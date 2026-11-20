//! `marfa_settings` and `marfa_change_settings`: the instance's name, enforcement and settings.

use std::sync::Arc;

use serde_json::{Map, Value, json};

use super::Definition;
use crate::app::App;
use crate::app::access::{Caller, Permission};
use crate::app::config::{self, Mode, Request};
use crate::app::oauth::store;
use crate::app::refusal::Code;
use crate::db::Write;
use crate::http::mcp::results::{ANSWER_BUDGET_CHARS, Outcome, Stop, fit_list};
use crate::settings::registry::{ENTRIES, SIGN_IN_ADDRESS};

pub const READ_NAME: &str = "marfa_settings";
pub const CHANGE_NAME: &str = "marfa_change_settings";

const ROOM: usize = ANSWER_BUDGET_CHARS - 2_000;

const SIGN_IN_ADDRESS_WITHHELD: &str = "sign_in_address is not changed from a tool: moving it ends every sign-in, this app's own included, and a passkey belongs to the address it was made at. The owner moves it from the command line or from an app, then signs in again at the new address. Nothing changed.";
const SIGN_IN_AGAIN: &str = "Ask the person to reconnect this app: Marfa asks them to sign in again, and the new connection may make this change. Nothing changed.";

pub fn read_definition() -> Definition {
    Definition {
        name: READ_NAME,
        title: "Read the instance's settings",
        description: "Use to see the instance's name, its enforcement levers and every setting: its value, its default, the rule it follows and whether a secret is set. A secret's value is never shown.",
        input: json!({
            "type": "object",
            "properties": {},
            "additionalProperties": false,
        }),
        output: json!({
            "type": "object",
            "properties": {
                "instance_id": { "type": "string" },
                "name": { "type": "string" },
                "enforcement": { "type": "object" },
                "settings": { "type": "array", "items": { "type": "object" } },
                "start_only": { "type": "array", "items": { "type": "object" } },
                "left_out": { "type": "integer" },
            },
            "required": ["instance_id", "settings"],
        }),
        annotations: json!({ "readOnlyHint": true, "openWorldHint": false }),
        meta: None,
    }
}

pub fn change_definition() -> Definition {
    Definition {
        name: CHANGE_NAME,
        title: "Change the instance's settings",
        description: "Use to change the instance's name, its enforcement levers or its settings, as PATCH /config does: a value sets it, null returns it to its default. Changing whether the instance reaches private addresses, where it keeps files or where it backs up needs the person to have signed in to this app recently; if they have not, ask them to reconnect it. Moving sign_in_address is not offered here.",
        input: json!({
            "type": "object",
            "properties": {
                "name": { "type": ["string", "null"], "description": "The instance's name; null removes it." },
                "enforcement": { "type": ["object", "null"],
                    "description": "The enforcement levers: strict_mode, source_allowlist and source_filter; null removes them." },
                "settings": { "type": "object",
                    "description": "Setting keys, as marfa_settings lists them, to their new values; null returns one to its default." },
            },
            "additionalProperties": false,
        }),
        output: json!({
            "type": "object",
            "properties": {
                "instance_id": { "type": "string" },
                "name": { "type": "string" },
                "enforcement": { "type": "object" },
            },
        }),
        annotations: json!({
            "readOnlyHint": false,
            "destructiveHint": false,
            "idempotentHint": true,
            "openWorldHint": true,
        }),
        meta: None,
    }
}

pub async fn read(app: &Arc<App>, caller: &Caller) -> Outcome {
    caller.require(Permission::ConfigManage)?;
    let document = config::read(app).await?;
    let listed = config::listing(app).await?;
    let lines = listed["data"].as_array().cloned().unwrap_or_default();
    let (kept, left_out) = fit_list(lines, ROOM);
    let mut answer = Map::new();
    for name in ["instance_id", "name", "enforcement"] {
        if let Some(value) = document.get(name) {
            answer.insert(name.into(), value.clone());
        }
    }
    answer.insert("settings".into(), Value::Array(kept));
    answer.insert("start_only".into(), listed["start_only"].clone());
    if left_out > 0 {
        answer.insert("left_out".into(), left_out.into());
    }
    Ok(Value::Object(answer))
}

pub async fn change(app: &Arc<App>, caller: &Caller, arguments: Map<String, Value>) -> Outcome {
    caller.require(Permission::ConfigManage)?;
    let mut body = Map::new();
    for name in ["name", "enforcement"] {
        if let Some(value) = arguments.get(name) {
            body.insert(name.into(), value.clone());
        }
    }
    if let Some(Value::Object(settings)) = arguments.get("settings") {
        if settings.contains_key(SIGN_IN_ADDRESS.entry.key) {
            return Err(Stop::coded("app_sign_in_required", SIGN_IN_ADDRESS_WITHHELD));
        }
        for (key, value) in settings {
            if key == "name" || key == "enforcement" || !ENTRIES.iter().any(|e| e.key == key) {
                return Err(Stop::invalid(format!(
                    "{key} is not a setting. Read the keys with marfa_settings."
                )));
            }
            body.insert(key.clone(), value.clone());
        }
    }
    if body.is_empty() {
        return Err(Stop::invalid(
            "Name what to change: name, enforcement or settings.",
        ));
    }
    let mut allowed = vec!["name", "enforcement"];
    allowed.extend(ENTRIES.iter().map(|entry| entry.key));
    let request = Request::from_body(Mode::Patch, &body, &allowed, app.settings.sealer())?;
    match config::update(app, caller, request).await {
        Ok(answer) => Ok(answer),
        Err(refusal) if refusal.code == Code::InsufficientUserAuthentication => {
            ask_sign_in_again(app, caller).await;
            Err(Stop::refused(refusal).with("next", SIGN_IN_AGAIN))
        }
        Err(refusal) => Err(refusal.into()),
    }
}

/// An MCP client cannot follow a challenge with `max_age`, so the app's next authorization asks
/// for a sign-in made after this refusal instead.
async fn ask_sign_in_again(app: &App, caller: &Caller) {
    let Caller::App { grant, .. } = caller else {
        return;
    };
    let (client_id, owner_id) = (grant.client_id.clone(), grant.owner_id.clone());
    let clock = app.clock.clone();
    let asked = app
        .db
        .write(Write::own(), move |tx| {
            store::ask_login_after(tx, &client_id, &owner_id, clock.instant())
        })
        .await;
    if let Err(refused) = asked {
        tracing::warn!(
            code = refused.code.wire(),
            "The app's sign-in could not be marked for renewal"
        );
    }
}
