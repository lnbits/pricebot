// SVG rendering avoids external chart dependencies and runtime template compilation.
window.PricebotChart = {
  props: ['history', 'range', 'loading'],
  emits: ['range'],
  data: () => ({hover: null, width: 900, observer: null}),
  mounted() {
    this.observer = new ResizeObserver(entries => {
      this.width = Math.max(300, entries[0].contentRect.width)
    })
    this.observer.observe(this.$refs.host)
  },
  beforeUnmount() {
    this.observer?.disconnect()
  },
  watch: {
    history() {
      this.hover = null
    }
  },
  computed: {
    plot() {
      const rows = this.history?.points || []
      if (!rows.length) return null
      const low = this.history.low,
        high = this.history.high
      const padding = Math.max((high - low) * 0.12, high * 0.0001, 1)
      const bottom = low - padding,
        top = high + padding
      const first = rows[0].first,
        last = rows.at(-1).last
      const right = this.width - 104
      const x = value =>
        last === first
          ? (right + 12) / 2
          : 12 + ((value - first) / (last - first)) * (right - 12)
      const y = value => 18 + ((top - value) / (top - bottom)) * 206
      const groups = []
      let group = []
      rows.forEach((row, index) => {
        // Never draw a continuous line across missing buckets.
        if (index && row.start > rows[index - 1].end) {
          groups.push(group)
          group = []
        }
        group.push({
          ...row,
          x: x(row.last),
          y: y(row.close),
          highY: y(row.high),
          lowY: y(row.low)
        })
      })
      if (group.length) groups.push(group)
      return {
        groups,
        right,
        points: groups.flat(),
        ticks: [top, (top + bottom) / 2, bottom].map(value => ({
          value,
          y: y(value)
        })),
        first,
        last
      }
    }
  },
  methods: {
    money(value) {
      return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: 2
      }).format(value)
    },
    time(value, full = false) {
      return new Date(value * 1000).toLocaleString(
        undefined,
        full
          ? {
              month: 'short',
              day: 'numeric',
              year: 'numeric',
              hour: '2-digit',
              minute: '2-digit'
            }
          : this.range === '1D'
            ? {hour: '2-digit', minute: '2-digit'}
            : {
                month: 'short',
                day: 'numeric',
                year: this.range === 'ALL' ? 'numeric' : undefined
              }
      )
    },
    pointAt(event) {
      const rect = event.currentTarget.getBoundingClientRect()
      const x = ((event.clientX - rect.left) / rect.width) * this.width
      const points = this.plot?.points || []
      if (points.length)
        this.hover = points.reduce((a, b) =>
          Math.abs(a.x - x) <= Math.abs(b.x - x) ? a : b
        )
    },
    move(event) {
      if (
        !['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape'].includes(
          event.key
        )
      )
        return
      event.preventDefault()
      const points = this.plot?.points || []
      if (!points.length) return
      if (event.key === 'Escape') {
        this.hover = null
        return
      }
      const current = this.hover
        ? points.findIndex(point => point.last === this.hover.last)
        : points.length - 1
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? points.length - 1
            : Math.max(
                0,
                Math.min(
                  points.length - 1,
                  current + (event.key === 'ArrowRight' ? 1 : -1)
                )
              )
      this.hover = points[next]
    }
  },
  render() {
    const h = Vue.h,
      plot = this.plot,
      selected = this.hover
    const change = this.history?.change
    const strokeClass = change < 0 ? 'chart-falling' : 'chart-rising'
    const line = points =>
      points
        .map(
          (point, i) =>
            `${i ? 'L' : 'M'}${point.x.toFixed(2)},${point.y.toFixed(2)}`
        )
        .join(' ')
    const area = points =>
      [
        ...points.map(
          (point, i) =>
            `${i ? 'L' : 'M'}${point.x.toFixed(2)},${point.highY.toFixed(2)}`
        ),
        ...[...points]
          .reverse()
          .map(point => `L${point.x.toFixed(2)},${point.lowY.toFixed(2)}`),
        'Z'
      ].join(' ')
    return h(
      'div',
      {
        ref: 'host',
        class: 'price-history',
        'aria-busy': this.loading ? 'true' : 'false'
      },
      [
        h(
          'div',
          {
            class: 'chart-ranges',
            role: 'group',
            'aria-label': 'Price chart range'
          },
          ['1D', '1W', '1M', '1Y', 'ALL'].map(range =>
            h(
              'button',
              {
                type: 'button',
                class: ['chart-range', {'is-selected': this.range === range}],
                'aria-pressed': this.range === range ? 'true' : 'false',
                onClick: () => this.$emit('range', range)
              },
              range === 'ALL' ? 'All' : range
            )
          )
        ),
        h(
          'div',
          {class: 'chart-detail', 'aria-live': 'polite'},
          selected
            ? [
                h('strong', this.money(selected.close)),
                h('span', {class: 'muted'}, this.time(selected.last, true)),
                h(
                  'span',
                  {class: 'muted'},
                  `Low ${this.money(selected.low)} · High ${this.money(selected.high)}`
                )
              ]
            : change != null
              ? [
                  h(
                    'strong',
                    {class: change < 0 ? 'negative' : 'positive'},
                    `${change >= 0 ? '+' : ''}${this.money(change)} (${change >= 0 ? '+' : ''}${this.history.changePercent.toFixed(2)}%)`
                  ),
                  h('span', {class: 'muted'}, 'in the available range')
                ]
              : [
                  h(
                    'span',
                    {class: 'muted'},
                    this.loading
                      ? 'Loading history…'
                      : 'History appears as prices are collected.'
                  )
                ]
        ),
        plot
          ? h(
              'svg',
              {
                viewBox: `0 0 ${this.width} 262`,
                class: ['price-chart', strokeClass],
                role: 'img',
                'aria-label':
                  'BTC price history in USD. Use arrow keys to inspect prices.',
                tabindex: 0,
                onPointermove: this.pointAt,
                onPointerleave: event => {
                  if (
                    event.currentTarget !==
                    event.currentTarget.ownerDocument.activeElement
                  )
                    this.hover = null
                },
                onKeydown: this.move,
                onBlur: () => {
                  this.hover = null
                }
              },
              [
                h(
                  'title',
                  `BTC/USD ${this.range}: low ${this.money(this.history.low)}, high ${this.money(this.history.high)}`
                ),
                ...plot.ticks.flatMap(tick => [
                  h('line', {
                    class: 'chart-grid',
                    x1: 12,
                    x2: plot.right,
                    y1: tick.y,
                    y2: tick.y
                  }),
                  h(
                    'text',
                    {class: 'chart-axis', x: plot.right + 12, y: tick.y + 4},
                    this.money(tick.value)
                  )
                ]),
                ...plot.groups.flatMap(points => [
                  h('path', {class: 'chart-band', d: area(points)}),
                  h('path', {class: 'chart-line', d: line(points)}),
                  ...(points.length === 1
                    ? [
                        h('circle', {
                          class: 'chart-dot',
                          cx: points[0].x,
                          cy: points[0].y,
                          r: 3.5
                        })
                      ]
                    : [])
                ]),
                h(
                  'text',
                  {class: 'chart-axis', x: 12, y: 253},
                  this.time(plot.first)
                ),
                h(
                  'text',
                  {
                    class: 'chart-axis',
                    x: plot.right,
                    y: 253,
                    'text-anchor': 'end'
                  },
                  this.time(plot.last)
                ),
                selected
                  ? h('g', [
                      h('line', {
                        class: 'chart-crosshair',
                        x1: selected.x,
                        x2: selected.x,
                        y1: 12,
                        y2: 230
                      }),
                      h('circle', {
                        class: 'chart-dot',
                        cx: selected.x,
                        cy: selected.y,
                        r: 4.5
                      })
                    ])
                  : null
              ]
            )
          : h('div', {class: 'chart-empty'}, [
              h('span', 'No recorded prices in this range yet.')
            ]),
        plot
          ? h('div', {class: 'chart-caption muted'}, [
              h(
                'span',
                `Low ${this.money(this.history.low)} · High ${this.money(this.history.high)}`
              ),
              h('span', 'Line: closing price · Shading: low to high')
            ])
          : null
      ]
    )
  }
}
