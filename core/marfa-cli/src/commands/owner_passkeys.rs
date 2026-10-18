use crate::error::CliError;
use crate::output::{Printer, printable};
use crate::remote::{Remote, request::Request};
use clap::Subcommand;
use serde_json::{Value, json};

#[derive(Debug, Subcommand)]
pub enum PasskeysCommand {
    /// List every registered owner passkey (private socket required).
    List,
    /// Rename one owner passkey (private socket required).
    Rename {
        /// The passkey's ID.
        id: String,
        /// The new name. Spaces at each end are trimmed.
        #[arg(long, allow_hyphen_values = true)]
        name: String,
    },
    /// Remove one passkey. Existing sign-ins and other passkeys stay usable (private socket required).
    Remove {
        /// The passkey's ID.
        id: String,
    },
    /// Open the owner's passkey page through a fresh browser sign-in (private socket required).
    Add {
        /// Print the sign-in URL without opening a browser.
        #[arg(long)]
        no_browser: bool,
    },
}

pub fn run(command: PasskeysCommand, remote: &Remote, out: &Printer) -> Result<(), CliError> {
    if !remote.is_local() {
        return Err(CliError::Usage(
            "this operation requires --socket PATH".into(),
        ));
    }
    match command {
        PasskeysCommand::List => {
            let answer = remote.json(&Request::get(&["owner", "passkeys"]))?;
            out.report(&answer, || listing(&answer))
        }
        PasskeysCommand::Rename { id, name } => out.value(
            &remote
                .json(&Request::patch(&["owner", "passkeys", &id]).json(json!({"name":name})))?,
        ),
        PasskeysCommand::Remove { id } => {
            out.value(&remote.json(&Request::delete(&["owner", "passkeys", &id]))?)
        }
        PasskeysCommand::Add { no_browser } => {
            let answer =
                remote.json(&Request::get(&["_control", "owner", "passkeys", "add-url"]))?;
            let link = answer.get("url").and_then(Value::as_str).ok_or_else(|| {
                CliError::Invalid("server returned no passkey sign-in URL".into())
            })?;
            if !no_browser {
                let command = if cfg!(target_os = "macos") {
                    "open"
                } else {
                    "xdg-open"
                };
                if !std::process::Command::new(command)
                    .arg(link)
                    .status()
                    .is_ok_and(|s| s.success())
                {
                    eprintln!("Could not open a browser; use the sign-in URL below.");
                }
            }
            out.report(&answer, || link.to_string())
        }
    }
}

fn listing(answer: &Value) -> String {
    let rows = answer
        .get("data")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    if rows.is_empty() {
        return "no passkeys".into();
    }
    rows.iter()
        .map(|row| {
            let text = |field| printable(row.get(field).and_then(Value::as_str).unwrap_or(""));
            let name = row
                .get("name")
                .and_then(Value::as_str)
                .map(printable)
                .unwrap_or_else(|| "Unnamed passkey".into());
            format!("{}  {}  created {}", text("id"), name, text("created_at"))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn listing_preserves_unnamed_keys_and_escapes_names() {
        assert_eq!(
            listing(&json!({"data":[{"id":"p1","name":null,"created_at":"2026-10-18"}]})),
            "p1  Unnamed passkey  created 2026-10-18"
        );
        assert_eq!(listing(&json!({"data":[]})), "no passkeys");
        assert!(!listing(&json!({"data":[{"id":"p1","name":"bad\rname\u{202e}"}]})).contains('\r'));
    }
    #[test]
    fn rename_requires_a_name_option_and_accepts_hyphens() {
        use clap::Parser;
        assert!(
            crate::Cli::try_parse_from(["marfa", "owner", "passkeys", "rename", "p1", "Studio"])
                .is_err()
        );
        let cli = crate::Cli::try_parse_from([
            "marfa", "owner", "passkeys", "rename", "p1", "--name", "-studio-",
        ])
        .unwrap();
        assert!(
            matches!(cli.command,crate::Command::Owner{command:super::super::owner::OwnerCommand::Passkeys{command:PasskeysCommand::Rename{id,name}}} if id=="p1" && name=="-studio-")
        );
    }
}
