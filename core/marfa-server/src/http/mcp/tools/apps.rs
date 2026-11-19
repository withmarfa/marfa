//! `marfa_apps` and `marfa_narrow_app`: the apps the owner approved, and narrowing one.

use std::sync::Arc;

use serde_json::{Map, Value, json};

use super::{Definition, text};
use crate::app::App;
use crate::app::access::{Caller, Permission};
use crate::app::oauth::grants::{self, Narrowing};
use crate::http::mcp::results::{ANSWER_BUDGET_CHARS, Outcome, fit_list};
use crate::http::oauth::grants::scopes_in;

pub const LIST_NAME: &str = "marfa_apps";
pub const NARROW_NAME: &str = "marfa_narrow_app";

pub fn list_definition() -> Definition {
    Definition {
        name: LIST_NAME,
        title: "List the apps the owner approved",
        description: "Use to see each app the owner approved: its id, what it may do, and when it was last used.",
        input: json!({
            "type": "object",
            "properties": {},
            "additionalProperties": false,
        }),
        output: json!({
            "type": "object",
            "properties": {
                "apps": { "type": "array", "items": { "type": "object" } },
                "left_out": { "type": "integer" },
            },
            "required": ["apps"],
        }),
        annotations: json!({ "readOnlyHint": true, "openWorldHint": false }),
        meta: None,
    }
}

pub fn narrow_definition() -> Definition {
    Definition {
        name: NARROW_NAME,
        title: "Narrow an app's access",
        description: "Use to set the scopes an app the owner approved keeps. It needs expected_scopes, the scopes marfa_apps showed, so a change made since is refused. The app's keys that hold more than it keeps end.",
        input: json!({
            "type": "object",
            "properties": {
                "id": { "type": "string", "minLength": 1, "description": "The app's grant, as marfa_apps shows it." },
                "scopes": { "type": "array", "items": { "type": "string", "minLength": 1 },
                    "description": "The scopes the app keeps. Required." },
                "expected_scopes": { "type": "array", "items": { "type": "string", "minLength": 1 },
                    "description": "The scopes the app holds now, as marfa_apps showed. Required." },
            },
            "required": ["id"],
            "additionalProperties": false,
        }),
        output: json!({
            "type": "object",
            "properties": {
                "scopes": { "type": "array", "items": { "type": "string" } },
                "revoked_keys": { "type": "integer" },
            },
            "required": ["scopes", "revoked_keys"],
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

pub async fn list(app: &Arc<App>, caller: &Caller) -> Outcome {
    caller.require(Permission::GrantsManage)?;
    let listed = grants::list(app, caller).await?;
    let (kept, left_out) = fit_list(listed, ANSWER_BUDGET_CHARS - 200);
    let mut answer = Map::new();
    answer.insert("apps".into(), Value::Array(kept));
    if left_out > 0 {
        answer.insert("left_out".into(), left_out.into());
    }
    Ok(Value::Object(answer))
}

pub async fn narrow(app: &Arc<App>, caller: &Caller, arguments: Map<String, Value>) -> Outcome {
    caller.require(Permission::GrantsManage)?;
    let id = text(&arguments, "id").unwrap_or_default();
    let asked = Narrowing {
        scopes: scopes_in(&arguments, "scopes")?,
        expected: scopes_in(&arguments, "expected_scopes")?,
    };
    let narrowed = grants::narrow(app, caller, id, asked).await?;
    Ok(json!({
        "scopes": narrowed.scopes.literals(),
        "revoked_keys": narrowed.revoked_keys,
    }))
}
