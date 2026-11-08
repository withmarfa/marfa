//! The server as a launchd agent on a Mac. A native install's agent runs
//! `marfa server run`; a Docker install's runs `marfa server start`, which
//! brings the Docker engine up first. `MARFA_AUTOSTART_ROOT` names a
//! directory in place of the home directory, with the `launchctl` to run in
//! its `bin`, as for `folders autostart`.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use crate::autostart::{ROOT_ENV, text, xml};
use crate::error::CliError;

/// launchd starts an agent with almost no `PATH`, and Docker is in none of it.
const PATH: &str = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

/// The most the Docker agent waits for the engine, in seconds.
pub const ENGINE_WAIT: u64 = 600;

const UNLOAD_WAIT: Duration = Duration::from_secs(10);

pub fn label(name: &str) -> String {
    format!("so.marfa.server.{name}")
}

/// What the agent runs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Job {
    /// `marfa server run --dir`: the server itself.
    Server,
    /// `marfa server start --dir`: Docker's engine, then the container.
    Container,
}

pub struct Agent {
    pub name: String,
    pub job: Job,
    pub binary: PathBuf,
    pub dir: PathBuf,
    pub stdout: PathBuf,
    /// Loaded at every login, which is where launchd reads agents from; an
    /// agent that is not is read from the install's folder and loaded now.
    pub at_login: bool,
}

impl Agent {
    /// The agent of a Docker install, which starts the engine and the container.
    pub fn for_docker(name: &str, dir: &Path) -> Result<Agent, CliError> {
        Ok(Agent {
            name: name.to_string(),
            job: Job::Container,
            binary: crate::server::native::stable_binary_of_this()?,
            dir: dir.to_path_buf(),
            stdout: agent_log(name)?,
            at_login: true,
        })
    }

