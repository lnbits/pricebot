import preparePricebotChart from '../../static/chart-data.js'
import assert from 'node:assert/strict'
import {test} from 'node:test'
import {createHistory, windowRange, DAY, HOUR} from '../src/history.js'
import {memoryStore, fixture} from './helpers.js'

function historyFixture() {
  const tables = new Map(),
    storage = memoryStore(tables),
    publicStorage = memoryStore(tables, null)
  const history = createHistory({storage, publicStorage}),
    rawChart = history.chart
  history.chart = (range, now) => {
    const first = rawChart(range, now)
    let offset = first.nextOffset
    while (offset !== null) {
      const page = rawChart(range, now, offset)
      first.chunks.push(...page.chunks)
      offset = page.nextOffset
    }
    return preparePricebotChart(first)
  }
  return {storage, history}
}

test('collector deduplicates a minute and preserves open, high, low, close at each level', () => {
  const f = fixture(),
    start = Math.floor(f.now() / HOUR) * HOUR
  f.observe(100000, start)
  f.observe(101000, start + 60)
  f.observe(99000, start + 120)
  f.observe(100500, start + 180)
  assert.equal(f.observe(200000, start + 190).collected, false)
  for (const resolution of ['hour', 'day', 'month:2027']) {
    const rows = resolution.startsWith('month')
      ? preparePricebotChart(f.bot.getHistory({range: 'ALL'})).points
      : createHistory({
          storage: f.collectorStorage,
          publicStorage: f.publicStorage
        }).read(resolution)
    assert.equal(rows.length, 1)
    const row = rows[0]
    assert.deepEqual(
      [row.open, row.high, row.low, row.close, row.count],
      [100000, 101000, 99000, 100500, 4]
    )
    assert.equal(row.highAt, start + 60)
    assert.equal(row.lowAt, start + 120)
  }
  f.setPrice(NaN)
  assert.throws(() => f.collector.collectPrices(), /invalid BTC price/)
})

test('retains minute/day, hourly/week, daily/366 days, monthly forever', () => {
  const {storage, history} = historyFixture(),
    start = Date.UTC(2024, 0, 1) / 1000
  for (let day = 0; day <= 400; day++)
    history.collect(100000 + day, start + day * DAY)
  const now = start + 400 * DAY
  for (const [resolution, duration] of [
    ['minute', DAY],
    ['hour', 7 * DAY],
    ['day', 366 * DAY]
  ]) {
    const rows = history.read(resolution)
    assert.equal(rows[0].last, now - duration)
    assert.ok(rows.every(row => row.last >= now - duration))
  }
  const monthly = history.chart('ALL', now)
  assert.equal(monthly.points[0].first, start)
  assert.equal(monthly.points.length, 14)
  assert.equal(monthly.low, 100000)
  assert.equal(
    storage.list('history', {filters: {resolution: 'month'}}).total,
    2,
    'two calendar-year chunks'
  )
})

test('retains every minute through the one-day boundary', () => {
  const {history} = historyFixture(),
    start = 1800000000
  for (let minute = 0; minute <= 1442; minute++)
    history.collect(100000 + minute, start + minute * 60)
  const rows = history.read('minute')
  assert.equal(rows.length, 1441)
  assert.equal(rows[0].last, start + 120)
  const hourly = history.read('hour')
  assert.equal(
    hourly.reduce((sum, row) => sum + row.count, 0),
    1443
  )
})

test('UTC month buckets handle leap day and the calendar-year boundary', () => {
  const {history} = historyFixture()
  for (const [date, price] of [
    ['2024-02-28T23:59:00Z', 100],
    ['2024-02-29T23:59:00Z', 120],
    ['2024-03-01T00:00:00Z', 90],
    ['2024-12-31T23:59:00Z', 80],
    ['2025-01-01T00:00:00Z', 110]
  ])
    history.collect(price, Date.parse(date) / 1000)
  const rows = history.chart(
    'ALL',
    Date.parse('2025-01-01T00:01:00Z') / 1000
  ).points
  assert.equal(rows.length, 4)
  assert.equal(rows[0].end - rows[0].start, 29 * DAY)
  assert.deepEqual(
    [rows[0].open, rows[0].high, rows[0].close, rows[0].count],
    [100, 120, 120, 2]
  )
  assert.equal(rows[3].start, Date.UTC(2025, 0, 1) / 1000)
})

