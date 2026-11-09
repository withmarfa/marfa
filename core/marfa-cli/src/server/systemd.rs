//! The server as a systemd service on Linux: a user unit in the person's own
//! account, kept running at boot by lingering, or, when root installs it, a
//! system unit that runs as the `marfa` account. `MARFA_AUTOSTART_ROOT` names
//! a directory in place of the root of the file system, with the tools to run
//! in its `bin`, as for `folders autostart`.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use crate::autostart::{ROOT_ENV, quoted, text};
use crate::error::CliError;
use crate::server::account;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    /// In the person's own account.
    User,
    /// For the whole machine, running as the `marfa` account.
    System,
}

pub fn service(name: &str) -> String {
    format!("marfa-{name}.service")
}

pub struct Unit {
    pub name: String,
    pub binary: PathBuf,
    pub dir: PathBuf,
    pub scope: Scope,
    /// Nothing the service runs or keeps is under `/home` or `/root`.
    pub protect_home: bool,
}

/// Whether none of the paths is somewhere `ProtectHome` would hide.
pub fn clear_of_home(paths: &[&Path]) -> bool {
    paths
        .iter()
        .all(|path| !path.starts_with("/home") && !path.starts_with("/root"))
}

impl Unit {
    pub fn text(&self) -> Result<String, CliError> {
        let exec = [
            text(&self.binary)?,
            "server",
            "run",
            "--dir",
            text(&self.dir)?,
        ]
        .iter()
        .map(|word| quoted(word, true))
        .collect::<Vec<_>>()
        .join(" ");
        let (unit, run_as, install) = match self.scope {
            Scope::User => (String::new(), String::new(), "default.target"),
            Scope::System => {
                let hardening = format!(
                    "User={account}\nGroup={account}\nNoNewPrivileges=yes\nProtectSystem=strict\nReadWritePaths={paths}\nPrivateTmp=yes\n{home}",
                    account = account::NAME,
                    // The folder is root's; only the data in it is the account's to write.
                    paths = quoted(text(&self.dir.join("data"))?, false),
                    home = if self.protect_home {
                        "ProtectHome=yes\n"
                    } else {
                        ""
                    },
                );
                (
                    "After=network.target\n".to_string(),
                    hardening,
                    "multi-user.target",
                )
            }
        };
        Ok(format!(
            "[Unit]
Description=Marfa server {name}
{unit}
[Service]
Type=simple
ExecStart={exec}
Restart=on-failure
RestartSec=5
{run_as}
[Install]
WantedBy={install}
",
            name = self.name
        ))
    }
}

fn stand_in() -> Option<PathBuf> {
    std::env::var_os(ROOT_ENV)
        .filter(|root| !root.is_empty())
        .map(PathBuf::from)
}

/// Where the unit file goes.
pub fn file(scope: Scope, name: &str) -> Result<PathBuf, CliError> {
    let unit = service(name);
    Ok(match (scope, stand_in()) {
        (Scope::System, Some(root)) => root.join("etc/systemd/system").join(unit),
        (Scope::System, None) => Path::new("/etc/systemd/system").join(unit),
        (Scope::User, Some(root)) => root.join(".config/systemd/user").join(unit),
        (Scope::User, None) => std::env::var_os("XDG_CONFIG_HOME")
            .filter(|config| !config.is_empty())
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os("HOME")
                    .filter(|home| !home.is_empty())
                    .map(|home| PathBuf::from(home).join(".config"))
            })
            .ok_or_else(|| CliError::Usage("HOME is not set".into()))?
            .join("systemd/user")
            .join(unit),
    })
}

fn tool(name: &str) -> PathBuf {
    match stand_in() {
        Some(root) => root.join("bin").join(name),
        None => PathBuf::from(name),
    }
}

fn systemctl(scope: Scope, arguments: &[&str]) -> Command {
    let mut command = Command::new(tool("systemctl"));
    if scope == Scope::User {
        command.arg("--user");
    }
    command.args(arguments);
    command
}

fn shown(scope: Scope, arguments: &[&str]) -> String {
    let user = if scope == Scope::User { " --user" } else { "" };
    format!("systemctl{user} {}", arguments.join(" "))
}

fn said(output: &Output) -> String {
    let text = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if text.is_empty() {
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    } else {
        text
    }
}

fn ran(scope: Scope, arguments: &[&str], trace: bool) -> Result<Output, CliError> {
    if trace {
        eprintln!("  $ {}", shown(scope, arguments));
    }
    systemctl(scope, arguments).output().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            CliError::Install(
                "systemd was not found on this machine, and a native install keeps the server running with it: install with --docker instead".into(),
            )
        } else {
            CliError::Install(format!("cannot run systemctl: {error}"))
        }
    })
}

