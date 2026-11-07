//! The parent's side. One loop on the calling thread feeds the child, reads what it
//! says and watches the clock and its memory, so there is no thread to leak, and a
//! process that kept a pipe open cannot hold the loop past the child's end.

use std::io::{ErrorKind, Read, Write};
use std::os::fd::{AsRawFd, RawFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

use super::wire::{self, Answer, MAX_REQUEST_BYTES, OcrRequest, Request};
use super::{CHILD_ARG, EXIT_DEADLINE, EXIT_OVER_MEMORY, footprint};
use crate::kind::Kind;
use crate::{NATIVE, Options, Reading, Refusal};

/// How often a running child's memory is looked at, and the longest the loop sleeps.
const TICK: Duration = Duration::from_millis(10);

/// The most of what a child writes to stderr that is kept: the end of it, which is
/// where a fatal message is.
const STDERR_KEPT: usize = 4096;

/// How much of stderr goes into a reason.
const STDERR_REPORTED: usize = 512;

/// Room in a child's answer for everything but the text.
const ANSWER_OVERHEAD: usize = 2 * wire::MAX_REASON_BYTES + 4096;

/// The most bytes one UTF-16 code unit of text takes in the JSON a child writes: six,
/// as a `\uXXXX` escape.
const JSON_BYTES_PER_UNIT: usize = 6;

/// The longest MIME type taken. A real one is far shorter.
const MAX_MIME_BYTES: usize = 1024;

/// A time limit past this means nothing to a file, and is held here so the deadline
/// always fits a clock.
const LONGEST_TIME_LIMIT: Duration = Duration::from_hours(24);

/// The name a child shows in a process listing.
const CHILD_NAME: &str = "marfa-enrichment-child";

/// The start of what Rust's standard library writes before it aborts for an allocation
/// that failed. It offers no stable way to act on that failure instead.
const RUST_OUT_OF_MEMORY: &str = "memory allocation of ";

pub(super) fn read(
    program: Option<&PathBuf>,
    bytes: &[u8],
    mime: &str,
    options: &Options,
) -> Result<Reading, Refusal> {
    refuse_without_a_child(bytes, mime, options)?;
    let program = program
        .ok_or_else(|| Refusal::ReaderUnavailable("the program cannot find itself".into()))?;
    let time_limit = options.time_limit.min(LONGEST_TIME_LIMIT);
    let deadline = Instant::now() + time_limit;
    let request = frame(bytes, mime, options, time_limit)?;

    let mut watched = Watched::start(program, time_limit, options.max_memory_bytes)?;
    let cap = options
        .max_text_chars
        .saturating_mul(JSON_BYTES_PER_UNIT)
        .saturating_add(ANSWER_OVERHEAD);
    let mut said = Said::new(cap);
    let end = watched.run(
        [&request, bytes],
        &mut said,
        options.max_memory_bytes,
        deadline,
    );
    let status = watched.reap();
    conclude(end, status, &said, options)
}

/// What can be decided from the call alone never starts a process.
fn refuse_without_a_child(bytes: &[u8], mime: &str, options: &Options) -> Result<(), Refusal> {
    if mime.len() > MAX_MIME_BYTES {
        return Err(Refusal::Unsupported);
    }
    match Kind::of(mime) {
        None => return Err(Refusal::Unsupported),
        Some(Kind::Pdf) if !NATIVE => return Err(Refusal::Unsupported),
        Some(_) => {}
    }
    if bytes.len() as u64 > options.max_memory_bytes {
        return Err(Refusal::OverLimit(format!(
            "the file is {} bytes, and the memory limit is {}",
            bytes.len(),
            options.max_memory_bytes
        )));
    }
    Ok(())
}

/// The soft budget stops OCR with time left to send what it read before the deadline.
fn soft_budget(options: &Options, time_limit: Duration) -> Duration {
    options
        .time_budget
        .unwrap_or(time_limit.mul_f64(crate::SOFT_SHARE_OF_LIMIT))
        .min(time_limit)
}

/// The request, after the four bytes of its length.
fn frame(
    bytes: &[u8],
    mime: &str,
    options: &Options,
    time_limit: Duration,
) -> Result<Vec<u8>, Refusal> {
    let request = Request {
        mime: mime.to_owned(),
        len: bytes.len() as u64,
        max_text_chars: options.max_text_chars as u64,
        max_inflated_bytes: options.max_inflated_bytes,
        time_budget_ms: u64::try_from(soft_budget(options, time_limit).as_millis())
            .unwrap_or(u64::MAX),
        ocr: options.ocr.as_ref().map(|ocr| OcrRequest {
            languages: ocr.languages.clone(),
            data_dir: ocr.data_dir.as_deref().map(resolved),
        }),
    };
    let json = serde_json::to_vec(&request)
        .map_err(|error| Refusal::ReaderUnavailable(format!("cannot write a request: {error}")))?;
    let len = u32::try_from(json.len())
        .ok()
        .filter(|len| *len <= MAX_REQUEST_BYTES)
        .ok_or_else(|| Refusal::OcrUnavailable("the OCR settings are too long".into()))?;
    let mut framed = Vec::with_capacity(json.len() + 4);
    framed.extend_from_slice(&len.to_le_bytes());
    framed.extend_from_slice(&json);
    Ok(framed)
}

/// A child works in `/`, and a sandbox names real paths, so a folder given relative or
/// through a link has to be resolved here. A folder that is not there stays as given:
/// the child finds nothing in it.
fn resolved(dir: &Path) -> Vec<u8> {
    let real = dir
        .canonicalize()
        .or_else(|_| std::path::absolute(dir))
        .unwrap_or_else(|_| dir.to_owned());
    real.as_os_str().as_bytes().to_vec()
}

/// How the loop ended.
#[derive(Clone, Copy, Debug)]
enum End {
    Deadline,
    OverMemory(u64),
    TooMuchOutput,
    /// The child ended by itself.
    Exited,
}

/// What a child wrote.
struct Said {
    stdout: Vec<u8>,
    cap: usize,
    stderr: Vec<u8>,
}

impl Said {
    fn new(cap: usize) -> Self {
        Self {
            stdout: Vec::new(),
            cap,
            stderr: Vec::new(),
        }
    }

    fn over_cap(&self) -> bool {
        self.stdout.len() > self.cap
    }

    fn keep_stderr(&mut self, chunk: &[u8]) {
        self.stderr.extend_from_slice(chunk);
        if self.stderr.len() > STDERR_KEPT {
            self.stderr.drain(..self.stderr.len() - STDERR_KEPT);
        }
    }

    /// The end of stderr, fit for a log: a child chooses these bytes.
    fn stderr_for_a_log(&self) -> String {
        let text = String::from_utf8_lossy(&self.stderr);
        let start = text
            .char_indices()
            .rev()
            .nth(STDERR_REPORTED)
            .map_or(0, |(index, _)| index);
        text[start..]
            .chars()
            .map(|c| if c.is_control() { ' ' } else { c })
            .collect::<String>()
            .trim()
            .to_owned()
    }

    fn ran_out_of_memory_in_rust(&self) -> bool {
        String::from_utf8_lossy(&self.stderr)
            .lines()
            .any(|line| line.starts_with(RUST_OUT_OF_MEMORY))
    }
}

/// A running child. Dropping it kills and reaps, so no path out of `read`, a panic
/// included, leaves a process or a zombie.
struct Watched {
    child: Child,
    pid: libc::pid_t,
    stdin: Option<ChildStdin>,
    stdout: Option<ChildStdout>,
    stderr: Option<ChildStderr>,
    reaped: bool,
}

impl Watched {
    fn start(program: &Path, time_limit: Duration, max_memory: u64) -> Result<Self, Refusal> {
        let mut child = Command::new(program)
            .arg0(CHILD_NAME)
            .arg(CHILD_ARG)
            .arg(time_limit.as_millis().to_string())
            .arg(max_memory.to_string())
            .env_clear()
            .current_dir("/")
            // Its own group, so anything it started ends with it.
            .process_group(0)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| {
                Refusal::ReaderUnavailable(format!("cannot start a reader: {error}"))
            })?;
        let pid = libc::pid_t::try_from(child.id()).expect("a process id fits a pid_t");
        let (stdin, stdout, stderr) =
            (child.stdin.take(), child.stdout.take(), child.stderr.take());
        let watched = Self {
            child,
            pid,
            stdin,
            stdout,
            stderr,
            reaped: false,
        };
        for fd in [
            watched.stdin.as_ref().map(AsRawFd::as_raw_fd),
            watched.stdout.as_ref().map(AsRawFd::as_raw_fd),
            watched.stderr.as_ref().map(AsRawFd::as_raw_fd),
        ]
        .into_iter()
        .flatten()
        {
            set_nonblocking(fd).map_err(|error| {
                Refusal::ReaderUnavailable(format!("cannot set a pipe: {error}"))
            })?;
        }
        Ok(watched)
    }

    /// Runs until the child ends or has to be ended.
    fn run(
        &mut self,
        mut feed: [&[u8]; 2],
        said: &mut Said,
        max_memory: u64,
        deadline: Instant,
    ) -> End {
        let mut next_sample = Instant::now();
        let mut idle = Duration::from_millis(1);
        loop {
            let now = Instant::now();
            if now >= deadline {
                return End::Deadline;
            }
            if now >= next_sample {
                next_sample = now + TICK;
                if let Some(used) = footprint::of(self.pid)
                    && used > max_memory
                {
                    return End::OverMemory(used);
                }
            }
            if self.has_ended() {
                self.kill();
                self.drain(said);
                return if said.over_cap() {
                    End::TooMuchOutput
                } else {
                    End::Exited
                };
            }

            let feeding = feed.iter().any(|part| !part.is_empty());
            let mut wanted: [Option<(RawFd, libc::c_short)>; 3] = [
                self.stdin
                    .as_ref()
                    .filter(|_| feeding)
                    .map(|pipe| (pipe.as_raw_fd(), libc::POLLOUT)),
                self.stdout
                    .as_ref()
                    .map(|pipe| (pipe.as_raw_fd(), libc::POLLIN)),
                self.stderr
                    .as_ref()
                    .map(|pipe| (pipe.as_raw_fd(), libc::POLLIN)),
            ];
            let mut wait = (deadline - now).min(next_sample.saturating_duration_since(now));
            if wanted.iter().all(Option::is_none) {
                // Every pipe has closed, so the child is on its way out: look again
                // soon, and less often if it lingers.
                wait = wait.min(idle);
                idle = (idle * 2).min(TICK);
            }
            let ready = wait_for(&mut wanted, wait);
            if ready[0] {
                self.write_some(&mut feed);
            }
            if ready[1] || ready[2] {
                self.drain(said);
                if said.over_cap() {
                    return End::TooMuchOutput;
                }
            }
        }
    }

    /// Whether the child has ended, without reaping it: until it is reaped its id
    /// stays its own, so killing its group can reach nothing else.
    fn has_ended(&self) -> bool {
        let mut info = std::mem::MaybeUninit::<libc::siginfo_t>::zeroed();
        // SAFETY: `info` is a buffer for one siginfo_t, and WNOWAIT leaves the child
        // to `reap`.
        let status = unsafe {
            libc::waitid(
                libc::P_PID,
                self.pid.cast_unsigned(),
                info.as_mut_ptr(),
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            )
        };
        if status != 0 {
            // A host that ignores SIGCHLD reaps by itself. `reap` reports it.
            return true;
        }
        // SAFETY: waitid returned, so `info` is zero or filled in, and with WNOHANG
        // and nothing to report the id stays zero.
        let info = unsafe { info.assume_init() };
        // SAFETY: waitid fills `si_pid` for a child, and it reads zero otherwise.
        let reported = unsafe { info.si_pid() } != 0;
        // macOS also reports a child that has only stopped, despite WEXITED.
        reported
            && matches!(
                info.si_code,
                libc::CLD_EXITED | libc::CLD_KILLED | libc::CLD_DUMPED
            )
    }

    fn write_some(&mut self, feed: &mut [&[u8]; 2]) {
        let Some(stdin) = self.stdin.as_mut() else {
            return;
        };
        for part in feed.iter_mut() {
            while !part.is_empty() {
                match stdin.write(part) {
                    Ok(0) => {
                        *feed = [&[], &[]];
                        self.stdin = None;
                        return;
                    }
                    Ok(written) => *part = &part[written..],
                    Err(error) if error.kind() == ErrorKind::Interrupted => {}
                    Err(error) if error.kind() == ErrorKind::WouldBlock => return,
                    // A child that closed stdin wants no more. What it does next
                    // decides the result.
                    Err(_) => {
                        *feed = [&[], &[]];
                        self.stdin = None;
                        return;
                    }
                }
            }
        }
        self.stdin = None;
    }

    /// Reads what is there now, and notes each pipe that has closed.
    fn drain(&mut self, said: &mut Said) {
        let mut chunk = [0u8; 64 * 1024];
        if let Some(stdout) = self.stdout.as_mut() {
            let closed = drain_pipe(stdout, &mut chunk, |read| {
                said.stdout.extend_from_slice(read);
                !said.over_cap()
            });
            if closed {
                self.stdout = None;
            }
        }
        if let Some(stderr) = self.stderr.as_mut() {
            // A child may write here without end; only its last words are kept, and
            // the deadline ends it. Bounded so that it cannot hold up stdout.
            let mut budget = 16;
            let closed = drain_pipe(stderr, &mut chunk, |read| {
                said.keep_stderr(read);
                budget -= 1;
                budget > 0
            });
            if closed {
                self.stderr = None;
            }
        }
    }

    fn kill(&self) {
        // SAFETY: a negative id names the child's group, which it leads, and the child
        // is not reaped, so the id is still its own.
        unsafe { libc::kill(-self.pid, libc::SIGKILL) };
    }

    /// Ends the child if it has not ended, and collects it.
    fn reap(&mut self) -> Option<ExitStatus> {
        self.kill();
        self.reaped = true;
        self.child.wait().ok()
    }
}

