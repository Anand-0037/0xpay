export function depositGate(input: {
  routeReady: boolean
  routeConnecting: boolean
  paymentWorkerReady: boolean
  activityLoaded: boolean
  activityFailed: boolean
  pendingDeposit: boolean
  balanceWei: bigint | null
  balanceFailed: boolean
  maximumDebitWei: bigint | undefined
}): { ready: boolean; reason: string | null; shortfallWei: bigint } {
  const { routeReady, routeConnecting, paymentWorkerReady, activityLoaded, activityFailed, pendingDeposit, balanceWei, balanceFailed, maximumDebitWei } = input
  const shortfallWei = balanceWei !== null && maximumDebitWei !== undefined && balanceWei < maximumDebitWei
    ? maximumDebitWei - balanceWei : 0n
  if (pendingDeposit) return { ready: false, reason: 'Check the existing deposit before starting another.', shortfallWei }
  if (!routeReady) return { ready: false, reason: routeConnecting ? 'Waiting for the private route to check your balance…' : 'Reconnect the private route to check your balance.', shortfallWei }
  if (!paymentWorkerReady) return { ready: false, reason: 'Switch to Nox in Connection to deposit.', shortfallWei }
  if (activityFailed) return { ready: false, reason: 'Could not check earlier deposits. Retry before depositing.', shortfallWei }
  if (!activityLoaded) return { ready: false, reason: 'Checking earlier deposits…', shortfallWei }
  if (balanceFailed) return { ready: false, reason: 'Could not read your public balance. Retry before depositing.', shortfallWei }
  if (balanceWei === null) return { ready: false, reason: 'Checking your public balance…', shortfallWei }
  if (maximumDebitWei === undefined) return { ready: false, reason: 'Could not calculate the deposit maximum.', shortfallWei }
  if (shortfallWei > 0n) return { ready: false, reason: 'Add devnet ETH to cover the deposit and maximum network fee.', shortfallWei }
  return { ready: true, reason: null, shortfallWei }
}
