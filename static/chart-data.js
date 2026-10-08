// Shared by the browser and Node tests; no runtime template compiler or library.
const preparePricebotChart = response => {
  const {range, resolution, since, until, chunks} = response
  const minute = resolution === 'minute'
  const endOf = start => {
    if (resolution !== 'month')
      return start + {minute: 60, hour: 3600, day: 86400}[resolution]
    const date = new Date(start * 1000)
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) / 1000
  }
  const decode = row => {
    if (minute)
      return {
        start: row[0],
        end: endOf(row[0]),
        open: row[1],
        high: row[1],
        low: row[1],
        close: row[1],
        first: row[0],
        last: row[0],
        highAt: row[0],
        lowAt: row[0],
        count: 1
      }
    const [start, open, high, low, close, first, last, highAt, lowAt, count] =
      row
    return {
      start,
      end: endOf(start),
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
  const rows = chunks
    .flatMap(chunk => JSON.parse(chunk))
    .filter(row => row[minute ? 0 : 6] >= since && row[minute ? 0 : 5] <= until)
    .sort((a, b) => a[0] - b[0])
  const points = [],
    size = Math.max(1, Math.ceil(rows.length / 720))
  let low = Infinity,
    high = -Infinity
  for (let i = 0; i < rows.length;) {
    const point = decode(rows[i])
    let next = i + 1
    for (; next < Math.min(i + size, rows.length); next++) {
      const row = rows[next]
      if (row[0] > point.end) break
      const rowHigh = row[minute ? 1 : 2],
        rowLow = row[minute ? 1 : 3]
      if (rowHigh > point.high) {
        point.high = rowHigh
        point.highAt = row[minute ? 0 : 7]
      }
      if (rowLow < point.low) {
        point.low = rowLow
        point.lowAt = row[minute ? 0 : 8]
      }
      point.end = endOf(row[0])
      point.last = row[minute ? 0 : 6]
      point.close = row[minute ? 1 : 4]
      point.count += minute ? 1 : row[9]
    }
    low = Math.min(low, point.low)
    high = Math.max(high, point.high)
    points.push(point)
    i = next
  }
  const first = points[0],
    last = points.at(-1)
  return {
    range,
    resolution,
    points,
    from: first?.first ?? null,
    to: last?.last ?? null,
    change: first ? last.close - first.open : null,
    changePercent: first ? (last.close / first.open - 1) * 100 : null,
    low: first ? low : null,
    high: first ? high : null
  }
}
if (typeof module !== 'undefined') module.exports = preparePricebotChart
