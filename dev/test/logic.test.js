import assert from 'node:assert/strict'
import {test} from 'node:test'
import {fixture} from './helpers.js'
import {DAY, HOUR} from '../src/history.js'

test('users immediately see the same collected history while alerts remain private', () => {
  const tables = new Map(),
    alice = fixture({tables}),
    bob = fixture({tables, owner: 'bob'})
  alice.observe(100000)
  assert.equal(bob.bot.getState().price, 100000)
  assert.deepEqual(bob.bot.getHistory(), alice.bot.getHistory())
  const alert = alice.alert()
  assert.equal(bob.bot.getState().alerts.length, 0)
  assert.throws(() => bob.bot.deleteAlert({alertId: alert.id}), /not found/)
  assert.equal(alice.storage.list('history').total, 0)
  assert.equal(bob.jobs.size, 0)
})

test('saving alerts needs no preferences and never creates a user collector', () => {
  const f = fixture()
  f.alert()
  f.alert({name: 'Another'})
  assert.deepEqual([...f.jobs.keys()], ['check-alerts'])
  assert.equal(f.saves(), 1)
  f.bot.savePreferences({channels: ['nostr'], dailySummary: true})
  assert.equal(f.jobs.size, 2)
  assert.equal(f.jobs.get('daily-summary').enabled, true)
  f.bot.savePreferences({channels: ['email'], dailySummary: false})
  assert.equal(f.jobs.get('daily-summary').enabled, false)
})

test('price returning to its starting value still triggers a within-window fluctuation', () => {
  const f = fixture()
  f.alert({channels: ['email', 'telegram', 'nostr']})
  f.observe(100000)
  f.observe(100700, f.now() + 60)
  f.observe(100000, f.now() + 60)
  assert.equal(f.bot.checkAlerts().queued, 3)
  assert.match(
    f.messages[0].message,
    /fluctuated by \$700.00 within the last 1 hour/
  )
  assert.equal(f.bot.checkAlerts().queued, 0)
  f.observe(100100, f.now() + HOUR)
  assert.equal(f.bot.checkAlerts().queued, 0)
  f.observe(99500, f.now() + 60)
  assert.equal(f.bot.checkAlerts().queued, 3)
})

test('the ten-minute boundary is inclusive and expired peaks do not trigger', () => {
  const f = fixture()
  f.alert({windowCount: 10, windowUnit: 'minute'})
  f.observe(100000)
  f.observe(100500, f.now() + 600)
  assert.equal(f.bot.checkAlerts().queued, 1)
  f.observe(100500, f.now() + 60)
  assert.equal(f.bot.checkAlerts().queued, 0)
  f.observe(101000, f.now() + 60)
  assert.equal(f.bot.checkAlerts().queued, 1)
})

test('failed channels retry without resending successful channels', () => {
  const f = fixture()
  f.alert({channels: ['email', 'telegram', 'nostr']})
  f.observe(100000)
  f.observe(100500, f.now() + 60)
  f.failChannels(['telegram'])
  assert.throws(() => f.bot.checkAlerts(), /Unsent channels/)
  assert.deepEqual(
    f.messages.map(row => row.channel),
    ['email', 'nostr']
  )
  assert.throws(() => f.bot.checkAlerts(), /Unsent channels/)
  assert.equal(f.messages.length, 2)
  f.failChannels([])
  assert.equal(f.bot.checkAlerts().queued, 1)
  assert.deepEqual(
    f.messages.map(row => row.channel),
    ['email', 'nostr', 'telegram']
  )
  assert.equal(f.bot.checkAlerts().queued, 0)
})

test('stale prices and disjoint observations outside the window do not notify', () => {
  const f = fixture()
  f.alert({windowCount: 10, windowUnit: 'minute'})
  f.observe(100000)
  f.observe(105000, f.now() + 1200)
  assert.equal(f.bot.checkAlerts().queued, 0)
  f.observe(110000, f.now() + 60)
  f.advance(121)
  assert.equal(f.bot.checkAlerts().queued, 0)
  assert.equal(f.bot.getState().stale, true)
})

