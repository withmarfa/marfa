//! The faults the server met since it started, held in memory so that a database that fails
//! does not lose them.

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, MutexGuard, PoisonError};

use crate::app::housekeeping::DAY_MS;
use crate::telemetry::Kind;

/// Places a fault is kept under; one more fault place is counted by the overflow entry.
pub const MAX_PLACES: usize = 64;
/// A fault place is forgotten this long after it last failed.
pub const KEPT_MS: i64 = DAY_MS;
pub const OVERFLOW: &str = "other";

pub const DESCRIPTION: &str = "The server met a fault it did not expect, and the request or job \
     it was doing failed. If this keeps happening, report it to the Marfa project with the \
     server's log from that time.";

/// Where a fault was met: never an id, so one fault in many places of one kind is one entry.
pub enum Place<'a> {
    Request {
        method: &'a str,
        route: Option<&'a str>,
    },
    Job(&'a str),
    WebhookSchedule,
}

impl Place<'_> {
    fn text(&self) -> String {
        match self {
            Place::Request {
                method,
                route: Some(route),
            } => format!("{method} {route}"),
            Place::Request {
                method,
                route: None,
            } => format!("{method} request"),
            Place::Job(name) => format!("job {name}"),
            Place::WebhookSchedule => "webhooks schedule".to_string(),
        }
    }
}

fn word(kind: Kind) -> &'static str {
    match kind {
        Kind::Database => "database",
        Kind::Panic => "panic",
        Kind::Internal => "internal",
    }
}

fn named(kind: Kind) -> &'static str {
    match kind {
        Kind::Database => "A database failure",
        Kind::Panic => "A panic",
        Kind::Internal => "An internal error",
    }
}

#[derive(Clone, Debug)]
pub struct Entry {
    pub reference: String,
    /// What failed and where, or `None` for the overflow entry.
    what: Option<(Kind, String)>,
    pub count: u64,
    pub first_ms: i64,
    pub last_ms: i64,
    /// Sent from memory while the database failed, so it is recorded and never announced.
    pub from_memory: bool,
}

impl Entry {
    pub fn title(&self) -> String {
        let times = match self.count {
            1 => "once".to_string(),
            count => format!("{count} times"),
        };
        match &self.what {
            Some((kind, place)) => format!("{} in {place}, {times}", named(*kind)),
            None => format!("Faults in more places than are listed, {times}"),
        }
    }
}

#[derive(Default)]
struct Held {
    entries: HashMap<String, Entry>,
    overflow: Option<Entry>,
}

impl Held {
    fn prune(&mut self, now_ms: i64) {
        self.entries
            .retain(|_, entry| now_ms - entry.last_ms < KEPT_MS);
        if self
            .overflow
            .as_ref()
            .is_some_and(|entry| now_ms - entry.last_ms >= KEPT_MS)
        {
            self.overflow = None;
        }
    }
}

#[derive(Default)]
pub struct Faults {
    held: Mutex<Held>,
}

impl Faults {
    fn held(&self) -> MutexGuard<'_, Held> {
        self.held.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Counts a fault, and answers its entry when this occurrence made the entry new.
    pub fn record(&self, kind: Kind, place: &Place<'_>, now_ms: i64) -> Option<Entry> {
        let place = place.text();
        let reference = format!("{}:{place}", word(kind));
        let mut held = self.held();
        held.prune(now_ms);
        if let Some(entry) = held.entries.get_mut(&reference) {
            entry.count += 1;
            entry.last_ms = now_ms;
            return None;
        }
        let fresh = |reference: String, what| Entry {
            reference,
            what,
            count: 1,
            first_ms: now_ms,
            last_ms: now_ms,
            from_memory: false,
        };
        if held.entries.len() < MAX_PLACES {
            let entry = fresh(reference.clone(), Some((kind, place)));
            held.entries.insert(reference, entry.clone());
            return Some(entry);
        }
        match held.overflow.as_mut() {
            Some(entry) => {
                entry.count += 1;
                entry.last_ms = now_ms;
                None
            }
            None => {
                let entry = fresh(OVERFLOW.to_string(), None);
                held.overflow = Some(entry.clone());
                Some(entry)
            }
        }
    }

