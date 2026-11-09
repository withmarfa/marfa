//! The child's side: takes its limits, reads one file, answers, and ends.

use std::ffi::OsString;
use std::fs::File;
use std::io::Write;
use std::mem::ManuallyDrop;
use std::os::fd::FromRawFd;
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use super::wire::{Answer, Frame, MAX_REQUEST_BYTES, Request};
use super::{
    EXIT_BAD_REQUEST, EXIT_DEADLINE, EXIT_NOT_CONFINED, EXIT_OVER_MEMORY, EXIT_PARENT_GONE, confine,
};
use crate::{Sandbox, read_here};

#[cfg(feature = "native")]
unsafe extern "C" {
    fn marfa_exit_when_new_fails(code: libc::c_int);
}

/// How often the watchdog looks for its parent.
const WATCHDOG_TICK: Duration = Duration::from_millis(50);

fn exit(code: i32) -> ! {
    // SAFETY: _exit ends the process at once. Nothing is left to clean up, and running
    // the destructors of C++ code that may be damaged is a way to crash after answering.
    unsafe { libc::_exit(code) }
}

/// The time limit in milliseconds, the memory limit, and the request.
fn arguments_of(mut arguments: impl Iterator<Item = OsString>) -> Option<(u64, u64, Request)> {
    let time_ms = arguments.next()?.to_str()?.parse().ok()?;
    let memory = arguments.next()?.to_str()?.parse().ok()?;
    let json = arguments.next()?;
    if arguments.next().is_some() || json.len() > MAX_REQUEST_BYTES {
        return None;
    }
    let request = serde_json::from_slice(json.as_encoded_bytes()).ok()?;
    Some((time_ms, memory, request))
}

pub(super) fn serve(arguments: impl Iterator<Item = OsString>) -> ! {
    let Some((time_ms, memory, request)) = arguments_of(arguments) else {
        exit(EXIT_BAD_REQUEST);
    };
    // SAFETY: getppid takes nothing and cannot fail.
    let parent = unsafe { libc::getppid() };
    let started = Instant::now();
    let time_limit = Duration::from_millis(time_ms);
    confine::let_go_of_what_was_inherited();
    confine::take_limits(time_limit, memory);
    #[cfg(feature = "native")]
    // SAFETY: the shim only stores the code and sets a `new` handler.
    unsafe {
        marfa_exit_when_new_fails(EXIT_OVER_MEMORY)
    };

    // SAFETY: descriptor 0 is the file from the parent, opened for reading only, and
    // ManuallyDrop keeps its number in use, so nothing the reader opens can land on it.
    let file = ManuallyDrop::new(unsafe { File::from_raw_fd(0) });
    let options = request.options(memory);
    let data_dir: Option<PathBuf> = options.ocr.as_ref().and_then(|ocr| ocr.data_dir.clone());

    // Landlock binds only the calling thread and the threads it starts afterward, so
    // it comes before the watchdog: an unconfined thread beside code a file may have
    // taken over would be no confinement at all. The call filter is tried while there
    // is one thread, and goes on last, because no thread can start under it.
    let files = confine::deny_files_and_network(data_dir.as_deref());
    let filter = confine::CallFilter::ready(data_dir.is_some());
    start_watchdog(started + time_limit, parent);
    confine::start_no_more_processes();
    let state = filter.apply(files);
    #[cfg(feature = "fault-injection")]
    let state = super::fault::weaken(state);
    write_out(&Frame::line(state));
    if state != Sandbox::Full {
        exit(EXIT_NOT_CONFINED);
    }

    #[cfg(feature = "fault-injection")]
    if let Some(text) = super::fault::act(&super::fault::opening(&file, request.len)) {
        answer(&Answer::of(Ok(crate::Reading {
            text,
            truncated: false,
            cut_short: false,
            dimensions: None,
            duration: None,
            text_refused: None,
        })));
    }
    answer(&Answer::of(read_here(
        &file,
        request.len,
        &request.mime,
        &options,
    )));
}

/// Ends the process at the deadline, or soon after the parent has gone. A closed pipe
/// cannot tell it: `poll` on macOS never reports the far end of a pipe closing unless
/// asked for input.
///
/// Returns once the thread runs, because what a thread does to start is not what the
/// call filter allows.
fn start_watchdog(deadline: Instant, parent: libc::pid_t) {
    let (running, is_running) = mpsc::channel();
    let watch = move || {
        let _ = running.send(());
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                exit(EXIT_DEADLINE);
            }
            std::thread::sleep(left.min(WATCHDOG_TICK));
            // SAFETY: getppid takes nothing and cannot fail.
            if unsafe { libc::getppid() } != parent {
                exit(EXIT_PARENT_GONE);
            }
        }
    };
    let started = std::thread::Builder::new()
        .name("watchdog".into())
        .stack_size(64 * 1024)
        .spawn(watch);
    if started.is_err() || is_running.recv().is_err() {
        exit(EXIT_OVER_MEMORY);
    }
}

/// Writes the one answer and ends the process.
fn answer(answer: &Answer) -> ! {
    let Ok(json) = serde_json::to_vec(answer) else {
        exit(EXIT_OVER_MEMORY);
    };
    write_out(&json);
    exit(0);
}

fn write_out(bytes: &[u8]) {
    // SAFETY: descriptor 1 is the pipe to the parent. ManuallyDrop keeps it open.
    let mut stdout = ManuallyDrop::new(unsafe { File::from_raw_fd(1) });
    if stdout.write_all(bytes).is_err() {
        exit(EXIT_PARENT_GONE);
    }
}
