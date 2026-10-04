use serde_json::{Value, json};

use crate::error::CliError;
use crate::output::Printer;
use crate::remote::Remote;
use crate::remote::request::Request;

/// The root with its slash: under a path prefix, the root is the prefix's own
/// directory, and the bare prefix is a different address to a proxy.
pub fn root_request() -> Request {
    Request::get(&[""]).public()
}

pub fn health_request() -> Request {
    Request::get(&["health"]).public()
}

pub fn stats_request() -> Request {
    Request::get(&["items", "stats"])
}

pub fn run(remote: &Remote, out: &Printer) -> Result<(), CliError> {
    // Read on any contract: saying the server is the wrong one is this
    // command's job.
    let instance = remote.root()?;
    let health = remote.health()?;
    let held = speaks_this_contract(&instance);
    // The operator key reaches no type, so its counts are refused; the
    // description still stands.
    let mut stats_refused = None;
    let stats = match (remote.credential(), held) {
        (Some(_), true) => match remote.json(&stats_request()) {
            Ok(stats) => Some(stats),
            Err(CliError::Refused { code, .. }) if code == "type_not_permitted" => {
                stats_refused = Some(code);
                None
            }
            Err(error) => return Err(error),
        },
        _ => None,
    };
    let contract = contract_report(&instance);
    let report = json!({
        "server": remote.origin(),
        "instance": instance,
        "contract": contract,
        "health": health,
        "stats": stats,
        "stats_refused": stats_refused,
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
            (None, Some(source)) if stats_refused.is_some() => {
                lines.push(format!("credential from {}", source.as_str()));
                lines.push(
                    "items need a working key: this credential's type permissions reach no type; the operator key mints one with `marfa keys create`".into(),
                );
            }
            _ => lines.push("no credential".into()),
        }
        lines.join("\n")
    })
}

pub fn speaks_this_contract(instance: &Value) -> bool {
    instance.get("contract").and_then(Value::as_u64) == Some(marfa_core::contract::CONTRACT_VERSION)
}

pub fn contract_report(instance: &Value) -> Value {
    json!({
        "served": instance.get("contract"),
        "built_for": marfa_core::contract::CONTRACT_VERSION,
    })
}

pub fn contract_line(instance: &Value) -> String {
    let served = match instance.get("contract") {
        Some(Value::String(served)) => served.clone(),
        Some(served) => served.to_string(),
        None => "none".into(),
    };
    format!(
        "contract {served}; this marfa was built for contract {}, so nothing past this description was read: use a marfa built for the server's contract",
        marfa_core::contract::CONTRACT_VERSION
    )
}
