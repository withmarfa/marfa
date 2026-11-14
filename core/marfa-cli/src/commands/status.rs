use serde_json::{Value, json};

use crate::error::CliError;
use crate::output::{Printer, printable};
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
    // A key may reach no type, so its counts are refused; the
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
    out.report(&report, |_| {
        let field = |value: &Value, name: &str| {
            value
                .get(name)
                .map(|value| match value {
                    Value::String(text) => printable(text),
                    other => printable(&other.to_string()),
                })
                .unwrap_or_default()
        };
        let mut lines = vec![
            format!("server {}", remote.origin()),
            instance_line(&instance),
            format!("health {}", field(&health, "status")),
        ];
        if !held {
            lines.push(contract_line(&instance));
        }
        match (&stats, remote.credential()) {
            (Some(stats), Some(source)) => {
                lines.push(format!("credential from {}", source.as_str()));
                lines.push(items_line(stats));
            }
            (None, Some(source)) if stats_refused.is_some() => {
                lines.push(format!("credential from {}", source.as_str()));
                lines.push("this credential's type permissions reach no type".into());
            }
            _ => lines.push("no credential".into()),
        }
        lines.join("\n")
    })
}

/// How many items there are in each state, or that there are none.
pub fn items_line(stats: &Value) -> String {
    let counted: Vec<String> = stats
        .as_object()
        .into_iter()
        .flatten()
        .filter_map(|(state, count)| {
            let count = count.as_u64().filter(|count| *count > 0)?;
            Some(match state.as_str() {
                "trashed" => format!("{count} in the bin"),
                state => format!("{count} {}", printable(state)),
            })
        })
        .collect();
    if counted.is_empty() {
        "no items".to_string()
    } else {
        format!("items {}", counted.join(", "))
    }
}

/// The instance as a line: its id, its name and the release it runs, or the
/// build when it is not a release.
pub fn instance_line(instance: &Value) -> String {
    let text = |name: &str| match instance.get(name) {
        Some(Value::String(text)) => printable(text),
        Some(other) => printable(&other.to_string()),
        None => String::new(),
    };
    let running = match instance.get("release").and_then(Value::as_str) {
        Some(release) => format!("{}, build {}", printable(release), text("version")),
        None => text("version"),
    };
    format!(
        "instance {} ({} {})",
        text("instance_id"),
        text("name"),
        running
    )
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
        Some(Value::String(served)) => printable(served),
        Some(served) => printable(&served.to_string()),
        None => "none".into(),
    };
    format!(
        "contract {served}; this marfa was built for contract {}, so nothing past this description was read: use a marfa built for the server's contract",
        marfa_core::contract::CONTRACT_VERSION
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_instance_says_it_has_no_items_and_a_busy_one_counts_by_state() {
        assert_eq!(items_line(&json!({})), "no items");
        assert_eq!(items_line(&json!({"active": 0})), "no items");
        assert_eq!(
            items_line(&json!({"active": 2, "archived": 1, "trashed": 3})),
            "items 2 active, 1 archived, 3 in the bin"
        );
    }

    #[test]
    fn names_the_release_beside_the_build() {
        let instance = json!({
            "name": "Marfa", "version": "abc123", "release": "0.0.14",
            "instance_id": "id-1", "contract": 0, "features": []
        });
        assert_eq!(
            instance_line(&instance),
            "instance id-1 (Marfa 0.0.14, build abc123)"
        );
    }

    #[test]
    fn names_only_the_build_when_the_server_is_not_a_release() {
        let instance = json!({
            "name": "Marfa", "version": "dev", "instance_id": "id-1",
            "contract": 0, "features": []
        });
        assert_eq!(instance_line(&instance), "instance id-1 (Marfa dev)");
    }
}
