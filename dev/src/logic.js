import {createHistory, windowRanges, MINUTE, DAY, UNITS} from './history.js'

const MAX_ALERTS = 50
const MAX_NOTIFICATION_ATTEMPTS = 15
const CHANNELS = ['email', 'telegram', 'nostr']
const JOBS = {'check-alerts': '* * * * *', 'daily-summary': '0 9 * * *'}

export function createPricebot({
  storage,
  publicStorage,
  scheduler,
  currencies,
  notifications,
  system
}) {
  const history = createHistory({storage, publicStorage})

  function ensureJob(handler, enabled = true) {
    const existing = scheduler.list('user').find(job => job.handler === handler)
    if (existing && existing.enabled === enabled) return existing
    return scheduler.set({
      scope: 'user',
      handler,
      cronExpression: JOBS[handler],
      timezone: 'UTC',
      enabled,
      id: existing?.id,
      payloadJson: '{}'
    })
  }

  const preferences = () =>
    storage.list('preferences', {limit: 1}).data[0] || null
  const alerts = () =>
    storage.list('alerts', {limit: MAX_ALERTS, sortBy: 'name'}).data
  const channelsOf = row => JSON.parse(row.channels_json)
  const present = row => {
    if (!row) return null
    const {channels_json, ...fields} = row
    return {...fields, channels: JSON.parse(channels_json)}
  }
  const money = value => `$${value.toFixed(2)}`
  const fresh = (latest, now) =>
    latest && latest[0] <= now && now - latest[0] <= 2 * MINUTE
  function readState(id) {
    const row = storage.get('state', id)
    return row ? JSON.parse(row.value_json) : {}
  }
  function writeState(id, value) {
    storage.set('state', {id, value_json: JSON.stringify(value)})
  }
  function validateChannels(value) {
    if (
      !Array.isArray(value) ||
      !value.length ||
      value.some(channel => !CHANNELS.includes(channel))
    )
      throw new Error('Choose at least one channel: email, Telegram, or Nostr.')
    return CHANNELS.filter(channel => value.includes(channel))
  }
  function validateAlert(request) {
    const name = String(request.name || '').trim()
    const amount = Number(request.amountUsd),
      count = Number(request.windowCount)
    const unit = request.windowUnit
    if (!name || name.length > 80)
      throw new Error('Enter an alert name of 1–80 characters.')
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1e9)
      throw new Error(
        'Price variation must be a positive USD amount, up to one billion.'
      )
    if (
      !Object.hasOwn(UNITS, unit) ||
      !Number.isSafeInteger(count) ||
      count < (unit === 'minute' ? 10 : 1) ||
      !Number.isSafeInteger(count * UNITS[unit])
    )
      throw new Error(
        'Use a whole interval: at least 10 minutes, or 1 hour, day, week, or month.'
      )
    if (request.enabled !== undefined && typeof request.enabled !== 'boolean')
      throw new Error('Enabled must be true or false.')
    return {
      name,
      amount_usd: amount,
      window_count: count,
      window_unit: unit,
      enabled: request.enabled !== false,
      channels_json: JSON.stringify(validateChannels(request.channels))
    }
  }
  function sendMissing(channels, state, message, limit = Infinity) {
    let queued = 0,
      failed = false,
      attempts = 0
    for (const channel of channels) {
      if (state.sent.includes(channel)) continue
      if (attempts >= limit) break
      attempts++
      try {
        if (!notifications.send(channel, message).queued)
          throw new Error('Queue unavailable')
        state.sent.push(channel)
        queued++
      } catch {
        failed = true
      }
    }
    return {queued, failed, attempts}
  }

  return {
    getState() {
      const now = system.now(),
        {latest, prior} = history.status(now)
      return {
        price: latest?.[1] ?? null,
        observedAt: latest?.[0] ?? null,
        stale: !fresh(latest, now),
        change24h: prior ? latest[1] - prior[1] : null,
        alerts: alerts().map(present),
        preferences: present(preferences())
      }
    },
    getHistory(request = {}) {
      return history.chart(
        request.range || '1D',
        system.now(),
        Number(request.offset || 0)
      )
    },
    savePreferences(request) {
      const channels = validateChannels(request.channels),
        daily = request.dailySummary === true
      const existing = preferences()
      const job = ensureJob('daily-summary', daily)
      const value = {
        id: existing?.id || job.id,
        channels_json: JSON.stringify(channels),
        daily_summary: daily
      }
      storage.set('preferences', value)
      return {preferences: present(value)}
    },
    saveAlert(request) {
      const fields = validateAlert(request)
      const existing = request.alertId
        ? storage.get('alerts', request.alertId)
        : null
      if (request.alertId && !existing) throw new Error('Alert not found.')
      if (!existing && storage.list('alerts', {limit: 1}).total >= MAX_ALERTS)
        throw new Error(`You can configure up to ${MAX_ALERTS} alerts.`)
      ensureJob('check-alerts')
      const alert = {id: existing?.id || system.id('alert'), ...fields}
      storage.set('alerts', alert)
      if (
        existing &&
        [
          'enabled',
          'amount_usd',
          'window_count',
          'window_unit',
          'channels_json'
        ].some(key => existing[key] !== alert[key])
      )
        storage.delete('state', `alert:${alert.id}`)
      return {alert: present(alert)}
    },
    deleteAlert(request) {
      if (!request.alertId || !storage.get('alerts', request.alertId))
        throw new Error('Alert not found.')
      storage.delete('alerts', request.alertId)
      storage.delete('state', `alert:${request.alertId}`)
      return {deleted: true}
    },
    collectPrices() {
      const price = Math.round(Number(currencies.rate('USD').price) * 100) / 100
      if (!Number.isFinite(price) || price <= 0)
        throw new Error('Core returned an invalid BTC price.')
      return history.collect(price, Math.floor(system.now() / MINUTE) * MINUTE)
    },
    checkAlerts() {
      const active = alerts().filter(alert => alert.enabled)
      if (!active.length) return {queued: 0}
      const now = system.now()
      const data = history.load(
        now,
        active.map(alert => alert.window_count * UNITS[alert.window_unit])
      )
      const latest = data.latest
      if (!fresh(latest, now)) return {queued: 0, waitingForHistory: true}
      // One read for all receipts keeps 50 alerts within the host storage-call budget.
      const states = new Map(
        storage
          .list('state', {limit: MAX_ALERTS + 1})
          .data.map(row => [row.id, JSON.parse(row.value_json)])
      )
      const ranges = windowRanges(
        data,
        now,
        active.map(alert => alert.window_count * UNITS[alert.window_unit])
      )
      let queued = 0,
        failed = false,
        remaining = MAX_NOTIFICATION_ATTEMPTS,
        pending = 0
      active.sort(
        (a, b) =>
          (states.get(`alert:${a.id}`)?.attemptedAt || 0) -
          (states.get(`alert:${b.id}`)?.attemptedAt || 0)
      )
      for (const alert of active) {
        const seconds = alert.window_count * UNITS[alert.window_unit]
        const range = ranges.get(seconds)
        if (!range) continue
        const id = `alert:${alert.id}`
        const rule = `${alert.amount_usd}:${alert.window_count}:${alert.window_unit}:${alert.channels_json}`
        const previous = states.get(id),
          channels = channelsOf(alert)
        const wasTriggered = previous?.rule === rule && previous.triggered
        const state =
          previous?.rule === rule
            ? previous
            : {rule, triggered: false, sent: []}
        const waiting = state.triggered && state.sent.length < channels.length
        if (!waiting && range.upperVariation < alert.amount_usd) {
          if (state.triggered || state.sent.length)
            writeState(id, {rule, triggered: false, sent: []})
          continue
        }
        if (range.variation < alert.amount_usd && !state.triggered) continue
        if (!state.triggered) {
          state.triggered = true
          state.event = [now, range.low, range.high, latest[1]]
        }
        let message = ''
        if (remaining && state.sent.length < channels.length) {
          const [time, low, high, price] = state.event
          const interval = `${alert.window_count} ${alert.window_unit}${alert.window_count === 1 ? '' : 's'}`
          message =
            `Pricebot · ${alert.name}: BTC fluctuated by ${money(high - low)} within the last ${interval}. ` +
            `Low: ${money(low)}; high: ${money(high)}. Current price: ${money(price)} USD. ` +
            `Observed at ${new Date(time * 1000).toISOString()}.`
        }
        const result = sendMissing(channels, state, message, remaining)
        remaining -= result.attempts
        if (result.attempts) state.attemptedAt = now
        pending += channels.length - state.sent.length
        queued += result.queued
        failed ||= result.failed
        // Keep successful channel receipts even if another channel failed.
        if (
          waiting &&
          state.sent.length === channels.length &&
          range.upperVariation < alert.amount_usd
        ) {
          state.triggered = false
          state.sent = []
        }
        if (result.attempts || !wasTriggered) writeState(id, state)
      }
      if (failed)
        throw new Error(
          'Some notifications could not be queued. Unsent channels will be retried on the next check.'
        )
      return {queued, pending}
    },
    dailySummary() {
      const prefs = preferences()
      if (!prefs?.daily_summary) return {queued: 0}
      const now = system.now(),
        {latest, prior} = history.status(now)
      if (!fresh(latest, now) || !prior)
        return {queued: 0, waitingForHistory: true}
      const day = new Date(now * 1000).toISOString().slice(0, 10),
        id = `summary:${prefs.id}`
      const previous = readState(id),
        state = previous.day === day ? previous : {day, sent: []}
      const change = latest[1] - prior[1],
        percent = (change / prior[1]) * 100
      const result = sendMissing(
        channelsOf(prefs),
        state,
        `Pricebot daily summary: BTC ${money(latest[1])} USD. ` +
          `24-hour change: ${change >= 0 ? '+' : '-'}${money(Math.abs(change))} (${percent >= 0 ? '+' : ''}${percent.toFixed(2)}%).`
      )
      if (result.queued) writeState(id, state)
      if (result.failed)
        throw new Error('Some daily summary notifications could not be queued.')
      return {queued: result.queued}
    }
  }
}
