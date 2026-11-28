//! What a folder watch's process costs: kept in the watch record for a reader,
//! and reported once a day, and at the start, through the core's telemetry.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime};

use marfa_telemetry::process;
use serde::{Deserialize, Serialize};

use super::Folder;
use crate::telemetry::WatchReport;

/// How long after the watch starts its first report waits for every folder to
/// be watched, so that it can count folders and files.
pub(super) const START_WAIT: Duration = Duration::from_secs(5);

/// The time from one report to the next.
pub(super) const EVERY: Duration = Duration::from_secs(24 * 60 * 60);

static FULL_PASSES: AtomicU64 = AtomicU64::new(0);
static QUICK_PASSES: AtomicU64 = AtomicU64::new(0);

/// Counts a pass that a folder's watch started.
pub(super) fn passed(full: bool) {
    let passes = if full { &FULL_PASSES } else { &QUICK_PASSES };
    passes.fetch_add(1, Ordering::Relaxed);
}

/// What the watch process has used since it started, as the record holds it.
/// `None` where the system does not say.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct Used {
    pub(super) cpu_millis: Option<u64>,
    pub(super) resident_bytes: Option<u64>,
    pub(super) peak_resident_bytes: Option<u64>,
    pub(super) full_passes: u64,
    pub(super) quick_passes: u64,
}

impl Used {
    pub(super) fn now() -> Used {
        Used {
            cpu_millis: process::cpu()
                .map(|cpu| u64::try_from(cpu.total().as_millis()).unwrap_or(u64::MAX)),
            resident_bytes: process::resident_bytes(),
            peak_resident_bytes: process::peak_resident_bytes(),
            full_passes: FULL_PASSES.load(Ordering::Relaxed),
            quick_passes: QUICK_PASSES.load(Ordering::Relaxed),
        }
    }
}

/// When the watch reports. Time is the wall clock's, so a laptop's sleep
/// counts, a clock set back counts as no time passed, and any one step counts
/// as at most a day, so a clock that jumps forward adds no more than that.
pub(super) struct Schedule {
    seen: SystemTime,
    running: Duration,
    since_report: Option<Duration>,
    cpu_millis: u64,
    full_passes: u64,
    quick_passes: u64,
}

impl Schedule {
    pub(super) fn new(began: SystemTime) -> Schedule {
        Schedule {
            seen: began,
            running: Duration::ZERO,
            since_report: None,
            cpu_millis: 0,
            full_passes: 0,
            quick_passes: 0,
        }
    }

    /// Takes the report due at `now`, if any: the first once every folder is
    /// watched or after `START_WAIT`, the rest a day apart. `followed` is the
    /// folders held and their files, `None` while none is counted.
    pub(super) fn take(
        &mut self,
        now: SystemTime,
        all_watched: bool,
        followed: (u64, Option<u64>),
    ) -> Option<WatchReport> {
        let passed = now
            .duration_since(self.seen)
            .unwrap_or(Duration::ZERO)
            .min(EVERY);
        self.seen = now;
        self.running = self.running.saturating_add(passed);
        if let Some(since) = &mut self.since_report {
            *since = since.saturating_add(passed);
        }
        let due = match self.since_report {
            None => all_watched || self.running >= START_WAIT,
            Some(since) => since >= EVERY,
        };
        if !due {
            return None;
        }
        self.since_report = Some(Duration::ZERO);
        let used = Used::now();
        let report = WatchReport {
            cpu_millis: used
                .cpu_millis
                .map(|total| total.saturating_sub(self.cpu_millis)),
            resident_bytes: used.resident_bytes,
            peak_resident_bytes: used.peak_resident_bytes,
            uptime_seconds: self.running.as_secs(),
            folders: followed.0,
            files: followed.1,
            full_passes: used.full_passes.saturating_sub(self.full_passes),
            quick_passes: used.quick_passes.saturating_sub(self.quick_passes),
            release: env!("CARGO_PKG_VERSION"),
        };
        self.cpu_millis = used.cpu_millis.unwrap_or(self.cpu_millis);
        self.full_passes = used.full_passes;
        self.quick_passes = used.quick_passes;
        Some(report)
    }
}

