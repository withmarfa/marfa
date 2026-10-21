//! Starting the server when its owner logs in, on a Mac: a launchd agent that
//! runs `marfa server start`, which brings the Docker engine up first. The
//! container's restart policy already brings the server back whenever the
//! engine starts, so the agent covers the engine itself being down.
//! `MARFA_AUTOSTART_ROOT` names a directory in place of the home directory,
//! with the `launchctl` to run in its `bin`, as for `folders autostart`.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use crate::autostart::{ROOT_ENV, invoked, text, xml};
use crate::error::CliError;
use crate::server::docker::Docker;

/// launchd starts an agent with almost no `PATH`, and Docker is in none of it.
const PATH: &str = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

/// The most the agent waits for the engine, in seconds.
pub const ENGINE_WAIT: u64 = 600;

const RESTART_SECONDS: u32 = 30;

pub fn label(name: &str) -> String {
    format!("so.marfa.server.{name}")
}

pub struct Agent {
    pub name: String,
    pub binary: PathBuf,
    pub dir: PathBuf,
    pub log: PathBuf,
}

impl Agent {
    pub fn for_this_binary(name: &str, dir: &Path) -> Result<Agent, CliError> {
        let binary = invoked(
            std::env::args_os().next().as_deref(),
            std::env::var_os("PATH").as_deref(),
            &std::env::current_dir()?,
            &std::env::current_exe()?,
        );
        let dir = std::path::absolute(dir)?;
        Ok(Agent {
            name: name.to_string(),
            binary,
            log: home()?
                .join("Library/Logs")
                .join(format!("marfa-server-{name}.log")),
            dir,
        })
    }

    pub fn plist(&self) -> Result<String, CliError> {
        let wait = ENGINE_WAIT.to_string();
        let arguments = [
            text(&self.binary)?,
            "server",
            "start",
            "--wait",
            &wait,
            "--dir",
            text(&self.dir)?,
        ]
        .iter()
        .map(|argument| format!("\t\t<string>{}</string>\n", xml(argument)))
        .collect::<String>();
        let log = xml(text(&self.log)?);
        Ok(format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">
<plist version=\"1.0\">
<dict>
\t<key>Label</key>
\t<string>{label}</string>
\t<key>ProgramArguments</key>
\t<array>
{arguments}\t</array>
\t<key>EnvironmentVariables</key>
\t<dict>
\t\t<key>PATH</key>
\t\t<string>{PATH}</string>
\t</dict>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<dict>
\t\t<key>SuccessfulExit</key>
\t\t<false/>
\t</dict>
\t<key>ThrottleInterval</key>
\t<integer>{RESTART_SECONDS}</integer>
\t<key>StandardOutPath</key>
\t<string>{log}</string>
\t<key>StandardErrorPath</key>
\t<string>{log}</string>
</dict>
</plist>
",
            label = label(&self.name)
        ))
    }
}

fn stand_in() -> Option<PathBuf> {
    std::env::var_os(ROOT_ENV)
        .filter(|root| !root.is_empty())
        .map(PathBuf::from)
}

fn home() -> Result<PathBuf, CliError> {
    match stand_in() {
        Some(root) => Ok(root),
        None => std::env::var_os("HOME")
            .filter(|home| !home.is_empty())
            .map(PathBuf::from)
            .ok_or_else(|| CliError::Usage("HOME is not set".into())),
    }
}

/// Whether this machine starts agents at login: a Mac, or a test's stand-in.
pub fn supported() -> bool {
    cfg!(target_os = "macos") || stand_in().is_some()
}

fn file(name: &str) -> Result<PathBuf, CliError> {
    Ok(home()?
        .join("Library/LaunchAgents")
        .join(format!("{}.plist", label(name))))
}

fn launchctl(arguments: &[&str]) -> Command {
    let mut command = match stand_in() {
        Some(root) => Command::new(root.join("bin/launchctl")),
        None => Command::new("/bin/launchctl"),
    };
    command.args(arguments);
    command
}

fn domain() -> String {
    // SAFETY: `getuid` cannot fail.
    format!("gui/{}", unsafe { libc::getuid() })
}

fn run(arguments: &[&str]) -> Result<std::process::Output, CliError> {
    launchctl(arguments)
        .output()
        .map_err(|error| CliError::Install(format!("cannot run launchctl: {error}")))
}

pub fn loaded(name: &str) -> bool {
    run(&["print", &format!("{}/{}", domain(), label(name))]).is_ok_and(|out| out.status.success())
}

