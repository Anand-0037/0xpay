import { HDNodeWallet, Mnemonic, randomBytes } from 'ethers'
import { openVault, sealMnemonic, type StoredVault } from './vault.ts'
import { SessionGate } from './session.ts'
import { walletStorageError } from './storage-error.ts'

export type WalletSession = { id: string; railgunAddress: string; publicAddress: string; backupConfirmed: boolean; generation: number }
const STORAGE_KEY = '0xpay.vault.v1'
let fundingWallet: HDNodeWallet | null = null
let loadedWalletId: string | null = null
let unlockedSdkKey: string | null = null
let loadedVaultIdentity: string | null = null
let storedIdentityInvalidated = false
const sessionGate = new SessionGate()

function vaultIdentity(vault: StoredVault) {
  return JSON.stringify({ version: vault.version, salt: vault.salt, nonce: vault.nonce,
    ciphertext: vault.ciphertext, walletId: vault.walletId, creationBlock: vault.creationBlock })
}

function assertCurrentStoredIdentity() {
  if (storedIdentityInvalidated) throw new Error('Stored wallet changed. Lock and reload before continuing.')
  const vault = storedVault()
  if (!vault || loadedVaultIdentity === null || vaultIdentity(vault) !== loadedVaultIdentity) {
    storedIdentityInvalidated = true
    throw new Error('Stored wallet changed. Lock and reload before continuing.')
  }
}

async function withVaultCreationLock<T>(create: () => Promise<T>): Promise<T> {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks
  if (!locks) return create()
  return locks.request('0xpay.wallet-vault-create', { ifAvailable: true }, (lock) => {
    if (!lock) throw new Error('Wallet setup is already running in another tab. Wait for it to finish.')
    return create()
  })
}

export function hasStoredVault() {
  try { return localStorage.getItem(STORAGE_KEY) !== null }
  catch { return false }
}

function assertWritableStorage() {
  const probe = `0xpay.storage-check.${crypto.randomUUID()}`
  try {
    localStorage.setItem(probe, '1')
    localStorage.removeItem(probe)
  } catch { throw new Error('Browser storage is unavailable. Enable site storage before setting up a wallet.') }
}

export function storedVault(): StoredVault | null {
  let saved: string | null
  try { saved = localStorage.getItem(STORAGE_KEY) }
  catch { throw new Error('Browser storage is unavailable. Enable site storage to unlock this wallet.') }
  if (!saved) return null
  let value: unknown
  try { value = JSON.parse(saved) } catch { throw new Error('Local wallet record is damaged') }
  if (typeof value !== 'object' || value === null || !('version' in value) || value.version !== 1 ||
    !('salt' in value) || typeof value.salt !== 'string' || !('nonce' in value) || typeof value.nonce !== 'string' ||
    !('ciphertext' in value) || typeof value.ciphertext !== 'string' ||
    !('creationBlock' in value) || typeof value.creationBlock !== 'number' ||
    !Number.isSafeInteger(value.creationBlock) || value.creationBlock < 0 ||
    ('walletId' in value && typeof value.walletId !== 'string') ||
    ('backupConfirmed' in value && typeof value.backupConfirmed !== 'boolean')) throw new Error('Local wallet record is damaged')
  return value as StoredVault
}

async function railgunWallet(vault: StoredVault, mnemonic: string, sdkKey: string) {
  const [{ createRailgunWallet, loadWalletByID, unloadWalletByID, getEngine, fromUTF8String }, { NetworkName }] = await Promise.all([
    import('@railgun-community/wallet'), import('@railgun-community/shared-models'),
  ])
  if (vault.walletId) {
    let recordMissing = false
    try {
      // This is the exact encrypted-wallet record used by AbstractWallet.read.
      // Probe before SDK sanitization strips the LevelUP NotFound metadata.
      await getEngine().db.get([fromUTF8String('wallet'), vault.walletId], 'json')
    } catch (cause) {
      recordMissing = typeof cause === 'object' && cause !== null && 'notFound' in cause && cause.notFound === true
      if (!recordMissing) { unloadWalletByID(vault.walletId); throw walletStorageError(cause) }
    }
    // A previous SDK attachment failure may have registered a partial wallet.
    // Unload only its in-memory object; this does not delete stored wallet data.
    unloadWalletByID(vault.walletId)
    if (!recordMissing) {
      try { return await loadWalletByID(sdkKey, vault.walletId, false) }
      catch (cause) {
        unloadWalletByID(vault.walletId)
        throw walletStorageError(cause)
      }
    }
  }
  const previouslyLoaded = new Set(Object.keys(getEngine().wallets))
  try {
    const info = await createRailgunWallet(sdkKey, mnemonic, { [NetworkName.EthereumSepolia]: vault.creationBlock })
    if (vault.walletId && info.id !== vault.walletId) {
      unloadWalletByID(info.id)
      throw new Error('Private wallet metadata does not match this recovery phrase')
    }
    vault.walletId = info.id
    return info
  } catch (cause) {
    // createWallet also registers before awaiting UTXO attachment. Remove only
    // new in-memory entries created by this serialized lifecycle operation.
    for (const id of Object.keys(getEngine().wallets)) if (!previouslyLoaded.has(id)) unloadWalletByID(id)
    throw walletStorageError(cause)
  }
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
  loadedVaultIdentity = vaultIdentity(vault)
  storedIdentityInvalidated = false
  return { id: info.id, railgunAddress: info.railgunAddress, publicAddress: publicWallet.address, backupConfirmed: vault.backupConfirmed === true, generation }
}

export async function createLocalWallet(password: string, blockNumber: number) {
  return withVaultCreationLock(() => createWalletRecord(password, blockNumber))
}

