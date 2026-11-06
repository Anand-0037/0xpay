import { encodeFunctionData, isAddress, type Hex } from 'viem'
import { claim, config, createNote, deposit, encodeNoteLink, decodeNoteLink, getBalance, type ClaimStep, type Note, type RpcTransport } from './index.ts'
import { rpc } from './network.ts'
import { listStoredNotes, saveStoredNotes, reconcileNotes, type StoredNote } from './notes.ts'
import { unlockedFundingWallet } from '../wallet/lifecycle.ts'
import { privateTransport } from './transport.ts'
import { mayRestoreRejectedClaim } from './claim-recovery.ts'
import type { PrivateRpc } from '../rpc.ts'
const DENOMINATION = 100_000_000_000_000_000n
export type PoolApi = ReturnType<typeof createPoolApi>
export function createPoolApi(route: PrivateRpc) {
  const transport = privateTransport(route)
  return {
    getPublicBalance: (address: Hex) => getBalance(address, transport),
    getPrivateBalance: async () => BigInt((await reconcileNotes(transport)).filter(x => x.status === 'unspent').length) * DENOMINATION,
    listNotes: () => reconcileNotes(transport),
    depositNotes: async (count: number, onStep?: (step: { kind: string; [key: string]: unknown }) => void) => {
      if (!Number.isSafeInteger(count) || count < 1 || count > 20) throw new Error('Invalid note count')
      const privateKey = unlockedFundingWallet().privateKey as Hex
      const results: StoredNote[] = []
      for (let i = 0; i < count; i++) {
        const note = createNote(config.pool, config.chainId)
        const records = await listStoredNotes(); records.push({ note, status: 'pending-deposit' }); await saveStoredNotes(records)
        const result = await deposit(note, { privateKey, onStep, transport })
        const refreshed = await listStoredNotes(); const entry = refreshed.find(x => x.note.commitment === note.commitment)!
        entry.status = 'unspent'; entry.txHash = result.txHash; await saveStoredNotes(refreshed); results.push(entry)
      }
      return results
    },
    privateSend: async ({ to, notes, onStep }: { to: Hex; notes: Note[]; onStep: (step: ClaimStep) => void }) => {
      if (!isAddress(to) || notes.length < 1) throw new Error('Invalid recipient or notes')
      const results = []
      for (const note of notes) {
        const stored = await listStoredNotes(); const entry = stored.find(x => x.note.commitment === note.commitment)
        if (!entry || entry.status !== 'unspent') throw new Error('Note is unavailable')
        entry.status = 'spending'; await saveStoredNotes(stored)
        let canonical: Extract<ClaimStep, { kind: 'canonical' }> | undefined
        let alt: Extract<ClaimStep, { kind: 'alt' }> | undefined
        let preflightSeen = false
        let acceptedHash: Hex | undefined
        let result: Awaited<ReturnType<typeof claim>>
        try {
          result = await claim(note, { recipient: to, transport, onStep: step => {
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
            const checked = await reconcileNotes(transport)
            const current = checked.find(x => x.note.commitment === note.commitment)
            if (current) {
              if (acceptedHash) current.txHash = acceptedHash
              else if (current.status === 'spending' && mayRestoreRejectedClaim(preflightSeen, canonical, alt)) current.status = 'unspent'
              await saveStoredNotes(checked)
            }
          } catch { /* Keep the note reserved when chain state cannot be checked. */ }
          throw error
        }
        const updated = await listStoredNotes(); const spent = updated.find(x => x.note.commitment === note.commitment)!
        spent.status = 'spent'; spent.txHash = result.txHash; await saveStoredNotes(updated); results.push(result)
      }
      return results
    },
    createPaymentLink: (note: Note) => encodeNoteLink(note, window.location.href.split('#')[0]),
    claimLink: (link: string, onStep: (step: ClaimStep) => void) => claim(decodeNoteLink(link), { onStep, transport }),
    tokenPortfolio: (address: Hex) => tokenPortfolio(address, transport),
    activity: async () => (await reconcileNotes(transport)).map(x => ({ commitment: x.note.commitment, status: x.status, txHash: x.txHash })),
  }
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
    depositNotes: (count, onStep) => core.depositNotes(count, step => onStep(step as import('../pay/types.ts').ClaimStep)),
    privateSend: async ({ to, count, onStep }) => {
      const available = (await core.listNotes()).filter(x => x.status === 'unspent')
      if (!Number.isSafeInteger(count) || count < 1 || available.length < count) throw new Error('Insufficient unspent notes')
      const txHashes: Hex[] = []
      for (let i = 0; i < count; i++) {
        const [result] = await core.privateSend({ to, notes: [available[i].note], onStep: step => onStep({ ...step, noteIndex: i } as import('../pay/types.ts').ClaimStep) })
        txHashes.push(result.txHash)
      }
      return { txHashes }
    },
    createPaymentLink: async () => core.createPaymentLink((await core.depositNotes(1))[0].note),
    claimLink: (link, onStep) => claim(decodeNoteLink(link), { recipient: address(), onStep, transport: privateTransport(route) }),
    tokenPortfolio: () => core.tokenPortfolio(address()).then(tokens => tokens.map(x => ({ ...x, decimals: x.symbol === 'USDC' || x.symbol === 'USDT' ? 6 : 18 }))),
    activity: async () => (await core.activity()).map((x, i) => ({ id: `${i}:${x.commitment}`, kind: x.status, txHash: x.txHash })),
    route: () => ({ kind: 'anon-rpc', worker: route.network, calls: route.stats.attempted, direct: 0 }),
  }
}
