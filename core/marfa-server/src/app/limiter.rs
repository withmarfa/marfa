//! The one rate limiter, held in memory. A window is fixed, opened by its first attempt, and
//! forgotten when the server stops.

use std::collections::HashMap;
use std::sync::{Mutex, PoisonError};

/// Most windows held at once. A key the table has no room for is counted in the lanes that
/// already hold it, so a flood of new addresses cannot grow the table or lift a limit that
/// was already counting.
const MAX_WINDOWS: usize = 100_000;
const PRUNE_ABOVE: usize = 1_024;
const PRUNE_EVERY_MS: i64 = 1_000;

/// The families of lanes a credential is counted in.
pub const REQUESTS: &str = "requests";
pub const KEY_OPERATIONS: &str = "key-operations";
pub const FILE_FETCHES: &str = "file-fetches";

#[derive(Clone, Debug)]
pub struct Lane {
    pub family: &'static str,
    pub key: String,
    pub limit: u64,
    pub window_ms: i64,
}

impl Lane {
    pub fn new(family: &'static str, key: String, limit: u64, window_ms: i64) -> Lane {
        Lane {
            family,
            key,
            limit,
            window_ms,
        }
    }

    /// One credential's allowance in the window the instance sets.
    pub fn credential(family: &'static str, handle: &str, limit: u64, window_ms: u64) -> Lane {
        Lane::new(
            family,
            handle.to_string(),
            limit,
            i64::try_from(window_ms).unwrap_or(i64::MAX),
        )
    }
}

/// What `Retry-After` and `retry_after` hold: whole seconds, rounded up, never fewer than one.
pub fn retry_seconds(wait_ms: i64) -> i64 {
    wait_ms.saturating_add(999).div_euclid(1000).max(1)
}

#[derive(Clone, Copy, Debug)]
struct Window {
    count: u64,
    ends_ms: i64,
}

#[derive(Debug, Default)]
struct Windows {
    families: HashMap<&'static str, HashMap<String, Window>>,
    held: usize,
    pruned_ms: i64,
}

impl Windows {
    fn live(&self, lane: &Lane, now_ms: i64) -> Option<Window> {
        self.families
            .get(lane.family)?
            .get(&lane.key)
            .copied()
            .filter(|window| window.ends_ms > now_ms)
    }

    /// Whether the window was recorded.
    fn record(&mut self, lane: &Lane, window: Window) -> bool {
        let family = self.families.entry(lane.family).or_default();
        if let Some(held) = family.get_mut(&lane.key) {
            *held = window;
            return true;
        }
        if self.held >= MAX_WINDOWS {
            return false;
        }
        family.insert(lane.key.clone(), window);
        self.held += 1;
        true
    }

    fn prune(&mut self, now_ms: i64) {
        if self.held <= PRUNE_ABOVE || now_ms.saturating_sub(self.pruned_ms) < PRUNE_EVERY_MS {
            return;
        }
        for family in self.families.values_mut() {
            family.retain(|_, window| window.ends_ms > now_ms);
        }
        self.held = self.families.values().map(HashMap::len).sum();
        self.pruned_ms = now_ms;
    }
}

#[derive(Debug, Default)]
pub struct Limiter {
    windows: Mutex<Windows>,
}

impl Limiter {
    /// Counts one attempt in each lane, in order, and stops counting at the first lane the
    /// attempt passes the limit of, so that lane's excess never reaches the next. Answers
    /// `None` when the attempt is allowed, and otherwise the milliseconds until the latest end
    /// among the lanes the next attempt would find spent.
    pub fn admit(&self, now_ms: i64, lanes: &[Lane]) -> Option<i64> {
        let mut windows = self.windows.lock().unwrap_or_else(PoisonError::into_inner);
        windows.prune(now_ms);
        let mut refused = false;
        let mut end: Option<i64> = None;
        for lane in lanes {
            let held = windows.live(lane, now_ms);
            let (count, ends_ms) = if refused {
                held.map_or((0, now_ms), |window| (window.count, window.ends_ms))
            } else {
                let (count, ends_ms) = held
                    .map_or((0, now_ms.saturating_add(lane.window_ms)), |window| {
                        (window.count, window.ends_ms)
                    });
                let count = count.saturating_add(1);
                windows.record(lane, Window { count, ends_ms });
                refused = count > lane.limit;
                (count, ends_ms)
            };
            if count >= lane.limit {
                end = end.max(Some(ends_ms));
            }
        }
        if refused {
            end.map(|end| end - now_ms)
        } else {
            None
        }
    }

