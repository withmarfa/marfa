//! The child's side: takes its limits, reads one file, answers, and ends.

use std::ffi::OsString;
use std::fs::File;
use std::io::{Read, Write};
use std::mem::ManuallyDrop;
use std::os::fd::FromRawFd;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use super::wire::{Answer, MAX_REQUEST_BYTES, Request};
use super::{EXIT_BAD_REQUEST, EXIT_DEADLINE, EXIT_OVER_MEMORY, EXIT_PARENT_GONE, confine};
use crate::{Refusal, read_here};

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

fn numbers(mut arguments: impl Iterator<Item = OsString>) -> Option<(u64, u64)> {
    let time_ms = arguments.next()?.to_str()?.parse().ok()?;
    let memory = arguments.next()?.to_str()?.parse().ok()?;
    arguments.next().is_none().then_some((time_ms, memory))
}

pub(super) fn serve(arguments: impl Iterator<Item = OsString>) -> ! {
    let Some((time_ms, memory)) = numbers(arguments) else {
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

    // SAFETY: descriptor 0 is the pipe from the parent, and ManuallyDrop keeps its
    // number in use, so nothing the reader opens can land on it.
    let mut stdin = ManuallyDrop::new(unsafe { File::from_raw_fd(0) });
    let request = read_request(&mut stdin);
    let options = request.options();
    let data_dir: Option<PathBuf> = options.ocr.as_ref().and_then(|ocr| ocr.data_dir.clone());

    // Landlock binds only the calling thread and the threads it starts afterward, so
    // it comes before the watchdog: an unconfined thread beside code a file may have
    // taken over would be no confinement at all.
    let sandbox = confine::deny_files_and_network(data_dir.as_deref());
    start_watchdog(started + time_limit, parent);
    confine::start_no_more_processes();

    let bytes = read_bytes(&mut stdin, request.len);
    #[cfg(feature = "fault-injection")]
    if let Some(text) = super::fault::act(&bytes) {
        answer(&Answer::of(
            Ok(crate::Reading {
                text,
                truncated: false,
                cut_short: false,
                dimensions: None,
                sandbox,
            }),
            sandbox,
        ));
    }
    let outcome = bytes.and_then(|bytes| read_here(&bytes, &request.mime, &options));
    answer(&Answer::of(outcome, sandbox));
}

fn read_request(stdin: &mut File) -> Request {
    let mut len = [0u8; 4];
    if stdin.read_exact(&mut len).is_err() {
        exit(EXIT_PARENT_GONE);
    }
    let len = u32::from_le_bytes(len);
    if len > MAX_REQUEST_BYTES {
        exit(EXIT_BAD_REQUEST);
    }
    let mut json = vec![0u8; len as usize];
    if stdin.read_exact(&mut json).is_err() {
        exit(EXIT_PARENT_GONE);
    }
    serde_json::from_slice(&json).unwrap_or_else(|_| exit(EXIT_BAD_REQUEST))
}

fn read_bytes(stdin: &mut File, len: u64) -> Result<Vec<u8>, Refusal> {
    let too_big = || Refusal::OverLimit(format!("no memory to hold a file of {len} bytes"));
    let len = usize::try_from(len).map_err(|_| too_big())?;
    let mut bytes = Vec::new();
    bytes.try_reserve_exact(len).map_err(|_| too_big())?;
    bytes.resize(len, 0);
    #[cfg(feature = "fault-injection")]
    let start = super::fault::read_opening(stdin, &mut bytes);
    #[cfg(not(feature = "fault-injection"))]
    let start = 0;
    if stdin.read_exact(&mut bytes[start..]).is_err() {
        exit(EXIT_PARENT_GONE);
    }
    Ok(bytes)
}

/// Ends the process at the deadline, or soon after the parent has gone. A closed pipe
/// cannot tell it: `poll` on macOS never reports the far end of a pipe closing unless
/// asked for input, and input here belongs to the main thread.
fn start_watchdog(deadline: Instant, parent: libc::pid_t) {
    let watch = move || {
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
    if started.is_err() {
        exit(EXIT_OVER_MEMORY);
    }
}

/// Writes the one answer and ends the process.
fn answer(answer: &Answer) -> ! {
    let Ok(json) = serde_json::to_vec(answer) else {
        exit(EXIT_OVER_MEMORY);
    };
    // SAFETY: descriptor 1 is the pipe to the parent. ManuallyDrop keeps it open.
    let mut stdout = ManuallyDrop::new(unsafe { File::from_raw_fd(1) });
    if stdout.write_all(&json).is_err() {
        exit(EXIT_PARENT_GONE);
    }
    exit(0);
}
