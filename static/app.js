const app = Vue.createApp({
  // Render directly: extension CSP prohibits Vue's runtime template compiler.
  render() {
    const h = Vue.h
    const q = (name, props, children) =>
      h(
        Vue.resolveComponent(name),
        props,
        children ? {default: () => children} : undefined
      )
    const model = (target, field, numeric = false) => ({
      modelValue: target[field],
      'onUpdate:modelValue': value => {
        target[field] = numeric ? Number(value) : value
      }
    })
    const banner = (message, kind, role) =>
      q('q-banner', {class: `notice ${kind} q-mb-md`, rounded: true, role}, [
        message
      ])
    const muted = (text, extra = '') => h('p', {class: `muted ${extra}`}, text)
    const state = this.state

    return h('main', [
      h('header', {class: 'row items-center justify-between q-mb-xl'}, [
        h('div', {class: 'row items-center q-gutter-md'}, [
          h('span', {class: 'brand-icon', 'aria-hidden': 'true'}, '₿'),
          h('div', [
            h('h1', 'Pricebot'),
            muted('Bitcoin moves. Stay informed.', 'q-mb-none')
          ])
        ]),
        q('q-btn', {
          flat: true,
          round: true,
          icon: 'refresh',
          loading: this.loading,
          'aria-label': 'Refresh prices',
          onClick: () => this.load()
        })
      ]),
      this.error ? banner(this.error, 'error', 'alert') : null,
      this.success ? banner(this.success, 'success', 'status') : null,
      this.loading
        ? q('q-linear-progress', {
            indeterminate: true,
            color: 'primary',
            class: 'q-mb-lg'
          })
        : null,
      h(
        'section',
        {class: 'price-card q-mb-lg', 'aria-label': 'Bitcoin price'},
        [
          h('div', {class: 'row justify-between items-center q-mb-md'}, [
            h('span', {class: 'eyebrow'}, 'BITCOIN / USD'),
            q(
              'q-badge',
              {color: state?.stale ? 'grey-5' : 'green-4', outline: true},
              [state?.stale ? 'Waiting for fresh data' : 'Updated every minute']
            )
          ]),
          h('div', {class: 'price'}, this.dollars(state?.price)),
          h('div', {class: 'row items-center q-gutter-sm q-mt-sm'}, [
            state?.change24h != null
              ? h(
                  'span',
                  {class: state.change24h >= 0 ? 'positive' : 'negative'},
                  `${state.change24h >= 0 ? '+' : ''}${this.dollars(state.change24h)}`
                )
              : null,
            h(
              'span',
              {class: 'muted'},
              state?.change24h == null
                ? 'Building 24-hour history'
                : 'over the last 24 hours'
            )
          ]),
          h(PricebotChart, {
            history: this.history,
            range: this.range,
            loading: this.chartLoading,
            onRange: this.changeRange
          }),
          muted(
            `${this.date(state?.observedAt)} · Rates provided by LNbits`,
            'text-caption q-mt-lg q-mb-none'
          )
        ]
      ),
      h('div', {class: 'row q-col-gutter-lg'}, [
        h('section', {class: 'col-12 col-md-7'}, [
          h('div', {class: 'panel'}, [
            h('div', {class: 'row items-center justify-between q-mb-lg'}, [
              h('h2', 'Your alerts'),
              q('q-btn', {
                unelevated: true,
                color: 'primary',
                textColor: 'black',
                icon: 'add',
                label: 'New alert',
                disable: this.busy || !state,
                onClick: () => this.openAlert()
              })
            ]),
            !state?.alerts.length
              ? muted(
                  'Create an alert for the price fluctuation you care about.'
                )
              : null,
            ...(state?.alerts || []).map(alert =>
              h('article', {key: alert.id, class: 'alert-row'}, [
                h(
                  'div',
                  {
                    class:
                      'row items-center justify-between no-wrap q-gutter-sm'
                  },
                  [
                    h('div', {class: 'alert-copy'}, [
                      h('div', {class: 'text-weight-medium'}, [
                        alert.name,
                        !alert.enabled
                          ? q('q-badge', {color: 'grey-8', label: 'Paused'})
                          : null
                      ]),
                      muted(
                        `${this.dollars(alert.amount_usd)} fluctuation within ${alert.window_count} ${alert.window_unit}${alert.window_count === 1 ? '' : 's'} · ${alert.channels.map(this.channelName).join(', ')}`,
                        'q-mt-xs q-mb-none'
                      )
                    ]),
                    h('div', {class: 'row no-wrap'}, [
                      q('q-btn', {
                        flat: true,
                        round: true,
                        icon: 'edit',
                        size: 'sm',
                        disable: this.busy,
                        'aria-label': `Edit ${alert.name}`,
                        onClick: () => this.openAlert(alert)
                      }),
                      q('q-btn', {
                        flat: true,
                        round: true,
                        icon: 'delete_outline',
                        size: 'sm',
                        disable: this.busy,
                        'aria-label': `Delete ${alert.name}`,
                        onClick: () => this.deleteAlert(alert)
                      })
                    ])
                  ]
                )
              ])
            ),
            muted(
              'An alert compares the highest and lowest recorded prices within its window. Each selected channel is notified once; the alert rearms below your threshold.',
              'text-caption q-mt-lg q-mb-none'
            )
          ])
        ]),
        h('section', {class: 'col-12 col-md-5'}, [
          q(
            'q-form',
            {ref: 'settingsForm', class: 'panel', onSubmit: this.saveSettings},
            [
              h('h2', {class: 'q-mb-lg'}, 'Daily summary'),
              q('q-select', {
                ...model(this, 'channels'),
                outlined: true,
                options: this.channelOptions,
                multiple: true,
                emitValue: true,
                mapOptions: true,
                useChips: true,
                label: 'Summary channels',
                class: 'q-mb-sm'
              }),
              muted(
                'Uses the address or identifier saved in your LNbits account notification settings. Configure it there before enabling alerts.',
                'text-caption'
              ),
              q('q-toggle', {
                ...model(this, 'dailySummary'),
                label: 'Daily summary',
                color: 'primary'
              }),
              muted(
                'At 09:00 UTC, receive the current price and its 24-hour change.',
                'text-caption q-mt-xs'
              ),
              q('q-btn', {
                unelevated: true,
                outline: true,
                color: 'primary',
                // The iframe sandbox blocks native form submission.
                type: 'button',
                onClick: () => this.$refs.settingsForm.submit(),
                label: 'Save settings',
                loading: this.busy,
                class: 'q-mt-sm full-width'
              })
            ]
          )
        ])
      ]),
      h(
        'footer',
        {class: 'muted text-caption q-mt-xl'},
        'Shared BTC/USD history · Minute prices: 1 day · Hourly: 7 days · Daily: 366 days · Monthly: forever'
      ),
      q('q-dialog', model(this, 'dialog'), [
        q('q-card', {class: 'alert-dialog'}, [
          q('q-form', {ref: 'alertForm', onSubmit: this.saveAlert}, [
            q('q-card-section', {}, [
              h('h2', this.editing ? 'Edit alert' : 'New price alert')
            ]),
            q('q-card-section', {class: 'q-gutter-md'}, [
              this.error ? banner(this.error, 'error', 'alert') : null,
              q('q-input', {
                ...model(this.form, 'name'),
                outlined: true,
                label: 'Alert name',
                maxlength: 80,
                rules: [value => !!value.trim() || 'Enter a name']
              }),
              q('q-input', {
                ...model(this.form, 'amountUsd', true),
                outlined: true,
                type: 'number',
                min: '0.01',
                max: '1000000000',
                step: '0.01',
                label: 'Price fluctuation (USD)',
                rules: [value => Number(value) > 0 || 'Enter a positive amount']
              }),
              h('div', {class: 'row q-col-gutter-sm'}, [
                h('div', {class: 'col-6'}, [
                  q('q-input', {
                    ...model(this.form, 'windowCount', true),
                    outlined: true,
                    type: 'number',
                    min: this.form.windowUnit === 'minute' ? '10' : '1',
                    step: '1',
                    label: 'Interval',
                    rules: [
                      value =>
                        (Number.isSafeInteger(Number(value)) &&
                          value >=
                            (this.form.windowUnit === 'minute' ? 10 : 1)) ||
                        'Use at least 10 minutes or 1 other unit'
                    ]
                  })
                ]),
                h('div', {class: 'col-6'}, [
                  q('q-select', {
                    ...model(this.form, 'windowUnit'),
                    outlined: true,
                    label: 'Unit',
                    options: ['minute', 'hour', 'day', 'week', 'month']
                  })
                ])
              ]),
              muted(
                'A month is 30 days. Older windows use hourly, daily, then monthly history.',
                'text-caption'
              ),
              q('q-select', {
                ...model(this.form, 'channels'),
                outlined: true,
                multiple: true,
                useChips: true,
                emitValue: true,
                mapOptions: true,
                options: this.channelOptions,
                label: 'Notify me via',
                rules: [
                  value => value.length > 0 || 'Choose at least one channel'
                ]
              }),
              muted(
                'Uses the email address, Telegram chat, or Nostr identifier saved in your LNbits account.',
                'text-caption'
              ),
              q('q-toggle', {
                ...model(this.form, 'enabled'),
                label: 'Alert enabled'
              })
            ]),
            q('q-card-actions', {align: 'right'}, [
              q('q-btn', {
                flat: true,
                label: 'Cancel',
                onClick: () => {
                  this.dialog = false
                }
              }),
              q('q-btn', {
                color: 'primary',
                textColor: 'black',
                type: 'button',
                onClick: () => this.$refs.alertForm.submit(),
                label: 'Save alert',
                loading: this.busy
              })
            ])
          ])
        ])
      ])
    ])
  },
  data() {
    return {
      loading: true,
      busy: false,
      error: '',
      success: '',
      state: null,
      channels: ['email'],
      channelOptions: [
        {label: 'Email', value: 'email'},
        {label: 'Telegram', value: 'telegram'},
        {label: 'Nostr', value: 'nostr'}
      ],
      history: null,
      range: '1D',
      chartLoading: true,
      chartRequest: 0,
      dailySummary: false,
      dialog: false,
      editing: null,
      form: {
        name: '',
        amountUsd: 500,
        windowCount: 1,
        windowUnit: 'hour',
        channels: ['email'],
        enabled: true
      },
      timer: null
    }
  },
  async mounted() {
    await this.load(true)
    this.timer = setInterval(() => this.load(false), 60000)
  },
  beforeUnmount() {
    clearInterval(this.timer)
  },
  methods: {
    dollars(value) {
      return value == null
        ? '—'
        : new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency: 'USD'
          }).format(value)
    },
    date(value) {
      return value
        ? new Date(value * 1000).toLocaleString()
        : 'Waiting for the first price'
    },
    async load(initial = false) {
      try {
        const [state] = await Promise.all([
          pricebotBridge.call('/state'),
          this.loadHistory()
        ])
        this.state = state
        if (initial && this.state.preferences) {
          this.channels = [...this.state.preferences.channels]
          this.dailySummary = this.state.preferences.daily_summary
        }
      } catch (error) {
        this.error = error.message
      } finally {
        this.loading = false
      }
    },
    async action(path, method, body, message) {
      this.busy = true
      this.error = ''
      this.success = ''
      try {
        await pricebotBridge.call(path, method, body)
        this.success = message
        await this.load()
        return true
      } catch (error) {
        this.error = error.message
        return false
      } finally {
        this.busy = false
      }
    },
    async saveSettings() {
      await this.action(
        '/preferences',
        'PUT',
        {channels: this.channels, dailySummary: this.dailySummary},
        'Notification settings saved.'
      )
    },
    openAlert(alert = null) {
      this.error = ''
      this.editing = alert?.id || null
      this.form = alert
        ? {
            name: alert.name,
            amountUsd: alert.amount_usd,
            windowCount: alert.window_count,
            windowUnit: alert.window_unit,
            channels: [...alert.channels],
            enabled: alert.enabled
          }
        : {
            name: '',
            amountUsd: 500,
            windowCount: 1,
            windowUnit: 'hour',
            channels: ['email'],
            enabled: true
          }
      this.dialog = true
    },
    async saveAlert() {
      const path = this.editing
        ? `/alerts/${encodeURIComponent(this.editing)}`
        : '/alerts'
      if (
        await this.action(
          path,
          this.editing ? 'PUT' : 'POST',
          this.form,
          'Alert saved.'
        )
      )
        this.dialog = false
    },
    deleteAlert(alert) {
      this.$q
        .dialog({
          title: 'Delete alert?',
          message: alert.name,
          cancel: true,
          persistent: true
        })
        .onOk(() =>
          this.action(
            `/alerts/${encodeURIComponent(alert.id)}`,
            'DELETE',
            null,
            'Alert deleted.'
          )
        )
    },
    channelName(value) {
      return (
        {email: 'Email', telegram: 'Telegram', nostr: 'Nostr'}[value] || value
      )
    },
    async changeRange(range) {
      this.range = range
      this.history = null
      await this.loadHistory()
    },
    async loadHistory() {
      const request = ++this.chartRequest
      this.chartLoading = true
      try {
        let history = null,
          offset = 0
        do {
          const page = await pricebotBridge.call(
            `/history?range=${encodeURIComponent(this.range)}&offset=${offset}`
          )
          if (request !== this.chartRequest) return
          if (!history) history = {...page, chunks: []}
          history.chunks.push(...page.chunks)
          offset = page.nextOffset
        } while (offset !== null)
        this.history = preparePricebotChart(history)
      } catch (error) {
        if (request === this.chartRequest) this.error = error.message
      } finally {
        if (request === this.chartRequest) this.chartLoading = false
      }
    }
  }
})
app.use(Quasar, {config: {dark: true, brand: {primary: '#f6a43a'}}})
app.mount('#pricebot')
