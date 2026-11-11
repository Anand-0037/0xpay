import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import qrcode from '../src/pay/vendor/qrcode.mjs'

test('build entry points do not invoke untracked init loaders', () => {
  for (const name of ['package.json', 'protocol/contracts/package.json']) {
    const pkg = JSON.parse(readFileSync(new URL('../' + name, import.meta.url), 'utf8'))
    for (const command of Object.values(pkg.scripts) as string[]) {
      assert.doesNotMatch(command, /\bnode\s+(?:\.\/)?init\b/, name)
    }
  }
  for (const name of ['init', 'protocol/contracts/init']) {
    assert.equal(existsSync(new URL('../' + name, import.meta.url)), false, name)
  }
})

test('vendored QR generator remains browser compatible', () => {
  const source = readFileSync(new URL('../src/pay/vendor/qrcode.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /createRequire|\bprocess\.|\brequire\s*\(/)
  const qr = qrcode(0, 'M')
  qr.addData('https://wallet.example/#test')
  qr.make()
  assert.ok(qr.getModuleCount() > 0)
  assert.equal(typeof qr.isDark(0, 0), 'boolean')
})

test('local environment and editor files remain ignored', () => {
  const ignore = readFileSync(new URL('../.gitignore', import.meta.url), 'utf8')
  for (const entry of ['.env', '.env.*', '.vscode/*']) {
    assert.ok(ignore.split(/\r?\n/).includes(entry), entry)
  }
})
