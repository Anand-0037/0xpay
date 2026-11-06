import test from 'node:test'
import assert from 'node:assert/strict'
import { pastePhrase, phraseWords } from '../src/wallet/phrase-input.ts'

test('paste distributes words without shifting an existing partial phrase or dropping overflow', () => {
  const words = Array<string>(12).fill(''); words[0] = 'first'; words[5] = 'kept'
  const result = pastePhrase(words, 2, ' TWO\nthree\tFOUR ')
  assert.deepEqual(result.words.slice(0, 6), ['first', '', 'two', 'three', 'four', 'kept'])
  assert.equal(result.focus, 5)
  assert.equal(words[2], '')
  assert.throws(() => pastePhrase(words, 11, 'two words'))
  assert.deepEqual(phraseWords('  HELLO\nworld  '), ['hello', 'world'])
})
