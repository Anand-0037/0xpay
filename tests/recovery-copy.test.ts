import { test } from 'node:test'
import assert from 'node:assert/strict'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { JSDOM } from 'jsdom'
import { RecoveryPhraseStep } from '../src/wallet/WalletPanel.tsx'

const syntheticWords = 'synthetic words for a disposable UI test'

test('recovery words and copy action are absent until reveal', () => {
  const html = renderToStaticMarkup(createElement(RecoveryPhraseStep, { words: syntheticWords, onSaved: () => {}, error: '' }))
  assert.doesNotMatch(html, /synthetic words|Copy recovery phrase/)
  assert.match(html, /Show recovery phrase/)
})

test('copy is user initiated, reports success and failure, and hiding removes words from the page', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://example.test/' })
  const original = { window: globalThis.window, document: globalThis.document, navigator: globalThis.navigator }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true })

  const writes: string[] = []
  Object.defineProperty(dom.window.navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => { writes.push(value) } } })
  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const root = createRoot(container)
  const button = (label: string) => [...container.querySelectorAll('button')].find(candidate => candidate.textContent === label)
  const click = async (label: string) => {
    const target = button(label)
    assert.ok(target, `${label} button must be present`)
    await act(async () => { target.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  }

  try {
    await act(async () => { root.render(createElement(RecoveryPhraseStep, { words: syntheticWords, onSaved: () => {}, error: '' })) })
    assert.equal(writes.length, 0)
    assert.doesNotMatch(container.textContent ?? '', /synthetic words/)
    assert.equal(button('Copy recovery phrase'), undefined)
    assert.equal(button('I saved it')?.disabled, true)

    await click('Show recovery phrase')
    assert.match(container.textContent ?? '', /synthetic words/)
    assert.equal(button('I saved it')?.disabled, false)
    await click('Copy recovery phrase')
    assert.deepEqual(writes, [syntheticWords])
    assert.match(container.querySelector('[role="status"]')?.textContent ?? '', /Copied to clipboard/)

    Object.defineProperty(dom.window.navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('Denied') } } })
    await click('Copied')
    assert.match(container.querySelector('[role="alert"]')?.textContent ?? '', /Clipboard unavailable/)
    await click('Hide recovery phrase')
    assert.doesNotMatch(container.textContent ?? '', /synthetic words/)
    assert.equal(button('Copy recovery phrase'), undefined)
  } finally {
    await act(async () => { root.unmount() })
    Object.defineProperty(globalThis, 'window', { configurable: true, value: original.window })
    Object.defineProperty(globalThis, 'document', { configurable: true, value: original.document })
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: original.navigator })
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT
    dom.window.close()
  }
})