impl Drop for Watched {
    fn drop(&mut self) {
        if !self.reaped {
            self.reap();
        }
    }
}

/// Reads until the pipe has nothing, closes, or `take` says stop. Whether it closed.
fn drain_pipe(pipe: &mut impl Read, chunk: &mut [u8], mut take: impl FnMut(&[u8]) -> bool) -> bool {
    loop {
        match pipe.read(chunk) {
            Ok(0) => return true,
            Ok(read) => {
                if !take(&chunk[..read]) {
                    return false;
                }
            }
            Err(error) if error.kind() == ErrorKind::Interrupted => {}
            Err(error) if error.kind() == ErrorKind::WouldBlock => return false,
            Err(_) => return true,
        }
    }
}

fn set_nonblocking(fd: RawFd) -> std::io::Result<()> {
    // SAFETY: `fd` is open for the length of these calls and the flags are plain ints.
    unsafe {
        let flags = libc::fcntl(fd, libc::F_GETFL);
        if flags < 0 || libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) < 0 {
            return Err(std::io::Error::last_os_error());
        }
    }
    Ok(())
}

/// Waits up to `wait` for any of the pipes, and says which have something to do.
fn wait_for(wanted: &mut [Option<(RawFd, libc::c_short)>; 3], wait: Duration) -> [bool; 3] {
    let mut fds: [libc::pollfd; 3] = [libc::pollfd {
        // A negative descriptor is one poll skips.
        fd: -1,
        events: 0,
        revents: 0,
    }; 3];
    for (slot, want) in fds.iter_mut().zip(wanted.iter()) {
        if let Some((fd, events)) = want {
            slot.fd = *fd;
            slot.events = *events;
        }
    }
    let millis = libc::c_int::try_from(wait.as_micros().div_ceil(1000)).unwrap_or(libc::c_int::MAX);
    // SAFETY: `fds` holds three initialized entries, and that is the count passed.
    let count = unsafe { libc::poll(fds.as_mut_ptr(), 3, millis) };
    if count <= 0 {
        return [false; 3];
    }
    [
        fds[0].revents != 0,
        fds[1].revents != 0,
        fds[2].revents != 0,
    ]
}

