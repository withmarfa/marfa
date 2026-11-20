//! `marfa_sign_ins` and `marfa_rename_sign_in`: where the owner is signed in, the owner's passkeys, and naming them.

use std::sync::Arc;

use serde_json::{Map, Value, json};

use super::{Definition, text};
use crate::app::App;
use crate::app::access::{Caller, Permission};
use crate::app::auth::{passkeys, sign_ins};
use crate::http::mcp::results::{ANSWER_BUDGET_CHARS, Outcome, fit_list};

pub const LIST_NAME: &str = "marfa_sign_ins";
pub const RENAME_NAME: &str = "marfa_rename_sign_in";

pub fn list_definition() -> Definition {
    Definition {
        name: LIST_NAME,
        title: "List sign-ins and passkeys",
        description: "Use to see where the owner is signed in, with browsers, apps and keys each named, and the owner's passkeys.",
        input: json!({
            "type": "object",
            "properties": {},
            "additionalProperties": false,
        }),
        output: json!({
            "type": "object",
            "properties": {
                "sign_ins": { "type": "array", "items": { "type": "object" } },
                "passkeys": { "type": "array", "items": { "type": "object" } },
                "left_out": { "type": "integer" },
            },
            "required": ["sign_ins", "passkeys"],
        }),
        annotations: json!({ "readOnlyHint": true, "openWorldHint": false }),
        meta: None,
    }
}

pub fn rename_definition() -> Definition {
    Definition {
        name: RENAME_NAME,
        title: "Rename a sign-in or a passkey",
        description: "Use to give a sign-in or a passkey, as marfa_sign_ins lists them, a new name. To end a sign-in or remove a passkey, use marfa_end_sign_in. Adding a passkey is not offered here.",
        input: json!({
            "type": "object",
            "properties": {
                "kind": { "type": "string", "enum": ["sign_in", "passkey"] },
                "id": { "type": "string", "minLength": 1,
                    "description": "The sign-in or passkey, as marfa_sign_ins shows it." },
                "name": { "type": "string", "minLength": 1, "description": "The new name." },
            },
            "required": ["kind", "id", "name"],
            "additionalProperties": false,
        }),
        output: json!({
            "type": "object",
            "properties": {
                "sign_in": { "type": "object" },
                "passkey": { "type": "object" },
            },
        }),
        annotations: json!({
            "readOnlyHint": false,
            "destructiveHint": false,
            "idempotentHint": true,
            "openWorldHint": false,
        }),
        meta: None,
    }
}

pub async fn list(app: &Arc<App>, caller: &Caller) -> Outcome {
    caller.require(Permission::SignInsManage)?;
    let signed_in: Vec<Value> = sign_ins::list(app, caller)
        .await?
        .iter()
        .map(sign_ins::SignIn::to_json)
        .collect();
    let keys: Vec<Value> = passkeys::list(app, caller)
        .await?
        .iter()
        .map(passkeys::Listed::to_json)
        .collect();
    let room = ANSWER_BUDGET_CHARS - 500;
    let (signed_in, sign_ins_left) = fit_list(signed_in, room / 2);
    let (keys, keys_left) = fit_list(keys, room / 2);
    let mut answer = Map::new();
    answer.insert("sign_ins".into(), Value::Array(signed_in));
    answer.insert("passkeys".into(), Value::Array(keys));
    if sign_ins_left + keys_left > 0 {
        answer.insert("left_out".into(), (sign_ins_left + keys_left).into());
    }
    Ok(Value::Object(answer))
}

pub async fn rename(app: &Arc<App>, caller: &Caller, arguments: Map<String, Value>) -> Outcome {
    caller.require(Permission::SignInsManage)?;
    let id = text(&arguments, "id").unwrap_or_default();
    let name = text(&arguments, "name").unwrap_or_default();
    if text(&arguments, "kind").as_deref() == Some("passkey") {
        let renamed = passkeys::rename(app, caller, id, &name).await?;
        return Ok(json!({ "passkey": renamed.to_json() }));
    }
    let renamed = sign_ins::rename(app, caller, id, sign_ins::new_name(&name)?).await?;
    Ok(json!({ "sign_in": renamed.to_json() }))
}
