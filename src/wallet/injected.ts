import { BrowserProvider, getAddress, isAddress, type Eip1193Provider, type JsonRpcSigner } from 'ethers'

type WalletEvents = {
  on?: (event: string, listener: (...args: unknown[]) => void) => void
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void
}
export type InjectedProvider = Eip1193Provider & WalletEvents
export type InjectedAccount = { address: string; chainId: 11155111 }

let connectedProvider: InjectedProvider | null = null
let connectedAddress: string | null = null
let selectionVersion = 0

export function browserWalletAvailable() {
  return typeof window !== 'undefined' && !!(window as Window & { ethereum?: InjectedProvider }).ethereum
}

function browserWallet(): InjectedProvider {
  const provider = typeof window === 'undefined' ? undefined : (window as Window & { ethereum?: InjectedProvider }).ethereum
  if (!provider || typeof provider.request !== 'function') throw new Error('No browser wallet found. Install MetaMask or another EIP-1193 wallet.')
  return provider
}

async function assertSepolia(provider: InjectedProvider) {
  const chainId: unknown = await provider.request({ method: 'eth_chainId' })
  if (typeof chainId !== 'string' || !/^0x[0-9a-f]+$/i.test(chainId) || BigInt(chainId) !== 11155111n) {
    throw new Error('Switch your browser wallet to Ethereum Sepolia, then reconnect.')
  }
}

function checkedAddress(accounts: unknown): string {
  if (!Array.isArray(accounts) || typeof accounts[0] !== 'string' || !isAddress(accounts[0])) {
    throw new Error('Browser wallet did not provide a valid account.')
  }
  return getAddress(accounts[0])
}

/** Requests account access only after an explicit Connect wallet click. */
export async function connectInjectedWallet(provider: InjectedProvider = browserWallet()): Promise<InjectedAccount> {
  const version = ++selectionVersion
  const accounts: unknown = await provider.request({ method: 'eth_requestAccounts' })
  const address = checkedAddress(accounts)
  await assertSepolia(provider)
  if (version !== selectionVersion) throw new Error('Browser wallet connection was cancelled. Connect again.')
  connectedProvider = provider
  connectedAddress = address
  return { address, chainId: 11155111 }
}

/** Forget only this app's in-memory selection; the extension controls its own permissions. */
export function forgetInjectedWallet() {
  selectionVersion++
  connectedProvider = null
  connectedAddress = null
}

/** Invalidate the selection when the extension changes accounts or networks. */
export function watchInjectedWallet(onInvalidated: () => void) {
  const provider = connectedProvider
  if (!provider?.on || !provider.removeListener) return () => {}
  const invalidate = () => {
    if (connectedProvider !== provider) return
    forgetInjectedWallet()
    onInvalidated()
  }
  for (const event of ['accountsChanged', 'chainChanged', 'disconnect']) provider.on(event, invalidate)
  return () => {
    for (const event of ['accountsChanged', 'chainChanged', 'disconnect']) provider.removeListener?.(event, invalidate)
  }
}

/** Call immediately before a user-authorized transaction. Never cache the returned signer. */
export async function getConnectedInjectedSigner(): Promise<JsonRpcSigner> {
  const provider = connectedProvider
  const address = connectedAddress
  const version = selectionVersion
  if (!provider || !address) throw new Error('Connect a browser wallet first.')
  await assertSepolia(provider)
  if (version !== selectionVersion) throw new Error('Browser wallet connection changed. Reconnect before signing.')
  const accounts: unknown = await provider.request({ method: 'eth_accounts' })
  if (!Array.isArray(accounts) || !accounts.some((account) => typeof account === 'string' && isAddress(account) && getAddress(account) === address)) {
    forgetInjectedWallet()
    throw new Error('Browser wallet account changed. Reconnect before signing.')
  }
  const signer = await new BrowserProvider(provider, 11155111).getSigner(address)
  await assertSepolia(provider)
  if (version !== selectionVersion) throw new Error('Browser wallet connection changed. Reconnect before signing.')
  return signer
}
