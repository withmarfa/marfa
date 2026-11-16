//! The server as a systemd service on Linux: a user unit, or a system unit run as the
//! `marfa` account under root. `MARFA_AUTOSTART_ROOT` stands in for the file system's
//! root, with the tools to run in its `bin`, as for `folders autostart`.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use marfa_rules::environment::SERVICE;

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
Environment={SERVICE}=systemd
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
        crate::errln!("  $ {}", shown(scope, arguments));
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

/// A service already running on the same unit is left running. Returns whether the unit changed.
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
        crate::errln!("  $ loginctl enable-linger {user}");
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

/// Where one journal selection stood before a start.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Position {
    /// The selection held no entry, so everything it holds later is the start's.
    Start,
    /// The cursor of its last entry.
    After(String),
    /// The journal could not be asked.
    Unknown,
}

/// A user service's lines may be in the system journal or the account's own, so each is tried.
fn selections(scope: Scope, name: &str) -> Vec<Vec<String>> {
    let unit = service(name);
    match scope {
        Scope::User => vec![
            vec!["--user-unit".into(), unit.clone()],
            vec!["--user".into(), "-u".into(), unit],
        ],
        Scope::System => vec![vec!["-u".into(), unit]],
    }
}

fn journalctl(program: &Path, selection: &[String], more: &[&str]) -> Option<String> {
    let output = Command::new(program)
        .args(selection)
        .args(more)
        .arg("--no-pager")
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// The cursor of each selection's last entry, to read what is logged after it. A time would
/// leave a line logged in the same second as the start on the wrong side.
pub fn journal_mark(scope: Scope, name: &str) -> Vec<Position> {
    marked_by(&tool("journalctl"), scope, name)
}

fn marked_by(program: &Path, scope: Scope, name: &str) -> Vec<Position> {
    selections(scope, name)
        .iter()
        .map(|selection| {
            let Some(text) = journalctl(program, selection, &["-n", "1", "--output=json"]) else {
                return Position::Unknown;
            };
            match text.lines().find(|line| line.starts_with('{')) {
                None => Position::Start,
                Some(line) => serde_json::from_str::<serde_json::Value>(line)
                    .ok()
                    .and_then(|entry| entry["__CURSOR"].as_str().map(str::to_string))
                    .map_or(Position::Unknown, Position::After),
            }
        })
        .collect()
}

/// The last `lines` lines the unit logged, or those after `mark`. `None` when the journal
/// could not be read, which is not the same as a journal that holds nothing.
pub fn log_tail(
    scope: Scope,
    name: &str,
    lines: usize,
    mark: Option<&[Position]>,
) -> Option<String> {
    read_by(&tool("journalctl"), scope, name, lines, mark)
}

fn read_by(
    program: &Path,
    scope: Scope,
    name: &str,
    lines: usize,
    mark: Option<&[Position]>,
) -> Option<String> {
    let mut unread = false;
    for (at, selection) in selections(scope, name).iter().enumerate() {
        let text = match mark.map(|mark| mark.get(at).unwrap_or(&Position::Unknown)) {
            None => journalctl(
                program,
                selection,
                &["-n", &lines.to_string(), "--output=cat"],
            ),
            Some(Position::Start) => journalctl(program, selection, &["--output=cat"]),
            Some(Position::After(cursor)) => journalctl(
                program,
                selection,
                &[&format!("--after-cursor={cursor}"), "--output=cat"],
            ),
            Some(Position::Unknown) => None,
        };
        match text {
            Some(text) if !text.is_empty() => {
                let all: Vec<&str> = text.lines().collect();
                return Some(all[all.len().saturating_sub(lines)..].join("\n"));
            }
            Some(_) => {}
            None => unread = true,
        }
    }
    (!unread).then(String::new)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    /// A journal in a file, one line per entry, whose cursor is the number of its entries, and
    /// which answers as `journalctl` does for the options the command line uses.
    fn journal_in(folder: &Path) -> PathBuf {
        let program = folder.join("journalctl");
        std::fs::write(
            &program,
            r#"#!/bin/sh
J="$(dirname "$0")/journal"
[ -e "$(dirname "$0")/broken" ] && exit 1
after=""; json=""; last=""
while [ $# -gt 0 ]; do
  case "$1" in
    --after-cursor=*) after="${1#--after-cursor=}" ;;
    --output=json) json=1 ;;
    -n) shift; last="$1" ;;
  esac
  shift
done
[ -e "$J" ] || touch "$J"
count=$(wc -l < "$J" | tr -d ' ')
if [ -n "$json" ]; then
  [ "$count" -gt 0 ] && printf '{"__CURSOR":"c%s","MESSAGE":"x"}\n' "$count"
  exit 0
fi
if [ -n "$after" ]; then tail -n +$(( ${after#c} + 1 )) "$J"
elif [ -n "$last" ]; then tail -n "$last" "$J"
else cat "$J"; fi
"#,
        )
        .unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
        program
    }

    fn logged(folder: &Path, line: &str) {
        use std::io::Write;
        let mut journal = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(folder.join("journal"))
            .unwrap();
        writeln!(journal, "{line}").unwrap();
    }

    #[test]
    fn a_journal_read_after_its_mark_leaves_out_a_line_logged_before_the_start_in_the_same_second()
    {
        let folder = tempfile::tempdir().unwrap();
        let program = journal_in(folder.path());
        logged(folder.path(), "refused by an earlier start");
        let mark = marked_by(&program, Scope::System, "marfa");
        assert_eq!(mark, [Position::After("c1".into())]);
        logged(folder.path(), "this start's line");
        assert_eq!(
            read_by(&program, Scope::System, "marfa", 20, Some(&mark)).as_deref(),
            Some("this start's line")
        );
        // Witness: with no mark the same journal gives the earlier line too.
        assert!(
            read_by(&program, Scope::System, "marfa", 20, None)
                .unwrap()
                .contains("refused by an earlier start")
        );
        // A journal with nothing before the start gives everything after it.
        let empty = tempfile::tempdir().unwrap();
        let program = journal_in(empty.path());
        let mark = marked_by(&program, Scope::System, "marfa");
        assert_eq!(mark, [Position::Start]);
        logged(empty.path(), "first");
        logged(empty.path(), "second");
        assert_eq!(
            read_by(&program, Scope::System, "marfa", 1, Some(&mark)).as_deref(),
            Some("second")
        );
    }

    #[test]
    fn a_journal_that_cannot_be_read_is_not_one_that_holds_nothing() {
        let folder = tempfile::tempdir().unwrap();
        let program = journal_in(folder.path());
        assert_eq!(
            read_by(&program, Scope::User, "marfa", 20, None).as_deref(),
            Some("")
        );
        std::fs::write(folder.path().join("broken"), "").unwrap();
        let mark = marked_by(&program, Scope::User, "marfa");
        assert_eq!(mark, [Position::Unknown, Position::Unknown]);
        assert_eq!(
            read_by(&program, Scope::User, "marfa", 20, Some(&mark)),
            None
        );
        assert_eq!(read_by(&program, Scope::User, "marfa", 20, None), None);
        assert_eq!(
            read_by(
                &folder.path().join("absent"),
                Scope::System,
                "marfa",
                20,
                None
            ),
            None
        );
    }

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
            "Environment=MARFA_SERVICE=systemd",
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
            "Environment=MARFA_SERVICE=systemd",
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
