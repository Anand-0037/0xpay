import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { Wallet, type TypedDataDomain, type TypedDataField } from 'ethers'
import { AgentMandatePanel, type AgentMandatePanelProps } from '../src/agents/AgentMandatePanel'
import { PaperJournal, type AgentPolicy } from '../src/agents/engine'
import { AgentMandateStore } from '../src/agents/mandate-store'

// Only generated, unfunded test EOAs. No real browser, funded keys or RPC.
const signer = Wallet.createRandom(), other = Wallet.createRandom()
const policy = (): AgentPolicy => ({ allowedMarketIds: ['200', '100'], maxOrderMicros: 5_000_000, sessionBudgetMicros: 20_000_000,
  expiresAt: Date.now() + 600_000, maxSnapshotAgeMs: 90_000, maxSpreadMicros: 50_000, maxPriceMicros: 700_000, maxOutcomeSharesMicros: 50_000_000 })
type Typed = { domain: TypedDataDomain; types: Record<string, TypedDataField[]>; message: Record<string, unknown>; primaryType: string }
function provider() {
  const calls: { method: string; params?: readonly unknown[] }[] = []
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const state = { account: signer.address, chain: '0x89' }
  let onSign: ((typed: Typed) => Promise<unknown>) | null = null
  const sign = async (typed: Typed) => {
    const types = { ...typed.types }; delete types.EIP712Domain
    return signer.signTypedData(typed.domain, types, typed.message)
  }
  return { calls, state, sign, setSign(next: (typed: Typed) => Promise<unknown>) { onSign = next }, emit(event: string) { listeners.get(event)?.forEach(listener => listener()) },
    async request(input: { method: string; params?: readonly unknown[] }) {
      calls.push(input)
      assert.ok(['eth_requestAccounts', 'eth_chainId', 'eth_signTypedData_v4'].includes(input.method), 'the panel must never submit a transaction or request a spending key')
      if (input.method === 'eth_requestAccounts') return [state.account]
      if (input.method === 'eth_chainId') return state.chain
      assert.equal(input.params?.[0], signer.address)
      const typed = JSON.parse(String(input.params?.[1])) as Typed
      return onSign ? onSign(typed) : sign(typed)
    },
    on(event: string, listener: (...args: unknown[]) => void) { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event)!.add(listener) },
    removeListener(event: string, listener: (...args: unknown[]) => void) { listeners.get(event)?.delete(listener) },
  }
}
async function environment(wallet: ReturnType<typeof provider> | null = provider(), journalStorage?: Pick<Storage, 'getItem' | 'setItem'>) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/?view=agents' })
  const names = ['window', 'document', 'localStorage', 'navigator'] as const
  const previous = names.map(name => Object.getOwnPropertyDescriptor(globalThis, name))
  let lockQueue = Promise.resolve()
  let nextLockGate: { entered: boolean; wait: Promise<void> } | null = null
  const locks = { request<T>(_name: string, action: () => Promise<T> | T) {
    const gate = nextLockGate; nextLockGate = null
    const next = lockQueue.then(async () => { if (gate) { gate.entered = true; await gate.wait }; return action() })
    lockQueue = next.then(() => {}, () => {}); return next
  } }
  names.forEach(name => Object.defineProperty(globalThis, name, { configurable: true, value: name === 'navigator' ? { locks } : dom.window[name] }))
  if (wallet) Object.defineProperty(dom.window, 'ethereum', { configurable: true, value: wallet })
  const root = createRoot(dom.window.document.getElementById('root')!)
  const journal = new PaperJournal(journalStorage ?? dom.window.localStorage)
  const counters = { stopped: 0, changed: 0, pending: [] as boolean[] }
  let props: AgentMandatePanelProps = { policy: policy(), marketId: '100', watchedAccount: other.address, journal, running: false,
    onChanged() { counters.changed++ }, async onStop() { counters.stopped++ }, onPendingChange(value) { counters.pending.push(value) } }
  const render = (next: Partial<AgentMandatePanelProps> = {}) => { props = { ...props, ...next }; flushSync(() => root.render(createElement(AgentMandatePanel, props))) }
  render()
  const pause = () => new Promise(resolve => setTimeout(resolve, 15))
  const until = async (condition: () => boolean) => { for (let i = 0; i < 100 && !condition(); i++) await pause(); assert.ok(condition(), 'expected panel state did not arrive') }
  const button = (text: string) => [...dom.window.document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === text)
  const click = (text: string) => { const target = button(text); assert.ok(target, `missing action ${text}`); assert.equal(target.disabled, false); flushSync(() => target.click()) }
  const store = () => new AgentMandateStore(dom.window.localStorage, journal.snapshot().sessionId!)
  let unmounted = false
  const unmount = () => { if (!unmounted) { flushSync(() => root.unmount()); unmounted = true } }
  return { dom, wallet, journal, counters, render, button, click, pause, until, store, unmount, holdNextLock() {
    let release!: () => void
    const gate = { entered: false, wait: new Promise<void>(resolve => { release = resolve }) }
    nextLockGate = gate
    return { gate, release }
  }, async prepare() {
    click('Prepare signed paper policy'); await until(() => Boolean(button('Sign paper policy')))
  }, async cleanup() {
    unmount(); await pause(); dom.window.close()
    names.forEach((name, index) => { if (previous[index]) Object.defineProperty(globalThis, name, previous[index]!); else Reflect.deleteProperty(globalThis, name) })
  } }
}

