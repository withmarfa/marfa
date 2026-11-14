//! Folder syncing from login: a launchd agent on macOS and a systemd user
//! unit on Linux, in the person's own account, that run the one watch over
//! every folder.

use std::io::Write as _;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant, SystemTime};

use clap::Subcommand;
use marfa_core::folder::{MISSING, Registry, WatchRecord};
use serde::{Deserialize, Serialize};

use crate::error::CliError;
use crate::output;
use crate::remote::Named;

/// The launchd agent's label, and the name of its property list.
pub const LABEL: &str = "so.marfa.folder-watch";

/// The systemd user unit's name.
pub const UNIT: &str = "marfa-folder-watch.service";

/// Names a directory that stands in for the home directory: the agent is
/// written below it, and the service manager is the `launchctl` or
/// `systemctl` in its `bin`, never the system's.
pub const ROOT_ENV: &str = "MARFA_AUTOSTART_ROOT";

/// The log's name, beside the folder registry.
pub const LOG_NAME: &str = "folder-watch.log";

/// The least time between two starts of a watch that keeps failing.
pub const RESTART_SECONDS: u32 = 30;

/// The reasons in the record of folder watches that say the watch has no
/// credential it can use for a folder's server.
const CREDENTIAL_REASONS: [&str; 4] =
    ["no_credential", "no_keychain", "unauthorized", "signed_out"];

/// The watch's nice level, under launchd and systemd alike. An agent or a
/// user unit may raise it without privilege, and the cpu controller that
/// systemd's `CPUWeight=` needs is not always delegated to a user manager.
const NICE: u8 = 10;

/// The watch's I/O priority within the best-effort class: 7 is the lowest.
const IO_PRIORITY: u8 = 7;

/// How long `off`, or an `on` that replaces a loaded agent, waits for launchd
/// to let go of the agent it unloaded.
const UNLOAD_WAIT: Duration = Duration::from_secs(10);

#[derive(Debug, Subcommand)]
pub enum AutostartCommand {
    /// Sync every folder from login, and start now: writes a launchd agent on
    /// macOS or a systemd user unit on Linux, in your own account, that runs
    /// `folders watch` with no directory by this binary's path. It holds no
    /// credential and no server: each folder uses the server its copy came
    /// from and the credential the keychain keeps for it. Run again, it
    /// changes nothing unless the agent would differ, as one written by an
    /// earlier build does. The watch runs at a lower CPU and I/O priority, so
    /// it gives way to foreground work but keeps working when every core is
    /// busy. Once a new build is installed at the binary's path, as an
    /// upgrade does, the watch ends after the passes under way finish and the
    /// service manager starts the new build.
    ///
    /// The watch writes to its log, `folder-watch.log` beside the folder
    /// registry. An error it makes before it opens the log goes, on macOS, to
    /// `folder-watch.launchd.log` beside it, which the agent names for the
    /// watch's output, and on Linux to the user journal
    /// (`journalctl --user -u marfa-folder-watch.service`).
    ///
    /// The watch reports as a command run from this shell does: the telemetry
    /// settings set here (`MARFA_POSTHOG_HOST`, `MARFA_POSTHOG_PROJECT_TOKEN`,
    /// `OTEL_SDK_DISABLED` and the `OTEL_*` settings that `marfa` reads) are
    /// written to `folder-watch.env` beside the folder registry, a file only
    /// you can read, and the agent names that file and holds none of them.
    /// Run again, it makes the file match the settings set then, and removes
    /// it where none is. It says which settings it carried, by name.
    ///
    /// With `--key-file` the agent runs the watch with that file in place of
    /// the keychain, for a machine where nobody signs in to unlock it. The
    /// agent holds the file's path and never what is in it.
    On {
        /// A file that holds `MARFA_API_URL` and `MARFA_API_KEY` lines, which
        /// only you can read (mode 600) and which lies outside every folder.
        /// The agent uses it for the folders that name that server and reads
        /// the keychain for none. A key limited to the types the folder
        /// carries is the intended use. Without this option the agent uses
        /// the keychain.
        #[arg(long, value_name = "FILE")]
        key_file: Option<PathBuf>,
    },
    /// Stop syncing folders from login: stops the watch and removes the
    /// agent. Run again, it changes nothing.
    Off,
    /// Say whether folders sync from login: whether the agent is installed
    /// and running, whether it differs from what `on` would write now, the
    /// binary it runs, where it logs (on macOS, also the file the installed
    /// agent names for what the watch prints before it opens its log, or that
    /// it names none), and what the watch's record says of each folder. Asks
    /// no server and needs no credential.
    Status,
}

pub fn run(command: AutostartCommand, named: &Named, json: bool) -> Result<(), CliError> {
    if named.on_command_line() {
        return Err(CliError::Usage(
            "folders autostart takes none of --url, --key and --profile: the watch it runs holds no server or credential, and each folder uses its own".into(),
        ));
    }
    let place = Place::here()?;
    match command {
        AutostartCommand::On { key_file } => on(&place, key_file.as_deref(), json),
        AutostartCommand::Off => off(&place, json),
        AutostartCommand::Status => status(&place, json),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum Manager {
    Launchd,
    Systemd,
}

impl Manager {
    fn here() -> Option<Manager> {
        if cfg!(target_os = "macos") {
            Some(Manager::Launchd)
        } else if cfg!(target_os = "linux") {
            Some(Manager::Systemd)
        } else {
            None
        }
    }

    fn name(self) -> &'static str {
        match self {
            Manager::Launchd => LABEL,
            Manager::Systemd => UNIT,
        }
    }

    fn kind(self) -> &'static str {
        match self {
            Manager::Launchd => "launchd agent",
            Manager::Systemd => "systemd user unit",
        }
    }
}

/// What the agent runs: `on` writes it and `status` reads it back.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Agent {
    binary: PathBuf,
    log: PathBuf,
    registry: PathBuf,
    /// The file the watch takes its server and key from, in place of the
    /// keychain. Its path only: the agent never holds what the file does.
    key_file: Option<PathBuf>,
    /// The file of telemetry settings the watch reads as it starts, which the
    /// agent names and never holds: it is readable by others, and the file is
    /// not.
    telemetry_file: Option<PathBuf>,
}

impl Agent {
    /// The registry is the one this command resolves, so the watch lists the
    /// folders `folders list` lists from this shell, whatever environment the
    /// service manager gives it.
    fn for_this_binary() -> Result<Agent, CliError> {
        let binary = invoked(
            std::env::args_os().next().as_deref(),
            std::env::var_os("PATH").as_deref(),
            &std::env::current_dir()?,
            &std::env::current_exe()?,
        );
        let registry = Registry::located().ok_or_else(|| {
            CliError::Invalid(
                "there is no folder registry for the watch to read: HOME is not set, and MARFA_FOLDER_REGISTRY names none".into(),
            )
        })?;
        let registry = std::path::absolute(registry.path())?;
        Ok(Agent {
            log: registry.with_file_name(LOG_NAME),
            binary,
            registry,
            key_file: None,
            telemetry_file: None,
        })
    }

    /// Where the telemetry settings go, beside the registry.
    fn telemetry_path(&self) -> PathBuf {
        self.registry.with_file_name(crate::telemetry::FILE_NAME)
    }

    /// The file launchd gives the watch for standard output and standard
    /// error, which holds what the watch prints before it opens its log.
    fn launchd_log(&self) -> PathBuf {
        self.log.with_file_name(crate::logfile::LAUNCHD_NAME)
    }

    /// Made before launchd starts the watch, which would make it readable by
    /// others, in a directory launchd does not make.
    fn make_launchd_log(&self) -> Result<(), CliError> {
        let path = self.launchd_log();
        let failed = |error: std::io::Error| {
            CliError::Io(std::io::Error::new(
                error.kind(),
                format!("cannot make {}: {error}", path.display()),
            ))
        };
        if let Some(parent) = path.parent() {
            std::fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(parent)
                .map_err(failed)?;
        }
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .mode(0o600)
            .open(&path)
            .map(drop)
            .map_err(failed)
    }

    fn arguments(&self) -> Result<Vec<&str>, CliError> {
        let mut arguments = vec![text(&self.binary)?, "folders", "watch"];
        if let Some(key_file) = &self.key_file {
            arguments.extend(["--key-file", text(key_file)?]);
        }
        arguments.extend([crate::new_build::FLAG, "--log", text(&self.log)?]);
        Ok(arguments)
    }

    fn render(&self, manager: Manager) -> Result<String, CliError> {
        match manager {
            Manager::Launchd => self.plist(),
            Manager::Systemd => self.unit(),
        }
    }

