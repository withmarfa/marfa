use crate::error::CliError;
use crate::output::Printer;
use crate::remote::{Remote, request::Request};
use clap::{Args, Subcommand};
use serde_json::{Value, json};
use std::io::{IsTerminal, Read};

#[derive(Debug, Subcommand)]
pub enum OwnerCommand {
    /// Show the instance's owner.
    Show,
    /// Recover the owner's password using private machine authority; revoke browser sessions.
    Recover(SecretInput),
}

#[derive(Debug, Args)]
pub struct SecretInput {
    /// Read a JSON object containing password from standard input instead of a hidden prompt.
    #[arg(long)]
    pub stdin: bool,
}

#[derive(Debug, Subcommand)]
pub enum SetupCommand {
    /// Show whether this instance has been claimed (private socket required).
    Status,
    /// Replace the setup code and invalidate earlier setup sessions (private socket required).
    Code,
    /// Issue a single-use browser handoff and open it (private socket required).
    Open {
        /// Print the handoff link without opening a browser.
        #[arg(long)]
        no_browser: bool,
    },
    /// Claim the instance. Password and remote setup code use hidden prompts or structured stdin.
    Claim(ClaimArgs),
}

#[derive(Debug, Args)]
pub struct ClaimArgs {
    /// The owner's email address. Required when using terminal prompts.
    #[arg(long)]
    pub email: Option<String>,
    /// The owner's display name.
    #[arg(long)]
    pub name: Option<String>,
    /// Read JSON containing email, password, optional name, and code for a remote claim.
    #[arg(long, conflicts_with_all=["email","name"])]
    pub stdin: bool,
}

fn input(stdin: bool) -> Result<Value, CliError> {
    if stdin {
        let mut body = String::new();
        std::io::stdin().take(65_537).read_to_string(&mut body)?;
        if body.len() > 65_536 {
            return Err(CliError::Invalid("input exceeds 64 KiB".into()));
        }
        return serde_json::from_str(&body)
            .map_err(|_| CliError::Invalid("expected a JSON object on stdin".into()));
    }
    if !std::io::stdin().is_terminal() {
        return Err(CliError::Usage(
            "use --stdin to supply a JSON object without a terminal".into(),
        ));
    }
    Ok(json!({"password":rpassword::prompt_password("New owner password: ")?}))
}

fn require_local(remote: &Remote) -> Result<(), CliError> {
    if remote.is_local() {
        Ok(())
    } else {
        Err(CliError::Usage(
            "this operation requires --socket PATH".into(),
        ))
    }
}

pub fn run(command: OwnerCommand, remote: &Remote, out: &Printer) -> Result<(), CliError> {
    match command {
        OwnerCommand::Show => out.value(&remote.json(&Request::get(&["owner"]))?),
        OwnerCommand::Recover(args) => {
            require_local(remote)?;
            let body = input(args.stdin)?;
            out.value(&remote.json(&Request::post(&["_control", "owner", "recover"]).json(body))?)
        }
    }
}

pub fn setup(command: SetupCommand, remote: &Remote, out: &Printer) -> Result<(), CliError> {
    match command {
        SetupCommand::Status => {
            require_local(remote)?;
            out.value(&remote.json(&Request::get(&["_control", "setup", "status"]))?)
        }
        SetupCommand::Code => {
            require_local(remote)?;
            out.value(&remote.json(&Request::post(&["_control", "setup", "code"]))?)
        }
        SetupCommand::Open { no_browser } => {
            require_local(remote)?;
            let result = remote.json(&Request::post(&["_control", "setup", "ticket"]))?;
            let link = result
                .get("url")
                .and_then(Value::as_str)
                .ok_or_else(|| CliError::Invalid("server returned no setup link".into()))?;
            if !no_browser {
                let command = if cfg!(target_os = "macos") {
                    "open"
                } else {
                    "xdg-open"
                };
                let status = std::process::Command::new(command).arg(link).status();
                if !status.is_ok_and(|status| status.success()) {
                    eprintln!("Could not open a browser; use the setup link below.");
                }
            }
            out.value(&result)
        }
        SetupCommand::Claim(args) => {
            if !remote.is_local() {
                let url = url::Url::parse(remote.url())
                    .map_err(|_| CliError::Invalid("invalid setup URL".into()))?;
                let loopback = match url.host() {
                    Some(url::Host::Domain("localhost")) => true,
                    Some(url::Host::Ipv4(address)) => address.is_loopback(),
                    Some(url::Host::Ipv6(address)) => address.is_loopback(),
                    _ => false,
                };
                if url.scheme() != "https" && !loopback {
                    return Err(CliError::Usage(
                        "setup requires HTTPS, except on loopback".into(),
                    ));
                }
            }
            let mut body = input(args.stdin)?;
            if !args.stdin {
                body["email"] = json!(
                    args.email
                        .ok_or_else(|| CliError::Usage("provide --email or use --stdin".into()))?
                );
                if let Some(name) = args.name {
                    body["name"] = json!(name);
                }
                if !remote.is_local() {
                    body["code"] = json!(rpassword::prompt_password("Setup code: ")?);
                }
            }
            let path = if remote.is_local() {
                vec!["_control", "setup", "claim"]
            } else {
                vec!["owner"]
            };
            out.value(&remote.json(&Request::post(&path).public().json(body))?)
        }
    }
}
