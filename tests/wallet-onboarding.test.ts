import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { createElement, type ComponentProps } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { WalletPanel } from '../src/wallet/WalletPanel'

const base: ComponentProps<typeof WalletPanel> = {
  blockNumber: null, engineReady: false, shieldFeeBasisPoints: null, connectionFailed: false,
  session: null, onRetry() {}, onSession() {},
}
function environment() {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/?view=wallet' })
  const names = ['window', 'document', 'localStorage'] as const
  const previous = names.map(name => Object.getOwnPropertyDescriptor(globalThis, name))
  names.forEach(name => Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] }))
  const root = createRoot(dom.window.document.getElementById('root')!)
  return { dom, root, async cleanup() {
    flushSync(() => root.unmount())
    await new Promise(resolve => setTimeout(resolve, 30))
    dom.window.close()
    names.forEach((name, index) => {
      if (previous[index]) Object.defineProperty(globalThis, name, previous[index]!)
      else Reflect.deleteProperty(globalThis, name)
    })
  } }
}

test('setup mode uses one keyboard-selectable radio and import visibly warns about unmasked recovery words', async () => {
  const { dom, root, cleanup } = environment()
  try {
    flushSync(() => root.render(createElement(WalletPanel, base)))
    const document = dom.window.document
    const group = document.querySelector<HTMLElement>('[role="radiogroup"][aria-label="Wallet setup"]')!
    const modes = [...group.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
    assert.deepEqual(modes.map(mode => mode.getAttribute('aria-checked')), ['true', 'false'])
    assert.deepEqual(modes.map(mode => mode.tabIndex), [0, -1])
    assert.equal(document.querySelector('#wallet-import-phrase'), null)
    const password = document.querySelector<HTMLInputElement>('#wallet-local-password')!
    assert.equal(password.type, 'password')
    assert.equal(password.minLength, 12)
    assert.equal(password.getAttribute('aria-describedby'), 'wallet-password-requirements')
    assert.match(document.getElementById('wallet-password-requirements')!.textContent!, /at least 12 characters/)
    assert.equal(password.hasAttribute('placeholder'), false, 'requirements remain visible after typing')
    const reveal = document.querySelector<HTMLButtonElement>('[aria-controls="wallet-local-password"]')!
    flushSync(() => reveal.click())
    assert.equal(password.type, 'text')
    assert.equal(reveal.getAttribute('aria-pressed'), 'true')
    modes[0].focus()
    flushSync(() => modes[0].dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })))
    assert.equal(document.activeElement, modes[1])
    assert.deepEqual(modes.map(mode => mode.getAttribute('aria-checked')), ['false', 'true'])
    assert.deepEqual(modes.map(mode => mode.tabIndex), [-1, 0])
    assert.equal(password.type, 'password', 'switching setup mode hides the password again')
    const phrase = document.querySelector<HTMLTextAreaElement>('#wallet-import-phrase')!
    assert.equal(phrase.tagName, 'TEXTAREA')
    assert.equal(phrase.autocomplete, 'off')
    assert.equal(phrase.getAttribute('aria-describedby'), 'wallet-import-visibility')
    assert.match(document.getElementById('wallet-import-visibility')!.textContent!, /visible.*Stop screen sharing/)
    flushSync(() => modes[1].dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true })))
    assert.equal(document.activeElement, modes[0])
    assert.equal(document.querySelector('#wallet-import-phrase'), null)
    assert.equal(dom.window.localStorage.length, 0, 'onboarding inspection does not create a vault or persist credentials')
  } finally { await cleanup() }
})

test('manual disconnect blocks wallet setup without describing a deliberate stop as a connection failure', async () => {
  const { dom, root, cleanup } = environment()
  let retries = 0
  try {
    flushSync(() => root.render(createElement(WalletPanel, { ...base, blockNumber: 12000000, engineReady: true,
      connectionFailed: true, disconnectedByUser: true, connectionMessage: 'Worker closed', onRetry() { retries++ } })))
    const document = dom.window.document
    const notice = document.querySelector<HTMLElement>('.wallet-setup-connection')!
    assert.equal(notice.getAttribute('role'), 'status')
    assert.match(notice.textContent!, /You disconnected the private route/)
    assert.doesNotMatch(notice.textContent!, /failed|Worker closed/i)
    assert.equal(document.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled, true)
    flushSync(() => notice.querySelector<HTMLButtonElement>('button')!.click())
    assert.equal(retries, 1)

    flushSync(() => root.render(createElement(WalletPanel, { ...base, connectionFailed: true,
      connectionMessage: 'Wallet database needs a fresh page.', connectionActionLabel: 'Refresh app' })))
    assert.equal(notice.getAttribute('role'), 'alert')
    assert.match(notice.textContent!, /Wallet database needs a fresh page/)
    assert.equal(notice.querySelector('button')!.textContent, 'Refresh app')
  } finally { await cleanup() }
})
