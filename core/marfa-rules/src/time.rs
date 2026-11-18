//! Stored times: whole milliseconds since the epoch, read and written as RFC 3339 text.

use crate::error::{Result, RuleError};

/// 0000-01-01T00:00:00.000Z, the first instant a stored time holds.
pub const FIRST_MS: i64 = -62_167_219_200_000;
/// 9999-12-31T23:59:59.999Z, the last.
pub const LAST_MS: i64 = 253_402_300_799_999;

const DAY_SECONDS: i64 = 86_400;
const DAY_MS: i64 = 86_400_000;

/// Why a text did not read as a stored time.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fault {
    /// It is not an RFC 3339 date-time as [`rfc3339`] reads one.
    Form,
    /// It is one, but its UTC year is outside 0000 to 9999.
    Range,
}

/// Days since 1970-01-01 of a proleptic Gregorian date.
pub fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let month = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * month + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// The year, month and day of a count of days since 1970-01-01.
pub fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (era * 400 + yoe + i64::from(m <= 2), m, d)
}

pub fn is_leap(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

pub fn days_in_month(y: i64, m: i64) -> i64 {
    match m {
        2 if is_leap(y) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// The UTC year, month and day of an instant.
pub fn civil_date(ms: i64) -> (i64, i64, i64) {
    civil_from_days(ms.div_euclid(DAY_MS))
}

/// The UTC date of an instant as jiff holds it, which reaches years -9999 to 9999.
pub fn date_of(ms: i64) -> Option<jiff::civil::Date> {
    let (year, month, day) = civil_date(ms);
    jiff::civil::Date::new(
        i16::try_from(year).ok()?,
        i8::try_from(month).ok()?,
        i8::try_from(day).ok()?,
    )
    .ok()
}

/// A year as a time writes it: four digits for 0000 to 9999, otherwise a sign and at least four digits.
pub fn year_text(year: i64) -> String {
    if (0..=9999).contains(&year) {
        format!("{year:04}")
    } else {
        format!("{year:+05}")
    }
}

/// The UTC date of an instant as `YYYY-MM-DD`.
pub fn date_text(ms: i64) -> String {
    let (year, month, day) = civil_date(ms);
    format!("{}-{month:02}-{day:02}", year_text(year))
}

/// Milliseconds since the epoch of a stored time: what [`normalize_bound`] reads, or a `datetime` value written without seconds.
pub fn epoch_ms(value: &str) -> Option<i64> {
    bound(value).ok().or_else(|| {
        let zoned = value
            .as_bytes()
            .get(16)
            .is_some_and(|b| matches!(b, b'Z' | b'z' | b'+' | b'-'));
        let minutes = value.get(..16).filter(|_| zoned)?;
        read(&format!("{minutes}:00{}", &value[16..])).ok()
    })
}

/// RFC 3339 as written: a date, `T`, a time with seconds, and a zone (`Z`, or `+` or `-` and `hh:mm`); `t` and `z` may be lowercase. The hour is 00 to 23 and the second 00 to 59, so a leap second is refused. A fraction longer than milliseconds is cut, not rounded. The UTC year must be 0000 to 9999. Answers `YYYY-MM-DDTHH:MM:SS.sssZ`.
pub fn rfc3339(value: &str, field: &str) -> Result<String> {
    instant(value, field).map(written)
}

/// The UTC instant [`rfc3339`] reads, in milliseconds.
pub fn instant(value: &str, field: &str) -> Result<i64> {
    read(value).map_err(|unread| fault(field, unread))
}

/// The UTC instant of an RFC 3339 date-time in milliseconds, or why it did not read.
pub fn read(value: &str) -> core::result::Result<i64, Fault> {
    let ms = utc_ms(value.as_bytes()).ok_or(Fault::Form)?;
    (FIRST_MS..=LAST_MS)
        .contains(&ms)
        .then_some(ms)
        .ok_or(Fault::Range)
}

fn utc_ms(b: &[u8]) -> Option<i64> {
    if b.len() < 20
        || (b[4], b[7], b[13], b[16]) != (b'-', b'-', b':', b':')
        || !matches!(b[10], b'T' | b't')
    {
        return None;
    }
    let (year, month, day) = (digits(&b[0..4])?, digits(&b[5..7])?, digits(&b[8..10])?);
    let (hour, minute, second) = (
        digits(&b[11..13])?,
        digits(&b[14..16])?,
        digits(&b[17..19])?,
    );
    if !(1..=12).contains(&month)
        || !(1..=days_in_month(year, month)).contains(&day)
        || hour > 23
        || minute > 59
        || second > 59
    {
        return None;
    }
    let (mut at, mut fraction) = (19, 0);
    if b[19] == b'.' {
        let length = b[20..].iter().take_while(|d| d.is_ascii_digit()).count();
        if length == 0 {
            return None;
        }
        for (place, digit) in b[20..20 + length.min(3)].iter().enumerate() {
            fraction += i64::from(digit - b'0') * [100, 10, 1][place];
        }
        at = 20 + length;
    }
    let offset = match &b[at..] {
        [b'Z' | b'z'] => 0,
        [sign @ (b'+' | b'-'), zone @ ..] if zone.len() == 5 && zone[2] == b':' => {
            let (hours, minutes) = (digits(&zone[0..2])?, digits(&zone[3..5])?);
            if hours > 23 || minutes > 59 {
                return None;
            }
            let seconds = hours * 3600 + minutes * 60;
            if *sign == b'-' { -seconds } else { seconds }
        }
        _ => return None,
    };
    let seconds =
        days_from_civil(year, month, day) * DAY_SECONDS + hour * 3600 + minute * 60 + second
            - offset;
    Some(seconds * 1000 + fraction)
}

fn digits(b: &[u8]) -> Option<i64> {
    b.iter().try_fold(0, |number, digit| {
        digit
            .is_ascii_digit()
            .then(|| number * 10 + i64::from(digit - b'0'))
    })
}

/// `YYYY-MM-DDTHH:MM:SS.sssZ` for an instant, which sorts as it reads for the years 0000 to 9999. A year outside them keeps a sign and at least four digits.
pub fn written(ms: i64) -> String {
    let (year, month, day) = civil_date(ms);
    let into_day = ms.rem_euclid(DAY_MS);
    format!(
        "{}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        year_text(year),
        into_day / 3_600_000,
        into_day / 60_000 % 60,
        into_day / 1000 % 60,
        into_day % 1000
    )
}

/// A date-time as [`rfc3339`] reads it, or a date alone as `YYYY-MM-DD`, which is its midnight in UTC.
pub fn normalize_bound(value: &str, field: &str) -> Result<String> {
    bound(value)
        .map(written)
        .map_err(|unread| fault(field, unread))
}

fn bound(value: &str) -> core::result::Result<i64, Fault> {
    date_alone(value).map_or_else(|| read(value), Ok)
}

fn date_alone(value: &str) -> Option<i64> {
    let b = value.as_bytes();
    if b.len() != 10 || (b[4], b[7]) != (b'-', b'-') {
        return None;
    }
    let (year, month, day) = (digits(&b[0..4])?, digits(&b[5..7])?, digits(&b[8..10])?);
    ((1..=12).contains(&month) && (1..=days_in_month(year, month)).contains(&day))
        .then(|| days_from_civil(year, month, day) * DAY_MS)
}

fn fault(field: &str, unread: Fault) -> RuleError {
    match unread {
        Fault::Form => invalid(field, "expected an RFC 3339 timestamp"),
        Fault::Range => invalid(field, "the UTC year must be between 0000 and 9999"),
    }
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

    #[test]
    fn a_unicode_minus_in_an_offset_is_not_a_sign() {
        assert!(rfc3339("2026-01-01T00:00:00-05:00", "time").is_ok());
        assert_eq!(read("2026-01-01T00:00:00\u{2212}05:00"), Err(Fault::Form));
        assert_eq!(epoch_ms("2026-01-01T00:00\u{2212}05:00"), None);
    }

    #[test]
    fn a_fault_of_form_is_told_from_a_year_out_of_range() {
        assert_eq!(read("2026-01-01T00:00:00Z"), Ok(1_767_225_600_000));
        for form in ["2026-01-01 00:00:00Z", "2016-12-31T23:59:60Z", ""] {
            assert_eq!(read(form), Err(Fault::Form), "{form}");
        }
        for range in ["0000-01-01T00:00:00+00:01", "9999-12-31T23:59:59-00:01"] {
            assert_eq!(read(range), Err(Fault::Range), "{range}");
        }
    }

    #[test]
    fn the_first_and_last_instants_read_and_write_as_they_are_stored() {
        for (text, ms) in [
            ("0000-01-01T00:00:00.000Z", FIRST_MS),
            ("9999-12-31T23:59:59.999Z", LAST_MS),
        ] {
            assert_eq!(read(text), Ok(ms));
            assert_eq!(written(ms), text);
        }
    }

    #[test]
    fn a_year_outside_four_digits_keeps_its_sign() {
        assert_eq!(written(LAST_MS + 1), "+10000-01-01T00:00:00.000Z");
        assert_eq!(written(FIRST_MS - 1), "-0001-12-31T23:59:59.999Z");
        assert_eq!(date_text(LAST_MS + 1), "+10000-01-01");
    }
}
