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
          h('img', {
            src: '/ext-assets/pricebot/icon.svg',
            width: 54,
            height: 54,
            alt: ''
          }),
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
                disable: !state?.preferences || this.busy,
                onClick: () => this.openAlert()
              })
            ]),
            !state?.preferences
              ? muted(
                  'Choose your notification channel and save settings to create your first alert.'
                )
              : !state.alerts.length
                ? muted(
                    'Create an alert for a price movement you care about. Pricebot checks both rises and falls.'
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
                        `${this.dollars(alert.amount_usd)} in ${alert.window_minutes} minutes`,
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
              'One notification when a threshold is crossed. The alert rearms when the price movement falls below your threshold. New windows wait until enough history is collected.',
              'text-caption q-mt-lg q-mb-none'
            )
          ])
        ]),
        h('section', {class: 'col-12 col-md-5'}, [
          q(
            'q-form',
            {ref: 'settingsForm', class: 'panel', onSubmit: this.saveSettings},
            [
              h('h2', {class: 'q-mb-lg'}, 'Notifications'),
              q('q-select', {
                ...model(this, 'channel'),
                outlined: true,
                options: ['email', 'nostr', 'telegram'],
                label: 'Send notifications via',
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
          ),
          q(
            'q-expansion-item',
            {
              label: 'Your price collection',
              icon: 'settings',
              class: 'panel admin-panel q-mt-lg'
            },
            [
              muted(
                'Saving notification settings starts your price collection. You can also start it here. Prices are collected every minute; your history is pruned daily at 00:05 UTC.',
                'text-caption q-mt-md'
              ),
              q('q-btn', {
                outline: true,
                color: 'primary',
                label: 'Start / resume price collection',
                loading: this.busy,
                onClick: this.setup
              })
            ]
          )
        ])
      ]),
      h(
        'footer',
        {class: 'muted text-caption q-mt-xl'},
        'Alert windows: 1 minute to 24 hours · 48-hour history retention with daily cleanup · USD'
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
                label: 'Price change (USD)',
                rules: [value => Number(value) > 0 || 'Enter a positive amount']
              }),
              q('q-input', {
                ...model(this.form, 'windowMinutes', true),
                outlined: true,
                type: 'number',
                min: '1',
                max: '1440',
                step: '1',
                label: 'Over how many minutes?',
                rules: [
                  value =>
                    (Number.isInteger(Number(value)) &&
                      value >= 1 &&
                      value <= 1440) ||
                    'Use 1–1,440 whole minutes'
                ]
              }),
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
      channel: 'email',
      dailySummary: false,
      dialog: false,
      editing: null,
      form: {name: '', amountUsd: 1000, windowMinutes: 60, enabled: true},
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
        this.state = await pricebotBridge.call('/state')
        if (initial && this.state.preferences) {
          this.channel = this.state.preferences.channel
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
        {channel: this.channel, dailySummary: this.dailySummary},
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
            windowMinutes: alert.window_minutes,
            enabled: alert.enabled
          }
        : {name: '', amountUsd: 1000, windowMinutes: 60, enabled: true}
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
    setup() {
      return this.action(
        '/setup',
        'POST',
        {},
        'Your price collection started. The first sample will arrive on the next minute.'
      )
    }
  }
})
app.use(Quasar, {config: {dark: true, brand: {primary: '#f6a43a'}}})
app.mount('#pricebot')
