# Pricebot

A WASM LNbits extension with one BTC/USD price history for the entire instance,
private user alerts, and optional daily summaries. Prices use LNbits' configured
exchange-rate providers and cache, rounded to USD cents. No external price provider is needed.

## Collection and history

The collector runs once per minute for the instance, beginning on
extension activation without a user visiting the UI. Ordinary users have no
start/stop controls. Every user reads the same history; alert and notification
settings remain private.

| Resolution     | Retention     |
| -------------- | ------------- |
| Minute         | Last 24 hours |
| Hour           | Last 7 days   |
| Day            | Last 366 days |
| Calendar month | Forever       |

A sample exactly on a retention boundary is retained. Each aggregate keeps its
open, high, low, close, observation count, and the timestamps of its extrema.
Hour/day/month boundaries use UTC. The collector prunes the shorter resolutions
on each successful observation; monthly data is stored in calendar-year chunks.
Collection downtime leaves gaps. Data is not fabricated or backfilled.

The chart below the current price offers 1D, 1W, 1M, 1Y, and All. Its line follows
closing prices and shading shows the recorded low/high range. Dense data is
reduced for display while preserving extrema; stored minute observations remain
complete. Hover, touch, or keyboard inspection shows prices and timestamps.
Longer chart ranges use the retained coarser resolutions. A fresh database shows
only observations collected since activation.

## Alerts

Create, edit, disable/enable, or delete up to 50 private alerts. Each includes:

- A name (1–80 characters).
- A positive USD fluctuation threshold.
- A whole-number interval in minutes (at least 10), hours, days, weeks, or months.
  Alert months mean 30 days; stored monthly aggregates use calendar months.
- One or more notification channels: email, Telegram, Nostr.

An alert compares the latest fresh price with the recorded low and high within
its rolling window: `max(abs(current - low), abs(current - high))`, rounded to USD
cents. It triggers when that difference reaches the threshold and at least the
configured interval has elapsed since its last successfully queued notification.
A new alert can trigger on its first check; a complete window is not required.
Missing observations are never invented, and checks skip when the newest price
is more than two minutes old.

The interval is both the lookback window and the notification cooldown. For a
10-minute alert, a notification queued at 12:00 allows the next evaluation at
12:10. If the threshold is not met, checks continue every 10 minutes until it is;
an unsuccessful check does not restart the cooldown. There is no requirement for
the difference to drop below the threshold between notifications.

Changing the threshold, interval, channels, or enabled state starts a fresh rule
evaluation; renaming alone does not send a duplicate. Successful channel receipts
are kept if another channel fails, so the next check retries only unsent channels
for the original event, even during the cooldown. Each successful queue operation
updates the cooldown timestamp; a failed attempt does not. Older receipts without
that timestamp use their last recorded attempt time, or their event time if no
attempt time was saved, for the initial cooldown. Notification bursts are drained
over successive checks every 10 minutes (up to 15 channel attempts per check).
This respects WASM limits. Pending channels retain the original event and timestamp
even if its window clears before delivery.

Windows up to one day use minute observations; up to seven days use hourly
extrema, up to 366 days use daily extrema, and longer windows use monthly extrema.
An older aggregate straddling the start of a window cannot reveal every interior
price after its finer history expires. To avoid a false notification from an
expired peak, only its timestamped open/close/extrema inside the window count
toward triggering. This can delay triggering for a partial older bucket.

Configure notification destinations in the user's LNbits account. Pricebot uses
the saved settings for each selected channel. A queued message does not guarantee
delivery. A process failure between queuing and saving a receipt can cause a
repeat; the host does not offer an atomic notification-and-storage transaction.

## User jobs and daily summary

Saving an alert creates or updates the user's `check-alerts` job
(`*/10 * * * *`, UTC), at minutes 00, 10, 20, 30, 40, and 50 of each hour.
Saving summary preferences creates or updates `daily-summary` (`0 9 * * *`, UTC).
Existing matching jobs are reused without postponing their next run. These user
jobs never collect prices. The optional summary includes the current price and
24-hour change, requires a full-day baseline, and queues once per selected
channel per UTC day during normal operation.

After upgrading, approve the updated `scheduler.user` policy, then save an
existing alert once to update its old one-minute job to the new cadence.

Disabling the extension for a user stops that user's jobs through the host's
access checks. The instance collector belongs to the extension, independent of
any account. Global extension deactivation prevents its scheduled work.

## Storage and host interfaces

The fresh schema creates `history`, `preferences`, `alerts`, and `state` inside
the extension database. No legacy-data conversion is provided.

The collector writes through current owner-scoped storage methods using a dedicated
extension owner. Users read only `history` through `storage.get_public` and
`storage.get_public_paginated`, with an explicit field/source policy. Private
alerts and notification state are not public. No deprecated shared-storage import
or invented shared-storage permission is used.

LNbits creates the approved `collect-prices` instance schedule on activation
and restores it on server startup. The first observation is collected at the
next minute boundary. Restarts reuse the same job without postponing it or
overriding an administrator's pause. The collector uses an extension storage
owner and does not depend on any user's account or browser session.

## Development

Use Node.js 22 or newer and the existing pinned `@bytecodealliance/jco` toolchain.

```sh
make check
make build
```

`make check` covers history retention, UTC boundaries, partial-write recovery,
shared reads with isolated alerts, rolling fluctuations, channel retries, and
input validation. `make build` compiles the guest into `wasm/module.wasm` using
the WIT contract. Browser files use Vue render functions and native SVG, without
runtime template compilation or an additional chart dependency.

Install through LNbits' installation flow to apply the fresh schema and approve
the manifest permissions, including `scheduler.extension`. This requires LNbits
with automatic WASM schedules and extension-owned schedule storage. A symlink
alone does not install storage migrations, approve permissions, or start jobs.

## GitHub Actions

CI runs `make check` and `make build` with Node.js 22 on branch pushes and pull
requests. No npm install step is needed; the build uses the pinned JCO command.

To release, update `config.json`'s version, run `make check` and `make build`, and
commit the rebuilt `wasm/module.wasm` before pushing a matching `vX.Y.Z` tag.
The release workflow validates the committed metadata and WASM, reruns the checks
and build, creates a GitHub release, and opens a pull request against
`lnbits/lnbits-extensions-wasm`. The registry installs the tagged source archive,
so the rebuilt WASM must be committed before tagging.

Configure the `EXT_GITHUB` Actions secret with access to push branches and open
pull requests in `lnbits/lnbits-extensions-wasm`. The release itself uses the
automatic `GITHUB_TOKEN` with `contents: write` permission.
