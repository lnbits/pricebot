import assert from 'node:assert/strict'
import {test} from 'node:test'
import {createPricebot} from '../src/logic.js'

const DAY = 86400
const clone = value => (value == null ? value : structuredClone(value))

function memoryStore() {
  const tables = new Map()
  const table = name => {
    if (!tables.has(name)) tables.set(name, new Map())
    return tables.get(name)
  }
  return {
    get(name, id) {
      return clone(table(name).get(id) || null)
    },
    set(name, row) {
      table(name).set(row.id, clone(row))
    },
    delete(name, id) {
      table(name).delete(id)
    },
    list(name, options = {}) {
      const rows = [...table(name).values()].sort((a, b) => {
        const left = a[options.sortBy],
          right = b[options.sortBy]
        return (
          (left < right ? -1 : left > right ? 1 : 0) *
          (options.descending ? -1 : 1)
        )
      })
      return {
        data: clone(
          rows.slice(
            options.offset || 0,
            (options.offset || 0) + (options.limit || 100)
          )
        ),
        total: rows.length
      }
    }
  }
}

function fixture() {
  let now = 1800000000,
    price = 100000,
    sequence = 0,
    fails = false
  const storage = memoryStore(),
    shared = memoryStore(),
    jobs = new Map(),
    messages = []
  let saves = 0,
    clockReads = 0
  const bot = createPricebot({
    storage,
    shared,
    system: {
      now: () => {
        clockReads++
        return now
      },
      id: prefix => `${prefix}-${++sequence}`
    },
    currencies: {rate: () => ({price})},
    notifications: {
      send(channel, message) {
        if (fails) throw new Error('Queue unavailable')
        messages.push({channel, message})
        return {queued: true}
      }
    },
    scheduler: {
      list: scope =>
        [...jobs.values()].filter(job => job.scope === scope).map(clone),
      set(job) {
        saves++
        const value = {...job, id: `${job.scope}:${job.handler}`}
        jobs.set(value.id, clone(value))
        return value
      }
    }
  })
  return {
    bot,
    storage,
    shared,
    jobs,
    messages,
    now: () => now,
    advance: seconds => (now += seconds),
    setTime: value => (now = value),
    setPrice: value => (price = value),
    failNotifications: value => (fails = value),
    saves: () => saves,
    clockReads: () => clockReads,
    observe(value, timestamp = now) {
      now = timestamp
      price = value
      bot.collectPrices()
    },
    alert(options = {}) {
      bot.savePreferences({channel: 'email', dailySummary: false})
      return bot.saveAlert({
        name: 'My alert',
        amountUsd: 100,
        windowMinutes: 1,
        ...options
      }).alert
    }
  }
}

test('creates two shared jobs and at most one user job per handler', () => {
  const f = fixture()
  f.bot.setupShared()
  f.bot.setupShared()
  assert.equal(f.jobs.size, 2)
  f.alert()
  f.alert({name: 'Another'})
  assert.equal(f.jobs.size, 4)
  assert.equal(f.saves(), 4, 'saving alerts must not postpone existing jobs')
  assert.equal(f.jobs.get('user:daily-summary').enabled, false)
  f.bot.savePreferences({channel: 'nostr', dailySummary: true})
  assert.equal(f.jobs.get('user:daily-summary').enabled, true)
  assert.equal(f.jobs.size, 4)
})

test('stores one observation per minute in hourly records', () => {
  const f = fixture()
  f.observe(100000)
  f.setPrice(200000)
  assert.equal(f.bot.collectPrices().collected, false)
  f.advance(60)
  f.observe(100100)
  const rows = f.shared.list('prices').data
  assert.equal(rows.length, 1)
  assert.deepEqual(
    JSON.parse(rows[0].samples_json).map(value => value[1]),
    [100000, 100100]
  )
  f.setPrice(NaN)
  assert.throws(() => f.bot.collectPrices(), /invalid BTC price/)
})

test('alerts on crossings in either direction and rearms only when the condition clears', () => {
  const f = fixture()
  f.alert()
  f.observe(100000)
  assert.equal(f.bot.checkAlerts().queued, 0)
  f.advance(60)
  f.observe(100100)
  assert.equal(f.bot.checkAlerts().queued, 1)
  assert.match(f.messages[0].message, /rose \$100.00/)
  assert.equal(f.bot.checkAlerts().queued, 0)
  f.advance(60)
  f.observe(100300)
  assert.equal(f.bot.checkAlerts().queued, 0)
  f.advance(60)
  f.observe(100310)
  assert.equal(f.bot.checkAlerts().queued, 0)
  f.advance(60)
  f.observe(100100)
  assert.equal(f.bot.checkAlerts().queued, 1)
  assert.match(f.messages[1].message, /fell \$210.00/)
})

