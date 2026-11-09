//! `marfa_revoke_key`: previews a key, then revokes it on a single-use confirmation.

use std::sync::Arc;

use chrono::{DateTime, SecondsFormat};
use serde_json::{Map, Value, json};

use super::keys::{own_id, view};
use super::{Definition, item_id, text};
use crate::app::App;
use crate::app::access::Caller;
use crate::app::keys::Key;
use crate::app::mcp::revoke::{self, Confirmed};
use crate::app::refusal::Refusal;
use crate::http::mcp::results::{Outcome, Stop};

pub const NAME: &str = "marfa_revoke_key";

const CONNECTION_ENDS: &str =
    "This is the key you are using: once it is revoked, this connection stops working. ";

pub fn definition() -> Definition {
    Definition {
        name: NAME,
        title: "Revoke a key",
        description: "Use to stop a key working for good. The first call previews the key; show it to the person, and call again with the same id and confirm to revoke it. A confirmation works once.",
        input: json!({
            "type": "object",
            "properties": {
                "id": { "type": "string", "minLength": 1, "description": "The key's ID, from marfa_keys." },
                "confirm": { "type": "string", "minLength": 1,
                    "description": "The confirm token from the preview. Leave out to preview." },
            },
            "required": ["id"],
            "additionalProperties": false,
        }),
        output: json!({
            "type": "object",
            "properties": {
                "key": { "type": "object" },
                "confirm": { "type": "string" },
                "expires_at": { "type": "string" },
                "revoked": { "type": "string" },
                "already_revoked": { "type": "boolean" },
                "next": { "type": "string" },
            },
        }),
        annotations: json!({
            "readOnlyHint": false,
            "destructiveHint": true,
            "idempotentHint": false,
            "openWorldHint": false,
        }),
        meta: None,
    }
}

fn instant(ms: i64) -> String {
    DateTime::from_timestamp_millis(ms)
        .unwrap_or(DateTime::<chrono::Utc>::MAX_UTC)
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn preview_body(app: &App, caller: &Caller, key: &Key) -> Result<Map<String, Value>, Refusal> {
    let token = revoke::token_for(app, caller, key)?;
    let yours = own_id(caller);
    let warning = if yours.as_deref() == Some(key.id.as_str()) {
        CONNECTION_ENDS
    } else {
        ""
    };
    let mut body = Map::new();
    body.insert("key".into(), view(key, yours.as_deref()));
    body.insert("confirm".into(), token.text.into());
    body.insert("expires_at".into(), instant(token.expires_at_ms).into());
    body.insert(
        "next".into(),
        format!("Nothing has been revoked. {warning}The key stops working at once. Show the person, and call again with the same id and confirm to revoke it.").into(),
    );
    Ok(body)
}

fn stale(body: Map<String, Value>, expired: bool) -> Stop {
    let mut stop = Stop::coded(
        "confirmation_stale",
        if expired {
            "The confirmation expired. Nothing was revoked; here is a new preview."
        } else {
            "The key changed, or the confirmation is not this preview's, or it was already used. Nothing was revoked; here is a new preview."
        },
    );
    for (name, value) in body {
        stop.error.insert(name, value);
    }
    stop
}

pub async fn run(app: &Arc<App>, caller: &Caller, arguments: Map<String, Value>) -> Outcome {
    let id = text(&arguments, "id").unwrap_or_default();
    item_id(&id)?;
    let fresh = revoke::preview(app, caller, &id).await;
    let Some(token) = text(&arguments, "confirm") else {
        return Ok(Value::Object(preview_body(app, caller, &fresh?)?));
    };
    match revoke::confirmed(app, caller, id.clone(), &token).await? {
        Confirmed::Revoked => {
            let yours = own_id(caller).as_deref() == Some(id.as_str());
            Ok(json!({
                "revoked": id,
                "next": if yours {
                    "Revoked. This was the key you were using, so this connection no longer works."
                } else {
                    "Revoked."
                },
            }))
        }
        Confirmed::AlreadyRevoked => Ok(json!({
            "revoked": id,
            "already_revoked": true,
            "next": "This confirmation already revoked the key, and nothing more was changed.",
        })),
        Confirmed::Stale => {
            let expired = revoke::is_expired(app, &token);
            Err(stale(preview_body(app, caller, &fresh?)?, expired))
        }
    }
}
