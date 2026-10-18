//! Faults a debug build injects where `MARFA_TEST_FAULT` names them, so the
//! device suite can stand a crash, a store that fails, or another process's
//! change at the moment it matters, which no fixture can time from outside.
//! A debug build also holds a call where a fixture in its own process says,
//! which a fault in the environment cannot do. A release build has none.

/// The argument of the named fault, empty where it takes none.
#[cfg(debug_assertions)]
pub fn named(fault: &str) -> Option<String> {
    std::env::var("MARFA_TEST_FAULT")
        .ok()?
        .split(',')
        .find_map(|one| {
            let (name, argument) = one.split_once('=').unwrap_or((one, ""));
            (name == fault).then(|| argument.to_string())
        })
}

#[cfg(not(debug_assertions))]
pub fn named(_fault: &str) -> Option<String> {
    None
}

/// Called by the engine where a fixture may hold it. A debug build counts
/// the call, armed or not, and makes the caller wait until `release` where
/// the fixture has armed the point. A release build does nothing.
pub fn hold(point: &str) {
    #[cfg(debug_assertions)]
    holds::reach(point);
    #[cfg(not(debug_assertions))]
    let _ = point;
}

/// Makes the next calls of `hold(point)` wait. A debug build only.
#[cfg(debug_assertions)]
pub fn arm(point: &str) {
    holds::arm(point);
}

/// Lets go of every caller waiting at `point`, and stops holding it. A debug
/// build only.
#[cfg(debug_assertions)]
pub fn release(point: &str) {
    holds::release(point);
}

/// How many times the engine has called `hold(point)`. A debug build only.
#[cfg(debug_assertions)]
pub fn reached(point: &str) -> usize {
    holds::reached(point)
}

/// How many callers wait at `point` now. A debug build only.
#[cfg(debug_assertions)]
pub fn waiting(point: &str) -> usize {
    holds::waiting(point)
}

#[cfg(debug_assertions)]
mod holds {
    use std::collections::HashMap;
    use std::sync::{Condvar, Mutex, MutexGuard};

    #[derive(Default)]
    struct Point {
        armed: bool,
        reached: usize,
        waiting: usize,
        /// Moves each release, so a caller waiting through one release and
        /// an arming after it is not let go by the earlier release.
        released: u64,
    }

    static POINTS: Mutex<Option<HashMap<String, Point>>> = Mutex::new(None);
    static CHANGED: Condvar = Condvar::new();

    fn points() -> MutexGuard<'static, Option<HashMap<String, Point>>> {
        POINTS
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn point<'a>(held: &'a mut Option<HashMap<String, Point>>, name: &str) -> &'a mut Point {
        held.get_or_insert_with(HashMap::new)
            .entry(name.to_string())
            .or_default()
    }

    pub(super) fn reach(name: &str) {
        let mut held = points();
        let here = point(&mut held, name);
        here.reached += 1;
        if !here.armed {
            return;
        }
        here.waiting += 1;
        let released = here.released;
        CHANGED.notify_all();
        while point(&mut held, name).released == released {
            held = CHANGED
                .wait(held)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
        point(&mut held, name).waiting -= 1;
        CHANGED.notify_all();
    }

    pub(super) fn arm(name: &str) {
        point(&mut points(), name).armed = true;
    }

    pub(super) fn release(name: &str) {
        let mut held = points();
        let here = point(&mut held, name);
        here.armed = false;
        here.released += 1;
        CHANGED.notify_all();
    }

    pub(super) fn reached(name: &str) -> usize {
        point(&mut points(), name).reached
    }

    pub(super) fn waiting(name: &str) -> usize {
        point(&mut points(), name).waiting
    }

    #[cfg(test)]
    mod tests {
        use super::super::{arm, hold, reached, release, waiting};
        use std::sync::Arc;
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::thread;
        use std::time::{Duration, Instant};

        fn until(what: &str, mut done: impl FnMut() -> bool) {
            let hung = Instant::now() + Duration::from_secs(10);
            while !done() {
                assert!(Instant::now() < hung, "{what}");
                thread::sleep(Duration::from_millis(2));
            }
        }

        #[test]
        fn a_point_nobody_armed_is_counted_and_does_not_wait() {
            hold("holds-test-unarmed");
            hold("holds-test-unarmed");
            assert_eq!(reached("holds-test-unarmed"), 2);
            assert_eq!(waiting("holds-test-unarmed"), 0);
        }

        #[test]
        fn an_armed_point_holds_each_caller_until_it_is_released() {
            arm("holds-test-armed");
            let passed = Arc::new(AtomicBool::new(false));
            let callers: Vec<_> = (0..2)
                .map(|_| {
                    let passed = Arc::clone(&passed);
                    thread::spawn(move || {
                        hold("holds-test-armed");
                        passed.store(true, Ordering::SeqCst);
                    })
                })
                .collect();
            until("the callers were not held", || {
                waiting("holds-test-armed") == 2
            });
            assert_eq!(reached("holds-test-armed"), 2);
            thread::sleep(Duration::from_millis(40));
            assert!(
                !passed.load(Ordering::SeqCst),
                "a caller passed an armed point"
            );
            release("holds-test-armed");
            for caller in callers {
                caller.join().unwrap();
            }
            assert_eq!(waiting("holds-test-armed"), 0);
            // Released, it holds nothing until it is armed again.
            hold("holds-test-armed");
            assert_eq!(reached("holds-test-armed"), 3);
        }

        #[test]
        fn a_release_before_the_engine_arrives_holds_nobody_and_a_new_arming_holds_again() {
            arm("holds-test-early");
            release("holds-test-early");
            hold("holds-test-early");
            arm("holds-test-early");
            let caller = thread::spawn(|| hold("holds-test-early"));
            until("the second arming did not hold", || {
                waiting("holds-test-early") == 1
            });
            release("holds-test-early");
            caller.join().unwrap();
        }

        #[test]
        fn points_are_held_apart_by_name() {
            arm("holds-test-one");
            hold("holds-test-two");
            assert_eq!(reached("holds-test-two"), 1);
            assert_eq!(reached("holds-test-one"), 0);
            release("holds-test-one");
        }
    }
}
