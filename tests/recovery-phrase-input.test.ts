import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { RecoveryPhraseInput } from '../src/wallet/RecoveryPhraseInput'

// Public BIP-39 test vectors only. These never create, unlock or fund a wallet.
const twelve = 'abandon '.repeat(11) + 'about'
const twentyFour = 'abandon '.repeat(23) + 'art'
function environment() {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/?view=wallet' })
  // React was imported before a browser existed and selected its legacy input
  // observer. Supply those event bindings in this JSDOM-only environment.
  Object.defineProperties(dom.window.HTMLInputElement.prototype, {
    attachEvent: { value(this: HTMLInputElement, type: string, listener: EventListener) { this.addEventListener(type.slice(2), listener) } },
    detachEvent: { value(this: HTMLInputElement, type: string, listener: EventListener) { this.removeEventListener(type.slice(2), listener) } },
  })
  const names = ['window', 'document'] as const
  const previous = names.map(name => Object.getOwnPropertyDescriptor(globalThis, name))
  names.forEach(name => Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] }))
  const root = createRoot(dom.window.document.getElementById('root')!)
  let phrase = ''
  let disabled = false
  const render = () => root.render(createElement(RecoveryPhraseInput, { value: phrase, disabled, onChange(next) { phrase = next; render() } }))
  flushSync(render)
  const inputs = () => [...dom.window.document.querySelectorAll<HTMLInputElement>('.recovery-input-grid input')]
  const paste = (text: string, index = 0) => {
    const event = new dom.window.Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: { getData(format: string) { assert.equal(format, 'text'); return text } } })
    flushSync(() => inputs()[index].dispatchEvent(event))
    assert.equal(event.defaultPrevented, true)
  }
  return { dom, inputs, paste, getPhrase: () => phrase, reset(value = '') { phrase = value; flushSync(render) }, disable() { disabled = true; flushSync(render) }, async cleanup() {
    flushSync(() => root.unmount())
    await new Promise(resolve => setTimeout(resolve, 20))
    dom.window.close()
    names.forEach((name, index) => { if (previous[index]) Object.defineProperty(globalThis, name, previous[index]!); else Reflect.deleteProperty(globalThis, name) })
  } }
}

test('numbered words are masked, keyboard navigable and preserved by reveal/hide', async () => {
  const env = environment()
  try {
    const { dom, inputs, paste } = env
    assert.equal(inputs().length, 12)
    assert.deepEqual(inputs().map(input => input.getAttribute('aria-label')), Array.from({ length: 12 }, (_, i) => `Word ${i + 1}`))
    assert.ok(inputs().every(input => input.type === 'password' && input.required && input.autocomplete === 'off'))
    inputs()[0].focus()
    flushSync(() => inputs()[0].dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })))
    assert.equal(dom.window.document.activeElement, inputs()[1])
    flushSync(() => inputs()[1].dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
    assert.equal(dom.window.document.activeElement, inputs()[2])
    flushSync(() => inputs()[2].dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true })))
    assert.equal(dom.window.document.activeElement, inputs()[1])
    paste(twelve.toUpperCase().replaceAll(' ', '\n'), 4)
    assert.equal(env.getPhrase(), twelve)
    assert.equal(inputs()[11].value, 'about')
    assert.doesNotMatch(dom.window.document.body.textContent!, /abandon|about/)
    const reveal = dom.window.document.querySelector<HTMLButtonElement>('.recovery-input-toolbar button')!
    flushSync(() => reveal.click())
    assert.equal(reveal.getAttribute('aria-pressed'), 'true')
    assert.ok(inputs().every(input => input.type === 'text'))
    flushSync(() => reveal.click())
    assert.ok(inputs().every(input => input.type === 'password'))
    assert.equal(env.getPhrase(), twelve)
    assert.equal(dom.window.localStorage.length, 0)
    env.reset()
    assert.ok(inputs().every(input => input.value === ''), 'a parent clear removes every draft word')
  } finally { await env.cleanup() }
})

test('full-phrase paste supports exactly 12 or 24 words and rejects invalid paste without losing entries', async () => {
  const env = environment()
  try {
    env.paste(twentyFour)
    assert.equal(env.inputs().length, 24)
    assert.equal(env.getPhrase(), twentyFour)
    const count = env.dom.window.document.querySelector<HTMLSelectElement>('.recovery-input-toolbar select')!
    count.value = '12'
    flushSync(() => count.dispatchEvent(new env.dom.window.Event('change', { bubbles: true })))
    assert.equal(count.value, '24')
    assert.equal(env.getPhrase(), twentyFour)
    assert.match(env.dom.window.document.querySelector('[role="alert"]')!.textContent!, /entries have been kept/)
    env.paste('abandon '.repeat(13))
    assert.equal(env.getPhrase(), twentyFour)
    assert.match(env.dom.window.document.querySelector('[role="alert"]')!.textContent!, /exactly 12 or 24/)
    assert.doesNotMatch(env.dom.window.document.querySelector('[role="alert"]')!.textContent!, /abandon/)
    env.paste(twelve)
    assert.equal(env.inputs().length, 12)
    assert.equal(env.getPhrase(), twelve)
    assert.equal(env.dom.window.document.querySelector('[role="alert"]'), null)
    count.value = '24'
    flushSync(() => count.dispatchEvent(new env.dom.window.Event('change', { bubbles: true })))
    assert.equal(env.inputs().length, 24)
    assert.equal(env.inputs()[11].value, 'about')
    assert.equal(env.inputs()[12].value, '')
    count.value = '12'
    flushSync(() => count.dispatchEvent(new env.dom.window.Event('change', { bubbles: true })))
    assert.equal(env.inputs().length, 12)
    env.disable()
    assert.equal(env.dom.window.document.querySelector<HTMLFieldSetElement>('fieldset')!.disabled, true)
    assert.equal(env.dom.window.localStorage.length, 0)
  } finally { await env.cleanup() }
})
