import { HDNodeWallet, Mnemonic, randomBytes } from 'ethers'
import { openVault, sealMnemonic, type StoredVault } from './vault.ts'
import { SessionGate } from './session.ts'
export type WalletSession = { id: string; publicAddress: string; backupConfirmed: boolean; generation: number }
const STORAGE_KEY = '0xpay.vault.v1'
const gate = new SessionGate()
let wallet: HDNodeWallet | null = null
let encryptionKey: string | null = null
let loadedIdentity: string | null = null
function identity(vault: StoredVault) { return JSON.stringify([vault.salt, vault.nonce, vault.ciphertext, vault.creationBlock]) }
export function hasStoredVault() { try { return localStorage.getItem(STORAGE_KEY) !== null } catch { return false } }
export function storedVault(): StoredVault | null {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) return null
  const value: unknown = JSON.parse(raw)
  if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1 || !('salt' in value) || typeof value.salt !== 'string' || !('nonce' in value) || typeof value.nonce !== 'string' || !('ciphertext' in value) || typeof value.ciphertext !== 'string' || !('creationBlock' in value) || typeof value.creationBlock !== 'number') throw new Error('Local wallet record is damaged')
  return value as StoredVault
}
function assertIdentity() { const vault = storedVault(); if (!vault || identity(vault) !== loadedIdentity) throw new Error('Stored wallet changed. Lock and reload.') }
async function unlock(vault: StoredVault, password: string, generation: number): Promise<WalletSession> {
  const { mnemonic, sdkKey } = await openVault(vault, password)
  gate.assertCurrent(generation)
  const derived = HDNodeWallet.fromPhrase(mnemonic)
  wallet = derived; encryptionKey = sdkKey; loadedIdentity = identity(vault)
  return { id: derived.address.toLowerCase(), publicAddress: derived.address, backupConfirmed: vault.backupConfirmed === true, generation }
}
async function create(phrase: string, password: string, creationBlock: number, imported: boolean) {
  if (hasStoredVault()) throw new Error('A local wallet already exists; unlock it instead')
  const generation = gate.beginUnlock()
  try {
    const vault = await sealMnemonic(phrase, password, creationBlock)
    vault.backupConfirmed = imported
    const session = await unlock(vault, password, generation)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(vault))
    return { session, recoveryPhrase: phrase }
  } catch (error) { wallet = null; encryptionKey = null; loadedIdentity = null; throw error }
  finally { gate.finishUnlock() }
}
export async function createLocalWallet(password: string, blockNumber: number) { return create(Mnemonic.fromEntropy(randomBytes(16)).phrase, password, blockNumber, false) }
export async function importLocalWallet(phrase: string, password: string) { return (await create(Mnemonic.fromPhrase(phrase.trim()).phrase, password, 0, true)).session }
export async function unlockLocalWallet(password: string) { const vault = storedVault(); if (!vault) throw new Error('No local wallet exists'); const generation = gate.beginUnlock(); try { return await unlock(vault, password, generation) } finally { gate.finishUnlock() } }
export async function lockLocalWallet() { await gate.lock(() => { wallet = null; encryptionKey = null; loadedIdentity = null }) }
export function unlockedFundingWallet() { if (!wallet) throw new Error('Wallet is locked'); assertIdentity(); return wallet }
export function unlockedEncryptionKey() { if (!encryptionKey) throw new Error('Wallet is locked'); assertIdentity(); return encryptionKey }
export function unlockedWalletId() { return unlockedFundingWallet().address.toLowerCase() }
export function unlockedSessionVersion() { unlockedWalletId(); return gate.version }
export function assertUnlockedSession(id: string, version: number) { if (unlockedWalletId() !== id || gate.version !== version) throw new Error('Wallet session changed') }
export async function recoveryPhraseForBackup(password: string) { const vault = storedVault(); if (!vault || vault.backupConfirmed) throw new Error('Backup unavailable'); return (await openVault(vault, password)).mnemonic }
export function confirmWalletBackup(id: string) { if (unlockedWalletId() !== id) throw new Error('Wallet changed'); const vault = storedVault(); if (!vault) throw new Error('Vault missing'); localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...vault, backupConfirmed: true })) }
