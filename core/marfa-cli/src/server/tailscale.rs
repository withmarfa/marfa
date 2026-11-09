//! Tailscale Serve, which gives a machine on a tailnet an `https` address.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde_json::Value;

use crate::error::CliError;

const MAC_APP: &str = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

/// A file this user may run, as a shell judges it.
fn is_program(path: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let Ok(text) = std::ffi::CString::new(path.as_os_str().as_bytes()) else {
        return false;
    };
    // SAFETY: `text` is a valid NUL-terminated string that outlives the call.
    let runnable = unsafe { libc::access(text.as_ptr(), libc::X_OK) } == 0;
    runnable && std::fs::metadata(path).is_ok_and(|meta| meta.is_file())
}

fn on_path(name: &OsStr, path: Option<&OsStr>) -> Option<PathBuf> {
    std::env::split_paths(path?)
        .filter(|dir| !dir.as_os_str().is_empty())
        .map(|dir| dir.join(name))
        .find(|candidate| is_program(candidate))
}

/// The program as a shell finds it, except that an empty `PATH` entry is skipped:
/// `MARFA_TAILSCALE` by path or on the `PATH`, else `tailscale` on the `PATH`, then
/// the Mac app. The caller runs exactly this path.
fn resolve(named: Option<&OsStr>, path: Option<&OsStr>, app: &Path) -> Option<PathBuf> {
    match named {
        Some(name) if name.as_encoded_bytes().contains(&b'/') => {
            Some(PathBuf::from(name)).filter(|candidate| is_program(candidate))
        }
        Some(name) => on_path(name, path),
        None => on_path(OsStr::new("tailscale"), path)
            .or_else(|| is_program(app).then(|| app.to_path_buf())),
    }
}

/// A process list (`ps -Axo comm=`) with the Mac app running.
fn judge_processes(processes: &str) -> Result<(), CliError> {
    if processes.lines().map(str::trim).any(|line| line == MAC_APP) {
        Ok(())
    } else {
        Err(CliError::Install(
            "the Tailscale app is not running. Open Tailscale, make sure it is connected, and run this again".into(),
        ))
    }
}

/// With the app installed, any Tailscale program run while it is closed can bring
/// up its network extension switched off.
fn require_the_app_running() -> Result<(), CliError> {
    if !cfg!(target_os = "macos") || !Path::new(MAC_APP).is_file() {
        return Ok(());
    }
    let listed = Command::new("/bin/ps")
        .args(["-Axo", "comm="])
        .stdin(Stdio::null())
        .output()
        .map_err(|error| CliError::Install(format!("cannot list processes: {error}")))?;
    if !listed.status.success() {
        return Err(CliError::Install(format!(
            "cannot list processes: `ps` exited with {}",
            listed.status
        )));
    }
    judge_processes(&String::from_utf8_lossy(&listed.stdout))
}

fn run(args: &[&str]) -> Result<String, CliError> {
    let named = std::env::var_os("MARFA_TAILSCALE");
    let path = std::env::var_os("PATH");
    let program = resolve(named.as_deref(), path.as_deref(), Path::new(MAC_APP)).ok_or_else(|| {
        CliError::Install(
            "Tailscale is not installed, or its command line is not on the PATH. Install it from tailscale.com and sign in, then run this again".into(),
        )
    })?;
    require_the_app_running()?;
    let mut command = Command::new(&program);
    // The Mac app's binary is the command line only with this set.
    command
        .args(args)
        .env("TAILSCALE_BE_CLI", "1")
        .stdin(Stdio::null());
    let output = command
        .output()
        .map_err(|error| CliError::Install(format!("cannot run Tailscale: {error}")))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let said = String::from_utf8_lossy(&output.stderr);
        Err(CliError::Install(format!(
            "`tailscale {}` failed: {}",
            args.join(" "),
            said.trim().lines().last().unwrap_or("no message")
        )))
    }
}

/// This machine's name on the tailnet, such as `host.example.ts.net`.
pub fn dns_name() -> Result<String, CliError> {
    let status: Value = serde_json::from_str(&run(&["status", "--json"])?)
        .map_err(|_| CliError::Install("Tailscale's status was not JSON".into()))?;
    status["Self"]["DNSName"]
        .as_str()
        .map(|name| name.trim_end_matches('.').to_string())
        .filter(|name| !name.is_empty())
        .ok_or_else(|| {
            CliError::Install(
                "Tailscale has no name for this machine: sign in, and turn on MagicDNS and HTTPS certificates for the tailnet".into(),
            )
        })
}

/// What is served at the root of `https_port`, from `tailscale serve status --json`.
pub fn served(status: &str, https_port: u16) -> Option<String> {
    let status: Value = serde_json::from_str(status).ok()?;
    let suffix = format!(":{https_port}");
    status["Web"]
        .as_object()?
        .iter()
        .find(|(host, _)| host.ends_with(&suffix))
        .and_then(|(_, web)| web["Handlers"]["/"].as_object())
        .map(|handler| {
            handler
                .get("Proxy")
                .and_then(Value::as_str)
                .unwrap_or("something else")
                .to_string()
        })
}