test('browser EOA signs only a fully displayed session-bound paper policy and can locally revoke it', async () => {
  const env = await environment()
  try {
    const { dom, wallet, counters } = env
    assert.match(dom.window.document.body.textContent!, /No signed mandate|Paper policy only/)
    await env.prepare()
    assert.deepEqual(wallet!.calls.map(call => call.method), ['eth_requestAccounts', 'eth_chainId'])
    const review = dom.window.document.querySelector('.agent-mandate-review')!
    assert.match(review.textContent!, /Polygon.*137/)
    assert.match(review.textContent!, /prediction-paper-runner/)
    assert.ok(dom.window.document.querySelector('.agent-mandate-limits')!.textContent!.includes(other.address))
    assert.match(dom.window.document.querySelector('.agent-mandate-limits')!.textContent!, /100|200/)
    assert.match(dom.window.document.body.textContent!, /canSignTransactions = false/)
    assert.match(dom.window.document.body.textContent!, /not proof of account ownership/)
    wallet!.setSign(async typed => {
      assert.equal(typed.primaryType, 'PaperAgentMandate')
      assert.deepEqual(typed.types.EIP712Domain.map(field => field.name), ['name', 'version', 'chainId'])
      assert.equal(typed.message.owner, signer.address)
      assert.equal(typed.message.watchedAccount, other.address)
      assert.equal(typed.message.agentId, 'prediction-paper-runner')
      assert.equal(typed.message.canSignTransactions, false)
      assert.equal(typed.message.budgetMicros, 20_000_000)
      assert.equal(typed.message.maxOrderMicros, 5_000_000)
      assert.equal(typed.message.maxPriceMicros, 700_000)
      assert.equal(typed.message.maxSpreadMicros, 50_000)
      assert.equal(typed.message.maxOutcomeSharesMicros, 50_000_000)
      assert.match(typed.message.nonce as string, /^0x[0-9a-f]{64}$/)
      assert.equal(typed.message.sessionId, env.journal.snapshot().sessionId)
      assert.ok(dom.window.document.querySelector('.agent-mandate-review'), 'review is visible before wallet approval')
      return wallet!.sign(typed)
    })
    env.click('Sign paper policy')
    await env.until(() => counters.changed === 1)
    assert.equal(env.store().load().active!.payload.owner, signer.address)
    assert.equal(env.store().load().active!.payload.watchedAccount, other.address)
    assert.equal(env.journal.snapshot().stopped, true)
    assert.ok(counters.stopped >= 3, 'the runner is stopped before preparation, signing and after the wallet returns')
    assert.equal(counters.pending.at(-1), false)
    assert.match(dom.window.document.querySelector('.agent-mandate-saved')!.textContent!, /Signed paper mandate|Policy digest/)
    assert.equal(dom.window.document.querySelector('.agent-mandate-review'), null)
    const calls = wallet!.calls.length
    env.click('Revoke paper policy')
    await env.until(() => counters.changed === 2)
    const revoked = env.store().load()
    assert.equal(revoked.active, null)
    assert.equal(revoked.revokedDigests.size, 1)
    assert.equal(wallet!.calls.length, calls, 'revocation performs no wallet RPC')
    assert.equal(env.journal.snapshot().stopped, true)
  } finally { await env.cleanup() }
})

test('a missing browser extension gives an actionable error without inventing a signer', async () => {
  const env = await environment(null)
  try {
    env.click('Prepare signed paper policy')
    await env.until(() => Boolean(env.dom.window.document.querySelector('[role="alert"]')))
    assert.match(env.dom.window.document.querySelector('[role="alert"]')!.textContent!, /No browser wallet was found/)
    assert.equal(env.button('Sign paper policy'), undefined)
    assert.equal(env.counters.changed, 0)
    assert.equal(env.journal.snapshot().sessionId, null)
  } finally { await env.cleanup() }
})

for (const changed of ['account', 'chain'] as const) test(`a ${changed} change during the signature prompt cannot activate the old mandate`, async () => {
  const env = await environment()
  try {
    await env.prepare()
    env.wallet!.setSign(async typed => {
      const signed = await env.wallet!.sign(typed)
      if (changed === 'account') env.wallet!.state.account = other.address
      else env.wallet!.state.chain = '0x1'
      return signed
    })
    env.click('Sign paper policy')
    await env.until(() => Boolean(env.dom.window.document.querySelector('[role="alert"]')))
    assert.equal(env.store().load().active, null)
    assert.equal(env.counters.changed, 0)
    assert.equal(env.journal.snapshot().stopped, true)
    assert.equal(env.counters.pending.at(-1), false)
  } finally { await env.cleanup() }
})

