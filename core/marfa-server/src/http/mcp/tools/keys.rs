//! `marfa_keys` and `marfa_manage_key`: the API keys a credential reaches, and making or narrowing one.

use std::sync::Arc;

use serde_json::{Map, Value, json};

use super::{Definition, item_id, text};
use crate::app::App;
use crate::app::access::Caller;
use crate::app::keys::{self, Key, Mint, Update};
use crate::http::mcp::results::{ANSWER_BUDGET_CHARS, Outcome, Stop, fit_list};

pub const LIST_NAME: &str = "marfa_keys";
pub const MANAGE_NAME: &str = "marfa_manage_key";

const GRANT_FIELDS: [&str; 4] = [
    "permissions",
    "type_permissions",
    "edge_permissions",
    "metadata_permissions",
];

pub fn list_definition() -> Definition {
    Definition {
        name: LIST_NAME,
        title: "List keys",
        description: "Use to see the API keys this credential can reach: what each may read and write, and when it was last used. The key you are using is marked yours.",
        input: json!({
            "type": "object",
            "properties": {},
            "additionalProperties": false,
        }),
        output: json!({
            "type": "object",
            "properties": {
                "keys": { "type": "array", "items": { "type": "object" } },
                "left_out": { "type": "integer" },
            },
            "required": ["keys"],
        }),
        annotations: json!({ "readOnlyHint": true, "openWorldHint": false }),
        meta: None,
    }
}

pub fn manage_definition() -> Definition {
    let level = json!({ "type": "string", "enum": ["read", "write"] });
    Definition {
        name: MANAGE_NAME,
        title: "Make or narrow a key",
        description: "Use to make an API key for an app or script, or to narrow what a key may reach. A key never gets more than this credential holds; a new key that names no permissions or maps gets all of it, so name only what the key needs. Making a key returns its secret once: give it to the person, who keeps it.",
        input: json!({
            "type": "object",
            "properties": {
                "action": { "type": "string", "enum": ["make", "narrow"] },
                "id": { "type": "string", "minLength": 1, "description": "The key to narrow." },
                "label": { "type": "string", "minLength": 1, "description": "Required to make a key." },
                "source": { "type": "string", "minLength": 1,
                    "description": "Required to make a key: a name unique to it, stamped on what it saves." },
                "permissions": { "type": "array", "items": { "type": "string", "minLength": 1 },
                    "description": "Permissions, such as `audit.read`." },
                "type_permissions": { "type": "object",
                    "description": "Types by ID or wildcard, such as {\"core.*\": \"read\"}; each `read`, `write` or `none`." },
                "edge_permissions": { "type": "object", "additionalProperties": level },
                "metadata_permissions": { "type": "object", "additionalProperties": level },
                "expires_at": { "type": "string", "description": "When the key stops working (RFC 3339)." },
            },
            "required": ["action"],
            "additionalProperties": false,
        }),
        output: json!({
            "type": "object",
            "properties": {
                "key": { "type": "object" },
                "secret": { "type": "string" },
                "next": { "type": "string" },
            },
            "required": ["key"],
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

/// A key as the tools show it: everything it reaches, without its secret. An empty
/// list or map is left out, but for `permissions` and `type_permissions`.
pub fn view(key: &Key, yours: Option<&str>) -> Value {
    let mut out = key.to_json();
    out.retain(|name, value| {
        let empty = match value {
            Value::Array(list) => list.is_empty(),
            Value::Object(map) => map.is_empty(),
            _ => false,
        };
        !empty || name == "permissions" || name == "type_permissions"
    });
    if yours == Some(key.id.as_str()) {
        out.insert("yours".into(), true.into());
    }
    Value::Object(out)
}

pub fn own_id(caller: &Caller) -> Option<String> {
    caller.key().map(|key| key.id.clone())
}

pub async fn list(app: &Arc<App>, caller: &Caller) -> Outcome {
    let yours = own_id(caller);
    let shown: Vec<Value> = keys::list(app, caller)
        .await?
        .iter()
        .map(|key| view(key, yours.as_deref()))
        .collect();
    let (kept, left_out) = fit_list(shown, ANSWER_BUDGET_CHARS - 200);
    let mut answer = Map::new();
    answer.insert("keys".into(), Value::Array(kept));
    if left_out > 0 {
        answer.insert("left_out".into(), left_out.into());
    }
    Ok(Value::Object(answer))
}

fn body_of(arguments: &Map<String, Value>, names: &[&str]) -> Map<String, Value> {
    let mut body = Map::new();
    for name in names {
        if let Some(value) = arguments.get(*name) {
            body.insert((*name).into(), value.clone());
        }
    }
    body
}

pub async fn manage(app: &Arc<App>, caller: &Caller, arguments: Map<String, Value>) -> Outcome {
    let yours = own_id(caller);
    if text(&arguments, "action").as_deref() == Some("make") {
        if !arguments.contains_key("label") || !arguments.contains_key("source") {
            return Err(Stop::coded(
                "missing_required_field",
                "A new key needs a label and a source.",
            ));
        }
        let mut names = vec!["label", "source", "expires_at"];
        names.extend(GRANT_FIELDS);
        let mint = Mint::from_body(&body_of(&arguments, &names))?;
        let (key, secret) = keys::mint(app, caller, mint).await?;
        return Ok(json!({
            "key": view(&key, yours.as_deref()),
            "secret": secret,
            "next": "Give the secret to the person now: Marfa never shows it again.",
        }));
    }
    let Some(id) = text(&arguments, "id") else {
        return Err(Stop::coded(
            "missing_required_field",
            "Name the key to narrow with id.",
        ));
    };
    if arguments.contains_key("source") {
        return Err(Stop::invalid("A key's source cannot change."));
    }
    item_id(&id)?;
    let mut names = vec!["label", "expires_at"];
    names.extend(GRANT_FIELDS);
    let mut body = body_of(&arguments, &names);
    body.insert("narrow_only".into(), true.into());
    let update = Update::from_body(&body)?;
    let key = keys::update(app, caller, id, update).await?;
    Ok(json!({ "key": view(&key, yours.as_deref()) }))
}
