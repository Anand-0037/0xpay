export type ClaimFragmentCleanup = 'cleared' | 'not-current' | 'failed'

/** Call only after the claim note has been persisted in encrypted wallet storage. */
export function clearImportedPaymentLink(
  expectedHash: string,
  location: Pick<Location, 'hash' | 'pathname' | 'search'> = window.location,
  history: Pick<History, 'state' | 'replaceState'> = window.history,
): ClaimFragmentCleanup {
  if (!expectedHash.startsWith('#claim=') || location.hash !== expectedHash) return 'not-current'
  try {
    history.replaceState(history.state, '', `${location.pathname}${location.search}`)
    return 'cleared'
  } catch {
    // Keep the bearer link visible if the browser refuses replacement, so it
    // remains recoverable. The caller should surface the failed cleanup.
    return 'failed'
  }
}
