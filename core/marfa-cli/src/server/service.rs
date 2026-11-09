//! What keeps a native server running on this machine, whichever service
//! manager the machine has, and how this command talks to the server through
//! its private socket.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::error::CliError;
use crate::server::account::{self, Identity};
use crate::server::docker::Docker;
use crate::server::systemd::{self, Linger, Scope};
use crate::server::{launchd, native};

/// The program that runs the `marfa` commands that talk to the server's
/// socket, in place of this one. The tests use it.
const CONTROL_ENV: &str = "MARFA_SERVER_CONTROL";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Manager {
    Launchd,
    SystemdUser,
    SystemdSystem,
}

impl Manager {
    pub fn name(self) -> &'static str {
        match self {
            Manager::Launchd => "launchd",
            Manager::SystemdUser => "systemd-user",
            Manager::SystemdSystem => "systemd-system",
        }
    }

    pub fn parse(name: &str) -> Option<Manager> {
        [
            Manager::Launchd,
            Manager::SystemdUser,
            Manager::SystemdSystem,
        ]
        .into_iter()
        .find(|manager| manager.name() == name)
    }

    /// The manager for a new install on this machine.
    pub fn here() -> Result<Manager, CliError> {
        let stand_in = std::env::var_os(crate::autostart::ROOT_ENV).is_some_and(|v| !v.is_empty());
        if cfg!(target_os = "macos") {
            if account::is_root() && !stand_in {
                return Err(CliError::Usage(
                    "a server installed by root on a Mac would run in root's login session, which does not exist at boot. Run this as the person who will use the server, without sudo".into(),
                ));
            }
            Ok(Manager::Launchd)
        } else if cfg!(target_os = "linux") {
            Ok(if account::is_root() && !stand_in {
                Manager::SystemdSystem
            } else {
                Manager::SystemdUser
            })
        } else {
            Err(CliError::Usage(format!(
                "a native server runs on macOS and Linux, and this system is {}: install with --docker",
                std::env::consts::OS
            )))
        }
    }

    /// Whether this account can manage a service of this kind.
    pub fn check_account(self) -> Result<(), CliError> {
        match (self, account::is_root()) {
            (Manager::SystemdSystem, false) => Err(CliError::Usage(
                "this server runs as the marfa account and was installed by root: run this with sudo".into(),
            )),
            (Manager::SystemdUser | Manager::Launchd, true)
                if !std::env::var_os(crate::autostart::ROOT_ENV).is_some_and(|v| !v.is_empty()) =>
            {
                Err(CliError::Usage(
                    "this server runs in another account's own service manager, and was not installed by root: run this as that account".into(),
                ))
            }
            _ => Ok(()),
        }
    }

    fn scope(self) -> Scope {
        match self {
            Manager::SystemdSystem => Scope::System,
            _ => Scope::User,
        }
    }
}

pub struct Service<'a> {
    pub manager: Manager,
    pub name: &'a str,
    pub dir: &'a Path,
    pub trace: bool,
}

const RESTART_WAIT: Duration = Duration::from_secs(4);

/// What a start left to say.
pub struct Started {
    pub linger: Option<Linger>,
    /// A restart whose process ID the manager did not report, so that only
    /// the server's answer on its port can confirm it.
    pub unconfirmed: Option<When>,
}

/// Whether the manager gave no process ID before the restart or after it.
#[derive(Clone, Copy)]
pub enum When {
    Before,
    After,
}

impl Started {
    pub fn confirmed(&self) -> bool {
        self.unconfirmed.is_none()
    }

    /// Says plainly what the restart left unconfirmed.
    pub fn say_unconfirmed(&self, port: u16) {
        if let Some(when) = self.unconfirmed {
            let when = match when {
                When::Before => "before",
                When::After => "after",
            };
            eprintln!(
                "The service manager gave no process ID {when} the restart, so this run cannot show that the process was replaced. It confirms only that the server answers on port {port}, and the next `marfa server install` restarts it again."
            );
        }
    }
}

