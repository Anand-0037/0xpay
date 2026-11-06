export type TransactionKind = 'shield' | 'send'
export type TransactionStatus = 'submitted' | 'unknown' | 'confirmed' | 'reverted'
export type TransactionRecord = Readonly<{
  kind: TransactionKind
  hash: string
  from: string
  status: TransactionStatus
  createdAt: number
}>

const STORAGE_KEY = '0xpay.transactions.v1'
const HASH = /^0x[0-9a-f]{64}$/i
const ADDRESS = /^0x[0-9a-f]{40}$/i
const KINDS = new Set<TransactionKind>(['shield', 'send'])
const STATUSES = new Set<TransactionStatus>(['submitted', 'unknown', 'confirmed', 'reverted'])

function checked(value: unknown): TransactionRecord {
  if (typeof value !== 'object' || value === null ||
      !('kind' in value) || !KINDS.has(value.kind as TransactionKind) ||
      !('hash' in value) || typeof value.hash !== 'string' || !HASH.test(value.hash) ||
      !('from' in value) || typeof value.from !== 'string' || !ADDRESS.test(value.from) ||
      !('status' in value) || !STATUSES.has(value.status as TransactionStatus) ||
      !('createdAt' in value) || typeof value.createdAt !== 'number' ||
      !Number.isSafeInteger(value.createdAt) || value.createdAt <= 0) {
    throw new Error('Local transaction history is damaged')
  }
  return value as TransactionRecord
}

export function readTransactions(storage: Pick<Storage, 'getItem'> = localStorage): TransactionRecord[] {
  const raw = storage.getItem(STORAGE_KEY)
  if (!raw) return []
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { throw new Error('Local transaction history is damaged') }
  if (!Array.isArray(parsed) || parsed.length > 50) throw new Error('Local transaction history is damaged')
  return parsed.map(checked)
}

export function unresolvedTransaction(kind: TransactionKind, storage: Pick<Storage, 'getItem'> = localStorage) {
  return readTransactions(storage).find((record) =>
    record.kind === kind && (record.status === 'submitted' || record.status === 'unknown'))
}

export function findTransaction(hash: string, storage: Pick<Storage, 'getItem'> = localStorage) {
  if (!HASH.test(hash)) throw new Error('Invalid transaction hash')
  return readTransactions(storage).find((record) => record.hash.toLowerCase() === hash.toLowerCase())
}

export function recordSubmitted(kind: TransactionKind, hash: string, from: string,
  storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage): TransactionRecord {
  const record = checked({ kind, hash, from, status: 'submitted', createdAt: Date.now() })
  const current = readTransactions(storage)
  const existing = current.find((item) => item.hash.toLowerCase() === hash.toLowerCase())
  if (existing) {
    if (existing.kind !== kind || existing.from.toLowerCase() !== from.toLowerCase()) {
      throw new Error('Transaction hash conflicts with local history')
    }
    return existing
  }
  storage.setItem(STORAGE_KEY, JSON.stringify([record, ...current].slice(0, 50)))
  return record
}

export function markTransaction(hash: string, status: Exclude<TransactionStatus, 'submitted'>,
  storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage): TransactionRecord {
  if (!HASH.test(hash) || !STATUSES.has(status)) throw new Error('Invalid transaction result')
  const current = readTransactions(storage)
  const index = current.findIndex((record) => record.hash.toLowerCase() === hash.toLowerCase())
  if (index < 0) throw new Error('Transaction is absent from local history')
  const prior = current[index]
  if ((prior.status === 'confirmed' || prior.status === 'reverted') && prior.status !== status) {
    throw new Error('Confirmed transaction result cannot be changed')
  }
  const next = { ...prior, status }
  current[index] = next
  storage.setItem(STORAGE_KEY, JSON.stringify(current))
  return next
}