test('does not compare across missing history or use a stale price', () => {
  const f = fixture()
  f.alert({windowMinutes: 10})
  f.observe(100000)
  f.advance(20 * 60)
  f.observe(110000)
  assert.equal(f.bot.checkAlerts().queued, 0)
  f.advance(10 * 60)
  f.observe(120000)
  f.advance(121)
  assert.equal(f.bot.checkAlerts().queued, 0)
  assert.equal(f.bot.getState().stale, true)
})

test('notification failure does not mark an alert as sent', () => {
  const f = fixture()
  f.alert()
  f.observe(100000)
  f.advance(60)
  f.observe(101000)
  f.failNotifications(true)
  assert.throws(() => f.bot.checkAlerts(), /Queue unavailable/)
  f.failNotifications(false)
  assert.equal(f.bot.checkAlerts().queued, 1)
})

test('processing three days of history keeps clock host calls constant', () => {
  const f = fixture()
  f.alert()
  const start = f.now() - 3 * DAY
  for (let i = 0; i <= 3 * 1440; i++) f.observe(100000 + i, start + i * 60)
  const before = f.clockReads()
  assert.equal(f.bot.checkAlerts().queued, 0)
  assert.equal(f.clockReads() - before, 2)
})

test('supports 24-hour windows and rejects invalid input', () => {
  const f = fixture()
  f.alert({windowMinutes: 1440})
  f.observe(100000)
  f.advance(DAY)
  f.observe(101000)
  assert.equal(f.bot.checkAlerts().queued, 1)
  for (const windowMinutes of [0, 1.5, 1441, 10080]) {
    assert.throws(
      () => f.bot.saveAlert({name: 'Invalid', amountUsd: 100, windowMinutes}),
      /window must/
    )
  }
  assert.throws(
    () =>
      f.bot.saveAlert({
        alertId: 'another-users-alert',
        name: 'Invalid',
        amountUsd: 100,
        windowMinutes: 10
      }),
    /not found/
  )
  assert.throws(
    () => f.bot.savePreferences({channel: 'http://example.org'}),
    /Choose/
  )
})

test('paused and deleted alerts do not notify, and edits re-evaluate a changed rule', () => {
  const f = fixture()
  const alert = f.alert({enabled: false})
  f.observe(100000)
  f.advance(60)
  f.observe(101000)
  assert.equal(f.bot.checkAlerts().queued, 0)
  f.bot.saveAlert({
    alertId: alert.id,
    name: 'Enabled',
    amountUsd: 100,
    windowMinutes: 1
  })
  assert.equal(f.bot.checkAlerts().queued, 1)
  f.bot.deleteAlert({alertId: alert.id})
  assert.equal(f.bot.checkAlerts().queued, 0)
  assert.equal(f.storage.get('state', `alert:${alert.id}`), null)
})

test('daily summary requires opt-in and history, and queues once per UTC day', () => {
  const f = fixture()
  f.bot.savePreferences({channel: 'telegram', dailySummary: true})
  f.observe(100000)
  assert.equal(f.bot.dailySummary({scheduleId: 'daily'}).queued, 0)
  f.advance(DAY)
  f.observe(110000)
  assert.equal(f.bot.dailySummary({scheduleId: 'daily'}).queued, 1)
  assert.match(
    f.messages[0].message,
    /24-hour change: \+\$10000.00 \(\+10.00%\)/
  )
  assert.equal(f.bot.dailySummary({scheduleId: 'daily'}).queued, 0)
  f.advance(DAY)
  f.observe(120000)
  assert.equal(f.bot.dailySummary({scheduleId: 'daily'}).queued, 1)
  f.bot.savePreferences({channel: 'telegram', dailySummary: false})
  f.advance(DAY)
  f.observe(130000)
  assert.equal(f.bot.dailySummary({scheduleId: 'daily'}).queued, 0)
})

test('pruning removes expired records and partial buckets without losing the boundary sample', () => {
  const f = fixture(),
    end = f.now(),
    cutoff = end - 2 * DAY
  for (let i = 0; i < 205; i++) f.observe(100000, cutoff - (206 - i) * 3600)
  f.observe(100001, cutoff - 60)
  f.observe(100002, cutoff)
  f.observe(100003, end)
  f.bot.pruneHistory()
  const samples = f.shared
    .list('prices', {limit: 1000})
    .data.flatMap(row => JSON.parse(row.samples_json))
  assert.deepEqual(
    samples.sort((a, b) => a[0] - b[0]),
    [
      [cutoff, 100002],
      [end, 100003]
    ]
  )
})
