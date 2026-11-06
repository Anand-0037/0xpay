import { encodeFunctionData, isAddress, keccak256, toHex, type Hex } from 'viem'
import { claim, config, confirmClaimPayment, hash, createNote, deposit, encodeNoteLink, decodeNoteLink, getBalance, type ClaimStep, type Note, type RpcTransport } from './index.ts'
import { rpc } from './network.ts'
import { assertNoteSession, captureNoteSession, listStoredNotes, mutateStoredNotes, reconcileNotes, type StoredNote, type NoteSession } from './notes.ts'
import { unlockedFundingWallet } from '../wallet/lifecycle.ts'
import { privateTransport } from './transport.ts'
import { mayRestoreRejectedClaim } from './claim-recovery.ts'
import type { PrivateRpc } from '../rpc.ts'
import { verifyDepositReceipt, type ClaimIntent, type PaymentReceipt, type PreparedPayment } from './payment-records.ts'
import { exportPrivateNoteBackup, restorePrivateNoteBackup } from './note-backup.ts'
import { claimFeeQuote, depositFundingQuote } from './fees.ts'
const DENOMINATION = 100_000_000_000_000_000n
export type PoolApi = ReturnType<typeof createPoolApi>
export function createPoolApi(route: PrivateRpc) {
  const transport = privateTransport(route)
  const activeNotes = (records: StoredNote[]) => records.filter(entry => entry.note.chainId === config.chainId && entry.note.pool.toLowerCase() === config.pool.toLowerCase())
  const sessionTransport = (session: NoteSession): RpcTransport => async (url, body) => {
    assertNoteSession(session)
    const result = await transport(url, body)
    assertNoteSession(session)
    return result
  }
  const api = {
    getPublicBalance: (address: Hex) => getBalance(address, transport),
    getPrivateBalance: async () => BigInt(activeNotes(await reconcileNotes(transport)).filter(x => x.status === 'unspent').length) * DENOMINATION,
    listNotes: async () => activeNotes(await reconcileNotes(transport)),
    exportNoteBackup: exportPrivateNoteBackup,
    restoreNoteBackup: restorePrivateNoteBackup,
    getClaimQuote: claimFeeQuote,
    getDepositQuote: depositFundingQuote,
    depositNotes: async (count: number, onStep?: (step: { kind: string; [key: string]: unknown }) => void) => {
      if (!Number.isSafeInteger(count) || count < 1 || count > 20) throw new Error('Invalid note count')
      const session = captureNoteSession()
      if (activeNotes(await listStoredNotes(session)).some(entry => entry.pending?.operation === 'deposit'))
        throw new Error('Check the existing pending deposit before starting another')
      const privateKey = unlockedFundingWallet().privateKey as Hex
      const operationTransport = sessionTransport(session)
      // Public devnets can reset. Never send a value-bearing deposit to an
      // address that no longer has contract code deployed.
      const poolCode = await rpc<Hex>(config.mempoolRpc, 'eth_getCode', [config.pool, 'latest'], operationTransport)
      if (!/^0x(?:[0-9a-f]{2})+$/i.test(poolCode) || /^0x0+$/i.test(poolCode))
        throw new Error('Pool contract is unavailable on this devnet. Do not deposit; refresh deployment details.')
      if (keccak256(poolCode).toLowerCase() !== config.poolCodeHash.toLowerCase())
        throw new Error('Pool contract code differs from the reviewed deployment. Do not deposit; refresh deployment details.')
      const results: StoredNote[] = []
      for (let i = 0; i < count; i++) {
        assertNoteSession(session)
        const note = createNote(config.pool, config.chainId)
        await mutateStoredNotes(records => { records.push({ note, status: 'pending-deposit' }) }, session)
        let result: Awaited<ReturnType<typeof deposit>>
        try {
          result = await deposit(note, { privateKey, onStep: step => { assertNoteSession(session); onStep?.(step) }, transport: operationTransport,
            onPrepared: async intent => {
              if (intent.operation !== 'deposit') throw new Error('Prepared operation does not match this deposit')
              await mutateStoredNotes(records => {
                const entry = records.find(value => value.note.commitment === note.commitment)
                if (!entry || entry.status !== 'pending-deposit') throw new Error('Pending deposit note is unavailable')
                entry.txHash = intent.txHash; entry.pending = intent
              }, session)
            },
          })
        } catch (error) {
          // A failure before preparing the signed hash cannot have broadcast.
          // Keep any note with a hash reserved for exact-receipt recovery.
          try {
            await mutateStoredNotes(records => {
              const index = records.findIndex(value => value.note.commitment === note.commitment)
              if (index >= 0 && records[index].status === 'pending-deposit' && !records[index].pending && !records[index].txHash) records.splice(index, 1)
            }, session)
          } catch { /* Keep the note when storage or wallet session changes. */ }
          throw error
        }
        const refreshed = await mutateStoredNotes(records => {
          const entry = records.find(x => x.note.commitment === note.commitment)
          if (!entry) throw new Error('Stored deposit note is missing; do not deposit again')
          entry.status = 'unspent'; entry.txHash = result.txHash; delete entry.pending
        }, session)
        results.push(refreshed.find(x => x.note.commitment === note.commitment)!)
      }
      return results
    },
    privateSend: async ({ to, notes, onStep }: { to: Hex; notes: Note[]; onStep: (step: ClaimStep) => void }) => {
      if (!isAddress(to) || notes.length < 1) throw new Error('Invalid recipient or notes')
      const session = captureNoteSession()
      const operationTransport = sessionTransport(session)
      const results = []
      for (const note of notes) {
        assertNoteSession(session)
        const reserved = await mutateStoredNotes(stored => {
          const entry = stored.find(x => x.note.commitment === note.commitment)
          if (!entry || entry.status !== 'unspent' || entry.pending) throw new Error('Note is unavailable; check the existing transaction first')
          if (entry.note.chainId !== config.chainId || entry.note.pool.toLowerCase() !== config.pool.toLowerCase()) throw new Error('Note belongs to another pool')
          entry.status = 'spending'
        }, session)
        const reservedNote = reserved.find(x => x.note.commitment === note.commitment)!.note
        const previousHash = reserved.find(x => x.note.commitment === note.commitment)!.txHash
        let canonical: Extract<ClaimStep, { kind: 'canonical' }> | undefined
        let alt: Extract<ClaimStep, { kind: 'alt' }> | undefined
        let preflightSeen = false
        let acceptedHash: Hex | undefined
        let preparedIntent: ClaimIntent | undefined
        let result: Awaited<ReturnType<typeof claim>>
        try {
          result = await claim(reservedNote, { recipient: to, transport: operationTransport, onPrepared: async (intent: PreparedPayment) => {
            if (intent.operation !== 'claim') throw new Error('Prepared operation does not match this claim')
            preparedIntent = intent
            acceptedHash = intent.txHash
            await mutateStoredNotes(records => {
              const current = records.find(value => value.note.commitment === note.commitment)
              if (!current || current.status !== 'spending') throw new Error('Reserved claim note is unavailable')
              current.txHash = intent.txHash; current.pending = intent
            }, session)
          }, onStep: step => {
            assertNoteSession(session)
            if (step.kind === 'preflight') preflightSeen = true
            if (step.kind === 'canonical') {
              canonical = step
              if (step.accepted && /^0x[0-9a-f]{64}$/i.test(step.reason)) acceptedHash = step.reason as Hex
            }
            if (step.kind === 'alt') {
              alt = step
              if (step.accepted) acceptedHash = step.txHash
            }
            if (step.kind === 'included') acceptedHash = step.txHash
            onStep(step)
          } })
        } catch (error) {
          try {
            assertNoteSession(session)
            await mutateStoredNotes(checked => {
              const current = checked.find(x => x.note.commitment === note.commitment)
              if (current) {
                if (current.status === 'spending' && mayRestoreRejectedClaim(preflightSeen, canonical, alt)) {
                  current.status = 'unspent'; current.txHash = previousHash; delete current.pending
                } else if (acceptedHash) {
                  current.txHash = acceptedHash
                  if (preparedIntent) current.pending = preparedIntent
                }
              }
            }, session)
            // Persist the known signed hash first, even if this chain read fails.
            await reconcileNotes(operationTransport, session)
          } catch { /* Keep the note reserved when chain state cannot be checked. */ }
          throw error
        }
        await mutateStoredNotes(updated => {
          const spent = updated.find(x => x.note.commitment === note.commitment)
          if (!spent) throw new Error('Stored claim note is missing; check the existing transaction')
          spent.status = 'spent'; spent.txHash = result.txHash; delete spent.pending
        }, session)
        results.push(result)
      }
      return results
    },
    checkPendingPayment: async (txHash: Hex) => {
      if (!/^0x[0-9a-f]{64}$/i.test(txHash)) throw new Error('Invalid pending transaction hash')
      const session = captureNoteSession()
      const operationTransport = sessionTransport(session)
      const matches = activeNotes(await listStoredNotes(session)).filter(entry => entry.pending?.txHash.toLowerCase() === txHash.toLowerCase())
      if (matches.length !== 1) throw new Error('Exact pending payment was not found in this wallet')
      const entry = matches[0], intent = entry.pending!
      if (intent.chainId !== config.chainId || intent.pool.toLowerCase() !== config.pool.toLowerCase()
        || (intent.operation === 'deposit' && (entry.status !== 'pending-deposit' || intent.commitment.toLowerCase() !== entry.note.commitment.toLowerCase()))
        || (intent.operation === 'claim' && (entry.status !== 'spending' || intent.nullifierHash.toLowerCase() !== toHex(hash(entry.note.nullifier), { size: 32 }).toLowerCase())))
        throw new Error('Pending payment does not match this note and pool')
      if (BigInt(await rpc<Hex>(config.mempoolRpc, 'eth_chainId', [], operationTransport)) !== BigInt(intent.chainId))
        throw new Error('Private route is connected to another chain')
      const receipt = await rpc<PaymentReceipt | null>(config.mempoolRpc, 'eth_getTransactionReceipt', [intent.txHash], operationTransport)
      if (!receipt) return { status: 'pending' as const, operation: intent.operation, txHash: intent.txHash }
      let blockNumber: bigint
      if (intent.operation === 'claim') {
        blockNumber = (await confirmClaimPayment(receipt, intent, operationTransport)).blockNumber
      } else {
        blockNumber = verifyDepositReceipt(receipt, intent).blockNumber
        const blockTag = toHex(blockNumber)
        const header = await rpc<{ hash: Hex } | null>(config.mempoolRpc, 'eth_getBlockByNumber', [blockTag, false], operationTransport)
        if (header?.hash?.toLowerCase() !== receipt.blockHash.toLowerCase()) throw new Error('Deposit block changed; check the existing transaction')
        const checked = await rpc<{ hash: Hex } | null>(config.mempoolRpc, 'eth_getBlockByNumber', [blockTag, false], operationTransport)
        if (checked?.hash?.toLowerCase() !== receipt.blockHash.toLowerCase()) throw new Error('Deposit block changed during verification')
      }
      await mutateStoredNotes(records => {
        const current = records.find(value => value.note.commitment.toLowerCase() === entry.note.commitment.toLowerCase())
        if (!current || current.pending?.txHash.toLowerCase() !== intent.txHash.toLowerCase()
          || current.pending.operation !== intent.operation || current.status !== (intent.operation === 'claim' ? 'spending' : 'pending-deposit'))
          throw new Error('Pending payment changed while checking; refresh your wallet')
        current.status = intent.operation === 'claim' ? 'spent' : 'unspent'
        current.txHash = intent.txHash
        delete current.pending
      }, session)
      return { status: 'verified' as const, operation: intent.operation, txHash: intent.txHash, blockNumber }
    },
    createPaymentLink: (note: Note) => encodeNoteLink(note, window.location.href.split('#')[0]),
    claimLink: async (link: string, onStep: (step: ClaimStep) => void): Promise<{ txHash: Hex; blockNumber: bigint }> => {
      const session = captureNoteSession()
      const recipient = unlockedFundingWallet().address as Hex
      const note = decodeNoteLink(link)
      if (note.chainId !== config.chainId || note.pool.toLowerCase() !== config.pool.toLowerCase()) throw new Error('Payment link belongs to another network or pool')
      await mutateStoredNotes(records => {
        if (!records.some(entry => entry.note.commitment === note.commitment)) records.push({ note, status: 'unspent' })
      }, session)
      assertNoteSession(session)
      const [result] = await api.privateSend({ to: recipient, notes: [note], onStep })
      return result
    },
    tokenPortfolio: (address: Hex) => tokenPortfolio(address, transport),
    activity: async () => activeNotes(await listStoredNotes()).map(x => ({ commitment: x.note.commitment, status: x.status, txHash: x.txHash, pending: Boolean(x.pending), operation: x.pending?.operation })),
  }
  return api
}
const tokens = ['USDC', 'USDT', 'WETH', 'LINK'] as const
const devnetTokens: Record<typeof tokens[number], Hex> = { USDC: '0xEFe0D421fD473564c9C9b0cDCeB194cF476D6AF5', USDT: '0xdb6785eB39E80a1770699C5dF8Ab7d4AC683b4D9', WETH: '0x1b7d32025F7cA633943BbCC9Ec61a98ef66187b6', LINK: '0x7BF399a347FC0757e668058f11D3B696932353e4' }
export async function tokenPortfolio(address: Hex, transport: RpcTransport) {
  const result: { symbol: typeof tokens[number]; address: Hex; balance: bigint }[] = []
  for (const symbol of tokens) {
    const tokenAddress = (import.meta.env[`VITE_${symbol}_ADDRESS`] || (config.chainId === 1337 ? devnetTokens[symbol] : undefined)) as Hex | undefined
    if (!tokenAddress || !isAddress(tokenAddress)) continue
    const data = encodeFunctionData({ abi: [{ name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }], functionName: 'balanceOf', args: [address] })
    const balance = BigInt(await rpc<Hex>(config.mempoolRpc, 'eth_call', [{ to: tokenAddress, data }, 'latest'], transport))
    result.push({ symbol, address: tokenAddress, balance })
  }
  return result
}

