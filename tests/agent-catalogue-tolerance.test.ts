import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadMarkets } from '../src/agents/market.ts'

const row = () => ({ id: '101', version: 'v1', conditionId: `0x${'a'.repeat(64)}`, question: 'Synthetic parser fixture?',
  slug: 'fixture', outcomes: '["Yes","No"]', clobTokenIds: '["201","202"]', active: true, closed: false,
  acceptingOrders: true, enableOrderBook: true })

test('invalid rows do not reserve IDs/tokens or hide later valid rows', async () => {
  let skipped = -1
  const badLateField = { ...row(), question: '\u0000' }
  const rows = [null, badLateField, { ...row(), version: 'v2' }, row(), row()]
  const markets = await loadMarkets(undefined, async () => Response.json(rows), count => { skipped = count })
  assert.equal(markets.length, 1)
  assert.equal(markets[0].id, '101')
  assert.equal(skipped, 4)
  assert.match(markets[0].sourceSha256!, /^[a-f0-9]{64}$/)
})

test('empty catalog remains empty; nonempty entirely-invalid catalog fails', async () => {
  let skipped = -1
  assert.deepEqual(await loadMarkets(undefined, async () => Response.json([]), count => { skipped = count }), [])
  assert.equal(skipped, 0)
  await assert.rejects(loadMarkets(undefined, async () => Response.json([null, { ...row(), version: 'v2' }])), /All 2 venue market rows/)
})

test('duplicates within one rejected row do not poison the following valid market', async () => {
  let skipped = 0
  const rows = [{ ...row(), clobTokenIds: '["201","201"]' }, row()]
  assert.equal((await loadMarkets(undefined, async () => Response.json(rows), count => { skipped = count })).length, 1)
  assert.equal(skipped, 1)
})
