//! The parent's side: one loop on the calling thread watches the child's output, clock and memory.

use std::fs::File;
use std::io::{ErrorKind, Read};
use std::os::fd::{AsRawFd, RawFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStderr, ChildStdout, Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

use super::wire::{
    self, Answer, Asked, Frame, MAX_FRAME_BYTES, MAX_REQUEST_BYTES, OcrRequest, Request,
};
use super::{CHILD_ARG, EXIT_BY_SIGNAL, EXIT_DEADLINE, EXIT_OVER_MEMORY, footprint};
use crate::kind::Kind;
use crate::{Limit, NATIVE, Options, Reading, Refusal, Sandbox};

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
    file: &File,
    mime: &str,
    options: &Options,
) -> Result<Reading, Refusal> {
    let (kind, len) = refuse_without_a_child(file, mime, options)?;
    let program = program
        .ok_or_else(|| Refusal::ReaderUnavailable("the program cannot find itself".into()))?;
    let time_limit = options.time_limit.min(LONGEST_TIME_LIMIT);
    let deadline = Instant::now() + time_limit;
    let request = request(len, mime, options, time_limit)?;
    let stdin = file
        .try_clone()
        .map_err(|error| Refusal::ReaderUnavailable(format!("cannot hold the file: {error}")))?;

    let mut watched = Watched::start(
        program,
        &request,
        stdin,
        time_limit,
        options.max_memory_bytes,
    )?;
    let cap = options
        .max_text_chars
        .saturating_mul(JSON_BYTES_PER_UNIT)
        .saturating_add(ANSWER_OVERHEAD);
    let mut said = Said::new(cap);
    let end = watched.run(&mut said, options.max_memory_bytes, deadline);
    let status = watched.reap();
    conclude(
        end,
        status,
        &said,
        kind,
        options,
        Instant::now() >= deadline,
    )
}

/// Refusals the call alone decides. The child shares the descriptor, so the file must be regular and read-only.
fn refuse_without_a_child(
    file: &File,
    mime: &str,
    options: &Options,
) -> Result<(Kind, u64), Refusal> {
    if mime.len() > MAX_MIME_BYTES {
        return Err(Refusal::Unsupported);
    }
    let kind = Kind::of(mime).ok_or(Refusal::Unsupported)?;
    if kind == Kind::Pdf && !NATIVE {
        return Err(Refusal::Unsupported);
    }
    let unusable =
        |why: &str| Refusal::ReaderUnavailable(format!("the file cannot be read: {why}"));
    let metadata = file
        .metadata()
        .map_err(|error| unusable(&error.to_string()))?;
    if !metadata.is_file() {
        return Err(unusable("it is not a regular file"));
    }
    // SAFETY: the descriptor is open for the length of the call.
    let flags = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETFL) };
    if flags < 0 || flags & libc::O_ACCMODE != libc::O_RDONLY {
        return Err(unusable("it is not open for reading only"));
    }
    let len = metadata.len();
    if kind.loads_whole_file() && len > options.max_memory_bytes {
        return Err(Refusal::OverLimit(
            Limit::Memory,
            format!(
                "the file is {len} bytes, and the memory limit is {}",
                options.max_memory_bytes
            ),
        ));
    }
    Ok((kind, len))
}

/// The soft budget stops OCR with time left to send what it read before the deadline.
fn soft_budget(options: &Options, time_limit: Duration) -> Duration {
    options
        .time_budget
        .unwrap_or(time_limit.mul_f64(crate::SOFT_SHARE_OF_LIMIT))
        .min(time_limit)
}

/// The request, as the one argument that carries it to the child.
fn request(
    len: u64,
    mime: &str,
    options: &Options,
    time_limit: Duration,
) -> Result<String, Refusal> {
    let request = Request {
        mime: mime.to_owned(),
        len,
        max_text_chars: options.max_text_chars as u64,
        max_inflated_bytes: options.max_inflated_bytes,
        time_budget_ms: u64::try_from(soft_budget(options, time_limit).as_millis())
            .unwrap_or(u64::MAX),
        ocr: options.ocr.as_ref().map(|ocr| OcrRequest {
            languages: ocr.languages.clone(),
            data_dir: ocr.data_dir.as_deref().map(resolved),
        }),
    };
    let json = serde_json::to_string(&request)
        .map_err(|error| Refusal::ReaderUnavailable(format!("cannot write a request: {error}")))?;
    if json.len() > MAX_REQUEST_BYTES {
        return Err(Refusal::OcrUnavailable(
            "the OCR settings are too long".into(),
        ));
    }
    Ok(json)
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
    /// What wrote the first line is no reader of this program's.
    BadFrame,
    /// The child's first line says something other than a full sandbox holds it.
    NotConfined,
    /// The child ended by itself.
    Exited,
}

