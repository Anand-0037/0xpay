import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

test('development and build scripts do not invoke an init loader', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  for (const command of Object.values(pkg.scripts) as string[]) {
    assert.doesNotMatch(command, /\bnode\s+(?:\.\/)?init\b/)
  }
  assert.equal(existsSync(new URL('../init', import.meta.url)), false)
})

test('research entry point does not fetch and evaluate executable code', () => {
  const source = readFileSync(new URL('../server/index.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /\beval\s*\(|AUTH_API_KEY|import\(['"]node-fetch['"]\)/)
})

test('local configuration stays outside the repository', () => {
  assert.equal(existsSync(new URL('../.env', import.meta.url)), false)
  const ignore = readFileSync(new URL('../.gitignore', import.meta.url), 'utf8')
  for (const entry of ['.env', '.env.*', '.vscode/*']) {
    assert.ok(ignore.split(/\r?\n/).includes(entry), entry)
  }
})