    /// Drops every window of `family` whose key `matches`.
    pub fn forget(&self, family: &'static str, matches: impl Fn(&str) -> bool) {
        let mut windows = self.windows.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(held) = windows.families.get_mut(family) {
            held.retain(|key, _| !matches(key));
        }
        windows.held = windows.families.values().map(HashMap::len).sum();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MINUTE: i64 = 60_000;

    fn lane(family: &'static str, key: &str, limit: u64) -> Lane {
        Lane::new(family, key.to_string(), limit, MINUTE)
    }

    #[test]
    fn a_lane_allows_its_limit_then_waits_out_its_window() {
        let limiter = Limiter::default();
        let one = [lane("a", "x", 2)];
        assert_eq!(limiter.admit(0, &one), None);
        assert_eq!(limiter.admit(1_000, &one), None);
        assert_eq!(limiter.admit(1_500, &one), Some(MINUTE - 1_500));
        assert_eq!(limiter.admit(MINUTE - 1, &one), Some(1));
        assert_eq!(limiter.admit(MINUTE, &one), None);
    }

    #[test]
    fn a_lane_counts_each_key_and_each_family_on_its_own() {
        let limiter = Limiter::default();
        assert_eq!(limiter.admit(0, &[lane("a", "x", 1)]), None);
        assert!(limiter.admit(1, &[lane("a", "x", 1)]).is_some());
        assert_eq!(limiter.admit(1, &[lane("a", "y", 1)]), None);
        assert_eq!(limiter.admit(1, &[lane("b", "x", 1)]), None);
    }

    #[test]
    fn a_refusing_lane_keeps_its_excess_from_the_next() {
        let limiter = Limiter::default();
        let both = [lane("address", "a", 2), lane("account", "z", 100)];
        assert_eq!(limiter.admit(0, &both), None);
        assert_eq!(limiter.admit(0, &both), None);
        for _ in 0..5 {
            assert_eq!(limiter.admit(1_000, &both), Some(MINUTE - 1_000));
        }
        let account = [lane("account", "z", 100)];
        let counted = (0..98).take_while(|_| limiter.admit(2_000, &account).is_none());
        assert_eq!(counted.count(), 98);
        assert!(limiter.admit(2_000, &account).is_some());
    }

    #[test]
    fn the_wait_runs_to_the_latest_lane_that_is_spent() {
        let limiter = Limiter::default();
        let long = Lane::new("long", "k".into(), 1, 50 * MINUTE);
        assert_eq!(limiter.admit(0, std::slice::from_ref(&long)), None);
        let both = [lane("short", "k", 1), long];
        assert_eq!(limiter.admit(0, &both), Some(50 * MINUTE));
    }

    #[test]
    fn a_window_changes_length_only_when_a_new_one_opens() {
        let limiter = Limiter::default();
        assert_eq!(limiter.admit(0, &[lane("a", "x", 1)]), None);
        let shorter = [Lane::new("a", "x".into(), 1, 1_000)];
        assert_eq!(limiter.admit(10, &shorter), Some(MINUTE - 10));
    }

    #[test]
    fn forgetting_drops_only_the_keys_that_match() {
        let limiter = Limiter::default();
        for key in ["a|1", "a|2", "b|1"] {
            assert_eq!(limiter.admit(0, &[lane("f", key, 1)]), None);
        }
        limiter.forget("f", |key| key.starts_with("a|"));
        assert_eq!(limiter.admit(1, &[lane("f", "a|1", 1)]), None);
        assert!(limiter.admit(1, &[lane("f", "b|1", 1)]).is_some());
    }

    #[test]
    fn ended_windows_go_once_the_table_grows() {
        let limiter = Limiter::default();
        for n in 0..(PRUNE_ABOVE + 10) {
            assert_eq!(limiter.admit(0, &[lane("a", &n.to_string(), 1)]), None);
        }
        assert_eq!(limiter.admit(MINUTE, &[lane("a", "late", 1)]), None);
        let windows = limiter.windows.lock().unwrap();
        assert_eq!(windows.held, 1);
    }

    #[test]
    fn a_full_table_still_counts_the_keys_it_holds_and_records_no_more() {
        let limiter = Limiter::default();
        {
            let mut windows = limiter.windows.lock().unwrap();
            let live = Window {
                count: 0,
                ends_ms: MINUTE,
            };
            let family = windows.families.entry("a").or_default();
            for n in 0..MAX_WINDOWS {
                family.insert(n.to_string(), live);
            }
            windows.held = MAX_WINDOWS;
        }
        let known = [lane("a", "7", 1)];
        assert_eq!(limiter.admit(1, &known), None);
        assert!(limiter.admit(2, &known).is_some());
        let stranger = [lane("a", "stranger", 1)];
        assert_eq!(limiter.admit(3, &stranger), None);
        assert_eq!(limiter.admit(4, &stranger), None);
        assert_eq!(limiter.windows.lock().unwrap().held, MAX_WINDOWS);
    }
}
