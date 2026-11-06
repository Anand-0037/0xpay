import type { ClaimStep } from './index.ts'

type Canonical = Extract<ClaimStep, { kind: 'canonical' }>
type Alt = Extract<ClaimStep, { kind: 'alt' }>

function explicitRejection(method: string, reason: string | undefined): boolean {
  return Boolean(reason && new RegExp(`${method}: -\\d+\\b`).test(reason))
}

export function mayRestoreRejectedClaim(preflightSeen: boolean, canonical?: Canonical, alt?: Alt): boolean {
  if (!preflightSeen) return true
  if (!canonical) return false // A broadcast may have timed out before producing a step.
  if (canonical.accepted || !alt || alt.accepted) return false
  return explicitRejection('eth_sendRawTransaction', canonical.reason)
    && explicitRejection('eth_sendFrameTransaction', alt.reason)
}