test('retry repairs a partially written rollup using the original minute price', () => {
  const tables = new Map(),
    storage = memoryStore(tables),
    publicStorage = memoryStore(tables, null)
  let fail = true
  const history = createHistory({
    storage: {
      ...storage,
      set(table, row) {
        if (row.resolution === 'day' && fail) throw new Error('Interrupted')
        storage.set(table, row)
      }
    },
    publicStorage
  })
  assert.throws(() => history.collect(100, 1800000000), /Interrupted/)
  fail = false
  assert.equal(history.collect(999, 1800000000).collected, false)
  for (const resolution of ['minute', 'hour', 'day']) {
    assert.equal(history.read(resolution)[0].close, 100)
    assert.equal(history.read(resolution)[0].count, 1)
  }
})

test('charts select retained resolutions, preserve extrema, and return empty ranges honestly', () => {
  const {history} = historyFixture(),
    now = 1800000000
  assert.deepEqual(history.chart('1D', now).points, [])
  history.collect(100, now - DAY)
  history.collect(200, now - 60)
  history.collect(150, now)
  for (const [range, resolution] of [
    ['1D', 'minute'],
    ['1W', 'hour'],
    ['1M', 'day'],
    ['1Y', 'day'],
    ['ALL', 'month']
  ]) {
    const result = history.chart(range, now)
    assert.equal(result.resolution, resolution)
    assert.equal(result.low, 100)
    assert.equal(result.high, 200)
    assert.equal(result.change, 50)
  }
  assert.throws(() => history.chart('bad', now), /Choose/)
  assert.deepEqual(history.chart('1D', now + 2 * DAY).points, [])
})

test('older hourly/daily/monthly extrema remain usable after minute samples expire', () => {
  const {history} = historyFixture(),
    now = Date.UTC(2026, 0, 3) / 1000
  history.collect(70000, now - 400 * DAY)
  history.collect(80000, now - 20 * DAY)
  history.collect(120000, now - 2 * DAY)
  history.collect(100000, now)
  assert.equal(
    windowRange(history.load(now, 3 * DAY), now, 3 * DAY).variation,
    20000
  )
  assert.equal(
    windowRange(history.load(now, 30 * DAY), now, 30 * DAY).variation,
    40000
  )
  assert.equal(
    windowRange(history.load(now, 500 * DAY), now, 500 * DAY).variation,
    50000
  )
})

test('an expired high in a partial old bucket cannot produce a false alert', () => {
  const {history} = historyFixture(),
    now = Date.UTC(2026, 0, 3) / 1000
  history.collect(150000, now - 2 * DAY)
  history.collect(100000, now - 2 * DAY + 1800)
  history.collect(100000, now)
  const range = windowRange(
    history.load(now, 2 * DAY - 600),
    now,
    2 * DAY - 600
  )
  assert.equal(range.variation, 0)
  assert.equal(
    range.upperVariation,
    50000,
    'do not rearm using incomplete older-bucket evidence'
  )
})

test('journal recovery preserves a sample when the next run crosses a UTC year boundary', () => {
  const tables = new Map(),
    storage = memoryStore(tables),
    publicStorage = memoryStore(tables, null)
  let fail = true
  const history = createHistory({
    storage: {
      ...storage,
      set(table, row) {
        if (row.resolution === 'hour' && fail) throw new Error('Interrupted')
        storage.set(table, row)
      }
    },
    publicStorage
  })
  const before = Date.UTC(2025, 11, 31, 23, 59) / 1000
  assert.throws(() => history.collect(100, before), /Interrupted/)
  fail = false
  history.collect(150, before + 60)
  const months = preparePricebotChart(history.chart('ALL', before + 60)).points
  assert.deepEqual(
    months.map(row => [row.close, row.count]),
    [
      [100, 1],
      [150, 1]
    ]
  )
  assert.equal(history.status(before + 60).latest[1], 150)
  assert.equal(storage.get('history', 'btc-usd:pending'), null)
})

test('prunes expired chunks after a long outage within the host storage-call budget', () => {
  const {storage, history} = historyFixture(),
    start = Date.UTC(2024, 0, 1) / 1000
  for (let day = 0; day <= 400; day++)
    history.collect(100000, start + day * DAY)
  for (let minute = 1; minute <= 1440; minute++)
    history.collect(100000, start + 400 * DAY + minute * 60)
  storage.calls.length = 0
  history.collect(110000, start + 800 * DAY)
  assert.ok(storage.calls.length < 100)
  for (const resolution of ['minute', 'hour', 'day'])
    assert.equal(history.read(resolution).length, 1)
  assert.ok(history.chart('ALL', start + 800 * DAY).points.length > 12)
})
