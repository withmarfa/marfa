//! `marfa_apps` and `marfa_manage_app`: the apps the owner approved, narrowing one and revoking one.

use std::sync::Arc;

use serde_json::{Map, Value, json};

use super::confirmed::{self, Shown, confirm_property};
use super::{Definition, text};
use crate::app::App;
use crate::app::access::{Caller, Permission};
use crate::app::mcp::confirm::Confirmed;
use crate::app::oauth::grants::{self, Narrowing};
use crate::http::mcp::results::{ANSWER_BUDGET_CHARS, Outcome, Stop, fit_list};
use crate::http::oauth::grants::scopes_in;

pub const LIST_NAME: &str = "marfa_apps";
pub const MANAGE_NAME: &str = "marfa_manage_app";

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

pub fn manage_definition() -> Definition {
    Definition {
        name: MANAGE_NAME,
        title: "Narrow or revoke an app's access",
        description: "Use to take access away from an app the owner approved. Narrowing sets the scopes the app keeps, and needs expected_scopes, the scopes marfa_apps showed, so a change made since is refused. Revoking ends the app's access, and with revoke_keys also the keys it minted; it first previews: show the person, and call again with the same arguments and confirm. A confirmation holds only for the arguments it previewed.",
        input: json!({
            "type": "object",
            "properties": {
                "action": { "type": "string", "enum": ["narrow", "revoke"] },
                "id": { "type": "string", "minLength": 1, "description": "The app's grant, as marfa_apps shows it." },
                "scopes": { "type": "array", "items": { "type": "string", "minLength": 1 },
                    "description": "The scopes the app keeps. Required to narrow." },
                "expected_scopes": { "type": "array", "items": { "type": "string", "minLength": 1 },
                    "description": "The scopes the app holds now, as marfa_apps showed. Required to narrow." },
                "revoke_keys": { "type": "boolean",
                    "description": "Also revoke the keys the app minted. Only to revoke; false when left out." },
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
                "scopes": { "type": "array", "items": { "type": "string" } },
                "revoked_keys": { "type": "integer" },
                "revoked": { "type": "string" },
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

pub async fn manage(app: &Arc<App>, caller: &Caller, arguments: Map<String, Value>) -> Outcome {
    caller.require(Permission::GrantsManage)?;
    let id = text(&arguments, "id").unwrap_or_default();
    if text(&arguments, "action").as_deref() == Some("narrow") {
        if arguments.contains_key("revoke_keys") || arguments.contains_key("confirm") {
            return Err(Stop::invalid(
                "Narrowing takes scopes and expected_scopes only.",
            ));
        }
        let body: Map<String, Value> = ["scopes", "expected_scopes"]
            .iter()
            .filter_map(|name| {
                arguments
                    .get(*name)
                    .map(|v| ((*name).to_string(), v.clone()))
            })
            .collect();
        let asked = Narrowing {
            scopes: scopes_in(&body, "scopes")?,
            expected: scopes_in(&body, "expected_scopes")?,
        };
        let narrowed = grants::narrow(app, caller, id, asked).await?;
        return Ok(json!({
            "scopes": narrowed.scopes.literals(),
            "revoked_keys": narrowed.revoked_keys,
        }));
    }
    if arguments.contains_key("scopes") || arguments.contains_key("expected_scopes") {
        return Err(Stop::invalid("Revoking takes id and revoke_keys only."));
    }
    let with_keys = arguments
        .get("revoke_keys")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let shown = |(app_shown, state): (Value, String)| Shown {
        tool: MANAGE_NAME,
        arguments: &arguments,
        state,
        preview: json!({
            "action": "revoke",
            "app": app_shown,
            "revoke_keys": with_keys,
            "effect": if with_keys {
                "The app's access ends, and so do the keys it minted."
            } else {
                "The app's access ends. The keys it minted keep working."
            },
        }),
        what: "which app loses its access",
    };
    let standing = grants::standing(app, caller, id.clone()).await?;
    let Some(confirming) = confirmed::confirming(app, caller, MANAGE_NAME, &arguments) else {
        return confirmed::preview(app, caller, shown(standing));
    };
    match grants::revoke_confirmed(app, caller, id.clone(), with_keys, confirming).await? {
        Confirmed::Done(()) => Ok(json!({ "revoked": id })),
        Confirmed::Stale => {
            let now = grants::standing(app, caller, id).await?;
            Err(confirmed::stale(app, caller, shown(now)))
        }
    }
}