/// The one result of a reading, from how it ended and what the child said.
fn conclude(
    end: End,
    status: Option<ExitStatus>,
    said: &Said,
    options: &Options,
) -> Result<Reading, Refusal> {
    match end {
        End::Deadline => return Err(Refusal::TimedOut),
        End::OverMemory(used) => return Err(over_memory(options, Some(used))),
        End::TooMuchOutput => {
            return Err(Refusal::Crashed("the reader wrote more than it may".into()));
        }
        End::Exited => {}
    }
    let Some(status) = status else {
        return Err(Refusal::Crashed("the reader's end cannot be known".into()));
    };
    if let Some(signal) = status.signal() {
        return Err(match signal {
            libc::SIGXCPU => Refusal::TimedOut,
            libc::SIGABRT if said.ran_out_of_memory_in_rust() => over_memory(options, None),
            signal => crashed(&format!("ended by {}", signal_name(signal)), said),
        });
    }
    match status.code() {
        Some(0) => {
            Answer::judge(&said.stdout, options.max_text_chars).map_err(|refusal| match refusal {
                Refusal::Crashed(why) => with_last_words(why, said),
                refusal => refusal,
            })
        }
        Some(EXIT_OVER_MEMORY) => Err(over_memory(options, None)),
        Some(EXIT_DEADLINE) => Err(Refusal::TimedOut),
        Some(code) => Err(crashed(&format!("exited with code {code}"), said)),
        None => Err(crashed("ended in no way the system can name", said)),
    }
}

