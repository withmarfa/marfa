use crate::error::CliError;
use crate::output::Printer;
use crate::remote::{Remote, request::Request};
use clap::{Args, Subcommand};
use serde_json::{Value, json};
use std::io::{IsTerminal, Read};
use std::path::PathBuf;

#[derive(Debug, Subcommand)]
pub enum OwnerCommand {
    /// Show the instance's owner.
    Show,
    /// Manage the owner's registered passkeys using private machine authority.
    Passkeys {
        #[command(subcommand)]
        command: super::owner_passkeys::PasskeysCommand,
    },
    /// Recover the owner's password using private machine authority; revoke browser sessions.
    Recover(SecretInput),
    /// Change the owner's email, display name, or picture (private socket required).
    Update(OwnerUpdateArgs),
    /// Fetch the owner's picture.
    Picture {
        /// Where to write the picture. Omitted, its bytes go to stdout.
        #[arg(long, value_name = "PATH")]
        output: Option<PathBuf>,
    },
}

#[derive(Debug, Args)]
#[group(required = true)]
pub struct OwnerUpdateArgs {
    /// The email address the owner uses to sign in.
    #[arg(long)]
    email: Option<String>,
    /// The owner's display name.
    #[arg(long)]
    name: Option<String>,
    /// A PNG, JPEG or WebP picture file of 2 MiB or less. The server decides the kind from the bytes.
    #[arg(long, value_name = "FILE", conflicts_with = "clear_avatar")]
    avatar: Option<PathBuf>,
    /// Remove the owner's picture.
    #[arg(long)]
    clear_avatar: bool,
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
        /// The address devices sign in at, such as `https://marfa.example.com`.
        /// The server holds it, and the link is at it, so it is set first,
        /// unless the instance is claimed: an owner's instance keeps the
        /// address its owner signs in at.
        #[arg(long, value_name = "URL")]
        address: Option<String>,
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
    /// The address devices sign in at, such as `https://marfa.example.com`.
    /// Private socket only. It is set on the server first, before the owner
    /// is made, so a claimed instance is never moved by it.
    #[arg(long, value_name = "URL")]
    pub address: Option<String>,
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

/// Sets the sign-in address before the link or the claim that depends on it,
/// on an instance that is not claimed. Giving the address is the confirmation
/// of the move; an owner's instance keeps the address its owner signs in at.
fn set_address(remote: &Remote, address: Option<&str>, out: &Printer) -> Result<(), CliError> {
    let Some(address) = address else {
        return Ok(());
    };
    let status = remote.json(&Request::get(&["_control", "setup", "status"]))?;
    if status.get("claimed").and_then(Value::as_bool) != Some(false) {
        return Ok(());
    }
    if let Some(set) = crate::server::address::ensure(remote, address)?
        && !out.json
    {
        eprintln!("Set the sign-in address to {set}.");
    }
    Ok(())
}

pub fn run(command: OwnerCommand, remote: &Remote, out: &Printer) -> Result<(), CliError> {
    match command {
        OwnerCommand::Passkeys { command } => super::owner_passkeys::run(command, remote, out),
        OwnerCommand::Show => out.value(&remote.json(&Request::get(&["owner"]))?),
        OwnerCommand::Picture { output } => {
            let (content_type, mut reader) =
                remote.stream(&Request::get(&["owner", "picture"]).streamed())?;
            let written = super::blobs::save(&mut reader, output.as_deref())?;
            // Bytes to stdout are the answer; a report there would corrupt it.
            if let Some(path) = output {
                out.report(
                    &json!({ "path": path, "size_bytes": written, "mime_type": content_type }),
                    || {
                        format!(
                            "{} byte(s) of {content_type} into {}",
                            written,
                            path.display()
                        )
                    },
                )?;
            }
            Ok(())
        }
        OwnerCommand::Update(args) => {
            require_local(remote)?;
            let picture = match &args.avatar {
                Some(file) => Some(super::profile::picture_request(
                    &["owner", "picture"],
                    file,
                )?),
                None => None,
            };
            let mut body = serde_json::Map::new();
            if let Some(email) = args.email {
                body.insert("email".into(), json!(email));
            }
            if let Some(name) = args.name {
                body.insert("name".into(), json!(name));
            }
            if args.clear_avatar {
                body.insert("avatar".into(), Value::Null);
            }
            // The picture goes first: the server may refuse it, and a refusal
            // then leaves the email and name as they were.
            let mut reply = None;
            if let Some(request) = picture {
                reply = Some(remote.json(&request)?);
            }
            if !body.is_empty() {
                reply = Some(remote.json(&Request::patch(&["owner"]).json(Value::Object(body)))?);
            }
            match reply {
                Some(reply) => out.value(&reply),
                None => Ok(()),
            }
        }
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
        SetupCommand::Open {
            no_browser,
            address,
        } => {
            require_local(remote)?;
            if let Some(address) = &address {
                crate::server::address::normalise(address)?;
            }
            set_address(remote, address.as_deref(), out)?;
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
            if let Some(address) = &args.address {
                require_local(remote)?;
                crate::server::address::normalise(address)?;
            }
            if !remote.is_local() {
                let url = url::Url::parse(remote.url())
                    .map_err(|_| CliError::Invalid("invalid setup URL".into()))?;
                if url.scheme() != "https" && !marfa_telemetry::host::is_loopback(&url) {
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
            // The address moves only once the claim's input is gathered, so
            // input this command refuses never moves it. A claim the server
            // then refuses leaves the address moved.
            set_address(remote, args.address.as_deref(), out)?;
            let path = if remote.is_local() {
                vec!["_control", "setup", "claim"]
            } else {
                vec!["owner"]
            };
            out.value(&remote.json(&Request::post(&path).public().json(body))?)
        }
    }
}
