//! `marfa server run`: the server as a child of this process, which a service runs.
//! A server that refused its database is not run again: a restart meets the same refusal.
//!
//! A self-update swaps in only the new `marfa-server`, so this process, of the release that ran
//! before, tries the new server: it counts each start in the update's record before any program
//! of the new release runs, ends a start that has not settled within [`TRIAL_LIMIT`] (not
//! counting a database upgrade, which has [`UPGRADE_LIMIT`]), and puts the old server back when
//! the new one does not stay up. The service definitions restart only a
//! failed exit, so a start of the new release that ends unasked ends this process with
//! [`RESTART`].

use std::fs::{File, OpenOptions, TryLockError};
use std::io::{ErrorKind, Read};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime};

use marfa_rules::environment::INSTALL_DIR;
use marfa_rules::update_record::{
    self as record, ASK_LIMIT, MARFA, Outcome, Pending, UNFINISHED_STARTS, Upgrade,
    cannot_put_back, finish_swap, keep_served_release, previous_of, put_back, release_of,
};

#[cfg(target_os = "linux")]
use std::os::unix::process::CommandExt;
use std::os::unix::process::ExitStatusExt;

use crate::error::CliError;
use crate::server::logs::{self, RotatingLog};
use crate::server::{Folder, RunArgs, files, launchd, native, shell_word};

/// What the server's exit status says of its database: 78 is a refusal that
/// a restart will not change.
pub const REFUSED: i32 = 78;

/// What the service says when the server refused its database, which
/// `install` and `status` look for in the log.
pub const REFUSED_DATABASE: &str = "will not start on the database";

const SERVER: &str = record::SERVER;

/// What both service managers start again, as a failed exit.
const RESTART: i32 = 75;

/// How long a start of a new release may run without settling, from its start or from the end
/// of its database upgrade.
const TRIAL_LIMIT: Duration = Duration::from_secs(10 * 60);

/// How long a start of a new release may spend upgrading the database. An upgrade rewrites the
/// database in one transaction, which a large database on a slow disk takes many minutes for.
const UPGRADE_LIMIT: Duration = Duration::from_secs(2 * 60 * 60);

/// How long a start of a new release waits for the last server of the install to let go of its
/// files, which a server that outlived its `marfa server run` holds until it ends.
const LET_GO_WAIT: Duration = Duration::from_secs(30);

/// How long a server ended at the trial limit has to stop before it is killed.
const STOP_GRACE: Duration = Duration::from_secs(30);

/// How often a start of a new release looks whether its update has settled.
const LOOK_EVERY: Duration = Duration::from_secs(2);

const POLL: Duration = Duration::from_millis(100);

pub const OWN: &str = env!("CARGO_PKG_VERSION");

static CHILD: AtomicI32 = AtomicI32::new(0);
static STOP: AtomicBool = AtomicBool::new(false);

extern "C" fn forward(signal: libc::c_int) {
    STOP.store(true, Ordering::SeqCst);
    let child = CHILD.load(Ordering::SeqCst);
    if child > 0 {
        // SAFETY: `kill` is async-signal-safe.
        unsafe { libc::kill(child, signal) };
    }
}

fn forward_stops() {
    // SAFETY: the handler only touches atomics and calls `kill`.
    unsafe {
        let mut action: libc::sigaction = std::mem::zeroed();
        action.sa_sigaction = forward as extern "C" fn(libc::c_int) as libc::sighandler_t;
        action.sa_flags = libc::SA_RESTART;
        libc::sigemptyset(&mut action.sa_mask);
        for signal in [libc::SIGTERM, libc::SIGINT] {
            libc::sigaction(signal, &action, std::ptr::null_mut());
        }
    }
}

