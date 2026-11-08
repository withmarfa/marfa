use chrono::{Datelike, NaiveDate, NaiveDateTime, TimeDelta};

use crate::error::{Result, RuleError};

/// An RFC 3339 date-time: a zone (`Z` or `±hh:mm`) is required, the second is written, the hour is 00 to 23 and the second 00 to 59. A fraction longer than milliseconds is cut, not rounded. The UTC year must be 0000 to 9999.
pub fn normalize(value: &str, field: &str) -> Result<String> {
    let instant = parse(value).ok_or_else(|| invalid(field, "expected an RFC 3339 timestamp"))?;
    answered(instant, field)
}

/// A date-time as [`normalize`] reads it, or a date alone as `YYYY-MM-DD`, which is its midnight in UTC.
pub fn normalize_bound(value: &str, field: &str) -> Result<String> {
    let instant = parse(value)
        .or_else(|| {
            let mut input = Input(value.as_bytes());
            let date = input.date()?;
            input.0.is_empty().then(|| date.and_hms_opt(0, 0, 0))?
        })
        .ok_or_else(|| invalid(field, "expected an RFC 3339 timestamp"))?;
    answered(instant, field)
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
    normalize(value, "occurred_at").unwrap_or_else(|_| value.to_string())
}

fn parse(value: &str) -> Option<NaiveDateTime> {
    let mut input = Input(value.as_bytes());
    let date = input.date()?;
    (input.take(b'T') || input.take(b't')).then_some(())?;
    let hour = input.digits(2)?;
    input.take(b':').then_some(())?;
    let minute = input.digits(2)?;
    input.take(b':').then_some(())?;
    let second = input.digits(2)?;
    if hour > 23 || minute > 59 || second > 59 {
        return None;
    }
    let mut millis = 0;
    if input.take(b'.') {
        let count = input.0.iter().take_while(|c| c.is_ascii_digit()).count();
        if count == 0 {
            return None;
        }
        for i in 0..3 {
            millis = millis * 10
                + if i < count {
                    u32::from(input.0[i] - b'0')
                } else {
                    0
                };
        }
        input.0 = &input.0[count..];
    }
    let offset = if input.take(b'Z') || input.take(b'z') {
        0
    } else {
        let sign = if input.take(b'+') {
            1
        } else if input.take(b'-') {
            -1
        } else {
            return None;
        };
        let hours = input.digits(2)?;
        input.take(b':').then_some(())?;
        let minutes = input.digits(2)?;
        if hours > 23 || minutes > 59 {
            return None;
        }
        sign * i64::from(hours * 60 + minutes)
    };
    if !input.0.is_empty() {
        return None;
    }
    date.and_hms_milli_opt(hour, minute, second, millis)?
        .checked_sub_signed(TimeDelta::minutes(offset))
}

struct Input<'a>(&'a [u8]);
impl Input<'_> {
    fn date(&mut self) -> Option<NaiveDate> {
        let year = self.digits(4)? as i32;
        self.take(b'-').then_some(())?;
        let month = self.digits(2)?;
        self.take(b'-').then_some(())?;
        let day = self.digits(2)?;
        NaiveDate::from_ymd_opt(year, month, day)
    }

    fn take(&mut self, byte: u8) -> bool {
        if self.0.first() == Some(&byte) {
            self.0 = &self.0[1..];
            true
        } else {
            false
        }
    }

    fn digits(&mut self, count: usize) -> Option<u32> {
        let bytes = self.0.get(..count)?;
        let number = bytes.iter().try_fold(0, |n, b| {
            b.is_ascii_digit().then(|| n * 10 + u32::from(*b - b'0'))
        })?;
        self.0 = &self.0[count..];
        Some(number)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_an_rfc_3339_date_time_as_its_utc_instant() {
        for (input, expected) in [
            ("2026-01-01T00:00:00Z", "2026-01-01T00:00:00.000Z"),
            ("2026-01-01t00:00:00z", "2026-01-01T00:00:00.000Z"),
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
            assert_eq!(normalize(input, "time").unwrap(), expected, "{input}");
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
            assert!(normalize(input, "time").is_err(), "{input}");
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
