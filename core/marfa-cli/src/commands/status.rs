use serde_json::{Value, json};

use crate::error::CliError;
use crate::output::Printer;
use crate::remote::Remote;
use crate::remote::request::Request;

/// The root with its slash, under a path prefix too: where the generated
/// operation the working copy's contract read calls reads it.
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
    // A server on another contract is still described: saying which server
    // this is, and that it is the wrong one, is what this command is for. The
    // counts would be read on the contract, so they are not asked for.
    let instance = remote.describe(&root_request())?;
    let health = remote.describe(&health_request())?;
    let held = speaks_this_contract(&instance);
    // The counts are scoped to what the credential can read, never
    // refused to one, so a refusal here is the credential's and propagates.
    let stats = match (remote.credential(), held) {
        (Some(_), true) => Some(remote.json(&stats_request())?),
        _ => None,
    };
    let contract = contract_report(&instance);
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
            lines.push(contract_line(&instance));
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

/// Whether a root's `contract` is the one this binary was built for.
pub fn speaks_this_contract(instance: &Value) -> bool {
    instance.get("contract").and_then(Value::as_u64) == Some(marfa_client::CONTRACT_VERSION)
}

/// The contract a root answered beside the one this binary was built for,
/// as the report states both.
pub fn contract_report(instance: &Value) -> Value {
    json!({
        "served": instance.get("contract"),
        "built_for": marfa_client::CONTRACT_VERSION,
    })
}

/// What a person reads when the server speaks another contract.
pub fn contract_line(instance: &Value) -> String {
    let served = instance
        .get("contract")
        .map(Value::to_string)
        .unwrap_or_else(|| "none".into());
    format!(
        "contract {served}; this marfa was built for contract {}, so nothing past this description was read: use a marfa built for the server's contract",
        marfa_client::CONTRACT_VERSION
    )
}