impl Service<'_> {
    /// What a person calls it.
    pub fn describe(&self) -> String {
        match self.manager {
            Manager::Launchd => format!("the launchd agent {}", launchd::label(self.name)),
            Manager::SystemdUser => {
                format!("the systemd user service {}", systemd::service(self.name))
            }
            Manager::SystemdSystem => {
                format!("the systemd service {}", systemd::service(self.name))
            }
        }
    }

    pub fn exists(&self) -> bool {
        match self.manager {
            Manager::Launchd => launchd::installed(self.name, self.dir).is_some(),
            m => systemd::installed(m.scope(), self.name),
        }
    }

    /// Writes the service and loads it. With `restart`, the running server
    /// is replaced, because it reads its settings only when it starts, and
    /// that happens whatever the process ID query says.
    pub fn on(
        &self,
        autostart: bool,
        restart: bool,
        binary: &Path,
        server: &Path,
    ) -> Result<Started, CliError> {
        let running = restart && self.running();
        let before = if running { self.process_id() } else { None };
        let (changed, linger) = self.write_and_load(autostart, binary, server)?;
        // Loading a changed definition restarted the service, and on systemd
        // loading also started a stopped one.
        if restart && !changed {
            if running {
                self.restart()?;
            } else {
                self.start()?;
            }
        }
        let unconfirmed = match (running, before) {
            (false, _) => None,
            (true, Some(before)) => self.await_new_process(before)?,
            (true, None) => Some(When::Before),
        };
        Ok(Started {
            linger,
            unconfirmed,
        })
    }

    fn write_and_load(
        &self,
        autostart: bool,
        binary: &Path,
        server: &Path,
    ) -> Result<(bool, Option<Linger>), CliError> {
        match self.manager {
            Manager::Launchd => {
                let agent = launchd::Agent {
                    name: self.name.to_string(),
                    job: launchd::Job::Server,
                    binary: binary.to_path_buf(),
                    dir: self.dir.to_path_buf(),
                    stdout: launchd::agent_log(self.name)?,
                    at_login: autostart,
                };
                Ok((launchd::on(&agent, self.trace)?, None))
            }
            manager => {
                let scope = manager.scope();
                if scope == Scope::User {
                    systemd::user_session()?;
                }
                let unit = systemd::Unit {
                    name: self.name.to_string(),
                    binary: binary.to_path_buf(),
                    dir: self.dir.to_path_buf(),
                    scope,
                    protect_home: systemd::clear_of_home(&[binary, self.dir, server]),
                };
                let changed = systemd::on(&unit, autostart, self.trace)?;
                // A user service starts at boot only while the account's
                // systemd runs, which nobody being logged in does not allow.
                let linger = (scope == Scope::User && autostart)
                    .then(|| systemd::linger(self.trace))
                    .transpose()?;
                Ok((changed, linger))
            }
        }
    }

    /// The process the manager runs the service as, while it runs one.
    pub fn process_id(&self) -> Option<u32> {
        match self.manager {
            Manager::Launchd => launchd::process_id(self.name),
            m => systemd::process_id(m.scope(), self.name),
        }
    }

    // Confirms by a changed process ID when the manager reports both, and
    // says which one it could not read when it does not.
    fn await_new_process(&self, before: u32) -> Result<Option<When>, CliError> {
        let deadline = Instant::now() + RESTART_WAIT;
        loop {
            let now = self.process_id();
            match now {
                Some(now) if now != before => return Ok(None),
                _ if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(100)),
                None => return Ok(Some(When::After)),
                Some(_) => {
                    return Err(CliError::Install(format!(
                        "{} did not restart: the service manager still reports process {before}, so the restart could not be confirmed. Run `marfa server stop --dir '{dir}'` and then `marfa server start --dir '{dir}'`",
                        self.describe(),
                        dir = self.dir.display().to_string().replace('\'', "'\\''")
                    )));
                }
            }
        }
    }

    pub fn start(&self) -> Result<(), CliError> {
        match self.manager {
            Manager::Launchd => launchd::start(self.name, self.dir, self.trace),
            m => systemd::start(m.scope(), self.name, self.trace),
        }
    }

    pub fn restart(&self) -> Result<(), CliError> {
        match self.manager {
            Manager::Launchd => launchd::restart(self.name, self.dir, self.trace),
            m => systemd::restart(m.scope(), self.name, self.trace),
        }
    }

    /// Whether it was running.
    pub fn stop(&self) -> Result<bool, CliError> {
        match self.manager {
            Manager::Launchd => launchd::stop(self.name, self.trace),
            m => systemd::stop(m.scope(), self.name, self.trace),
        }
    }

    pub fn running(&self) -> bool {
        match self.manager {
            Manager::Launchd => launchd::running(self.name),
            m => systemd::active(m.scope(), self.name),
        }
    }

    /// Whether it starts again by itself after the machine or login does.
    pub fn at_boot(&self) -> bool {
        match self.manager {
            Manager::Launchd => launchd::at_login(self.name),
            m => systemd::enabled(m.scope(), self.name),
        }
    }

    /// Removes the service. Whether there was one.
    pub fn off(&self) -> Result<bool, CliError> {
        match self.manager {
            Manager::Launchd => launchd::off(self.name, self.dir, self.trace),
            m => systemd::off(m.scope(), self.name, self.trace),
        }
    }

    /// Where the log stands now, so that a later read can leave out what was
    /// logged before: an earlier refusal is not this one.
    pub fn mark(&self) -> Mark {
        match self.manager {
            Manager::Launchd => Mark::Bytes(
                launchd::server_log(self.name)
                    .ok()
                    .and_then(|path| std::fs::metadata(path).ok())
                    .map_or(0, |meta| meta.len()),
            ),
            _ => Mark::Time(
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_or(0, |since| since.as_secs()),
            ),
        }
    }

    /// The last lines the server logged, where this manager keeps them.
    pub fn log_tail(&self, lines: usize) -> String {
        self.log_after(None, lines)
    }

    /// The last lines logged since `mark`, or ever.
    pub fn log_after(&self, mark: Option<&Mark>, lines: usize) -> String {
        match self.manager {
            Manager::Launchd => {
                let read = |path: Result<PathBuf, CliError>| {
                    path.ok()
                        .map(|path| tail_of_file(&path, lines))
                        .unwrap_or_default()
                };
                let log = match (mark, launchd::server_log(self.name)) {
                    (Some(Mark::Bytes(from)), Ok(path)) => tail_of_file_from(&path, *from, lines),
                    (_, path) => read(path),
                };
                if log.is_empty() && mark.is_none() {
                    read(launchd::agent_log(self.name))
                } else {
                    log
                }
            }
            m => {
                let since = match mark {
                    Some(Mark::Time(since)) => Some(*since),
                    _ => None,
                };
                systemd::log_tail(m.scope(), self.name, lines, since)
            }
        }
    }
}