/// The line a child writes before it reads the file.
#[derive(Clone, Copy, Debug)]
enum FirstLine {
    Awaited,
    Said(Sandbox),
    Bad,
}

/// What a child wrote.
struct Said {
    first_line: FirstLine,
    /// What came after the first line.
    stdout: Vec<u8>,
    cap: usize,
    stderr: Vec<u8>,
}

impl Said {
    fn new(cap: usize) -> Self {
        Self {
            first_line: FirstLine::Awaited,
            stdout: Vec::new(),
            cap,
            stderr: Vec::new(),
        }
    }

    fn over_cap(&self) -> bool {
        self.stdout.len() > self.cap
    }

    fn keep_stdout(&mut self, chunk: &[u8]) {
        self.stdout.extend_from_slice(chunk);
        if !matches!(self.first_line, FirstLine::Awaited) {
            return;
        }
        let end = self.stdout.iter().position(|byte| *byte == b'\n');
        match end {
            Some(end) => {
                self.first_line =
                    Frame::read(&self.stdout[..end]).map_or(FirstLine::Bad, FirstLine::Said);
                self.stdout.drain(..=end);
            }
            None if self.stdout.len() > MAX_FRAME_BYTES => self.first_line = FirstLine::Bad,
            None => {}
        }
    }

    fn keep_stderr(&mut self, chunk: &[u8]) {
        self.stderr.extend_from_slice(chunk);
        if self.stderr.len() > STDERR_KEPT {
            self.stderr.drain(..self.stderr.len() - STDERR_KEPT);
        }
    }

