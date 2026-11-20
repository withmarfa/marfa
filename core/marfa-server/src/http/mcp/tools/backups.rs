//! `marfa_backups` and `marfa_take_backup`: the backups, and taking one now.

use std::sync::Arc;

use serde_json::{Map, Value, json};

use super::Definition;
use crate::app::App;
use crate::app::access::{Caller, Permission};
use crate::http::mcp::results::{ANSWER_BUDGET_CHARS, Outcome, fit_list};

pub const LIST_NAME: &str = "marfa_backups";
pub const TAKE_NAME: &str = "marfa_take_backup";

pub fn list_definition() -> Definition {
    Definition {
        name: LIST_NAME,
        title: "List the backups",
        description: "Use to see the backups where the instance keeps them, newest first.",
        input: json!({
            "type": "object",
            "properties": {},
            "additionalProperties": false,
        }),
        output: json!({
            "type": "object",
            "properties": {
                "backups": { "type": "array", "items": { "type": "object" } },
                "left_out": { "type": "integer" },
            },
            "required": ["backups"],
        }),
        annotations: super::reads(),
        meta: None,
    }
}

pub fn take_definition() -> Definition {
    Definition {
        name: TAKE_NAME,
        title: "Take a backup now",
        description: "Use to take a backup now, where the instance keeps its backups, which can be an object store. This is how to copy the whole instance from here: an export archive does not fit in a tool's answer, so it is streamed with marfa export or GET /export instead. Restoring a backup is not offered here.",
        input: json!({
            "type": "object",
            "properties": {},
            "additionalProperties": false,
        }),
        output: json!({
            "type": "object",
            "properties": {
                "backup": { "type": "object" },
            },
            "required": ["backup"],
        }),
        annotations: json!({
            "readOnlyHint": false,
            "destructiveHint": false,
            "idempotentHint": false,
            "openWorldHint": true,
        }),
        meta: None,
    }
}

pub async fn list(app: &Arc<App>, caller: &Caller) -> Outcome {
    caller.require(Permission::BackupsManage)?;
    let listed = app.list_backups(caller).await?;
    let (kept, left_out) = fit_list(listed, ANSWER_BUDGET_CHARS - 200);
    let mut answer = Map::new();
    answer.insert("backups".into(), Value::Array(kept));
    if left_out > 0 {
        answer.insert("left_out".into(), left_out.into());
    }
    Ok(Value::Object(answer))
}

pub async fn take(app: &Arc<App>, caller: &Caller) -> Outcome {
    caller.require(Permission::BackupsManage)?;
    let backup = app.run_backup(caller).await?;
    Ok(json!({ "backup": backup }))
}