/// macOS has no parent-death signal; there the service manager's clean-up of the process group
/// stops the child, and a start of a new release waits for it to let go of its files.
#[cfg(target_os = "linux")]
fn die_with_the_parent(command: &mut Command) {
    let parent = std::process::id() as libc::pid_t;
    // SAFETY: the closure makes only async-signal-safe calls between `fork`
    // and `exec`.
    unsafe {
        command.pre_exec(move || {
            if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            // The parent may have ended before the request was made.
            if libc::getppid() != parent {
                return Err(std::io::Error::other("the parent ended"));
            }
            Ok(())
        });
    }
}

#[cfg(not(target_os = "linux"))]
fn die_with_the_parent(_command: &mut Command) {}

/// A limit a test sets shorter through `name`; a release build reads no such variable.
fn limit(name: &str, otherwise: Duration) -> Duration {
    #[cfg(debug_assertions)]
    if let Some(ms) = std::env::var(name).ok().and_then(|ms| ms.parse().ok()) {
        return Duration::from_millis(ms);
    }
    let _ = name;
    otherwise
}

fn spoken(limit: Duration) -> String {
    match limit.as_secs() {
        seconds if seconds >= 3600 && seconds % 3600 == 0 => format!("{} hours", seconds / 3600),
        seconds if seconds >= 60 && seconds % 60 == 0 => format!("{} minutes", seconds / 60),
        seconds if limit.subsec_millis() == 0 => format!("{seconds} seconds"),
        _ => format!("{} ms", limit.as_millis()),
    }
}

fn release(server: &Path) -> Result<String, CliError> {
    release_of(server, ASK_LIMIT).map_err(CliError::Install)
}

fn beside() -> Result<PathBuf, CliError> {
    let exe = std::fs::canonicalize(std::env::current_exe()?)?;
    native::find_server(&exe).ok_or_else(|| {
        CliError::Install(format!(
            "{SERVER} was not found beside {}: it comes in the same package as marfa (Homebrew's marfa, or scripts/install.sh), so install that again. A {SERVER} elsewhere on the path is never used",
            exe.display()
        ))
    })
}

fn record_of(dir: &Path) -> record::Folder {
    record::Folder::beside(&native::Layout::new(dir).database())
}

/// The files a server of the install in `dir` locks while it runs, named as the server names
/// them: beside the database, in the blob folder and beside the control socket.
fn server_locks(dir: &Path) -> Vec<PathBuf> {
    let layout = native::Layout::new(dir);
    let with = |path: PathBuf, suffix: &str| {
        let mut name = path.into_os_string();
        name.push(suffix);
        PathBuf::from(name)
    };
    vec![
        with(layout.database(), ".server-lock"),
        layout.blobs().join(".server-lock"),
        with(layout.socket(), ".lock"),
    ]
}

fn held(lock: &Path) -> bool {
    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(lock)
        .is_ok_and(|file| matches!(file.try_lock_shared(), Err(TryLockError::WouldBlock)))
}

/// A new server that an update swapped in, under the `marfa` of either release.
fn trying(pending: &Pending, own: &str, theirs: &str) -> bool {
    theirs == pending.to && (own == pending.from || own == pending.to)
}

/// The server beside this `marfa`. Another release is refused because the two share a database
/// and a socket, except a new server the install in `dir` is trying after an update.
pub fn locate(dir: Option<&Path>) -> Result<PathBuf, CliError> {
    let server = beside()?;
    let theirs = release(&server)?;
    let pending = dir.and_then(|dir| record_of(dir).pending().ok().flatten());
    if pending.is_some_and(|pending| trying(&pending, OWN, &theirs)) {
        return Ok(server);
    }
    agree(&server, &theirs, OWN)?;
    Ok(server)
}

/// Whether the install in `dir`, whose service runs `serviced`, is trying a new server of an
/// update between `serviced` and this `marfa`'s release, which the service already names.
pub fn trying_update(dir: &Path, serviced: &str) -> bool {
    record_of(dir)
        .pending()
        .ok()
        .flatten()
        .is_some_and(|pending| {
            let part = |release: &str| release == pending.from || release == pending.to;
            part(serviced) && part(OWN)
        })
}

