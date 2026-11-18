//! Old (chrono-tz 2025b) against new (jiff, tzdata 2026f) bucket keys.

use chrono::{Datelike, NaiveDate};
use marfa_rules::recurrence::{DAY, Zone, civil_from_days, days_from_civil};
use serde_json::Value;

use super::date_bucket;

fn old_date_bucket(value: &Value, bucket: &str, zone: Option<chrono_tz::Tz>) -> Value {
    let Some(text) = value.as_str() else {
        return Value::Null;
    };
    let date = if let Ok(date) = NaiveDate::parse_from_str(text, "%Y-%m-%d") {
        date
    } else {
        let Ok(normalized) = marfa_rules::time::rfc3339(text, "view date") else {
            return Value::Null;
        };
        let Ok(instant) = chrono::DateTime::parse_from_rfc3339(&normalized) else {
            return Value::Null;
        };
        match zone {
            Some(zone) => instant.with_timezone(&zone).date_naive(),
            None => instant.with_timezone(&chrono::Local).date_naive(),
        }
    };
    let date = match bucket {
        "week" => date.checked_sub_signed(chrono::TimeDelta::days(i64::from(
            date.weekday().num_days_from_monday(),
        ))),
        "month" => date.with_day(1),
        "year" => date.with_month(1).and_then(|d| d.with_day(1)),
        _ => Some(date),
    };
    date.map(|date| Value::String(date.format("%Y-%m-%d").to_string()))
        .unwrap_or(Value::Null)
}

const ZONES: [&str; 10] = [
    "Europe/London",
    "America/New_York",
    "Australia/Sydney",
    "Asia/Kolkata",
    "Asia/Kathmandu",
    "Pacific/Chatham",
    "Australia/Lord_Howe",
    "Pacific/Apia",
    "Antarctica/Casey",
    "UTC",
];

const BUCKETS: [&str; 4] = ["day", "week", "month", "year"];

fn text_of(ms: i64, offset_minutes: i64) -> String {
    let wall = ms.div_euclid(1000) + offset_minutes * 60;
    let (y, m, d) = civil_from_days(wall.div_euclid(DAY));
    let second = wall.rem_euclid(DAY);
    let sign = if offset_minutes < 0 { '-' } else { '+' };
    let magnitude = offset_minutes.abs();
    let zone = if offset_minutes == 0 && ms % 2 == 0 {
        "Z".to_string()
    } else {
        format!("{sign}{:02}:{:02}", magnitude / 60, magnitude % 60)
    };
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}{zone}",
        second / 3600,
        second / 60 % 60,
        second % 60,
        ms.rem_euclid(1000)
    )
}

fn ms_of(y: i64, m: i64, d: i64) -> i64 {
    days_from_civil(y, m, d) * DAY * 1000
}

#[derive(Default)]
struct Tally {
    probes: u64,
    after_2099: u64,
    other: Vec<String>,
}

fn run(name: &str) -> Tally {
    let new = Zone::named(name).unwrap();
    let old: chrono_tz::Tz = name.parse().unwrap();
    let tz = jiff::tz::TimeZone::get(name).unwrap();
    let mut corpus: Vec<i64> = Vec::new();
    let hour = 3_600_000;
    let first = ms_of(0, 1, 1);
    let last = ms_of(10_000, 1, 1) - 1;
    for edge in [first, last] {
        for step in -72..=72 {
            let ms = edge + step * hour;
            if (first..=last).contains(&ms) {
                corpus.push(ms);
            }
        }
        corpus.extend([edge - 1, edge, edge + 1]);
    }
    corpus.retain(|ms| (first..=last).contains(ms));
    for transition in tz.following(jiff::Timestamp::MIN) {
        let ms = transition.timestamp().as_millisecond();
        if ms >= ms_of(2110, 1, 1) {
            break;
        }
        for delta in [-DAY * 1000, -1000, 0, 1000, DAY * 1000] {
            corpus.push(ms + delta);
        }
    }
    let mut ms = first;
    let mut n = 0i64;
    while ms <= last {
        corpus.push(ms + (n * 7 % 24) * hour + (n * 13 % 60) * 60_000 + n % 1000);
        ms += DAY * 1000;
        n += 1;
    }
    corpus.retain(|ms| (first..=last).contains(ms));
    let mut tally = Tally::default();
    let check = |text: String, tally: &mut Tally, ms: Option<i64>| {
        for bucket in BUCKETS {
            tally.probes += 1;
            let value = Value::String(text.clone());
            let (a, b) = (
                old_date_bucket(&value, bucket, Some(old)),
                date_bucket(&value, bucket, &new),
            );
            if a != b {
                if ms.is_some_and(|ms| ms >= ms_of(2100, 1, 1)) {
                    tally.after_2099 += 1;
                } else {
                    tally
                        .other
                        .push(format!("{name} {bucket} {text}: old {a} new {b}"));
                }
            }
        }
    };
    for (at, ms) in corpus.iter().enumerate() {
        let offset = [0, 330, -480, 840, -720, 0][at % 6];
        check(text_of(*ms, offset), &mut tally, Some(*ms));
    }
    let mut day = days_from_civil(0, 1, 1);
    while day < days_from_civil(10_000, 1, 1) {
        let (y, m, d) = civil_from_days(day);
        check(format!("{y:04}-{m:02}-{d:02}"), &mut tally, None);
        day += 3;
    }
    tally
}

#[test]
fn bucket_keys_old_against_new() {
    let results: Vec<(&str, Tally)> = std::thread::scope(|scope| {
        let handles: Vec<_> = ZONES
            .iter()
            .map(|name| scope.spawn(move || (*name, run(name))))
            .collect();
        handles.into_iter().map(|h| h.join().unwrap()).collect()
    });
    for (name, tally) in &results {
        eprintln!(
            "bucket {name}: {} probes, {} differ only after 2099, {} other",
            tally.probes,
            tally.after_2099,
            tally.other.len()
        );
        for line in tally.other.iter().take(10) {
            eprintln!("bucket DIFF {line}");
        }
    }
}

#[test]
fn loose_dates_old_against_new() {
    for text in [
        "2026-1-5",
        "+2026-01-05",
        " 2026-01-05",
        "226-01-05",
        "-0001-01-05",
        "2026-01-05 ",
        "2026-01-5",
        "2026-02-30",
        "02026-01-05",
        "2026-01-05T00:00",
    ] {
        let value = Value::String(text.to_string());
        eprintln!(
            "loose {text:?}: old {} new {}",
            old_date_bucket(&value, "day", Some(chrono_tz::UTC)),
            date_bucket(&value, "day", &Zone::UTC)
        );
    }
}
