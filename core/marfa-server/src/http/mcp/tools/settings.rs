//! `marfa_settings` and `marfa_change_settings`: the instance's name, enforcement and settings.

use std::sync::Arc;

use serde_json::{Map, Value, json};

use super::Definition;
use crate::app::App;
use crate::app::access::{Caller, Permission};
use crate::app::config::{self, Mode, Request};
use crate::http::mcp::results::{ANSWER_BUDGET_CHARS, Outcome, Stop, fit_list};
use crate::settings::registry::{
    ALLOW_PRIVATE_ADDRESSES, BACKUP_PATH, ENTRIES, OBJECT_STORE_BUCKET, OBJECT_STORE_ENDPOINT,
    OBJECT_STORE_PATH_STYLE, OBJECT_STORE_PREFIX, OBJECT_STORE_REGION, SIGN_IN_ADDRESS,
};

pub const READ_NAME: &str = "marfa_settings";
pub const CHANGE_NAME: &str = "marfa_change_settings";

const ROOM: usize = ANSWER_BUDGET_CHARS - 2_000;

/// The settings an owner changes only with a recent sign-in or from the command line.
fn withheld() -> [&'static str; 8] {
    [
        SIGN_IN_ADDRESS.entry.key,
        ALLOW_PRIVATE_ADDRESSES.entry.key,
        OBJECT_STORE_BUCKET.entry.key,
        OBJECT_STORE_ENDPOINT.entry.key,
        OBJECT_STORE_REGION.entry.key,
        OBJECT_STORE_PATH_STYLE.entry.key,
        OBJECT_STORE_PREFIX.entry.key,
        BACKUP_PATH.entry.key,
    ]
}

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
        description: "Use to change the instance's name, its enforcement levers or its settings, as PATCH /config does: a value sets it, null returns it to its default. Changing where the instance signs people in, whether it reaches private addresses, where it keeps files or where it backs up is not offered here: the owner does that from the command line or from an app after a recent sign-in.",
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
            "openWorldHint": false,
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
        for (key, value) in settings {
            if withheld().contains(&key.as_str()) {
                return Err(Stop::coded(
                    "app_sign_in_required",
                    format!(
                        "{key} is not changed from a tool. The owner changes it from the command line, or from an app after a recent sign-in. Nothing changed."
                    ),
                ));
            }
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
    Ok(config::update(app, caller, request).await?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_withheld_setting_is_a_setting() {
        for key in withheld() {
            assert!(ENTRIES.iter().any(|entry| entry.key == key), "{key}");
        }
    }
}
