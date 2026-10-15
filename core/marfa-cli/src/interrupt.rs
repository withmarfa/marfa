//! Ctrl-C as a request to stop, for the commands that look for one.

use std::sync::atomic::{AtomicBool, Ordering};

/// Shared by the signal-waiting thread and the command it stops.
static STOP: AtomicBool = AtomicBool::new(false);

/// Set once the interrupt has arrived, which a `--for` limit never sets.
static SIGNALED: AtomicBool = AtomicBool::new(false);

/// Set by a command that runs until it is stopped, when the interrupt is what
/// stopped it.
static ENDED: AtomicBool = AtomicBool::new(false);

/// Set before the stop is armed by a command that a service manager stops,
/// so that `SIGTERM` raises the stop as Ctrl-C does.
static ON_TERMINATE: AtomicBool = AtomicBool::new(false);

/// Set once `SIGTERM` has arrived, for a command that takes it.
static TERMINATED: AtomicBool = AtomicBool::new(false);

/// The status a shell gives a process that died of Ctrl-C.
pub const INTERRUPTED: u8 = crate::error::Exit::Interrupted as u8;

pub fn stop() -> &'static AtomicBool {
    &STOP
}

pub fn stop_after(seconds: Option<u64>) -> &'static AtomicBool {
    if let Some(seconds) = seconds {
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(seconds));
            STOP.store(true, Ordering::Relaxed);
        });
    }
    &STOP
}

/// Whether Ctrl-C has arrived, which a `--for` limit never does.
pub fn signaled() -> bool {
    SIGNALED.load(Ordering::Relaxed)
}

/// For a command that a service manager runs and stops: `SIGTERM` raises
/// the stop as Ctrl-C does, and the command ends as one that completed. A
/// second `SIGTERM` changes nothing, since a manager that will not wait
/// sends `SIGKILL`. Call before any thread is made, as for
/// `stop_on_interrupt`.
pub fn stop_on_terminate_too() {
    ON_TERMINATE.store(true, Ordering::Relaxed);
}

/// Whether Ctrl-C or, for a command that takes it, `SIGTERM` has arrived.
pub fn asked_to_stop() -> bool {
    signaled() || TERMINATED.load(Ordering::Relaxed)
}

/// For a command that runs until the person stops it: call when it returns.
/// The process then leaves with the status the interrupt gave it before this
/// command handled the signal itself.
pub fn ended_by_interrupt() {
    if signaled() {
        ENDED.store(true, Ordering::Relaxed);
    }
}

/// The status the process leaves with after `exit` from the command.
pub fn status(exit: u8) -> u8 {
    if ENDED.load(Ordering::Relaxed) {
        INTERRUPTED
    } else {
        exit
    }
}

fn interrupt_set() -> libc::sigset_t {
    // SAFETY: the set is initialized before it is used.
    unsafe {
        let mut set: libc::sigset_t = std::mem::zeroed();
        libc::sigemptyset(&mut set);
        libc::sigaddset(&mut set, libc::SIGINT);
        if ON_TERMINATE.load(Ordering::Relaxed) {
            libc::sigaddset(&mut set, libc::SIGTERM);
        }
        set
    }
}

fn block_in_this_thread() {
    let set = interrupt_set();
    // SAFETY: the set is initialized.
    unsafe {
        libc::pthread_sigmask(libc::SIG_BLOCK, &set, std::ptr::null_mut());
    }
}

/// Starts a thread that Ctrl-C is never delivered to, for work that runs
/// beside a command that handles the signal itself. The signal is blocked
/// around the start, so it cannot reach the thread before the thread has it
/// blocked.
pub fn spawn_apart(
    name: &str,
    work: impl FnOnce() + Send + 'static,
) -> std::io::Result<std::thread::JoinHandle<()>> {
    let set = interrupt_set();
    // SAFETY: the sets are initialized, and the caller's mask is put back.
    unsafe {
        let mut before: libc::sigset_t = std::mem::zeroed();
        libc::pthread_sigmask(libc::SIG_BLOCK, &set, &mut before);
        let started = std::thread::Builder::new()
            .name(name.to_string())
            .spawn(work);
        libc::pthread_sigmask(libc::SIG_SETMASK, &before, std::ptr::null_mut());
        started
    }
}

/// Ctrl-C raises the stop and does not interrupt what the process is doing: a
/// handler would fail a request in flight with `EINTR`, which reads as the
/// network failing rather than as a stop. The signal is blocked here, which
/// every thread made afterwards inherits, and one thread waits for it. So a
/// command calls this before it makes any thread, bar those that
/// `spawn_apart`.
///
/// A second Ctrl-C ends the process at once, with the status a shell gives
/// one that died of it.
pub fn stop_on_interrupt() {
    block_in_this_thread();
    let set = interrupt_set();
    std::thread::spawn(move || {
        // Where the platform lets `sigwait` fail with `EINTR`, a wait that
        // gave up would leave the signal blocked for good.
        let wait = || loop {
            let mut signal = 0;
            // SAFETY: the set is initialized and `signal` outlives the call.
            match unsafe { libc::sigwait(&set, &mut signal) } {
                0 => return Some(signal),
                libc::EINTR => continue,
                _ => return None,
            }
        };
        match wait() {
            Some(libc::SIGTERM) => TERMINATED.store(true, Ordering::Relaxed),
            Some(_) => SIGNALED.store(true, Ordering::Relaxed),
            None => return,
        }
        STOP.store(true, Ordering::Relaxed);
        while let Some(signal) = wait() {
            if signal == libc::SIGINT {
                // SAFETY: ends the process without running anything else.
                unsafe { libc::_exit(i32::from(INTERRUPTED)) };
            }
        }
    });
}
