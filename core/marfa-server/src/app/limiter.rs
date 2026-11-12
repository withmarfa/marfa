//! The one rate limiter, in memory: fixed windows, each opened by its first attempt.

use std::collections::{BTreeSet, HashMap};
use std::sync::{Arc, Mutex, PoisonError};

/// Most windows a family holds beside its pinned ones; the families together bound the table.
const ROOM: usize = 8_192;
const PRUNE_EVERY_MS: i64 = 1_000;

/// The families of lanes a credential is counted in.
pub const REQUESTS: &str = "requests";
pub const KEY_OPERATIONS: &str = "key-operations";
pub const FILE_FETCHES: &str = "file-fetches";
pub const INBOUND_DELIVERIES: &str = "inbound-deliveries";

#[derive(Clone, Debug)]
pub struct Lane {
    pub family: &'static str,
    pub key: String,
    pub limit: u64,
    pub window_ms: i64,
    pub pinned: bool,
}

impl Lane {
    pub fn new(family: &'static str, key: String, limit: u64, window_ms: i64) -> Lane {
        Lane {
            family,
            key,
            limit,
            window_ms,
            pinned: false,
        }
    }

    /// Never dropped to make room; only the owner's, the instance's and other emails' keys.
    pub fn pinned(family: &'static str, key: String, limit: u64, window_ms: i64) -> Lane {
        Lane {
            pinned: true,
            ..Lane::new(family, key, limit, window_ms)
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

/// What `Retry-After` and `retry_after` hold: whole seconds, rounded up, from one to a day.
pub fn retry_seconds(wait_ms: i64) -> i64 {
    wait_ms
        .saturating_add(999)
        .div_euclid(1000)
        .clamp(1, 86_400)
}

#[derive(Clone, Copy, Debug)]
struct Window {
    count: u64,
    ends_ms: i64,
}

/// `keys` and `by_end` share each key's one allocation.
#[derive(Debug, Default)]
struct Family {
    pinned: HashMap<String, Window>,
    keys: HashMap<Arc<str>, Window>,
    by_end: BTreeSet<(i64, Arc<str>)>,
}

impl Family {
    fn live(&self, key: &str, now_ms: i64) -> Option<Window> {
        self.pinned
            .get(key)
            .or_else(|| self.keys.get(key))
            .copied()
            .filter(|window| window.ends_ms > now_ms)
    }

    fn unhold(&mut self, key: &str) -> Option<Arc<str>> {
        let (key, window) = self.keys.remove_entry(key)?;
        self.by_end.remove(&(window.ends_ms, Arc::clone(&key)));
        Some(key)
    }

    /// A key once pinned stays pinned while its window lasts.
    fn record(&mut self, lane: &Lane, window: Window) {
        if let Some(held) = self.pinned.get_mut(&lane.key) {
            *held = window;
            return;
        }
        let held = self.unhold(&lane.key);
        if lane.pinned {
            self.pinned.insert(lane.key.clone(), window);
            return;
        }
        if held.is_none()
            && self.keys.len() >= ROOM
            && let Some((_, soonest)) = self.by_end.pop_first()
        {
            self.keys.remove(&soonest);
        }
        let key = held.unwrap_or_else(|| Arc::from(lane.key.as_str()));
        self.by_end.insert((window.ends_ms, Arc::clone(&key)));
        self.keys.insert(key, window);
    }

    fn prune(&mut self, now_ms: i64) {
        self.pinned.retain(|_, window| window.ends_ms > now_ms);
        while self
            .by_end
            .first()
            .is_some_and(|(ends_ms, _)| *ends_ms <= now_ms)
        {
            if let Some((_, key)) = self.by_end.pop_first() {
                self.keys.remove(&key);
            }
        }
    }

    fn forget(&mut self, matches: impl Fn(&str) -> bool) {
        self.pinned.retain(|key, _| !matches(key));
        let Family { keys, by_end, .. } = self;
        keys.retain(|key, window| {
            let drop = matches(key);
            if drop {
                by_end.remove(&(window.ends_ms, Arc::clone(key)));
            }
            !drop
        });
    }
}

#[derive(Debug, Default)]
struct Windows {
    families: HashMap<&'static str, Family>,
    pruned_ms: i64,
}

impl Windows {
    fn live(&self, lane: &Lane, now_ms: i64) -> Option<Window> {
        self.families.get(lane.family)?.live(&lane.key, now_ms)
    }

    fn record(&mut self, lane: &Lane, window: Window) {
        self.families
            .entry(lane.family)
            .or_default()
            .record(lane, window);
    }

    fn prune(&mut self, now_ms: i64) {
        if now_ms.saturating_sub(self.pruned_ms) < PRUNE_EVERY_MS {
            return;
        }
        for family in self.families.values_mut() {
            family.prune(now_ms);
        }
        self.pruned_ms = now_ms;
    }
}

#[derive(Debug, Default)]
pub struct Limiter {
    windows: Mutex<Windows>,
}

impl Limiter {
    /// Counts up to the first refusing lane; a refusal is the ms to the latest spent lane.
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

    /// Takes one attempt back from each lane whose window was already open at `admitted_ms`,
    /// leaving every window's end where it was.
    pub fn give_back(&self, admitted_ms: i64, now_ms: i64, lanes: &[Lane]) {
        let mut windows = self.windows.lock().unwrap_or_else(PoisonError::into_inner);
        for lane in lanes {
            let Some(window) = windows.live(lane, now_ms) else {
                continue;
            };
            if window.ends_ms.saturating_sub(lane.window_ms) > admitted_ms {
                continue;
            }
            let count = window.count.saturating_sub(1);
            windows.record(lane, Window { count, ..window });
        }
    }

    /// Drops every window of `family` whose key `matches`.
    pub fn forget(&self, family: &'static str, matches: impl Fn(&str) -> bool) {
        let mut windows = self.windows.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(held) = windows.families.get_mut(family) {
            held.forget(matches);
        }
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
    fn a_clock_moved_back_never_asks_for_more_than_a_day() {
        let limiter = Limiter::default();
        let one = [lane("a", "x", 1)];
        let later = 30 * 24 * 60 * MINUTE;
        assert_eq!(limiter.admit(later, &one), None);
        let wait = limiter.admit(0, &one).unwrap();
        assert_eq!(retry_seconds(wait), 86_400);
        assert_eq!(retry_seconds(i64::MAX), 86_400);
        assert_eq!(retry_seconds(-5_000), 1);
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

    fn held(limiter: &Limiter, family: &'static str) -> (usize, usize) {
        let windows = limiter.windows.lock().unwrap();
        windows.families.get(family).map_or((0, 0), |family| {
            assert_eq!(family.keys.len(), family.by_end.len());
            (family.keys.len(), family.pinned.len())
        })
    }

    #[test]
    fn ended_windows_go_within_a_second_of_ending() {
        let limiter = Limiter::default();
        for n in 0..10 {
            assert_eq!(limiter.admit(0, &[lane("a", &n.to_string(), 1)]), None);
        }
        let pinned = [Lane::pinned("a", "owner".into(), 1, MINUTE)];
        assert_eq!(limiter.admit(0, &pinned), None);
        assert_eq!(limiter.admit(MINUTE - 1, &[lane("b", "x", 1)]), None);
        assert_eq!(limiter.admit(MINUTE + 998, &[lane("b", "y", 1)]), None);
        assert_eq!(held(&limiter, "a"), (10, 1));
        assert_eq!(limiter.admit(MINUTE + 999, &[lane("b", "z", 1)]), None);
        assert_eq!(held(&limiter, "a"), (0, 0));
    }

    #[test]
    fn a_full_family_drops_the_window_that_ends_soonest() {
        let limiter = Limiter::default();
        for n in 0..ROOM {
            let at = i64::try_from(n).unwrap();
            assert_eq!(limiter.admit(at, &[lane("a", &n.to_string(), 1)]), None);
        }
        let at = i64::try_from(ROOM).unwrap();
        assert_eq!(limiter.admit(at, &[lane("a", "new", 1)]), None);
        assert_eq!(held(&limiter, "a"), (ROOM, 0));
        assert!(limiter.admit(at, &[lane("a", "1", 1)]).is_some());
        assert_eq!(limiter.admit(at, &[lane("a", "0", 1)]), None);
    }

    #[test]
    fn a_pinned_window_outlasts_a_full_family_and_takes_none_of_its_room() {
        let limiter = Limiter::default();
        let owner = [Lane::pinned("a", "owner".into(), 1, MINUTE)];
        assert_eq!(limiter.admit(0, &owner), None);
        for n in 0..(2 * ROOM) {
            assert_eq!(limiter.admit(1, &[lane("a", &n.to_string(), 1)]), None);
        }
        assert_eq!(held(&limiter, "a"), (ROOM, 1));
        assert!(limiter.admit(2, &owner).is_some());
    }

    #[test]
    fn a_held_window_moves_to_the_pinned_ones_and_keeps_its_count() {
        let limiter = Limiter::default();
        assert_eq!(limiter.admit(0, &[lane("a", "owner", 2)]), None);
        let pinned = [Lane::pinned("a", "owner".into(), 2, MINUTE)];
        assert_eq!(limiter.admit(1, &pinned), None);
        assert_eq!(held(&limiter, "a"), (0, 1));
        assert!(limiter.admit(2, &[lane("a", "owner", 2)]).is_some());
        assert_eq!(held(&limiter, "a"), (0, 1));
    }

    #[test]
    fn a_window_reopened_after_it_ends_is_ordered_by_its_new_end() {
        let limiter = Limiter::default();
        assert_eq!(limiter.admit(0, &[lane("a", "old", 1)]), None);
        assert_eq!(limiter.admit(10, &[lane("a", "x", 1)]), None);
        assert_eq!(limiter.admit(MINUTE - 500, &[lane("b", "y", 1)]), None);
        assert_eq!(limiter.admit(MINUTE + 5, &[lane("a", "old", 1)]), None);
        assert_eq!(held(&limiter, "a"), (2, 0));
        let windows = limiter.windows.lock().unwrap();
        let order: Vec<_> = windows.families["a"]
            .by_end
            .iter()
            .map(|(ends_ms, key)| (*ends_ms, key.as_ref()))
            .collect();
        assert_eq!(order, [(MINUTE + 10, "x"), (2 * MINUTE + 5, "old")]);
    }

    #[test]
    fn forgetting_reaches_pinned_windows_and_the_order() {
        let limiter = Limiter::default();
        assert_eq!(
            limiter.admit(0, &[Lane::pinned("f", "a|1".into(), 1, MINUTE)]),
            None
        );
        assert_eq!(limiter.admit(0, &[lane("f", "a|2", 1)]), None);
        limiter.forget("f", |key| key.starts_with("a|"));
        assert_eq!(held(&limiter, "f"), (0, 0));
    }

    fn fill(limiter: &Limiter, family: &'static str, keys: usize) {
        for n in 0..keys {
            assert_eq!(limiter.admit(0, &[lane(family, &n.to_string(), 1)]), None);
        }
    }

    #[test]
    fn a_full_family_still_counts_every_new_key_in_a_window_of_its_own() {
        for family in [REQUESTS, INBOUND_DELIVERIES] {
            let limiter = Limiter::default();
            fill(&limiter, family, ROOM);
            let now = 1;
            for key in ["new-1", "new-2", "new-3"] {
                let fresh = [lane(family, key, 1)];
                assert_eq!(limiter.admit(now, &fresh), None, "{family} {key}");
                assert!(limiter.admit(now, &fresh).is_some(), "{family} {key}");
            }
        }
    }
}
