use std::io::{IsTerminal, Read};

use clap::{Args, Subcommand};
use serde_json::json;

use crate::error::CliError;
use crate::output::Printer;
use crate::remote::Remote;
use crate::remote::request::Request;

/// The owner: the one account behind the instance's sign-in surface.
#[derive(Debug, Subcommand)]
pub enum OwnerCommand {
    /// Who owns this instance. Operator key.
    Show,
    /// Create the owner, once. The password is asked for on the terminal,
    /// or read from stdin with --password-stdin; it is never an argument.
    /// Operator key.
    Create(CreateArgs),
}

#[derive(Debug, Args)]
pub struct CreateArgs {
    /// The owner's email address, which is what they sign in with.
    #[arg(long, value_name = "EMAIL")]
    pub email: String,
    /// A display name. The address's local part when absent.
    #[arg(long, value_name = "NAME")]
    pub name: Option<String>,
    /// Read the password from stdin (the first line) instead of the terminal.
    #[arg(long)]
    pub password_stdin: bool,
}

pub fn run(command: OwnerCommand, remote: &Remote, out: &Printer) -> Result<(), CliError> {
    match command {
        OwnerCommand::Show => out.value(&remote.json(&Request::get(&["owner"]))?),
        OwnerCommand::Create(args) => {
            let password = read_password(args.password_stdin)?;
            let mut body = json!({ "email": args.email, "password": password });
            if let Some(name) = args.name {
                body["name"] = json!(name);
            }
            let created = remote.json(&Request::post(&["owner"]).json(body))?;
            out.report(&created, || {
                format!(
                    "created the owner {} on {}",
                    created.get("email").and_then(|v| v.as_str()).unwrap_or(""),
                    remote.origin()
                )
            })
        }
    }
}

/// The password, from stdin when asked or from the terminal otherwise; a
/// process with neither is told to use --password-stdin rather than left
/// hanging on a prompt nobody sees.
fn read_password(from_stdin: bool) -> Result<String, CliError> {
    let password = if from_stdin {
        let mut text = String::new();
        std::io::stdin().read_to_string(&mut text)?;
        text.lines().next().unwrap_or("").to_string()
    } else {
        if !std::io::stdin().is_terminal() {
            return Err(CliError::Invalid(
                "no terminal to ask for the password on: pass --password-stdin and write it on stdin"
                    .into(),
            ));
        }
        rpassword::prompt_password("Password for the owner: ")?
    };
    if password.is_empty() {
        return Err(CliError::Invalid("the password is empty".into()));
    }
    Ok(password)
}
