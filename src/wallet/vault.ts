export type StoredVault = {
  version: 1
  salt: string
  nonce: string
  ciphertext: string
  walletId?: string
  creationBlock: number
  backupConfirmed?: boolean
}

const ITERATIONS = 310_000

function encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
}

function decode(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (character) => character.charCodeAt(0))
}

async function keys(password: string, salt: Uint8Array) {
  if (password.length < 12) throw new Error('Use a password with at least 12 characters')
  const passwordBytes = new TextEncoder().encode(password)
  const source = await crypto.subtle.importKey('raw', passwordBytes, 'PBKDF2', false, ['deriveBits'])
  passwordBytes.fill(0)
  const bits = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: new Uint8Array(salt), iterations: ITERATIONS, hash: 'SHA-256' }, source, 512,
  ))
  const key = await crypto.subtle.importKey('raw', bits.slice(0, 32), 'AES-GCM', false, ['encrypt', 'decrypt'])
  const sdkKey = Array.from(bits.slice(32), (byte) => byte.toString(16).padStart(2, '0')).join('')
  bits.fill(0)
  return { key, sdkKey }
}

export async function sealMnemonic(mnemonic: string, password: string, creationBlock: number): Promise<StoredVault> {
  if (!Number.isSafeInteger(creationBlock) || creationBlock < 0) throw new Error('Invalid creation block')
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const { key } = await keys(password, salt)
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce }, key, new TextEncoder().encode(mnemonic),
  ))
  return { version: 1, salt: encode(salt), nonce: encode(nonce), ciphertext: encode(ciphertext), creationBlock, backupConfirmed: false }
}

export async function openVault(vault: StoredVault, password: string) {
  if (vault.version !== 1) throw new Error('Unsupported vault version')
  const salt = decode(vault.salt)
  const nonce = decode(vault.nonce)
  if (salt.length !== 16 || nonce.length !== 12) throw new Error('Invalid vault metadata')
  const { key, sdkKey } = await keys(password, salt)
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(nonce) }, key, new Uint8Array(decode(vault.ciphertext)),
    )
    return { mnemonic: new TextDecoder().decode(plaintext), sdkKey }
  } catch {
    throw new Error('Could not unlock wallet with this password')
  }
}
