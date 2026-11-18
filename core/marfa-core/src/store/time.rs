//! The clock and the RFC 3339 times the store reads and writes.

/// Nanoseconds since the epoch, from an RFC 3339 time with any fraction of a
/// second and a `Z` or numeric offset. `None` for anything else.
pub fn instant_of(stamp: &str) -> Option<i128> {
    let bytes = stamp.as_bytes();
    if bytes.len() < 20
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || !matches!(bytes[10], b'T' | b't')
        || bytes[13] != b':'
        || bytes[16] != b':'
    {
        return None;
    }
    let number = |from: usize, to: usize| -> Option<i64> {
        let digits = stamp.get(from..to)?;
        if !digits.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        digits.parse().ok()
    };
    let (year, month, day) = (number(0, 4)?, number(5, 7)?, number(8, 10)?);
    let (hour, minute, second) = (number(11, 13)?, number(14, 16)?, number(17, 19)?);
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 60
    {
        return None;
    }
    let mut at = 19;
    let mut nanos: i128 = 0;
    if bytes.get(at) == Some(&b'.') {
        at += 1;
        let start = at;
        while bytes.get(at).is_some_and(u8::is_ascii_digit) {
            at += 1;
        }
        let digits = stamp.get(start..at)?;
        if digits.is_empty() {
            return None;
        }
        let kept = &digits[..digits.len().min(9)];
        nanos = kept.parse::<i128>().ok()? * 10_i128.pow(9 - kept.len() as u32);
    }
    let offset: i64 = match stamp.get(at..)? {
        "Z" | "z" => 0,
        zone if zone.len() == 6
            && matches!(zone.as_bytes()[0], b'+' | b'-')
            && zone.as_bytes()[3] == b':' =>
        {
            let hours = number(at + 1, at + 3)?;
            let minutes = number(at + 4, at + 6)?;
            let sign = if zone.starts_with('-') { -1 } else { 1 };
            sign * (hours * 3_600 + minutes * 60)
        }
        _ => return None,
    };
    // Days since the epoch, by the days-from-civil algorithm.
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let day_of_year = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days = era * 146_097 + day_of_era - 719_468;
    let seconds = days * 86_400 + hour * 3_600 + minute * 60 + second - offset;
    Some(i128::from(seconds) * 1_000_000_000 + nanos)
}

/// The store's clock. A debug build moves it by the milliseconds the
/// `clock-offset` fault names, negative to put it back, so a fixture can pass
/// minutes between two drains, or have the clock go backward, without waiting.
fn clock() -> std::time::SystemTime {
    let now = std::time::SystemTime::now();
    match crate::fault::named("clock-offset").and_then(|ms| ms.parse::<i64>().ok()) {
        Some(ms) if ms >= 0 => now + std::time::Duration::from_millis(ms.unsigned_abs()),
        Some(ms) => now - std::time::Duration::from_millis(ms.unsigned_abs()),
        None => now,
    }
}

pub fn now_iso() -> String {
    iso_at(clock())
}

/// The store's clock as milliseconds since the Unix epoch.
pub fn now_millis() -> i64 {
    clock()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |since| since.as_millis() as i64)
}

pub(crate) fn iso_at(now: std::time::SystemTime) -> String {
    let now = now
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs() as i64;
    let millis = now.subsec_millis();
    let days = secs.div_euclid(86_400);
    let time = secs.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        time / 3600,
        (time % 3600) / 60,
        time % 60
    )
}

fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod comparison {
    use super::{instant_of, iso_at};
    use marfa_rules::time::{self, Fault};
    use std::collections::BTreeMap;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    fn seeds() -> Vec<String> {
        let mut seeds = Vec::new();
        for year in [
            0, 1, 4, 100, 400, 1600, 1900, 1969, 1970, 1999, 2000, 2024, 2026, 2100, 9998, 9999,
        ] {
            for month in 1..=12 {
                for day in [1, time::days_in_month(year, month)] {
                    seeds.push(format!("{year:04}-{month:02}-{day:02}T12:34:56Z"));
                }
            }
        }
        for year in 0..=9999 {
            for (month, day) in [(1, 1), (2, 28), (3, 1), (12, 31)] {
                seeds.push(format!("{year:04}-{month:02}-{day:02}T23:59:59.999Z"));
            }
            if time::is_leap(year) {
                seeds.push(format!("{year:04}-02-29T00:00:00Z"));
            }
        }
        for length in 1..=12 {
            let fraction: String = "123456789012".chars().take(length).collect();
            seeds.push(format!("2026-07-01T20:00:30.{fraction}Z"));
            seeds.push(format!("0000-01-01T00:00:00.{fraction}+00:00"));
            seeds.push(format!("9999-12-31T23:59:59.{fraction}-00:00"));
        }
        for zone in [
            "Z", "z", "+00:00", "-00:00", "+05:30", "-12:00", "+14:00", "+23:59", "-23:59",
            "+24:00", "-24:00", "+00:60", "+99:99", "-99:00", "+0100", "+01", "+1:00",
        ] {
            seeds.push(format!("2026-07-01T20:00:30{zone}"));
            seeds.push(format!("2026-07-01T20:00:30.25{zone}"));
            seeds.push(format!("0000-01-01T00:00:00{zone}"));
            seeds.push(format!("9999-12-31T23:59:59{zone}"));
        }
        for untidy in [
            "",
            "2026-07-01",
            "2026-07-01T20:00Z",
            "2026-07-01T20:00:00",
            "2016-12-31T23:59:60Z",
            "2026-07-01T20:00:60Z",
            "2026-02-31T00:00:00Z",
            "2026-02-29T00:00:00Z",
            "2000-02-30T00:00:00Z",
            "1900-02-29T00:00:00Z",
            "2026-04-31T00:00:00Z",
            "2026-06-31T00:00:00Z",
            "2026-01-32T00:00:00Z",
            "2026-00-10T00:00:00Z",
            "2026-13-10T00:00:00Z",
            "2026-07-01 20:00:00Z",
            "2026-07-01T24:00:00Z",
            "2026-07-01T20:60:00Z",
            "2026-07-01T20:00:00\u{2212}05:00",
            "2026-07-01T20:00:00+05\u{2212}00",
            "2026-07-01T20:00:00.Z",
            "2026-07-01T20:00:00Zjunk",
            " 2026-07-01T20:00:00Z",
            "2026-07-01T20:00:00Z ",
            "-001-07-01T20:00:00Z",
            "+2026-07-01T20:00:00Z",
            "10000-01-01T00:00:00Z",
            "0000-01-01T00:00:00+00:01",
            "9999-12-31T23:59:59-00:01",
            "0000-01-01T00:00:00+23:59",
            "9999-12-31T23:59:59-23:59",
            "２０２６-07-01T20:00:00Z",
            "2026-07-01T20:00:00.1234567890123456789Z",
        ] {
            seeds.push(untidy.to_string());
        }
        seeds
    }

    fn edits(seed: &str) -> Vec<String> {
        const ALPHABET: &[char] = &[
            '0', '1', '2', '3', '5', '6', '9', ':', '-', '+', 'T', 't', 'Z', 'z', '.', ' ',
            '\u{2212}', 'x', '６',
        ];
        let chars: Vec<char> = seed.chars().collect();
        let mut edited = Vec::new();
        for at in 0..=chars.len() {
            for &c in ALPHABET {
                let mut inserted = chars.clone();
                inserted.insert(at, c);
                edited.push(inserted.into_iter().collect());
                if at < chars.len() {
                    let mut replaced = chars.clone();
                    replaced[at] = c;
                    edited.push(replaced.into_iter().collect());
                }
            }
            if at < chars.len() {
                let mut removed = chars.clone();
                removed.remove(at);
                edited.push(removed.into_iter().collect());
            }
        }
        edited
    }

    fn reason(text: &str) -> &'static str {
        let b = text.as_bytes();
        if b.len() >= 20 && &b[17..19] == b"60" {
            return "leap second :60";
        }
        if b.len() >= 10 {
            let number =
                |from: usize, to: usize| text.get(from..to).and_then(|d| d.parse::<i64>().ok());
            if let (Some(y), Some(m), Some(d)) = (number(0, 4), number(5, 7), number(8, 10))
                && (1..=12).contains(&m)
                && d > time::days_in_month(y, m)
            {
                return "day past the month's end";
            }
        }
        if let Some(zone) = text
            .get(19..)
            .and_then(|rest| rest.find(['+', '-']).map(|at| &rest[at..]))
            && zone.len() == 6
            && let (Some(h), Some(m)) = (
                zone.get(1..3).and_then(|d| d.parse::<i64>().ok()),
                zone.get(4..6).and_then(|d| d.parse::<i64>().ok()),
            )
            && (h > 23 || m > 59)
        {
            return "offset hours past 23 or minutes past 59";
        }
        "other"
    }

    #[test]
    fn old_and_new_readers_and_writers_compare() {
        let mut corpus = seeds();
        let originals = corpus.clone();
        for seed in originals
            .iter()
            .filter(|s| s.len() >= 20)
            .step_by(1)
            .filter(|s| {
                // Single-character edits of a few seeds, not of every seed.
                [
                    "2026-07-01T20:00:30Z",
                    "2026-07-01T20:00:30.25+05:30",
                    "0000-01-01T00:00:00Z",
                    "9999-12-31T23:59:59.999Z",
                    "2024-02-29T00:00:00-12:00",
                ]
                .contains(&s.as_str())
            })
        {
            corpus.extend(edits(seed));
        }
        corpus.sort();
        corpus.dedup();
        let mut classes: BTreeMap<String, (usize, Option<String>)> = BTreeMap::new();
        let mut note = |class: String, input: &str| {
            let entry = classes.entry(class).or_insert((0, None));
            entry.0 += 1;
            entry.1.get_or_insert_with(|| input.to_string());
        };
        for input in &corpus {
            match (instant_of(input), time::read(input)) {
                (Some(old), Ok(new)) if old.div_euclid(1_000_000) as i64 == new => {
                    note(
                        if old.rem_euclid(1_000_000) == 0 {
                            "same, to the millisecond".into()
                        } else {
                            "same millisecond, old kept sub-millisecond digits".into()
                        },
                        input,
                    );
                }
                (Some(old), Ok(new)) => {
                    panic!("different instant for {input:?}: {old} ns against {new} ms")
                }
                (None, Err(_)) => note("both refuse".into(), input),
                (Some(_), Err(fault)) => {
                    let what = match fault {
                        Fault::Range => "UTC year outside 0000 to 9999",
                        Fault::Form => reason(input),
                    };
                    note(format!("old reads, new refuses: {what}"), input);
                }
                (None, Ok(_)) => note("new reads, old refuses".into(), input),
            }
        }
        println!("reader corpus: {} inputs", corpus.len());
        for (class, (count, first)) in &classes {
            println!(
                "  {count:>7}  {class}  (first: {:?})",
                first.as_deref().unwrap_or("")
            );
        }
        assert!(!classes.contains_key("new reads, old refuses"));

        let new_iso = |at: SystemTime| {
            time::written(
                at.duration_since(UNIX_EPOCH)
                    .map_or(0, |since| since.as_millis() as i64),
            )
        };
        let mut checked = 0_u64;
        let mut written_differences = Vec::new();
        let mut check = |at: SystemTime| {
            checked += 1;
            let (old, new) = (iso_at(at), new_iso(at));
            if old != new {
                written_differences.push((old, new));
            }
        };
        for ms in 0..10_000_u64 {
            check(UNIX_EPOCH + Duration::from_millis(ms));
        }
        for ms in time::LAST_MS - 10_000..=time::LAST_MS {
            check(UNIX_EPOCH + Duration::from_millis(ms as u64));
        }
        let mut ms = 10_000_u64;
        while ms < time::LAST_MS as u64 {
            check(UNIX_EPOCH + Duration::from_millis(ms) + Duration::from_nanos(ms % 1_000_000));
            ms += 86_399_999 + ms % 7_919;
        }
        for nanos in [1, 999_999, 1_000_000, 1_999_999, 999_999_999, 1_000_000_001] {
            check(UNIX_EPOCH + Duration::from_nanos(nanos));
        }
        check(UNIX_EPOCH - Duration::from_secs(1));
        check(UNIX_EPOCH - Duration::from_secs(86_400 * 366));
        println!(
            "writer corpus: {checked} instants in 0000 to 9999 and before 1970, {} differences",
            written_differences.len()
        );
        assert!(written_differences.is_empty(), "{written_differences:?}");
        let after_9999 = UNIX_EPOCH + Duration::from_millis(time::LAST_MS as u64 + 1);
        println!(
            "writer after 9999: old {:?}, new {:?}",
            iso_at(after_9999),
            new_iso(after_9999)
        );
    }

    fn old_days(year: i64, month: i64, day: i64) -> i64 {
        let year = if month <= 2 { year - 1 } else { year };
        let era = if year >= 0 { year } else { year - 399 } / 400;
        let year_of_era = year - era * 400;
        let day_of_year = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
        let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
        era * 146_097 + day_of_era - 719_468
    }

    #[test]
    fn old_and_new_days_from_civil_compare() {
        let mut checked = 0_u64;
        for year in (-5_000_000..=5_000_000).step_by(997).chain(-1500..=11_500) {
            for month in 1..=12 {
                for day in [-40, -1, 0, 1, 15, 28, 29, 30, 31, 32, 99] {
                    assert_eq!(
                        old_days(year, month, day),
                        time::days_from_civil(year, month, day),
                        "{year}-{month}-{day}"
                    );
                    checked += 1;
                }
            }
        }
        println!("http days-from-civil corpus: {checked} dates, 0 differences");
    }
}
