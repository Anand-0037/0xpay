import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import NoteBackupControls from '../src/pay/NoteBackupControls'
import type { PayApi } from '../src/pay/types'

test('backup controls explain separate note recovery and never render note secrets or plaintext export', () => {
  const api = { exportNoteBackup: async () => ({ contents: '{}', noteCount: 1 }), restoreNoteBackup: async () => ({ added: 0, existing: 1, reserved: 1, total: 1 }) } as unknown as PayApi
  const markup = renderToStaticMarkup(createElement(NoteBackupControls, { api, paymentBusy: false, onRestored: () => {} }))
  assert.match(markup, /Recovery words restore your wallet address, not its private notes/)
  assert.match(markup, /Download encrypted backup/)
  assert.match(markup, /Restore/)
  assert.equal((markup.match(/type="password"/g) ?? []).length, 2)
  assert.equal(markup.includes('<textarea'), false)
})
test('payments disable opening backup controls and older API stubs show no fake capability', () => {
  const api = { exportNoteBackup: async () => ({ contents: '{}', noteCount: 1 }) } as unknown as PayApi
  const markup = renderToStaticMarkup(createElement(NoteBackupControls, { api, paymentBusy: true, onRestored: () => {} }))
  assert.match(markup, /<button type="button" disabled="">Back up \/ restore notes/)
  assert.equal(renderToStaticMarkup(createElement(NoteBackupControls, { api: {} as PayApi, paymentBusy: false, onRestored: () => {} })), '')
})
