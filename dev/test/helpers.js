import {randomUUID} from 'node:crypto'
import {createPricebot} from '../src/logic.js'

const clone = value => (value == null ? value : structuredClone(value))
export function memoryStore(tables = new Map(), owner = 'extension:pricebot') {
  const calls = []
  const table = name => {
    if (!tables.has(name)) tables.set(name, new Map())
    return tables.get(name)
  }
  const allowed = entry =>
    owner === null ? entry?.row.series === 'btc-usd' : entry?.owner === owner
  return {
    calls,
    get(name, id) {
      calls.push(['get', name])
      const entry = table(name).get(id)
      return allowed(entry) ? clone(entry.row) : null
    },
    set(name, row) {
      calls.push(['set', name])
      const existing = table(name).get(row.id)
      if (owner === null || (existing && existing.owner !== owner))
        throw new Error('Wrong owner')
      table(name).set(row.id, {owner, row: clone(row)})
    },
    delete(name, id) {
      calls.push(['delete', name])
      if (allowed(table(name).get(id))) table(name).delete(id)
    },
    list(name, options = {}) {
      calls.push(['list', name])
      const rows = [...table(name).values()]
        .filter(allowed)
        .map(entry => entry.row)
        .filter(row =>
          Object.entries(options.filters || {}).every(
            ([key, value]) => row[key] === value
          )
        )
        .sort(
          (a, b) =>
            (a[options.sortBy] < b[options.sortBy]
              ? -1
              : a[options.sortBy] > b[options.sortBy]
                ? 1
                : 0) * (options.descending ? -1 : 1)
        )
      const start = options.offset || 0
      return {
        data: clone(rows.slice(start, start + (options.limit || 100))),
        total: rows.length
      }
    }
  }
}
export function fixture({tables = new Map(), owner = 'alice'} = {}) {
  let now = 1800000000,
    price = 100000,
    failedChannels = [],
    saves = 0
  const storage = memoryStore(tables, owner),
    collectorStorage = memoryStore(tables)
  const publicStorage = memoryStore(tables, null),
    jobs = new Map(),
    messages = []
  const dependencies = {
    storage,
    publicStorage,
    system: {now: () => now, id: prefix => `${prefix}-${randomUUID()}`},
    currencies: {rate: () => ({price})},
    notifications: {
      send(channel, message) {
        if (failedChannels.includes(channel))
          throw new Error('Queue unavailable')
        messages.push({channel, message})
        return {queued: true}
      }
    },
    scheduler: {
      list: () => [...jobs.values()].map(clone),
      set(job) {
        if (job.scope !== 'user')
          throw new Error('Users must not control shared jobs')
        saves++
        const value = {...job, id: `${owner}:${job.handler}`}
        jobs.set(job.handler, clone(value))
        return value
      }
    }
  }
  const bot = createPricebot(dependencies)
  const collector = createPricebot({...dependencies, storage: collectorStorage})
  return {
    bot,
    collector,
    storage,
    collectorStorage,
    publicStorage,
    jobs,
    messages,
    now: () => now,
    advance: seconds => (now += seconds),
    setTime: value => (now = value),
    setPrice: value => (price = value),
    failChannels: value => (failedChannels = value),
    saves: () => saves,
    observe(value, timestamp = now) {
      now = timestamp
      price = value
      return collector.collectPrices()
    },
    alert(options = {}) {
      return bot.saveAlert({
        name: 'My alert',
        amountUsd: 500,
        windowCount: 1,
        windowUnit: 'hour',
        channels: ['email'],
        enabled: true,
        ...options
      }).alert
    }
  }
}