/// What `server` says when it will not run on the install's settings and `database`, or `None`
/// when it will, or when it could not be asked: a server asked to start judges both again.
pub fn will_not_open(
    server: &Path,
    database: &Path,
    environment: &[(String, String)],
) -> Option<String> {
    let mut command = Command::new(server);
    command.arg("--can-open").arg(database);
    // The server reads settings beyond its own, such as `OTEL_*`, and what this shell sets is
    // not what the service starts it with.
    command.env_clear();
    for name in ["PATH", "HOME"] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    command.envs(environment.iter().map(|(name, value)| (name, value)));
    let ran = record::run_within(command, ASK_LIMIT).ok()?;
    (ran.status.code() == Some(REFUSED)).then(|| ran.stderr.trim().to_string())
}

fn agree(server: &Path, theirs: &str, own: &str) -> Result<(), CliError> {
    if theirs != own {
        return Err(CliError::Install(format!(
            "{} is release {theirs} and this marfa is release {own}: the two are released together, so install the same release of both",
            server.display()
        )));
    }
    Ok(())
}

/// Where the child's output goes.
enum Sink {
    /// To this process's own, which a service manager keeps.
    Inherit,
    /// To a file of bounded size.
    File(Arc<Mutex<RotatingLog>>),
}

impl Sink {
    fn say(&self, line: &str) {
        crate::errln!("{line}");
        if let Sink::File(log) = self
            && let Ok(mut log) = log.lock()
        {
            let _ = log.write(format!("{line}\n").as_bytes());
        }
    }
}

fn pump(mut from: impl Read + Send + 'static, log: Arc<Mutex<RotatingLog>>) -> JoinHandle<()> {
    std::thread::spawn(move || {
        let mut buffer = [0u8; 8192];
        loop {
            match from.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => {
                    if let Ok(mut log) = log.lock() {
                        let _ = log.write(&buffer[..read]);
                    }
                }
                Err(error) if error.kind() == ErrorKind::Interrupted => {}
                Err(_) => break,
            }
        }
    })
}

fn now() -> String {
    let ms = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |since| since.as_millis() as i64);
    marfa_rules::time::written(ms)
}

/// How this start runs the server.
enum Start {
    /// A start of the new release of an update that has not settled, counted in this record.
    Trial(Pending),
    /// Any other start, of a server that reports this release.
    Plain(String),
}

/// The install `--dir` names, as this process supervises its server's updates.
struct Install {
    record: record::Folder,
    database: PathBuf,
    environment: Vec<(String, String)>,
    server_locks: Vec<PathBuf>,
    /// Held while this process runs, so a second `marfa server run` of the install counts no
    /// start; `None` when another holds it.
    lock: Option<File>,
}

impl Install {
    fn end(&self, sink: &Sink, pending: &Pending, outcome: Outcome, reason: String) {
        sink.say(&reason);
        let attempt = pending.attempt.as_deref();
        if let Err(error) = self
            .record
            .end(&now(), outcome, &pending.to, Some(reason), attempt)
        {
            sink.say(&format!(
                "The outcome of the update could not be kept: {error}"
            ));
        }
    }

    fn clear(&self, sink: &Sink) {
        if let Err(error) = self.record.clear_pending() {
            sink.say(&format!(
                "The update's record could not be cleared: {error}"
            ));
        }
    }

    /// Names `release` as the one on the database. A release put back may be one that keeps no
    /// such record itself.
    fn name_release(&self, sink: &Sink, release: &str) {
        if let Err(error) = keep_served_release(&self.database, release) {
            sink.say(&format!(
                "Release {release} could not be named beside the database: {error}"
            ));
        }
    }

    /// Whether `pending`'s own attempt has an outcome already: a record kept after it ended lets
    /// the old `marfa` go on starting the new server, which is then no longer on trial.
    fn ended(&self, pending: &Pending) -> bool {
        self.record
            .last()
            .ok()
            .flatten()
            .is_some_and(|last| last.ends(pending))
    }

