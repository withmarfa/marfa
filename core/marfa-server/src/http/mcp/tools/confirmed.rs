//! A preview and a signed confirmation for a change that cannot be undone.

use std::collections::BTreeMap;

use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::app::App;
use crate::app::access::Caller;
use crate::app::mcp::confirm::{self, Check};
use crate::http::mcp::results::Stop;

pub enum Step {
    /// The confirmation was good: do the change.
    Go,
    /// Nothing was changed: show this to the person.
    Preview(Value),
}

/// The arguments a confirmation covers, which is all of them but `confirm`, in a fixed order.
fn subject_of(arguments: &Map<String, Value>, covers: &str) -> String {
    let sorted: BTreeMap<&str, &Value> = arguments
        .iter()
        .filter(|(name, _)| name.as_str() != "confirm")
        .map(|(name, value)| (name.as_str(), value))
        .collect();
    let text = serde_json::to_string(&sorted).unwrap_or_default();
    hex::encode(Sha256::digest(format!("{text}\n{covers}").as_bytes()))
}

fn body(token: &confirm::Token, preview: Value, what: &str) -> Map<String, Value> {
    let mut body = Map::new();
    body.insert("preview".into(), preview);
    body.insert("confirm".into(), token.text.clone().into());
    body.insert("expires_at".into(), token.expires_at.text().into());
    body.insert(
        "next".into(),
        format!(
            "Nothing has changed. Show the person {what}, and call again with the same arguments and confirm once they agree."
        )
        .into(),
    );
    body
}

/// Previews without `confirm`, and with one that is this credential's for these arguments and `covers`, lets the change go.
pub fn gate(
    app: &App,
    caller: &Caller,
    tool: &str,
    arguments: &Map<String, Value>,
    covers: &str,
    preview: Value,
    what: &str,
) -> Result<Step, Stop> {
    let credential = caller.credential_handle();
    let subject = subject_of(arguments, covers);
    let now = app.clock.now_ms();
    let fresh = app.mcp.signer.issue(tool, &credential, &subject, now)?;
    let Some(token) = arguments.get("confirm").and_then(Value::as_str) else {
        return Ok(Step::Preview(Value::Object(body(&fresh, preview, what))));
    };
    match app
        .mcp
        .signer
        .check(tool, &credential, &subject, token, now)?
    {
        Check::Valid => Ok(Step::Go),
        check => {
            let message = if check == Check::Expired {
                "The confirmation expired. Nothing changed; here is a new preview."
            } else {
                "The confirmation is not for these arguments, or what they name changed. Nothing changed; here is a new preview."
            };
            let mut stop = Stop::coded("confirmation_stale", message);
            for (name, value) in body(&fresh, preview, what) {
                stop.error.insert(name, value);
            }
            Err(stop)
        }
    }
}

/// The `confirm` argument every confirmed tool takes.
pub fn confirm_property() -> Value {
    json!({ "type": "string", "minLength": 1,
        "description": "The confirm token from the preview. Leave out to preview." })
}
