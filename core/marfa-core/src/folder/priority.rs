//! The scheduling class of the threads a folder watch runs on.

/// Puts the calling thread at utility quality of service on Apple platforms,
/// where the scheduler gives it efficiency cores and defers it under load. A
/// watch is work the person did not ask for at that moment. Utility, not
/// background: inside an app the person has open, a background thread can be
/// deferred for far longer than the few seconds an edit may wait, as in Low
/// Power Mode. Elsewhere it changes nothing; the service manager's own
/// settings cover the agent.
///
/// A thread started by a thread at utility does not inherit the class, so
/// each thread of a watch calls this itself.
pub fn run_as_utility_work() {
    #[cfg(target_vendor = "apple")]
    {
        // SAFETY: the call takes two integers and acts on the calling thread
        // alone. It fails only for a class the system lacks, which leaves the
        // thread as it was.
        unsafe {
            libc::pthread_set_qos_class_self_np(libc::qos_class_t::QOS_CLASS_UTILITY, 0);
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
    const UTILITY: u32 = libc::qos_class_t::QOS_CLASS_UTILITY as u32;

    #[test]
    fn a_thread_runs_at_utility_quality_of_service_once_it_asks() {
        let (before, after) = std::thread::spawn(|| {
            let before = current_class();
            run_as_utility_work();
            (before, current_class())
        })
        .join()
        .unwrap();
        // The witness: a thread that has not asked is not at utility.
        assert_ne!(before, UTILITY);
        assert_eq!(after, UTILITY);
    }
}