/// Where a log stood.
pub enum Mark {
    Bytes(u64),
    Time(u64),
}

/// The last `lines` lines of a file after its first `from` bytes, which a
/// file that has since been moved aside and begun again does not have.
fn tail_of_file_from(path: &Path, from: u64, lines: usize) -> String {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut file) = std::fs::File::open(path) else {
        return String::new();
    };
    let length = file.metadata().map(|meta| meta.len()).unwrap_or(0);
    let start = if length < from { 0 } else { from };
    let mut bytes = Vec::new();
    if file.seek(SeekFrom::Start(start)).is_err() || file.read_to_end(&mut bytes).is_err() {
        return String::new();
    }
    let text = String::from_utf8_lossy(&bytes);
    let all: Vec<&str> = text.lines().collect();
    all[all.len().saturating_sub(lines)..].join("\n")
}

/// The last `lines` lines of a file, read from its end.
pub fn tail_of_file(path: &Path, lines: usize) -> String {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut file) = std::fs::File::open(path) else {
        return String::new();
    };
    let length = file.metadata().map(|meta| meta.len()).unwrap_or(0);
    let from = length.saturating_sub(64 * 1024);
    let mut bytes = Vec::new();
    if file.seek(SeekFrom::Start(from)).is_err() || file.read_to_end(&mut bytes).is_err() {
        return String::new();
    }
    let text = String::from_utf8_lossy(&bytes);
    let all: Vec<&str> = text.lines().collect();
    all[all.len().saturating_sub(lines)..].join("\n")
}

