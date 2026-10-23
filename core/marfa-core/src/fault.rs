//! Faults a debug build injects where `MARFA_TEST_FAULT` names them, so the
//! device suite can stand a crash, a store that fails, or another process's
//! change at the moment it matters, which no fixture can time from outside.
//! A debug build also holds a call, or makes it fail, where a fixture in its
//! own process says, which a fault in the environment cannot do. A release
//! build has none.
//!
//! A fixture in its own process (the Node binding) makes a point fail for
//! the whole process with `set_failing`. A unit test shares its process with
//! every other test, so it makes a point fail for its own thread with
//! `fail_on_this_thread`, which no test running beside it can see.

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

/// Holds an armed point until `release`, counting it only while observing.
/// The name is evaluated only while a fixture has enabled a hook.
#[cfg(debug_assertions)]
#[inline]
pub fn hold<S: AsRef<str>>(point: impl FnOnce() -> S) {
    if holds::active() {
        holds::reach(point().as_ref());
    }
}

/// Whether the fixture, or the calling thread's own test, has made `point`
/// fail, for the engine to answer with the error that point's failure is.
/// Counts the call only while observing.
#[cfg(debug_assertions)]
#[inline]
pub fn fails<S: AsRef<str>>(point: impl FnOnce() -> S) -> bool {
    let (everywhere, here) = (holds::active(), scoped::active());
    if !everywhere && !here {
        return false;
    }
    let point = point();
    (here && scoped::fails(point.as_ref())) || (everywhere && holds::fails(point.as_ref()))
}

#[cfg(debug_assertions)]
pub use scoped::Failing;

/// Makes `fails(point)` answer true on the calling thread alone, until the
/// returned guard is dropped. A thread's other callers, and every other
/// thread, see the point as it was. A debug build only.
#[cfg(debug_assertions)]
#[must_use = "the point stops failing when the guard is dropped"]
pub fn fail_on_this_thread(point: &str) -> Failing {
    scoped::fail(point)
}

/// Enables or disables reach counters without resetting their values.
#[cfg(debug_assertions)]
pub fn observe(on: bool) {
    holds::observe(on);
}

/// Makes the next calls of `hold(point)` wait. A debug build only.
#[cfg(debug_assertions)]
pub fn arm(point: &str) {
    holds::arm(point);
}

/// Makes `fails(point)` answer `on`. A debug build only.
#[cfg(debug_assertions)]
pub fn set_failing(point: &str, on: bool) {
    holds::set_failing(point, on);
}

/// Lets go of every caller waiting at `point`, and stops holding it. A debug
/// build only.
#[cfg(debug_assertions)]
pub fn release(point: &str) {
    holds::release(point);
}

/// How many times a point was reached while observing. A debug build only.
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
mod scoped {
    use std::cell::RefCell;
    use std::marker::PhantomData;

    thread_local! {
        static FAILING: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
    }

    /// A point made to fail on the thread that made it, until dropped.
    pub struct Failing {
        point: String,
        // The point lives in the creating thread's storage, so the guard
        // must be dropped there.
        _thread: PhantomData<*const ()>,
    }

    /// Whether this thread has a point made to fail. Another thread's guard
    /// never makes a call here evaluate its name.
    #[inline]
    pub(super) fn active() -> bool {
        FAILING.with(|failing| !failing.borrow().is_empty())
    }

    pub(super) fn fail(point: &str) -> Failing {
        FAILING.with(|failing| failing.borrow_mut().push(point.to_string()));
        Failing {
            point: point.to_string(),
            _thread: PhantomData,
        }
    }

    pub(super) fn fails(point: &str) -> bool {
        FAILING.with(|failing| failing.borrow().iter().any(|one| one == point))
    }

    impl Drop for Failing {
        fn drop(&mut self) {
            FAILING.with(|failing| {
                let mut failing = failing.borrow_mut();
                if let Some(at) = failing.iter().rposition(|one| *one == self.point) {
                    failing.remove(at);
                }
            });
        }
    }

    #[cfg(test)]
    mod tests {
        use super::super::{fail_on_this_thread, fails};
        use std::sync::mpsc;
        use std::thread;

