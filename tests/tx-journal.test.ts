import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Wallet, Interface, ZeroAddress, ZeroHash, keccak256 } from 'ethers'
import { ABIRailgunSmartWallet, ABIRelayAdapt } from '@railgun-community/engine'
import { NETWORK_CONFIG, NetworkName } from '@railgun-community/shared-models'
import { findTransaction, markTransaction, readTransactions, recordSubmitted, recordSignedTransaction, signedTransactionForRecovery, unresolvedTransaction, unresolvedFundingTransaction } from '../src/domain/tx-journal.ts'

function memoryStorage() {
  const items = new Map<string, string>()
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => { items.set(key, value) },
  }
}

const hash = `0x${'12'.repeat(32)}`
const from = `0x${'34'.repeat(20)}`
const sepolia = NETWORK_CONFIG[NetworkName.EthereumSepolia]
const relay = new Interface(ABIRelayAdapt)
const smartWallet = new Interface(ABIRailgunSmartWallet)
// Structurally valid calldata fixtures only; zeros here are not a ZK proof.
function sendData(unshield = 0) {
  return smartWallet.encodeFunctionData('transact', [[{
    proof: { a: { x: 0, y: 0 }, b: { x: [0, 0], y: [0, 0] }, c: { x: 0, y: 0 } },
    merkleRoot: ZeroHash, nullifiers: [ZeroHash], commitments: [ZeroHash],
    boundParams: { treeNumber: 0, minGasPrice: 0, unshield, chainID: 11155111,
      adaptContract: ZeroAddress, adaptParams: ZeroHash, commitmentCiphertext: [{
        ciphertext: [ZeroHash, ZeroHash, ZeroHash, ZeroHash], blindedSenderViewingKey: ZeroHash,
        blindedReceiverViewingKey: ZeroHash, annotationData: '0x', memo: '0x',
      }] },
    unshieldPreimage: { npk: ZeroHash, token: { tokenType: 0, tokenAddress: ZeroAddress, tokenSubID: 0 }, value: 0 },
  }]])
}
function shieldData(requireSuccess = true, wrappedAmount = 1n, innerTarget = sepolia.relayAdaptContract, tokenAddress = sepolia.baseToken.wrappedAddress) {
  const shield = { preimage: { npk: ZeroHash, token: { tokenType: 0, tokenAddress, tokenSubID: 0 }, value: 1 },
    ciphertext: { encryptedBundle: [ZeroHash, ZeroHash, ZeroHash], shieldKey: ZeroHash } }
  return relay.encodeFunctionData('multicall', [requireSuccess, [
    { to: innerTarget, data: relay.encodeFunctionData('wrapBase', [wrappedAmount]), value: 0 },
    { to: innerTarget, data: relay.encodeFunctionData('shield', [[shield]]), value: 0 },
  ]])
}

test('a submitted transaction survives a fresh reader and blocks duplicate intent until reconciled', () => {
  const storage = memoryStorage()
  recordSubmitted('send', hash, from, storage)
  assert.equal(unresolvedTransaction('send', storage)?.hash, hash)
  assert.equal(unresolvedFundingTransaction(from, storage)?.hash, hash)
  assert.equal(unresolvedFundingTransaction(`0x${'56'.repeat(20)}`, storage), undefined)
  assert.equal(readTransactions(storage).length, 1)
  recordSubmitted('send', hash, from, storage)
  assert.equal(readTransactions(storage).length, 1)
  markTransaction(hash, 'unknown', storage)
  assert.equal(unresolvedTransaction('send', storage)?.status, 'unknown')
  markTransaction(hash, 'confirmed', storage)
  assert.equal(unresolvedTransaction('send', storage), undefined)
  assert.equal(unresolvedFundingTransaction(from, storage), undefined)
  assert.equal(findTransaction(hash, storage)?.status, 'confirmed')
  assert.throws(() => markTransaction(hash, 'reverted', storage), /cannot be changed/)
})

test('damaged local transaction history cannot silently be overwritten', () => {
  const storage = memoryStorage()
  storage.setItem('0xpay.transactions.v1', '[{"hash":"broken"}]')
  assert.throws(() => recordSubmitted('shield', hash, from, storage), /damaged/)
  assert.throws(() => unresolvedTransaction('shield', storage), /damaged/)
})

