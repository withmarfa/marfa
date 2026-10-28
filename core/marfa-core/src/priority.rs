//! The scheduling class of the threads a folder watch runs on.

use std::marker::PhantomData;

/// The quality of service class of one thread and its relative priority.
#[cfg(target_vendor = "apple")]
#[derive(Clone, Copy)]
struct Class {
    class: libc::qos_class_t,
    relative: libc::c_int,
}

#[cfg(target_vendor = "apple")]
impl Class {
    /// The calling thread's, or `None` where the system will not say.
    fn of_caller() -> Option<Class> {
        let mut class = libc::qos_class_t::QOS_CLASS_UNSPECIFIED;
        let mut relative = 0;
        // SAFETY: `pthread_self` is this thread, and both outputs are valid.
        let read = unsafe {
            libc::pthread_get_qos_class_np(libc::pthread_self(), &mut class, &mut relative)
        };
        (read == 0).then_some(Class { class, relative })
    }

    /// Puts the calling thread at this class. The system refuses a class it
    /// does not allow the thread, which leaves the thread as it was.
    fn set(self) {
        // SAFETY: the call takes a class and an integer and acts on the
        // calling thread alone.
        unsafe { libc::pthread_set_qos_class_self_np(self.class, self.relative) };
    }
}

/// Runs `work` at the quality of service class of the thread that calls
/// `inheriting`, which a new thread does not take from its creator.
///
/// Every thread the core starts for work a watch may do goes through this, so
/// a watch's helpers run at its class and an operation in the foreground keeps
/// its helpers in the foreground, with no operation lowered by another. Off
/// Apple platforms it changes nothing.
pub(crate) fn inheriting<T, F: FnOnce() -> T>(work: F) -> impl FnOnce() -> T {
    #[cfg(target_vendor = "apple")]
    let class = Class::of_caller();
    move || {
        #[cfg(target_vendor = "apple")]
        if let Some(class) = class {
            class.set();
        }
        work()
    }
}

/// Puts the calling thread at utility quality of service until the guard is
/// dropped, on Apple platforms, where the scheduler gives such a thread
/// efficiency cores and defers it under load. A watch is work the person did
/// not ask for at that moment. Utility, not background: inside an app the
/// person has open, a background thread can be deferred for far longer than
/// the few seconds an edit may wait, as in Low Power Mode. A thread already at
/// utility or lower is left as it is. Off Apple platforms it changes nothing;
/// the service manager's own settings cover the agent.
pub(crate) fn lowered() -> Lowered {
    #[cfg(target_vendor = "apple")]
    let before = Class::of_caller()
        .filter(|before| before.class as u32 > libc::qos_class_t::QOS_CLASS_UTILITY as u32);
    #[cfg(target_vendor = "apple")]
    if before.is_some() {
        Class {
            class: libc::qos_class_t::QOS_CLASS_UTILITY,
            relative: 0,
        }
        .set();
    }
    Lowered {
        #[cfg(target_vendor = "apple")]
        before,
        _same_thread: PhantomData,
    }
}

/// Puts the class the thread had when [`lowered`] was called back, where it
/// ends or unwinds. It belongs to the thread that made it.
pub(crate) struct Lowered {
    #[cfg(target_vendor = "apple")]
    before: Option<Class>,
    _same_thread: PhantomData<*const ()>,
}

#[cfg(target_vendor = "apple")]
impl Drop for Lowered {
    fn drop(&mut self) {
        if let Some(before) = self.before {
            before.set();
        }
    }
}

/// The quality of service class of the calling thread, as the system numbers it.
#[cfg(all(test, target_vendor = "apple"))]
pub(crate) fn current_class() -> u32 {
    let mut class = libc::qos_class_t::QOS_CLASS_UNSPECIFIED;
    let mut relative = 0;
    // SAFETY: `pthread_self` is this thread, and both outputs are valid.
    unsafe { libc::pthread_get_qos_class_np(libc::pthread_self(), &mut class, &mut relative) };
    class as u32
}