/// The call to the server's socket. As the server's account, it carries
/// nothing of the caller's: root's environment, with its variables and search
/// path, is not the account's to read or to run from.
fn socket_command(
    program: &Path,
    dir: &Path,
    socket: &Path,
    as_account: Option<Identity>,
    args: &[&str],
) -> std::process::Command {
    let mut command = match as_account {
        Some(identity) => {
            let mut command = account::command_as(identity, program);
            command
                .env_clear()
                .env("PATH", "/usr/bin:/bin")
                .env("HOME", dir)
                .current_dir(dir);
            command
        }
        None => std::process::Command::new(program),
    };
    command
        .arg("--socket")
        .arg(socket)
        .arg("--json")
        .args(args)
        .stdin(Stdio::null())
        .env("MARFA_NO_KEYCHAIN", "1");
    command
}

/// How this command reaches the server's private socket.
pub enum Control<'a> {
    Container {
        docker: &'a Docker,
        name: &'a str,
    },
    Process {
        /// The install folder, where the call runs.
        dir: PathBuf,
        socket: PathBuf,
        as_account: Option<Identity>,
    },
}

impl<'a> Control<'a> {
    pub fn native(dir: &Path, manager: Manager) -> Result<Control<'a>, CliError> {
        let as_account = match manager {
            Manager::SystemdSystem => Some(account::lookup(account::NAME).ok_or_else(|| {
                CliError::Install(format!("the {} account is missing", account::NAME))
            })?),
            _ => None,
        };
        Ok(Control::Process {
            dir: dir.to_path_buf(),
            socket: native::Layout::new(dir).socket(),
            as_account,
        })
    }

    /// Runs a `marfa` command through the socket and reads the JSON it prints.
    pub fn json(&self, args: &[&str]) -> Result<Value, CliError> {
        match self {
            Control::Container { docker, name } => docker.marfa_json(name, args),
            Control::Process {
                dir,
                socket,
                as_account,
            } => {
                let program = std::env::var_os(CONTROL_ENV)
                    .map(PathBuf::from)
                    .map_or_else(std::env::current_exe, Ok)?;
                let mut command = socket_command(&program, dir, socket, *as_account, args);
                let output = command.output().map_err(|error| {
                    CliError::Install(format!("cannot run {}: {error}", program.display()))
                })?;
                if !output.status.success() {
                    let said = String::from_utf8_lossy(&output.stderr);
                    let said = said.trim();
                    let said = if said.is_empty() {
                        String::from_utf8_lossy(&output.stdout).trim().to_string()
                    } else {
                        said.to_string()
                    };
                    return Err(CliError::Install(format!(
                        "`marfa {}` on the server's socket failed: {said}",
                        args.join(" ")
                    )));
                }
                serde_json::from_slice(&output.stdout).map_err(|_| {
                    CliError::Install(format!(
                        "the server's answer to `marfa {}` was not JSON",
                        args.join(" ")
                    ))
                })
            }
        }
    }
}

#[cfg(test)]
mod socket_tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn a_call_as_the_account_carries_nothing_of_the_callers() {
        let dir = std::env::temp_dir().join(format!("marfa-socket-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let program = dir.join("show");
        std::fs::write(
            &program,
            "#!/bin/sh\n/usr/bin/env\npwd\necho \"args: $*\"\n",
        )
        .unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
        // Becoming oneself needs no privilege, and the environment is cleared
        // all the same.
        // SAFETY: `getuid` and `getgid` cannot fail.
        let me = Identity {
            uid: unsafe { libc::getuid() },
            gid: unsafe { libc::getgid() },
        };
        let socket = dir.join("marfa.sock");
        let output = socket_command(&program, &dir, &socket, Some(me), &["setup", "status"])
            .output()
            .unwrap();
        let said = String::from_utf8_lossy(&output.stdout);
        assert!(output.status.success(), "{said}");
        assert!(
            !said.contains("CARGO_MANIFEST_DIR"),
            "the caller's environment was inherited: {said}"
        );
        for line in [
            "PATH=/usr/bin:/bin".to_string(),
            format!("HOME={}", dir.display()),
            "MARFA_NO_KEYCHAIN=1".to_string(),
        ] {
            assert!(said.lines().any(|set| set == line), "{line}\n{said}");
        }
        let here = std::fs::canonicalize(&dir).unwrap();
        assert!(
            said.lines().any(|line| line == here.display().to_string()),
            "{said}"
        );
        assert!(
            said.contains(&format!(
                "args: --socket {} --json setup status",
                socket.display()
            )),
            "{said}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