fn over_memory(options: &Options, used: Option<u64>) -> Refusal {
    let limit = options.max_memory_bytes;
    Refusal::OverLimit(match used {
        Some(used) => format!("the reader held {used} bytes, and the memory limit is {limit}"),
        None => format!("the reader ran out of memory under the limit of {limit} bytes"),
    })
}

fn crashed(how: &str, said: &Said) -> Refusal {
    with_last_words(format!("the reader {how}"), said)
}

fn with_last_words(why: String, said: &Said) -> Refusal {
    let last_words = said.stderr_for_a_log();
    Refusal::Crashed(if last_words.is_empty() {
        why
    } else {
        format!("{why}: {last_words}")
    })
}

fn signal_name(signal: i32) -> String {
    let name = match signal {
        libc::SIGABRT => "SIGABRT",
        libc::SIGALRM => "SIGALRM",
        libc::SIGBUS => "SIGBUS",
        libc::SIGFPE => "SIGFPE",
        libc::SIGHUP => "SIGHUP",
        libc::SIGILL => "SIGILL",
        libc::SIGINT => "SIGINT",
        libc::SIGKILL => "SIGKILL",
        libc::SIGPIPE => "SIGPIPE",
        libc::SIGQUIT => "SIGQUIT",
        libc::SIGSEGV => "SIGSEGV",
        libc::SIGSYS => "SIGSYS",
        libc::SIGTERM => "SIGTERM",
        libc::SIGTRAP => "SIGTRAP",
        libc::SIGXFSZ => "SIGXFSZ",
        other => return format!("signal {other}"),
    };
    name.to_owned()
}