pub fn installed(name: &str) -> bool {
    file(name).is_ok_and(|path| path.exists())
}

/// Writes the agent and loads it. Loaded from this account's own login
/// session; an agent already loaded is unloaded first when it changed.
pub fn on(agent: &Agent, trace: bool) -> Result<bool, CliError> {
    let path = file(&agent.name)?;
    let plist = agent.plist()?;
    if let Some(folder) = path.parent() {
        std::fs::create_dir_all(folder)?;
    }
    if let Some(folder) = agent.log.parent() {
        std::fs::create_dir_all(folder)?;
    }
    let changed = crate::server::files::write_if_changed(&path, &plist, false)?;
    let was_loaded = loaded(&agent.name);
    if was_loaded && !changed {
        return Ok(false);
    }
    let target = format!("{}/{}", domain(), label(&agent.name));
    if was_loaded {
        if trace {
            eprintln!("  $ launchctl bootout {target}");
        }
        run(&["bootout", &target])?;
    }
    let path_text = text(&path)?;
    if trace {
        eprintln!("  $ launchctl bootstrap {} {path_text}", domain());
    }
    let ran = run(&["bootstrap", &domain(), path_text])?;
    if !ran.status.success() {
        return Err(CliError::Install(format!(
            "`launchctl bootstrap` failed: {}",
            String::from_utf8_lossy(&ran.stderr).trim()
        )));
    }
    Ok(true)
}

pub fn off(name: &str, trace: bool) -> Result<bool, CliError> {
    let path = file(name)?;
    let was_loaded = loaded(name);
    if was_loaded {
        let target = format!("{}/{}", domain(), label(name));
        if trace {
            eprintln!("  $ launchctl bootout {target}");
        }
        run(&["bootout", &target])?;
    }
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(was_loaded),
        Err(error) => Err(error.into()),
    }
}

/// Brings the Docker engine up if it is down, on a Mac, and waits for it.
pub fn ensure_engine(docker: &Docker, seconds: u64, trace: bool) -> Result<(), CliError> {
    if docker.running() {
        return Ok(());
    }
    if !cfg!(target_os = "macos") {
        return Err(CliError::Install(
            "Docker's engine is not running. Start it (`sudo systemctl start docker`), then run this again".into(),
        ));
    }
    let app = ["OrbStack", "Docker"].into_iter().find(|app| {
        Path::new(&format!("/Applications/{app}.app")).exists()
            || home().is_ok_and(|home| home.join(format!("Applications/{app}.app")).exists())
    });
    let Some(app) = app else {
        return Err(CliError::Install(
            "Docker's engine is not running, and neither OrbStack nor Docker Desktop is installed to start it".into(),
        ));
    };
    if trace {
        eprintln!("  $ open -g -a {app}");
    }
    let _ = Command::new("open").args(["-g", "-a", app]).output();
    let deadline = Instant::now() + Duration::from_secs(seconds);
    while Instant::now() < deadline {
        if docker.running() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_secs(2));
    }
    Err(CliError::Install(format!(
        "{app} was opened, and Docker's engine did not answer in {seconds} seconds"
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent() -> Agent {
        Agent {
            name: "marfa".into(),
            binary: "/opt/homebrew/bin/marfa".into(),
            dir: "/Users/x/Services/apis/marfa".into(),
            log: "/Users/x/Library/Logs/marfa-server-marfa.log".into(),
        }
    }

    #[test]
    fn the_agent_starts_the_server_at_login_and_restarts_only_a_failure() {
        let plist = agent().plist().unwrap();
        for part in [
            "<string>so.marfa.server.marfa</string>",
            "<string>/opt/homebrew/bin/marfa</string>\n\t\t<string>server</string>\n\t\t<string>start</string>",
            "<string>/Users/x/Services/apis/marfa</string>",
            "<key>RunAtLoad</key>\n\t<true/>",
            "<key>SuccessfulExit</key>\n\t\t<false/>",
            "/usr/local/bin",
        ] {
            assert!(plist.contains(part), "{part}\n{plist}");
        }
    }

    #[test]
    fn neither_the_agent_nor_its_path_can_carry_a_secret() {
        let plist = agent().plist().unwrap();
        assert!(!plist.contains("SECRET") && !plist.contains("SALT"));
    }

    #[test]
    fn a_path_with_markup_is_escaped() {
        let mut odd = agent();
        odd.dir = "/Users/x/a&b <c>".into();
        let plist = odd.plist().unwrap();
        assert!(plist.contains("/Users/x/a&amp;b &lt;c&gt;"), "{plist}");
    }
}
