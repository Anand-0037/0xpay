import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  connectInjectedWallet, forgetInjectedWallet, getConnectedInjectedSigner, type InjectedProvider,
} from '../src/wallet/injected.ts'

const account = '0x4C748dF523c602a3E58208414b55AA1C961Db3e9'

function stub() {
  let chain = '0xaa36a7'
  let accounts = [account]
  const requests: string[] = []
  const provider: InjectedProvider = { async request({ method }) {
    requests.push(method)
    if (method === 'eth_chainId') return chain
    if (method === 'eth_requestAccounts' || method === 'eth_accounts') return accounts
    throw new Error(`Unexpected wallet method: ${method}`)
  } }
  return { provider, requests, setChain(value: string) { chain = value }, setAccounts(value: string[]) { accounts = value } }
}

test('explicit browser wallet connection checks Sepolia and exposes a checked signer', async () => {
  const wallet = stub()
  try {
    assert.deepEqual(await connectInjectedWallet(wallet.provider), { address: account, chainId: 11155111 })
    const signer = await getConnectedInjectedSigner()
    assert.equal(await signer.getAddress(), account)
    assert.ok(wallet.requests.includes('eth_requestAccounts'))
    assert.ok(wallet.requests.includes('eth_accounts'))
    wallet.setChain('0x1')
    await assert.rejects(getConnectedInjectedSigner(), /Ethereum Sepolia/)
  } finally { forgetInjectedWallet() }
})

test('wrong chain or changed account never yields a signer', async () => {
  const wallet = stub()
  try {
    wallet.setChain('0x1')
    await assert.rejects(connectInjectedWallet(wallet.provider), /Ethereum Sepolia/)
    wallet.setChain('0xaa36a7')
    await connectInjectedWallet(wallet.provider)
    wallet.setAccounts(['0xCE39a395F8b68993eBF95f6c5C63bE7a5688974e'])
    await assert.rejects(getConnectedInjectedSigner(), /account changed/)
  } finally { forgetInjectedWallet() }
})

test('forgetting a wallet cancels an extension response that arrives later', async () => {
  let approve: ((accounts: string[]) => void) | undefined
  const provider: InjectedProvider = { async request({ method }) {
    if (method === 'eth_requestAccounts') return new Promise<string[]>((resolve) => { approve = resolve })
    if (method === 'eth_chainId') return '0xaa36a7'
    throw new Error(`Unexpected wallet method: ${method}`)
  } }
  const connecting = connectInjectedWallet(provider)
  forgetInjectedWallet()
  approve?.([account])
  await assert.rejects(connecting, /cancelled/)
  await assert.rejects(getConnectedInjectedSigner(), /Connect a browser wallet first/)
})
