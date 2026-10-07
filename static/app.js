const app = Vue.createApp({
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
        'Shared price collection started. The first sample will arrive on the next minute.'
      )
    }
  }
})
app.use(Quasar, {config: {dark: true, brand: {primary: '#f6a43a'}}})
app.mount('#pricebot')
