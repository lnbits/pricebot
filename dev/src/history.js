export const MINUTE = 60
export const HOUR = 3600
export const DAY = 86400
export const UNITS = {
  minute: MINUTE,
  hour: HOUR,
  day: DAY,
  week: 7 * DAY,
  month: 30 * DAY
}
const SERIES = 'btc-usd'
const RETENTION = {minute: DAY, hour: 7 * DAY, day: 366 * DAY}
const WIDTH = {minute: MINUTE, hour: HOUR, day: DAY}

function bucketBounds(timestamp, resolution) {
  if (resolution === 'month') {
    const date = new Date(timestamp * 1000),
      year = date.getUTCFullYear(),
      month = date.getUTCMonth()
    return [
      Date.UTC(year, month, 1) / 1000,
      Date.UTC(year, month + 1, 1) / 1000
    ]
  }
  const start = Math.floor(timestamp / WIDTH[resolution]) * WIDTH[resolution]
  return [start, start + WIDTH[resolution]]
}

// Minute tuples: [observedAt, price]. Other tuples:
// [start, open, high, low, close, first, last, highAt, lowAt, count].
// Keeping stored tuples compact avoids expanding thousands of objects in WASM.
function decode(values, resolution) {
  if (resolution === 'minute') {
    const [timestamp, price] = values
    return {
      start: timestamp,
      end: timestamp + MINUTE,
      open: price,
      high: price,
      low: price,
      close: price,
      first: timestamp,
      last: timestamp,
      highAt: timestamp,
      lowAt: timestamp,
      count: 1
    }
  }
  const [start, open, high, low, close, first, last, highAt, lowAt, count] =
    values
  return {
    start,
    end: bucketBounds(start, resolution)[1],
    open,
    high,
    low,
    close,
    first,
    last,
    highAt,
    lowAt,
    count
  }
}

function resolutionFor(seconds) {
  return seconds <= DAY
    ? 'minute'
    : seconds <= 7 * DAY
      ? 'hour'
      : seconds <= 366 * DAY
        ? 'day'
        : 'month'
}
function chunkStart(timestamp, resolution) {
  if (resolution === 'minute') return Math.floor(timestamp / HOUR) * HOUR
  if (resolution === 'hour') return Math.floor(timestamp / DAY) * DAY
  if (resolution === 'day') return bucketBounds(timestamp, 'month')[0]
  return Date.UTC(new Date(timestamp * 1000).getUTCFullYear(), 0, 1) / 1000
}

export function createHistory({storage, publicStorage}) {
  const key = (resolution, timestamp) =>
    `${SERIES}:${resolution}:${chunkStart(timestamp, resolution)}`
  function readRaw(resolution, since = 0) {
    const result = [],
      minute = resolution === 'minute'
    for (let offset = 0; ; offset += 100) {
      const page = publicStorage.list('history', {
        filters: {resolution},
        sortBy: 'start',
        descending: true,
        limit: 100,
        offset
      })
      for (const row of page.data)
        result.push(
          ...JSON.parse(row.buckets_json).filter(
            bucket => bucket[minute ? 0 : 6] >= since
          )
        )
      if (
        offset + page.data.length >= page.total ||
        !page.data.length ||
        page.data.at(-1).start < since
      )
        break
    }
    return result.sort((a, b) => a[0] - b[0])
  }
  function write(resolution, id, start, rows) {
    storage.set('history', {
      id,
      series: SERIES,
      resolution,
      start,
      buckets_json: JSON.stringify(rows)
    })
  }
  function applySample(timestamp, price) {
    for (const resolution of ['minute', 'hour', 'day', 'month']) {
      const id = key(resolution, timestamp),
        previous = storage.get('history', id)
      const rows = previous ? JSON.parse(previous.buckets_json) : [],
        minute = resolution === 'minute'
      const last = rows.at(-1)
      if (last && last[minute ? 0 : 6] >= timestamp) continue
      if (minute) rows.push([timestamp, price])
      else {
        const [start] = bucketBounds(timestamp, resolution)
        if (!last || last[0] !== start)
          rows.push([
            start,
            price,
            price,
            price,
            price,
            timestamp,
            timestamp,
            timestamp,
            timestamp,
            1
          ])
        else {
          if (price > last[2]) {
            last[2] = price
            last[7] = timestamp
          }
          if (price < last[3]) {
            last[3] = price
            last[8] = timestamp
          }
          last[4] = price
          last[6] = timestamp
          last[9]++
        }
      }
      write(resolution, id, chunkStart(timestamp, resolution), rows)
    }
    // There are at most 25 minute chunks, 8 hourly chunks and 14 daily chunks
    // before cleanup. Even recovery after downtime fits the 100-call budget.
    for (const resolution of ['minute', 'hour', 'day']) {
      const cutoff = timestamp - RETENTION[resolution]
      const page = storage.list('history', {
        filters: {resolution},
        sortBy: 'start',
        limit: 30
      })
      for (const row of page.data) {
        if (row.start >= cutoff) break
        const rows = JSON.parse(row.buckets_json)
        const retained = rows.filter(
          bucket => bucket[resolution === 'minute' ? 0 : 6] >= cutoff
        )
        if (!retained.length) storage.delete('history', row.id)
        else {
          if (retained.length !== rows.length)
            write(resolution, row.id, row.start, retained)
          break
        }
      }
    }
    write('latest', `${SERIES}:latest`, timestamp, [timestamp, price])
  }
  return {
    read(resolution) {
      return readRaw(resolution).map(row => decode(row, resolution))
    },
    status(now, withBaseline = true) {
      const row = publicStorage.get('history', `${SERIES}:latest`)
      const latest = row ? JSON.parse(row.buckets_json) : null
      if (!latest || latest[0] > now) return {latest: null, prior: null}
      let prior = null
      if (withBaseline) {
        const target = latest[0] - DAY
        const previous = publicStorage.get('history', key('minute', target))
        if (previous) {
          const rows = JSON.parse(previous.buckets_json)
          prior = rows.findLast(sample => sample[0] <= target) || null
          if (prior && target - prior[0] > 2 * MINUTE) prior = null
        }
      }
      return {latest, prior}
    },
    collect(price, timestamp) {
      const pendingId = `${SERIES}:pending`,
        pending = storage.get('history', pendingId)
      if (pending) {
        const sample = JSON.parse(pending.buckets_json)
        if (sample[0] > timestamp)
          throw new Error('The collector clock moved backwards.')
        applySample(sample[0], sample[1])
        storage.delete('history', pendingId)
      }
      const latestRow = storage.get('history', `${SERIES}:latest`)
      const latest = latestRow ? JSON.parse(latestRow.buckets_json) : null
      if (latest?.[0] > timestamp)
        throw new Error('The collector clock moved backwards.')
      if (latest?.[0] === timestamp)
        return {collected: false, price: latest[1], timestamp}
      // Journal the observation before any aggregate is changed. Recovery also
      // handles a failure immediately before an hour/day/month boundary.
      write('pending', pendingId, timestamp, [timestamp, price])
      applySample(timestamp, price)
      storage.delete('history', pendingId)
      return {collected: true, price, timestamp}
    },
    load(now, intervals) {
      const windows = Array.isArray(intervals) ? intervals : [intervals]
      const result = {
        minute: [],
        hour: [],
        day: [],
        month: [],
        latest: this.status(now, false).latest
      }
      for (const resolution of ['minute', 'hour', 'day', 'month']) {
        const relevant = windows.filter(
          seconds => resolutionFor(seconds) === resolution
        )
        if (relevant.length)
          result[resolution] = readRaw(resolution, now - Math.max(...relevant))
      }
      return result
    },
    chart(range, now, offset = 0) {
      const choices = {
        '1D': ['minute', DAY],
        '1W': ['hour', 7 * DAY],
        '1M': ['day', 30 * DAY],
        '1Y': ['day', 366 * DAY],
        ALL: ['month', Infinity]
      }
      if (!Object.hasOwn(choices, range))
        throw new Error('Choose 1D, 1W, 1M, 1Y, or ALL.')
      const [resolution, duration] = choices[range],
        since = Number.isFinite(duration) ? now - duration : 0
      if (!Number.isSafeInteger(offset) || offset < 0)
        throw new Error('Invalid history offset.')
      const page = publicStorage.list('history', {
        filters: {resolution},
        sortBy: 'start',
        descending: true,
        limit: 4,
        offset
      })
      const more =
        page.data.length &&
        offset + page.data.length < page.total &&
        page.data.at(-1).start >= since
      // Bound each response; the browser assembles pages and draws the chart.
      return {
        range,
        resolution,
        since,
        until: now,
        chunks: page.data.map(row => row.buckets_json),
        nextOffset: more ? offset + page.data.length : null
      }
    }
  }
}

