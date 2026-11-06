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
  // React was imported before a browser existed and selected its legacy input
  // observer. Supply those event bindings in this JSDOM-only environment.
  Object.defineProperties(dom.window.HTMLInputElement.prototype, {
    attachEvent: { value(this: HTMLInputElement, type: string, listener: EventListener) { this.addEventListener(type.slice(2), listener) } },
    detachEvent: { value(this: HTMLInputElement, type: string, listener: EventListener) { this.removeEventListener(type.slice(2), listener) } },
  })
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

test('setup mode uses one keyboard-selectable radio and import masks numbered recovery words', async () => {
  const { dom, root, cleanup } = environment()
  try {
    flushSync(() => root.render(createElement(WalletPanel, base)))
    const document = dom.window.document
    const group = document.querySelector<HTMLElement>('[role="radiogroup"][aria-label="Wallet setup"]')!
    const modes = [...group.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
    assert.deepEqual(modes.map(mode => mode.getAttribute('aria-checked')), ['true', 'false'])
    assert.deepEqual(modes.map(mode => mode.tabIndex), [0, -1])
    assert.equal(document.querySelector('.recovery-input'), null)
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
    const words = [...document.querySelectorAll<HTMLInputElement>('.recovery-input-grid input')]
    assert.equal(words.length, 12)
    assert.equal(words.every(input => input.type === 'password' && input.autocomplete === 'off'), true)
    assert.match(document.querySelector('.recovery-input-privacy')!.textContent!, /Stop screen sharing/)
    const paste = new dom.window.Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(paste, 'clipboardData', { value: { getData: () => 'abandon '.repeat(11) + 'about' } })
    flushSync(() => words[0].dispatchEvent(paste))
    const revealWords = document.querySelector<HTMLButtonElement>('.recovery-input-toolbar button')!
    flushSync(() => revealWords.click())
    assert.equal(words[0].type, 'text')
    flushSync(() => modes[1].dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true })))
    assert.equal(document.activeElement, modes[0])
    assert.equal(document.querySelector('.recovery-input'), null)
    flushSync(() => modes[1].click())
    const restoredWords = [...document.querySelectorAll<HTMLInputElement>('.recovery-input-grid input')]
    assert.equal(restoredWords[0].value, 'abandon', 'switching onboarding mode keeps the unsaved import draft only in memory')
    assert.equal(restoredWords[11].value, 'about')
    assert.equal(restoredWords.every(input => input.type === 'password'), true, 're-entering import hides words again')
    assert.equal(document.querySelector('.wallet-setup-footnote')!.textContent!.includes('Test ETH only'), false)
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
