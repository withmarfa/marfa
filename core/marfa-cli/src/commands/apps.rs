use clap::Subcommand;
use serde_json::{Value, json};

use crate::error::CliError;
use crate::output::Printer;
use crate::remote::{Remote, request::Request};

#[derive(Debug, Subcommand)]
pub enum AppsCommand {
    /// List approved apps. Requires grants.manage or private machine authority.
    List,
    /// Reduce an app's access. Ends tokens and refresh chains that exceed it.
    /// Requires private machine authority (--socket).
    Narrow {
        /// The app grant's ID.
        id: String,
        /// One scope to keep; repeat for the complete resulting set.
        #[arg(long, required_unless_present = "clear", conflicts_with = "clear")]
        scope: Vec<String>,
        /// Remove every scope.
        #[arg(long)]
        clear: bool,
    },
    /// End an app's grant. Requires grants.manage or private machine authority.
    Disconnect {
        /// The app grant's ID.
        id: String,
        /// Also revoke keys the app minted.
        #[arg(long)]
        revoke_keys: bool,
    },
}

pub fn list_request() -> Request {
    Request::get(&["auth", "grants"])
}

pub fn narrow_request(id: &str, scopes: &[String], expected: &Value) -> Request {
    Request::patch(&["auth", "grants", id])
        .json(json!({ "scopes": scopes, "expected_scopes": expected }))
}

pub fn disconnect_request(id: &str, revoke_keys: bool) -> Request {
    Request::delete(&["auth", "grants", id]).query_flag("revoke_keys", revoke_keys)
}

pub fn run(command: AppsCommand, remote: &Remote, out: &Printer) -> Result<(), CliError> {
    match command {
        AppsCommand::List => out.value(&remote.json(&list_request())?),
        AppsCommand::Narrow { id, scope, .. } => {
            let listed = remote.json(&list_request())?;
            let expected = listed
                .get("data")
                .and_then(Value::as_array)
                .and_then(|rows| {
                    rows.iter()
                        .find(|row| row.get("id").and_then(Value::as_str) == Some(id.as_str()))
                })
                .and_then(|row| row.get("scopes"))
                .cloned()
                .unwrap_or(json!([]));
            out.value(&remote.json(&narrow_request(&id, &scope, &expected))?)
        }
        AppsCommand::Disconnect { id, revoke_keys } => {
            out.value(&remote.json(&disconnect_request(&id, revoke_keys))?)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sends_the_complete_choice_and_the_grant_seen_before_it() {
        let req = narrow_request(
            "app-1",
            &["core.note:read".into()],
            &json!(["core.note:write"]),
        );
        assert_eq!(req.segments, ["auth", "grants", "app-1"]);
        assert_eq!(
            req.body,
            crate::remote::request::Body::Json(
                json!({"scopes":["core.note:read"], "expected_scopes":["core.note:write"]})
            )
        );
    }
}