test('supports all interval units and rejects malformed alerts', () => {
  const f = fixture()
  for (const unit of ['minute', 'hour', 'day', 'week', 'month'])
    assert.equal(
      f.alert({windowCount: unit === 'minute' ? 10 : 1, windowUnit: unit})
        .window_unit,
      unit
    )
  for (const options of [
    {windowCount: 9, windowUnit: 'minute'},
    {windowCount: 0},
    {windowCount: 1.5},
    {windowCount: Number.MAX_SAFE_INTEGER},
    {windowUnit: 'year'},
    {windowUnit: '__proto__'},
    {channels: []},
    {channels: ['sms']},
    {channels: 'email'},
    {amountUsd: NaN},
    {enabled: 'false'},
    {name: ''}
  ])
    assert.throws(() => f.alert(options))
  assert.deepEqual(f.alert({channels: ['nostr', 'email', 'email']}).channels, [
    'email',
    'nostr'
  ])
})

test('disabled/deleted alerts do not notify; enabling or changing the rule rearms', () => {
  const f = fixture(),
    alert = f.alert({enabled: false})
  f.observe(100000)
  f.observe(100700, f.now() + 60)
  assert.equal(f.bot.checkAlerts().queued, 0)
  f.alert({alertId: alert.id, enabled: true})
  assert.equal(f.bot.checkAlerts().queued, 1)
  f.alert({alertId: alert.id, name: 'Renamed'})
  assert.equal(f.bot.checkAlerts().queued, 0)
  f.alert({alertId: alert.id, amountUsd: 600})
  assert.equal(f.bot.checkAlerts().queued, 1)
  f.bot.deleteAlert({alertId: alert.id})
  assert.equal(f.bot.checkAlerts().queued, 0)
  assert.equal(f.storage.get('state', `alert:${alert.id}`), null)
})

test('fifty alerts can notify within the storage-call budget', () => {
  const f = fixture()
  for (let i = 0; i < 50; i++) f.alert({name: `Alert ${i}`})
  assert.throws(() => f.alert(), /up to 50/)
  f.observe(100000)
  f.observe(100700, f.now() + 60)
  f.storage.calls.length = 0
  f.publicStorage.calls.length = 0
  assert.equal(f.bot.checkAlerts().queued, 15)
  assert.ok(f.storage.calls.length + f.publicStorage.calls.length < 100)
  for (const count of [15, 15, 5]) {
    f.observe(100700, f.now() + 60)
    assert.equal(f.bot.checkAlerts().queued, count)
  }
  assert.equal(f.bot.checkAlerts().queued, 0)
})

test('daily summary uses common history and sends once per channel per UTC day', () => {
  const f = fixture()
  f.bot.savePreferences({channels: ['email', 'telegram'], dailySummary: true})
  f.observe(100000)
  assert.equal(f.bot.dailySummary().queued, 0)
  f.observe(110000, f.now() + DAY)
  f.failChannels(['telegram'])
  assert.throws(() => f.bot.dailySummary(), /could not be queued/)
  assert.match(
    f.messages[0].message,
    /24-hour change: \+\$10000.00 \(\+10.00%\)/
  )
  f.failChannels([])
  assert.equal(f.bot.dailySummary().queued, 1)
  assert.equal(f.bot.dailySummary().queued, 0)
  f.bot.savePreferences({channels: ['email'], dailySummary: false})
  f.observe(120000, f.now() + DAY)
  assert.equal(f.bot.dailySummary().queued, 0)
})

test('a notification burst drains without duplicates even after the original window clears', () => {
  const f = fixture()
  for (let i = 0; i < 15; i++)
    f.alert({
      name: `Alert ${i}`,
      windowCount: 10,
      windowUnit: 'minute',
      channels: ['email', 'telegram', 'nostr']
    })
  f.observe(100000)
  f.observe(101000, f.now() + 60)
  assert.equal(f.bot.checkAlerts().queued, 15)
  f.observe(101000, f.now() + 11 * 60)
  assert.equal(f.bot.checkAlerts().queued, 15)
  assert.equal(f.bot.checkAlerts().queued, 15)
  assert.equal(f.bot.checkAlerts().queued, 0)
  assert.equal(
    new Set(f.messages.map(row => row.channel + row.message)).size,
    45
  )
})
