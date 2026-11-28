//! What a folder watch's process costs: kept in the watch record for a reader,
//! and reported once a day, and at the start, through the core's telemetry.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use marfa_telemetry::process;
use serde::{Deserialize, Serialize};

use super::Folder;
use crate::telemetry::WatchReport;

/// How long after the watch starts its first report waits for a folder to be
/// watched, so that it can count folders and files.
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

/// When the watch reports, and what it had used at its last report.
pub(super) struct Schedule {
    began: Instant,
    next: Option<Instant>,
    cpu_millis: u64,
    full_passes: u64,
    quick_passes: u64,
}

impl Schedule {
    pub(super) fn new(began: Instant) -> Schedule {
        Schedule {
            began,
            next: None,
            cpu_millis: 0,
            full_passes: 0,
            quick_passes: 0,
        }
    }

    /// Takes the report that is due at `now`, if one is. The first is due once
    /// a folder is watched, or after `START_WAIT`; the rest, a day apart.
    pub(super) fn take(
        &mut self,
        now: Instant,
        watched: bool,
        followed: (u64, u64),
    ) -> Option<WatchReport> {
        let due = match self.next {
            None => watched || now.saturating_duration_since(self.began) >= START_WAIT,
            Some(at) => now >= at,
        };
        if !due {
            return None;
        }
        self.next = Some(now + EVERY);
        let used = Used::now();
        let report = WatchReport {
            cpu_millis: used
                .cpu_millis
                .map(|total| total.saturating_sub(self.cpu_millis)),
            resident_bytes: used.resident_bytes,
            peak_resident_bytes: used.peak_resident_bytes,
            uptime_seconds: now.saturating_duration_since(self.began).as_secs(),
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

    #[test]
    fn the_first_report_waits_for_a_folder_or_the_wait_and_the_rest_a_day() {
        let began = Instant::now();
        let mut schedule = Schedule::new(began);
        assert!(schedule.take(began, false, (0, 0)).is_none());
        assert!(
            schedule
                .take(began + START_WAIT - Duration::from_secs(1), false, (0, 0))
                .is_none()
        );
        let first = schedule.take(began + START_WAIT, false, (0, 0)).unwrap();
        assert_eq!(first.uptime_seconds, START_WAIT.as_secs());
        assert!(schedule.take(began + START_WAIT, true, (1, 5)).is_none());
        let at = began + START_WAIT + EVERY;
        assert!(
            schedule
                .take(at - Duration::from_secs(1), true, (1, 5))
                .is_none()
        );
        let next = schedule.take(at, true, (2, 7)).unwrap();
        assert_eq!((next.folders, next.files), (2, 7));
        assert_eq!(next.uptime_seconds, (START_WAIT + EVERY).as_secs());

        // A folder watched sends the first at once.
        let mut watched = Schedule::new(began);
        assert!(watched.take(began, true, (1, 3)).is_some());
    }

    #[test]
    fn a_report_counts_the_passes_since_the_last() {
        let began = Instant::now();
        let mut schedule = Schedule::new(began);
        passed(true);
        let first = schedule.take(began, true, (1, 3)).unwrap();
        assert!(first.full_passes >= 1, "{first:?}");
        // Other tests in a process that is not nextest's count passes too.
        passed(true);
        passed(false);
        passed(false);
        let second = schedule.take(began + EVERY, true, (1, 3)).unwrap();
        assert!(
            second.full_passes >= 1 && second.quick_passes >= 2,
            "{second:?}"
        );
        assert!(second.cpu_millis.is_some());
    }
}
