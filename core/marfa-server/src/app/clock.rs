//! The instance's clock: the one place code asks the time. Under test hooks a
//! harness can move it forward and pause it; it never goes back. Every time a
//! table holds is a [`Stamp`].

#[cfg(feature = "test-hooks")]
use std::sync::Mutex;

use std::fmt;

use chrono::{DateTime, Utc};
use marfa_rules::time;
use rusqlite::types::{FromSql, FromSqlError, FromSqlResult, ToSql, ToSqlOutput, ValueRef};
use tokio::sync::watch;

use crate::app::refusal::{self, Refusal};

#[cfg(feature = "test-hooks")]
pub const MAX_OFFSET_MS: u64 = 3_153_600_000_000;
const FIRST_MS: i64 = -62_167_219_200_000;
const LAST_MS: i64 = 253_402_300_799_999;

#[cfg(feature = "test-hooks")]
#[derive(Debug)]
struct State {
    offset_ms: u64,
    paused_at_ms: Option<i64>,
}

#[derive(Debug)]
#[cfg_attr(not(feature = "test-hooks"), derive(Default))]
pub struct Clock {
    #[cfg(feature = "test-hooks")]
    state: Mutex<State>,
    moved: watch::Sender<u64>,
}

#[cfg(feature = "test-hooks")]
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum Refused {
    #[error("the clock cannot be more than {MAX_OFFSET_MS} ms ahead")]
    TooFarAhead,
    #[error("the clock cannot move past the last instant")]
    PastLastInstant,
}

fn system_ms() -> i64 {
    Utc::now().timestamp_millis()
}

impl Clock {
    #[cfg(feature = "test-hooks")]
    pub fn new(offset_ms: u64) -> Clock {
        Clock {
            state: Mutex::new(State {
                offset_ms,
                paused_at_ms: None,
            }),
            moved: watch::Sender::new(0),
        }
    }

    #[cfg(feature = "test-hooks")]
    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    #[cfg(feature = "test-hooks")]
    pub fn now_ms(&self) -> i64 {
        let state = self.state();
        state.paused_at_ms.unwrap_or_else(system_ms) + state.offset_ms as i64
    }

    #[cfg(not(feature = "test-hooks"))]
    pub fn now_ms(&self) -> i64 {
        system_ms()
    }

    /// The time to the millisecond, which never leaves the years a [`Stamp`] holds.
    pub fn instant(&self) -> Stamp {
        Stamp(
            DateTime::from_timestamp_millis(self.now_ms().clamp(FIRST_MS, LAST_MS))
                .unwrap_or_default(),
        )
    }

    pub fn now(&self) -> DateTime<Utc> {
        self.instant().at()
    }

    pub fn stamp(&self) -> String {
        self.instant().text()
    }

    #[cfg(feature = "test-hooks")]
    pub fn offset_ms(&self) -> u64 {
        self.state().offset_ms
    }

    #[cfg(feature = "test-hooks")]
    pub fn is_paused(&self) -> bool {
        self.state().paused_at_ms.is_some()
    }

    #[cfg(not(feature = "test-hooks"))]
    pub fn is_paused(&self) -> bool {
        false
    }

    /// Changes each time the clock is moved or paused, so a wait on it can be measured again.
    pub fn moves(&self) -> watch::Receiver<u64> {
        self.moved.subscribe()
    }

    #[cfg(feature = "test-hooks")]
    fn tell_moved(&self) {
        self.moved.send_modify(|count| *count += 1);
    }

    #[cfg(feature = "test-hooks")]
    pub fn advance(&self, ms: u64) -> Result<u64, Refused> {
        let mut state = self.state();
        let offset = state
            .offset_ms
            .checked_add(ms)
            .filter(|offset| *offset <= MAX_OFFSET_MS)
            .ok_or(Refused::TooFarAhead)?;
        let base = state.paused_at_ms.unwrap_or_else(system_ms);
        if base + offset as i64 > LAST_MS {
            return Err(Refused::PastLastInstant);
        }
        state.offset_ms = offset;
        drop(state);
        self.tell_moved();
        Ok(offset)
    }

