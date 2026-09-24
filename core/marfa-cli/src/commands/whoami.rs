use serde_json::{Value, json};

use crate::auth;
use crate::commands::status;
use crate::error::CliError;
use crate::output::Printer;
use crate::remote::request::Request;
use crate::remote::{CredentialSource, Remote, Transport};

/// Which server, which instance, and which credential a bare command would
/// use, and where that credential came from.
///
/// A key has no door that says whose it is, so for a key this reports the
/// key's kind and its source; a token reports the person it was issued to.
pub fn run(remote: &Remote, out: &Printer) -> Result<(), CliError> {
    let instance = remote.root()?;
    let held = status::speaks_this_contract(&instance);
    let credential = match remote.credential() {
        None => json!(null),
        Some(source) => {
            let bearer = remote.bearer().unwrap_or_default();
            let kind = if bearer.starts_with("marfa_at_") {
                "token"
            } else if bearer.starts_with("marfa_k1_") {
                "key"
            } else {
                "unknown"
            };
            let mut record = json!({ "kind": kind, "from": source.as_str() });
            if let Some(crate::credentials::Kept::Token {
                scope, expires_at, ..
            }) = remote.kept()
            {
                record["scope"] = json!(scope);
                record["expires_at"] = json!(expires_at);
            }
            if kind == "token" {
                // The person the token was issued to, at the door the server
                // names for it. A token whose scope does not reach the
                // identity claims is refused there (401 or 403) and reported
                // without a person; any other refusal is this command's.
                // A server on another contract is reported without a person
                // rather than refused, and the token is not sent on to it,
                // since saying which server this is remains the command's job.
                if !held {
                    record["person"] = json!(null);
                } else if let Some(endpoint) = auth::discover(remote)?.userinfo_endpoint {
                    let door = Remote::with(Transport::new(&endpoint, Some(&bearer))?);
                    match door.json(&Request::get(&[])) {
                        Ok(person) => record["person"] = person,
                        Err(CliError::Refused {
                            status: 401 | 403, ..
                        }) => {}
                        Err(error) => return Err(error),
                    }
                }
            }
            record
        }
    };
    let report = json!({
        "server": remote.origin(),
        "instance": instance,
        "contract": status::contract_report(&instance),
        "credential": credential,
    });
    out.report(&report, || {
        let field = |value: &Value, name: &str| {
            value
                .get(name)
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string()
        };
        let mut lines = vec![
            format!("server {}", remote.origin()),
            format!(
                "instance {} ({} {})",
                field(&instance, "instance_id"),
                field(&instance, "name"),
                field(&instance, "version")
            ),
        ];
        if !held {
            lines.push(status::contract_line(&instance));
        }
        match remote.credential() {
            None => lines.push("no credential".into()),
            Some(source) => {
                let kind = field(&credential, "kind");
                let who = credential
                    .get("person")
                    .map(|person| {
                        let email = field(person, "email");
                        let name = if email.is_empty() {
                            field(person, "sub")
                        } else {
                            email
                        };
                        format!(" as {name}")
                    })
                    .unwrap_or_default();
                let from = match source {
                    CredentialSource::Flag => "--key",
                    CredentialSource::Environment => "MARFA_API_KEY",
                    CredentialSource::Keychain => "the keychain",
                };
                lines.push(format!("a {kind} from {from}{who}"));
            }
        }
        lines.join("\n")
    })
}
