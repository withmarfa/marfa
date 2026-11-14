//! Deliveries left due because their maker's share of lookups is full, and for how long.

use std::collections::HashMap;
use std::time::{Duration, Instant};

/// How long a delivery may be left due for want of a lookup slot before its next attempt counts.
pub const LIMIT: Duration = Duration::from_secs(10);
/// A delivery that left the sender by another way, such as a deleted subscription, is forgotten after this.
const FORGOTTEN: Duration = Duration::from_secs(3_600);

struct Entry {
    maker: String,
    since: Instant,
    /// Held back until its maker has room for a lookup or the limit passes.
    waiting: bool,
}

#[derive(Default)]
pub struct Deferred {
    entries: HashMap<i64, Entry>,
}

impl Deferred {
    /// A delivery found its maker's share full. It waits unless the share has room again.
    pub fn defer(&mut self, seq: i64, maker: &str, now: Instant, waiting: bool) {
        let entry = self.entries.entry(seq).or_insert_with(|| Entry {
            maker: maker.to_string(),
            since: now,
            waiting,
        });
        entry.waiting = waiting;
    }

    /// The delivery's attempt ended some other way.
    pub fn settle(&mut self, seq: i64) {
        self.entries.remove(&seq);
    }

    /// A slot was given back, so each waiting delivery whose maker has room is offered a lookup again.
    pub fn release(&mut self, has_room: impl Fn(&str) -> bool) {
        for entry in self.entries.values_mut() {
            if entry.waiting && has_room(&entry.maker) {
                entry.waiting = false;
            }
        }
    }

    /// Frees each delivery whose limit has passed, and forgets those long gone.
    pub fn expire(&mut self, now: Instant) {
        self.entries.retain(|_, entry| {
            if now >= entry.since + LIMIT {
                entry.waiting = false;
            }
            now < entry.since + FORGOTTEN
        });
    }

    /// Whether the delivery's next attempt counts without a slot.
    pub fn spent(&self, seq: i64, now: Instant) -> bool {
        self.entries
            .get(&seq)
            .is_some_and(|entry| now >= entry.since + LIMIT)
    }

    pub fn waiting(&self) -> impl Iterator<Item = i64> + '_ {
        self.entries
            .iter()
            .filter(|(_, entry)| entry.waiting)
            .map(|(seq, _)| *seq)
    }

    pub fn any_waiting(&self) -> bool {
        self.waiting().next().is_some()
    }

    /// The first moment a waiting delivery reaches its limit.
    pub fn next_limit(&self) -> Option<Instant> {
        self.entries
            .values()
            .filter(|entry| entry.waiting)
            .map(|entry| entry.since + LIMIT)
            .min()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_delivery_waits_until_a_slot_is_given_back() {
        let start = Instant::now();
        let mut deferred = Deferred::default();
        deferred.defer(7, "a", start, true);
        deferred.defer(8, "b", start, true);
        deferred.release(|maker| maker == "a");
        assert_eq!(deferred.waiting().collect::<Vec<_>>(), vec![8]);
        deferred.release(|_| true);
        assert!(!deferred.any_waiting());
        assert!(!deferred.spent(7, start + Duration::from_secs(1)));
    }

    #[test]
    fn a_slot_given_back_during_the_attempt_means_no_wait() {
        let mut deferred = Deferred::default();
        deferred.defer(7, "a", Instant::now(), false);
        assert!(!deferred.any_waiting());
    }

    #[test]
    fn the_limit_counts_from_the_first_deferral_however_often_it_is_offered_again() {
        let start = Instant::now();
        let mut deferred = Deferred::default();
        deferred.defer(7, "a", start, true);
        deferred.release(|_| true);
        deferred.defer(7, "a", start + Duration::from_secs(6), true);
        assert_eq!(deferred.next_limit(), Some(start + LIMIT));
        deferred.expire(start + LIMIT);
        assert!(!deferred.any_waiting());
        assert!(deferred.spent(7, start + LIMIT));
    }

    #[test]
    fn a_settled_delivery_starts_again_and_a_gone_one_is_forgotten() {
        let start = Instant::now();
        let mut deferred = Deferred::default();
        deferred.defer(7, "a", start, true);
        deferred.defer(8, "a", start, false);
        deferred.settle(7);
        assert!(!deferred.any_waiting());
        deferred.expire(start + FORGOTTEN);
        assert!(!deferred.spent(8, start + FORGOTTEN));
        assert_eq!(deferred.next_limit(), None);
    }
}
