//! A preview and a single-use confirmation for an owner task that cannot be undone.

use std::collections::BTreeMap;

use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::app::App;
use crate::app::access::Caller;
use crate::app::mcp::confirm::{self, Confirming};
use crate::http::mcp::results::{Outcome, Stop};

/// What a preview names and shows, and the state of what it names.
pub struct Shown<'a> {
    pub tool: &'static str,
    pub arguments: &'a Map<String, Value>,
    pub state: String,
    pub preview: Value,
    pub what: &'static str,
}

/// Every argument but `confirm`, in a fixed order.
fn arguments_of(arguments: &Map<String, Value>) -> String {
    let sorted: BTreeMap<&str, &Value> = arguments
        .iter()
        .filter(|(name, _)| name.as_str() != "confirm")
        .map(|(name, value)| (name.as_str(), value))
        .collect();
    let text = serde_json::to_string(&sorted).unwrap_or_default();
    hex::encode(Sha256::digest(text.as_bytes()))
}

fn body(app: &App, caller: &Caller, shown: Shown<'_>) -> Result<Map<String, Value>, Stop> {
    let subject = confirm::owner_subject(&arguments_of(shown.arguments), &shown.state);
    let token = app.mcp.signer.issue(
        shown.tool,
        &caller.credential_handle(),
        &subject,
        app.clock.now_ms(),
    )?;
    let mut body = Map::new();
    body.insert("preview".into(), shown.preview);
    body.insert("confirm".into(), token.text.into());
    body.insert("expires_at".into(), token.expires_at.text().into());
    body.insert(
        "next".into(),
        format!(
            "Nothing has changed. Show the person {}, and call again with the same arguments and confirm once they agree. A confirmation works once.",
            shown.what
        )
        .into(),
    );
    Ok(body)
}

/// The answer to a call that carried no `confirm`: nothing changes.
pub fn preview(app: &App, caller: &Caller, shown: Shown<'_>) -> Outcome {
    Ok(Value::Object(body(app, caller, shown)?))
}

/// The confirmation a call carries, for the application to judge in the write that acts.
pub fn confirming(
    app: &App,
    caller: &Caller,
    tool: &'static str,
    arguments: &Map<String, Value>,
) -> Option<Confirming> {
    let token = arguments.get("confirm").and_then(Value::as_str)?;
    Some(Confirming {
        signer: app.mcp.signer.clone(),
        tool,
        credential: caller.credential_handle(),
        arguments: arguments_of(arguments),
        token: token.to_string(),
    })
}

/// A confirmation the write refused, with a new preview of what stands now.
pub fn stale(app: &App, caller: &Caller, shown: Shown<'_>) -> Stop {
    let expired = shown
        .arguments
        .get("confirm")
        .and_then(Value::as_str)
        .is_some_and(|token| confirm::is_expired(token, app.clock.now_ms()));
    let message = if expired {
        "The confirmation expired. Nothing changed; here is a new preview."
    } else {
        "The confirmation was already used, is not for these arguments, or what they name changed. Nothing changed; here is a new preview."
    };
    let mut stop = Stop::coded("confirmation_stale", message);
    match body(app, caller, shown) {
        Ok(fresh) => {
            for (name, value) in fresh {
                stop.error.insert(name, value);
            }
            stop
        }
        Err(failed) => failed,
    }
}

/// The `confirm` argument every confirmed tool takes.
pub fn confirm_property() -> Value {
    json!({ "type": "string", "minLength": 1,
        "description": "The confirm token from the preview. Leave out to preview. A confirmation works once." })
}