    /// The end of stderr, fit for a log.
    fn stderr_for_a_log(&self) -> String {
        let text = String::from_utf8_lossy(&self.stderr);
        let start = text
            .char_indices()
            .rev()
            .nth(STDERR_REPORTED)
            .map_or(0, |(index, _)| index);
        wire::for_a_log(&text[start..])
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
    stdout: Option<ChildStdout>,
    stderr: Option<ChildStderr>,
    reaped: bool,
}

impl Watched {
    /// The file is the child's stdin and the request its last argument.
    fn start(
        program: &Path,
        request: &str,
        file: File,
        time_limit: Duration,
        max_memory: u64,
    ) -> Result<Self, Refusal> {
        let mut child = Command::new(program)
            .arg0(CHILD_NAME)
            .arg(CHILD_ARG)
            .arg(time_limit.as_millis().to_string())
            .arg(max_memory.to_string())
            .arg(request)
            .env_clear()
            .envs(fault_environment())
            .current_dir("/")
            // Its own group, so anything it started ends with it.
            .process_group(0)
            .stdin(Stdio::from(file))
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| {
                Refusal::ReaderUnavailable(format!("cannot start a reader: {error}"))
            })?;
        let pid = libc::pid_t::try_from(child.id()).expect("a process id fits a pid_t");
        let (stdout, stderr) = (child.stdout.take(), child.stderr.take());
        let watched = Self {
            child,
            pid,
            stdout,
            stderr,
            reaped: false,
        };
        for fd in [
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
    fn run(&mut self, said: &mut Said, max_memory: u64, deadline: Instant) -> End {
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

            let wanted: [Option<(RawFd, libc::c_short)>; 2] = [
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
            let ready = wait_for(&wanted, wait);
            if ready[0] || ready[1] {
                self.drain(said);
                match said.first_line {
                    FirstLine::Bad => return End::BadFrame,
                    FirstLine::Said(sandbox) if sandbox != Sandbox::Full => {
                        return End::NotConfined;
                    }
                    FirstLine::Said(_) | FirstLine::Awaited => {}
                }
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

    /// Reads what is there now, and notes each pipe that has closed.
    fn drain(&mut self, said: &mut Said) {
        let mut chunk = [0u8; 64 * 1024];
        if let Some(stdout) = self.stdout.as_mut() {
            let closed = drain_pipe(stdout, &mut chunk, |read| {
                said.keep_stdout(read);
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

/// The one setting a fault-injection child keeps.
#[cfg(feature = "fault-injection")]
fn fault_environment() -> Option<(&'static str, std::ffi::OsString)> {
    let name = super::fault::UNCONFINED;
    std::env::var_os(name).map(|value| (name, value))
}

#[cfg(not(feature = "fault-injection"))]
fn fault_environment() -> Option<(&'static str, std::ffi::OsString)> {
    None
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

/// Waits up to `wait` for either pipe, and says which has something to do.
fn wait_for(wanted: &[Option<(RawFd, libc::c_short)>; 2], wait: Duration) -> [bool; 2] {
    let mut fds: [libc::pollfd; 2] = [libc::pollfd {
        // A negative descriptor is one poll skips.
        fd: -1,
        events: 0,
        revents: 0,
    }; 2];
    for (slot, want) in fds.iter_mut().zip(wanted.iter()) {
        if let Some((fd, events)) = want {
            slot.fd = *fd;
            slot.events = *events;
        }
    }
    let millis = libc::c_int::try_from(wait.as_micros().div_ceil(1000)).unwrap_or(libc::c_int::MAX);
    // SAFETY: `fds` holds two initialized entries, and that is the count passed.
    let count = unsafe { libc::poll(fds.as_mut_ptr(), 2, millis) };
    if count <= 0 {
        return [false; 2];
    }
    [fds[0].revents != 0, fds[1].revents != 0]
}

/// The one result of a reading, from how it ended and what the child said.
///
/// Before its first line a child has not read the file, so whatever ends it is no fault
/// of the file. After that the child may be running code the file chose, and everything
/// it says, its exit code included, is a claim. `ReaderUnavailable` stops a whole run,
/// so a child that has had the file cannot earn it, and it cannot claim the deadline
/// the parent has not seen pass.
fn conclude(
    end: End,
    status: Option<ExitStatus>,
    said: &Said,
    kind: Kind,
    options: &Options,
    past_deadline: bool,
) -> Result<Reading, Refusal> {
    // Whatever ended it, a child that never said it was confined read nothing of the
    // file, so the file has no part in how it ended.
    let FirstLine::Said(sandbox) = said.first_line else {
        let how = match end {
            End::Deadline => "at the deadline".to_owned(),
            End::OverMemory(used) => format!("holding {used} bytes"),
            End::TooMuchOutput => "after writing more than it may".to_owned(),
            End::BadFrame | End::NotConfined | End::Exited => {
                status.map_or_else(|| "with no status".to_owned(), |status| status.to_string())
            }
        };
        return Err(Refusal::ReaderUnavailable(with_last_words(
            format!("the reader ended before it took the file: {how}"),
            said,
        )));
    };
    if sandbox != Sandbox::Full {
        return Err(Refusal::ReaderUnavailable(format!(
            "the reader could not confine itself ({sandbox:?}), so it read nothing"
        )));
    }
    match end {
        End::Deadline => return Err(Refusal::TimedOut),
        End::OverMemory(used) => return Err(over_memory(options, Some(used))),
        End::TooMuchOutput => {
            return Err(Refusal::Crashed("the reader wrote more than it may".into()));
        }
        End::BadFrame | End::NotConfined | End::Exited => {}
    }
    let Some(status) = status else {
        return Err(Refusal::Crashed("the reader's end cannot be known".into()));
    };
    let by_exit_code = status
        .code()
        .and_then(|code| code.checked_sub(EXIT_BY_SIGNAL))
        .filter(|signal| *signal > 0);
    if let Some(signal) = status.signal().or(by_exit_code) {
        return Err(match signal {
            libc::SIGXCPU if past_deadline => Refusal::TimedOut,
            libc::SIGABRT if said.ran_out_of_memory_in_rust() => over_memory(options, None),
            signal => crashed(&format!("ended by {}", signal_name(signal)), said),
        });
    }
    match status.code() {
        Some(0) => {
            let asked = Asked {
                kind,
                ocr: NATIVE && options.ocr.is_some(),
                max_text_chars: options.max_text_chars,
                sandbox,
            };
            Answer::judge(&said.stdout, &asked).map_err(|refusal| match refusal {
                Refusal::Crashed(why) => Refusal::Crashed(with_last_words(why, said)),
                refusal => refusal,
            })
        }
        Some(EXIT_OVER_MEMORY) => Err(over_memory(options, None)),
        Some(EXIT_DEADLINE) if past_deadline => Err(Refusal::TimedOut),
        Some(code) => Err(crashed(&format!("exited with code {code}"), said)),
        None => Err(crashed("ended in no way the system can name", said)),
    }
}

fn over_memory(options: &Options, used: Option<u64>) -> Refusal {
    let limit = options.max_memory_bytes;
    Refusal::OverLimit(
        Limit::Memory,
        match used {
            Some(used) => format!("the reader held {used} bytes, and the memory limit is {limit}"),
            None => format!("the reader ran out of memory under the limit of {limit} bytes"),
        },
    )
}

fn crashed(how: &str, said: &Said) -> Refusal {
    Refusal::Crashed(with_last_words(format!("the reader {how}"), said))
}

fn with_last_words(why: String, said: &Said) -> String {
    let last_words = said.stderr_for_a_log();
    if last_words.is_empty() {
        why
    } else {
        format!("{why}: {last_words}")
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    const ANSWER: &[u8] =
        br#"{"reading":{"text":"hi","truncated":false,"cut_short":false,"size":null,"text_refused":null}}"#;

    fn confined(sandbox: Sandbox) -> Said {
        let mut said = Said::new(64 * 1024);
        said.keep_stdout(&Frame::line(sandbox));
        said
    }

    fn confirmed(said: &Said) -> bool {
        matches!(said.first_line, FirstLine::Said(_))
    }

    fn exited(code: i32) -> Option<ExitStatus> {
        Some(ExitStatus::from_raw(code << 8))
    }

    fn signaled(signal: i32) -> Option<ExitStatus> {
        Some(ExitStatus::from_raw(signal))
    }

    fn ended(
        status: Option<ExitStatus>,
        said: &Said,
        past_deadline: bool,
    ) -> Result<Reading, Refusal> {
        conclude(
            End::Exited,
            status,
            said,
            Kind::Text,
            &Options::default(),
            past_deadline,
        )
    }

    #[test]
    fn the_frame_may_arrive_in_pieces() {
        let line = Frame::line(Sandbox::Full);
        let mut said = Said::new(64 * 1024);
        for byte in &line[..line.len() - 1] {
            said.keep_stdout(&[*byte]);
            assert!(!confirmed(&said));
        }
        said.keep_stdout(b"\n");
        assert!(confirmed(&said));
        said.keep_stdout(ANSWER);
        assert_eq!(
            ended(exited(0), &said, false).unwrap().sandbox,
            Sandbox::Full
        );
    }

    #[test]
    fn a_later_frame_changes_nothing() {
        let mut said = confined(Sandbox::Full);
        said.keep_stdout(&Frame::line(Sandbox::Off));
        said.keep_stdout(ANSWER);
        assert!(matches!(
            ended(exited(0), &said, false),
            Err(Refusal::Crashed(_))
        ));
        assert!(matches!(said.first_line, FirstLine::Said(Sandbox::Full)));
    }

    #[test]
    fn a_reader_that_is_not_fully_confined_gives_no_reading() {
        let mut said = confined(Sandbox::Full);
        said.keep_stdout(ANSWER);
        assert!(ended(exited(0), &said, false).is_ok());
        for sandbox in [Sandbox::Partial, Sandbox::Off] {
            let mut said = confined(sandbox);
            said.keep_stdout(ANSWER);
            for end in [End::Exited, End::NotConfined] {
                let result = conclude(
                    end,
                    exited(0),
                    &said,
                    Kind::Text,
                    &Options::default(),
                    false,
                );
                assert!(
                    matches!(&result, Err(Refusal::ReaderUnavailable(why)) if why.contains("confine")),
                    "{sandbox:?}: {result:?}"
                );
            }
        }
    }

    #[test]
    fn a_bad_first_line_is_no_reader() {
        for line in [
            b"not the reader\n".to_vec(),
            b"{\"sandbox\":\"maybe\"}\n".to_vec(),
            vec![b'x'; MAX_FRAME_BYTES + 1],
        ] {
            let mut said = Said::new(64 * 1024);
            said.keep_stdout(&line);
            assert!(matches!(said.first_line, FirstLine::Bad), "{line:?}");
            assert!(matches!(
                conclude(
                    End::BadFrame,
                    exited(0),
                    &said,
                    Kind::Text,
                    &Options::default(),
                    false
                ),
                Err(Refusal::ReaderUnavailable(_))
            ));
        }
    }

    /// The child had no file, so no code of a file's chose how it ended.
    #[test]
    fn any_end_before_the_frame_is_no_reader() {
        let said = Said::new(64 * 1024);
        for status in [
            exited(0),
            exited(EXIT_OVER_MEMORY),
            exited(EXIT_DEADLINE),
            exited(super::super::EXIT_PARENT_GONE),
            exited(super::super::EXIT_BAD_REQUEST),
            signaled(libc::SIGSYS),
            signaled(libc::SIGSEGV),
            None,
        ] {
            assert!(
                matches!(
                    ended(status, &said, false),
                    Err(Refusal::ReaderUnavailable(_))
                ),
                "{status:?}"
            );
        }
    }

    /// A deadline, a memory limit or a flood of output before the frame ends a reader
    /// that never had the file, so none of them is a verdict on it.
    #[test]
    fn a_limit_reached_before_the_frame_is_no_reader_either() {
        let said = Said::new(64 * 1024);
        let confined = confined(Sandbox::Full);
        for (end, after_the_frame) in [
            (End::Deadline, Refusal::TimedOut),
            (
                End::OverMemory(2 << 30),
                over_memory(&Options::default(), Some(2 << 30)),
            ),
            (
                End::TooMuchOutput,
                Refusal::Crashed("the reader wrote more than it may".into()),
            ),
        ] {
            let before = |said| {
                conclude(
                    end,
                    signaled(libc::SIGKILL),
                    said,
                    Kind::Text,
                    &Options::default(),
                    true,
                )
            };
            assert!(
                matches!(before(&said), Err(Refusal::ReaderUnavailable(_))),
                "{end:?}"
            );
            assert_eq!(before(&confined), Err(after_the_frame), "{end:?}");
        }
    }

    /// `ReaderUnavailable` stops the run, so a hostile file must not be able to reach it.
    #[test]
    fn after_the_frame_no_exit_code_stops_the_run() {
        let said = confined(Sandbox::Full);
        for code in 1..=255 {
            assert!(
                !matches!(
                    ended(exited(code), &said, false),
                    Err(Refusal::ReaderUnavailable(_))
                ),
                "{code}"
            );
        }
    }

    #[test]
    fn a_deadline_that_has_not_passed_is_a_false_claim() {
        let said = confined(Sandbox::Full);
        assert!(matches!(
            ended(exited(EXIT_DEADLINE), &said, false),
            Err(Refusal::Crashed(_))
        ));
        assert!(matches!(
            ended(signaled(libc::SIGXCPU), &said, false),
            Err(Refusal::Crashed(_))
        ));
        assert!(matches!(
            ended(exited(EXIT_BY_SIGNAL + libc::SIGXCPU), &said, false),
            Err(Refusal::Crashed(_))
        ));
        assert_eq!(
            ended(exited(EXIT_DEADLINE), &said, true),
            Err(Refusal::TimedOut)
        );
        assert_eq!(
            ended(signaled(libc::SIGXCPU), &said, true),
            Err(Refusal::TimedOut)
        );
    }

    fn script(folder: &Path, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;

        let path = folder.join("reader");
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    /// A reader that never states its sandbox has read nothing, so its end is no verdict on the file.
    #[test]
    fn a_reader_that_states_no_sandbox_is_no_reader() {
        let folder = tempfile::tempdir().unwrap();
        let options = Options {
            time_limit: Duration::from_millis(500),
            ..Options::default()
        };
        let path = folder.path().join("file");
        std::fs::write(&path, b"text").unwrap();
        let file = File::open(&path).unwrap();
        let silent = script(folder.path(), "sleep 5\nexit 9");
        let result = read(Some(&silent), &file, "text/plain", &options);
        assert!(
            matches!(&result, Err(Refusal::ReaderUnavailable(why)) if why.contains("deadline")),
            "{result:?}"
        );

        let frame = String::from_utf8(Frame::line(Sandbox::Full)).unwrap();
        let states = script(
            folder.path(),
            &format!("printf '%s\\n' '{}'\nexit 9", frame.trim()),
        );
        let result = read(Some(&states), &file, "text/plain", &options);
        assert!(
            matches!(&result, Err(Refusal::Crashed(why)) if why.contains("code 9")),
            "{result:?}"
        );
    }

    #[test]
    fn a_file_the_reader_could_write_is_refused() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("file");
        std::fs::write(&path, b"text").unwrap();
        let writable = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&path)
            .unwrap();
        let result = read(None, &writable, "text/plain", &Options::default());
        assert!(
            matches!(&result, Err(Refusal::ReaderUnavailable(why)) if why.contains("reading only")),
            "{result:?}"
        );
        let directory = File::open(folder.path()).unwrap();
        let result = read(None, &directory, "text/plain", &Options::default());
        assert!(
            matches!(&result, Err(Refusal::ReaderUnavailable(_))),
            "{result:?}"
        );
    }

    #[test]
    fn last_words_go_through_the_same_cleaning_as_a_reason() {
        let mut said = confined(Sandbox::Full);
        said.keep_stderr("a\nb\u{202e}c\u{2028}d".as_bytes());
        assert_eq!(said.stderr_for_a_log(), wire::for_a_log("a b c d"));
    }
}
