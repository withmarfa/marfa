//! `marfa server run`: the server as a child of this process, which a service runs.
//! A server that refused its database is not run again: a restart meets the same refusal.
//!
//! A self-update swaps in only the new `marfa-server`, so this process, of the release that ran
//! before, tries the new server: it counts each start in the update's record before the server
//! runs, and puts the old server back when the new one does not stay up. The service
//! definitions restart only a failed exit, so a start of the new release that ends unasked ends
//! this process with [`RESTART`].

use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime};

use marfa_rules::environment::INSTALL_DIR;
use marfa_rules::update_record::{
    self as record, MARFA, Outcome, Pending, UNFINISHED_STARTS, finish_swap, previous_of, put_back,
};

#[cfg(target_os = "linux")]
use std::os::unix::process::CommandExt;
use std::os::unix::process::ExitStatusExt;

use crate::error::CliError;
use crate::server::logs::{self, RotatingLog};
use crate::server::{Folder, RunArgs, files, launchd, native};

/// What the server's exit status says of its database: 78 is a refusal that
/// a restart will not change.
const REFUSED: i32 = 78;

/// What the service says when the server refused its database, which
/// `install` and `status` look for in the log.
pub const REFUSED_DATABASE: &str = "will not start on the database";

const SERVER: &str = record::SERVER;

/// What both service managers start again, as a failed exit.
const RESTART: i32 = 75;

/// How long the old server may take to say whether it opens the database.
const ASK_LIMIT: Duration = Duration::from_secs(20);

const OWN: &str = env!("CARGO_PKG_VERSION");

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

/// macOS has no parent-death signal; there the service manager's clean-up of the process group stops the child.
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

