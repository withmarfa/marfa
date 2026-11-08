//! The instance's clock: the one place code asks the time. Under test hooks a
//! harness can move it forward and pause it; it never goes back.

#[cfg(feature = "test-hooks")]
use std::sync::Mutex;

use chrono::{DateTime, SecondsFormat, Utc};
use tokio::sync::watch;

#[cfg(feature = "test-hooks")]
pub const MAX_OFFSET_MS: u64 = 3_153_600_000_000;
#[cfg(feature = "test-hooks")]
const MAX_INSTANT_MS: i64 = 8_640_000_000_000_000;

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

    pub fn now(&self) -> DateTime<Utc> {
        DateTime::from_timestamp_millis(self.now_ms()).unwrap_or(DateTime::<Utc>::MAX_UTC)
    }

    /// UTC text that sorts as it reads.
    pub fn stamp(&self) -> String {
        self.now().to_rfc3339_opts(SecondsFormat::Millis, true)
    }

    pub fn stamp_ago(&self, ms: i64) -> String {
        DateTime::from_timestamp_millis(self.now_ms() - ms)
            .unwrap_or(DateTime::<Utc>::MIN_UTC)
            .to_rfc3339_opts(SecondsFormat::Millis, true)
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
        if base + offset as i64 > MAX_INSTANT_MS {
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
}
