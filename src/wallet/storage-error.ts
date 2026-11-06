const browserErrors = new Set([
  'InvalidStateError', 'QuotaExceededError', 'SecurityError', 'NotAllowedError',
  'AbortError', 'UnknownError', 'DataError', 'DataCloneError', 'VersionError',
])

/** Show only known exception names, never SDK messages containing wallet data. */
export function walletStorageError(cause: unknown) {
  let current = cause
  const seen = new Set<unknown>()
  let writeFailure = false
  let storageErrorName: string | undefined
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current)
    if (current.message.includes('Failed to put value in database')) writeFailure = true
    if (browserErrors.has(current.name)) storageErrorName = current.name
    current = current.cause
  }
  const action = storageErrorName === 'QuotaExceededError'
    ? 'Free disk space or increase site storage, then retry.'
    : storageErrorName === 'SecurityError' || storageErrorName === 'NotAllowedError'
      ? 'Allow site storage in this browser, then retry.'
      : 'Reload this tab and retry. Keep the existing wallet and site data.'
  const summary = writeFailure ? 'Wallet storage could not be written.' : 'Wallet storage could not be loaded.'
  const diagnostic = storageErrorName ? ` IndexedDB reported ${storageErrorName}.` : ''
  return Object.assign(new Error(`${summary}${diagnostic} ${action}`, { cause }), {
    code: writeFailure ? 'WALLET_STORAGE_WRITE_FAILED' : 'WALLET_STORAGE_LOAD_FAILED',
    storageErrorName,
  })
}