    /// Whether the update `trial` counts has settled or ended since this start began.
    fn settled(&self, trial: &Pending) -> bool {
        match self.record.pending() {
            Ok(Some(now)) => now.to != trial.to || now.attempt != trial.attempt || self.ended(&now),
            Ok(None) => true,
            Err(_) => false,
        }
    }

    /// The first lock the last server of the install still holds after [`LET_GO_WAIT`].
    fn still_held(&self) -> Option<&Path> {
        let wait = limit("MARFA_TEST_LET_GO_MS", LET_GO_WAIT);
        let began = Instant::now();
        loop {
            match self.server_locks.iter().find(|lock| held(lock)) {
                None => return None,
                Some(lock) if began.elapsed() >= wait => return Some(lock),
                Some(_) => std::thread::sleep(POLL),
            }
        }
    }

    /// Counts this start before any program of the new release runs, so a start that hangs or
    /// dies on its first word is counted too. Ends the process when this start may not run.
    fn begin(&self, sink: &Sink, server: &Path, pending: Pending) -> Result<Start, CliError> {
        // Before anything is decided or moved: a server that outlived its run may still be
        // changing the database.
        if let Some(lock) = self.still_held() {
            sink.say(&format!(
                "The last server of this install still holds {} after {}, so this start of release {} is not counted and ends for the service to start it again.",
                lock.display(),
                spoken(limit("MARFA_TEST_LET_GO_MS", LET_GO_WAIT)),
                pending.to
            ));
            std::process::exit(RESTART);
        }
        if self.ended(&pending) || (OWN != pending.from && OWN != pending.to) {
            let theirs = release(server)?;
            self.reconcile(sink, &pending, &theirs);
            return Ok(Start::Plain(theirs));
        }
        let (from, to) = (&pending.from, &pending.to);
        if pending.starts >= UNFINISHED_STARTS {
            match release_of(server, ASK_LIMIT) {
                Ok(theirs) if !trying(&pending, OWN, &theirs) => {
                    self.reconcile(sink, &pending, &theirs);
                    return Ok(Start::Plain(theirs));
                }
                _ => self.roll_back(
                    sink,
                    &pending,
                    &format!(
                        "Release {to} ended {} times before it settled",
                        pending.starts
                    ),
                ),
            }
        }
        if let Err(error) = self.record.clear_upgrade() {
            sink.say(&format!(
                "An earlier start's upgrade mark could not be cleared, so this start of release {to} is not counted and does not run: {error}"
            ));
            std::process::exit(RESTART);
        }
        let counted = Pending {
            starts: pending.starts + 1,
            ..pending.clone()
        };
        if let Err(error) = self.record.keep_pending(&counted) {
            sink.say(&format!(
                "This start of release {to} could not be counted, so it does not run: {error}"
            ));
            std::process::exit(RESTART);
        }
        match release_of(server, ASK_LIMIT) {
            Err(why) => {
                sink.say(&format!(
                    "{why}, so this start of release {to} is counted as one that ended before it settled; the service starts it again, and puts release {from} back after {UNFINISHED_STARTS} such starts."
                ));
                std::process::exit(RESTART);
            }
            Ok(theirs) if self.reconcile(sink, &counted, &theirs) => Ok(Start::Trial(counted)),
            Ok(theirs) => Ok(Start::Plain(theirs)),
        }
    }

