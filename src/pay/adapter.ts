import type { PoolApi } from '../pool/api'
import { unlockedFundingWallet } from '../wallet/lifecycle'
import type { ClaimStep, PayApi } from './types'

/** Bridge from the pool worker's current API to the wallet view contract. */
export function adaptPoolApi(pool: PoolApi): PayApi {
  const address = () => unlockedFundingWallet().address as `0x${string}`
  return {
    getFundingAddress: address,
    getPublicBalance: () => pool.getPublicBalance(address()),
    getPrivateBalance: () => pool.getPrivateBalance(),
    listNotes: async () => (await pool.listNotes()).map(entry => ({ commitment: entry.note.commitment, spent: entry.status !== 'unspent', source: entry.source })),
    exportNoteBackup: pool.exportNoteBackup,
    restoreNoteBackup: pool.restoreNoteBackup,
    getClaimQuote: pool.getClaimQuote,
    getDepositQuote: pool.getDepositQuote,
    checkPendingPayment: pool.checkPendingPayment,
    depositNotes: (count, onStep) => pool.depositNotes(count, step => {
      if (step.kind === 'included' && typeof step.blockNumber === 'bigint' && typeof step.txHash === 'string') {
        onStep({ kind: 'included', blockNumber: step.blockNumber, txHash: step.txHash as `0x${string}`, explorerUrl: 'https://explorer.altmempool.wtf/' })
      }
    }),
    privateSend: async ({ to, count, onStep }) => {
      const notes = (await pool.listNotes()).filter(entry => entry.status === 'unspent').slice(0, count)
      if (notes.length !== count) throw new Error('Not enough unspent notes')
      const txHashes: `0x${string}`[] = []
      for (let noteIndex = 0; noteIndex < notes.length; noteIndex++) {
        const result = await pool.privateSend({ to, notes: [notes[noteIndex].note], onStep: step => onStep({ ...step, noteIndex } as ClaimStep) })
        txHashes.push(...result.map(item => item.txHash))
      }
      return { txHashes }
    },
    createPaymentLink: async () => {
      const [entry] = await pool.depositNotes(1)
      if (!entry) throw new Error('Deposit did not create a note')
      return pool.createPaymentLink(entry.note)
    },
    claimLink: (link, onStep) => pool.claimLink(link, onStep),
    importPaymentLink: pool.importPaymentLink,
    claimImportedLink: pool.claimImportedLink,
    tokenPortfolio: async () => (await pool.tokenPortfolio(address())).map(token => ({ symbol: token.symbol, balance: token.balance })),
    activity: async () => (await pool.activity()).map(item => ({ id: item.commitment, title: item.status, kind: item.status, txHash: item.txHash, pending: item.pending, operation: item.operation })),
    route: () => ({ kind: 'unknown', worker: null, calls: null, direct: null }),
  }
}
