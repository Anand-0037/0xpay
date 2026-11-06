import { parseUnits } from 'ethers'

/** Parse a user-entered ETH amount without accepting signs, exponents or rounding. */
export function parseEthAmount(input: string): bigint {
  const value = input.trim()
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,18})?$/.test(value)) {
    throw new Error('Enter a positive ETH amount with up to 18 decimal places')
  }
  const wei = parseUnits(value, 18)
  if (wei <= 0n) throw new Error('Amount must be greater than zero')
  return wei
}
