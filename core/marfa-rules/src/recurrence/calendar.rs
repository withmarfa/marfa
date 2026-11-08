//! Whole days counted from 1970-01-01, and the wall clock of a zone.

use chrono::{DateTime, LocalResult, Offset, TimeDelta, TimeZone};
use chrono_tz::Tz;

pub const DAY: i64 = 86_400;
pub const LAST_YEAR: i64 = 9999;

pub fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let month = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * month + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

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

/// 0 for Monday through 6 for Sunday, RFC 5545's order.
pub fn weekday(day: i64) -> i64 {
    (day + 3).rem_euclid(7)
}

pub fn week_start(day: i64, wkst: i64) -> i64 {
    day - (weekday(day) - wkst).rem_euclid(7)
}

/// The week number RFC 5545 gives `day` under `wkst`, and the count of weeks in that week's year.
pub fn week_number(day: i64, wkst: i64) -> (i64, i64) {
    let start = week_start(day, wkst);
    let (week_year, _, _) = civil_from_days(start + 3);
    let first = week_start(days_from_civil(week_year, 1, 4), wkst);
    let next = week_start(days_from_civil(week_year + 1, 1, 4), wkst);
    ((start - first) / 7 + 1, (next - first) / 7)
}

pub fn ceil_div(a: i64, b: i64) -> i64 {
    -((-a).div_euclid(b))
}

/// A zone as the wall clock turns an instant into a reading and back; no zone is UTC.
#[derive(Clone, Copy, Debug)]
pub struct Zone(Option<Tz>);

impl Zone {
    pub const UTC: Zone = Zone(None);

    pub fn named(name: &str) -> Option<Zone> {
        name.parse::<Tz>().ok().map(|tz| Zone(Some(tz)))
    }

    /// The reading of the wall clock at `ms`, in seconds counted as if the zone were UTC.
    pub fn wall_of(self, ms: i64) -> i64 {
        let seconds = ms.div_euclid(1000);
        let Some(tz) = self.0 else {
            return seconds;
        };
        let Some(at) = DateTime::from_timestamp_millis(ms) else {
            return seconds;
        };
        seconds
            + i64::from(
                tz.offset_from_utc_datetime(&at.naive_utc())
                    .fix()
                    .local_minus_utc(),
            )
    }

    /// The instant, in milliseconds, at which the zone reads `wall`. A reading a clock change
    /// skips takes the offset in force before the gap, so it lands later by the gap; a reading it
    /// repeats names its first occurrence.
    pub fn instant_of(self, wall: i64) -> i64 {
        let Some(tz) = self.0 else {
            return wall * 1000;
        };
        let Some(naive) = DateTime::from_timestamp(wall, 0).map(|at| at.naive_utc()) else {
            return wall * 1000;
        };
        match tz.from_local_datetime(&naive) {
            LocalResult::Single(at) => at.timestamp_millis(),
            LocalResult::Ambiguous(first, second) => {
                first.timestamp_millis().min(second.timestamp_millis())
            }
            LocalResult::None => {
                let before = naive - TimeDelta::days(1);
                let offset =
                    i64::from(tz.offset_from_utc_datetime(&before).fix().local_minus_utc());
                (wall - offset) * 1000
            }
        }
    }

    /// The day `ms` falls on, as a day number.
    pub fn day_of(self, ms: i64) -> i64 {
        self.wall_of(ms).div_euclid(DAY)
    }

    pub fn midnight(self, day: i64) -> i64 {
        self.instant_of(day * DAY)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn civil_round_trip_and_weekdays() {
        for day in [-800_000, -1, 0, 1, 19_000, 2_900_000] {
            let (y, m, d) = civil_from_days(day);
            assert_eq!(days_from_civil(y, m, d), day);
        }
        assert_eq!(weekday(0), 3);
        assert_eq!(weekday(days_from_civil(2026, 11, 8)), 6);
    }

    #[test]
    fn week_numbers_follow_the_week_year() {
        let day = days_from_civil(2021, 1, 3);
        assert_eq!(week_number(day, 0), (53, 53));
        assert_eq!(week_number(days_from_civil(2020, 12, 31), 0), (53, 53));
        assert_eq!(week_number(days_from_civil(2021, 1, 4), 0), (1, 52));
    }

    #[test]
    fn a_skipped_reading_lands_later_by_the_gap_and_a_repeated_one_takes_its_first() {
        let london = Zone::named("Europe/London").unwrap();
        let gap = days_from_civil(2026, 3, 29) * DAY + 3600 + 1800;
        assert_eq!(london.instant_of(gap), gap * 1000);
        assert_eq!(london.wall_of(london.instant_of(gap)), gap + 3600);
        let twice = days_from_civil(2026, 10, 25) * DAY + 3600 + 1800;
        assert_eq!(london.instant_of(twice), (twice - 3600) * 1000);

        let sydney = Zone::named("Australia/Sydney").unwrap();
        let skipped = days_from_civil(2026, 10, 4) * DAY + 2 * 3600 + 1800;
        assert_eq!(sydney.wall_of(sydney.instant_of(skipped)), skipped + 3600);
        let repeated = days_from_civil(2026, 4, 5) * DAY + 2 * 3600 + 1800;
        assert_eq!(sydney.instant_of(repeated), (repeated - 11 * 3600) * 1000);
    }

    #[test]
    fn half_hour_and_forty_five_minute_zones_read_their_offsets() {
        let day = days_from_civil(2026, 6, 1) * DAY;
        let kolkata = Zone::named("Asia/Kolkata").unwrap();
        assert_eq!(kolkata.wall_of(day * 1000), day + 19_800);
        let kathmandu = Zone::named("Asia/Kathmandu").unwrap();
        assert_eq!(kathmandu.wall_of(day * 1000), day + 20_700);
        assert_eq!(kathmandu.instant_of(day + 20_700), day * 1000);
    }

    #[test]
    fn a_name_in_another_case_is_not_a_zone() {
        assert!(Zone::named("Europe/London").is_some());
        assert!(Zone::named("europe/london").is_none());
        assert!(Zone::named("+01:00").is_none());
        assert!(Zone::named("US/Pacific").is_some());
    }
}
