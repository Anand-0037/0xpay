import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyOutgoingRequest } from '../src/net/network-guard.ts'

const origin = 'https://wallet.example'
const markets = 'https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=20&order=volume24hr&ascending=false&version=v1'
const book = 'https://clob.polymarket.com/book?token_id=123'
const classify = (url: string, method = 'GET', body: unknown = undefined, enabled = true) =>
  classifyOutgoingRequest(url, method, body, origin, new Set(), false, 'nox', enabled)

test('public venue reads cannot bypass the worker through page fetch or XHR', () => {
  for (const url of [markets, book]) {
    assert.equal(classify(url), 'blocked')
    assert.equal(classify(url, 'GET', undefined, false), 'blocked')
    assert.equal(classify(url, 'POST'), 'blocked')
    assert.equal(classify(url, 'GET', 'private request data'), 'blocked')
  }
})

test('venue reads cannot carry wallet queries, duplicate parameters or order requests', () => {
  for (const url of [
    `${markets}&user=0x1111111111111111111111111111111111111111`, `${markets}&active=true`,
    markets.replace('limit=20', 'limit=2000'), markets.replace('version=v1', 'version=v2'),
    `${book}&token_id=456`, `${book}&address=0x1111`, `${book}#private`,
    book.replace('token_id=123','token_id=0123'), book.replace('token_id=123','token_id=0'),
    book.replace('token_id=123', `token_id=${1n << 256n}`),
    book.replace('https://', 'https://user:secret@'), book.replace('polymarket.com','polymarket.com.evil.test'),
    'https://clob.polymarket.com/order', 'https://clob.polymarket.com/auth/api-key',
    'https://polygon.publicnode.com',
  ]) assert.equal(classify(url), 'blocked', url)
})
