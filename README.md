# Pricebot

A WASM LNbits extension for BTC/USD price alerts and optional daily summaries.
Prices come from LNbits core and use its configured providers and exchange-rate
cache. Users share one price history; their alert settings and notification state
remain private.

## Scheduled jobs

The administrator approves these exact schedules during installation. Opening the
extension does not start jobs automatically.

| Handler          | Scope              | Cron        | Timezone |
| ---------------- | ------------------ | ----------- | -------- |
| `collect-prices` | Shared             | `* * * * *` | UTC      |
| `prune-history`  | Shared             | `5 0 * * *` | UTC      |
| `check-alerts`   | Per user           | `* * * * *` | UTC      |
| `daily-summary`  | Per user, optional | `0 9 * * *` | UTC      |

An administrator opens **Instance administration → Start / resume shared jobs**
once to start collection. Saving notification settings creates the user's two
jobs; the summary job is paused unless enabled. Each handler has only one job per
owner. Repeated setup and settings changes reuse those jobs.

Disabling Pricebot for a user stops that user's scheduled work through core's
access checks. Other users and shared jobs continue. Re-enabling resumes eligible
jobs; a manually paused schedule stays paused until explicitly enabled.

## Alerts and history

- Configure up to 50 alerts with a USD threshold and a window of 1–1,440 minutes.
- Each check compares the latest price with the last sample at or before the
  start of that window. Both upward and downward changes count.
- Notify when the absolute movement reaches or exceeds the threshold. Send no
  additional notification while it stays above the threshold; rearm below it.
- Changing the threshold or window starts a new rule evaluation.
- Skip checks when the latest observation is over two minutes old or the baseline
  is missing/more than two minutes earlier than the requested window.
- The collector stores one observation per minute, grouped into hourly records.
- Daily pruning removes observations older than 48 hours. Between daily cleanups,
  the database can contain up to about 72 hours of history.
- Daily summaries include the current price and absolute/percentage 24-hour
  change. They wait for sufficient history and queue at most once per UTC day
  during normal operation.

Core caches exchange rates (60 seconds by default). Samples record the time
Pricebot observed core's rate, not an exchange-provided trade timestamp. A check
that runs before the collector may use the previous minute's observation.

Choose email, Nostr, or Telegram and configure the destination in the user's
LNbits account notification settings. Notifications use core's queue; successful
queuing does not guarantee delivery. As with other recovering scheduled jobs,
a process failure between queuing and saving state can cause a repeated alert.

## Core requirements

This extension requires the core WASM scheduler with administrator-approved
handler policies and one schedule ID per handler/owner, plus the
`storage.shared.get`, `storage.shared.set`, `storage.shared.get_paginated`, and
`storage.shared.delete` host methods. Shared storage grants are restricted to the
`prices` table. Only an administrator or a shared scheduled callback may write it;
user invocations may read it. No external HTTP permission is required.

The extension's storage migration creates its own `prices`, `preferences`,
`alerts`, and `state` tables. It does not add core database tables.

## Development

Use Node.js 22 or newer and the LNbits WASM toolchain (`@bytecodealliance/jco`).
The checked-in component is built from the JavaScript sources, adapter, and WIT
contract in this repository.

```sh
make check
make build
```

`make check` runs JavaScript syntax checks and unit tests for alerts, summaries,
job reuse, stale/missing data, notification failures, and retention.
`make build` bundles the two source modules and compiles `wasm/module.wasm`.

Install through LNbits' extension installation flow to apply storage migrations
and approve the manifest permissions. A filesystem symlink by itself does not
install the extension, approve permissions, or create its jobs.
