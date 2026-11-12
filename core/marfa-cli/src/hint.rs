//! What a refusal says to a person after its own words: the way on, where the
//! cause is one the command line can tell. `--json` carries the code, status
//! and details instead, so a hint is never part of it.

use std::ffi::OsString;

use serde_json::Value;

use crate::error::CliError;
use crate::remote::{Named, Remote};

/// What the command that failed was aimed at.
pub struct Aim {
    command: String,
    args: Vec<OsString>,
    named: Named,
}

impl Aim {
    pub fn new(command: &str, args: Vec<OsString>, named: Named) -> Self {
        Self {
            command: command.to_string(),
            args,
            named,
        }
    }
}

pub fn for_error(error: &CliError, aim: &Aim) -> Option<String> {
    match error {
        CliError::Core(core) => {
            let origin = marfa_core::http::refused_origin(core)?;
            Some(not_listening(origin))
        }
        CliError::Refused {
            status: 403,
            details,
            ..
        } if details
            .as_deref()
            .and_then(|details| details.get("needs"))
            .and_then(Value::as_str)
            == Some("local") =>
        {
            Some(needs_local(aim))
        }
        CliError::Refused {
            status: 409,
            code,
            details,
            ..
        } if code == "sign_in_address_change_unconfirmed" => {
            Some(confirm_address(aim, details.as_deref()))
        }
        _ => None,
    }
}

fn not_listening(origin: &str) -> String {
    let on_this_machine =
        url::Url::parse(origin).is_ok_and(|url| marfa_telemetry::host::is_loopback(&url));
    if on_this_machine {
        "Nothing is listening at that address. Is the server running? `marfa server status` shows it, and `marfa server start` starts it.".into()
    } else {
        "Nothing answered at that address. Check the address and this machine's network.".into()
    }
}

fn needs_local(aim: &Aim) -> String {
    let prefix = Remote::url_named(&aim.named)
        .ok()
        .and_then(|origin| crate::server::socket_command_for(&origin));
    match prefix {
        Some(prefix) => {
            let mut text = format!(
                "A key or an app's sign-in cannot do this: it needs the server's private local command, which this machine can run:\n  {prefix} {}",
                same_command(&aim.args)
            );
            if ["MARFA_API_URL", "MARFA_API_KEY", crate::profiles::ENVIRONMENT]
                .iter()
                .any(|name| std::env::var(name).is_ok_and(|value| !value.is_empty()))
            {
                text.push_str(
                    "\n(--socket cannot be combined with MARFA_API_URL, MARFA_API_KEY or MARFA_PROFILE: unset them for that command.)",
                );
            }
            text
        }
        None => "A key or an app's sign-in cannot do this: it needs the server's private local command, which runs on the server's own machine, as `marfa --socket <path>` followed by this command. A server installed with `marfa server install` keeps its socket under its install folder, in data/control/marfa.sock.".into(),
    }
}

fn confirm_address(aim: &Aim, details: Option<&Value>) -> String {
    let sentences: Vec<&str> = details
        .and_then(|details| details.get("consequences"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|consequence| consequence.get("sentence").and_then(Value::as_str))
        .collect();
    let mut text = String::from(if sentences.is_empty() {
        "Nothing was changed. The server holds the change until it is confirmed."
    } else {
        "Nothing was changed. Making the change:"
    });
    for sentence in sentences {
        text.push_str(&format!("\n  - {sentence}"));
    }
    if matches!(
        aim.command.as_str(),
        "marfa config update" | "marfa config replace"
    ) {
        text.push_str("\nRun it again with --confirm-address-change to make the change.");
    } else {
        text.push_str(
            "\nSend `confirm_sign_in_address_change` set to true with the change to make it.",
        );
    }
    text
}

/// The arguments again, without the ones that name a server, which
/// `--socket` replaces, quoted for a shell.
fn same_command(args: &[OsString]) -> String {
    let mut kept = Vec::new();
    let mut words = args.iter().skip(1);
    while let Some(word) = words.next() {
        let word = word.to_string_lossy();
        if matches!(word.as_ref(), "--url" | "--key" | "--profile") {
            words.next();
        } else if ["--url=", "--key=", "--profile="]
            .iter()
            .any(|flag| word.starts_with(flag))
        {
        } else {
            kept.push(shell_word(&word));
        }
    }
    kept.join(" ")
}

pub(crate) fn shell_word(word: &str) -> String {
    let plain = !word.is_empty()
        && word
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "_@%+=:,./-".contains(c));
    if plain {
        word.to_string()
    } else {
        format!("'{}'", word.replace('\'', r"'\''"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(line: &[&str]) -> Vec<OsString> {
        line.iter().map(OsString::from).collect()
    }

    #[test]
    fn the_command_is_repeated_without_the_server_it_named_and_quoted() {
        let line = words(&[
            "marfa",
            "--url",
            "http://localhost:8600",
            "items",
            "--profile=work",
            "trash",
            "list",
            "--query",
            "it's here",
        ]);
        assert_eq!(
            same_command(&line),
            "items trash list --query 'it'\\''s here'"
        );
    }

    #[test]
    fn a_refused_connection_names_the_way_on_by_where_the_server_is() {
        let here = not_listening("http://localhost:8600");
        assert!(here.contains("marfa server status"), "{here}");
        let there = not_listening("https://marfa.example.com");
        assert!(!there.contains("marfa server"), "{there}");
        assert!(there.contains("address"), "{there}");
    }
}
