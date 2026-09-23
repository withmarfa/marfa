use serde_json::{Value, json};

use crate::error::CliError;
use crate::output::Printer;
use crate::remote::Remote;
use crate::remote::request::Request;

/// The root with its slash, under a path prefix too: where the generated
/// operation the contract gate calls reads it.
pub fn root_request() -> Request {
    Request::get(&[""]).public()
}

pub fn health_request() -> Request {
    Request::get(&["health"]).public()
}

pub fn stats_request() -> Request {
    Request::get(&["items", "stats"])
}

/// What the instance says about itself, with counts where a credential
/// reaches them.
pub fn run(remote: &Remote, out: &Printer) -> Result<(), CliError> {
    let instance = remote.json(&root_request())?;
    let health = remote.json(&health_request())?;
    // A server on another contract is still described: saying which server
    // this is, and that it is the wrong one, is what this command is for. The
    // counts need the credential, so they are not asked for.
    let held = match remote.credential() {
        Some(_) => match remote.hold_contract() {
            Ok(()) => true,
            Err(CliError::ContractMismatch { .. }) => false,
            Err(error) => return Err(error),
        },
        None => true,
    };
    // The counts are scoped to what the credential can read, never
    // refused to one, so a refusal here is the credential's and propagates.
    let stats = match (remote.credential(), held) {
        (Some(_), true) => Some(remote.json(&stats_request())?),
        _ => None,
    };
    let contract = json!({
        "served": instance.get("contract"),
        "built_for": marfa_client::CONTRACT_VERSION,
    });
    let report = json!({
        "server": remote.origin(),
        "instance": instance,
        "contract": contract,
        "health": health,
        "stats": stats,
        "credential": remote.credential().map(|source| source.as_str()),
    });
    out.report(&report, || {
        let field = |value: &Value, name: &str| {
            value
                .get(name)
                .map(|value| match value {
                    Value::String(text) => text.clone(),
                    other => other.to_string(),
                })
                .unwrap_or_default()
        };
        let mut lines = vec![
            format!("server {}", remote.origin()),
            format!(
                "instance {} ({} {})",
                field(&instance, "instance_id"),
                field(&instance, "name"),
                field(&instance, "version")
            ),
            format!("health {}", field(&health, "status")),
        ];
        if !held {
            lines.push(format!(
                "contract {}; this marfa was built for contract {}, so nothing that carries the credential was sent",
                field(&instance, "contract"),
                marfa_client::CONTRACT_VERSION
            ));
        }
        match (&stats, remote.credential()) {
            (Some(stats), Some(source)) => {
                lines.push(format!("credential from {}", source.as_str()));
                lines.push(format!(
                    "items {}",
                    serde_json::to_string(stats).unwrap_or_default()
                ));
            }
            _ => lines.push("no credential".into()),
        }
        lines.join("\n")
    })
}
