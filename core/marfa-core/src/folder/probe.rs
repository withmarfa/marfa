//! What a test learns of one folder watch from outside it.
//!
//! The watch loop runs on the thread that calls `watch`, so a probe installed
//! on that thread hears that watch alone.

use std::cell::RefCell;
use std::ffi::OsStr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::ThreadId;

#[derive(Default)]
pub(super) struct Probe {
    thread: Mutex<Option<ThreadId>>,
    passes: AtomicUsize,
    changed: Mutex<Vec<PathBuf>>,
}

thread_local! {
    static HERE: RefCell<Option<Arc<Probe>>> = const { RefCell::new(None) };
}

/// Ends the probe on the thread that installed it when dropped.
pub(super) struct Installed(std::marker::PhantomData<*const ()>);

impl Drop for Installed {
    fn drop(&mut self) {
        HERE.with(|here| here.borrow_mut().take());
    }
}

fn held<T>(lock: &Mutex<T>) -> MutexGuard<'_, T> {
    lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl Probe {
    /// Listens to the watch the calling thread goes on to run.
    pub(super) fn install(self: &Arc<Self>) -> Installed {
        *held(&self.thread) = Some(std::thread::current().id());
        HERE.with(|here| *here.borrow_mut() = Some(Arc::clone(self)));
        Installed(std::marker::PhantomData)
    }

    /// Whether the watch's thread waits on the manual clock for a time the
    /// clock has not reached.
    pub(super) fn waits_on_the_clock(&self) -> bool {
        let thread = *held(&self.thread);
        thread.is_some_and(crate::clock::waiting_on)
    }

    /// The passes the watch has started.
    pub(super) fn passes(&self) -> usize {
        self.passes.load(Ordering::SeqCst)
    }

    /// Whether the watch has taken a change to a file with this name.
    pub(super) fn took_a_change_to(&self, name: &OsStr) -> bool {
        held(&self.changed)
            .iter()
            .any(|path| path.file_name() == Some(name))
    }
}

pub(super) fn pass_started() {
    HERE.with(|here| {
        if let Some(probe) = &*here.borrow() {
            probe.passes.fetch_add(1, Ordering::SeqCst);
        }
    });
}

pub(super) fn change_taken(paths: &[PathBuf]) {
    HERE.with(|here| {
        if let Some(probe) = &*here.borrow() {
            held(&probe.changed).extend(paths.iter().cloned());
        }
    });
}