    /// Puts the old server back when it can run, and otherwise finishes the swap, so the next
    /// start runs one release whole. Ends the process for the service to start again.
    fn roll_back(&self, sink: &Sink, pending: &Pending, why: &str) -> ! {
        let (from, to, programs) = (&pending.from, &pending.to, &pending.programs);
        let why = &match &pending.limit_ended {
            Some(limit) => format!("{why}, and a start was ended because it {limit}"),
            None => why.to_string(),
        };
        if let Some(cannot) = cannot_put_back(pending, &self.database, &self.environment) {
            self.finish_forward(
                sink,
                pending,
                &format!("{why}, and release {from} cannot be put back: {cannot}"),
                ", and the server's log says why it ends.",
            );
        }
        match put_back(programs, OWN == to.as_str()) {
            Ok(()) => {
                self.name_release(sink, from);
                self.clear(sink);
                self.end(
                    sink,
                    pending,
                    Outcome::RolledBack,
                    format!("{why}, so release {from} was put back."),
                );
            }
            // Nothing was put back, so the new release is still whole but for its `marfa`.
            Err(error) if previous_of(programs, SERVER).is_file() => self.finish_forward(
                sink,
                pending,
                &format!("{why}, and release {from} could not be put back: {error}"),
                ", with both of its programs in place.",
            ),
            Err(error) => sink.say(&format!(
                "{why}, and release {from}'s server was put back, but not all of its programs: {error}. The next start finishes putting it back."
            )),
        }
        std::process::exit(RESTART);
    }

    /// Ends the update as `failed` with release `pending.to` in place, so that a start runs it
    /// again. When its `marfa` cannot be put in place, the record stays, ended, so that the old
    /// `marfa` goes on starting the new server.
    fn finish_forward(&self, sink: &Sink, pending: &Pending, why: &str, stays: &str) -> ! {
        let (from, to) = (&pending.from, &pending.to);
        match finish_swap(&pending.programs) {
            Ok(()) => {
                self.clear(sink);
                self.end(
                    sink,
                    pending,
                    Outcome::Failed,
                    format!("{why}. Release {to} stays{stays}"),
                );
            }
            Err(error) => self.end(
                sink,
                pending,
                Outcome::Failed,
                format!(
                    "{why}, and release {to}'s marfa could not be put in place: {error}. Release {from}'s marfa goes on starting release {to}'s server. Install release {to} on this host, then run `marfa server upgrade` for this server."
                ),
            ),
        }
        std::process::exit(RESTART);
    }

    /// Ends an update the programs on disk no longer match. `true` when this start goes on to
    /// try the new server.
    fn reconcile(&self, sink: &Sink, pending: &Pending, theirs: &str) -> bool {
        let (from, to, programs) = (&pending.from, &pending.to, &pending.programs);
        if trying(pending, OWN, theirs) {
            return true;
        }
        let ended_already = self.ended(pending);
        let reason = if OWN == from && theirs == from {
            let _ = record::drop_next(programs);
            (!ended_already).then(|| {
                (
                    Outcome::RolledBack,
                    format!("The update to release {to} did not finish, so release {from} runs."),
                )
            })
        } else if OWN == to && theirs == from {
            // Putting back stopped between the two programs.
            let restored = std::fs::rename(previous_of(programs, MARFA), programs.join(MARFA))
                .and_then(|()| record::drop_next(programs))
                .and_then(|()| record::sync_folder(programs));
            self.name_release(sink, from);
            self.clear(sink);
            let (outcome, reason) = match restored {
                Ok(()) => (
                    Outcome::RolledBack,
                    format!(
                        "Release {from}'s server was put back before this start, so its marfa was put back too."
                    ),
                ),
                Err(error) => (
                    Outcome::Failed,
                    format!(
                        "Release {from}'s server was put back, but its marfa could not be: {error}. Install release {from} on this host, then run `marfa server upgrade` for this server."
                    ),
                ),
            };
            self.end(sink, pending, outcome, reason);
            std::process::exit(RESTART);
        } else {
            let _ = record::drop_next(programs);
            Some((
                Outcome::Failed,
                format!(
                    "The programs were replaced with release {theirs} before release {to} settled, so the update to release {to} ended."
                ),
            ))
        };
        self.clear(sink);
        if let Some((outcome, reason)) = reason {
            self.end(sink, pending, outcome, reason);
        }
        false
    }
}

