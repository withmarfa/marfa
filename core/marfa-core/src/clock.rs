//! The clock the engine waits by.
//!
//! A release build reads the system clock and sleeps. A debug build can be
//! given a manual clock, which moves only where `advance` moves it and
//! reports the waits that are pending, so the device suite can read a retry
//! wait without spending it. Where no manual clock is set, a debug build
//! behaves as a release build does.

use std::sync::atomic::AtomicBool;
use std::time::{Duration, Instant};

/// The time on the clock the engine waits by.
pub(crate) fn now() -> Instant {
    #[cfg(debug_assertions)]
    if let Some(manual) = manual::set() {
        return manual.now();
    }
    Instant::now()
}

/// Waits for `wait`, looking at `stop` every `poll`, and returns once `stop`
/// is set. A wait too long to add to the clock lasts until `stop` is set.
pub(crate) fn wait(stop: &AtomicBool, wait: Duration, poll: Duration) {
    #[cfg(debug_assertions)]
    if let Some(manual) = manual::set() {
        manual.wait(stop, wait, poll);
        return;
    }
    let until = Instant::now().checked_add(wait);
    while !stop.load(std::sync::atomic::Ordering::Relaxed) {
        let left = until.map_or(poll, |until| {
            until.saturating_duration_since(Instant::now())
        });
        if left.is_zero() {
            return;
        }
        std::thread::sleep(poll.min(left));
    }
}

#[cfg(debug_assertions)]
pub use manual::{Waiting, advance, set_manual, waits};

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::Ordering;
    use std::sync::mpsc;
    use std::thread;

    const MS: fn(u64) -> Duration = Duration::from_millis;

    #[test]
    fn a_wait_ends_when_stopped_and_one_too_long_for_the_clock_does_not_panic() {
        let stop = Arc::new(AtomicBool::new(false));
        let (ended, done) = mpsc::channel();
        let flag = Arc::clone(&stop);
        let started = Instant::now();
        thread::spawn(move || {
            wait(&flag, Duration::MAX, MS(10));
            let _ = ended.send(());
        });
        thread::sleep(MS(50));
        stop.store(true, Ordering::Relaxed);
        done.recv_timeout(Duration::from_secs(2))
            .expect("the wait outlasted its stop, or panicked");
        assert!(started.elapsed() < Duration::from_secs(1));
        // Witness: unstopped, a wait lasts as long as it was asked to.
        let started = Instant::now();
        wait(&AtomicBool::new(false), MS(60), MS(10));
        assert!(started.elapsed() >= MS(60));
    }
}

