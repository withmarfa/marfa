//! The Docker engine, reached through its command line. `MARFA_DOCKER` names
//! another program in its place, which the tests use.

use std::ffi::OsString;
use std::os::fd::AsFd;
use std::path::Path;
use std::process::{Command, Output, Stdio};

use serde_json::Value;

use crate::error::CliError;

pub struct Docker {
    program: OsString,
    /// Say each command that changes something, as it is run.
    trace: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub struct ContainerState {
    pub status: String,
    pub health: Option<String>,
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).trim().to_string()
}

impl Docker {
    pub fn new(trace: bool) -> Self {
        Self {
            program: std::env::var_os("MARFA_DOCKER").unwrap_or_else(|| "docker".into()),
            trace,
        }
    }

    fn show(&self, words: &str) {
        if self.trace {
            eprintln!("  $ {words}");
        }
    }

    fn command(&self, args: &[&str]) -> Command {
        let mut command = Command::new(&self.program);
        command.args(args).stdin(Stdio::null());
        command
    }

    fn output(&self, args: &[&str]) -> Result<Output, CliError> {
        self.command(args).output().map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                CliError::Install(
                    "Docker is not installed. Install Docker Desktop or OrbStack on a Mac, or Docker Engine on Linux, then run this again".into(),
                )
            } else {
                CliError::Install(format!("cannot run Docker: {error}"))
            }
        })
    }

    /// The standard output of a command that must succeed.
    fn succeed(&self, args: &[&str]) -> Result<String, CliError> {
        let output = self.output(args)?;
        if output.status.success() {
            Ok(text(&output.stdout))
        } else {
            Err(failed(args, &output))
        }
    }

    /// Docker and Compose are installed and the engine answers.
    pub fn check(&self) -> Result<(), CliError> {
        let compose = self.output(&["compose", "version"])?;
        if !compose.status.success() {
            return Err(CliError::Install(
                "Docker Compose version 2 is missing: `docker compose version` fails. Update Docker, or install the Compose plugin, then run this again".into(),
            ));
        }
        let info = self.output(&["info", "--format", "{{.ServerVersion}}"])?;
        if !info.status.success() {
            return Err(CliError::Install(format!(
                "Docker is installed but its engine is not running: {}. Start Docker Desktop or OrbStack (on Linux, `sudo systemctl start docker`), then run this again",
                text(&info.stderr).lines().last().unwrap_or("no answer")
            )));
        }
        Ok(())
    }

    /// Whether the engine answers.
    pub fn running(&self) -> bool {
        self.output(&["info", "--format", "{{.ServerVersion}}"])
            .is_ok_and(|output| output.status.success())
    }

    /// Whether `docker <kind> ls` lists a thing of exactly this name. Containers
    /// call the column `Names`, volumes and networks `Name`.
    fn exists(&self, kind: &[&str], name: &str) -> Result<bool, CliError> {
        let filter = format!("name=^{name}$");
        let format = if kind[0] == "container" {
            "{{.Names}}"
        } else {
            "{{.Name}}"
        };
        let mut args = kind.to_vec();
        args.extend(["--filter", &filter, "--format", format]);
        Ok(self.succeed(&args)?.lines().any(|line| line == name))
    }

    /// The IPv4 range of a network, or `None` when there is no such network.
    pub fn network_subnet(&self, name: &str) -> Result<Option<String>, CliError> {
        if !self.exists(&["network", "ls"], name)? {
            return Ok(None);
        }
        let config = self.succeed(&[
            "network",
            "inspect",
            name,
            "--format",
            "{{json .IPAM.Config}}",
        ])?;
        subnet_of(&config).map(Some).ok_or_else(|| {
            CliError::Install(format!(
                "the Docker network {name} has no IPv4 range, so the server cannot tell which address is its proxy. Remove it with `docker network rm {name}` and run this again"
            ))
        })
    }

    /// Whether the registry has this release's image. A registry that cannot
    /// be reached says nothing, and the pull will say what is wrong.
    pub fn release_exists(&self, image: &str, release: &str) -> Result<(), CliError> {
        let reference = format!("{image}:{release}");
        let output = self.output(&["manifest", "inspect", &reference])?;
        let said = text(&output.stderr).to_lowercase();
        // The registry's own word for a tag it does not have: `manifest
        // unknown` from Docker 29 against ghcr.io, `no such manifest` from older
        // clients. Any other failure (a credential helper that is "not found",
        // no network, a denied pull) says nothing about the release.
        if !output.status.success()
            && (said.contains("manifest unknown") || said.contains("no such manifest"))
        {
            return Err(CliError::Usage(format!(
                "there is no release {release}: {reference} is not in the registry. Releases are listed at https://github.com/withmarfa/marfa/releases"
            )));
        }
        Ok(())
    }

    pub fn remove_container(&self, name: &str) -> Result<(), CliError> {
        if self.container(name)?.is_some() {
            self.show(&format!("docker rm -f {name}"));
            self.succeed(&["rm", "-f", name])?;
        }
        Ok(())
    }

    pub fn volume_exists(&self, name: &str) -> Result<bool, CliError> {
        self.exists(&["volume", "ls"], name)
    }

    /// Whether the image is already on this machine.
    pub fn image_present(&self, image: &str) -> Result<bool, CliError> {
        Ok(self
            .output(&["image", "inspect", "--format", "{{.Id}}", image])?
            .status
            .success())
    }

    pub fn create_network(&self, name: &str) -> Result<(), CliError> {
        self.show(&format!("docker network create {name}"));
        self.succeed(&["network", "create", name]).map(|_| ())
    }

    pub fn remove_network(&self, name: &str) -> Result<(), CliError> {
        if self.exists(&["network", "ls"], name)? {
            self.show(&format!("docker network rm {name}"));
            self.succeed(&["network", "rm", name])?;
        }
        Ok(())
    }

    pub fn remove_volume(&self, name: &str) -> Result<(), CliError> {
        if self.exists(&["volume", "ls"], name)? {
            self.show(&format!("docker volume rm {name}"));
            self.succeed(&["volume", "rm", name])?;
        }
        Ok(())
    }

    /// Runs `docker compose` on the project in `dir`. With `show`, Docker's
    /// own progress goes to the terminal's standard error.
    pub fn compose(&self, dir: &Path, args: &[&str], show: bool) -> Result<(), CliError> {
        self.show(&format!(
            "docker compose {}   (in {})",
            args.join(" "),
            dir.display()
        ));
        let dir_text = dir.to_string_lossy();
        let mut all = vec!["compose", "--project-directory", &dir_text];
        all.extend(args);
        let mut command = self.command(&all);
        command.current_dir(dir);
        if show {
            command.stdout(Stdio::from(std::io::stderr().as_fd().try_clone_to_owned()?));
            command.stderr(Stdio::inherit());
            let status = command
                .status()
                .map_err(|error| CliError::Install(format!("cannot run Docker: {error}")))?;
            if status.success() {
                return Ok(());
            }
            return Err(CliError::Install(format!(
                "`docker compose {}` failed (exit {})",
                args.join(" "),
                status
                    .code()
                    .map_or("signal".into(), |code| code.to_string())
            )));
        }
        let output = command
            .output()
            .map_err(|error| CliError::Install(format!("cannot run Docker: {error}")))?;
        if output.status.success() {
            Ok(())
        } else {
            Err(failed(&all, &output))
        }
    }

    pub fn container(&self, name: &str) -> Result<Option<ContainerState>, CliError> {
        if !self.exists(&["container", "ls", "-a"], name)? {
            return Ok(None);
        }
        let state = self.succeed(&["inspect", "--format", "{{json .State}}", name])?;
        let value: Value = serde_json::from_str(&state)
            .map_err(|_| CliError::Install("Docker described the container unreadably".into()))?;
        Ok(Some(ContainerState {
            status: value["Status"].as_str().unwrap_or("unknown").to_string(),
            health: value["Health"]["Status"].as_str().map(str::to_string),
        }))
    }

    /// Runs the `marfa` command inside the container, through its private
    /// socket, and reads the JSON it prints.
    pub fn marfa_json(&self, name: &str, args: &[&str]) -> Result<Value, CliError> {
        let mut all = vec![
            "exec",
            name,
            "marfa",
            "--socket",
            "/data/control/marfa.sock",
            "--json",
        ];
        all.extend(args);
        let out = self.succeed(&all)?;
        serde_json::from_str(&out).map_err(|_| {
            CliError::Install(format!(
                "the server's answer to `marfa {}` was not JSON",
                args.join(" ")
            ))
        })
    }

    pub fn logs_tail(&self, name: &str) -> String {
        self.output(&["logs", "--tail", "20", name])
            .map(|output| {
                format!("{}\n{}", text(&output.stdout), text(&output.stderr))
                    .trim()
                    .to_string()
            })
            .unwrap_or_default()
    }
}

fn failed(args: &[&str], output: &Output) -> CliError {
    let said = text(&output.stderr);
    let said = said.lines().last().unwrap_or("no message");
    CliError::Install(format!("`docker {}` failed: {said}", args.join(" ")))
}

/// The first IPv4 range in what `docker network inspect` says of `.IPAM.Config`.
pub fn subnet_of(config: &str) -> Option<String> {
    let value: Value = serde_json::from_str(config).ok()?;
    value
        .as_array()?
        .iter()
        .filter_map(|entry| entry["Subnet"].as_str())
        .find(|subnet| !subnet.contains(':'))
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_first_ipv4_range_is_the_network() {
        assert_eq!(
            subnet_of(
                r#"[{"Subnet":"fd00::/64"},{"Subnet":"192.168.117.0/24","Gateway":"192.168.117.1"}]"#
            ),
            Some("192.168.117.0/24".into())
        );
        assert_eq!(subnet_of("null"), None);
        assert_eq!(subnet_of("[]"), None);
        assert_eq!(subnet_of("nonsense"), None);
    }
}