test('signed recovery survives reload and rejects corrupted identity or completed payments', async () => {
  const storage = memoryStorage()
  const wallet = Wallet.createRandom()
  const raw = await wallet.signTransaction({ to: sepolia.proxyContract, data: sendData(), value: 0n, nonce: 7, gasLimit: 1_000_000n,
    type: 2, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n, chainId: 11155111 })
  const saved = recordSignedTransaction('send', raw, wallet.address, storage)
  const freshReader = { getItem: storage.getItem }
  assert.equal(signedTransactionForRecovery(saved.hash, wallet.address, freshReader).signedTransaction, raw)
  assert.equal(signedTransactionForRecovery(saved.hash, wallet.address, freshReader).nonce, 7)
  for (const altered of [ { hash: `0x${'56'.repeat(32)}` }, { from }, { nonce: 8 }, { signedTransaction: raw.slice(0, -2) } ]) {
    storage.setItem('0xpay.transactions.v1', JSON.stringify([{ ...saved, ...altered }]))
    assert.throws(() => readTransactions(storage), /signed transaction/i)
  }
  storage.setItem('0xpay.transactions.v1', JSON.stringify([saved]))
  markTransaction(saved.hash, 'confirmed', storage)
  assert.throws(() => signedTransactionForRecovery(saved.hash, wallet.address, storage), /Completed/)
  assert.throws(() => recordSignedTransaction('send', raw, wallet.address, storage), /Completed/)
  storage.setItem('0xpay.transactions.v1', JSON.stringify([{ ...saved, status: 'reverted' }]))
  assert.throws(() => signedTransactionForRecovery(saved.hash, wallet.address, storage), /Completed/)
  const wrongChain = await wallet.signTransaction({ to: wallet.address, nonce: 0, gasLimit: 21000n, gasPrice: 1n, chainId: 1 })
  assert.throws(() => recordSignedTransaction('send', wrongChain, wallet.address, memoryStorage()), /signed transaction/i)
})

test('journal refuses relabeled, unrelated or malformed RAILGUN replay while preserving legacy readability', async () => {
  const wallet = Wallet.createRandom()
  const fees = { nonce: 0, gasLimit: 1_000_000n, type: 2, maxFeePerGas: 2_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n, chainId: 11155111 }
  const shieldRaw = await wallet.signTransaction({ ...fees, to: sepolia.relayAdaptContract, data: shieldData(), value: 1n })
  const validShield = recordSignedTransaction('shield', shieldRaw, wallet.address, memoryStorage())
  assert.equal(validShield.signedTransaction, shieldRaw)
  const unrelated = await wallet.signTransaction({ ...fees, to: wallet.address, value: 1n })
  const legacy = { kind: 'send', hash: keccak256(unrelated), from: wallet.address, status: 'submitted',
    createdAt: Date.now(), signedTransaction: unrelated, nonce: 0 }
  const legacyStorage = memoryStorage()
  legacyStorage.setItem('0xpay.transactions.v1', JSON.stringify([legacy]))
  assert.equal(readTransactions(legacyStorage).length, 1)
  assert.throws(() => signedTransactionForRecovery(legacy.hash, wallet.address, legacyStorage), /supported Sepolia RAILGUN/)
  assert.throws(() => recordSignedTransaction('send', shieldRaw, wallet.address, memoryStorage()), /supported Sepolia RAILGUN/)
  for (const invalid of [
    { to: wallet.address, data: sendData(), value: 0n, kind: 'send' },
    { to: sepolia.proxyContract, data: sendData(), value: 1n, kind: 'send' },
    { to: sepolia.proxyContract, data: sendData(1), value: 0n, kind: 'send' },
    { to: sepolia.proxyContract, data: sendData() + '00', value: 0n, kind: 'send' },
    { to: sepolia.proxyContract, data: '0xd8ae136a', value: 0n, kind: 'send' },
    { to: sepolia.relayAdaptContract, data: shieldData(false), value: 1n, kind: 'shield' },
    { to: sepolia.relayAdaptContract, data: shieldData(true, 2n), value: 1n, kind: 'shield' },
    { to: sepolia.relayAdaptContract, data: shieldData(true, 1n, wallet.address), value: 1n, kind: 'shield' },
    { to: sepolia.relayAdaptContract, data: shieldData(true, 1n, sepolia.relayAdaptContract, wallet.address), value: 1n, kind: 'shield' },
  ] as const) {
    const raw = await wallet.signTransaction({ ...fees, to: invalid.to, data: invalid.data, value: invalid.value })
    assert.throws(() => recordSignedTransaction(invalid.kind, raw, wallet.address, memoryStorage()), /supported Sepolia RAILGUN/)
  }
})