    /// Avoid `Background` process-wide throttling: it can starve the watch's
    /// utility-QoS threads when every core is busy.
    fn plist(&self) -> Result<String, CliError> {
        let arguments = self
            .arguments()?
            .iter()
            .map(|argument| format!("\t\t<string>{}</string>\n", xml(argument)))
            .collect::<String>();
        Ok(format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">
<plist version=\"1.0\">
<dict>
\t<key>Label</key>
\t<string>{LABEL}</string>
\t<key>ProgramArguments</key>
\t<array>
{arguments}\t</array>
\t<key>EnvironmentVariables</key>
\t<dict>
\t\t<key>{registry_env}</key>
\t\t<string>{registry}</string>{telemetry}
\t</dict>
\t<key>StandardOutPath</key>
\t<string>{launchd_log}</string>
\t<key>StandardErrorPath</key>
\t<string>{launchd_log}</string>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<dict>
\t\t<key>SuccessfulExit</key>
\t\t<false/>
\t</dict>
\t<key>ThrottleInterval</key>
\t<integer>{RESTART_SECONDS}</integer>
\t<key>Nice</key>
\t<integer>{NICE}</integer>
\t<key>LowPriorityIO</key>
\t<true/>
</dict>
</plist>
",
            registry_env = marfa_core::folder::REGISTRY_ENV,
            registry = xml(text(&self.registry)?),
            telemetry = match &self.telemetry_file {
                Some(file) => format!(
                    "\n\t\t<key>{}</key>\n\t\t<string>{}</string>",
                    crate::telemetry::FILE_ENV,
                    xml(text(file)?)
                ),
                None => String::new(),
            },
            launchd_log = xml(text(&self.launchd_log())?),
        ))
    }

    fn unit(&self) -> Result<String, CliError> {
        let exec = self
            .arguments()?
            .iter()
            .map(|argument| quoted(argument, true))
            .collect::<Vec<_>>()
            .join(" ");
        let mut environment = quoted(
            &format!(
                "{}={}",
                marfa_core::folder::REGISTRY_ENV,
                text(&self.registry)?
            ),
            false,
        );
        if let Some(file) = &self.telemetry_file {
            environment.push(' ');
            environment.push_str(&quoted(
                &format!("{}={}", crate::telemetry::FILE_ENV, text(file)?),
                false,
            ));
        }
        Ok(format!(
            "[Unit]
Description=Marfa folder sync: marfa folders watch over every folder

[Service]
Type=simple
ExecStart={exec}
Environment={environment}
Restart=on-failure
RestartSec={RESTART_SECONDS}
Nice={NICE}
IOSchedulingClass=best-effort
IOSchedulingPriority={IO_PRIORITY}

[Install]
WantedBy=default.target
"
        ))
    }

    fn read(manager: Manager, written: &str) -> Option<Agent> {
        let (mut arguments, registry, telemetry_file) = match manager {
            Manager::Launchd => (
                plist_strings(after(written, "<key>ProgramArguments</key>")?, "</array>")?,
                // A string never holds a bare `<`, so the key is found only as one.
                plist_strings(
                    after(
                        written,
                        &format!("<key>{}</key>", marfa_core::folder::REGISTRY_ENV),
                    )?,
                    "</dict>",
                )?
                .into_iter()
                .next(),
                after(
                    written,
                    &format!("<key>{}</key>", crate::telemetry::FILE_ENV),
                )
                .and_then(|rest| plist_strings(rest, "</dict>"))
                .and_then(|strings| strings.into_iter().next()),
            ),
            Manager::Systemd => {
                let environment = unquoted(line_value(written, "Environment=")?)?;
                let of = |name: &str| {
                    environment
                        .iter()
                        .find_map(|pair| pair.strip_prefix(&format!("{name}=")).map(str::to_string))
                };
                (
                    unquoted(line_value(written, "ExecStart=")?)?,
                    of(marfa_core::folder::REGISTRY_ENV),
                    of(crate::telemetry::FILE_ENV),
                )
            }
        };
        // An agent whose watch does not end for a new build is still read as
        // the agent it is, so `status` says it is one `on` replaces.
        if let Some(at) = arguments
            .iter()
            .position(|argument| argument == crate::new_build::FLAG)
        {
            arguments.remove(at);
        }
        let (binary, key_file, log) = match arguments.as_slice() {
            [binary, folders, watch, flag, log]
                if folders == "folders" && watch == "watch" && flag == "--log" =>
            {
                (binary, None, log)
            }
            [binary, folders, watch, keyed, key_file, flag, log]
                if folders == "folders"
                    && watch == "watch"
                    && keyed == "--key-file"
                    && flag == "--log" =>
            {
                (binary, Some(PathBuf::from(key_file)), log)
            }
            _ => return None,
        };
        Some(Agent {
            binary: binary.into(),
            log: log.into(),
            registry: registry?.into(),
            key_file,
            telemetry_file: telemetry_file.map(PathBuf::from),
        })
    }
}

/// Whether `written` is an agent this command wrote and would not write now,
/// as one written by an earlier build is.
fn outdated(manager: Manager, written: &str) -> bool {
    Agent::read(manager, written)
        .and_then(|agent| agent.render(manager).ok())
        .is_some_and(|wanted| wanted != written)
}

/// The one file an installed property list gives the watch's standard output
/// and standard error, which an agent written before the output was named
/// does not have. Not the file `on` would name now, so `status` does not
/// promise output to a file the agent will not write.
fn launchd_log_of(written: &str) -> Option<PathBuf> {
    let named = |key: &str| {
        let value = after(written, &format!("<key>{key}</key>"))?
            .trim_start()
            .strip_prefix("<string>")?;
        Some(PathBuf::from(unxml(&value[..value.find("</string>")?])))
    };
    let out = named("StandardOutPath")?;
    (named("StandardErrorPath")? == out).then_some(out)
}

/// The path the binary was run by, where it leads to the binary running:
/// Linux gives `current_exe` with links resolved, and a link such as a
/// package manager's survives an upgrade that replaces what it leads to.
pub(crate) fn invoked(
    argv0: Option<&std::ffi::OsStr>,
    path: Option<&std::ffi::OsStr>,
    cwd: &Path,
    exe: &Path,
) -> PathBuf {
    let found = argv0.and_then(|argv0| {
        if Path::new(argv0).components().count() > 1 {
            return Some(cwd.join(argv0));
        }
        std::env::split_paths(path?)
            .map(|dir| cwd.join(dir).join(argv0))
            .find(|candidate| candidate.is_file())
    });
    let leads_here = |candidate: &PathBuf| {
        std::fs::canonicalize(candidate).ok() == std::fs::canonicalize(exe).ok()
    };
    match found.filter(leads_here) {
        Some(found) => std::path::absolute(&found).unwrap_or(found),
        None => exe.to_path_buf(),
    }
}

/// A path the agent's file can carry: text with no control character, which
/// neither a property list nor a unit file can hold.
pub(crate) fn text(path: &Path) -> Result<&str, CliError> {
    path.to_str()
        .filter(|text| !text.chars().any(char::is_control))
        .ok_or_else(|| {
            CliError::Invalid(format!(
                "{} is not a path a service manager's file can carry: it is not UTF-8 or holds a control character",
                path.display()
            ))
        })
}

pub(crate) fn xml(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn unxml(text: &str) -> String {
    text.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

fn after<'a>(text: &'a str, marker: &str) -> Option<&'a str> {
    text.find(marker).map(|at| &text[at + marker.len()..])
}

/// The `<string>` values from here to `end`.
fn plist_strings(mut text: &str, end: &str) -> Option<Vec<String>> {
    let stop = text.find(end)?;
    text = &text[..stop];
    let mut strings = Vec::new();
    while let Some(rest) = after(text, "<string>") {
        let close = rest.find("</string>")?;
        strings.push(unxml(&rest[..close]));
        text = &rest[close..];
    }
    Some(strings)
}

fn line_value<'a>(text: &'a str, key: &str) -> Option<&'a str> {
    text.lines().find_map(|line| line.strip_prefix(key))
}

/// One word of a unit file, quoted so that systemd reads it back as written:
/// `%` starts a specifier anywhere, and `$` a variable on a command line.
pub(crate) fn quoted(word: &str, command: bool) -> String {
    let mut out = String::from("\"");
    for character in word.chars() {
        match character {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '%' => out.push_str("%%"),
            '$' if command => out.push_str("$$"),
            other => out.push(other),
        }
    }
    out.push('"');
    out
}

/// The words of a line written by [`quoted`], or `None` for any other.
fn unquoted(line: &str) -> Option<Vec<String>> {
    let mut words = Vec::new();
    let mut characters = line.trim().chars().peekable();
    while let Some(character) = characters.next() {
        match character {
            ' ' => continue,
            '"' => {}
            _ => return None,
        }
        let mut word = String::new();
        loop {
            match characters.next()? {
                '"' => break,
                '\\' => word.push(characters.next()?),
                '%' if characters.next_if_eq(&'%').is_some() => word.push('%'),
                '$' if characters.next_if_eq(&'$').is_some() => word.push('$'),
                other => word.push(other),
            }
        }
        words.push(word);
    }
    Some(words)
}

