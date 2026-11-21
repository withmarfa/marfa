use clap::Subcommand;
use serde_json::{Value, json};

use crate::error::CliError;
use crate::output::Printer;
use crate::remote::Remote;
use crate::remote::request::Request;

#[derive(Debug, Subcommand)]
pub enum HostsCommand {
    /// Make a connector host, a machine that runs connectors, and print its one-time link. Give the link to the host program once, within 15 minutes. Requires `connectors.manage`.
    Add {
        /// The name people see for the host, such as the machine's.
        name: String,
    },
    /// Every connector host, with the connectors assigned to each. Requires `connectors.manage`.
    List,
    /// One connector host, with the connectors assigned to it. Requires `connectors.manage`.
    Get {
        /// The host's ID or name.
        host: String,
    },
    /// Make a fresh one-time link for a host, to move it to a new machine. Redeeming it revokes the host's key. Requires `connectors.manage`.
    Link {
        /// The host's ID or name.
        host: String,
    },
    /// Remove a host: revoke its key and every connector key it minted, and assign its connectors to no host. Requires `connectors.manage`.
    Remove {
        /// The host's ID or name.
        host: String,
    },
}

pub fn list_request() -> Request {
    Request::get(&["connector-hosts"])
}

/// A host named by its ID, or by a name exactly one host has.
pub fn resolve(remote: &Remote, host: &str) -> Result<String, CliError> {
    if marfa_rules::validation::id("host", host).is_ok() {
        return Ok(host.to_string());
    }
    let listed = remote.json(&list_request())?;
    let named: Vec<&str> = listed["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|held| held["name"].as_str() == Some(host.trim()))
        .filter_map(|held| held["id"].as_str())
        .collect();
    match named[..] {
        [id] => Ok(id.to_string()),
        [] => Err(CliError::Invalid(format!(
            "no connector host is named {host}; `marfa hosts list` shows them"
        ))),
        _ => Err(CliError::Invalid(format!(
            "{} connector hosts are named {host}; name one by its ID",
            named.len()
        ))),
    }
}

pub fn run(command: HostsCommand, remote: &Remote, out: &Printer) -> Result<(), CliError> {
    match command {
        HostsCommand::Add { name } => {
            let answer = remote.json(&Request::post(&["connector-hosts"]).json(json!({ "name": name })))?;
            out.report(&answer, linked_words)
        }
        HostsCommand::List => out.value(&remote.json(&list_request())?),
        HostsCommand::Get { host } => {
            let id = resolve(remote, &host)?;
            out.value(&remote.json(&Request::get(&["connector-hosts", &id]))?)
        }
        HostsCommand::Link { host } => {
            let id = resolve(remote, &host)?;
            let answer = remote.json(&Request::post(&["connector-hosts", &id, "link"]))?;
            out.report(&answer, linked_words)
        }
        HostsCommand::Remove { host } => {
            let id = resolve(remote, &host)?;
            let answer = remote.json(&Request::delete(&["connector-hosts", &id]))?;
            out.report(&answer, removed_words)
        }
    }
}

fn linked_words(answer: &Value) -> String {
    let text = |value: &Value| value.as_str().unwrap_or_default().to_string();
    format!(
        "host {} ({}); give this link to the host program once, before {}:\n{}",
        text(&answer["host"]["name"]),
        text(&answer["host"]["id"]),
        text(&answer["expires_at"]),
        text(&answer["link"]),
    )
}

fn removed_words(answer: &Value) -> String {
    let keys = answer["revoked_keys"].as_u64().unwrap_or_default();
    let unassigned: Vec<&str> = answer["unassigned"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    let mut said = format!(
        "removed host {}; revoked {keys} {}",
        answer["removed"]["name"].as_str().unwrap_or_default(),
        if keys == 1 { "key" } else { "keys" }
    );
    if !unassigned.is_empty() {
        said.push_str(&format!(
            "; these connectors now run on no host: {}",
            unassigned.join(", ")
        ));
    }
    said
}
