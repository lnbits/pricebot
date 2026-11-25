use crate::{host, input::*, Reply};
use serde_json::{json, Value};
use std::collections::BTreeMap;
pub const DAY: i64 = 86400;
const HOUR: i64 = 3600;
const SERIES: &str = "btc-usd";
const TABLE: &str = "history";
const RES: [&str; 4] = ["minute", "hour", "day", "month"];
pub fn iso(t: i64) -> String {
    let (y, m, d) = civil(t);
    let sec = t.rem_euclid(DAY);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.000Z",
        sec / 3600,
        sec / 60 % 60,
        sec % 60
    )
}
fn civil(t: i64) -> (i64, i64, i64) {
    let days = t.div_euclid(DAY) + 719468;
    let era = days.div_euclid(146097);
    let d = days - era * 146097;
    let y = (d - d / 1460 + d / 36524 - d / 146096) / 365;
    let doy = d - (365 * y + y / 4 - y / 100);
    let mp = (5 * doy + 2) / 153;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    (
        era * 400 + y + i64::from(month <= 2),
        month,
        doy - (153 * mp + 2) / 5 + 1,
    )
}
fn month_start(t: i64, year_only: bool) -> i64 {
    let (y, m, _) = civil(t);
    let m = if year_only { 1 } else { m };
    let y = y - i64::from(m <= 2);
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = if m > 2 { m - 3 } else { m + 9 };
    (era * 146097 + 365 * yoe + yoe / 4 - yoe / 100 + (153 * mp + 2) / 5 - 719468) * DAY
}
fn chunk(t: i64, res: &str) -> i64 {
    match res {
        "minute" => t.div_euclid(HOUR) * HOUR,
        "hour" => t.div_euclid(DAY) * DAY,
        "day" => month_start(t, false),
        _ => month_start(t, true),
    }
}
fn key(res: &str, time: i64) -> String {
    format!("{SERIES}:{res}:{}", chunk(time, res))
}
fn values(row: &Value) -> Reply {
    if row.is_null() {
        Ok(Value::Null)
    } else {
        parsed(&row["buckets_json"])
    }
}
fn write(res: &str, id: &str, start: i64, rows: &Value) -> Result<(), String> {
    host::set(
        TABLE,
        &json!({"id":id,"series":SERIES,"resolution":res,"start":start,"buckets_json":rows.to_string()}),
    )
}
pub fn collect(price: f64, t: i64) -> Reply {
    let pending = values(&host::get(TABLE, "btc-usd:pending")?)?;
    if !pending.is_null() {
        let prior = i(&pending[0]);
        if prior > t {
            return Err("The collector clock moved backwards.".into());
        }
        apply(prior, num(&pending[1]))?;
        host::delete(TABLE, "btc-usd:pending")?;
    }
    let latest = values(&host::get(TABLE, "btc-usd:latest")?)?;
    if !latest.is_null() {
        let last = i(&latest[0]);
        if last > t {
            return Err("The collector clock moved backwards.".into());
        }
        if last == t {
            return Ok(json!({"collected":false,"price":latest[1],"timestamp":t}));
        }
    }
    write("pending", "btc-usd:pending", t, &json!([t, price]))?;
    apply(t, price)?;
    host::delete(TABLE, "btc-usd:pending")?;
    Ok(json!({"collected":true,"price":price,"timestamp":t}))
}
fn apply(t: i64, price: f64) -> Result<(), String> {
    for res in RES {
        let id = key(res, t);
        let data = values(&host::get(TABLE, &id)?)?;
        let mut rows = match data {
            Value::Array(a) => a,
            Value::Null => Vec::new(),
            _ => return Err("Invalid history chunk.".into()),
        };
        let idx = if res == "minute" { 0 } else { 6 };
        if rows.last().is_some_and(|r| i(&r[idx]) >= t) {
            continue;
        }
        if res == "minute" {
            rows.push(json!([t, price]));
        } else {
            let start = match res {
                "hour" => t.div_euclid(HOUR) * HOUR,
                "day" => t.div_euclid(DAY) * DAY,
                _ => month_start(t, false),
            };
            if let Some(last) = rows.last_mut().filter(|r| i(&r[0]) == start) {
                if price > num(&last[2]) {
                    last[2] = json!(price);
                    last[7] = json!(t);
                }
                if price < num(&last[3]) {
                    last[3] = json!(price);
                    last[8] = json!(t);
                }
                last[4] = json!(price);
                last[6] = json!(t);
                last[9] = json!(i(&last[9]) + 1);
            } else {
                rows.push(json!([start, price, price, price, price, t, t, t, t, 1]));
            }
        }
        write(res, &id, chunk(t, res), &Value::Array(rows))?;
    }
    for (res, retention, idx) in [
        ("minute", DAY, 0),
        ("hour", 7 * DAY, 6),
        ("day", 366 * DAY, 6),
    ] {
        let cutoff = t - retention;
        let p = host::page(
            TABLE,
            json!({"filters":{"resolution":res},"sortBy":"start","limit":30}),
        )?;
        for row in p.rows {
            let start = i(&row["start"]);
            if start >= cutoff {
                break;
            }
            let data = values(&row)?;
            let rows = data.as_array().ok_or("Invalid history chunk.")?;
            let first = rows.partition_point(|r| i(&r[idx]) < cutoff);
            if first == rows.len() {
                host::delete(TABLE, s(&row["id"]))?;
            } else {
                if first > 0 {
                    write(res, s(&row["id"]), start, &json!(&rows[first..]))?;
                }
                break;
            }
        }
    }
    write("latest", "btc-usd:latest", t, &json!([t, price]))
}
pub fn status(now: i64, baseline: bool) -> Result<(Value, Value), String> {
    let latest = values(&host::get_public(TABLE, "btc-usd:latest")?)?;
    if latest.is_null() || i(&latest[0]) > now {
        return Ok((Value::Null, Value::Null));
    }
    let mut prior = Value::Null;
    if baseline {
        let target = i(&latest[0]) - DAY;
        let p = values(&host::get_public(TABLE, &key("minute", target))?)?;
        if let Some(row) = p
            .as_array()
            .and_then(|a| a.iter().rev().find(|r| i(&r[0]) <= target))
            .filter(|r| target - i(&r[0]) <= 120)
        {
            prior = row.clone();
        }
    }
    Ok((latest, prior))
}
pub fn chart(range: &str, now: i64, offset: u32) -> Reply {
    let (res, duration) = match range {
        "1D" => ("minute", DAY),
        "1W" => ("hour", 7 * DAY),
        "1M" => ("day", 30 * DAY),
        "1Y" => ("day", 366 * DAY),
        "ALL" => ("month", 0),
        _ => return Err("Choose 1D, 1W, 1M, 1Y, or ALL.".into()),
    };
    let since = if duration == 0 { 0 } else { now - duration };
    let p = public_chunks(res, 4, offset)?;
    let next = u64::from(offset) + p.rows.len() as u64;
    Ok(
        json!({"range":range,"resolution":res,"since":since,"until":now,"chunks":p.rows.iter().map(|r|&r["buckets_json"]).collect::<Vec<_>>(),"nextOffset":(next<p.total&&p.rows.last().is_some_and(|r|i(&r["start"])>=since)).then_some(next)}),
    )
}
fn public_chunks(res: &str, limit: u32, offset: u32) -> Result<host::Page, String> {
    host::public_page(
        TABLE,
        SERIES,
        json!({"filters":{"resolution":res},"sortBy":"start","descending":true,"limit":limit,"offset":offset}),
    )
}
pub fn ranges(now: i64, intervals: &[i64]) -> Result<BTreeMap<i64, (f64, f64)>, String> {
    let mut result = BTreeMap::new();
    for res in RES {
        let mut windows = intervals
            .iter()
            .copied()
            .filter(|&w| resolution(w) == res)
            .collect::<Vec<_>>();
        windows.sort_unstable();
        windows.dedup();
        let Some(max) = windows.last() else { continue };
        let since = now - max;
        let mut offset = 0;
        let mut extremes = vec![(f64::INFINITY, f64::NEG_INFINITY); windows.len()];
        loop {
            let p = public_chunks(res, 100, offset)?;
            for row in &p.rows {
                let data = values(row)?;
                for b in data.as_array().into_iter().flatten() {
                    include_bucket(&mut extremes, &windows, now, res, b);
                }
            }
            offset += p.rows.len() as u32;
            if u64::from(offset) >= p.total || p.rows.last().is_none_or(|r| i(&r["start"]) < since)
            {
                break;
            }
        }
        let (mut low, mut high) = (f64::INFINITY, f64::NEG_INFINITY);
        for (w, (lo, hi)) in windows.into_iter().zip(extremes) {
            low = low.min(lo);
            high = high.max(hi);
            if low.is_finite() {
                result.insert(w, (low, high));
            }
        }
    }
    Ok(result)
}
fn resolution(w: i64) -> &'static str {
    if w <= DAY {
        "minute"
    } else if w <= 7 * DAY {
        "hour"
    } else if w <= 366 * DAY {
        "day"
    } else {
        "month"
    }
}
fn include_bucket(extremes: &mut [(f64, f64)], windows: &[i64], now: i64, res: &str, b: &Value) {
    let mut include = |t: i64, lo: f64, hi: f64| {
        if t <= now {
            let index = windows.partition_point(|&w| w < now - t);
            if let Some(pair) = extremes.get_mut(index) {
                pair.0 = pair.0.min(lo);
                pair.1 = pair.1.max(hi);
            }
        }
    };
    if res == "minute" {
        include(i(&b[0]), num(&b[1]), num(&b[1]));
        return;
    }
    // Each stored extremum carries the time it occurred. An expired extremum
    // cannot trigger an alert when only part of the bucket lies in the window.
    for (t, p) in [(5, 1), (6, 4), (7, 2), (8, 3)] {
        include(i(&b[t]), num(&b[p]), num(&b[p]));
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn partial_bucket_excludes_expired_high() {
        let mut extremes = [(f64::INFINITY, f64::NEG_INFINITY)];
        include_bucket(
            &mut extremes,
            &[2 * DAY - 600],
            2 * DAY,
            "hour",
            &json!([0, 150000, 150000, 100000, 100000, 0, 1800, 0, 1800, 2]),
        );
        assert_eq!(extremes, [(100000., 100000.)]);
    }
}
