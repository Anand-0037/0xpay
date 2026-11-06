/** Temporary contract for the pool API. Keep this file aligned with src/pool/API.md. */
export type Address = `0x${string}`
export type Note = { commitment?: Address; spent?: boolean; source?: 'link'; [key: string]: unknown }
export type Activity = { id?: string; kind?: string; title?: string; timestamp?: number | string; txHash?: Address; amountWei?: bigint; pending?: boolean; operation?: 'deposit' | 'claim'; [key: string]: unknown }
export type PendingPaymentCheck = { status: 'pending'; operation: 'deposit' | 'claim'; txHash: Address } | { status: 'verified'; operation: 'deposit' | 'claim'; txHash: Address; blockNumber: bigint }
export type ClaimStep =
  | { kind: 'key'; address: Address; balanceWei: bigint; noteIndex?: number }
  | { kind: 'sync'; leaves: number; noteIndex?: number }
  | { kind: 'proof'; ms: number; noteIndex?: number }
  | { kind: 'preflight'; noteIndex?: number }
  | { kind: 'canonical'; accepted: boolean; reason: string; noteIndex?: number }
  | { kind: 'alt'; accepted: boolean; txHash?: Address; reason?: string; noteIndex?: number }
  | { kind: 'included'; blockNumber: bigint; txHash: Address; explorerUrl: string; noteIndex?: number }
  | { kind: 'balance'; address: Address; balanceWei: bigint; noteIndex?: number }

export type PayApi = {
  getPublicBalance(): Promise<bigint>
  getPrivateBalance(): Promise<bigint>
  listNotes(): Promise<Note[]>
  exportNoteBackup?(password: string): Promise<{ contents: string; noteCount: number }>
  restoreNoteBackup?(contents: string, password: string): Promise<{ added: number; existing: number; reserved: number; total: number }>
  getDepositQuote?(count: number): { noteCount: number; noteValueWei: bigint; maxNetworkFeeWei: bigint; maximumDebitWei: bigint }
  checkPendingPayment?(txHash: Address): Promise<PendingPaymentCheck>
  getClaimQuote?(count: number): { grossWei: bigint; feePerNoteWei: bigint; feeWei: bigint; recipientWei: bigint }
  depositNotes(count: number, onStep: (step: ClaimStep) => void): Promise<unknown>
  privateSend(args: { to: Address; count: number; onStep: (step: ClaimStep) => void }): Promise<{ txHashes: Address[] }>
  createPaymentLink(): Promise<string>
  importPaymentLink(link: string): Promise<Address>
  claimImportedLink(commitment: Address, onStep: (step: ClaimStep) => void): Promise<unknown>
  claimLink(link: string, onStep: (step: ClaimStep) => void): Promise<unknown>
  tokenPortfolio(): Promise<{ symbol: string; balance: bigint; decimals?: number }[]>
  activity(): Promise<Activity[]>
  route(): { kind: 'anon-rpc' | 'direct' | 'unknown'; worker: 'nox' | 'nym' | null; calls: number | null; direct: number | null }
}
