use chrono::{Datelike, NaiveDate, NaiveDateTime, TimeDelta};

use crate::{CoreError, Result};

/// Matches the server's flexible timestamp grammar, with a UTC default zone.
/// Chrono handles the calendar; the adapter preserves Date's reduced precision,
/// compact offsets, millisecond truncation and special midnight spelling.
pub(crate) fn normalize(value: &str, field: &str) -> Result<String> {
    let instant = parse(value).ok_or_else(|| invalid(field, "expected an RFC 3339 timestamp"))?;
    if !(0..=9999).contains(&instant.year()) {
        return Err(invalid(field, "the UTC year must be between 0000 and 9999"));
    }
    Ok(instant.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
}

pub(crate) fn invalid(field: &str, reason: &str) -> CoreError {
    CoreError::Validation {
        code: "validation_error".into(),
        message: format!("Invalid {field}: {reason}"),
    }
}

/// Invalid queued writes still reach the server's existing refusal path.
/// Only the displayed projection changes, never the queued request.
pub(crate) fn projected(value: &str) -> String {
    normalize(value, "occurred_at").unwrap_or_else(|_| value.to_string())
}

fn parse(value: &str) -> Option<NaiveDateTime> {
    let mut input = Input(value.as_bytes());
    let year = input.digits(4)? as i32;
    let month = if input.take(b'-') {
        input.digits(2)?
    } else {
        1
    };
    let day = if input.take(b'-') {
        input.digits(2)?
    } else {
        if !input.0.is_empty() {
            return None;
        }
        1
    };
    let date = NaiveDate::from_ymd_opt(year, month, day)?;
    if input.0.is_empty() {
        return date.and_hms_opt(0, 0, 0);
    }
    input.take(b'T').then_some(())?;
    let hour = input.digits(2)?;
    input.take(b':').then_some(())?;
    let minute = input.digits(2)?;
    let mut second = 0;
    let mut millis = 0;
    let mut fractional_nonzero = false;
    if input.take(b':') {
        second = input.digits(2)?;
        if input.take(b'.') {
            let count = input.0.iter().take_while(|c| c.is_ascii_digit()).count();
            if count == 0 {
                return None;
            }
            fractional_nonzero = input.0[..count].iter().any(|c| *c != b'0');
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
    }
    if hour > 24
        || minute > 59
        || second > 59
        || (hour == 24 && (minute != 0 || second != 0 || fractional_nonzero))
    {
        return None;
    }
    let mut offset = 0;
    if !input.take(b'Z') && !input.0.is_empty() {
        let sign = if input.take(b'+') {
            1
        } else if input.take(b'-') {
            -1
        } else {
            return None;
        };
        let hours = input.digits(2)?;
        input.take(b':');
        let minutes = input.digits(2)?;
        if hours > 23 || minutes > 59 {
            return None;
        }
        offset = sign * i64::from(hours * 60 + minutes);
    }
    if !input.0.is_empty() {
        return None;
    }
    date.and_hms_milli_opt(0, minute, second, millis)?
        .checked_add_signed(TimeDelta::minutes(i64::from(hour) * 60 - offset))
}

struct Input<'a>(&'a [u8]);
impl Input<'_> {
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
    fn supported_spellings_and_calendar_edges() {
        for (input, expected) in [
            ("0000", "0000-01-01T00:00:00.000Z"),
            ("0099-02", "0099-02-01T00:00:00.000Z"),
            ("2000-02-29", "2000-02-29T00:00:00.000Z"),
            ("2026-01-01T00:00", "2026-01-01T00:00:00.000Z"),
            ("2026-01-01T00:00:00.1", "2026-01-01T00:00:00.100Z"),
            (
                "2026-01-01T00:00:00.1234567890123Z",
                "2026-01-01T00:00:00.123Z",
            ),
            ("2026-01-01T01:00+0100", "2026-01-01T00:00:00.000Z"),
            ("2025-12-31T23:00-01:00", "2026-01-01T00:00:00.000Z"),
            ("2026-01-01T00:00+2359", "2025-12-31T00:01:00.000Z"),
            ("2026-01-01T24:00:00.00000Z", "2026-01-02T00:00:00.000Z"),
            ("0000-01-01T01:00+01:00", "0000-01-01T00:00:00.000Z"),
            ("9999-12-31T23:59:59.9999Z", "9999-12-31T23:59:59.999Z"),
        ] {
            assert_eq!(normalize(input, "time").unwrap(), expected, "{input}");
        }
        for input in [
            "",
            "2026-1",
            "2026-00",
            "2026-13",
            "2026-01-00",
            "1900-02-29",
            "2026-02-29T23:00-01:00",
            "2026-04-31",
            "2026-01-01T25:00",
            "2026-01-01T00:60Z",
            "2026-01-01T00:00:60Z",
            "2026-01-01T24:01Z",
            "2026-01-01T24:00:00.0001Z",
            "2026-01-01T00:00+2400",
            "2026-01-01T00:00+0060",
            "2026-01-01T00:00Zjunk",
            "2026-01-01T00:00.1Z",
            "2026-01-01T00:00:00.Z",
            "2026-01-01t00:00z",
            "2026-01-01T00:00+01",
            "2026T00:00",
            "２０２６",
            "0000-01-01T00:00+00:01",
            "9999-12-31T24:00Z",
            "9999-12-31T23:59-00:01",
        ] {
            assert!(normalize(input, "time").is_err(), "{input}");
        }
    }
}
