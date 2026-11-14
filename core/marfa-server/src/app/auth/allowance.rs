//! Audit allowances for requests that need no credential.

use std::collections::HashMap;
use std::sync::{Mutex, PoisonError};

use rusqlite::Transaction;
use serde_json::Value;

use crate::app::audit;
use crate::app::clock::Stamp;
use crate::app::refusal::Result;

pub const WINDOW_MS: i64 = 15 * 60_000;
const STORED_PER_WINDOW: usize = 10;
const MAX_RETRY_WAIT_MS: i64 = 60_000;

/// Records of requests the server stores whether or not it records them.
#[derive(Clone, Copy, Debug)]
pub struct Stored {
    action: &'static str,
    source: &'static str,
}

pub const CLIENT_REGISTERED: Stored = Stored {
    action: "auth.client.created",
    source: "registration",
};
pub const DEVICE_CODE_ISSUED: Stored = Stored {
    action: "auth.device_code.issued",
    source: "device",
};

impl Stored {
    pub fn action(self) -> &'static str {
        self.action
    }

    pub fn source(self) -> &'static str {
        self.source
    }
}

/// Must run in the transaction that stores the request.
pub fn record_or_count(
    tx: &Transaction<'_>,
    kind: Stored,
    at: Stamp,
    record: impl FnOnce() -> Result<()>,
) -> Result<()> {
    let after = at
        .earlier_by(WINDOW_MS)
        .map(Stamp::text)
        .unwrap_or_default();
    let recent = audit::newest_after(tx, kind.action, kind.source, &after, STORED_PER_WINDOW)?;
    match recent.first() {
        Some(newest) if recent.len() >= STORED_PER_WINDOW => {
            audit::count_unrecorded_after(tx, newest)
        }
        _ => record(),
    }
}

/// A door whose refusals by a limit are recorded at most once in fifteen minutes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Door(&'static str);

pub const SIGN_IN_REFUSED: Door = Door("sign-in");
pub const CONFIRM_REFUSED: Door = Door("confirm");
pub const CHANGE_REFUSED: Door = Door("password-change");

#[derive(Default)]
struct DoorState {
    writing: bool,
    spent_until: i64,
    left_out: u64,
    failures: u32,
    retry_at: i64,
}

#[derive(Default)]
pub struct RefusalRecords {
    doors: Mutex<HashMap<Door, DoorState>>,
}

impl RefusalRecords {
    /// A successful claim must be settled even if the caller disconnects.
    pub fn begin(&self, door: Door, now_ms: i64) -> Option<u64> {
        let mut doors = self.doors.lock().unwrap_or_else(PoisonError::into_inner);
        let state = doors.entry(door).or_default();
        if state.writing || now_ms < state.spent_until || now_ms < state.retry_at {
            state.left_out = state.left_out.saturating_add(1);
            return None;
        }
        state.writing = true;
        Some(std::mem::take(&mut state.left_out))
    }

    /// An unknown write spends its window; `now_ms` must follow the write's answer.
    pub fn settle(&self, door: Door, carried: u64, written: &Result<()>, now_ms: i64) {
        let mut doors = self.doors.lock().unwrap_or_else(PoisonError::into_inner);
        let state = doors.entry(door).or_default();
        state.writing = false;
        match written {
            Err(failed) if !failed.commit_failed => {
                state.left_out = state.left_out.saturating_add(carried).saturating_add(1);
                state.failures = state.failures.saturating_add(1);
                state.retry_at = now_ms.saturating_add(retry_wait_ms(state.failures));
            }
            _ => {
                state.spent_until = now_ms.saturating_add(WINDOW_MS);
                state.failures = 0;
                state.retry_at = 0;
            }
        }
    }
}

/// The first retry is at once, and each failure after doubles the wait, up to a minute.
fn retry_wait_ms(failures: u32) -> i64 {
    match failures {
        0 | 1 => 0,
        n => (1_000_i64 << (n - 2).min(6)).min(MAX_RETRY_WAIT_MS),
    }
}

/// Adds `unrecorded_before` to a refusal's details when its door left any out.
pub fn with_unrecorded_before(mut details: Value, left_out: u64) -> Value {
    if let (Some(fields), true) = (details.as_object_mut(), left_out > 0) {
        fields.insert("unrecorded_before".to_string(), Value::from(left_out));
    }
    details
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::refusal::Refusal;

    fn failed() -> Result<()> {
        Err(Refusal::internal("not written"))
    }

    fn unknown() -> Result<()> {
        Err(Refusal {
            commit_failed: true,
            ..Refusal::internal("may be written")
        })
    }

    #[test]
    fn a_door_writes_one_record_at_a_time_and_counts_the_rest_on_the_next() {
        let records = RefusalRecords::default();
        assert_eq!(records.begin(SIGN_IN_REFUSED, 0), Some(0));
        assert_eq!(records.begin(SIGN_IN_REFUSED, 0), None);
        assert_eq!(records.begin(CONFIRM_REFUSED, 0), Some(0));
        records.settle(SIGN_IN_REFUSED, 0, &Ok(()), 5_000);
        assert_eq!(records.begin(SIGN_IN_REFUSED, 5_000 + WINDOW_MS - 1), None);
        assert_eq!(records.begin(SIGN_IN_REFUSED, 5_000 + WINDOW_MS), Some(2));
    }

    #[test]
    fn a_failed_record_counts_itself_and_its_wait_starts_when_it_failed() {
        let records = RefusalRecords::default();
        let carried = records.begin(SIGN_IN_REFUSED, 0).unwrap_or(99);
        records.settle(SIGN_IN_REFUSED, carried, &failed(), 0);
        let carried = records.begin(SIGN_IN_REFUSED, 0).unwrap_or(99);
        assert_eq!(carried, 1);
        records.settle(SIGN_IN_REFUSED, carried, &failed(), 2_000);
        assert_eq!(records.begin(SIGN_IN_REFUSED, 2_999), None);
        assert_eq!(records.begin(SIGN_IN_REFUSED, 3_000), Some(3));
        assert_eq!(retry_wait_ms(40), MAX_RETRY_WAIT_MS);
    }

    #[test]
    fn a_record_whose_write_is_unknown_spends_the_window_and_is_not_counted() {
        let records = RefusalRecords::default();
        assert_eq!(records.begin(SIGN_IN_REFUSED, 0), Some(0));
        records.settle(SIGN_IN_REFUSED, 0, &unknown(), 7_000);
        assert_eq!(records.begin(SIGN_IN_REFUSED, 7_000), None);
        assert_eq!(records.begin(SIGN_IN_REFUSED, 7_000 + WINDOW_MS - 1), None);
        assert_eq!(records.begin(SIGN_IN_REFUSED, 7_000 + WINDOW_MS), Some(2));
    }
}
