//! `marfa server run`: the server as a child of this process, which a service runs.
//! A server that refused its database is not run again: a restart meets the same refusal.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

#[cfg(target_os = "linux")]
use std::os::unix::process::CommandExt;
use std::os::unix::process::ExitStatusExt;

use crate::error::CliError;
use crate::server::logs::{self, RotatingLog};
use crate::server::{DirArgs, Folder, files, launchd, native};

/// What the server's exit status says of its database: 78 is a refusal that
/// a restart will not change.
const REFUSED: i32 = 78;

/// What the service says when the server refused its database, which
/// `install` and `status` look for in the log.
pub const REFUSED_DATABASE: &str = "will not start on the database";

const SERVER: &str = "marfa-server";

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

/// The server beside this `marfa`; another release is refused because the two share a database and a socket.
pub fn locate() -> Result<PathBuf, CliError> {
    let exe = std::fs::canonicalize(std::env::current_exe()?)?;
    let server = native::find_server(&exe).ok_or_else(|| {
        CliError::Install(format!(
            "{SERVER} was not found beside {}: it comes in the same package as marfa (Homebrew's marfa, or scripts/install.sh), so install that again. A {SERVER} elsewhere on the path is never used",
            exe.display()
        ))
    })?;
    agree(&server, env!("CARGO_PKG_VERSION"))?;
    Ok(server)
}

fn agree(server: &Path, own: &str) -> Result<(), CliError> {
    let theirs = version_of(server)?;
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

pub fn run(dir: &DirArgs) -> Result<(), CliError> {
    let server = locate()?;
    let mut command = Command::new(&server);
    command.stdin(Stdio::null());
    let mut sink = Sink::Inherit;
    let mut folder_arg = String::new();
    if dir.dir.is_some() {
        let folder = Folder::new(dir)?;
        let (state, _) = folder.require_state()?;
        folder_arg = format!(
            " --dir '{}'",
            folder.dir.display().to_string().replace('\'', "'\\''")
        );
        let settings = folder.read(files::SETTINGS)?.unwrap_or_default();
        command.envs(native::environment(&folder.dir, state.port, &settings));
        if launchd::supported() {
            let path = launchd::server_log(&state.name)?;
            let log = RotatingLog::open(&path, logs::LIMIT).map_err(|error| {
                CliError::Io(std::io::Error::new(
                    error.kind(),
                    format!("cannot open the log {}: {error}", path.display()),
                ))
            })?;
            sink = Sink::File(Arc::new(Mutex::new(log)));
        }
    }
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
    if status.code() == Some(REFUSED) && !stopped {
        sink.say(&format!(
            "{SERVER} {REFUSED_DATABASE} (exit status {REFUSED}); the lines above say why. This service stays up and does nothing, so that it is not started again into the same refusal. Stop it with `marfa server stop{folder_arg}`, fix the database, then run `marfa server start{folder_arg}`."
        ));
        while !STOP.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(250));
        }
        std::process::exit(0);
    }
    std::process::exit(match (status.code(), status.signal()) {
        (Some(code), _) => code,
        // A stop that was passed on ended it as asked.
        (None, Some(libc::SIGTERM | libc::SIGINT)) if stopped => 0,
        (None, signal) => 128 + signal.unwrap_or(0),
    });
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
        agree(&server, "0.0.70").unwrap();
        let error = agree(&server, "0.0.71").unwrap_err().to_string();
        assert!(
            error.contains("0.0.70") && error.contains("0.0.71"),
            "{error}"
        );
    }

    #[test]
    fn a_server_that_says_nothing_or_fails_is_not_taken_for_a_release() {
        let dir = scratch("silent");
        assert!(version_of(&script(&dir, "exit 0")).is_err());
        assert!(version_of(&script(&dir, "echo marfa-server 0.0.70; exit 3")).is_err());
        assert!(version_of(&dir.join("absent")).is_err());
    }
}