async function createWalletRecord(password: string, blockNumber: number) {
  assertWritableStorage()
  if (hasStoredVault()) throw new Error('A local wallet already exists; unlock it instead')
  const generation = sessionGate.beginUnlock()
  try {
    const mnemonic = Mnemonic.fromEntropy(randomBytes(16)).phrase
    const vault = await sealMnemonic(mnemonic, password, blockNumber)
    sessionGate.assertCurrent(generation)
    const session = await unlockRecord(vault, password, generation)
    sessionGate.assertCurrent(generation)
    try {
      if (hasStoredVault()) throw new Error('Another tab already created a wallet')
      localStorage.setItem(STORAGE_KEY, JSON.stringify(vault))
    }
    catch {
      try { await lockLocalWallet() } catch { /* never expose an unsaved wallet session */ }
      throw new Error('Browser storage could not save this wallet. No wallet was set up; enable site storage and retry.')
    }
    return { session, recoveryPhrase: mnemonic }
  } finally { sessionGate.finishUnlock() }
}

export async function importLocalWallet(phrase: string, password: string) {
  return withVaultCreationLock(() => importWalletRecord(phrase, password))
}

async function importWalletRecord(phrase: string, password: string) {
  assertWritableStorage()
  if (hasStoredVault()) throw new Error('A local wallet already exists; unlock it instead')
  const generation = sessionGate.beginUnlock()
  try {
    const mnemonic = Mnemonic.fromPhrase(phrase.trim()).phrase
    const { NETWORK_CONFIG, NetworkName } = await import('@railgun-community/shared-models')
    const creationBlock = NETWORK_CONFIG[NetworkName.EthereumSepolia].deploymentBlock
    if (!creationBlock) throw new Error('Sepolia deployment block is unavailable')
    const vault = await sealMnemonic(mnemonic, password, creationBlock)
    // Import starts from an existing recovery phrase held by the user.
    vault.backupConfirmed = true
    sessionGate.assertCurrent(generation)
    const session = await unlockRecord(vault, password, generation)
    sessionGate.assertCurrent(generation)
    try {
      if (hasStoredVault()) throw new Error('Another tab already created a wallet')
      localStorage.setItem(STORAGE_KEY, JSON.stringify(vault))
    }
    catch {
      try { await lockLocalWallet() } catch { /* never expose an unsaved wallet session */ }
      throw new Error('Browser storage could not save this wallet. No wallet was set up; enable site storage and retry.')
    }
    return session
  } finally { sessionGate.finishUnlock() }
}

export async function unlockLocalWallet(password: string) {
  const vault = storedVault()
  if (!vault) throw new Error('No local wallet exists')
  const recordBeforeUnlock = JSON.stringify(vault)
  const needsWalletId = !vault.walletId
  const generation = sessionGate.beginUnlock()
  try {
    const session = await unlockRecord(vault, password, generation)
    try {
      sessionGate.assertCurrent(generation)
      if (JSON.stringify(storedVault()) !== recordBeforeUnlock) throw new Error('Stored wallet changed during unlock. Lock and reload before continuing.')
      // Older interrupted setup records can lack the derived SDK identifier.
      // Save that repair before allowing backup confirmation or transactions.
      if (needsWalletId) localStorage.setItem(STORAGE_KEY, JSON.stringify(vault))
    } catch (cause) {
      try { await lockLocalWallet() } catch { /* references are cleared before SDK cleanup */ }
      throw new Error('Could not save or validate restored wallet metadata. Enable site storage and retry.', { cause })
    }
    return session
  }
  finally { sessionGate.finishUnlock() }
}

export async function lockLocalWallet() {
  await sessionGate.lock(async () => {
    const id = loadedWalletId
    loadedWalletId = null
    fundingWallet = null
    unlockedSdkKey = null
    loadedVaultIdentity = null
    storedIdentityInvalidated = false
    if (id) {
      const { unloadWalletByID } = await import('@railgun-community/wallet')
      unloadWalletByID(id)
    }
  })
}

export function unlockedFundingWallet() {
  if (!fundingWallet) throw new Error('Wallet is locked')
  assertCurrentStoredIdentity()
  return fundingWallet
}

export function unlockedEncryptionKey() {
  if (!unlockedSdkKey) throw new Error('Private wallet is locked')
  assertCurrentStoredIdentity()
  return unlockedSdkKey
}

export function unlockedWalletId() {
  if (!loadedWalletId) throw new Error('Private wallet is locked')
  assertCurrentStoredIdentity()
  return loadedWalletId
}

export function unlockedSessionVersion() {
  unlockedWalletId()
  return sessionGate.version
}

export function assertUnlockedSession(walletId: string, version: number) {
  if (loadedWalletId !== walletId || !sessionGate.isCurrent(version)) throw new Error('Wallet session changed. Unlock and review again.')
  assertCurrentStoredIdentity()
}

/** Reauthenticate before recovering an unfinished backup after a lock or reload. */
export async function recoveryPhraseForBackup(password: string): Promise<string> {
  const walletId = unlockedWalletId()
  const version = unlockedSessionVersion()
  const vault = storedVault()
  if (!vault || vault.walletId !== walletId) throw new Error('Stored wallet changed. Lock and reload before continuing.')
  if (vault.backupConfirmed === true) throw new Error('This recovery phrase has already been backed up')
  const { mnemonic } = await openVault(vault, password)
  assertUnlockedSession(walletId, version)
  return mnemonic
}

/** UI calls only after the user answers the recovery-word challenge. */
export function confirmWalletBackup(walletId: string) {
  if (unlockedWalletId() !== walletId) throw new Error('Wallet changed during backup')
  const vault = storedVault()
  if (!vault || vault.walletId !== walletId) throw new Error('Stored wallet changed. Lock and reload before continuing.')
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...vault, backupConfirmed: true }))
}
