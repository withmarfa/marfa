//! Dropping the windows that have ended.

use std::sync::PoisonError;

use super::Limiter;

impl Limiter {
    /// Drops every window `window_ms` has passed since the start of, and
    /// answers how many went.
    pub fn sweep(&self, now_ms: i64, window_ms: u64) -> usize {
        let span = i64::try_from(window_ms).unwrap_or(i64::MAX);
        let mut windows = self.windows.lock().unwrap_or_else(PoisonError::into_inner);
        let held = windows.len();
        windows.retain(|_, window| now_ms.saturating_sub(window.started_ms) < span);
        held - windows.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_window_goes_once_it_has_ended_and_not_a_moment_before() {
        let limiter = Limiter::default();
        assert_eq!(limiter.take("key", 1_000, 10, 60_000), None);
        assert_eq!(limiter.sweep(60_999, 60_000), 0);
        assert_eq!(limiter.sweep(61_000, 60_000), 1);
        assert_eq!(limiter.sweep(61_000, 60_000), 0);
    }
}
