const MINUTE = 60
const HOUR = 3600
const DAY = 86400
const HISTORY_SECONDS = 2 * DAY
const MAX_ALERTS = 50
const JOBS = {
  'collect-prices': {scope: 'user', cronExpression: '* * * * *'},
  'prune-history': {scope: 'user', cronExpression: '5 0 * * *'},
  'check-alerts': {scope: 'user', cronExpression: '* * * * *'},
  'daily-summary': {scope: 'user', cronExpression: '0 9 * * *'}
}

export function createPricebot({
  storage,
  scheduler,
  currencies,
  notifications,
  system
}) {
  function ensureJob(handler, enabled = true) {
    const config = JOBS[handler]
    const existing = scheduler
      .list(config.scope)
      .find(job => job.handler === handler)
    if (existing && existing.enabled === enabled) return existing
    return scheduler.set({
      ...config,
      handler,
      timezone: 'UTC',
      enabled,
      id: existing?.id,
      payloadJson: '{}'
    })
  }

  function preferences() {
    return storage.list('preferences', {limit: 1}).data[0] || null
  }

  function alerts() {
    return storage.list('alerts', {limit: MAX_ALERTS, sortBy: 'name'}).data
  }

  function samples() {
    const observedBefore = system.now()
    return storage
      .list('prices', {limit: 1000, sortBy: 'hour', descending: true})
      .data.flatMap(row => JSON.parse(row.samples_json))
      .filter(
        ([timestamp, price]) =>
          Number.isFinite(price) && price > 0 && timestamp <= observedBefore
      )
      .sort((a, b) => a[0] - b[0])
  }

  function latestPrice(history) {
    const latest = history.at(-1)
    return latest && system.now() - latest[0] <= 2 * MINUTE ? latest : null
  }

  function baseline(history, timestamp) {
    const prior = history.findLast(sample => sample[0] <= timestamp)
    return prior && timestamp - prior[0] <= 2 * MINUTE ? prior : null
  }

  function readState(id) {
    const row = storage.get('state', id)
    return row ? JSON.parse(row.value_json) : {}
  }

  function writeState(id, value) {
    storage.set('state', {id, value_json: JSON.stringify(value)})
  }

  function money(value) {
    return `$${value.toFixed(2)}`
  }

  function notify(channel, message) {
    const response = notifications.send(channel, message)
    if (!response.queued) throw new Error('Notification could not be queued.')
  }

  function validateAlert(request) {
    const name = String(request.name || '').trim()
    const amount = Number(request.amountUsd)
    const minutes = Number(request.windowMinutes)
    if (!name || name.length > 80)
      throw new Error('Enter an alert name of 1–80 characters.')
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1e9) {
      throw new Error(
        'Price change must be a positive USD amount, up to one billion.'
      )
    }
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
      throw new Error('The window must be between 1 and 1,440 whole minutes.')
    }
    return {
      name,
      amount_usd: amount,
      window_minutes: minutes,
      enabled: request.enabled !== false
    }
  }

  return {
    getState() {
      const history = samples()
      const latest = history.at(-1) || null
      const prior = latest ? baseline(history, latest[0] - DAY) : null
      return {
        price: latest?.[1] ?? null,
        observedAt: latest?.[0] ?? null,
        stale: !latestPrice(history),
        change24h: prior ? latest[1] - prior[1] : null,
        historyFrom: history[0]?.[0] ?? null,
        alerts: alerts(),
        preferences: preferences(),
        jobs: scheduler.list('user')
      }
    },

    setupJobs() {
      return {
        jobs: [ensureJob('collect-prices'), ensureJob('prune-history')]
      }
    },

    savePreferences(request) {
      if (!['email', 'nostr', 'telegram'].includes(request.channel)) {
        throw new Error('Choose email, Nostr, or Telegram.')
      }
      ensureJob('collect-prices')
      ensureJob('prune-history')
      const check = ensureJob('check-alerts')
      const daily = request.dailySummary === true
      ensureJob('daily-summary', daily)
      const value = {
        id: check.id,
        channel: request.channel,
        daily_summary: daily
      }
      storage.set('preferences', value)
      return {preferences: value}
    },

    saveAlert(request) {
      const fields = validateAlert(request)
      if (!preferences())
        throw new Error('Save your notification settings first.')
      const existing = request.alertId
        ? storage.get('alerts', request.alertId)
        : null
      if (request.alertId && !existing) throw new Error('Alert not found.')
      if (!existing && storage.list('alerts', {limit: 1}).total >= MAX_ALERTS) {
        throw new Error(`You can configure up to ${MAX_ALERTS} alerts.`)
      }
      ensureJob('check-alerts')
      const alert = {id: existing?.id || system.id('alert'), ...fields}
      storage.set('alerts', alert)
      return {alert}
    },

    deleteAlert(request) {
      if (!request.alertId || !storage.get('alerts', request.alertId)) {
        throw new Error('Alert not found.')
      }
      storage.delete('alerts', request.alertId)
      storage.delete('state', `alert:${request.alertId}`)
      return {deleted: true}
    },

    collectPrices() {
      const price = Number(currencies.rate('USD').price)
      if (!Number.isFinite(price) || price <= 0)
        throw new Error('Core returned an invalid BTC price.')
      const timestamp = Math.floor(system.now() / MINUTE) * MINUTE
      const hour = Math.floor(timestamp / HOUR) * HOUR
      const existing = storage.list('prices', {filters: {hour}, limit: 1}).data[0]
      // IDs are table-wide even though reads and writes are owner-scoped.
      const id = existing?.id || system.id('price')
      const entries = existing ? JSON.parse(existing.samples_json) : []
      // Recovered/repeated invocations keep the original observation for a minute.
      if (entries.some(sample => sample[0] === timestamp))
        return {collected: false}
      entries.push([timestamp, price])
      entries.sort((a, b) => a[0] - b[0])
      storage.set('prices', {id, hour, samples_json: JSON.stringify(entries)})
      return {collected: true, price, timestamp}
    },

    pruneHistory() {
      const cutoff = system.now() - HISTORY_SECONDS
      let deleted = 0
      // Read oldest-first and repeat page zero after deletion, avoiding skipped rows.
      while (true) {
        const page = storage.list('prices', {limit: 100, sortBy: 'hour'}).data
        let removed = 0
        for (const row of page) {
          if (row.hour >= cutoff) break
          const entries = JSON.parse(row.samples_json).filter(
            sample => sample[0] >= cutoff
          )
          if (!entries.length) {
            storage.delete('prices', row.id)
            removed++
            deleted++
          } else {
            storage.set('prices', {
              ...row,
              samples_json: JSON.stringify(entries)
            })
          }
        }
        if (removed < page.length || page.length < 100) break
      }
      return {deleted}
    },

    checkAlerts() {
      const prefs = preferences()
      if (!prefs) return {queued: 0}
      const history = samples()
      const latest = latestPrice(history)
      if (!latest) return {queued: 0, waitingForHistory: true}
      let queued = 0
      for (const alert of alerts()) {
        if (!alert.enabled) continue
        const prior = baseline(
          history,
          latest[0] - alert.window_minutes * MINUTE
        )
        if (!prior) continue
        const change = latest[1] - prior[1]
        const crossed = Math.abs(change) >= alert.amount_usd
        const id = `alert:${alert.id}`
        const state = readState(id)
        const rule = `${alert.amount_usd}:${alert.window_minutes}`
        if (state.rule === rule && state.timestamp >= latest[0]) continue
        if (crossed && !(state.rule === rule && state.triggered)) {
          notify(
            prefs.channel,
            `Pricebot · ${alert.name}: BTC ${change >= 0 ? 'rose' : 'fell'} ${money(Math.abs(change))} ` +
              `over ${alert.window_minutes} minutes. Current price: ${money(latest[1])} USD.`
          )
          queued++
        }
        writeState(id, {rule, timestamp: latest[0], triggered: crossed})
      }
      return {queued}
    },

    dailySummary(request) {
      const prefs = preferences()
      if (!prefs?.daily_summary) return {queued: 0}
      const history = samples()
      const latest = latestPrice(history)
      const prior = latest ? baseline(history, latest[0] - DAY) : null
      if (!latest || !prior) return {queued: 0, waitingForHistory: true}
      const day = new Date(system.now() * 1000).toISOString().slice(0, 10)
      const id = `summary:${request.scheduleId}`
      if (readState(id).day === day) return {queued: 0}
      const change = latest[1] - prior[1]
      const percent = (change / prior[1]) * 100
      notify(
        prefs.channel,
        `Pricebot daily summary: BTC ${money(latest[1])} USD. ` +
          `24-hour change: ${change >= 0 ? '+' : '-'}${money(Math.abs(change))} ` +
          `(${percent >= 0 ? '+' : ''}${percent.toFixed(2)}%).`
      )
      writeState(id, {day})
      return {queued: 1}
    }
  }
}