/// Where the agent goes and the tool that loads it.
struct Place {
    manager: Manager,
    file: PathBuf,
    tool: PathBuf,
}

impl Place {
    fn here() -> Result<Place, CliError> {
        let manager = Manager::here().ok_or_else(|| {
            CliError::Invalid(format!(
                "folders sync on Apple platforms and Linux only, and this system is {}",
                std::env::consts::OS
            ))
        })?;
        let named_root = std::env::var_os(ROOT_ENV).filter(|root| !root.is_empty());
        let stand_in = named_root.is_some();
        let (home, tool) = match named_root {
            Some(root) => {
                let root = PathBuf::from(root);
                if !root.is_absolute() {
                    return Err(CliError::Usage(format!(
                        "{ROOT_ENV} names {}, which is not an absolute path",
                        root.display()
                    )));
                }
                let tool = root.join("bin").join(match manager {
                    Manager::Launchd => "launchctl",
                    Manager::Systemd => "systemctl",
                });
                (root, tool)
            }
            None => {
                let home = std::env::var_os("HOME")
                    .filter(|home| !home.is_empty())
                    .map(PathBuf::from)
                    .ok_or_else(|| {
                        CliError::Invalid(
                            "HOME is not set, so there is no account to start folder syncing in"
                                .into(),
                        )
                    })?;
                let tool = PathBuf::from(match manager {
                    Manager::Launchd => "/bin/launchctl",
                    Manager::Systemd => "systemctl",
                });
                (home, tool)
            }
        };
        let file = match manager {
            Manager::Launchd => home
                .join("Library")
                .join("LaunchAgents")
                .join(format!("{LABEL}.plist")),
            Manager::Systemd => {
                // systemd reads a user's units from XDG_CONFIG_HOME where it is
                // set; a stand-in home keeps everything below it.
                let config = std::env::var_os("XDG_CONFIG_HOME")
                    .filter(|config| !config.is_empty() && !stand_in)
                    .map(PathBuf::from)
                    .unwrap_or_else(|| home.join(".config"));
                config.join("systemd").join("user").join(UNIT)
            }
        };
        Ok(Place {
            manager,
            file,
            tool,
        })
    }

    /// The launchd domain of the person's login session.
    fn domain() -> String {
        // SAFETY: `getuid` cannot fail.
        format!("gui/{}", unsafe { libc::getuid() })
    }

    fn target() -> String {
        format!("{}/{LABEL}", Place::domain())
    }

    fn command(&self, arguments: &[&str]) -> Command {
        let mut command = Command::new(&self.tool);
        if self.manager == Manager::Systemd {
            command.arg("--user");
        }
        command.args(arguments);
        command
    }

    /// Runs the tool and refuses on a failure, with what it said.
    fn must(&self, arguments: &[&str]) -> Result<(), CliError> {
        let ran = self.ran(arguments)?;
        if ran.status.success() {
            return Ok(());
        }
        Err(CliError::Io(std::io::Error::other(format!(
            "{} failed ({}): {}",
            self.shown(arguments),
            ran.status,
            said(&ran)
        ))))
    }

    fn ran(&self, arguments: &[&str]) -> Result<std::process::Output, CliError> {
        self.command(arguments).output().map_err(|error| {
            CliError::Io(std::io::Error::new(
                error.kind(),
                format!("could not run {}: {error}", self.shown(arguments)),
            ))
        })
    }

    fn shown(&self, arguments: &[&str]) -> String {
        let mut words = vec![self.tool.display().to_string()];
        if self.manager == Manager::Systemd {
            words.push("--user".into());
        }
        words.extend(arguments.iter().map(|argument| argument.to_string()));
        words.join(" ")
    }

    /// What the service manager says of the agent now.
    fn state(&self) -> Result<State, String> {
        match self.manager {
            Manager::Launchd => {
                let ran = self
                    .ran(&["print", &Place::target()])
                    .map_err(|error| error.to_string())?;
                match ran.status.code() {
                    Some(0) => Ok(launchd_state(&String::from_utf8_lossy(&ran.stdout))),
                    // launchctl's own word for a service it does not hold.
                    Some(113) => Ok(State::default()),
                    _ => Err(format!(
                        "{} failed ({}): {}",
                        self.shown(&["print", &Place::target()]),
                        ran.status,
                        said(&ran)
                    )),
                }
            }
            Manager::Systemd => {
                let arguments = [
                    "show",
                    UNIT,
                    "--property=LoadState,ActiveState,SubState,MainPID,ExecMainStatus,UnitFileState,NeedDaemonReload",
                ];
                let ran = self.ran(&arguments).map_err(|error| error.to_string())?;
                if !ran.status.success() {
                    return Err(format!(
                        "{} failed ({}): {}",
                        self.shown(&arguments),
                        ran.status,
                        said(&ran)
                    ));
                }
                Ok(systemd_state(&String::from_utf8_lossy(&ran.stdout)))
            }
        }
    }

    /// Unloads the agent and waits until launchd no longer holds it, since a
    /// load straight after an unload can find the old one still there.
    fn bootout(&self) -> Result<(), CliError> {
        self.must(&["bootout", &Place::target()])?;
        let started = Instant::now();
        while started.elapsed() < UNLOAD_WAIT {
            if self.state().is_ok_and(|state| !state.loaded) {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        Err(CliError::Io(std::io::Error::other(format!(
            "launchd still holds {LABEL} {} seconds after it was unloaded",
            UNLOAD_WAIT.as_secs()
        ))))
    }
}

/// Starts the installed watch again where a credential kept for `origin` can
/// reach it: the agent reads the keychain, and lists a folder that follows it.
/// Whether it did is returned.
fn resume(
    place: &Place,
    origin: &str,
    follows: impl FnOnce(&Path, &str) -> bool,
) -> Result<bool, CliError> {
    let Some(written) = read_file(&place.file)? else {
        return Ok(false);
    };
    let Some(agent) = Agent::read(place.manager, &written) else {
        return Ok(false);
    };
    if agent.key_file.is_some() || !follows(&agent.registry, origin) {
        return Ok(false);
    }
    let state = place
        .state()
        .map_err(|reason| CliError::Io(std::io::Error::other(reason)))?;
    if !state.loaded {
        return Ok(false);
    }
    match place.manager {
        Manager::Launchd => place.must(&["kickstart", "-k", &Place::target()])?,
        Manager::Systemd => place.must(&["restart", UNIT])?,
    }
    Ok(true)
}

/// Starts the installed watch again after a credential is kept for `origin`,
/// and says on stderr that it did, or why it could not.
pub fn resume_after_credential_kept(origin: &str) {
    let follows = |registry: &Path, origin: &str| {
        marfa_core::folder::follows(&Registry::at(registry), origin)
    };
    match Place::here().and_then(|place| resume(&place, origin, follows).map(|ran| (place, ran))) {
        Ok((place, true)) => crate::errln!(
            "restarted {}, so the folder watch uses this credential",
            place.manager.name()
        ),
        Ok((_, false)) => {}
        Err(error) => crate::errln!(
            "the credential is kept, but the folder watch could not be restarted ({error}); `marfa folders autostart on` starts it"
        ),
    }
}

fn said(ran: &std::process::Output) -> String {
    let text = String::from_utf8_lossy(&ran.stderr).trim().to_string();
    if text.is_empty() {
        String::from_utf8_lossy(&ran.stdout).trim().to_string()
    } else {
        text
    }
}

/// What a service manager says of the agent.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
struct State {
    loaded: bool,
    running: bool,
    pid: Option<u32>,
    /// The exit status the watch last ended with, where the manager keeps it.
    last_exit: Option<i32>,
    /// Whether it starts at login: systemd says; launchd loads every agent in
    /// the person's `LaunchAgents` at login.
    enabled: Option<bool>,
    /// Whether systemd runs the unit as it was before its file last changed.
    #[serde(skip)]
    reload: Option<bool>,
}

/// From `launchctl print`, whose first `state`, `pid` and `last exit code`
/// lines are the service's own.
fn launchd_state(printed: &str) -> State {
    let value = |key: &str| {
        printed.lines().find_map(|line| {
            line.trim()
                .strip_prefix(key)
                .and_then(|rest| rest.trim_start().strip_prefix('='))
                .map(str::trim)
        })
    };
    let running = value("state") == Some("running");
    State {
        loaded: true,
        running,
        pid: value("pid")
            .and_then(|pid| pid.parse().ok())
            .filter(|_| running),
        // Such as `78: EX_CONFIG`.
        last_exit: value("last exit code")
            .and_then(|code| code.split(':').next()?.trim().parse().ok()),
        enabled: None,
        reload: None,
    }
}

/// From `systemctl show`'s `KEY=value` lines.
fn systemd_state(shown: &str) -> State {
    let value = |key: &str| {
        shown
            .lines()
            .find_map(|line| line.strip_prefix(key)?.strip_prefix('='))
    };
    let running = value("ActiveState") == Some("active") && value("SubState") == Some("running");
    State {
        loaded: value("LoadState") == Some("loaded"),
        running,
        pid: value("MainPID")
            .and_then(|pid| pid.parse().ok())
            .filter(|pid| *pid > 0 && running),
        last_exit: value("ExecMainStatus").and_then(|code| code.parse().ok()),
        enabled: value("UnitFileState").map(|state| state == "enabled"),
        reload: value("NeedDaemonReload").map(|reload| reload == "yes"),
    }
}

fn read_file(path: &Path) -> Result<Option<String>, CliError> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(CliError::Io(std::io::Error::new(
            error.kind(),
            format!("cannot read {}: {error}", path.display()),
        ))),
    }
}

