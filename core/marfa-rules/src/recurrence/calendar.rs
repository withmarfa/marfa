//! Whole days counted from 1970-01-01, and the wall clock of a zone.

use jiff::Timestamp;
use jiff::civil::DateTime;
use jiff::tz::{AmbiguousOffset, TimeZone};

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

/// 0 for Monday through 6 for Sunday.
pub fn weekday(day: i64) -> i64 {
    (day + 3).rem_euclid(7)
}

pub fn week_start(day: i64, wkst: i64) -> i64 {
    day - (weekday(day) - wkst).rem_euclid(7)
}

/// The week number under `wkst`, and the weeks in that week's year.
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

/// A time zone read from the bundled IANA database.
#[derive(Clone, Debug)]
pub struct Zone {
    zone: TimeZone,
    fixed: Option<i64>,
}

impl Zone {
    pub const UTC: Zone = Zone {
        zone: TimeZone::UTC,
        fixed: Some(0),
    };

    /// A name the bundled database holds in exactly this spelling.
    pub fn named(name: &str) -> Option<Zone> {
        let zone = TimeZone::get(name).ok()?;
        (zone.iana_name() == Some(name) && name != "Factory").then(|| Zone::from_time_zone(zone))
    }

    pub fn from_time_zone(zone: TimeZone) -> Zone {
        let fixed = zone
            .to_fixed_offset()
            .ok()
            .map(|offset| i64::from(offset.seconds()));
        Zone { zone, fixed }
    }

    /// The reading of the wall clock at `ms`, in seconds counted as if the zone were UTC. Past the range jiff holds, the offset at its bound.
    pub fn wall_of(&self, ms: i64) -> i64 {
        if let Some(offset) = self.fixed {
            return ms.div_euclid(1000) + offset;
        }
        let at = Timestamp::from_millisecond(ms).unwrap_or(if ms < 0 {
            Timestamp::MIN
        } else {
            Timestamp::MAX
        });
        ms.div_euclid(1000) + i64::from(self.zone.to_offset(at).seconds())
    }

    /// A reading a clock change skips takes the offset before the gap; one it repeats, the first.
    pub fn instant_of(&self, wall: i64) -> i64 {
        (wall - self.offset_at_wall(wall)) * 1000
    }

    fn offset_at_wall(&self, wall: i64) -> i64 {
        if let Some(offset) = self.fixed {
            return offset;
        }
        let days = wall.div_euclid(DAY);
        let second = wall.rem_euclid(DAY);
        let (year, month, day) = civil_from_days(days);
        let reading = i16::try_from(year)
            .ok()
            .and_then(|year| {
                DateTime::new(
                    year,
                    month as i8,
                    day as i8,
                    (second / 3600) as i8,
                    (second / 60 % 60) as i8,
                    (second % 60) as i8,
                    0,
                )
                .ok()
            })
            .unwrap_or(if wall < 0 {
                DateTime::MIN
            } else {
                DateTime::MAX
            });
        let offset = match self.zone.to_ambiguous_timestamp(reading).offset() {
            AmbiguousOffset::Unambiguous { offset } => offset,
            AmbiguousOffset::Gap { before, .. } | AmbiguousOffset::Fold { before, .. } => before,
        };
        i64::from(offset.seconds())
    }

    /// The day `ms` falls on, as a day number.
    pub fn day_of(&self, ms: i64) -> i64 {
        self.wall_of(ms).div_euclid(DAY)
    }

    pub fn midnight(&self, day: i64) -> i64 {
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

    #[test]
    fn only_an_exact_database_spelling_is_a_zone() {
        for taken in ["US/Eastern", "UTC", "Etc/UTC", "Asia/Kolkata"] {
            assert!(Zone::named(taken).is_some(), "{taken}");
        }
        for refused in [
            "Factory",
            "posixrules",
            "Etc/Unknown",
            "utc",
            "europe/London",
            "US/EASTERN",
            "",
            " UTC",
            "UTC ",
            "EST5EDT,M3.2.0,M11.1.0",
            "/usr/share/zoneinfo/UTC",
        ] {
            assert!(Zone::named(refused).is_none(), "{refused:?}");
        }
    }

    #[test]
    fn every_name_of_the_earlier_database_still_resolves() {
        let names: Vec<&str> = include_str!("zone-names.txt").lines().collect();
        assert_eq!(names.len(), 597);
        for name in names {
            assert!(Zone::named(name).is_some(), "{name}");
        }
    }

    #[test]
    fn the_last_day_of_9999_reads_its_zones_offset() {
        let sydney = Zone::named("Australia/Sydney").unwrap();
        let london = Zone::named("Europe/London").unwrap();
        let last_day = days_from_civil(9999, 12, 31) * DAY;
        for hour in [0, 21, 22, 23] {
            let ms = (last_day + hour * 3600 + 1800) * 1000;
            assert_eq!(sydney.wall_of(ms), last_day + hour * 3600 + 1800 + 39_600);
            assert_eq!(london.wall_of(ms), last_day + hour * 3600 + 1800);
        }
        let last_ms = (last_day + DAY) * 1000 - 1;
        assert_eq!(sydney.wall_of(last_ms), last_day + DAY - 1 + 39_600);
        assert_eq!(sydney.day_of(last_ms), days_from_civil(10_000, 1, 1));
    }

    #[test]
    fn a_wall_on_the_last_day_of_9999_has_an_instant() {
        let sydney = Zone::named("Australia/Sydney").unwrap();
        let london = Zone::named("Europe/London").unwrap();
        let last_day = days_from_civil(9999, 12, 31) * DAY;
        for wall in [
            last_day + 10 * 3600,
            last_day + DAY - 1,
            last_day + DAY,
            last_day + 400 * DAY,
        ] {
            assert_eq!(london.instant_of(wall), wall * 1000, "{wall}");
            assert_eq!(sydney.instant_of(wall), (wall - 39_600) * 1000, "{wall}");
        }
        assert_eq!(
            london.midnight(days_from_civil(9999, 12, 31)),
            last_day * 1000
        );
    }
}
