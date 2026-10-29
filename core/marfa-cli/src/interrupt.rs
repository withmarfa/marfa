//! Ctrl-C as a request to stop, for the commands that look for one.

use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};

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

/// The first of the two signals to arrive, or 0 before one has.
static ARRIVED: AtomicI32 = AtomicI32::new(0);

/// The process that sent [`ARRIVED`], or 0 where the platform did not say.
static SENDER: AtomicI32 = AtomicI32::new(0);

/// The status a shell gives a process that died of Ctrl-C.
pub const INTERRUPTED: u8 = crate::error::Exit::Interrupted as u8;

/// What a debug build with the `stop-notice` fault writes to stderr once the
/// stop is set, so a fixture can hold a request open until the command has
/// the stop to notice. A release build never writes it.
const STOP_NOTICE: &str = "marfa-test: stop raised";

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
    signal_set(ON_TERMINATE.load(Ordering::Relaxed))
}

fn signal_set(terminate: bool) -> libc::sigset_t {
    // SAFETY: the set is initialized before it is used.
    unsafe {
        let mut set: libc::sigset_t = std::mem::zeroed();
        libc::sigemptyset(&mut set);
        libc::sigaddset(&mut set, libc::SIGINT);
        if terminate {
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

/// Starts a thread that neither Ctrl-C nor `SIGTERM` is ever delivered to,
/// for work that runs beside a command that handles them itself. Both are
/// blocked around the start, so neither can reach the thread before the
/// thread has them blocked. `SIGTERM` is blocked whether or not the command
/// takes it, since such a thread, as telemetry's, starts before the command
/// says; a thread that does not block it still ends the process on it.
pub fn spawn_apart(
    name: &str,
    work: impl FnOnce() + Send + 'static,
) -> std::io::Result<std::thread::JoinHandle<()>> {
    let set = signal_set(true);
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

/// What stopped a command that took the interrupt or `SIGTERM`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Stop {
    pub signal: &'static str,
    /// The process that sent it, where the platform said: a signal the
    /// terminal raised for Ctrl-C comes from none.
    pub sender: Option<u32>,
}

impl Stop {
    /// How a log line says it: `SIGTERM, sent by process 4821`.
    pub fn describe(&self) -> String {
        match self.sender {
            Some(pid) => format!("{}, sent by process {pid}", self.signal),
            None => self.signal.to_string(),
        }
    }
}

/// The signal that stopped the command, once it has arrived.
pub fn stopped_by() -> Option<Stop> {
    let signal = match ARRIVED.load(Ordering::Acquire) {
        0 => return None,
        libc::SIGTERM => "SIGTERM",
        _ => "SIGINT",
    };
    Some(Stop {
        signal,
        sender: u32::try_from(SENDER.load(Ordering::Acquire))
            .ok()
            .filter(|pid| *pid > 0),
    })
}

/// Runs in whichever thread has the signal unblocked, which is only the one
/// that waits in `stop_on_interrupt`, and so does only what a handler may:
/// store to atomics and end the process.
extern "C" fn arrived(signal: libc::c_int, info: *mut libc::siginfo_t, _: *mut libc::c_void) {
    if ARRIVED
        .compare_exchange(0, signal, Ordering::AcqRel, Ordering::Acquire)
        .is_ok()
    {
        if !info.is_null() {
            // SAFETY: the kernel gives a handler installed with `SA_SIGINFO`
            // a `siginfo_t` that is valid for the call.
            SENDER.store(unsafe { sender_of(&*info) }, Ordering::Release);
        }
    } else if signal == libc::SIGINT {
        // SAFETY: ends the process without running anything else.
        unsafe { libc::_exit(i32::from(INTERRUPTED)) };
    }
}

#[cfg(target_vendor = "apple")]
unsafe fn sender_of(info: &libc::siginfo_t) -> i32 {
    info.si_pid
}

#[cfg(not(target_vendor = "apple"))]
unsafe fn sender_of(info: &libc::siginfo_t) -> i32 {
    // SAFETY: the caller passes what the kernel gave a handler.
    unsafe { info.si_pid() }
}

/// Ctrl-C raises the stop and does not interrupt what the process is doing: a
/// handler would fail a request in flight with `EINTR`, which reads as the
/// network failing rather than as a stop. The signal is blocked here, which
/// every thread made afterwards inherits, and one thread, with it unblocked
/// only while it waits in `sigsuspend`, takes it. So a command calls this
/// before it makes any thread, bar those that `spawn_apart`.
///
/// A second Ctrl-C ends the process at once, with the status a shell gives
/// one that died of it.
pub fn stop_on_interrupt() {
    block_in_this_thread();
    let set = interrupt_set();
    // SAFETY: an all-zero `sigaction` is a valid one, and the fields set
    // below are the ones this command needs.
    let mut action: libc::sigaction = unsafe { std::mem::zeroed() };
    action.sa_sigaction =
        arrived as extern "C" fn(libc::c_int, *mut libc::siginfo_t, *mut libc::c_void) as usize;
    action.sa_mask = set;
    action.sa_flags = libc::SA_SIGINFO | libc::SA_RESTART;
    for signal in [libc::SIGINT, libc::SIGTERM] {
        // SAFETY: the set is initialized.
        if unsafe { libc::sigismember(&set, signal) } == 1 {
            // SAFETY: `action` is initialized and names a handler that may
            // run in any thread.
            unsafe { libc::sigaction(signal, &action, std::ptr::null_mut()) };
        }
    }
    std::thread::spawn(move || {
        // The mask this thread inherited, less the signals it waits for.
        // `sigsuspend` swaps it in and waits in one step, so a signal that
        // arrived before the wait is taken at once and none is lost.
        let mut open = set;
        // SAFETY: the sets are initialized.
        unsafe {
            libc::pthread_sigmask(libc::SIG_BLOCK, std::ptr::null(), &mut open);
            libc::sigdelset(&mut open, libc::SIGINT);
            libc::sigdelset(&mut open, libc::SIGTERM);
        }
        let wait = || {
            // SAFETY: `open` is initialized. `sigsuspend` always returns -1,
            // with `EINTR`, once a handler has run.
            unsafe { libc::sigsuspend(&open) };
        };
        while ARRIVED.load(Ordering::Acquire) == 0 {
            wait();
        }
        match ARRIVED.load(Ordering::Acquire) {
            libc::SIGTERM => TERMINATED.store(true, Ordering::Relaxed),
            _ => SIGNALED.store(true, Ordering::Relaxed),
        }
        STOP.store(true, Ordering::Relaxed);
        if marfa_core::fault::named("stop-notice").is_some() {
            use std::io::Write;
            let _ = std::io::stderr().write_all(format!("{STOP_NOTICE}\n").as_bytes());
        }
        // Stays to take a second Ctrl-C, which `arrived` ends the process on.
        loop {
            wait();
        }
    });
}