/// Written whole in one step, so the manager never reads half a file. Not
/// writable by others, which launchd refuses.
fn write_file(path: &Path, text: &str) -> Result<(), CliError> {
    let failed = |error: std::io::Error| {
        CliError::Io(std::io::Error::new(
            error.kind(),
            format!("cannot write {}: {error}", path.display()),
        ))
    };
    let parent = path
        .parent()
        .ok_or_else(|| CliError::Invalid(format!("{} has no directory", path.display())))?;
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o755)
        .create(parent)
        .map_err(failed)?;
    let mut name = path.as_os_str().to_owned();
    name.push(format!(".{}.tmp", std::process::id()));
    let temporary = PathBuf::from(name);
    let written = (|| {
        let mut file = std::fs::File::create(&temporary)?;
        file.set_permissions(std::fs::Permissions::from_mode(0o644))?;
        file.write_all(text.as_bytes())?;
        file.sync_all()?;
        std::fs::rename(&temporary, path)
    })();
    if written.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    written.map_err(failed)
}

/// The telemetry file, written whole in one step and for its owner alone from
/// the moment it exists: it can hold a credential.
fn write_private(path: &Path, text: &str) -> Result<(), CliError> {
    let failed = |error: std::io::Error| {
        CliError::Io(std::io::Error::new(
            error.kind(),
            format!("cannot write {}: {error}", path.display()),
        ))
    };
    let parent = path
        .parent()
        .ok_or_else(|| CliError::Invalid(format!("{} has no directory", path.display())))?;
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(parent)
        .map_err(failed)?;
    let mut name = path.as_os_str().to_owned();
    name.push(format!(".{}.tmp", std::process::id()));
    let temporary = PathBuf::from(name);
    let written = (|| {
        let _ = std::fs::remove_file(&temporary);
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temporary)?;
        file.write_all(text.as_bytes())?;
        file.sync_all()?;
        std::fs::rename(&temporary, path)
    })();
    if written.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    written.map_err(failed)
}

#[derive(Serialize)]
struct Switched {
    autostart: &'static str,
    /// Whether this run changed anything.
    changed: bool,
    manager: Manager,
    name: &'static str,
    file: PathBuf,
    #[serde(skip_serializing_if = "Option::is_none")]
    binary: Option<PathBuf>,
    #[serde(skip_serializing_if = "Option::is_none")]
    log: Option<PathBuf>,
    /// Where launchd writes the watch's own output, which a systemd user unit
    /// has none of: the journal keeps it.
    #[serde(skip_serializing_if = "Option::is_none")]
    launchd_log: Option<PathBuf>,
    #[serde(skip_serializing_if = "Option::is_none")]
    registry: Option<PathBuf>,
    #[serde(skip_serializing_if = "Option::is_none")]
    key_file: Option<PathBuf>,
    /// The telemetry settings the watch carries, by name and never by value:
    /// none for an empty list. Absent from `off`.
    #[serde(skip_serializing_if = "Option::is_none")]
    telemetry: Option<Vec<&'static str>>,
    /// The file that holds their values, where any are carried.
    #[serde(skip_serializing_if = "Option::is_none")]
    telemetry_file: Option<PathBuf>,
    #[serde(skip_serializing_if = "Option::is_none")]
    running: Option<bool>,
}

fn on(place: &Place, key_file: Option<&Path>, json: bool) -> Result<(), CliError> {
    let mut agent = Agent::for_this_binary()?;
    if let Some(key_file) = key_file {
        // Refused before anything is written, so a file the watch could not
        // use is found now and not at the next login.
        let path = crate::keyfile::placed(key_file, None)?;
        crate::keyfile::read(&path)?;
        agent.key_file = Some(path);
    }
    let carried = crate::telemetry::carry(&|name| std::env::var(name).ok()).map_err(|name| {
        CliError::Invalid(format!(
            "{name} holds a control character, which the watch's telemetry file cannot carry, so nothing was written"
        ))
    })?;
    let telemetry_path = agent.telemetry_path();
    if carried.content.is_some() {
        agent.telemetry_file = Some(telemetry_path.clone());
    }
    // Settings are written before the agent names them, and removed after the
    // agent stops naming them, so the agent never names a file that is not
    // there. Both wait until the watch has been let go of, so a failure leaves
    // the next `on` to try again.
    let settle_before = || match &carried.content {
        Some(content) => write_private(&telemetry_path, content),
        None => Ok(()),
    };
    let settle_after = || match &carried.content {
        Some(_) => Ok(()),
        None => remove(&telemetry_path),
    };
    let wanted = agent.render(place.manager)?;
    let changed = read_file(&place.file)?.as_deref() != Some(wanted.as_str())
        || !telemetry_file_is(&telemetry_path, carried.content.as_deref())?;
    let state = place
        .state()
        .map_err(|reason| CliError::Io(std::io::Error::other(reason)))?;
    let started = match place.manager {
        Manager::Launchd => {
            let loaded = state.loaded;
            agent.make_launchd_log()?;
            // Let go of the old agent before the file changes, so a failure
            // leaves the file differing and the next `on` tries again.
            if changed {
                if loaded {
                    place.bootout()?;
                }
                settle_before()?;
                write_file(&place.file, &wanted)?;
                settle_after()?;
            }
            if changed || !loaded {
                // An agent the person disabled is not loaded until enabled.
                place.must(&["enable", &Place::target()])?;
                place.must(&["bootstrap", &Place::domain(), text(&place.file)?])?;
            }
            changed || !loaded
        }
        Manager::Systemd => {
            // A file written by an `on` that failed before systemd read it.
            let changed = changed || state.reload == Some(true);
            if changed {
                settle_before()?;
                write_file(&place.file, &wanted)?;
                settle_after()?;
                place.must(&["daemon-reload"])?;
                place.must(&["enable", UNIT])?;
                place.must(&["restart", UNIT])?;
            } else {
                place.must(&["enable", "--now", UNIT])?;
            }
            changed
        }
    };
    let running = place.state().ok().map(|state| state.running);
    let report = Switched {
        autostart: "on",
        changed: changed || started,
        manager: place.manager,
        name: place.manager.name(),
        file: place.file.clone(),
        binary: Some(agent.binary.clone()),
        log: Some(agent.log.clone()),
        launchd_log: (place.manager == Manager::Launchd).then(|| agent.launchd_log()),
        registry: Some(agent.registry.clone()),
        key_file: agent.key_file.clone(),
        telemetry: Some(carried.names.clone()),
        telemetry_file: agent.telemetry_file.clone(),
        running,
    };
    output::report(&report, json, || {
        let mut lines = vec![if report.changed {
            format!(
                "folders now sync from login: wrote {} ({} {}) and started it",
                place.file.display(),
                place.manager.kind(),
                place.manager.name()
            )
        } else {
            format!(
                "folders already sync from login: {} is unchanged",
                place.file.display()
            )
        }];
        lines.push(format!(
            "it runs {} folders watch, over every folder {} lists",
            agent.binary.display(),
            agent.registry.display()
        ));
        lines.push(format!("it logs to {}", agent.log.display()));
        if let Some(launchd_log) = &report.launchd_log {
            lines.push(format!(
                "what it prints before it opens that log goes to {}",
                launchd_log.display()
            ));
        }
        if let Some(key_file) = &agent.key_file {
            lines.push(format!(
                "it takes its server and key from {}, and reads the keychain for no folder",
                key_file.display()
            ));
        }
        match &agent.telemetry_file {
            Some(file) => lines.push(format!(
                "it carries these telemetry settings from this shell, in {} which only you can read: {}",
                file.display(),
                carried.names.join(", ")
            )),
            None => lines.push(
                "it carries no telemetry settings: none is set in this shell, so the watch sends no error reports or traces".into(),
            ),
        }
        if running == Some(false) {
            lines.push(
                "the watch is not running yet: `marfa folders autostart status` says why".into(),
            );
        }
        if agent.key_file.is_none()
            && ["MARFA_API_KEY", "MARFA_API_URL", "MARFA_PROFILE"]
                .iter()
                .any(|name| std::env::var_os(name).is_some_and(|value| !value.is_empty()))
        {
            lines.push(
                "the watch reads no MARFA_API_KEY, MARFA_API_URL or MARFA_PROFILE: each folder uses the credential the keychain keeps for its server".into(),
            );
        }
        lines.join("\n")
    })
}