#[cfg(all(test, target_vendor = "apple"))]
mod tests {
    use super::*;
    use libc::qos_class_t::{
        QOS_CLASS_BACKGROUND, QOS_CLASS_DEFAULT, QOS_CLASS_USER_INITIATED, QOS_CLASS_UTILITY,
    };

    const UTILITY: u32 = QOS_CLASS_UTILITY as u32;
    const DEFAULT: u32 = QOS_CLASS_DEFAULT as u32;
    const INITIATED: u32 = QOS_CLASS_USER_INITIATED as u32;

    fn set(class: libc::qos_class_t) {
        // SAFETY: the call acts on the calling thread alone.
        assert_eq!(unsafe { libc::pthread_set_qos_class_self_np(class, 0) }, 0);
    }

    /// The class a thread started from a thread at `parent` reads, by a plain
    /// spawn and by `inheriting`.
    fn children_of(parent: libc::qos_class_t) -> (u32, u32) {
        std::thread::spawn(move || {
            set(parent);
            let plain = std::thread::spawn(current_class).join().unwrap();
            let inherited = std::thread::spawn(inheriting(current_class))
                .join()
                .unwrap();
            (plain, inherited)
        })
        .join()
        .unwrap()
    }

    #[test]
    fn a_thread_started_under_utility_work_runs_at_utility_and_under_default_work_at_default() {
        let (plain, inherited) = children_of(QOS_CLASS_UTILITY);
        // The witness: a plain spawn does not take its creator's class.
        assert_eq!(plain, DEFAULT);
        assert_eq!(inherited, UTILITY);
        let (_, inherited) = children_of(QOS_CLASS_DEFAULT);
        assert_eq!(inherited, DEFAULT);
        let (_, inherited) = children_of(QOS_CLASS_USER_INITIATED);
        assert_eq!(inherited, INITIATED);
    }

    #[test]
    fn a_scoped_thread_takes_the_class_of_the_thread_that_started_it() {
        let read = |parent| {
            std::thread::spawn(move || {
                set(parent);
                std::thread::scope(|scope| scope.spawn(inheriting(current_class)).join().unwrap())
            })
            .join()
            .unwrap()
        };
        assert_eq!(read(QOS_CLASS_UTILITY), UTILITY);
        assert_eq!(read(QOS_CLASS_DEFAULT), DEFAULT);
    }

    #[test]
    fn a_thread_is_lowered_to_utility_and_put_back_where_it_ends_or_unwinds() {
        let (before, during, after) = std::thread::spawn(|| {
            let before = current_class();
            let guard = lowered();
            let during = current_class();
            drop(guard);
            (before, during, current_class())
        })
        .join()
        .unwrap();
        assert_eq!(before, DEFAULT);
        assert_eq!(during, UTILITY);
        assert_eq!(after, DEFAULT);

        let (during, after) = std::thread::spawn(|| {
            let during = std::sync::Mutex::new(0);
            let unwound = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let _guard = lowered();
                *during.lock().unwrap() = current_class();
                panic!("a pass failed");
            }));
            assert!(unwound.is_err());
            let during = *during.lock().unwrap();
            (during, current_class())
        })
        .join()
        .unwrap();
        assert_eq!(during, UTILITY);
        assert_eq!(after, DEFAULT);
    }

    #[test]
    fn a_thread_already_at_utility_or_lower_is_not_raised() {
        for class in [QOS_CLASS_UTILITY, QOS_CLASS_BACKGROUND] {
            let (during, after) = std::thread::spawn(move || {
                set(class);
                let guard = lowered();
                let during = current_class();
                drop(guard);
                (during, current_class())
            })
            .join()
            .unwrap();
            assert_eq!(during, class as u32);
            assert_eq!(after, class as u32);
        }
    }
}