    pub fn plist(&self) -> Result<String, CliError> {
        let wait = ENGINE_WAIT.to_string();
        let mut arguments = vec![text(&self.binary)?, "server"];
        match self.job {
            Job::Server => arguments.push("run"),
            Job::Container => arguments.extend(["start", "--wait", &wait]),
        }
        arguments.extend(["--dir", text(&self.dir)?]);
        let arguments = arguments
            .iter()
            .map(|argument| format!("\t\t<string>{}</string>\n", xml(argument)))
            .collect::<String>();
        let log = xml(text(&self.stdout)?);
        let restart = match self.job {
            Job::Server => 10,
            Job::Container => 30,
        };
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
\t<integer>{restart}</integer>
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

pub fn home() -> Result<PathBuf, CliError> {
    match stand_in() {
        Some(root) => Ok(root),
        None => std::env::var_os("HOME")
            .filter(|home| !home.is_empty())
            .map(PathBuf::from)
            .ok_or_else(|| CliError::Usage("HOME is not set".into())),
    }
}

/// Whether this machine runs launchd agents: a Mac, or a test's stand-in.
pub fn supported() -> bool {
    cfg!(target_os = "macos") || stand_in().is_some()
}

/// Where a native server's log is kept, beside the agent's own output.
pub fn logs() -> Result<PathBuf, CliError> {
    Ok(home()?.join("Library/Logs/Marfa"))
}

/// The server's log, which `marfa server run` writes and rotates.
pub fn server_log(name: &str) -> Result<PathBuf, CliError> {
    Ok(logs()?.join(format!("{name}.log")))
}

/// What launchd keeps of the agent's own output.
pub fn agent_log(name: &str) -> Result<PathBuf, CliError> {
    Ok(logs()?.join(format!("{name}.launchd.log")))
}

fn at_login_file(name: &str) -> Result<PathBuf, CliError> {
    Ok(home()?
        .join("Library/LaunchAgents")
        .join(format!("{}.plist", label(name))))
}

fn in_folder_file(name: &str, dir: &Path) -> PathBuf {
    dir.join(format!("{}.plist", label(name)))
}

fn file(agent: &Agent) -> Result<PathBuf, CliError> {
    if agent.at_login {
        at_login_file(&agent.name)
    } else {
        Ok(in_folder_file(&agent.name, &agent.dir))
    }
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

fn target(name: &str) -> String {
    format!("{}/{}", domain(), label(name))
}

fn run(arguments: &[&str]) -> Result<std::process::Output, CliError> {
    launchctl(arguments)
        .output()
        .map_err(|error| CliError::Install(format!("cannot run launchctl: {error}")))
}

fn said(output: &std::process::Output) -> String {
    let text = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if text.is_empty() {
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    } else {
        text
    }
}

pub fn loaded(name: &str) -> bool {
    run(&["print", &target(name)]).is_ok_and(|out| out.status.success())
}

/// Whether launchd holds the agent and has its process running.
pub fn running(name: &str) -> bool {
    run(&["print", &target(name)])
        .ok()
        .filter(|out| out.status.success())
        .is_some_and(|out| {
            String::from_utf8_lossy(&out.stdout)
                .lines()
                .find_map(|line| line.trim().strip_prefix("state = "))
                == Some("running")
        })
}

/// The agent's file, where this install has one.
pub fn installed(name: &str, dir: &Path) -> Option<PathBuf> {
    [at_login_file(name).ok()?, in_folder_file(name, dir)]
        .into_iter()
        .find(|path| path.exists())
}

fn bootout(name: &str, trace: bool) -> Result<(), CliError> {
    if !loaded(name) {
        return Ok(());
    }
    if trace {
        eprintln!("  $ launchctl bootout {}", target(name));
    }
    let ran = run(&["bootout", &target(name)])?;
    if !ran.status.success() && loaded(name) {
        return Err(CliError::Install(format!(
            "`launchctl bootout {}` failed: {}",
            target(name),
            said(&ran)
        )));
    }
    // A load straight after an unload can find the old agent still there.
    let started = Instant::now();
    while loaded(name) {
        if started.elapsed() > UNLOAD_WAIT {
            return Err(CliError::Install(format!(
                "launchd still holds {} after it was unloaded",
                label(name)
            )));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Ok(())
}

fn bootstrap(path: &Path, name: &str, trace: bool) -> Result<(), CliError> {
    let path_text = text(path)?;
    if trace {
        eprintln!("  $ launchctl bootstrap {} {path_text}", domain());
    }
    let ran = run(&["bootstrap", &domain(), path_text])?;
    if ran.status.success() {
        return Ok(());
    }
    Err(CliError::Install(format!(
        "launchd refused to load {}: {}. Load it yourself with `launchctl bootstrap {} {path_text}`",
        label(name),
        said(&ran),
        domain()
    )))
}

/// Writes the agent and loads it, which runs it. An agent already loaded and
/// unchanged is left running. Whether it was started or changed.
pub fn on(agent: &Agent, trace: bool) -> Result<bool, CliError> {
    let path = file(agent)?;
    let plist = agent.plist()?;
    if let Some(folder) = path.parent() {
        std::fs::create_dir_all(folder)?;
    }
    if let Some(folder) = agent.stdout.parent() {
        std::fs::create_dir_all(folder)?;
    }
    // The other place the agent could be read from is the old choice.
    let other = if agent.at_login {
        in_folder_file(&agent.name, &agent.dir)
    } else {
        at_login_file(&agent.name)?
    };
    let moved = other.exists();
    let changed = crate::server::files::write_if_changed(&path, &plist, false)?;
    let was_loaded = loaded(&agent.name);
    if was_loaded && !changed && !moved {
        return Ok(false);
    }
    bootout(&agent.name, trace)?;
    match std::fs::remove_file(&other) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    bootstrap(&path, &agent.name, trace)?;
    Ok(true)
}

/// Starts an agent that is written and not running.
pub fn start(name: &str, dir: &Path, trace: bool) -> Result<(), CliError> {
    if !loaded(name) {
        let Some(path) = installed(name, dir) else {
            return Err(CliError::Usage(format!(
                "{} has no launchd agent: `marfa server install` writes it",
                dir.display()
            )));
        };
        return bootstrap(&path, name, trace);
    }
    if running(name) {
        return Ok(());
    }
    if trace {
        eprintln!("  $ launchctl kickstart {}", target(name));
    }
    let ran = run(&["kickstart", &target(name)])?;
    if ran.status.success() {
        return Ok(());
    }
    Err(CliError::Install(format!(
        "`launchctl kickstart {}` failed: {}",
        target(name),
        said(&ran)
    )))
}

/// Whether the agent is one launchd loads at every login.
pub fn at_login(name: &str) -> bool {
    at_login_file(name).is_ok_and(|path| path.exists())
}

/// Restarts the agent's process, loading the agent first if it is not.
pub fn restart(name: &str, dir: &Path, trace: bool) -> Result<(), CliError> {
    if !loaded(name) {
        return start(name, dir, trace);
    }
    if trace {
        eprintln!("  $ launchctl kickstart -k {}", target(name));
    }
    let ran = run(&["kickstart", "-k", &target(name)])?;
    if ran.status.success() {
        return Ok(());
    }
    Err(CliError::Install(format!(
        "`launchctl kickstart -k {}` failed: {}",
        target(name),
        said(&ran)
    )))
}

/// Stops the agent's process and unloads it. An agent that starts at login
/// starts again then.
pub fn stop(name: &str, trace: bool) -> Result<bool, CliError> {
    let was = loaded(name);
    bootout(name, trace)?;
    Ok(was)
}

/// Unloads the agent and removes its file wherever it is.
pub fn off(name: &str, dir: &Path, trace: bool) -> Result<bool, CliError> {
    let was_loaded = loaded(name);
    bootout(name, trace)?;
    let mut removed = false;
    for path in [at_login_file(name)?, in_folder_file(name, dir)] {
        match std::fs::remove_file(&path) {
            Ok(()) => removed = true,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(removed || was_loaded)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent(job: Job) -> Agent {
        Agent {
            name: "marfa".into(),
            job,
            binary: "/opt/homebrew/bin/marfa".into(),
            dir: "/Users/x/Services/apis/marfa".into(),
            stdout: "/Users/x/Library/Logs/Marfa/marfa.launchd.log".into(),
            at_login: true,
        }
    }

    #[test]
    fn the_server_agent_runs_the_server_and_restarts_only_a_failure() {
        let plist = agent(Job::Server).plist().unwrap();
        for part in [
            "<string>so.marfa.server.marfa</string>",
            "<string>/opt/homebrew/bin/marfa</string>\n\t\t<string>server</string>\n\t\t<string>run</string>\n\t\t<string>--dir</string>\n\t\t<string>/Users/x/Services/apis/marfa</string>",
            "<key>RunAtLoad</key>\n\t<true/>",
            "<key>SuccessfulExit</key>\n\t\t<false/>",
            "<string>/Users/x/Library/Logs/Marfa/marfa.launchd.log</string>",
            "/usr/local/bin",
        ] {
            assert!(plist.contains(part), "{part}\n{plist}");
        }
    }

    #[test]
    fn the_container_agent_brings_the_engine_up_first() {
        let plist = agent(Job::Container).plist().unwrap();
        assert!(
            plist.contains("<string>start</string>\n\t\t<string>--wait</string>\n\t\t<string>600</string>"),
            "{plist}"
        );
        assert!(!plist.contains("<string>run</string>"));
    }

    #[test]
    fn neither_the_agent_nor_its_path_can_carry_a_secret() {
        for job in [Job::Server, Job::Container] {
            let plist = agent(job).plist().unwrap();
            assert!(!plist.contains("SECRET") && !plist.contains("SALT"));
        }
    }

    #[test]
    fn a_path_with_markup_is_escaped() {
        let mut odd = agent(Job::Server);
        odd.dir = "/Users/x/a&b <c>".into();
        let plist = odd.plist().unwrap();
        assert!(plist.contains("/Users/x/a&amp;b &lt;c&gt;"), "{plist}");
    }
}
