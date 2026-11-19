//! `marfa_sign_ins` and `marfa_manage_sign_in`: where the owner is signed in, and the owner's passkeys.

use std::sync::Arc;

use serde_json::{Map, Value, json};

use super::confirmed::{self, Step, confirm_property};
use super::{Definition, text};
use crate::app::App;
use crate::app::access::{Caller, Permission};
use crate::app::auth::{Visit, passkeys, sign_ins};
use crate::http::mcp::results::{ANSWER_BUDGET_CHARS, Outcome, Stop, fit_list};

pub const LIST_NAME: &str = "marfa_sign_ins";
pub const MANAGE_NAME: &str = "marfa_manage_sign_in";

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

pub fn manage_definition() -> Definition {
    Definition {
        name: MANAGE_NAME,
        title: "Rename or end a sign-in, rename or remove a passkey",
        description: "Use to rename a sign-in or a passkey, to end a sign-in, or to remove a passkey. Ending and removing first preview: show the person, and call again with the same arguments and confirm. A confirmation holds only for the arguments it previewed. Adding a passkey needs a browser and is not offered here.",
        input: json!({
            "type": "object",
            "properties": {
                "action": { "type": "string",
                    "enum": ["rename_sign_in", "end_sign_in", "rename_passkey", "remove_passkey"] },
                "id": { "type": "string", "minLength": 1,
                    "description": "The sign-in or passkey, as marfa_sign_ins shows it." },
                "name": { "type": "string", "minLength": 1, "description": "The new name. Only to rename." },
                "revoke_keys": { "type": "boolean",
                    "description": "Also revoke the keys an app minted. Only to end an app's sign-in; false when left out." },
                "confirm": confirm_property(),
            },
            "required": ["action", "id"],
            "additionalProperties": false,
        }),
        output: json!({
            "type": "object",
            "properties": {
                "preview": { "type": "object" },
                "confirm": { "type": "string" },
                "expires_at": { "type": "string" },
                "sign_in": { "type": "object" },
                "passkey": { "type": "object" },
                "ended": { "type": "string" },
                "removed": { "type": "string" },
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

fn confirmation(
    app: &App,
    caller: &Caller,
    arguments: &Map<String, Value>,
    effect: &str,
) -> Result<Step, Stop> {
    let preview = json!({
        "action": arguments.get("action"),
        "id": arguments.get("id"),
        "revoke_keys": arguments.get("revoke_keys").and_then(Value::as_bool).unwrap_or(false),
        "effect": effect,
    });
    confirmed::gate(
        app,
        caller,
        MANAGE_NAME,
        arguments,
        "",
        preview,
        "what the owner loses",
    )
}

pub async fn manage(
    app: &Arc<App>,
    caller: &Caller,
    arguments: Map<String, Value>,
    visit: Visit,
) -> Outcome {
    caller.require(Permission::SignInsManage)?;
    let id = text(&arguments, "id").unwrap_or_default();
    let action = text(&arguments, "action").unwrap_or_default();
    let rename = action.starts_with("rename");
    let name = text(&arguments, "name");
    if rename != name.is_some() {
        return Err(Stop::invalid(
            "A rename takes name, and nothing else takes it.",
        ));
    }
    if arguments.contains_key("revoke_keys") && action != "end_sign_in" {
        return Err(Stop::invalid("revoke_keys applies only to end_sign_in."));
    }
    match (action.as_str(), name) {
        ("rename_sign_in", Some(name)) => {
            let renamed = sign_ins::rename(app, caller, id, sign_ins::new_name(&name)?).await?;
            Ok(json!({ "sign_in": renamed.to_json() }))
        }
        ("rename_passkey", Some(name)) => {
            let renamed = passkeys::rename(app, caller, id, &name).await?;
            Ok(json!({ "passkey": renamed.to_json() }))
        }
        ("remove_passkey", _) => {
            let step = confirmation(
                app,
                caller,
                &arguments,
                "The passkey can no longer sign the owner in.",
            )?;
            if let Step::Preview(body) = step {
                return Ok(body);
            }
            passkeys::remove(app, caller, id.clone()).await?;
            Ok(json!({ "removed": id }))
        }
        _ => {
            let with_keys = arguments
                .get("revoke_keys")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let step = confirmation(
                app,
                caller,
                &arguments,
                "The sign-in ends; whoever holds it is signed out.",
            )?;
            if let Step::Preview(body) = step {
                return Ok(body);
            }
            sign_ins::end(app, caller, id.clone(), with_keys, visit).await?;
            Ok(json!({ "ended": id }))
        }
    }
}
