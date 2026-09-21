use serde_json::{Value, json};

use crate::error::CliError;
use crate::output::Printer;
use crate::remote::Remote;
use crate::remote::request::Request;

pub fn root_request() -> Request {
    Request::get(&[]).public()
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
    let stats = match remote.credential() {
        Some(_) => match remote.json(&stats_request()) {
            Ok(stats) => Some(stats),
            // A credential without reach to the counts is still a credential;
            // the counts are the part that goes, and the answer says so.
            Err(CliError::Refused {
                status: 401 | 403, ..
            }) => None,
            Err(error) => return Err(error),
        },
        None => None,
    };
    let report = json!({
        "server": remote.origin(),
        "instance": instance,
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
        match (&stats, remote.credential()) {
            (Some(stats), Some(source)) => {
                lines.push(format!("credential from {}", source.as_str()));
                lines.push(format!(
                    "items {}",
                    serde_json::to_string(stats).unwrap_or_default()
                ));
            }
            (None, Some(source)) => {
                lines.push(format!(
                    "credential from {}, without reach to the item counts",
                    source.as_str()
                ));
            }
            (_, None) => lines.push("no credential".into()),
        }
        lines.join("\n")
    })
}
