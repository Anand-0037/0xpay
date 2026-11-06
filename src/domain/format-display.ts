/** Display-only rounding for 18-decimal ETH/WETH. Never use this value in a transaction. */
export function formatDisplayBalance(wei: bigint, fractionDigits = 5): string {
  if (wei < 0n) throw new Error('A wallet balance cannot be negative')
  if (!Number.isInteger(fractionDigits) || fractionDigits < 1 || fractionDigits > 18) throw new Error('Invalid display precision')
  if (wei === 0n) return '0'
  const displayScale = 10n ** BigInt(fractionDigits)
  const unit = 10n ** BigInt(18 - fractionDigits)
  const smallest = `0.${'0'.repeat(fractionDigits - 1)}1`
  if (wei < unit) return `<${smallest}`
  const rounded = (wei + unit / 2n) / unit
  const whole = rounded / displayScale
  const fraction = (rounded % displayScale).toString().padStart(fractionDigits, '0').replace(/0+$/, '')
  return `${wei % unit === 0n ? '' : '≈'}${whole}${fraction ? `.${fraction}` : ''}`
}