fn off(place: &Place, json: bool) -> Result<(), CliError> {
    let existed = place.file.exists();
    // The file of telemetry settings can hold a credential, so it goes with
    // the agent: the one the agent names, or where `on` would put it.
    let telemetry_path = read_file(&place.file)?
        .and_then(|written| Agent::read(place.manager, &written))
        .and_then(|agent| agent.telemetry_file)
        .or_else(|| {
            Agent::for_this_binary()
                .ok()
                .map(|agent| agent.telemetry_path())
        });
    // The file goes whatever came of stopping the watch, so that the watch
    // never starts at login again, even where the manager cannot be asked.
    let stopping = match (place.state(), place.manager) {
        (Err(reason), _) => Err(CliError::Io(std::io::Error::other(reason))),
        (Ok(state), Manager::Launchd) if state.loaded => place.bootout().map(|()| true),
        (Ok(state), Manager::Systemd) if existed => place
            .must(&["disable", "--now", UNIT])
            .map(|()| state.running),
        (Ok(state), Manager::Systemd) if state.running => {
            place.must(&["stop", UNIT]).map(|()| true)
        }
        (Ok(_), _) => Ok(false),
    };
    // The agent goes first, and a failure to remove the settings is returned
    // only once it has, so the watch never starts at login with a file kept.
    let agent_removed = if existed { remove(&place.file) } else { Ok(()) };
    let settings_removed = telemetry_path.as_deref().map_or(Ok(()), remove);
    if existed {
        agent_removed?;
        if place.manager == Manager::Systemd {
            match &stopping {
                Ok(_) => place.must(&["daemon-reload"])?,
                Err(_) => {
                    let _ = place.ran(&["daemon-reload"]);
                }
            }
        }
    }
    settings_removed?;
    let stopped = stopping.map_err(|error| {
        CliError::Io(std::io::Error::other(format!(
            "{}could not stop {}: {error}; the watch may run until it ends or you sign out",
            if existed {
                format!(
                    "removed {}, so folders no longer sync from login, but ",
                    place.file.display()
                )
            } else {
                String::new()
            },
            place.manager.name()
        )))
    })?;
    let report = Switched {
        autostart: "off",
        changed: existed || stopped,
        manager: place.manager,
        name: place.manager.name(),
        file: place.file.clone(),
        binary: None,
        log: None,
        launchd_log: None,
        registry: None,
        key_file: None,
        telemetry: None,
        telemetry_file: None,
        running: None,
    };
    output::report(&report, json, || {
        if report.changed {
            format!(
                "folders no longer sync from login: stopped {} and removed {}",
                place.manager.name(),
                place.file.display()
            )
        } else {
            format!(
                "folders already do not sync from login: there is no {}",
                place.file.display()
            )
        }
    })
}

/// Whether the telemetry file is what `on` would make: absent where nothing is
/// carried, and otherwise a regular file of the person's own that only they
/// can access, holding the text. A link, another owner or a looser mode is
/// not, so that `on` makes it right.
fn telemetry_file_is(path: &Path, content: Option<&str>) -> Result<bool, CliError> {
    use std::os::unix::fs::MetadataExt as _;
    let meta = match std::fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(content.is_none());
        }
        Err(error) => {
            return Err(CliError::Io(std::io::Error::new(
                error.kind(),
                format!("cannot read {}: {error}", path.display()),
            )));
        }
    };
    let Some(content) = content else {
        return Ok(false);
    };
    // SAFETY: `geteuid` cannot fail.
    let mine = unsafe { libc::geteuid() };
    Ok(meta.is_file()
        && meta.uid() == mine
        && meta.mode() & 0o077 == 0
        && read_file(path)?.as_deref() == Some(content))
}

fn remove(path: &Path) -> Result<(), CliError> {
    match std::fs::remove_file(path) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
            Err(CliError::Io(std::io::Error::new(
                error.kind(),
                format!("cannot remove {}: {error}", path.display()),
            )))
        }
        _ => Ok(()),
    }
}

#[derive(Serialize)]
struct Status {
    installed: bool,
    manager: Manager,
    name: &'static str,
    file: PathBuf,
    /// `None` where the service manager could not be asked.
    #[serde(flatten)]
    state: Option<State>,
    #[serde(skip_serializing_if = "Option::is_none")]
    manager_error: Option<String>,
    /// Whether the installed file is one `on` wrote but would not write now,
    /// as one from an earlier build is.
    outdated: bool,
    /// What the installed file runs; `None` where it is not one `on` writes.
    binary: Option<Binary>,
    log: Option<PathBuf>,
    /// The file the installed launchd agent names for what the watch prints
    /// before it opens its log; none for a systemd user unit, whose journal
    /// keeps it, and for an agent written before the output was named.
    launchd_log: Option<PathBuf>,
    registry: Option<PathBuf>,
    /// The file the watch takes its server and key from, or none where it
    /// uses the keychain.
    key_file: Option<PathBuf>,
    record: Option<RecordView>,
    /// The folders the watch has no credential it can use for.
    credential: Vec<String>,
}

#[derive(Serialize)]
struct Binary {
    path: PathBuf,
    exists: bool,
    /// Whether it is the binary that runs this command, links followed.
    this_binary: bool,
}