test('policy changes and unmount discard late valid signatures instead of activating them', async () => {
  for (const change of ['policy', 'unmount'] as const) {
    const env = await environment()
    try {
      await env.prepare()
      let release!: () => void
      env.wallet!.setSign(async typed => { await new Promise<void>(resolve => { release = resolve }); return env.wallet!.sign(typed) })
      env.click('Sign paper policy')
      await env.until(() => typeof release === 'function')
      if (change === 'policy') env.render({ policy: { ...policy(), sessionBudgetMicros: 21_000_000 } })
      else env.unmount()
      release(); await env.pause(); await env.pause()
      assert.equal(env.store().load().active, null)
      assert.equal(env.counters.changed, 0)
      assert.equal(env.counters.pending.at(-1), false)
      assert.equal(env.journal.snapshot().stopped, true)
    } finally { await env.cleanup() }
  }
})

test('wallet rejection and failed durable session initialization cannot fabricate authorization', async () => {
  const env = await environment()
  try {
    await env.prepare()
    env.wallet!.setSign(async () => { throw { code: 4001, message: 'PRIVATE_PROVIDER_EXCEPTION_MUST_NOT_RENDER' } })
    env.click('Sign paper policy')
    await env.until(() => Boolean(env.dom.window.document.querySelector('[role="alert"]')))
    assert.match(env.dom.window.document.querySelector('[role="alert"]')!.textContent!, /Wallet request cancelled/)
    assert.doesNotMatch(env.dom.window.document.body.textContent!, /PRIVATE_PROVIDER_EXCEPTION/)
    assert.equal(env.store().load().active, null)
    assert.equal(env.counters.changed, 0)
  } finally { await env.cleanup() }
  const failing = await environment(provider(), { getItem() { return null }, setItem() { throw new Error('storage denied') } })
  try {
    failing.click('Prepare signed paper policy')
    await failing.until(() => Boolean(failing.dom.window.document.querySelector('[role="alert"]')))
    assert.equal(failing.wallet!.calls.length, 0)
    assert.equal(failing.counters.changed, 0)
    assert.equal(failing.button('Sign paper policy'), undefined)
  } finally { await failing.cleanup() }
})

test('an account-change event while activation waits for the journal lock invalidates the signature', async () => {
  const env = await environment()
  let held: ReturnType<typeof env.holdNextLock> | null = null
  try {
    await env.prepare()
    let signed = false
    env.wallet!.setSign(async typed => { const signature = await env.wallet!.sign(typed); signed = true; return signature })
    const request = env.wallet!.request.bind(env.wallet)
    env.wallet!.request = async input => {
      const response = await request(input)
      // The post-sign chain check is the last wallet read before authority is
      // updated under the journal lock. Pause that exact lock acquisition.
      if (signed && input.method === 'eth_chainId') held = env.holdNextLock()
      return response
    }
    env.click('Sign paper policy')
    await env.until(() => held !== null && held.gate.entered)
    env.wallet!.state.account = other.address
    flushSync(() => env.wallet!.emit('accountsChanged'))
    held!.release()
    await env.until(() => env.counters.pending.at(-1) === false)
    assert.equal(env.store().load().active, null)
    assert.equal(env.counters.changed, 0)
    assert.equal(env.journal.snapshot().stopped, true)
    assert.match(env.dom.window.document.querySelector('[role="alert"]')!.textContent!, /account or network changed|approval context changed/)
  } finally { held?.release(); await env.cleanup() }
})

test('an authorization-record write failure never reports activation or re-enables the runner', async () => {
  const env = await environment()
  try {
    await env.prepare()
    const prototype = env.dom.window.Storage.prototype
    const original = prototype.setItem
    prototype.setItem = function (key: string, value: string) {
      if (key === '0xpay-paper-mandate-v1') throw new Error('Synthetic mandate-record storage denial')
      return original.call(this, key, value)
    }
    env.click('Sign paper policy')
    await env.until(() => env.counters.pending.at(-1) === false)
    assert.equal(env.counters.changed, 0)
    assert.equal(env.journal.snapshot().stopped, true)
    assert.equal(env.dom.window.document.querySelector('.agent-mandate-saved'), null)
    assert.equal(env.dom.window.document.querySelector('.agent-mandate-state')!.textContent, 'Authorization status unavailable', 'unreadable authority must never be described as absent')
    assert.match(env.dom.window.document.querySelector('[role="alert"]')!.textContent!, /storage|stopped/)
    assert.throws(() => env.store().load(), /unreadable|inconsistent/, 'a torn authorization write cannot look like a fresh valid policy')
    prototype.setItem = original
  } finally { await env.cleanup() }
})
