use crate::{
    history, host,
    input::*,
    lnbits::extension::{host as wit, scheduler, utils_currencies},
    Reply,
};
use serde_json::{json, Value};
use std::collections::BTreeMap;
const CHANNELS: [&str; 3] = ["email", "telegram", "nostr"];
const MAX_ALERTS: usize = 50;
const MAX_ATTEMPTS: usize = 15;
pub fn get_state(_: &Value) -> Reply {
    let now = host::now() as i64;
    let (latest, prior) = history::status(now, true)?;
    Ok(
        json!({"price":latest[1],"observedAt":latest[0],"stale":!fresh(&latest,now),"change24h":(!prior.is_null()).then(||num(&latest[1])-num(&prior[1])),"alerts":alerts()?.into_iter().map(present).collect::<Result<Vec<_>,_>>()?,"preferences":present(prefs()?)?}),
    )
}
pub fn get_history(r: &Value) -> Reply {
    let n = if r["offset"].is_null() || r["offset"] == "" {
        0.
    } else {
        num(&r["offset"])
    };
    if !n.is_finite() || n.fract() != 0. || n < 0. || n > u32::MAX as f64 {
        return Err("Invalid history offset.".into());
    }
    history::chart(
        r["range"]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or("1D"),
        host::now() as i64,
        n as u32,
    )
}
pub fn collect_prices(_: &Value) -> Reply {
    let raw = utils_currencies::rate(&utils_currencies::RateRequest {
        currency: "USD".into(),
    })
    .price;
    let price = cents(raw);
    if !price.is_finite() || price <= 0. {
        return Err("Core returned an invalid BTC price.".into());
    }
    history::collect(price, host::now() as i64 / 60 * 60)
}
pub fn save_preferences(r: &Value) -> Reply {
    let channels = validate_channels(&r["channels"])?;
    let daily = r["dailySummary"] == true;
    let old = prefs()?;
    let job = ensure_job("daily-summary", daily)?;
    let value = json!({"id":old.get("id").unwrap_or(&job["id"]),"channels_json":channels.to_string(),"daily_summary":daily});
    host::set("preferences", &value)?;
    Ok(json!({"preferences":present(value)?}))
}
pub fn save_alert(r: &Value) -> Reply {
    let name = s(&r["name"]).trim();
    if name.is_empty() || name.encode_utf16().count() > 80 {
        return Err("Enter an alert name of 1–80 characters.".into());
    }
    let amount = num(&r["amountUsd"]);
    if !amount.is_finite() || amount <= 0. || amount > 1e9 {
        return Err("Price variation must be a positive USD amount, up to one billion.".into());
    }
    let count = num(&r["windowCount"]);
    let unit = s(&r["windowUnit"]);
    let width = unit_seconds(unit);
    if width == 0
        || count.fract() != 0.
        || count < if unit == "minute" { 10. } else { 1. }
        || count * (width as f64) > 9007199254740991.
    {
        return Err(
            "Use a whole interval: at least 10 minutes, or 1 hour, day, week, or month.".into(),
        );
    }
    if r.get("enabled").is_some_and(|v| !v.is_boolean()) {
        return Err("Enabled must be true or false.".into());
    }
    let channels = validate_channels(&r["channels"])?;
    let key = s(&r["alertId"]);
    let old = if key.is_empty() {
        Value::Null
    } else {
        let v = host::get("alerts", key)?;
        if v.is_null() {
            return Err("Alert not found.".into());
        }
        v
    };
    if old.is_null() && host::page("alerts", json!({"limit":1}))?.total >= MAX_ALERTS as u64 {
        return Err("You can configure up to 50 alerts.".into());
    }
    ensure_job("check-alerts", true)?;
    let id = if old.is_null() {
        host::id("alert")
    } else {
        key.to_owned()
    };
    let row = json!({"id":id,"name":name,"amount_usd":amount,"window_count":count as i64,"window_unit":unit,"enabled":r["enabled"]!=false,"channels_json":channels.to_string()});
    host::set("alerts", &row)?;
    if !old.is_null()
        && (["enabled", "window_unit", "channels_json"]
            .iter()
            .any(|k| old[k] != row[k])
            || num(&old["amount_usd"]) != amount
            || i(&old["window_count"]) != count as i64)
    {
        host::delete("state", &format!("alert:{id}"))?;
    }
    Ok(json!({"alert":present(row)?}))
}
pub fn delete_alert(r: &Value) -> Reply {
    let id = s(&r["alertId"]);
    if id.is_empty() || host::get("alerts", id)?.is_null() {
        return Err("Alert not found.".into());
    }
    host::delete("alerts", id)?;
    host::delete("state", &format!("alert:{id}"))?;
    Ok(json!({"deleted":true}))
}
pub fn daily_summary(_: &Value) -> Reply {
    let prefs = prefs()?;
    if prefs["daily_summary"] != true {
        return Ok(json!({"queued":0}));
    }
    let now = host::now() as i64;
    let (latest, prior) = history::status(now, true)?;
    if !fresh(&latest, now) || prior.is_null() {
        return Ok(json!({"queued":0,"waitingForHistory":true}));
    }
    let iso = history::iso(now);
    let day = &iso[..10];
    let id = format!("summary:{}", s(&prefs["id"]));
    let row = host::get("state", &id)?;
    let mut state = if row.is_null() {
        Value::Null
    } else {
        parsed(&row["value_json"])?
    };
    if state["day"] != day {
        state = json!({"day":day,"sent":[]});
    }
    let price = num(&latest[1]);
    let change = price - num(&prior[1]);
    let percent = change / num(&prior[1]) * 100.;
    let message=format!("Pricebot daily summary: BTC \u{24}{price:.2} USD. 24-hour change: {}\u{24}{:.2} ({percent:+.2}%).",if change>=0.{"+"}else{"-"},change.abs());
    let channels = parsed(&prefs["channels_json"])?;
    let count = send(&channels, &mut state, &message, usize::MAX)?;
    if count.queued > 0 {
        write_state(&id, &state)?;
    }
    if count.failed {
        return Err("Some daily summary notifications could not be queued.".into());
    }
    Ok(json!({"queued":count.queued}))
}
pub fn check_alerts(_: &Value) -> Reply {
    log(json!({"phase":"invoked"}));
    let mut active = Vec::new();
    for alert in alerts()? {
        if alert["enabled"] == true {
            active.push(alert);
        } else {
            log_alert(
                &alert,
                json!({"checkDue":false,"checkReason":"alert_disabled","notify":false,"notifyReason":"alert_disabled"}),
            );
        }
    }
    if active.is_empty() {
        log(
            json!({"phase":"completed","checkDue":false,"checkReason":"no_enabled_alerts","notify":false,"queued":0}),
        );
        return Ok(json!({"queued":0}));
    }
    let now = host::now() as i64;
    let (latest, _) = history::status(now, false)?;
    if !fresh(&latest, now) {
        let reason = if latest.is_null() {
            "missing_price_history"
        } else {
            "latest_price_older_than_two_minutes"
        };
        for alert in &active {
            log_alert(
                alert,
                json!({"checkDue":false,"checkReason":reason,"observedAt":latest[0],"priceAgeSeconds":(!latest.is_null()).then(||now-i(&latest[0])),"notify":false,"notifyReason":reason}),
            );
        }
        log(json!({"phase":"completed","queued":0,"waitingForHistory":true}));
        return Ok(json!({"queued":0,"waitingForHistory":true}));
    }
    let intervals = active.iter().map(interval).collect::<Vec<_>>();
    let ranges = history::ranges(now, &intervals)?;
    let state_rows = host::page("state", json!({"limit":MAX_ALERTS+1}))?;
    let mut states = BTreeMap::new();
    for row in state_rows.rows {
        states.insert(s(&row["id"]).to_owned(), parsed(&row["value_json"])?);
    }
    active.sort_by_key(|a| {
        states
            .get(&state_id(a))
            .map_or(0, |state| i(&state["attemptedAt"]))
    });
    let mut remaining = MAX_ATTEMPTS;
    let mut queued = 0;
    let mut failed = false;
    let mut pending = 0;
    for alert in active {
        let id = state_id(&alert);
        let seconds = interval(&alert);
        let price = num(&latest[1]);
        let amount = num(&alert["amount_usd"]);
        let channels = parsed(&alert["channels_json"])?;
        let rule = format!(
            "{}:{}:{}:{}",
            amount,
            i(&alert["window_count"]),
            s(&alert["window_unit"]),
            s(&alert["channels_json"])
        );
        let mut state = states
            .remove(&id)
            .filter(|v| v["rule"] == rule)
            .unwrap_or_else(|| json!({"rule":rule,"triggered":false,"sent":[]}));
        let count = channels.as_array().ok_or("Invalid alert channels.")?.len();
        let sent = state["sent"].as_array().map_or(0, Vec::len);
        let waiting = state["triggered"] == true && sent < count;
        let last = state["lastNotifiedAt"].as_i64().or_else(|| {
            if sent > 0 {
                state["attemptedAt"]
                    .as_i64()
                    .or_else(|| state["event"][0].as_i64())
            } else {
                None
            }
        });
        let next = last.map(|n| n.saturating_add(seconds));
        let due = next.is_none_or(|n| now >= n);
        let range = ranges.get(&seconds);
        let diff = range.map(|&(lo, hi)| fluctuation(price, lo, hi));
        let reason = if waiting {
            "pending_channel_retry"
        } else if !due {
            "notification_interval_not_elapsed"
        } else if last.is_none() {
            "never_notified"
        } else {
            "notification_interval_elapsed"
        };
        let mut decision = json!({"checkDue":waiting||due,"checkReason":reason,"lastNotifiedAt":last,"nextEligibleAt":next,"cooldownRemainingSeconds":(next.unwrap_or(now)-now).max(0),
            "windowStart":now-seconds,"windowEnd":now,"currentPriceUsd":price,"observedAt":latest[0],"lowUsd":range.map(|r|r.0),"highUsd":range.map(|r|r.1),"differenceUsd":diff});
        let skip = if !waiting && !due {
            Some("notification_interval_not_elapsed")
        } else if !waiting && range.is_none() {
            Some("no_prices_in_window")
        } else if !waiting && diff.is_some_and(|d| d < amount) {
            Some("below_threshold")
        } else {
            None
        };
        if let Some(reason) = skip {
            merge(&mut decision, json!({"notify":false,"notifyReason":reason}));
            log_alert(&alert, decision);
            continue;
        }
        if !waiting {
            let &(lo, hi) = range.ok_or("No prices in window.")?;
            merge(
                &mut state,
                json!({"triggered":true,"sent":[],"event":[now,lo,hi,price]}),
            );
        }
        let event = &state["event"];
        let t = i(&event[0]);
        let (lo, hi, price) = (num(&event[1]), num(&event[2]), num(&event[3]));
        let diff = fluctuation(price, lo, hi);
        merge(
            &mut decision,
            json!({"notify":remaining>0,"notifyReason":if remaining==0{"notification_attempt_limit_reached"}else if waiting{"retry_pending_channels"}else{"threshold_reached"},
            "remainingAttempts":remaining,"sentChannels":state["sent"],"pendingChannels":unsent(&channels,&state),"eventAt":t,"eventLowUsd":lo,"eventHighUsd":hi,"eventPriceUsd":price,"eventDifferenceUsd":diff}),
        );
        log_alert(&alert, decision);
        let count_units = i(&alert["window_count"]);
        let unit = s(&alert["window_unit"]);
        let plural = if count_units == 1 { "" } else { "s" };
        let name = s(&alert["name"]);
        let message=format!("Pricebot · {name}: BTC fluctuated by \u{24}{diff:.2} within the last {count_units} {unit}{plural}. Low: \u{24}{lo:.2}; high: \u{24}{hi:.2}. Current price: \u{24}{price:.2} USD. Observed at {}.",history::iso(t));
        let delivery = send(&channels, &mut state, &message, remaining)?;
        let missed = unsent(&channels, &state);
        state["lastNotifiedAt"] = json!(if delivery.queued > 0 { Some(now) } else { last });
        if delivery.attempts > 0 {
            log_alert(
                &alert,
                json!({"phase":"notification_result","queued":delivery.queued,"failed":delivery.failed,"attempts":delivery.attempts,"lastNotifiedAt":state["lastNotifiedAt"],"sentChannels":state["sent"],"pendingChannels":missed}),
            );
            state["attemptedAt"] = json!(now);
        }
        remaining -= delivery.attempts;
        pending += missed.len();
        queued += delivery.queued;
        failed |= delivery.failed;
        state["triggered"] = json!(!missed.is_empty());
        if delivery.attempts > 0 || !waiting {
            write_state(&id, &state)?;
        }
    }
    log(json!({"phase":"completed","queued":queued,"pending":pending,"failed":failed}));
    if failed {
        return Err("Some notifications could not be queued. Unsent channels will be retried on the next check.".into());
    }
    Ok(json!({"queued":queued,"pending":pending}))
}
fn alerts() -> Result<Vec<Value>, String> {
    Ok(host::page("alerts", json!({"limit":MAX_ALERTS,"sortBy":"name"}))?.rows)
}
fn prefs() -> Reply {
    Ok(host::page("preferences", json!({"limit":1}))?
        .rows
        .into_iter()
        .next()
        .unwrap_or(Value::Null))
}
fn present(mut r: Value) -> Reply {
    if !r.is_null() {
        r["channels"] = parsed(&r["channels_json"])?;
        if let Some(obj) = r.as_object_mut() {
            obj.remove("channels_json");
        }
    }
    Ok(r)
}
fn ensure_job(handler: &str, enabled: bool) -> Reply {
    let cron = if handler == "daily-summary" {
        "0 9 * * *"
    } else {
        "*/10 * * * *"
    };
    let rows = scheduler::list_schedules(&scheduler::ListRequest {
        scope: "user".into(),
        limit: 100,
        offset: 0,
    });
    let rows: Vec<Value> =
        serde_json::from_str(&rows.schedules_json).map_err(|_| "Invalid schedule list.")?;
    let job = rows.iter().find(|j| j["handler"] == handler);
    if let Some(j) = job.filter(|j| {
        j["enabled"] == enabled && j["cron_expression"] == cron && j["timezone"] == "UTC"
    }) {
        return Ok(j.clone());
    }
    let r = scheduler::set_schedule(&scheduler::SetRequest {
        id: job.and_then(|j| j["id"].as_str()).map(String::from),
        handler: handler.into(),
        cron_expression: cron.into(),
        timezone: "UTC".into(),
        payload_json: "{}".into(),
        enabled,
        scope: "user".into(),
    });
    serde_json::from_str(&r.schedule_json).map_err(|_| "Invalid returned schedule.".into())
}
fn validate_channels(v: &Value) -> Reply {
    let list = v
        .as_array()
        .filter(|c| !c.is_empty() && c.iter().all(|v| CHANNELS.contains(&s(v))))
        .ok_or("Choose at least one channel: email, Telegram, or Nostr.")?;
    Ok(json!(CHANNELS
        .iter()
        .filter(|&&c| list.iter().any(|v| v == c))
        .collect::<Vec<_>>()))
}
fn unit_seconds(unit: &str) -> i64 {
    match unit {
        "minute" => 60,
        "hour" => 3600,
        "day" => history::DAY,
        "week" => 7 * history::DAY,
        "month" => 30 * history::DAY,
        _ => 0,
    }
}
fn interval(a: &Value) -> i64 {
    i(&a["window_count"]).saturating_mul(unit_seconds(s(&a["window_unit"])))
}
fn state_id(a: &Value) -> String {
    format!("alert:{}", s(&a["id"]))
}
fn write_state(id: &str, state: &Value) -> Result<(), String> {
    host::set("state", &json!({"id":id,"value_json":state.to_string()}))
}
fn log(v: Value) {
    host::log(&format!("check-alerts {v}"), "info");
}
fn log_alert(a: &Value, v: Value) {
    let mut data = json!({"alertId":a["id"],"windowCount":a["window_count"],"windowUnit":a["window_unit"],"thresholdUsd":a["amount_usd"]});
    merge(&mut data, v);
    log(data);
}
fn fresh(latest: &Value, now: i64) -> bool {
    !latest.is_null() && (0..=120).contains(&(now - i(&latest[0])))
}
fn cents(x: f64) -> f64 {
    (x * 100.).round() / 100.
}
fn fluctuation(price: f64, low: f64, high: f64) -> f64 {
    cents((price - low).abs().max((price - high).abs()))
}
fn unsent<'a>(channels: &'a Value, state: &Value) -> Vec<&'a Value> {
    channels
        .as_array()
        .into_iter()
        .flatten()
        .filter(|c| {
            !state["sent"]
                .as_array()
                .is_some_and(|sent| sent.contains(c))
        })
        .collect()
}
struct Delivery {
    attempts: usize,
    queued: usize,
    failed: bool,
}
fn send(
    channels: &Value,
    state: &mut Value,
    message: &str,
    limit: usize,
) -> Result<Delivery, String> {
    let mut result = Delivery {
        attempts: 0,
        queued: 0,
        failed: false,
    };
    for channel in unsent(channels, state).into_iter().take(limit) {
        result.attempts += 1;
        let response = wit::notifications_send_user_notification(&wit::NotificationRequest {
            type_: s(channel).into(),
            message: message.into(),
        });
        if response.queued {
            state["sent"]
                .as_array_mut()
                .ok_or("Invalid notification receipt.")?
                .push(channel.clone());
            result.queued += 1;
        } else {
            result.failed = true;
        }
    }
    Ok(result)
}
