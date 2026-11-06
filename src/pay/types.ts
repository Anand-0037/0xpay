/** Temporary contract for the pool API. Keep this file aligned with src/pool/API.md. */
export type Address = `0x${string}`
export type Note = { commitment?: Address; spent?: boolean; [key: string]: unknown }
export type Activity = { id?: string; kind?: string; title?: string; timestamp?: number | string; txHash?: Address; amountWei?: bigint; [key: string]: unknown }
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
  depositNotes(count: number, onStep: (step: ClaimStep) => void): Promise<unknown>
  privateSend(args: { to: Address; count: number; onStep: (step: ClaimStep) => void }): Promise<{ txHashes: Address[] }>
  createPaymentLink(): Promise<string>
  claimLink(link: string, onStep: (step: ClaimStep) => void): Promise<unknown>
  tokenPortfolio(): Promise<{ symbol: string; balance: bigint; decimals?: number }[]>
  activity(): Promise<Activity[]>
  route(): { kind: 'anon-rpc' | 'direct' | 'unknown'; worker: 'nox' | 'nym' | null; calls: number | null; direct: number | null }
}