pub fn run(args: &RunArgs) -> Result<(), CliError> {
    let dir = &args.dir;
    let server = beside()?;
    let mut command = Command::new(&server);
    command.stdin(Stdio::null());
    let mut sink = Sink::Inherit;
    let mut folder_arg = String::new();
    let mut install = None;
    let mut log_path = None;
    if dir.dir.is_some() {
        let folder = Folder::new(dir)?;
        let (state, _) = folder.require_state()?;
        folder_arg = format!(" --dir {}", shell_word(&folder.dir));
        let settings = folder.read(files::SETTINGS)?.unwrap_or_default();
        let environment = native::environment(&folder.dir, state.port, &settings);
        command.envs(environment.iter().map(|(name, value)| (name, value)));
        if launchd::supported() {
            log_path = Some(launchd::server_log(&state.name)?);
        }
        let record = record_of(&folder.dir);
        // A check runs beside the service it checks, and must not take the service's lock.
        let lock = match args.check {
            true => None,
            false => Some(record.supervisor_lock().map_err(|error| {
                CliError::Io(std::io::Error::new(
                    error.kind(),
                    format!(
                        "cannot open the update's lock in {}: {error}",
                        record.path().display()
                    ),
                ))
            })?),
        };
        let lock = lock.filter(|lock| lock.try_lock().is_ok());
        if lock.is_some() {
            command.env(INSTALL_DIR, &folder.dir);
        }
        install = Some(Install {
            record,
            database: native::Layout::new(&folder.dir).database(),
            environment,
            server_locks: server_locks(&folder.dir),
            lock,
        });
    }
    let accept = |install: Option<&Install>, theirs: &str| {
        let pending = install.and_then(|install| install.record.pending().ok().flatten());
        match pending.is_some_and(|pending| trying(&pending, OWN, theirs)) {
            true => Ok(()),
            false => agree(&server, theirs, OWN),
        }
    };
    if args.check {
        return accept(install.as_ref(), &release(&server)?);
    }
    if let Some(path) = &log_path {
        let log = RotatingLog::open(path, logs::LIMIT).map_err(|error| {
            CliError::Io(std::io::Error::new(
                error.kind(),
                format!("cannot open the log {}: {error}", path.display()),
            ))
        })?;
        sink = Sink::File(Arc::new(Mutex::new(log)));
    }
    let supervising = install.as_ref().filter(|install| install.lock.is_some());
    let pending = match supervising.map(|install| install.record.pending()) {
        Some(Ok(pending)) => pending,
        Some(Err(error)) => {
            sink.say(&format!(
                "The update's record does not read, so this start ignores it: {error}"
            ));
            None
        }
        None => None,
    };
    let start = match (supervising, pending) {
        (Some(install), Some(pending)) => install.begin(&sink, &server, pending)?,
        _ => Start::Plain(release(&server)?),
    };
    let trial = match start {
        Start::Trial(pending) => supervising.map(|install| (install, pending)),
        Start::Plain(theirs) => {
            accept(install.as_ref(), &theirs)?;
            None
        }
    };
    let mut pumps = Vec::new();
    if let Sink::File(_) = &sink {
        command.stdout(Stdio::piped()).stderr(Stdio::piped());
    }
    // The server stays in this process's group so a service manager's clean-up reaches it.
    die_with_the_parent(&mut command);
    forward_stops();
    let mut child = command.spawn().map_err(|error| {
        CliError::Install(format!("cannot start {}: {error}", server.display()))
    })?;
    CHILD.store(child.id() as i32, Ordering::SeqCst);
    if STOP.load(Ordering::SeqCst) {
        // SAFETY: a signal to a process this one started.
        unsafe { libc::kill(child.id() as i32, libc::SIGTERM) };
    }
    if let Sink::File(log) = &sink {
        if let Some(out) = child.stdout.take() {
            pumps.push(pump(out, log.clone()));
        }
        if let Some(err) = child.stderr.take() {
            pumps.push(pump(err, log.clone()));
        }
    }
    let (status, limit_ended) = match &trial {
        Some((install, pending)) => on_trial(install, &sink, &mut child, pending)?,
        None => (child.wait()?, None),
    };
    for pump in pumps {
        let _ = pump.join();
    }
    CHILD.store(0, Ordering::SeqCst);
    // A start ended at the limit stays counted, whatever stop came after.
    let stopped = STOP.load(Ordering::SeqCst) && limit_ended.is_none();
    if let Some((install, pending)) = &trial {
        ended_trial(install, &sink, pending, status, stopped, limit_ended);
    }
    if status.code() == Some(REFUSED) && !stopped {
        sink.say(&format!(
            "{SERVER} {REFUSED_DATABASE} (exit status {REFUSED}); the lines above say why. This service stays up and does nothing, so that it is not started again into the same refusal. Stop it with `marfa server stop{folder_arg}`, fix the database, then run `marfa server start{folder_arg}`."
        ));
        while !STOP.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(250));
        }
        std::process::exit(0);
    }
    std::process::exit(exit_code(status, stopped));
}

