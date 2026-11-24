use crate::error::CliError;
use crate::output::Printer;
use crate::remote::{Remote, request::Request};
use clap::{Args, Subcommand};
use serde_json::{Value, json};
use std::io::{IsTerminal, Read};

#[derive(Debug, Subcommand)]
pub enum OwnerCommand {
    /// Manage the owner's registered passkeys.
    Passkeys {
        #[command(subcommand)]
        command: super::owner_passkeys::PasskeysCommand,
    },
    /// Replace the owner's password. Asks for the current password and the new
    /// one with no echo, or reads them from standard input with `--stdin`; a
    /// password is never an argument. Ends every browser sign-in and keeps
    /// keys and apps. Requires `sign_ins.manage`.
    Password(PasswordArgs),
    /// Recover the owner's password using private machine authority; revoke browser sessions.
    Recover(SecretInput),
}

#[derive(Debug, Args)]
pub struct PasswordArgs {
    /// Read a JSON object holding `current_password` and `new_password` from
    /// standard input instead of asking for them.
    #[arg(long)]
    pub stdin: bool,
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
    /// The username the owner signs in with. Required when using terminal prompts.
    #[arg(long)]
    pub username: Option<String>,
    /// The owner's email address. It plays no part in signing in.
    #[arg(long)]
    pub email: Option<String>,
    /// The owner's display name. It defaults to the username.
    #[arg(long)]
    pub name: Option<String>,
    /// Read JSON containing username, password, optional email and name, and code for a remote claim.
    #[arg(long, conflicts_with_all=["username","email","name"])]
    pub stdin: bool,
    /// The address devices sign in at, such as `https://marfa.example.com`.
    /// Private socket only. It is set on the server first, before the owner
    /// is made, so a claimed instance is never moved by it.
    #[arg(long, value_name = "URL")]
    pub address: Option<String>,
}

fn stdin_object() -> Result<Value, CliError> {
    let mut body = String::new();
    std::io::stdin().take(65_537).read_to_string(&mut body)?;
    if body.len() > 65_536 {
        return Err(CliError::Invalid("input exceeds 64 KiB".into()));
    }
    serde_json::from_str(&body)
        .map_err(|_| CliError::Invalid("expected a JSON object on stdin".into()))
}

fn terminal_only() -> Result<(), CliError> {
    if std::io::stdin().is_terminal() {
        Ok(())
    } else {
        Err(CliError::Usage(
            "use --stdin to supply a JSON object without a terminal".into(),
        ))
    }
}

fn input(stdin: bool) -> Result<Value, CliError> {
    if stdin {
        return stdin_object();
    }
    terminal_only()?;
    Ok(json!({"password":rpassword::prompt_password("New owner password: ")?}))
}

/// The current password and the new one, which a person types twice.
fn passwords(stdin: bool) -> Result<Value, CliError> {
    if stdin {
        return stdin_object();
    }
    terminal_only()?;
    let current = rpassword::prompt_password("Current password: ")?;
    let new = rpassword::prompt_password("New password: ")?;
    if rpassword::prompt_password("Repeat the new password: ")? != new {
        return Err(CliError::Usage(
            "the two new passwords differ; the password is unchanged".into(),
        ));
    }
    Ok(json!({"current_password":current,"new_password":new}))
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
        crate::errln!("Set the sign-in address to {set}.");
    }
    Ok(())
}

pub fn run(command: OwnerCommand, remote: &Remote, out: &Printer) -> Result<(), CliError> {
    match command {
        OwnerCommand::Passkeys { command } => super::owner_passkeys::run(command, remote, out),
        OwnerCommand::Password(args) => {
            if !args.stdin {
                terminal_only()?;
            }
            // Renews an app's token and stops a key without the permission before
            // anything is typed, so a later `401` is the password's refusal.
            if !remote.is_local() {
                remote.json(&Request::get(&["owner", "passkeys"]))?;
            }
            let body = passwords(args.stdin)?;
            let answer = remote.json(&Request::put(&["owner", "password"]).proving().json(body))?;
            out.report(&answer, |_| {
                "replaced the owner's password and ended every browser sign-in".to_string()
            })
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
            if !no_browser && !super::open_link(link) {
                crate::errln!("Could not open a browser; use the setup link below.");
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
                body["username"] =
                    json!(args.username.ok_or_else(|| CliError::Usage(
                        "provide --username or use --stdin".into()
                    ))?);
                if let Some(email) = args.email {
                    body["email"] = json!(email);
                }
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

#[cfg(test)]
mod tests {
    use clap::Parser;

    #[test]
    fn a_password_is_never_an_argument() {
        for words in [
            &["owner", "password", "hunter2"][..],
            &["owner", "password", "--current-password", "x"],
            &["owner", "password", "--new-password", "x"],
            &["owner", "password", "--password", "x"],
            &["owner", "recover", "hunter2"],
        ] {
            let mut argv = vec!["marfa"];
            argv.extend(words);
            assert!(
                crate::Cli::try_parse_from(&argv).is_err(),
                "{words:?} was taken"
            );
        }
        for words in [
            &["owner", "password"][..],
            &["owner", "password", "--stdin"],
        ] {
            let mut argv = vec!["marfa"];
            argv.extend(words);
            assert!(crate::Cli::try_parse_from(&argv).is_ok(), "{words:?}");
        }
    }
}
