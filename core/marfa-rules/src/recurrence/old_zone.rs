//! The zone code as chrono-tz answered it, kept only to compare with the jiff one.

use chrono::{DateTime, LocalResult, Offset, TimeDelta, TimeZone};
use chrono_tz::Tz;

use super::calendar::DAY;

/// No zone is UTC.
#[derive(Clone, Copy, Debug)]
pub struct OldZone(Option<Tz>);

impl OldZone {
    pub const UTC: OldZone = OldZone(None);

    pub fn named(name: &str) -> Option<OldZone> {
        name.parse::<Tz>().ok().map(|tz| OldZone(Some(tz)))
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

    /// A reading a clock change skips takes the offset before the gap; one it repeats, the first.
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
