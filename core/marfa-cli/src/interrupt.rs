//! Ctrl-C as a request to stop, for the commands that look for one.

use std::sync::atomic::{AtomicBool, Ordering};

/// Shared by the signal-waiting thread and the command it stops.
static STOP: AtomicBool = AtomicBool::new(false);

/// Set once the interrupt has arrived, which a `--for` limit never sets.
static SIGNALED: AtomicBool = AtomicBool::new(false);

/// Set by a command that runs until it is stopped, when the interrupt is what
/// stopped it.
static ENDED: AtomicBool = AtomicBool::new(false);

/// The status a shell gives a process that died of Ctrl-C.
pub const INTERRUPTED: u8 = 130;

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

/// For a command that runs until the person stops it: call when it returns.
/// The process then leaves with the status the interrupt gave it before this
/// command handled the signal itself.
pub fn ended_by_interrupt() {
    if SIGNALED.load(Ordering::Relaxed) {
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
/// every thread made afterwards inherits, and one thread waits for it. That
/// makes this the first thing a command does, before any thread is made, bar
/// those that `spawn_apart`.
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
                0 => return true,
                libc::EINTR => continue,
                _ => return false,
            }
        };
        if !wait() {
            return;
        }
        SIGNALED.store(true, Ordering::Relaxed);
        STOP.store(true, Ordering::Relaxed);
        if wait() {
            // SAFETY: ends the process without running anything else.
            unsafe { libc::_exit(i32::from(INTERRUPTED)) };
        }
    });
}