/// Where a start of the new release stands with the database upgrade the server marks.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Stage {
    Starting,
    Upgrading,
    Upgraded,
}

/// Waits for a start of the new release, and ends it when its update has not settled within
/// its limit: its status, and why the limit ended it.
fn on_trial(
    install: &Install,
    sink: &Sink,
    child: &mut Child,
    trial: &Pending,
) -> std::io::Result<(ExitStatus, Option<String>)> {
    let settle_limit = limit("MARFA_TEST_TRIAL_LIMIT_MS", TRIAL_LIMIT);
    let upgrade_limit = limit("MARFA_TEST_UPGRADE_LIMIT_MS", UPGRADE_LIMIT);
    let allowed = |stage| match stage {
        Stage::Upgrading => upgrade_limit,
        Stage::Starting | Stage::Upgraded => settle_limit,
    };
    let (mut stage, mut since) = (Stage::Starting, Instant::now());
    let mut looked = since;
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok((status, None));
        }
        if since.elapsed() >= allowed(stage) || looked.elapsed() >= LOOK_EVERY {
            looked = Instant::now();
            if install.settled(trial) {
                return Ok((child.wait()?, None));
            }
            let marked = install.record.upgrade().ok().flatten();
            let now = match (stage, marked) {
                (Stage::Starting, Some(Upgrade::Began)) => Stage::Upgrading,
                (Stage::Starting | Stage::Upgrading, Some(Upgrade::Ended)) => Stage::Upgraded,
                _ => stage,
            };
            if now != stage {
                (stage, since) = (now, Instant::now());
            }
        }
        // A stop someone asked for has reached the server already.
        if since.elapsed() >= allowed(stage) && !STOP.load(Ordering::SeqCst) {
            let why = match stage {
                Stage::Starting => {
                    format!("did not settle within {} of starting", spoken(settle_limit))
                }
                Stage::Upgrading => format!(
                    "did not finish upgrading the database within {}",
                    spoken(upgrade_limit)
                ),
                Stage::Upgraded => format!(
                    "did not settle within {} of upgrading the database",
                    spoken(settle_limit)
                ),
            };
            sink.say(&format!(
                "Release {} {why}, so this start of it is ended.",
                trial.to
            ));
            return Ok((stop(child)?, Some(why)));
        }
        std::thread::sleep(POLL);
    }
}

/// Stops the server as a service manager does, and kills it when it does not end in time.
fn stop(child: &mut Child) -> std::io::Result<ExitStatus> {
    // SAFETY: a signal to a process this one started and has not yet waited for.
    unsafe { libc::kill(child.id() as i32, libc::SIGTERM) };
    let began = Instant::now();
    while began.elapsed() < STOP_GRACE {
        if let Some(status) = child.try_wait()? {
            return Ok(status);
        }
        std::thread::sleep(POLL);
    }
    let _ = child.kill();
    child.wait()
}