#[derive(Serialize)]
struct RecordView {
    path: PathBuf,
    /// Whether the record holds a current entry for the running watch.
    current: bool,
    /// The folders of that entry, or none.
    folders: Vec<Watched>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct Watched {
    pub(crate) dir: String,
    pub(crate) watching: bool,
    pub(crate) reason: Option<String>,
}

/// The parts of `folder-watch.json` this program reads.
#[derive(Deserialize)]
pub(crate) struct RecordFile {
    pub(crate) processes: Vec<RecordProcess>,
}

#[derive(Deserialize)]
pub(crate) struct RecordProcess {
    pub(crate) pid: u32,
    #[serde(default)]
    pub(crate) build_version: Option<String>,
    heartbeat_at: String,
    heartbeat_interval_seconds: u64,
    ended_at: Option<String>,
    pub(crate) folders: Vec<Watched>,
}

impl RecordFile {
    pub(crate) fn read(path: &Path) -> Option<RecordFile> {
        std::fs::read(path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
    }
}

impl RecordProcess {
    /// The rule `FOLDER-WATCH-RECORD.md` gives a reader.
    pub(crate) fn current(&self, now: SystemTime) -> bool {
        let Ok(beat) = chrono::DateTime::parse_from_rfc3339(&self.heartbeat_at) else {
            return false;
        };
        let Ok(beat) = u64::try_from(beat.timestamp_millis()) else {
            return false;
        };
        let beat = SystemTime::UNIX_EPOCH + Duration::from_millis(beat);
        self.ended_at.is_none()
            && now.duration_since(beat).is_ok_and(|age| {
                age < Duration::from_secs(self.heartbeat_interval_seconds.saturating_mul(3))
            })
    }
}

fn status(place: &Place, json: bool) -> Result<(), CliError> {
    let installed = read_file(&place.file)?;
    let (state, manager_error) = match place.state() {
        Ok(state) => (Some(state), None),
        Err(reason) => (None, Some(reason)),
    };
    let agent = installed
        .as_deref()
        .and_then(|written| Agent::read(place.manager, written));
    let this = std::env::current_exe().and_then(std::fs::canonicalize).ok();
    let binary = agent.as_ref().map(|agent| Binary {
        exists: agent.binary.is_file(),
        this_binary: this.is_some() && std::fs::canonicalize(&agent.binary).ok() == this,
        path: agent.binary.clone(),
    });
    let pid = state.as_ref().and_then(|state| state.pid);
    let record = agent.as_ref().map(|agent| {
        let path = WatchRecord::beside(&Registry::at(&agent.registry))
            .path()
            .to_path_buf();
        let entry = RecordFile::read(&path).and_then(|file| {
            file.processes
                .into_iter()
                .find(|process| Some(process.pid) == pid)
        });
        let current = entry
            .as_ref()
            .is_some_and(|entry| entry.current(SystemTime::now()));
        RecordView {
            path,
            current,
            folders: entry.map(|entry| entry.folders).unwrap_or_default(),
        }
    });
    let credential = record
        .iter()
        .filter(|record| record.current)
        .flat_map(|record| &record.folders)
        .filter(|folder| {
            !folder.watching
                && folder
                    .reason
                    .as_deref()
                    .is_some_and(|reason| CREDENTIAL_REASONS.contains(&reason))
        })
        .map(|folder| folder.dir.clone())
        .collect();
    let report = Status {
        installed: installed.is_some(),
        manager: place.manager,
        name: place.manager.name(),
        file: place.file.clone(),
        state,
        manager_error,
        outdated: installed
            .as_deref()
            .is_some_and(|written| outdated(place.manager, written)),
        binary,
        log: agent.as_ref().map(|agent| agent.log.clone()),
        launchd_log: installed
            .as_deref()
            .filter(|_| agent.is_some() && place.manager == Manager::Launchd)
            .and_then(launchd_log_of),
        registry: agent.as_ref().map(|agent| agent.registry.clone()),
        key_file: agent.as_ref().and_then(|agent| agent.key_file.clone()),
        record,
        credential,
    };
    output::report(&report, json, || describe_status(place, &report))
}

fn describe_status(place: &Place, report: &Status) -> String {
    let mut lines = Vec::new();
    if !report.installed {
        lines.push(format!(
            "folders do not sync from login: there is no {}; `marfa folders autostart on` turns it on",
            report.file.display()
        ));
        if report.state.as_ref().is_some_and(|state| state.running) {
            lines.push(format!(
                "{} is still running: `marfa folders autostart off` stops it",
                report.name
            ));
        }
        return lines.join("\n");
    }
    lines.push(format!(
        "folders sync from login: {} ({} {})",
        report.file.display(),
        place.manager.kind(),
        report.name
    ));
    match (&report.state, &report.manager_error) {
        (Some(state), _) if state.running => lines.push(match state.pid {
            Some(pid) => format!("the watch is running, as process {pid}"),
            None => "the watch is running".into(),
        }),
        (Some(state), _) if !state.loaded => lines.push(
            "the watch is not running: the service manager has not loaded it; `marfa folders autostart on` loads it".into(),
        ),
        (Some(state), _) => lines.push(match state.last_exit {
            Some(code) if code != 0 => format!(
                "the watch is not running: it last ended with status {code}, and is started again after {RESTART_SECONDS} seconds; the log says why"
            ),
            _ => "the watch is not running".into(),
        }),
        (None, Some(reason)) => lines.push(format!("cannot tell whether the watch runs: {reason}")),
        (None, None) => {}
    }
    if report.state.as_ref().and_then(|state| state.enabled) == Some(false) {
        lines.push(format!(
            "{UNIT} is not enabled, so it does not start at login; `marfa folders autostart on` enables it"
        ));
    }
    if report.outdated {
        lines.push(format!(
            "{} was written by an earlier marfa and differs from what `marfa folders autostart on` writes now; run `marfa folders autostart on` again with the same options to replace it",
            report.file.display()
        ));
    }
    let Some(binary) = &report.binary else {
        lines.push(format!(
            "{} is not as `marfa folders autostart on` writes it; run that to replace it",
            report.file.display()
        ));
        return lines.join("\n");
    };
    lines.push(if !binary.exists {
        format!(
            "it runs {}, which no longer exists: run `marfa folders autostart on` with the marfa you use now",
            binary.path.display()
        )
    } else if !binary.this_binary {
        format!(
            "it runs {}, which is not this marfa: run `marfa folders autostart on` with this one to switch",
            binary.path.display()
        )
    } else {
        format!("it runs {}", binary.path.display())
    });
    if let Some(log) = &report.log {
        lines.push(format!("it logs to {}", log.display()));
    }
    if let Some(launchd_log) = &report.launchd_log {
        lines.push(format!(
            "what it prints before it opens that log goes to {}",
            launchd_log.display()
        ));
    } else if place.manager == Manager::Launchd && report.log.is_some() {
        lines.push(
            "it names no file for what it prints before it opens that log; `marfa folders autostart on` again replaces it with an agent that does".into(),
        );
    }
    if let Some(key_file) = &report.key_file {
        lines.push(if key_file.is_file() {
            format!(
                "it takes its server and key from {}, and reads the keychain for no folder",
                key_file.display()
            )
        } else {
            format!(
                "it takes its server and key from {}, which no longer exists: the watch cannot start until it does",
                key_file.display()
            )
        });
    }
    if let Some(record) = &report.record {
        let running = report.state.as_ref().is_some_and(|state| state.running);
        if record.current {
            let watched = record
                .folders
                .iter()
                .filter(|folder| folder.watching)
                .count();
            lines.push(format!(
                "the record of folder watches is current: {} folder(s), {watched} watched",
                record.folders.len()
            ));
            let missing = record
                .folders
                .iter()
                .filter(|folder| !folder.watching && folder.reason.as_deref() == Some(MISSING))
                .count();
            if missing > 0 {
                lines.push(format!(
                    "{missing} listed folder(s) cannot be found, so they are not watched; `marfa folders list` shows them, and `marfa folders remove DIR` takes one off the list"
                ));
            }
            for folder in record
                .folders
                .iter()
                .filter(|folder| !folder.watching && folder.reason.as_deref() != Some(MISSING))
            {
                let reason = output::printable(folder.reason.as_deref().unwrap_or("not tried yet"));
                lines.push(if report.credential.contains(&folder.dir) {
                    match &report.key_file {
                        Some(key_file) => format!(
                            "{}: not watched ({reason}): the watch has no credential it can use for this folder's server; the key file {} must name that server, and the keychain is not read",
                            output::printable(&folder.dir),
                            key_file.display()
                        ),
                        None => format!(
                            "{}: not watched ({reason}): the watch has no credential it can use for this folder's server; keep one with `marfa keys keep` or `marfa login`, and on Linux unlock the Secret Service keychain at login",
                            output::printable(&folder.dir)
                        ),
                    }
                } else {
                    format!("{}: not watched ({reason})", output::printable(&folder.dir))
                });
            }
        } else if running {
            lines.push(format!(
                "{} holds no current entry for the running watch yet",
                record.path.display()
            ));
        }
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_telemetry_file_is_current_only_when_text_mode_owner_and_type_are_right() {
        use std::os::unix::fs::PermissionsExt as _;
        let dir = std::env::temp_dir().join(format!("marfa-autostart-file-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("dir");
        let path = dir.join("folder-watch.env");
        // Nothing carried: absent is current, anything there is not.
        assert!(telemetry_file_is(&path, None).expect("checked"));
        assert!(!telemetry_file_is(&path, Some("a=b\n")).expect("checked"));
        std::fs::write(&path, "a=b\n").expect("write");
        assert!(!telemetry_file_is(&path, None).expect("checked"));
        // Witness: right text, mode 0600 and own file is current.
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).expect("mode");
        assert!(telemetry_file_is(&path, Some("a=b\n")).expect("checked"));
        assert!(!telemetry_file_is(&path, Some("a=c\n")).expect("checked"));
        // Right text, loose mode.
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).expect("mode");
        assert!(!telemetry_file_is(&path, Some("a=b\n")).expect("checked"));
        // Right text and mode, but a link.
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).expect("mode");
        let link = dir.join("link.env");
        std::os::unix::fs::symlink(&path, &link).expect("link");
        assert!(!telemetry_file_is(&link, Some("a=b\n")).expect("checked"));
        std::fs::remove_dir_all(dir).ok();
    }

    /// A service manager that keeps what it was asked in `asked`, and holds
    /// the agent unless `held` is false.
    fn asked_manager(dir: &Path, manager: Manager, held: bool) -> (Place, PathBuf) {
        use std::os::unix::fs::PermissionsExt as _;
        let asked = dir.join("asked");
        let tool = dir.join("tool");
        let print = if held {
            "echo '\tstate = running'; exit 0"
        } else {
            "exit 113"
        };
        let loaded = if held {
            "LoadState=loaded"
        } else {
            "LoadState=not-found"
        };
        std::fs::write(
            &tool,
            format!(
                "#!/bin/sh\necho \"$@\" >> '{}'\ncase \"$*\" in\n*print*) {print};;\n*show*) echo '{loaded}'; echo 'ActiveState=active'; echo 'SubState=running';;\nesac\n",
                asked.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&tool, std::fs::Permissions::from_mode(0o755)).unwrap();
        let file = dir.join("agent");
        (
            Place {
                manager,
                file,
                tool,
            },
            asked,
        )
    }

    #[test]
    fn a_credential_kept_restarts_the_watch_only_where_it_can_help() {
        let here = |_: &Path, origin: &str| origin == "https://one.test";
        for manager in [Manager::Launchd, Manager::Systemd] {
            let temp = tempfile::tempdir().unwrap();
            let (place, asked) = asked_manager(temp.path(), manager, true);
            // Not installed: the manager is not even asked.
            assert!(!resume(&place, "https://one.test", here).unwrap());
            assert!(
                !asked.exists(),
                "{manager:?} was asked with nothing installed"
            );
            // Installed and held, listing a folder of that server: restarted.
            std::fs::write(&place.file, agent("/bin/marfa").render(manager).unwrap()).unwrap();
            assert!(resume(&place, "https://one.test", here).unwrap());
            let asked_of = std::fs::read_to_string(&asked).unwrap();
            let restart = match manager {
                Manager::Launchd => "kickstart -k",
                Manager::Systemd => "restart marfa-folder-watch.service",
            };
            assert!(asked_of.contains(restart), "{manager:?}: {asked_of}");
        }
    }

    #[test]
    fn a_credential_kept_leaves_the_watch_alone_where_it_could_not_help() {
        let here = |_: &Path, origin: &str| origin == "https://one.test";
        let temp = tempfile::tempdir().unwrap();
        let (place, asked) = asked_manager(temp.path(), Manager::Launchd, true);
        let keyed = Agent {
            key_file: Some("/home/me/watch.env".into()),
            ..agent("/bin/marfa")
        };
        std::fs::write(&place.file, keyed.render(Manager::Launchd).unwrap()).unwrap();
        // An agent with a key file never reads the keychain.
        assert!(!resume(&place, "https://one.test", here).unwrap());
        std::fs::write(
            &place.file,
            agent("/bin/marfa").render(Manager::Launchd).unwrap(),
        )
        .unwrap();
        // No listed folder follows the server the credential is for.
        assert!(!resume(&place, "https://two.test", here).unwrap());
        assert!(!asked.exists(), "{:?}", std::fs::read_to_string(&asked));
        // A file the manager does not hold is left alone.
        let temp = tempfile::tempdir().unwrap();
        let (place, asked) = asked_manager(temp.path(), Manager::Launchd, false);
        std::fs::write(
            &place.file,
            agent("/bin/marfa").render(Manager::Launchd).unwrap(),
        )
        .unwrap();
        assert!(!resume(&place, "https://one.test", here).unwrap());
        let asked_of = std::fs::read_to_string(&asked).unwrap();
        assert!(!asked_of.contains("kickstart"), "{asked_of}");
    }

    fn agent(binary: &str) -> Agent {
        Agent {
            binary: binary.into(),
            log: "/data/marfa/folder-watch.log".into(),
            registry: "/data/marfa/folders.json".into(),
            key_file: None,
            telemetry_file: None,
        }
    }

    #[test]
    fn an_agent_names_the_telemetry_file_and_is_read_back_with_it() {
        for manager in [Manager::Launchd, Manager::Systemd] {
            let mut carrying = agent("/bin/marfa");
            carrying.telemetry_file = Some("/data/marfa/folder-watch.env".into());
            let written = carrying.render(manager).unwrap();
            assert!(written.contains("MARFA_TELEMETRY_FILE"));
            assert!(written.contains("/data/marfa/folder-watch.env"));
            assert_eq!(Agent::read(manager, &written), Some(carrying));
            assert!(!outdated(manager, &written));
            // Witness: with none carried the agent names no file.
            let bare = agent("/bin/marfa").render(manager).unwrap();
            assert!(!bare.contains("MARFA_TELEMETRY_FILE"));
            assert_eq!(Agent::read(manager, &bare), Some(agent("/bin/marfa")));
        }
    }

    #[test]
    fn the_binary_is_recorded_by_the_path_it_was_run_by_where_that_leads_to_it() {
        let root = std::env::temp_dir()
            .canonicalize()
            .unwrap()
            .join(format!("marfa-cli-invoked-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("real")).unwrap();
        std::fs::create_dir_all(root.join("bin")).unwrap();
        let real = root.join("real").join("marfa");
        let other = root.join("real").join("other");
        std::fs::write(&real, "").unwrap();
        std::fs::write(&other, "").unwrap();
        let link = root.join("bin").join("marfa");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let path = std::env::join_paths([root.join("nothing"), root.join("bin")]).unwrap();
        let run = |argv0: Option<&str>| {
            invoked(argv0.map(std::ffi::OsStr::new), Some(&path), &root, &real)
        };
        assert_eq!(run(Some(link.to_str().unwrap())), link);
        assert_eq!(run(Some("marfa")), link);
        assert_eq!(run(Some("bin/marfa")), link);
        // Witnesses: a name that leads elsewhere, or none, gives the binary.
        assert_eq!(run(Some(other.to_str().unwrap())), real);
        assert_eq!(run(Some("absent")), real);
        assert_eq!(run(None), real);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn the_launchd_agent_runs_the_watch_of_every_folder_and_restarts_only_a_failure() {
        let plist = agent("/bin/marfa").plist().unwrap();
        assert!(plist.contains("<key>Label</key>\n\t<string>so.marfa.folder-watch</string>"));
        assert!(plist.contains(
            "\t\t<string>/bin/marfa</string>\n\t\t<string>folders</string>\n\t\t<string>watch</string>\n\t\t<string>--exit-on-new-build</string>\n\t\t<string>--log</string>\n\t\t<string>/data/marfa/folder-watch.log</string>\n\t</array>"
        ));
        assert!(plist.contains(
            "<key>MARFA_FOLDER_REGISTRY</key>\n\t\t<string>/data/marfa/folders.json</string>"
        ));
        assert!(plist.contains("<key>RunAtLoad</key>\n\t<true/>"));
        assert!(plist.contains("<key>SuccessfulExit</key>\n\t\t<false/>"));
        assert!(plist.contains("<key>ThrottleInterval</key>\n\t<integer>30</integer>"));
    }

    #[test]
    fn the_launchd_agent_names_a_file_beside_the_log_for_the_output_the_log_does_not_hold() {
        let plist = agent("/bin/marfa").plist().unwrap();
        for key in ["StandardOutPath", "StandardErrorPath"] {
            assert!(plist.contains(&format!(
                "<key>{key}</key>\n\t<string>/data/marfa/folder-watch.launchd.log</string>"
            )));
        }
        // Witness: the systemd unit names none, since its journal keeps the output.
        let unit = agent("/bin/marfa").unit().unwrap();
        assert!(!unit.contains("StandardOutput") && !unit.contains("StandardError"));
        assert!(!unit.contains("launchd"));
    }

    #[test]
    fn the_output_file_an_installed_agent_names_is_read_from_its_property_list() {
        let plist = agent("/bin/marfa").plist().unwrap();
        assert_eq!(
            launchd_log_of(&plist),
            Some(PathBuf::from("/data/marfa/folder-watch.launchd.log"))
        );
        // Witnesses: an agent from before the output was named, or one that
        // sends the two streams to different files, names no one file.
        let earlier = plist
            .replace(
                "\t<key>StandardOutPath</key>\n\t<string>/data/marfa/folder-watch.launchd.log</string>\n\t<key>StandardErrorPath</key>\n\t<string>/data/marfa/folder-watch.launchd.log</string>\n",
                "",
            );
        assert_ne!(earlier, plist);
        assert_eq!(launchd_log_of(&earlier), None);
        let split = plist.replacen("launchd.log", "launchd-err.log", 1);
        assert_ne!(split, plist);
        assert_eq!(launchd_log_of(&split), None);
    }

    #[test]
    fn the_launchd_output_file_is_made_for_its_owner_alone_in_a_directory_that_may_not_exist() {
        let root =
            std::env::temp_dir().join(format!("marfa-cli-launchd-log-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let mut made = agent("/bin/marfa");
        made.log = root.join("new").join("folder-watch.log");
        made.make_launchd_log().unwrap();
        let file = made.launchd_log();
        assert_eq!(file, root.join("new").join("folder-watch.launchd.log"));
        let mode = |path: &Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&file), 0o600);
        // Made again, it keeps what the first run wrote.
        std::fs::write(&file, "kept\n").unwrap();
        made.make_launchd_log().unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "kept\n");
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn the_systemd_unit_runs_the_watch_of_every_folder_and_restarts_only_a_failure() {
        let unit = agent("/bin/marfa").unit().unwrap();
        assert!(unit.contains(
            "ExecStart=\"/bin/marfa\" \"folders\" \"watch\" \"--exit-on-new-build\" \"--log\" \"/data/marfa/folder-watch.log\"\n"
        ));
        assert!(unit.contains("Environment=\"MARFA_FOLDER_REGISTRY=/data/marfa/folders.json\"\n"));
        assert!(unit.contains("Restart=on-failure\nRestartSec=30\n"));
        assert!(unit.contains("[Install]\nWantedBy=default.target\n"));
    }

    #[test]
    fn the_launchd_agent_lowers_the_watch_cpu_and_io_priority_and_is_not_background_work() {
        let plist = agent("/bin/marfa").plist().unwrap();
        assert!(plist.contains("\t<key>Nice</key>\n\t<integer>10</integer>\n"));
        assert!(plist.contains("\t<key>LowPriorityIO</key>\n\t<true/>\n"));
        assert!(!plist.contains("ProcessType"));
    }

    #[test]
    fn the_systemd_unit_lowers_the_watch_cpu_and_io_priority() {
        let unit = agent("/bin/marfa").unit().unwrap();
        let service = unit
            .split("[Service]\n")
            .nth(1)
            .and_then(|rest| rest.split("\n[").next())
            .unwrap();
        for line in [
            "Nice=10",
            "IOSchedulingClass=best-effort",
            "IOSchedulingPriority=7",
        ] {
            assert!(service.lines().any(|found| found == line), "{line}");
        }
        // No cpu controller is assumed to be delegated to a user unit.
        assert!(!unit.contains("CPUWeight"));
    }

    #[test]
    fn an_agent_from_an_earlier_build_is_one_to_replace() {
        const LAUNCHD_PRIORITY: &str =
            "\t<key>Nice</key>\n\t<integer>10</integer>\n\t<key>LowPriorityIO</key>\n\t<true/>\n";
        for (manager, without, instead) in [
            (Manager::Launchd, LAUNCHD_PRIORITY, ""),
            (
                Manager::Launchd,
                LAUNCHD_PRIORITY,
                "\t<key>ProcessType</key>\n\t<string>Background</string>\n",
            ),
            (
                Manager::Systemd,
                "Nice=10\nIOSchedulingClass=best-effort\nIOSchedulingPriority=7\n",
                "",
            ),
        ] {
            let current = agent("/bin/marfa").render(manager).unwrap();
            assert!(current.contains(without), "{manager:?}");
            let earlier = current.replace(without, instead);
            assert_ne!(earlier, current, "{manager:?}");
            // It still reads as the agent it was, so `status` can name it.
            assert_eq!(
                Agent::read(manager, &earlier),
                Some(agent("/bin/marfa")),
                "{manager:?}"
            );
            assert!(outdated(manager, &earlier), "{manager:?}");
            // Witness: the agent `on` writes now is not.
            assert!(!outdated(manager, &current), "{manager:?}");
        }
        assert!(!outdated(Manager::Launchd, "something else"));
    }

    #[test]
    fn an_agent_whose_watch_does_not_end_for_a_new_build_is_one_to_replace() {
        for manager in [Manager::Launchd, Manager::Systemd] {
            for keyed in [
                agent("/bin/marfa"),
                Agent {
                    key_file: Some("/home/me/watch.env".into()),
                    ..agent("/bin/marfa")
                },
            ] {
                let current = keyed.render(manager).unwrap();
                let flag = match manager {
                    Manager::Launchd => "\t\t<string>--exit-on-new-build</string>\n",
                    Manager::Systemd => " \"--exit-on-new-build\"",
                };
                assert!(current.contains(flag), "{manager:?}");
                let earlier = current.replace(flag, "");
                assert_eq!(Agent::read(manager, &earlier), Some(keyed.clone()));
                assert!(outdated(manager, &earlier), "{manager:?}");
                assert!(!outdated(manager, &current), "{manager:?}");
            }
        }
    }

    #[test]
    fn neither_file_holds_a_credential_or_a_server() {
        for manager in [Manager::Launchd, Manager::Systemd] {
            let written = agent("/bin/marfa").render(manager).unwrap();
            for name in [
                "MARFA_API_KEY",
                "MARFA_API_URL",
                "MARFA_KEYCHAIN",
                "--url",
                "--key",
            ] {
                assert!(!written.contains(name), "{manager:?} carries {name}");
            }
            // Witness: the one variable it carries is there.
            assert!(written.contains("MARFA_FOLDER_REGISTRY"));
        }
    }

    #[test]
    fn an_agent_with_a_key_file_runs_the_watch_with_its_path_and_holds_nothing_from_it() {
        let keyed = Agent {
            key_file: Some("/home/me/.config/marfa/watch.env".into()),
            ..agent("/bin/marfa")
        };
        let plist = keyed.plist().unwrap();
        assert!(plist.contains(
            "\t\t<string>watch</string>\n\t\t<string>--key-file</string>\n\t\t<string>/home/me/.config/marfa/watch.env</string>\n\t\t<string>--exit-on-new-build</string>\n\t\t<string>--log</string>"
        ));
        let unit = keyed.unit().unwrap();
        assert!(
            unit.contains(
                "\"watch\" \"--key-file\" \"/home/me/.config/marfa/watch.env\" \"--exit-on-new-build\" \"--log\""
            )
        );
        for manager in [Manager::Launchd, Manager::Systemd] {
            let written = keyed.render(manager).unwrap();
            for name in [
                "MARFA_API_KEY",
                "MARFA_API_URL",
                "MARFA_KEYCHAIN",
                "--url",
                "--key\"",
            ] {
                assert!(!written.contains(name), "{manager:?} carries {name}");
            }
            assert_eq!(
                Agent::read(manager, &written),
                Some(keyed.clone()),
                "{manager:?}"
            );
            // The witness: an agent with none is another agent.
            assert_ne!(
                written,
                agent("/bin/marfa").render(manager).unwrap(),
                "{manager:?}"
            );
        }
    }

    #[test]
    fn untidy_paths_are_read_back_as_written() {
        let untidy = "/Apps & Tools/<marfa> \"100%\" $HOME\\bin/marfa";
        for manager in [Manager::Launchd, Manager::Systemd] {
            let written = agent(untidy).render(manager).unwrap();
            assert_eq!(
                Agent::read(manager, &written),
                Some(agent(untidy)),
                "{manager:?}: {written}"
            );
        }
    }

    #[test]
    fn a_unit_word_cannot_reach_a_specifier_or_a_variable() {
        assert_eq!(quoted("50% $HOME", true), "\"50%% $$HOME\"");
        // `Environment=` expands no variable.
        assert_eq!(quoted("50% $HOME", false), "\"50%% $HOME\"");
        assert_eq!(quoted("a\"b\\c", true), "\"a\\\"b\\\\c\"");
    }

    #[test]
    fn a_path_with_a_control_character_is_refused() {
        let error = agent("/bin/mar\nfa").render(Manager::Systemd).unwrap_err();
        assert!(matches!(error, CliError::Invalid(_)), "{error}");
        let error = agent("/bin/mar\tfa").render(Manager::Launchd).unwrap_err();
        assert!(matches!(error, CliError::Invalid(_)), "{error}");
    }

    #[test]
    fn a_file_marfa_did_not_write_is_not_read_as_an_agent() {
        for manager in [Manager::Launchd, Manager::Systemd] {
            assert_eq!(Agent::read(manager, "something else"), None);
        }
        let other = agent("/bin/marfa")
            .unit()
            .unwrap()
            .replace("\"watch\"", "\"push\"");
        assert_eq!(Agent::read(Manager::Systemd, &other), None);
    }

    #[test]
    fn launchctl_print_says_whether_the_watch_runs() {
        let printed = "gui/501/so.marfa.folder-watch = {\n\tactive count = 1\n\tpath = /x.plist\n\ttype = LaunchAgent\n\tstate = running\n\n\tprogram = /bin/marfa\n\tpid = 4821\n\tlast exit code = 2\n\tendpoints = {\n\t\tstate = active\n\t}\n}\n";
        assert_eq!(
            launchd_state(printed),
            State {
                loaded: true,
                running: true,
                pid: Some(4821),
                last_exit: Some(2),
                enabled: None,
                reload: None,
            }
        );
        let waiting = "gui/501/so.marfa.folder-watch = {\n\tstate = not running\n\tlast exit code = 78: EX_CONFIG\n}\n";
        assert_eq!(
            launchd_state(waiting),
            State {
                loaded: true,
                running: false,
                pid: None,
                last_exit: Some(78),
                enabled: None,
                reload: None,
            }
        );
    }

    #[test]
    fn systemctl_show_says_whether_the_watch_runs() {
        let shown = "LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=4821\nExecMainStatus=0\nUnitFileState=enabled\nNeedDaemonReload=yes\n";
        assert_eq!(
            systemd_state(shown),
            State {
                loaded: true,
                running: true,
                pid: Some(4821),
                last_exit: Some(0),
                enabled: Some(true),
                reload: Some(true),
            }
        );
        let failed = "LoadState=loaded\nActiveState=activating\nSubState=auto-restart\nMainPID=0\nExecMainStatus=3\nUnitFileState=enabled\n";
        let state = systemd_state(failed);
        assert!(!state.running);
        assert_eq!((state.pid, state.last_exit), (None, Some(3)));
        let absent = "LoadState=not-found\nActiveState=inactive\nSubState=dead\nMainPID=0\nExecMainStatus=0\nUnitFileState=\n";
        assert!(!systemd_state(absent).loaded);
    }

    #[test]
    fn an_entry_is_current_by_the_record_reader_rule() {
        let entry = |beat: &str, ended: Option<&str>| RecordProcess {
            pid: 1,
            build_version: None,
            heartbeat_at: beat.into(),
            heartbeat_interval_seconds: 5,
            ended_at: ended.map(str::to_string),
            folders: Vec::new(),
        };
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(1_760_000_000);
        let at = |seconds: u64| {
            chrono::DateTime::from_timestamp(seconds as i64, 0)
                .unwrap()
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        };
        assert!(entry(&at(1_760_000_000 - 14), None).current(now));
        assert!(!entry(&at(1_760_000_000 - 15), None).current(now));
        assert!(!entry(&at(1_760_000_000 + 1), None).current(now));
        assert!(!entry(&at(1_760_000_000 - 1), Some("2025-10-09T00:00:00Z")).current(now));
        assert!(!entry("not a time", None).current(now));
    }
}
