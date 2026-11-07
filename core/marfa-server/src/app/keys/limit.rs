//! The fixed window the operations under `/keys` share, per credential.

use std::collections::HashMap;
use std::sync::{Mutex, PoisonError};

mod sweep;

const SWEEP_ABOVE: usize = 1024;

#[derive(Debug)]
struct Window {
    started_ms: i64,
    count: u64,
}

#[derive(Debug, Default)]
pub struct Limiter {
    windows: Mutex<HashMap<String, Window>>,
}

impl Limiter {
    /// Counts one request, and answers the seconds to wait if it is over
    /// `cap`.
    pub fn take(&self, credential: &str, now_ms: i64, cap: u64, window_ms: u64) -> Option<u64> {
        let span = i64::try_from(window_ms).unwrap_or(i64::MAX);
        let ended = |window: &Window| now_ms.saturating_sub(window.started_ms) >= span;
        let mut windows = self.windows.lock().unwrap_or_else(PoisonError::into_inner);
        if windows.len() > SWEEP_ABOVE {
            windows.retain(|_, window| !ended(window));
        }
        let window = windows.entry(credential.to_string()).or_insert(Window {
            started_ms: now_ms,
            count: 0,
        });
        if ended(window) {
            *window = Window {
                started_ms: now_ms,
                count: 0,
            };
        }
        window.count += 1;
        if window.count <= cap {
            return None;
        }
        let left_ms = window
            .started_ms
            .saturating_add(span)
            .saturating_sub(now_ms);
        Some(u64::try_from(left_ms).unwrap_or(0).div_ceil(1000).max(1))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_credential_has_a_window_of_its_own_that_ends() {
        let limiter = Limiter::default();
        assert_eq!(limiter.take("a", 0, 2, 60_000), None);
        assert_eq!(limiter.take("a", 1, 2, 60_000), None);
        assert_eq!(limiter.take("a", 1_500, 2, 60_000), Some(59));
        assert_eq!(limiter.take("b", 1_500, 2, 60_000), None);
        assert_eq!(limiter.take("a", 59_999, 2, 60_000), Some(1));
        assert_eq!(limiter.take("a", 60_000, 2, 60_000), None);
    }
}
