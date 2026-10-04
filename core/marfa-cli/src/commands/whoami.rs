use serde_json::{Value, json};

use crate::auth;
use crate::commands::status;
use crate::error::CliError;
use crate::output::Printer;
use crate::remote::request::Request;
use crate::remote::{CredentialSource, Remote};

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
                // A scope that does not reach the identity claims is refused
                // 401 or 403 and reported without a person. A server on
                // another contract is described, not refused, and the token
                // is not sent on to it.
                if !held {
                    record["person"] = json!(null);
                } else if let Some(endpoint) = auth::discover(remote)?.userinfo_endpoint {
                    let door = Remote::keyed(&endpoint, &bearer)?;
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