/// Runs systemctl and refuses on a failure, with what it said and the command
/// to run by hand.
fn must(scope: Scope, arguments: &[&str], trace: bool) -> Result<(), CliError> {
    let output = ran(scope, arguments, trace)?;
    if output.status.success() {
        return Ok(());
    }
    Err(CliError::Install(format!(
        "`{}` failed: {}. Run it yourself once that is fixed",
        shown(scope, arguments),
        said(&output)
    )))
}

/// Whether the person's own systemd answers, which a login session or
/// lingering gives.
pub fn user_session() -> Result<(), CliError> {
    let output = ran(Scope::User, &["show-environment"], false)?;
    if output.status.success() {
        return Ok(());
    }
    Err(CliError::Install(format!(
        "systemd is not running for this account ({}): log in again with a full session, or run `sudo loginctl enable-linger {}` and then log in again",
        said(&output),
        account::current_user()
    )))
}

pub fn active(scope: Scope, name: &str) -> bool {
    ran(scope, &["is-active", "--quiet", &service(name)], false)
        .is_ok_and(|output| output.status.success())
}

/// The process systemd runs the service as, while it runs one.
pub fn process_id(scope: Scope, name: &str) -> Option<u32> {
    let output = ran(
        scope,
        &["show", "--property=MainPID", "--value", &service(name)],
        false,
    )
    .ok()
    .filter(|output| output.status.success())?;
    String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse()
        .ok()
        .filter(|pid| *pid != 0)
}

pub fn enabled(scope: Scope, name: &str) -> bool {
    ran(scope, &["is-enabled", "--quiet", &service(name)], false)
        .is_ok_and(|output| output.status.success())
}

pub fn installed(scope: Scope, name: &str) -> bool {
    file(scope, name).is_ok_and(|path| path.exists())
}

/// Writes the unit, loads it and starts it, and has it start at boot when
/// `at_boot`. A service already running on the same unit is left running.
/// Whether the unit changed.
pub fn on(unit: &Unit, at_boot: bool, trace: bool) -> Result<bool, CliError> {
    let path = file(unit.scope, &unit.name)?;
    if let Some(folder) = path.parent() {
        std::fs::create_dir_all(folder)?;
    }
    let changed = crate::server::files::write_if_changed(
        &path,
        &unit.text()?,
        crate::server::files::Perms::READABLE,
    )?;
    let name = service(&unit.name);
    if changed {
        must(unit.scope, &["daemon-reload"], trace)?;
    }
    if at_boot {
        if !enabled(unit.scope, &unit.name) {
            must(unit.scope, &["enable", &name], trace)?;
        }
    } else if enabled(unit.scope, &unit.name) {
        must(unit.scope, &["disable", &name], trace)?;
    }
    if !active(unit.scope, &unit.name) {
        must(unit.scope, &["start", &name], trace)?;
    } else if changed {
        must(unit.scope, &["restart", &name], trace)?;
    }
    Ok(changed)
}

pub fn start(scope: Scope, name: &str, trace: bool) -> Result<(), CliError> {
    if active(scope, name) {
        return Ok(());
    }
    must(scope, &["start", &service(name)], trace)
}

pub fn restart(scope: Scope, name: &str, trace: bool) -> Result<(), CliError> {
    must(scope, &["restart", &service(name)], trace)
}

pub fn stop(scope: Scope, name: &str, trace: bool) -> Result<bool, CliError> {
    if !active(scope, name) {
        return Ok(false);
    }
    must(scope, &["stop", &service(name)], trace)?;
    Ok(true)
}

/// Stops the service, takes it out of boot, and removes the unit.
pub fn off(scope: Scope, name: &str, trace: bool) -> Result<bool, CliError> {
    let path = file(scope, name)?;
    let existed = path.exists();
    if existed {
        // A unit file that is gone leaves systemd unable to name what to stop.
        stop(scope, name, trace)?;
        if enabled(scope, name) {
            must(scope, &["disable", &service(name)], trace)?;
        }
        std::fs::remove_file(&path)?;
        must(scope, &["daemon-reload"], trace)?;
    }
    Ok(existed)
}

/// What the machine does about the account running at boot with nobody
/// logged in.
#[derive(Debug, PartialEq, Eq)]
pub enum Linger {
    Already,
    Enabled,
    /// `loginctl` refused: what it said.
    Refused(String),
}