    /// Resuming reads the system clock again, so the time paused is caught up.
    #[cfg(feature = "test-hooks")]
    pub fn pause(&self, paused: bool) {
        let mut state = self.state();
        state.paused_at_ms = if paused {
            Some(state.paused_at_ms.unwrap_or_else(system_ms))
        } else {
            None
        };
        drop(state);
        self.tell_moved();
    }
}

/// A time as every table holds it: RFC 3339 UTC text with milliseconds, which sorts as it reads.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Stamp(DateTime<Utc>);

impl Stamp {
    /// Refuses an instant outside the years 0000 to 9999, which no text of this form can hold.
    pub fn from_ms(ms: i64) -> refusal::Result<Stamp> {
        (FIRST_MS..=LAST_MS)
            .contains(&ms)
            .then(|| DateTime::from_timestamp_millis(ms))
            .flatten()
            .map(Stamp)
            .ok_or_else(|| Refusal::internal("a time outside the years 0000 to 9999"))
    }

    /// Refuses any text but the one form a time is stored in.
    pub fn read(stored: &str) -> refusal::Result<Stamp> {
        Stamp::parsed(stored).ok_or_else(|| Refusal::internal("a stored time did not read"))
    }

    /// For a caller that reports an unreadable time itself.
    pub fn parsed(stored: &str) -> Option<Stamp> {
        time::instant(stored, "")
            .ok()
            .filter(|at| time::written(at) == stored)
            .map(Stamp)
    }

    pub fn ms(self) -> i64 {
        self.0.timestamp_millis()
    }

    pub fn at(self) -> DateTime<Utc> {
        self.0
    }

    pub fn text(self) -> String {
        time::written(&self.0)
    }

    pub fn plus_ms(self, ms: i64) -> refusal::Result<Stamp> {
        Stamp::from_ms(self.ms().saturating_add(ms))
    }

    /// `None` once no stored time can be that early, so a cutoff there keeps everything.
    pub fn earlier_by(self, ms: i64) -> Option<Stamp> {
        let at = self.ms().saturating_sub(ms);
        (at >= FIRST_MS)
            .then(|| DateTime::from_timestamp_millis(at))
            .flatten()
            .map(Stamp)
    }
}

/// SQL that holds only where `column` is a time in the stored form, so that comparing it as text
/// compares instants. A clean-up keyed on a time adds it, so a time that does not read is never past.
/// SQLite's own reading lets an hour of 24 through.
pub fn readable(column: &str) -> String {
    format!(
        "(strftime('%Y-%m-%dT%H:%M:%fZ', {column}) = {column} AND substr({column}, 12, 2) < '24')"
    )
}

impl fmt::Display for Stamp {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.text())
    }
}

impl serde::Serialize for Stamp {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.text())
    }
}

impl ToSql for Stamp {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        Ok(ToSqlOutput::from(self.text()))
    }
}