        #[test]
        fn a_point_made_to_fail_on_this_thread_fails_here_alone_and_until_dropped() {
            let fault = fail_on_this_thread("scoped-test-here");
            assert!(fails(|| "scoped-test-here"));
            assert!(!fails(|| "scoped-test-other-point"));
            let (asked, answer) = mpsc::channel();
            thread::spawn(move || asked.send(fails(|| "scoped-test-here")).unwrap());
            assert!(!answer.recv().unwrap(), "another thread saw the fault");
            drop(fault);
            assert!(!fails(|| "scoped-test-here"));
        }

        #[test]
        fn two_guards_for_one_point_on_a_thread_fail_until_both_are_dropped() {
            let first = fail_on_this_thread("scoped-test-twice");
            let second = fail_on_this_thread("scoped-test-twice");
            drop(first);
            assert!(fails(|| "scoped-test-twice"));
            drop(second);
            assert!(!fails(|| "scoped-test-twice"));
        }
    }
}

#[cfg(debug_assertions)]
mod holds {
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Condvar, Mutex, MutexGuard};

    #[derive(Default)]
    struct Point {
        armed: bool,
        failing: bool,
        reached: usize,
        waiting: usize,
        /// Lets a released caller proceed even if the point is armed again
        /// before that caller wakes.
        released: u64,
    }

    #[derive(Default)]
    struct Registry {
        points: HashMap<String, Point>,
        observing: bool,
    }

    static ACTIVE: AtomicBool = AtomicBool::new(false);
    static POINTS: Mutex<Option<Registry>> = Mutex::new(None);
    static CHANGED: Condvar = Condvar::new();

    #[inline]
    pub(super) fn active() -> bool {
        ACTIVE.load(Ordering::Acquire)
    }

    fn points() -> MutexGuard<'static, Option<Registry>> {
        POINTS
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn point<'a>(held: &'a mut Option<Registry>, name: &str) -> &'a mut Point {
        held.get_or_insert_with(Registry::default)
            .points
            .entry(name.to_string())
            .or_default()
    }

    // Publish while holding POINTS so a concurrent disarm cannot overwrite
    // the flag of a later arm.
    fn publish(held: &Option<Registry>) {
        ACTIVE.store(
            held.as_ref().is_some_and(|registry| {
                registry.observing
                    || registry
                        .points
                        .values()
                        .any(|point| point.armed || point.failing)
            }),
            Ordering::Release,
        );
    }

    fn visit<'a>(held: &'a mut Option<Registry>, name: &str) -> Option<&'a mut Point> {
        let registry = held.as_mut()?;
        if registry.observing {
            let point = registry.points.entry(name.to_string()).or_default();
            point.reached += 1;
            Some(point)
        } else {
            registry.points.get_mut(name)
        }
    }

    pub(super) fn observe(on: bool) {
        let mut held = points();
        held.get_or_insert_with(Registry::default).observing = on;
        publish(&held);
    }

    pub(super) fn reach(name: &str) {
        let mut held = points();
        let Some(here) = visit(&mut held, name) else {
            return;
        };
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

    pub(super) fn fails(name: &str) -> bool {
        visit(&mut points(), name).is_some_and(|here| here.failing)
    }

    pub(super) fn set_failing(name: &str, on: bool) {
        let mut held = points();
        point(&mut held, name).failing = on;
        publish(&held);
    }

    pub(super) fn arm(name: &str) {
        let mut held = points();
        point(&mut held, name).armed = true;
        publish(&held);
    }

    pub(super) fn release(name: &str) {
        let mut held = points();
        let here = point(&mut held, name);
        here.armed = false;
        here.released += 1;
        publish(&held);
        CHANGED.notify_all();
    }

    pub(super) fn reached(name: &str) -> usize {
        points()
            .as_ref()
            .and_then(|held| held.points.get(name))
            .map_or(0, |here| here.reached)
    }

    pub(super) fn waiting(name: &str) -> usize {
        points()
            .as_ref()
            .and_then(|held| held.points.get(name))
            .map_or(0, |here| here.waiting)
    }

    #[cfg(test)]
    mod tests {
        use super::super::{arm, fails, hold, observe, reached, release, set_failing, waiting};
        use std::sync::Arc;
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::thread;
        use std::time::{Duration, Instant};

        static ALONE: std::sync::Mutex<()> = std::sync::Mutex::new(());

        struct Observing {
            _alone: std::sync::MutexGuard<'static, ()>,
        }

        impl Drop for Observing {
            fn drop(&mut self) {
                observe(false);
            }
        }

        fn alone() -> Observing {
            let alone = ALONE
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            observe(true);
            Observing { _alone: alone }
        }

        #[test]
        fn disabled_hooks_neither_evaluate_names_nor_access_the_registry() {
            let _alone = alone();
            let calls = std::cell::Cell::new(0);
            let enabled = std::cell::Cell::new(true);
            let name = || {
                assert!(enabled.get(), "a disabled hook evaluated its name");
                calls.set(calls.get() + 1);
                format!("holds-test-lazy-{}", 1)
            };
            hold(name);
            assert!(!fails(name));
            assert_eq!(calls.get(), 2);
            assert_eq!(reached("holds-test-lazy-1"), 2);

            observe(false);
            enabled.set(false);
            assert!(!super::active());
            // Owning the registry also proves disabled hooks never lock it.
            let held = super::points();
            hold(name);
            assert!(!fails(name));
            assert_eq!(calls.get(), 2);
            drop(held);
            assert_eq!(reached("holds-test-lazy-1"), 2);

            enabled.set(true);
            set_failing("holds-test-lazy-1", true);
            assert!(fails(name));
            set_failing("holds-test-lazy-1", false);
            assert!(!super::active());
            arm("holds-test-lazy-1");
            assert!(super::active());
            release("holds-test-lazy-1");
            assert!(!super::active());
            assert_eq!(reached("holds-test-lazy-1"), 2);
        }

        fn until(what: &str, mut done: impl FnMut() -> bool) {
            let hung = Instant::now() + Duration::from_secs(10);
            while !done() {
                assert!(Instant::now() < hung, "{what}");
                thread::sleep(Duration::from_millis(2));
            }
        }

        #[test]
        fn a_point_nobody_armed_is_not_counted_and_does_not_wait() {
            let _alone = alone();
            observe(false);
            hold(|| "holds-test-unarmed");
            hold(|| "holds-test-unarmed");
            assert_eq!(reached("holds-test-unarmed"), 0);
            assert_eq!(waiting("holds-test-unarmed"), 0);
        }

        #[test]
        fn an_armed_point_holds_each_caller_until_it_is_released() {
            let _alone = alone();
            arm("holds-test-armed");
            let passed = Arc::new(AtomicBool::new(false));
            let callers: Vec<_> = (0..2)
                .map(|_| {
                    let passed = Arc::clone(&passed);
                    thread::spawn(move || {
                        hold(|| "holds-test-armed");
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
            hold(|| "holds-test-armed");
            assert_eq!(reached("holds-test-armed"), 3);
        }

        #[test]
        fn a_release_before_the_engine_arrives_holds_nobody_and_a_new_arming_holds_again() {
            let _alone = alone();
            observe(false);
            arm("holds-test-early");
            release("holds-test-early");
            hold(|| "holds-test-early");
            arm("holds-test-early");
            let caller = thread::spawn(|| hold(|| "holds-test-early"));
            until("the second arming did not hold", || {
                waiting("holds-test-early") == 1
            });
            release("holds-test-early");
            caller.join().unwrap();
            assert_eq!(reached("holds-test-early"), 0);
            assert!(!super::active());
        }

        #[test]
        fn a_point_made_to_fail_fails_until_it_is_made_not_to_and_counts_each_ask() {
            let _alone = alone();
            assert!(!fails(|| "holds-test-failing"));
            set_failing("holds-test-failing", true);
            assert!(fails(|| "holds-test-failing"));
            set_failing("holds-test-failing", false);
            assert!(!fails(|| "holds-test-failing"));
            assert_eq!(reached("holds-test-failing"), 3);
        }

        #[test]
        fn points_are_held_apart_by_name() {
            let _alone = alone();
            arm("holds-test-one");
            hold(|| "holds-test-two");
            assert_eq!(reached("holds-test-two"), 1);
            assert_eq!(reached("holds-test-one"), 0);
            release("holds-test-one");
        }
    }
}
