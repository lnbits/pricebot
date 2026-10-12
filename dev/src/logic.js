import {createHistory, windowRanges, MINUTE, DAY, UNITS} from './history.js'

const MAX_ALERTS = 50
const MAX_NOTIFICATION_ATTEMPTS = 15
const CHANNELS = ['email', 'telegram', 'nostr']
const JOBS = {'check-alerts': '*/10 * * * *', 'daily-summary': '0 9 * * *'}

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
    if (
      existing &&
      existing.enabled === enabled &&
      existing.cron_expression === JOBS[handler] &&
      existing.timezone === 'UTC'
    )
      return existing
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
  const fluctuation = (price, low, high) =>
    Math.round(Math.max(Math.abs(price - low), Math.abs(price - high)) * 100) /
    100
  const fresh = (latest, now) =>
    latest && latest[0] <= now && now - latest[0] <= 2 * MINUTE
  function logCheck(details) {
    system.log(`check-alerts ${JSON.stringify(details)}`)
  }
  function logAlert(alert, details) {
    logCheck({
      alertId: alert.id,
      windowCount: alert.window_count,
      windowUnit: alert.window_unit,
      thresholdUsd: alert.amount_usd,
      ...details
    })
  }
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
      logCheck({phase: 'invoked'})
      const configured = alerts(),
        active = configured.filter(alert => alert.enabled)
      for (const alert of configured.filter(alert => !alert.enabled))
        logAlert(alert, {
          checkDue: false,
          checkReason: 'alert_disabled',
          notify: false,
          notifyReason: 'alert_disabled'
        })
      if (!active.length) {
        logCheck({
          phase: 'completed',
          checkDue: false,
          checkReason: 'no_enabled_alerts',
          notify: false,
          queued: 0
        })
        return {queued: 0}
      }
      const now = system.now()
      const data = history.load(
        now,
        active.map(alert => alert.window_count * UNITS[alert.window_unit])
      )
      const latest = data.latest
      if (!fresh(latest, now)) {
        const reason = !latest
          ? 'missing_price_history'
          : latest[0] > now
            ? 'latest_price_is_in_the_future'
            : 'latest_price_older_than_two_minutes'
        for (const alert of active)
          logAlert(alert, {
            checkDue: false,
            checkReason: reason,
            observedAt: latest?.[0] ?? null,
            priceAgeSeconds: latest ? now - latest[0] : null,
            notify: false,
            notifyReason: reason
          })
        logCheck({phase: 'completed', queued: 0, waitingForHistory: true})
        return {queued: 0, waitingForHistory: true}
      }
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
        const id = `alert:${alert.id}`
        const rule = `${alert.amount_usd}:${alert.window_count}:${alert.window_unit}:${alert.channels_json}`
        const previous = states.get(id),
          channels = channelsOf(alert)
        const state =
          previous?.rule === rule
            ? previous
            : {rule, triggered: false, sent: []}
        const waiting = state.triggered && state.sent.length < channels.length
        // Older receipts have no queue timestamp; retain their last known attempt.
        const lastNotifiedAt =
          state.lastNotifiedAt ??
          (state.sent.length
            ? (state.attemptedAt ?? state.event?.[0])
            : null) ??
          null
        const nextEligibleAt =
          lastNotifiedAt === null ? null : lastNotifiedAt + seconds
        const due = nextEligibleAt === null || now >= nextEligibleAt
        const range = ranges.get(seconds)
        const difference = range
          ? fluctuation(latest[1], range.low, range.high)
          : null
        const logDecision = (notify, notifyReason, details = {}) =>
          logAlert(alert, {
            checkDue: waiting || due,
            checkReason: waiting
              ? 'pending_channel_retry'
              : !due
                ? 'notification_interval_not_elapsed'
                : lastNotifiedAt === null
                  ? 'never_notified'
                  : 'notification_interval_elapsed',
            lastNotifiedAt,
            nextEligibleAt,
            cooldownRemainingSeconds: Math.max(
              0,
              (nextEligibleAt ?? now) - now
            ),
            windowStart: now - seconds,
            windowEnd: now,
            currentPriceUsd: latest[1],
            observedAt: latest[0],
            lowUsd: range?.low ?? null,
            highUsd: range?.high ?? null,
            differenceUsd: difference,
            notify,
            notifyReason,
            ...details
          })
        if (!waiting && !due) {
          logDecision(false, 'notification_interval_not_elapsed')
          continue
        }
        if (!waiting && !range) {
          logDecision(false, 'no_prices_in_window')
          continue
        }
        if (!waiting && difference < alert.amount_usd) {
          logDecision(false, 'below_threshold')
          continue
        }
        if (!waiting) {
          state.triggered = true
          state.sent = []
          state.event = [now, range.low, range.high, latest[1]]
        }
        const unsent = channels.filter(channel => !state.sent.includes(channel))
        logDecision(
          remaining > 0,
          !remaining
            ? 'notification_attempt_limit_reached'
            : waiting
              ? 'retry_pending_channels'
              : 'threshold_reached',
          {
            remainingAttempts: remaining,
            sentChannels: state.sent,
            pendingChannels: unsent,
            eventAt: state.event[0],
            eventLowUsd: state.event[1],
            eventHighUsd: state.event[2],
            eventPriceUsd: state.event[3],
            eventDifferenceUsd: fluctuation(
              state.event[3],
              state.event[1],
              state.event[2]
            )
          }
        )
        let message = ''
        if (remaining) {
          const [time, low, high, price] = state.event
          const interval = `${alert.window_count} ${alert.window_unit}${alert.window_count === 1 ? '' : 's'}`
          message =
            `Pricebot · ${alert.name}: BTC fluctuated by ${money(fluctuation(price, low, high))} within the last ${interval}. ` +
            `Low: ${money(low)}; high: ${money(high)}. Current price: ${money(price)} USD. ` +
            `Observed at ${new Date(time * 1000).toISOString()}.`
        }
        const result = sendMissing(channels, state, message, remaining)
        state.lastNotifiedAt = result.queued ? now : lastNotifiedAt
        if (result.attempts)
          logAlert(alert, {
            phase: 'notification_result',
            ...result,
            lastNotifiedAt: state.lastNotifiedAt,
            sentChannels: state.sent,
            pendingChannels: channels.filter(
              channel => !state.sent.includes(channel)
            )
          })
        remaining -= result.attempts
        if (result.attempts) state.attemptedAt = now
        pending += channels.length - state.sent.length
        queued += result.queued
        failed ||= result.failed
        // Keep the event and successful receipts while unsent channels retry.
        state.triggered = state.sent.length < channels.length
        if (result.attempts || !waiting) writeState(id, state)
      }
      logCheck({phase: 'completed', queued, pending, failed})
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
