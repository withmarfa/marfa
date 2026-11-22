//! Entries sent from memory, so the log route records them without announcing them again.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

/// An entry's kind and reference.
pub type Key = (String, String);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mark {
    /// Queued for the sender, which has not yet loaded the subscriptions.
    Pending(u64),
    /// Handed to at least one subscription's send.
    Sent(u64),
}

impl Mark {
    pub fn serial(self) -> u64 {
        match self {
            Mark::Pending(serial) | Mark::Sent(serial) => serial,
        }
    }
}

#[derive(Default, Debug)]
pub struct Memory {
    marks: Mutex<HashMap<Key, Mark>>,
    serial: AtomicU64,
}

impl Memory {
    fn marks(&self) -> MutexGuard<'_, HashMap<Key, Mark>> {
        self.marks.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Checks freshness under the commit snapshot's lock before marking.
    pub fn begin(
        self: &Arc<Memory>,
        kind: &str,
        reference: &str,
        current: impl FnOnce() -> bool,
    ) -> Option<Pending> {
        let key = (kind.to_string(), reference.to_string());
        let mut marks = self.marks();
        if marks.contains_key(&key) || !current() {
            return None;
        }
        let serial = self.serial.fetch_add(1, Ordering::Relaxed);
        marks.insert(key.clone(), Mark::Pending(serial));
        Some(Pending {
            memory: self.clone(),
            key,
            serial,
            handed: false,
        })
    }

    pub fn get(&self, kind: &str, reference: &str) -> Option<Mark> {
        self.marks()
            .get(&(kind.to_string(), reference.to_string()))
            .copied()
    }

    pub fn snapshot(&self) -> HashMap<Key, Mark> {
        self.marks().clone()
    }

    /// Drops each mark named with the serial it had, leaving one made since.
    pub fn settle(&self, settled: &[(Key, u64)]) {
        let mut marks = self.marks();
        for (key, serial) in settled {
            if marks.get(key).is_some_and(|mark| mark.serial() == *serial) {
                marks.remove(key);
            }
        }
    }

    /// Drops every mark `keep` refuses, deciding under the lock that `begin` takes.
    pub fn retain(&self, keep: impl Fn(&Key) -> bool) {
        self.marks().retain(|key, _| keep(key));
    }

    pub fn forget(&self, kind: &str, reference: &str) {
        self.marks()
            .remove(&(kind.to_string(), reference.to_string()));
    }
}

/// Marked sent once handed to a send, and unmarked when dropped, so the log route announces it.
#[derive(Debug)]
pub struct Pending {
    memory: Arc<Memory>,
    key: Key,
    serial: u64,
    handed: bool,
}

impl Pending {
    pub fn handed(mut self) {
        self.handed = true;
        let mut marks = self.memory.marks();
        if let Some(mark) = marks.get_mut(&self.key)
            && mark.serial() == self.serial
        {
            *mark = Mark::Sent(self.serial);
        }
    }
}

impl Drop for Pending {
    fn drop(&mut self) {
        if !self.handed {
            self.memory.settle(&[(self.key.clone(), self.serial)]);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_entry_dropped_before_any_send_is_unmarked_and_one_handed_stays_sent() {
        let memory = Arc::new(Memory::default());
        let dropped = memory.begin("fault", "a", || true).expect("a new mark");
        assert!(memory.begin("fault", "a", || true).is_none());
        assert!(matches!(memory.get("fault", "a"), Some(Mark::Pending(_))));
        drop(dropped);
        assert_eq!(memory.get("fault", "a"), None);

        let handed = memory.begin("fault", "a", || true).expect("marked again");
        handed.handed();
        assert!(matches!(memory.get("fault", "a"), Some(Mark::Sent(_))));
        assert!(memory.begin("fault", "a", || true).is_none());
    }

    #[test]
    fn an_entry_is_not_marked_once_a_newer_check_has_taken_over() {
        let memory = Arc::new(Memory::default());
        assert!(memory.begin("health", "disk", || false).is_none());
        assert_eq!(memory.get("health", "disk"), None, "no mark is left behind");
        assert!(memory.begin("health", "disk", || true).is_some());
    }

    #[test]
    fn a_settle_leaves_a_mark_made_since() {
        let memory = Arc::new(Memory::default());
        let first = memory.begin("health", "disk", || true).unwrap();
        let serial = first.serial;
        first.handed();
        memory.forget("health", "disk");
        memory.begin("health", "disk", || true).unwrap().handed();
        memory.settle(&[(("health".into(), "disk".into()), serial)]);
        assert!(matches!(memory.get("health", "disk"), Some(Mark::Sent(_))));
    }
}