fn exit_code(status: ExitStatus, stopped: bool) -> i32 {
    match (status.code(), status.signal()) {
        (Some(code), _) => code,
        // A stop that was passed on ended it as asked.
        (None, Some(libc::SIGTERM | libc::SIGINT)) if stopped => 0,
        (None, signal) => 128 + signal.unwrap_or(0),
    }
}

/// After a start of the new release while its update had not settled. Returns only when the
/// update has settled or ended meanwhile, and the exit is then as for any other server.
fn ended_trial(
    install: &Install,
    sink: &Sink,
    trial: &Pending,
    status: ExitStatus,
    stopped: bool,
    limit_ended: Option<String>,
) {
    let to = &trial.to;
    let pending = match install.record.pending() {
        Ok(Some(pending))
            if pending.to == trial.to
                && pending.attempt == trial.attempt
                && !install.ended(&pending) =>
        {
            pending
        }
        Ok(_) => return,
        Err(error) => {
            sink.say(&format!(
                "The update's record does not read after the server ended: {error}"
            ));
            std::process::exit(RESTART);
        }
    };
    if stopped {
        // A stop someone asked for is not the new release failing.
        let uncounted = Pending {
            starts: pending.starts.saturating_sub(1),
            ..pending
        };
        if let Err(error) = install.record.keep_pending(&uncounted) {
            sink.say(&format!(
                "This stop could not be taken off the starts of release {to}: {error}"
            ));
        }
        std::process::exit(exit_code(status, stopped));
    }
    if let Some(why) = limit_ended {
        let limited = Pending {
            limit_ended: Some(why),
            ..pending.clone()
        };
        if let Err(error) = install.record.keep_pending(&limited) {
            sink.say(&format!(
                "Why the limit ended this start of release {to} could not be kept: {error}"
            ));
        }
    } else if status.code() == Some(REFUSED) {
        install.roll_back(
            sink,
            &pending,
            &format!(
                "Release {to} refused this server's database or settings (exit status {REFUSED})"
            ),
        );
    }
    sink.say(&format!(
        "Release {to} ended before it settled ({}); the service starts it again, and puts release {} back after {UNFINISHED_STARTS} such starts.",
        match (status.code(), status.signal()) {
            (Some(code), _) => format!("exit status {code}"),
            (None, Some(signal)) => format!("signal {signal}"),
            (None, None) => "no status".to_string(),
        },
        pending.from
    ));
    std::process::exit(RESTART);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_server_of_another_release_is_refused_by_name() {
        let server = Path::new("marfa-server");
        agree(server, "0.0.70", "0.0.70").unwrap();
        let error = agree(server, "0.0.70", "0.0.71").unwrap_err().to_string();
        assert!(
            error.contains("0.0.70") && error.contains("0.0.71"),
            "{error}"
        );
    }

    #[test]
    fn only_the_new_server_of_an_unsettled_update_runs_under_another_release() {
        let pending = Pending {
            from: "0.0.74".into(),
            to: "0.0.75".into(),
            schema: Some(1),
            starts: 0,
            programs: PathBuf::from("/bin"),
            attempt: None,
            limit_ended: None,
        };
        assert!(trying(&pending, "0.0.74", "0.0.75"));
        assert!(trying(&pending, "0.0.75", "0.0.75"));
        assert!(!trying(&pending, "0.0.74", "0.0.74"));
        assert!(!trying(&pending, "0.0.75", "0.0.74"));
        assert!(!trying(&pending, "0.0.74", "0.0.76"));
        assert!(!trying(&pending, "0.0.73", "0.0.75"));
    }

    #[test]
    fn a_limit_is_said_in_minutes_when_it_is_whole_minutes() {
        assert_eq!(spoken(TRIAL_LIMIT), "10 minutes");
        assert_eq!(spoken(UPGRADE_LIMIT), "2 hours");
        assert_eq!(spoken(Duration::from_millis(1500)), "1500 ms");
        assert_eq!(spoken(LET_GO_WAIT), "30 seconds");
    }
}
