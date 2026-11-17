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
pub(super) fn clock() -> std::time::SystemTime {
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