/// Refuses when the port serves anything but `target` or `previous`, before changing
/// anything. `true` means `target` is served already.
pub fn check_free(https_port: u16, target: &str, previous: Option<&str>) -> Result<bool, CliError> {
    let status = run(&["serve", "status", "--json"])?;
    match served(&status, https_port) {
        Some(existing) if existing == target => Ok(true),
        Some(existing) if Some(existing.as_str()) == previous => Ok(false),
        Some(existing) => Err(CliError::Usage(format!(
            "Tailscale already serves {existing} on port {https_port}. Choose another with --https-port, or turn that one off first"
        ))),
        None => Ok(false),
    }
}

/// Serves `target` on the tailnet only; a port serving something else is never replaced.
pub fn serve(
    https_port: u16,
    target: &str,
    previous: Option<&str>,
    trace: bool,
) -> Result<(), CliError> {
    if check_free(https_port, target, previous)? {
        return Ok(());
    }
    let https = format!("--https={https_port}");
    if trace {
        eprintln!("  $ tailscale serve --bg {https} {target}");
    }
    run(&["serve", "--bg", &https, target]).map(|_| ())
}

/// Stops serving `target` on `https_port`, and only that.
pub fn unserve(https_port: u16, target: &str, trace: bool) -> Result<bool, CliError> {
    let status = run(&["serve", "status", "--json"])?;
    if served(&status, https_port).as_deref() != Some(target) {
        return Ok(false);
    }
    let https = format!("--https={https_port}");
    if trace {
        eprintln!("  $ tailscale serve {https} off");
    }
    run(&["serve", &https, "off"])?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use super::*;

    const STATUS: &str = r#"{"TCP":{"443":{"HTTPS":true}},"Web":{"host.example.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:8600"}}}}}"#;

    #[test]
    fn only_the_running_app_lets_a_command_through() {
        assert!(judge_processes(&format!("/usr/sbin/cfprefsd\n  {MAC_APP}\n")).is_ok());
        let refused = judge_processes(
            "/usr/sbin/cfprefsd\ntailscaled\n/Applications/Tailscale.app/Contents/PlugIns/IPNExtension.appex/Contents/MacOS/IPNExtension\n",
        )
        .unwrap_err()
        .to_string();
        assert!(
            refused.contains("Tailscale app is not running"),
            "{refused}"
        );
        assert!(judge_processes("").is_err());
    }

    fn program(dir: &Path, name: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    #[test]
    fn a_name_with_a_slash_is_that_path_and_nothing_else() {
        let dir = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let named = program(dir.path(), "ts");
        program(other.path(), "ts");
        let path = other.path().as_os_str();
        let app = dir.path().join("no-app");
        assert_eq!(
            resolve(Some(named.as_os_str()), Some(path), &app),
            Some(named)
        );
        let missing = dir.path().join("missing");
        assert_eq!(resolve(Some(missing.as_os_str()), Some(path), &app), None);
    }

    #[test]
    fn a_name_without_a_slash_is_searched_on_the_path() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let found = program(second.path(), "ts");
        std::fs::write(first.path().join("ts"), "not executable").unwrap();
        let path = std::env::join_paths([first.path(), second.path()]).unwrap();
        let app = first.path().join("no-app");
        assert_eq!(
            resolve(Some(OsStr::new("ts")), Some(&path), &app),
            Some(found)
        );
        assert_eq!(resolve(Some(OsStr::new("other")), Some(&path), &app), None);
        assert_eq!(resolve(Some(OsStr::new("ts")), None, &app), None);
    }

    #[test]
    fn with_no_name_the_path_comes_before_the_app() {
        let bin = tempfile::tempdir().unwrap();
        let apps = tempfile::tempdir().unwrap();
        let app = program(apps.path(), "Tailscale");
        let empty = tempfile::tempdir().unwrap();
        let none = std::env::join_paths([empty.path()]).unwrap();
        assert_eq!(resolve(None, Some(&none), &app), Some(app.clone()));
        assert_eq!(resolve(None, None, &app), Some(app.clone()));
        let on_path = program(bin.path(), "tailscale");
        let path = std::env::join_paths([bin.path()]).unwrap();
        assert_eq!(resolve(None, Some(&path), &app), Some(on_path));
        assert_eq!(
            resolve(None, Some(&none), &apps.path().join("missing")),
            None
        );
    }

    #[test]
    fn what_a_port_serves_is_read_from_the_status() {
        assert_eq!(served(STATUS, 443), Some("http://127.0.0.1:8600".into()));
        assert_eq!(served(STATUS, 8443), None);
        assert_eq!(served("{}", 443), None);
        assert_eq!(served("", 443), None);
    }
}