#[cfg(debug_assertions)]
mod manual {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Condvar, Mutex, MutexGuard, RwLock};
    use std::time::{Duration, Instant};

    /// A wait the engine asked the manual clock for and has not had.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct Waiting {
        /// What the engine asked to wait.
        pub asked: Duration,
        /// How much of it the clock has yet to be advanced by, or `None` for
        /// a wait too long to add to the clock.
        pub left: Option<Duration>,
    }

    struct Pending {
        id: u64,
        asked: Duration,
        until: Option<Duration>,
    }

    #[derive(Default)]
    struct State {
        elapsed: Duration,
        waits: Vec<Pending>,
        next: u64,
        closed: bool,
    }

    pub(super) struct Manual {
        base: Instant,
        state: Mutex<State>,
        moved: Condvar,
    }

    /// The manual clock, while one is set.
    static SET: RwLock<Option<Arc<Manual>>> = RwLock::new(None);

    pub(super) fn set() -> Option<Arc<Manual>> {
        SET.read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// Sets the manual clock, at no time elapsed, or goes back to the system
    /// clock and ends every wait the manual clock held. Set it before the
    /// calls whose waits it is to read: a wait asked of one clock is not
    /// moved to the other.
    pub fn set_manual(on: bool) {
        let next = on.then(|| Arc::new(Manual::new()));
        let before = std::mem::replace(
            &mut *SET.write().unwrap_or_else(|poisoned| poisoned.into_inner()),
            next,
        );
        if let Some(before) = before {
            before.close();
        }
    }

    /// Moves the manual clock forward, and ends the waits it reaches. Does
    /// nothing where no manual clock is set.
    pub fn advance(by: Duration) {
        if let Some(manual) = set() {
            manual.advance(by);
        }
    }

    /// The waits asked of the manual clock that it has not reached, in the
    /// order they were asked.
    pub fn waits() -> Vec<Waiting> {
        set().map_or_else(Vec::new, |manual| manual.waits())
    }

    fn held(state: &Mutex<State>) -> MutexGuard<'_, State> {
        state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    impl Manual {
        pub(super) fn new() -> Self {
            Self {
                base: Instant::now(),
                state: Mutex::new(State::default()),
                moved: Condvar::new(),
            }
        }

        pub(super) fn now(&self) -> Instant {
            self.base
                .checked_add(held(&self.state).elapsed)
                .unwrap_or(self.base)
        }

        pub(super) fn advance(&self, by: Duration) {
            let mut state = held(&self.state);
            state.elapsed = state.elapsed.saturating_add(by);
            let elapsed = state.elapsed;
            // Removed here rather than by the waiter, so a caller that reads
            // `waits` after `advance` returns sees only what is still pending.
            state
                .waits
                .retain(|wait| wait.until.is_none_or(|until| elapsed < until));
            drop(state);
            self.moved.notify_all();
        }

        pub(super) fn waits(&self) -> Vec<Waiting> {
            let state = held(&self.state);
            state
                .waits
                .iter()
                .map(|wait| Waiting {
                    asked: wait.asked,
                    left: wait.until.map(|until| until.saturating_sub(state.elapsed)),
                })
                .collect()
        }

        fn close(&self) {
            held(&self.state).closed = true;
            self.moved.notify_all();
        }

        /// Returns once the clock has been advanced by `wait`, `stop` is set
        /// (looked at every `poll`), or the clock is unset.
        pub(super) fn wait(&self, stop: &AtomicBool, wait: Duration, poll: Duration) {
            if wait.is_zero() {
                return;
            }
            let mut state = held(&self.state);
            // As the system clock's, a wait that does not fit in an `Instant`
            // has no end.
            let until = state
                .elapsed
                .checked_add(wait)
                .filter(|until| self.base.checked_add(*until).is_some());
            let id = state.next;
            state.next += 1;
            state.waits.push(Pending {
                id,
                asked: wait,
                until,
            });
            while !stop.load(Ordering::Relaxed)
                && !state.closed
                && state.waits.iter().any(|pending| pending.id == id)
            {
                state = self
                    .moved
                    .wait_timeout(state, poll)
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .0;
            }
            state.waits.retain(|pending| pending.id != id);
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::thread;

        const MS: fn(u64) -> Duration = Duration::from_millis;

        fn until(what: &str, mut done: impl FnMut() -> bool) {
            let hung = Instant::now() + Duration::from_secs(10);
            while !done() {
                assert!(Instant::now() < hung, "{what}");
                thread::sleep(MS(2));
            }
        }

        #[test]
        fn a_wait_lasts_until_the_clock_is_moved_past_it_and_is_reported_meanwhile() {
            let clock = Arc::new(Manual::new());
            let stop = Arc::new(AtomicBool::new(false));
            let waiting = {
                let (clock, stop) = (Arc::clone(&clock), Arc::clone(&stop));
                thread::spawn(move || clock.wait(&stop, MS(1_000), MS(5)))
            };
            until("the wait was never reported", || !clock.waits().is_empty());
            assert_eq!(
                clock.waits(),
                [Waiting {
                    asked: MS(1_000),
                    left: Some(MS(1_000))
                }]
            );
            // Real time passing does not end it.
            thread::sleep(MS(60));
            assert!(!waiting.is_finished(), "the wait ended with no advance");
            clock.advance(MS(400));
            assert_eq!(clock.waits()[0].left, Some(MS(600)));
            assert!(!waiting.is_finished(), "the wait ended before its time");
            clock.advance(MS(600));
            assert!(clock.waits().is_empty(), "a reached wait is still reported");
            waiting.join().unwrap();
        }

        #[test]
        fn the_time_moves_only_where_the_clock_is_advanced() {
            let clock = Manual::new();
            let first = clock.now();
            thread::sleep(MS(30));
            assert_eq!(clock.now(), first);
            clock.advance(MS(2_500));
            assert_eq!(clock.now() - first, MS(2_500));
        }

        #[test]
        fn a_wait_ends_when_stopped_without_the_clock_moving() {
            let clock = Arc::new(Manual::new());
            let stop = Arc::new(AtomicBool::new(false));
            let waiting = {
                let (clock, stop) = (Arc::clone(&clock), Arc::clone(&stop));
                thread::spawn(move || clock.wait(&stop, Duration::MAX, MS(5)))
            };
            until("the wait was never reported", || !clock.waits().is_empty());
            assert_eq!(
                clock.waits(),
                [Waiting {
                    asked: Duration::MAX,
                    left: None
                }],
                "a wait too long to add to the clock was not reported as one"
            );
            clock.advance(Duration::MAX);
            thread::sleep(MS(30));
            assert!(
                !waiting.is_finished(),
                "a wait with no end ended on an advance"
            );
            stop.store(true, Ordering::Relaxed);
            waiting.join().unwrap();
            assert!(clock.waits().is_empty());
        }

        #[test]
        fn a_wait_of_nothing_returns_at_once_and_is_not_reported() {
            let clock = Manual::new();
            clock.wait(&AtomicBool::new(false), Duration::ZERO, MS(5));
            assert!(clock.waits().is_empty());
        }

        #[test]
        fn waits_are_reported_in_the_order_asked_and_each_ends_at_its_own_time() {
            let clock = Arc::new(Manual::new());
            let stop = Arc::new(AtomicBool::new(false));
            let mut waiting = Vec::new();
            for asked in [3_000, 1_000, 2_000] {
                let (waiter, stop) = (Arc::clone(&clock), Arc::clone(&stop));
                let before = clock.waits().len();
                waiting.push(thread::spawn(move || waiter.wait(&stop, MS(asked), MS(5))));
                until("a wait was never reported", || clock.waits().len() > before);
            }
            assert_eq!(
                clock.waits().iter().map(|w| w.asked).collect::<Vec<_>>(),
                [MS(3_000), MS(1_000), MS(2_000)]
            );
            clock.advance(MS(1_500));
            assert_eq!(
                clock.waits().iter().map(|w| w.asked).collect::<Vec<_>>(),
                [MS(3_000), MS(2_000)]
            );
            until("the wait the clock reached did not end", || {
                waiting[1].is_finished()
            });
            assert!(!waiting[0].is_finished() && !waiting[2].is_finished());
            clock.advance(MS(1_500));
            for one in waiting {
                one.join().unwrap();
            }
        }

        #[test]
        fn unsetting_the_clock_ends_the_waits_it_held() {
            let clock = Arc::new(Manual::new());
            let stop = Arc::new(AtomicBool::new(false));
            let waiting = {
                let (clock, stop) = (Arc::clone(&clock), Arc::clone(&stop));
                thread::spawn(move || clock.wait(&stop, MS(60_000), MS(5)))
            };
            until("the wait was never reported", || !clock.waits().is_empty());
            clock.close();
            waiting.join().unwrap();
        }

        /// The free functions, which every wait of the engine goes through.
        /// The only test that sets the clock for the whole process; the
        /// others hold a clock of their own.
        #[test]
        fn the_engine_waits_by_the_manual_clock_while_one_is_set_and_by_the_system_clock_after() {
            let stop = Arc::new(AtomicBool::new(false));
            set_manual(true);
            let waiting = {
                let stop = Arc::clone(&stop);
                thread::spawn(move || super::super::wait(&stop, MS(30_000), MS(5)))
            };
            until(
                "the engine's wait was not asked of the manual clock",
                || !waits().is_empty(),
            );
            let at = super::super::now();
            assert_eq!(waits()[0].asked, MS(30_000));
            advance(MS(30_000));
            waiting.join().unwrap();
            assert_eq!(super::super::now() - at, MS(30_000));
            set_manual(false);
            assert!(waits().is_empty());
            let started = Instant::now();
            super::super::wait(&AtomicBool::new(false), MS(40), MS(5));
            assert!(started.elapsed() >= MS(40), "the system clock did not wait");
        }
    }
}
