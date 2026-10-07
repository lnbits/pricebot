import {
  storageGet,
  storageSet,
  storageGetPaginated,
  storageDelete,
  randomId,
  now,
  notificationsSendUserNotification
} from 'lnbits:extension/host'
import {
  get,
  set,
  getPaginated,
  delete as deleteShared
} from 'lnbits:extension/storage-shared'
import {setSchedule, listSchedules} from 'lnbits:extension/scheduler'
import {rate} from 'lnbits:extension/utils-currencies'
import {createPricebot} from './logic.js'

function storageAdapter(read, write, list, remove) {
  return {
    get(table, id) {
      const value = read({table, id}).dataJson
      return value ? JSON.parse(value) : null
    },
    set(table, data) {
      write({table, dataJson: JSON.stringify(data)})
    },
    list(table, options = {}) {
      const page = list({
        table,
        filtersJson: '{}',
        search: '',
        searchFields: [],
        sortBy: options.sortBy || '',
        descending: options.descending === true,
        limit: options.limit || 100,
        offset: options.offset || 0
      })
      return {data: JSON.parse(page.rowsJson), total: Number(page.total)}
    },
    delete(table, id) {
      remove({table, id})
    }
  }
}

const bot = createPricebot({
  storage: storageAdapter(
    storageGet,
    storageSet,
    storageGetPaginated,
    storageDelete
  ),
  shared: storageAdapter(get, set, getPaginated, deleteShared),
  scheduler: {
    list(scope) {
      return JSON.parse(
        listSchedules({scope, limit: 100, offset: 0}).schedulesJson
      )
    },
    set(request) {
      return JSON.parse(setSchedule(request).scheduleJson)
    }
  },
  currencies: {
    rate(currency) {
      return rate({currency})
    }
  },
  notifications: {
    send(type, message) {
      return notificationsSendUserNotification({type, message})
    }
  },
  system: {
    now() {
      return Number(now().timestamp)
    },
    id(prefix) {
      return randomId({prefix}).id
    }
  }
})

function request(value) {
  const parsed = JSON.parse(value || '{}')
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('Expected an object.')
  return parsed
}

function interactive(method, value) {
  try {
    return JSON.stringify({ok: true, data: bot[method](request(value))})
  } catch (error) {
    return JSON.stringify({
      ok: false,
      error: error.message || 'Pricebot request failed.'
    })
  }
}

export function getState(value) {
  return interactive('getState', value)
}
export function setupShared(value) {
  return interactive('setupShared', value)
}
export function savePreferences(value) {
  return interactive('savePreferences', value)
}
export function saveAlert(value) {
  return interactive('saveAlert', value)
}
export function deleteAlert(value) {
  return interactive('deleteAlert', value)
}
export function collectPrices(value) {
  return JSON.stringify(bot.collectPrices(request(value)))
}
export function pruneHistory(value) {
  return JSON.stringify(bot.pruneHistory(request(value)))
}
export function checkAlerts(value) {
  return JSON.stringify(bot.checkAlerts(request(value)))
}
export function dailySummary(value) {
  return JSON.stringify(bot.dailySummary(request(value)))
}