/** Adapter matching the pay screen's shared interface. */
export function createPayApi(route: PrivateRpc): import('../pay/types.ts').PayApi {
  const core = createPoolApi(route)
  const address = () => unlockedFundingWallet().address as Hex
  return {
    getPublicBalance: () => core.getPublicBalance(address()),
    getPrivateBalance: core.getPrivateBalance,
    listNotes: async () => (await core.listNotes()).map(x => ({ commitment: x.note.commitment, spent: x.status !== 'unspent', status: x.status })),
    exportNoteBackup: core.exportNoteBackup,
    restoreNoteBackup: core.restoreNoteBackup,
    getClaimQuote: core.getClaimQuote,
    getDepositQuote: core.getDepositQuote,
    checkPendingPayment: core.checkPendingPayment,
    depositNotes: (count, onStep) => core.depositNotes(count, step => onStep(step as import('../pay/types.ts').ClaimStep)),
    privateSend: async ({ to, count, onStep }) => {
      const session = captureNoteSession()
      const available = (await core.listNotes()).filter(x => x.status === 'unspent' && !x.pending)
      assertNoteSession(session)
      if (!Number.isSafeInteger(count) || count < 1 || available.length < count) throw new Error('Insufficient unspent notes')
      const txHashes: Hex[] = []
      for (let i = 0; i < count; i++) {
        assertNoteSession(session)
        const [result] = await core.privateSend({ to, notes: [available[i].note], onStep: step => onStep({ ...step, noteIndex: i } as import('../pay/types.ts').ClaimStep) })
        assertNoteSession(session)
        txHashes.push(result.txHash)
      }
      return { txHashes }
    },
    createPaymentLink: async () => {
      const session = captureNoteSession()
      const [entry] = await core.depositNotes(1)
      assertNoteSession(session)
      return core.createPaymentLink(entry.note)
    },
    claimLink: core.claimLink,
    tokenPortfolio: () => core.tokenPortfolio(address()).then(tokens => tokens.map(x => ({ ...x, decimals: x.symbol === 'USDC' || x.symbol === 'USDT' ? 6 : 18 }))),
    activity: async () => (await core.activity()).map((x, i) => ({ id: `${i}:${x.commitment}`, kind: x.status, txHash: x.txHash, pending: x.pending, operation: x.operation })),
    route: () => ({ kind: 'anon-rpc', worker: route.network, calls: route.stats.attempted, direct: 0 }),
  }
}
