/** Independent user policy: never derive this cap from the proposed stake. */
export function perOrderLimitMicros(input: string): number {
  if (input.length > 32 || !/^\d+(?:\.\d{1,6})?$/.test(input.trim())) throw new Error('Enter a valid maximum per order.')
  const [whole, fraction = ''] = input.trim().split('.')
  const value = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0') || '0')
  if (value <= 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Maximum per order must be positive and within the supported range.')
  return Number(value)
}
