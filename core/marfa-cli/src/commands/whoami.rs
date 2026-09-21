use serde_json::{Value, json};

use crate::error::CliError;
use crate::output::Printer;
use crate::remote::request::Request;
use crate::remote::{CredentialSource, Remote};

/// Which server, which instance, and which credential a bare command would
/// use, and where that credential came from.
///
/// A key has no door that says whose it is, so this reports the key's kind
/// and its source.
pub fn run(remote: &Remote, out: &Printer) -> Result<(), CliError> {
    let instance = remote.json(&Request::get(&[]).public())?;
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
            json!({ "kind": kind, "from": source.as_str() })
        }
    };
    let report = json!({
        "server": remote.origin(),
        "instance": instance,
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
        match remote.credential() {
            None => lines.push("no credential".into()),
            Some(source) => {
                let kind = field(&credential, "kind");
                let from = match source {
                    CredentialSource::Flag => "--key",
                    CredentialSource::Environment => "MARFA_API_KEY",
                    CredentialSource::Keychain => "the keychain",
                };
                lines.push(format!("a {kind} from {from}"));
            }
        }
        lines.join("\n")
    })
}