    /// The entries that stand at `now_ms`, oldest first.
    pub fn standing(&self, now_ms: i64) -> Vec<Entry> {
        let mut held = self.held();
        held.prune(now_ms);
        let mut entries: Vec<Entry> = held.entries.values().cloned().collect();
        entries.sort_by(|a, b| (a.first_ms, &a.reference).cmp(&(b.first_ms, &b.reference)));
        entries.extend(held.overflow.clone());
        entries
    }

    /// The references that stand at `now_ms`.
    pub fn references(&self, now_ms: i64) -> HashSet<String> {
        self.standing(now_ms)
            .into_iter()
            .map(|entry| entry.reference)
            .collect()
    }

    /// Marks the entry first met at `first_ms` as sent from memory, unless it has since gone.
    pub fn sent_from_memory(&self, reference: &str, first_ms: i64) {
        let mut held = self.held();
        let Held { entries, overflow } = &mut *held;
        let entry = match entries.get_mut(reference) {
            Some(entry) => Some(entry),
            None => overflow
                .as_mut()
                .filter(|entry| entry.reference == reference),
        };
        if let Some(entry) = entry.filter(|entry| entry.first_ms == first_ms) {
            entry.from_memory = true;
        }
    }

    /// The entries sent from memory that stand at `now_ms`, each with when it was first met.
    pub fn from_memory(&self, now_ms: i64) -> Vec<(String, i64)> {
        self.standing(now_ms)
            .into_iter()
            .filter(|entry| entry.from_memory)
            .map(|entry| (entry.reference, entry.first_ms))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const JOB: Place<'static> = Place::Job("backup");

    #[test]
    fn a_fault_in_one_place_is_one_entry_counted_each_time() {
        let faults = Faults::default();
        let first = faults.record(Kind::Database, &JOB, 0).expect("a new entry");
        assert_eq!(first.reference, "database:job backup");
        assert!(faults.record(Kind::Database, &JOB, 10).is_none());
        let route = Place::Request {
            method: "POST",
            route: Some("/items/{id}"),
        };
        assert!(faults.record(Kind::Panic, &route, 20).is_some());
        let standing = faults.standing(30);
        assert_eq!(standing.len(), 2);
        assert_eq!(standing[0].count, 2);
        assert_eq!(
            standing[0].title(),
            "A database failure in job backup, 2 times"
        );
        assert_eq!(standing[1].reference, "panic:POST /items/{id}");
        assert_eq!(standing[1].title(), "A panic in POST /items/{id}, once");
    }

    #[test]
    fn an_entry_is_gone_a_day_after_its_last_fault_and_comes_back_new() {
        let faults = Faults::default();
        faults.record(Kind::Internal, &JOB, 0);
        faults.record(Kind::Internal, &JOB, 1_000);
        assert_eq!(faults.standing(KEPT_MS + 999).len(), 1);
        assert!(faults.standing(KEPT_MS + 1_000).is_empty());
        let again = faults
            .record(Kind::Internal, &JOB, KEPT_MS + 2_000)
            .expect("new again");
        assert_eq!((again.count, again.first_ms), (1, KEPT_MS + 2_000));
    }

    #[test]
    fn places_past_the_cap_are_counted_by_one_overflow_entry() {
        let faults = Faults::default();
        let names: Vec<String> = (0..MAX_PLACES + 3).map(|n| format!("job-{n}")).collect();
        let mut new = 0;
        for name in &names {
            if faults
                .record(Kind::Internal, &Place::Job(name), 0)
                .is_some()
            {
                new += 1;
            }
        }
        assert_eq!(new, MAX_PLACES + 1);
        let standing = faults.standing(0);
        assert_eq!(standing.len(), MAX_PLACES + 1);
        let overflow = standing.last().unwrap();
        assert_eq!((overflow.reference.as_str(), overflow.count), (OVERFLOW, 3));
        assert_eq!(
            overflow.title(),
            "Faults in more places than are listed, 3 times"
        );
    }

    #[test]
    fn only_the_entry_that_failed_to_record_is_marked_sent_from_memory() {
        let faults = Faults::default();
        let entry = faults.record(Kind::Database, &JOB, 0).unwrap();
        faults.sent_from_memory(&entry.reference, entry.first_ms + 1);
        assert!(faults.from_memory(0).is_empty());
        faults.sent_from_memory(&entry.reference, entry.first_ms);
        assert_eq!(faults.from_memory(0), [(entry.reference, 0)]);
    }
}
