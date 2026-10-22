//! Tailscale Serve, which gives a machine on a tailnet an `https` address.
//! `MARFA_TAILSCALE` names the program in place of the one found.

use std::path::PathBuf;
use std::process::{Command, Stdio};

use serde_json::Value;

use crate::error::CliError;

const MAC_APP: &str = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

fn program() -> Option<PathBuf> {
    if let Some(named) = std::env::var_os("MARFA_TAILSCALE") {
        return Some(named.into());
    }
    let found = std::env::var_os("PATH").and_then(|path| {
        std::env::split_paths(&path)
            .map(|dir| dir.join("tailscale"))
            .find(|candidate| candidate.is_file())
    });
    found.or_else(|| {
        let app = PathBuf::from(MAC_APP);
        app.is_file().then_some(app)
    })
}

fn run(args: &[&str]) -> Result<String, CliError> {
    let program = program().ok_or_else(|| {
        CliError::Install(
            "Tailscale is not installed, or its command line is not on the PATH. Install it from tailscale.com and sign in, then run this again".into(),
        )
    })?;
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

/// Refuses when the port already serves something other than `target`, or
/// than `previous`, which this install served before and may replace. Whether
/// it does is read before anything is changed, so a refusal leaves nothing
/// behind. `true` means `target` is served already.
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

/// Serves `target` on the tailnet only, unless the port already serves
/// something else, which is never replaced.
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
    use super::*;

    const STATUS: &str = r#"{"TCP":{"443":{"HTTPS":true}},"Web":{"host.example.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:8600"}}}}}"#;

    #[test]
    fn what_a_port_serves_is_read_from_the_status() {
        assert_eq!(served(STATUS, 443), Some("http://127.0.0.1:8600".into()));
        assert_eq!(served(STATUS, 8443), None);
        assert_eq!(served("{}", 443), None);
        assert_eq!(served("", 443), None);
    }
}