impl FromSql for Stamp {
    fn column_result(value: ValueRef<'_>) -> FromSqlResult<Stamp> {
        Stamp::parsed(value.as_str()?).ok_or_else(|| {
            FromSqlError::Other("a stored time is not RFC 3339 UTC text with milliseconds".into())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_paused_clock_stands_still_and_keeps_its_offset_when_it_resumes() {
        let clock = Clock::new(0);
        clock.pause(true);
        let at = clock.now_ms();
        std::thread::sleep(std::time::Duration::from_millis(5));
        assert_eq!(clock.now_ms(), at);
        clock.advance(1_000).unwrap();
        assert_eq!(clock.now_ms(), at + 1_000);
        clock.pause(false);
        assert!(clock.now_ms() >= at + 1_005);
        assert_eq!(clock.offset_ms(), 1_000);
    }

    #[test]
    fn stops_at_its_offset_cap() {
        let clock = Clock::new(MAX_OFFSET_MS);
        assert_eq!(clock.advance(1), Err(Refused::TooFarAhead));
        assert_eq!(clock.offset_ms(), MAX_OFFSET_MS);
    }

    #[test]
    fn stamps_utc_to_the_millisecond() {
        let stamp = Clock::new(0).stamp();
        assert_eq!(stamp.len(), "2026-11-07T01:39:37.000Z".len());
        assert!(stamp.ends_with('Z'));
    }

    #[test]
    fn reads_only_the_form_it_writes() {
        let at = Stamp::from_ms(1_762_672_580_123).unwrap();
        assert_eq!(at.text(), "2025-11-09T07:16:20.123Z");
        assert_eq!(Stamp::read(&at.text()).unwrap(), at);
        for stored in [
            "",
            "soon",
            "1762672580",
            "2025-11-09T07:16:20Z",
            "2025-11-09T07:16:20.1Z",
            "2025-11-09T07:16:20.123+00:00",
            "2025-11-09t07:16:20.123z",
            "2025-11-09T07:16:20.1234Z",
            "2025-11-09 07:16:20.123Z",
        ] {
            assert!(Stamp::read(stored).is_err(), "{stored}");
        }
    }

    #[test]
    fn its_sql_test_agrees_with_reading() {
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE t (at)").unwrap();
        let held: Vec<rusqlite::types::Value> = [
            "2025-11-09T07:16:20.123Z",
            "0000-01-01T00:00:00.000Z",
            "9999-12-31T23:59:59.999Z",
            "2024-02-29T00:00:00.000Z",
            "",
            "0",
            "z",
            "soon",
            "1762672580",
            "2025-11-09T07:16:20Z",
            "2025-11-09T07:16:20.1Z",
            "2025-11-09T07:16:20.123+00:00",
            "2025-11-09t07:16:20.123z",
            "2025-11-09T07:16:20.1234Z",
            "2025-11-09 07:16:20.123Z",
            " 2025-11-09T07:16:20.123Z",
            "2025-11-09T07:16:20.123Z ",
            "2025-02-29T00:00:00.000Z",
            "2025-13-01T00:00:00.000Z",
            "2025-11-31T00:00:00.000Z",
            "2025-11-09T24:00:00.000Z",
            "2025-11-09T24:59:59.999Z",
            "2025-11-09T25:00:00.000Z",
            "2025-11-09T23:59:59.999Z",
            "2025-11-09T23:60:00.000Z",
            "2025-11-09T23:59:60.000Z",
        ]
        .map(|text| rusqlite::types::Value::Text(text.into()))
        .into_iter()
        .chain([
            rusqlite::types::Value::Integer(1_762_672_580_123),
            rusqlite::types::Value::Real(2_461_000.5),
            rusqlite::types::Value::Null,
        ])
        .collect();
        for value in &held {
            db.execute("DELETE FROM t", []).unwrap();
            db.execute("INSERT INTO t VALUES (?1)", [value]).unwrap();
            let passes: bool = db
                .query_row(
                    &format!("SELECT EXISTS (SELECT 1 FROM t WHERE {})", readable("at")),
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            let reads = match value {
                rusqlite::types::Value::Text(text) => Stamp::parsed(text).is_some(),
                _ => false,
            };
            assert_eq!(passes, reads, "{value:?}");
        }
    }

    #[test]
    fn holds_the_years_0000_to_9999_and_refuses_the_rest() {
        assert_eq!(
            Stamp::from_ms(FIRST_MS).unwrap().text(),
            "0000-01-01T00:00:00.000Z"
        );
        assert_eq!(
            Stamp::from_ms(LAST_MS).unwrap().text(),
            "9999-12-31T23:59:59.999Z"
        );
        assert!(Stamp::from_ms(FIRST_MS - 1).is_err());
        assert!(Stamp::from_ms(LAST_MS + 1).is_err());
        assert!(Stamp::from_ms(LAST_MS).unwrap().plus_ms(1).is_err());
        let first = Stamp::from_ms(FIRST_MS + 1).unwrap();
        assert_eq!(first.earlier_by(1).map(Stamp::ms), Some(FIRST_MS));
        assert_eq!(first.earlier_by(2), None);
    }

    #[test]
    fn sorts_as_text_in_the_order_of_its_instants() {
        let times = [FIRST_MS, -1, 0, 1, 999, 1_000, 1_762_672_580_123, LAST_MS];
        let texts: Vec<String> = times
            .iter()
            .map(|ms| Stamp::from_ms(*ms).unwrap().text())
            .collect();
        let mut sorted = texts.clone();
        sorted.sort();
        assert_eq!(texts, sorted);
    }
}
