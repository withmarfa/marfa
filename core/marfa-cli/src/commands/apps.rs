use clap::Subcommand;
use serde_json::{Value, json};

use crate::error::CliError;
use crate::output::Printer;
use crate::remote::{Remote, request::Request};

#[derive(Debug, Subcommand)]
pub enum AppsCommand {
    /// List approved apps. Requires `grants.manage`.
    List,
    /// Reduce an app's access. Ends tokens and refresh chains that exceed it.
    /// Requires `grants.manage`.
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
    /// End an app's grant. Requires `grants.manage`.
    Revoke {
        /// The app grant's ID.
        id: String,
        /// Also revoke every key the app minted, and every key those keys
        /// minted, but an owner's key.
        #[arg(long)]
        revoke_keys: bool,
    },
    /// The `app.<vendor>` namespaces apps hold. An app holds the namespace it
    /// registered the first type under; the owner holds one no single app is
    /// known to have made, until they give it to an app. Requires
    /// `grants.manage`.
    Vendors {
        #[command(subcommand)]
        command: VendorsCommand,
    },
}

#[derive(Debug, Subcommand)]
pub enum VendorsCommand {
    /// List each vendor and the client ID of the app that holds it, or `null`
    /// for one the owner holds and has not given to an app.
    List,
    /// Give a vendor to an app, such as one that registered again and got a
    /// new client ID, or one the owner holds. The app named then reaches the
    /// vendor's items in place of whoever held it. Only the owner's own
    /// credentials may: an app's sign-in or a key an app made is refused.
    Move {
        /// The namespace, such as `app.acme`.
        vendor: String,
        /// The client ID of the app to give it to, as `marfa apps list` shows it.
        client_id: String,
    },
}

pub fn list_request() -> Request {
    Request::get(&["grants"])
}

pub fn narrow_request(id: &str, scopes: &[String], expected: &Value) -> Request {
    Request::patch(&["grants", id]).json(json!({ "scopes": scopes, "expected_scopes": expected }))
}

pub fn revoke_request(id: &str, revoke_keys: bool) -> Request {
    Request::delete(&["grants", id]).query_flag("revoke_keys", revoke_keys)
}

pub fn vendors_request() -> Request {
    Request::get(&["app-vendors"])
}

pub fn move_request(vendor: &str, client_id: &str) -> Request {
    Request::put(&["app-vendors", vendor]).json(json!({ "client_id": client_id }))
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
            let answer = remote.json(&narrow_request(&id, &scope, &expected))?;
            out.report(&answer, |answer| {
                match answer.get("revoked_keys").and_then(Value::as_u64) {
                    None | Some(0) => format!("narrowed the app {id}"),
                    Some(1) => format!("narrowed the app {id} and revoked 1 key it made"),
                    Some(count) => {
                        format!("narrowed the app {id} and revoked {count} keys it made")
                    }
                }
            })
        }
        AppsCommand::Revoke { id, revoke_keys } => {
            let answer = remote.json(&revoke_request(&id, revoke_keys))?;
            out.report(&answer, |_| format!("revoked the app {id}"))
        }
        AppsCommand::Vendors {
            command: VendorsCommand::List,
        } => out.value(&remote.json(&vendors_request())?),
        AppsCommand::Vendors {
            command: VendorsCommand::Move { vendor, client_id },
        } => {
            let answer = remote.json(&move_request(&vendor, &client_id))?;
            out.report(&answer, |_| format!("gave {vendor} to the app {client_id}"))
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
        assert_eq!(req.segments, ["grants", "app-1"]);
        assert_eq!(
            req.body,
            crate::remote::request::Body::Json(
                json!({"scopes":["core.note:read"], "expected_scopes":["core.note:write"]})
            )
        );
    }
}
