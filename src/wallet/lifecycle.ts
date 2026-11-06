import { HDNodeWallet, Mnemonic, randomBytes } from 'ethers'
import { openVault, sealMnemonic, type StoredVault } from './vault'
import { SessionGate } from './session'

export type WalletSession = { id: string; railgunAddress: string; publicAddress: string }
const STORAGE_KEY = '0xpay.vault.v1'
let fundingWallet: HDNodeWallet | null = null
let loadedWalletId: string | null = null
let unlockedSdkKey: string | null = null
const sessionGate = new SessionGate()

export function hasStoredVault() { return localStorage.getItem(STORAGE_KEY) !== null }

export function storedVault(): StoredVault | null {
  const saved = localStorage.getItem(STORAGE_KEY)
  if (!saved) return null
  let value: unknown
  try { value = JSON.parse(saved) } catch { throw new Error('Local wallet record is damaged') }
  if (typeof value !== 'object' || value === null || !('version' in value) || value.version !== 1 ||
    !('salt' in value) || typeof value.salt !== 'string' || !('nonce' in value) || typeof value.nonce !== 'string' ||
    !('ciphertext' in value) || typeof value.ciphertext !== 'string' ||
    !('creationBlock' in value) || typeof value.creationBlock !== 'number' ||
    !Number.isSafeInteger(value.creationBlock) || value.creationBlock < 0 ||
    ('walletId' in value && typeof value.walletId !== 'string')) throw new Error('Local wallet record is damaged')
  return value as StoredVault
}

async function railgunWallet(vault: StoredVault, mnemonic: string, sdkKey: string) {
  const [{ createRailgunWallet, loadWalletByID, unloadWalletByID }, { NetworkName }] = await Promise.all([
    import('@railgun-community/wallet'), import('@railgun-community/shared-models'),
  ])
  if (vault.walletId) {
    try { return await loadWalletByID(sdkKey, vault.walletId, false) }
    catch {
      // The browser may evict the SDK database while retaining our encrypted vault.
      // Recreate only if the decrypted phrase derives the exact stored wallet ID.
      const restored = await createRailgunWallet(sdkKey, mnemonic, { [NetworkName.EthereumSepolia]: vault.creationBlock })
      if (restored.id !== vault.walletId) {
        unloadWalletByID(restored.id)
        throw new Error('Private wallet metadata does not match this recovery phrase')
      }
      return restored
    }
  }
  const info = await createRailgunWallet(sdkKey, mnemonic, { [NetworkName.EthereumSepolia]: vault.creationBlock })
  vault.walletId = info.id
  return info
}

async function unlockRecord(vault: StoredVault, password: string, generation: number): Promise<WalletSession> {
  const { mnemonic, sdkKey } = await openVault(vault, password)
  sessionGate.assertCurrent(generation)
  const publicWallet = HDNodeWallet.fromPhrase(mnemonic)
  const info = await railgunWallet(vault, mnemonic, sdkKey)
  if (!sessionGate.isCurrent(generation)) {
    const { unloadWalletByID } = await import('@railgun-community/wallet')
    unloadWalletByID(info.id)
    throw new Error('Wallet was locked during unlock')
  }
  fundingWallet = publicWallet
  loadedWalletId = info.id
  unlockedSdkKey = sdkKey
  return { id: info.id, railgunAddress: info.railgunAddress, publicAddress: publicWallet.address }
}

export async function createLocalWallet(password: string, blockNumber: number) {
  if (hasStoredVault()) throw new Error('A local wallet already exists; unlock it instead')
  const generation = sessionGate.beginUnlock()
  try {
    const mnemonic = Mnemonic.fromEntropy(randomBytes(16)).phrase
    const vault = await sealMnemonic(mnemonic, password, blockNumber)
    sessionGate.assertCurrent(generation)
    const session = await unlockRecord(vault, password, generation)
    sessionGate.assertCurrent(generation)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(vault))
    return { session, recoveryPhrase: mnemonic }
  } finally { sessionGate.finishUnlock() }
}

export async function importLocalWallet(phrase: string, password: string) {
  if (hasStoredVault()) throw new Error('A local wallet already exists; unlock it instead')
  const generation = sessionGate.beginUnlock()
  try {
    const mnemonic = Mnemonic.fromPhrase(phrase.trim()).phrase
    const { NETWORK_CONFIG, NetworkName } = await import('@railgun-community/shared-models')
    const creationBlock = NETWORK_CONFIG[NetworkName.EthereumSepolia].deploymentBlock
    if (!creationBlock) throw new Error('Sepolia deployment block is unavailable')
    const vault = await sealMnemonic(mnemonic, password, creationBlock)
    sessionGate.assertCurrent(generation)
    const session = await unlockRecord(vault, password, generation)
    sessionGate.assertCurrent(generation)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(vault))
    return session
  } finally { sessionGate.finishUnlock() }
}

export async function unlockLocalWallet(password: string) {
  const vault = storedVault()
  if (!vault) throw new Error('No local wallet exists')
  const generation = sessionGate.beginUnlock()
  try { return await unlockRecord(vault, password, generation) }
  finally { sessionGate.finishUnlock() }
}

export async function lockLocalWallet() {
  await sessionGate.lock(async () => {
    const id = loadedWalletId
    loadedWalletId = null
    fundingWallet = null
    unlockedSdkKey = null
    if (id) {
      const { unloadWalletByID } = await import('@railgun-community/wallet')
      unloadWalletByID(id)
    }
  })
}

export function unlockedFundingWallet() {
  if (!fundingWallet) throw new Error('Wallet is locked')
  return fundingWallet
}

export function unlockedEncryptionKey() {
  if (!unlockedSdkKey) throw new Error('Private wallet is locked')
  return unlockedSdkKey
}

export function unlockedWalletId() {
  if (!loadedWalletId) throw new Error('Private wallet is locked')
  return loadedWalletId
}
