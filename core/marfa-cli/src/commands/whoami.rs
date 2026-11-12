use serde_json::{Value, json};

use crate::access;
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
            let bearer = remote.key_now()?.unwrap_or_default();
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
            // A server on another contract never receives the credential.
            if kind == "token" {
                record["person"] = if held {
                    remote.json(&Request::get(&["profile"]))?
                } else {
                    json!(null)
                };
            } else if held {
                record["key"] = remote.json(&Request::get(&["keys", "current"]))?;
            }
            record
        }
    };
    let profile = remote.profile().map(|profile| profile.name.clone());
    let report = json!({
        "server": remote.origin(),
        "profile": profile,
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
            match &profile {
                Some(name) => format!("server {} (profile {name})", remote.origin()),
                None => format!("server {}", remote.origin()),
            },
            status::instance_line(&instance),
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
                        if email.is_empty() {
                            field(person, "name")
                        } else {
                            email
                        }
                    })
                    .filter(|name| !name.is_empty())
                    .map(|name| format!(" as {name}"))
                    .unwrap_or_default();
                let named = credential
                    .get("key")
                    .map(|key| field(key, "label"))
                    .filter(|label| !label.is_empty())
                    .map(|label| format!(" named {label}"))
                    .unwrap_or_default();
                let from = match source {
                    CredentialSource::Flag => "--key",
                    CredentialSource::Environment => "MARFA_API_KEY",
                    CredentialSource::Keychain => "the keychain",
                    CredentialSource::KeyCommand => "the profile's key_command",
                };
                let what = match kind.as_str() {
                    "token" | "key" => format!("a {kind}"),
                    _ => "an unknown credential".to_string(),
                };
                let line = format!("{what}{named} from {from}{who}");
                match credential.get("scope").and_then(Value::as_str) {
                    Some(scope) => {
                        lines.push(access::indented(&line, &access::lines_for_scope(scope)))
                    }
                    None => lines.push(line),
                }
            }
        }
        lines.join("\n")
    })
}
