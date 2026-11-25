import {component} from './component.mjs'
import prepareChart from '../../static/chart-data.js'

export const HOUR = 3600
export const DAY = 24 * HOUR

export function createPricebot({storage, publicStorage, system, notifications, scheduler, currencies}) {
  const get = (service, {table, id}) => ({dataJson: JSON.stringify(service.get(table, id))})
  function list(service, {table, filtersJson, ...options}) {
    const page = service.list(table, {...options, filters: JSON.parse(filtersJson)})
    return {rowsJson: JSON.stringify(page.data), total: BigInt(page.total)}
  }
  let lastError
  const imports = {
    'lnbits:extension/host': {
      now: () => ({timestamp: BigInt(system.now())}),
      randomId: ({prefix}) => ({id: system.id(prefix)}),
      log({message, level}) {
        if (level === 'error') lastError = message
        system.log?.(message)
        return {ok: true}
      },
      storageGet: req => get(storage, req),
      storageGetPublic: req => get(publicStorage, req),
      storageGetPaginated: req => list(storage, req),
      storageGetPublicPaginated: req => list(publicStorage, req),
      storageSet({table, dataJson}) {storage.set(table, JSON.parse(dataJson)); return {ok: true}},
      storageDelete({table, id}) {storage.delete(table, id); return {ok: true}},
      notificationsSendUserNotification({type, message}) {
        return notifications.send(type, message)
      }
    },
    'lnbits:extension/scheduler': {
      listSchedules: ({scope}) => ({schedulesJson: JSON.stringify(scheduler.list(scope))}),
      setSchedule: request => ({scheduleJson: JSON.stringify(scheduler.set(request))})
    },
    'lnbits:extension/utils-currencies': {rate: ({currency}) => ({rate: 1, ...currencies.rate(currency)})}
  }
  let guest
  return new Proxy({}, {get(_, method) {
    return (request = {}) => {
      guest ??= component(imports)
      lastError = null
      let result
      try {result = JSON.parse(guest[method](JSON.stringify(request)))}
      catch (error) {guest = null;throw lastError ? new Error(lastError) : error}
      if (result.ok === false) throw new Error(result.error)
      return result.ok ? result.data : result
    }
  }})
}

// Exercise collection, retention, and recovery through the shipped exports.
export function createHistory({storage, publicStorage}) {
  let price, now = 0
  const bot = createPricebot({storage, publicStorage, currencies: {rate: () => ({price})}, system: {now: () => now}})
  return {
    collect(value, timestamp) {price = value; now = timestamp; return bot.collectPrices()},
    chart(range, timestamp, offset = 0) {now = timestamp;return bot.getHistory({range, offset})},
    status(timestamp) {now = timestamp;const state = bot.getState();return {latest: [state.observedAt, state.price]}},
    read(resolution) {
      const range = {minute: '1D', hour: '1W', day: '1Y', month: 'ALL'}[resolution]
      const buckets = []
      let offset = 0
      do {
        const page = bot.getHistory({range, offset})
        for (const chunk of page.chunks) {
          for (const row of JSON.parse(chunk)) {
            const points = prepareChart({...page, chunks: [JSON.stringify([row])], since: 0, until: Infinity}).points
            buckets.push(...points)
          }
        }
        offset = page.nextOffset
      } while (offset !== null)
      return buckets.sort((a, b) => a.start - b.start)
    }
  }
}