export function windowRanges(history, now, intervals) {
  const result = new Map(),
    unique = [...new Set(intervals)]
  for (const resolution of ['minute', 'hour', 'day', 'month']) {
    const windows = unique
      .filter(seconds => resolutionFor(seconds) === resolution)
      .sort((a, b) => a - b)
    if (!windows.length) continue
    const lows = windows.map(() => Infinity),
      highs = windows.map(() => -Infinity)
    const upperLows = [...lows],
      upperHighs = [...highs]
    function indexAt(time) {
      const age = now - time
      let left = 0,
        right = windows.length
      while (left < right) {
        const middle = (left + right) >>> 1
        if (windows[middle] < age) left = middle + 1
        else right = middle
      }
      return left
    }
    function include(index, low, high, lower, upper) {
      if (index < windows.length) {
        if (low < lower[index]) lower[index] = low
        if (high > upper[index]) upper[index] = high
      }
    }
    for (const row of history[resolution] || []) {
      if (resolution === 'minute') {
        if (row[0] > now) continue
        const index = indexAt(row[0])
        include(index, row[1], row[1], lows, highs)
        include(index, row[1], row[1], upperLows, upperHighs)
      } else {
        if (row[5] > now) continue
        const full = indexAt(row[5]),
          partial = row[5] === row[6] ? full : indexAt(Math.min(row[6], now))
        if (row[6] <= now) include(full, row[3], row[2], lows, highs)
        // Most buckets fit entirely. Inspect individual timestamps only for a
        // boundary bucket, instead of expanding every stored observation.
        if (partial !== full || row[6] > now)
          for (const [timeIndex, priceIndex] of [
            [5, 1],
            [6, 4],
            [7, 2],
            [8, 3]
          ])
            if (row[timeIndex] <= now)
              include(
                indexAt(row[timeIndex]),
                row[priceIndex],
                row[priceIndex],
                lows,
                highs
              )
        include(partial, row[3], row[2], upperLows, upperHighs)
      }
    }
    let low = Infinity,
      high = -Infinity,
      upperLow = Infinity,
      upperHigh = -Infinity
    for (let i = 0; i < windows.length; i++) {
      low = Math.min(low, lows[i])
      high = Math.max(high, highs[i])
      upperLow = Math.min(upperLow, upperLows[i])
      upperHigh = Math.max(upperHigh, upperHighs[i])
      result.set(
        windows[i],
        Number.isFinite(low)
          ? {
              low,
              high,
              variation: high - low,
              upperVariation: upperHigh - upperLow
            }
          : null
      )
    }
  }
  return result
}

export function windowRange(history, now, seconds) {
  return windowRanges(history, now, [seconds]).get(seconds)
}