pub fn linger(trace: bool) -> Result<Linger, CliError> {
    let user = account::current_user();
    let shown = Command::new(tool("loginctl"))
        .args(["show-user", &user, "--property=Linger", "--value"])
        .output();
    if shown.is_ok_and(|output| String::from_utf8_lossy(&output.stdout).trim() == "yes") {
        return Ok(Linger::Already);
    }
    if trace {
        eprintln!("  $ loginctl enable-linger {user}");
    }
    let output = Command::new(tool("loginctl"))
        .args(["enable-linger", &user])
        .output()
        .map_err(|error| CliError::Install(format!("cannot run loginctl: {error}")))?;
    Ok(if output.status.success() {
        Linger::Enabled
    } else {
        Linger::Refused(said(&output))
    })
}

/// The last lines the service logged, for a person who finds it down. A user
/// service's lines are in the system journal, which only some accounts may
/// read, and in the account's own journal, which a machine that keeps its
/// journal in memory does not have, so each is tried.
pub fn log_tail(scope: Scope, name: &str, lines: usize, since: Option<u64>) -> String {
    let unit = service(name);
    let selections: Vec<Vec<String>> = match scope {
        Scope::User => vec![
            vec!["--user-unit".into(), unit.clone()],
            vec!["--user".into(), "-u".into(), unit],
        ],
        Scope::System => vec![vec!["-u".into(), unit]],
    };
    for selection in selections {
        let mut command = Command::new(tool("journalctl"));
        command
            .args(&selection)
            .args(["-n", &lines.to_string(), "--no-pager", "--output=cat"]);
        if let Some(since) = since {
            command.arg(format!("--since=@{since}"));
        }
        let text = command
            .output()
            .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
            .unwrap_or_default();
        if !text.is_empty() {
            return text;
        }
    }
    String::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unit(scope: Scope) -> Unit {
        Unit {
            name: "marfa".into(),
            binary: "/usr/local/bin/marfa".into(),
            dir: "/var/lib/marfa-server".into(),
            scope,
            protect_home: true,
        }
    }

    #[test]
    fn a_user_unit_runs_the_server_in_the_account_and_comes_back_after_a_failure() {
        let text = unit(Scope::User).text().unwrap();
        for line in [
            "ExecStart=\"/usr/local/bin/marfa\" \"server\" \"run\" \"--dir\" \"/var/lib/marfa-server\"",
            "Restart=on-failure",
            "WantedBy=default.target",
        ] {
            assert!(text.lines().any(|found| found == line), "{line}\n{text}");
        }
        assert!(!text.contains("User=") && !text.contains("ProtectSystem"));
    }

    #[test]
    fn a_system_unit_runs_as_the_account_with_what_it_needs_and_no_more() {
        let text = unit(Scope::System).text().unwrap();
        for line in [
            "User=marfa",
            "Group=marfa",
            "Restart=on-failure",
            "NoNewPrivileges=yes",
            "ProtectSystem=strict",
            "ReadWritePaths=\"/var/lib/marfa-server/data\"",
            "PrivateTmp=yes",
            "ProtectHome=yes",
            "WantedBy=multi-user.target",
        ] {
            assert!(text.lines().any(|found| found == line), "{line}\n{text}");
        }
    }

    #[test]
    fn home_is_hidden_from_the_service_only_when_it_needs_none_of_it() {
        assert!(
            unit(Scope::System)
                .text()
                .unwrap()
                .contains("ProtectHome=yes")
        );
        let mut open = unit(Scope::System);
        open.protect_home = false;
        assert!(!open.text().unwrap().contains("ProtectHome"));
        assert!(clear_of_home(&[
            Path::new("/usr/local/bin/marfa"),
            Path::new("/var/lib/marfa-server")
        ]));
        assert!(!clear_of_home(&[Path::new("/root/.local/bin/marfa")]));
        assert!(!clear_of_home(&[Path::new("/home/x/marfa-server")]));
        assert!(clear_of_home(&[
            Path::new("/homes/x"),
            Path::new("/rooted")
        ]));
    }

    #[test]
    fn a_path_a_unit_would_read_as_a_specifier_is_escaped() {
        let mut odd = unit(Scope::User);
        odd.dir = "/srv/100%/a b".into();
        let text = odd.text().unwrap();
        assert!(text.contains("\"/srv/100%%/a b\""), "{text}");
    }

    #[test]
    fn a_unit_holds_no_secret() {
        for scope in [Scope::User, Scope::System] {
            let text = unit(scope).text().unwrap();
            assert!(!text.contains("SECRET") && !text.contains("SALT"));
        }
    }
}