/// The version `marfa-server --version` prints: its last word.
fn version_of(server: &Path) -> Result<String, CliError> {
    let output = Command::new(server)
        .arg("--version")
        .stdin(Stdio::null())
        .output()
        .map_err(|error| CliError::Install(format!("cannot run {}: {error}", server.display())))?;
    String::from_utf8_lossy(&output.stdout)
        .split_whitespace()
        .last()
        .filter(|_| output.status.success())
        .map(str::to_string)
        .ok_or_else(|| {
            CliError::Install(format!(
                "{} did not say which release it is",
                server.display()
            ))
        })
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

/// A new server that an update swapped in, under the `marfa` of either release.
fn trying(pending: &Pending, own: &str, theirs: &str) -> bool {
    theirs == pending.to && (own == pending.from || own == pending.to)
}

/// The server beside this `marfa`. Another release is refused because the two share a database
/// and a socket, except a new server the install in `dir` is trying after an update.
pub fn locate(dir: Option<&Path>) -> Result<PathBuf, CliError> {
    let server = beside()?;
    let theirs = version_of(&server)?;
    let pending = dir.and_then(|dir| record_of(dir).pending().ok().flatten());
    if pending.is_some_and(|pending| trying(&pending, OWN, &theirs)) {
        return Ok(server);
    }
    agree(&server, &theirs, OWN)?;
    Ok(server)
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
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
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

/// The install `--dir` names, as this process supervises its server's updates.
struct Install {
    record: record::Folder,
    database: PathBuf,
    environment: Vec<(String, String)>,
    /// Held while this process runs, so a second `marfa server run` of the install counts no
    /// start; `None` when another holds it.
    lock: Option<File>,
}

impl Install {
    fn end(&self, sink: &Sink, outcome: Outcome, release: &str, reason: String) {
        sink.say(&reason);
        if let Err(error) = self.record.end(&now(), outcome, release, Some(reason)) {
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

    /// Why release `pending.from` cannot run again, or `None` when it can: it must open the
    /// database, as it stands now, with the same schema as before the swap.
    fn cannot_put_back(&self, pending: &Pending) -> Option<String> {
        let old = previous_of(&pending.programs, SERVER);
        if !old.is_file() {
            return Some(format!("{} is missing", old.display()));
        }
        let mut command = Command::new(&old);
        command
            .arg("--can-open")
            .arg(&self.database)
            .envs(self.environment.iter().map(|(name, value)| (name, value)))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let from = &pending.from;
        let (status, stdout, stderr) = match within(command, ASK_LIMIT) {
            Ok(Some(answered)) => answered,
            Ok(None) => {
                return Some(format!(
                    "release {from} did not say within {} seconds whether it opens the database",
                    ASK_LIMIT.as_secs()
                ));
            }
            Err(error) => return Some(format!("release {from} could not be asked: {error}")),
        };
        if !status.success() {
            let said = stderr.trim();
            return Some(format!(
                "release {from} will not open the database{}",
                if said.is_empty() {
                    String::new()
                } else {
                    format!(": {said}")
                }
            ));
        }
        #[derive(serde::Deserialize)]
        struct Said {
            schema: Option<u32>,
        }
        match serde_json::from_str::<Said>(stdout.trim()) {
            Ok(said) if said.schema == pending.schema => None,
            Ok(said) => Some(format!(
                "release {} has changed the database's schema from {} to {}",
                pending.to,
                schema_text(pending.schema),
                schema_text(said.schema)
            )),
            Err(_) => Some(format!(
                "release {from} answered about the database in words this marfa cannot read"
            )),
        }
    }

    /// Puts the old server back when it can run, and otherwise finishes the swap, so the next
    /// start runs one release whole. Ends the process for the service to start again.
    fn roll_back(&self, sink: &Sink, pending: &Pending, why: &str) -> ! {
        let (from, to, programs) = (&pending.from, &pending.to, &pending.programs);
        match self.cannot_put_back(pending) {
            None => match put_back(programs, OWN == to.as_str()) {
                Ok(()) => {
                    self.clear(sink);
                    self.end(
                        sink,
                        Outcome::RolledBack,
                        to,
                        format!("{why}, so release {from} was put back."),
                    );
                }
                Err(error) => self.end(
                    sink,
                    Outcome::Failed,
                    to,
                    format!(
                        "{why}, and release {from} could not be put back: {error}. The next start tries again."
                    ),
                ),
            },
            Some(cannot) => {
                let forward = finish_swap(programs);
                self.clear(sink);
                let reason = match forward {
                    Ok(()) => format!(
                        "{why}, and release {from} cannot be put back: {cannot}. Release {to} stays, and the server's log says why it ends."
                    ),
                    Err(error) => format!(
                        "{why}, release {from} cannot be put back ({cannot}), and release {to}'s marfa could not be put in place: {error}. Install release {to} on this host, then run `marfa server upgrade` for this server."
                    ),
                };
                self.end(sink, Outcome::Failed, to, reason);
            }
        }
        std::process::exit(RESTART);
    }

    /// Ends an update the programs on disk no longer match. `true` when this start goes on to
    /// try the new server, which `pending` counts.
    fn reconcile(&self, sink: &Sink, pending: &Pending, theirs: &str) -> bool {
        let (from, to, programs) = (&pending.from, &pending.to, &pending.programs);
        if trying(pending, OWN, theirs) {
            return true;
        }
        let ended_already = self
            .record
            .last()
            .ok()
            .flatten()
            .is_some_and(|last| last.release == *to);
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
                .and_then(|()| record::drop_next(programs));
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
            self.end(sink, outcome, to, reason);
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
            self.end(sink, outcome, to, reason);
        }
        false
    }
}

fn schema_text(schema: Option<u32>) -> String {
    schema.map_or_else(|| "none".to_string(), |schema| schema.to_string())
}

/// Runs `command` for at most `limit`, stopping it after that: its status and output, or `None`
/// when it did not end in time.
fn within(
    mut command: Command,
    limit: Duration,
) -> std::io::Result<Option<(ExitStatus, String, String)>> {
    let mut child = command.spawn()?;
    let mut readers = Vec::new();
    for from in [
        child
            .stdout
            .take()
            .map(|out| Box::new(out) as Box<dyn Read + Send>),
        child
            .stderr
            .take()
            .map(|err| Box::new(err) as Box<dyn Read + Send>),
    ]
    .into_iter()
    .flatten()
    {
        readers.push(std::thread::spawn(move || {
            let mut text = String::new();
            let mut from = from;
            let _ = from.read_to_string(&mut text);
            text
        }));
    }
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break Some(status);
        }
        if started.elapsed() >= limit {
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    let mut said = readers
        .into_iter()
        .map(|reader| reader.join().unwrap_or_default());
    let (stdout, stderr) = (
        said.next().unwrap_or_default(),
        said.next().unwrap_or_default(),
    );
    Ok(status.map(|status| (status, stdout, stderr)))
}

pub fn run(args: &RunArgs) -> Result<(), CliError> {
    let dir = &args.dir;
    let server = beside()?;
    let theirs = version_of(&server)?;
    let mut command = Command::new(&server);
    command.stdin(Stdio::null());
    let mut sink = Sink::Inherit;
    let mut folder_arg = String::new();
    let mut install = None;
    let mut log_path = None;
    if dir.dir.is_some() {
        let folder = Folder::new(dir)?;
        let (state, _) = folder.require_state()?;
        folder_arg = format!(
            " --dir '{}'",
            folder.dir.display().to_string().replace('\'', "'\\''")
        );
        let settings = folder.read(files::SETTINGS)?.unwrap_or_default();
        let environment = native::environment(&folder.dir, state.port, &settings);
        command.envs(environment.iter().map(|(name, value)| (name, value)));
        if launchd::supported() {
            log_path = Some(launchd::server_log(&state.name)?);
        }
        let record = record_of(&folder.dir);
        let lock = match record.path().is_dir() {
            true => Some(record.supervisor_lock().map_err(|error| {
                CliError::Io(std::io::Error::new(
                    error.kind(),
                    format!(
                        "cannot open the update's lock in {}: {error}",
                        record.path().display()
                    ),
                ))
            })?),
            false => None,
        };
        let supervised = lock.as_ref().is_none_or(|lock| lock.try_lock().is_ok());
        if supervised {
            command.env(INSTALL_DIR, &folder.dir);
        }
        install = Some(Install {
            record,
            database: native::Layout::new(&folder.dir).database(),
            environment,
            lock: lock.filter(|_| supervised),
        });
    }
    let accept = |install: Option<&Install>| {
        let pending = install.and_then(|install| install.record.pending().ok().flatten());
        match pending.is_some_and(|pending| trying(&pending, OWN, &theirs)) {
            true => Ok(()),
            false => agree(&server, &theirs, OWN),
        }
    };
    if args.check {
        return accept(install.as_ref());
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
    let trial = match (supervising, pending) {
        (Some(install), Some(pending)) if install.reconcile(&sink, &pending, &theirs) => {
            if pending.starts >= UNFINISHED_STARTS {
                install.roll_back(
                    &sink,
                    &pending,
                    &format!(
                        "Release {} ended {} times before it settled",
                        pending.to, pending.starts
                    ),
                );
            }
            let counted = Pending {
                starts: pending.starts + 1,
                ..pending.clone()
            };
            install.record.keep_pending(&counted).map_err(|error| {
                CliError::Io(std::io::Error::new(
                    error.kind(),
                    format!("cannot count this start of release {}: {error}", pending.to),
                ))
            })?;
            Some((install, pending.to))
        }
        _ => {
            accept(install.as_ref())?;
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
    let status = child.wait()?;
    for pump in pumps {
        let _ = pump.join();
    }
    CHILD.store(0, Ordering::SeqCst);
    let stopped = STOP.load(Ordering::SeqCst);
    if let Some((install, to)) = trial {
        ended_trial(install, &sink, &to, status, stopped);
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

fn exit_code(status: ExitStatus, stopped: bool) -> i32 {
    match (status.code(), status.signal()) {
        (Some(code), _) => code,
        // A stop that was passed on ended it as asked.
        (None, Some(libc::SIGTERM | libc::SIGINT)) if stopped => 0,
        (None, signal) => 128 + signal.unwrap_or(0),
    }
}

/// After a start of the new release while its update has not settled. Returns only when the
/// update has ended meanwhile, and the exit is then as for any other server.
fn ended_trial(install: &Install, sink: &Sink, to: &str, status: ExitStatus, stopped: bool) {
    let pending = match install.record.pending() {
        Ok(Some(pending)) if pending.to == to => pending,
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
    if status.code() == Some(REFUSED) {
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
    use std::os::unix::fs::PermissionsExt;

    fn script(dir: &Path, body: &str) -> PathBuf {
        let path = dir.join("marfa-server");
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("marfa-run-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_release_is_the_last_word_of_what_the_server_prints() {
        let dir = scratch("version");
        let server = script(&dir, "echo marfa-server 0.0.70");
        assert_eq!(version_of(&server).unwrap(), "0.0.70");
        agree(&server, "0.0.70", "0.0.70").unwrap();
        let error = agree(&server, "0.0.70", "0.0.71").unwrap_err().to_string();
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
        };
        assert!(trying(&pending, "0.0.74", "0.0.75"));
        assert!(trying(&pending, "0.0.75", "0.0.75"));
        assert!(!trying(&pending, "0.0.74", "0.0.74"));
        assert!(!trying(&pending, "0.0.75", "0.0.74"));
        assert!(!trying(&pending, "0.0.74", "0.0.76"));
        assert!(!trying(&pending, "0.0.73", "0.0.75"));
    }

    #[test]
    fn a_server_that_says_nothing_or_fails_is_not_taken_for_a_release() {
        let dir = scratch("silent");
        assert!(version_of(&script(&dir, "exit 0")).is_err());
        assert!(version_of(&script(&dir, "echo marfa-server 0.0.70; exit 3")).is_err());
        assert!(version_of(&dir.join("absent")).is_err());
    }
}