impl Folder {
    /// How many files the folder follows.
    pub(super) fn files_followed(&self) -> Option<u64> {
        let conn = self.core.conn().ok()?;
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM folder_files", [], |row| row.get(0))
            .ok()?;
        u64::try_from(count).ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(seconds: u64) -> SystemTime {
        SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000 + seconds)
    }

    #[test]
    fn the_first_report_waits_for_every_folder_or_the_wait_and_the_rest_a_day() {
        let wait = START_WAIT.as_secs();
        let day = EVERY.as_secs();
        let mut schedule = Schedule::new(at(0));
        assert!(schedule.take(at(0), false, (0, None)).is_none());
        assert!(schedule.take(at(wait - 1), false, (1, None)).is_none());
        let first = schedule.take(at(wait), false, (1, None)).unwrap();
        assert_eq!(first.uptime_seconds, wait);
        assert!(schedule.take(at(wait), true, (1, Some(5))).is_none());
        assert!(
            schedule
                .take(at(wait + day - 1), true, (1, Some(5)))
                .is_none()
        );
        let next = schedule.take(at(wait + day), true, (2, Some(7))).unwrap();
        assert_eq!((next.folders, next.files), (2, Some(7)));
        assert_eq!(next.uptime_seconds, wait + day);

        // Every folder watched sends the first at once.
        let mut watched = Schedule::new(at(0));
        assert!(watched.take(at(0), true, (3, Some(3))).is_some());
    }

    #[test]
    fn a_report_leaves_out_the_files_until_a_folder_has_been_counted() {
        let mut schedule = Schedule::new(at(0));
        let report = schedule.take(at(0), true, (2, None)).unwrap();
        assert_eq!((report.folders, report.files), (2, None));
    }

    #[test]
    fn a_clock_set_back_counts_as_no_time_passed() {
        let day = EVERY.as_secs();
        let mut schedule = Schedule::new(at(1_000));
        assert!(schedule.take(at(1_000), true, (1, Some(1))).is_some());
        // Half a day passes, the clock goes back a week, and a quarter of a
        // day passes on the earlier time.
        assert!(
            schedule
                .take(at(1_000 + day / 2), true, (1, Some(1)))
                .is_none()
        );
        let earlier = at(1_000 + day / 2)
            .checked_sub(Duration::from_secs(7 * day))
            .unwrap();
        assert!(schedule.take(earlier, true, (1, Some(1))).is_none());
        let later = earlier + Duration::from_secs(day / 4);
        assert!(schedule.take(later, true, (1, Some(1))).is_none());
        // Three quarters of a day have passed in all, not a week and a half.
        let due = later + Duration::from_secs(day / 4);
        let report = schedule.take(due, true, (1, Some(1))).unwrap();
        assert_eq!(report.uptime_seconds, day);
    }

    #[test]
    fn a_step_of_years_counts_as_a_day_and_sends_one_report() {
        let day = EVERY.as_secs();
        // A clock that reads 1970 when the watch starts and the time now once
        // the network sets it.
        let mut schedule = Schedule::new(SystemTime::UNIX_EPOCH);
        let years = Duration::from_secs(50 * 365 * day);
        let first = schedule
            .take(SystemTime::UNIX_EPOCH + years, true, (1, Some(1)))
            .unwrap();
        assert_eq!(first.uptime_seconds, day);
        let after = SystemTime::UNIX_EPOCH + years + Duration::from_secs(60);
        assert!(schedule.take(after, true, (1, Some(1))).is_none());
        let next = schedule
            .take(after + Duration::from_secs(day), true, (1, Some(1)))
            .unwrap();
        assert_eq!(next.uptime_seconds, 2 * day + 60);
    }

    #[test]
    fn a_report_counts_the_passes_since_the_last() {
        let mut schedule = Schedule::new(at(0));
        passed(true);
        let first = schedule.take(at(0), true, (1, Some(3))).unwrap();
        assert_eq!(first.full_passes, 1, "{first:?}");
        passed(true);
        passed(false);
        passed(false);
        let second = schedule
            .take(at(EVERY.as_secs()), true, (1, Some(3)))
            .unwrap();
        assert_eq!((second.full_passes, second.quick_passes), (1, 2));
        assert!(second.cpu_millis.is_some());
    }
}
