use chrono::{Datelike, NaiveDate, NaiveDateTime, Timelike};

use crate::error::{Result, RuleError};

/// RFC 3339 as written: a date, `T`, a time with seconds, and a zone (`Z` or `±hh:mm`); `t` and `z` may be lowercase. The hour is 00 to 23 and the second 00 to 59, so a leap second is refused. A fraction longer than milliseconds is cut, not rounded. The UTC year must be 0000 to 9999. Answers `YYYY-MM-DDTHH:MM:SS.sssZ`.
pub fn rfc3339(value: &str, field: &str) -> Result<String> {
    let bytes = value.as_bytes();
    let zoned = matches!(bytes.last(), Some(b'Z' | b'z'))
        || bytes.len() > 6 && bytes[bytes.len() - 3] == b':';
    let instant = (zoned && matches!(bytes.get(10), Some(b'T' | b't')))
        .then(|| chrono::DateTime::parse_from_rfc3339(value).ok())
        .flatten()
        .map(|instant| instant.naive_utc())
        .filter(|instant| instant.nanosecond() < 1_000_000_000)
        .ok_or_else(|| invalid(field, "expected an RFC 3339 timestamp"))?;
    answered(instant, field)
}

/// A date-time as [`rfc3339`] reads it, or a date alone as `YYYY-MM-DD`, which is its midnight in UTC.
pub fn normalize_bound(value: &str, field: &str) -> Result<String> {
    match date_alone(value) {
        Some(instant) => answered(instant, field),
        None => rfc3339(value, field),
    }
}

fn date_alone(value: &str) -> Option<NaiveDateTime> {
    let bytes = value.as_bytes();
    let shaped = bytes.len() == 10
        && bytes.iter().enumerate().all(|(at, byte)| {
            if at == 4 || at == 7 {
                *byte == b'-'
            } else {
                byte.is_ascii_digit()
            }
        });
    shaped
        .then(|| NaiveDate::parse_from_str(value, "%Y-%m-%d").ok())
        .flatten()
        .and_then(|date| date.and_hms_opt(0, 0, 0))
}

fn answered(instant: NaiveDateTime, field: &str) -> Result<String> {
    if !(0..=9999).contains(&instant.year()) {
        return Err(invalid(field, "the UTC year must be between 0000 and 9999"));
    }
    Ok(instant.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
}

pub fn invalid(field: &str, reason: &str) -> RuleError {
    RuleError::validation(format!("Invalid {field}: {reason}"))
}

pub fn projected(value: &str) -> String {
    rfc3339(value, "occurred_at").unwrap_or_else(|_| value.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_an_rfc_3339_date_time_as_its_utc_instant() {
        for (input, expected) in [
            ("2026-01-01T00:00:00Z", "2026-01-01T00:00:00.000Z"),
            ("2026-01-01t00:00:00z", "2026-01-01T00:00:00.000Z"),
            ("2026-01-01t00:00:00Z", "2026-01-01T00:00:00.000Z"),
            ("2026-01-01T00:00:00.5z", "2026-01-01T00:00:00.500Z"),
            ("2026-01-01t01:00:00+01:00", "2026-01-01T00:00:00.000Z"),
            ("2026-01-01T00:00:00.1Z", "2026-01-01T00:00:00.100Z"),
            (
                "2026-01-01T00:00:00.1234567890123Z",
                "2026-01-01T00:00:00.123Z",
            ),
            ("2026-01-01T01:00:00+01:00", "2026-01-01T00:00:00.000Z"),
            ("2025-12-31T23:00:00-01:00", "2026-01-01T00:00:00.000Z"),
            ("2026-01-01T00:00:00-00:00", "2026-01-01T00:00:00.000Z"),
            ("2026-01-01T00:00:00+23:59", "2025-12-31T00:01:00.000Z"),
            ("2000-02-29T12:00:00Z", "2000-02-29T12:00:00.000Z"),
            ("0000-01-01T01:00:00+01:00", "0000-01-01T00:00:00.000Z"),
            ("9999-12-31T23:59:59.9999Z", "9999-12-31T23:59:59.999Z"),
        ] {
            assert_eq!(rfc3339(input, "time").unwrap(), expected, "{input}");
        }
    }

    #[test]
    fn refuses_what_rfc_3339_does_not_write() {
        for input in [
            "",
            "2026",
            "2026-01",
            "2026-01-01",
            "2026-01-01T00:00",
            "2026-01-01T00:00Z",
            "2026-01-01T00:00:00",
            "2026-01-01T00:00:00.1",
            "2026-01-01T00:00:00.Z",
            "2026-01-01T24:00:00Z",
            "2026-01-01T25:00:00Z",
            "2026-01-01T00:60:00Z",
            "2026-01-01T00:00:60Z",
            "2026-01-01T01:00:00+0100",
            "2026-01-01T01:00:00+01",
            "2026-01-01T00:00:00+24:00",
            "2026-01-01T00:00:00+00:60",
            "2026-01-01T00:00:00Zjunk",
            " 2026-01-01T00:00:00Z",
            "2026-01-01T00:00:00Z ",
            "2016-12-31T23:59:60Z",
            "2026-01-01 00:00:00Z",
            "2026-1-1T00:00:00Z",
            "2026-00-01T00:00:00Z",
            "2026-13-01T00:00:00Z",
            "2026-01-00T00:00:00Z",
            "1900-02-29T00:00:00Z",
            "2026-04-31T00:00:00Z",
            "２０２６-01-01T00:00:00Z",
            "0000-01-01T00:00:00+00:01",
            "9999-12-31T23:59:59-00:01",
        ] {
            assert!(rfc3339(input, "time").is_err(), "{input}");
        }
    }

    #[test]
    fn a_bound_also_takes_a_date_alone_as_its_midnight_in_utc() {
        assert_eq!(
            normalize_bound("2000-02-29", "time").unwrap(),
            "2000-02-29T00:00:00.000Z"
        );
        assert_eq!(
            normalize_bound("2026-01-01T01:00:00+01:00", "time").unwrap(),
            "2026-01-01T00:00:00.000Z"
        );
        for input in [
            "2026",
            "2026-01",
            "2026-02-29",
            "2026-01-01T00:00",
            "2026-01-01Z",
        ] {
            assert!(normalize_bound(input, "time").is_err(), "{input}");
        }
    }
}
