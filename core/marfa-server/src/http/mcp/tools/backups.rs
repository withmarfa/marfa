//! `marfa_backups` and `marfa_manage_backups`: the backups, taking one now, and adopting the folder.

use std::sync::Arc;

use serde_json::{Map, Value, json};

use super::confirmed::{self, Shown, confirm_property};
use super::{Definition, text};
use crate::app::App;
use crate::app::access::{Caller, Permission};
use crate::app::mcp::confirm::Confirmed;
use crate::http::mcp::results::{ANSWER_BUDGET_CHARS, Outcome, fit_list};

pub const LIST_NAME: &str = "marfa_backups";
pub const MANAGE_NAME: &str = "marfa_manage_backups";

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
        annotations: json!({ "readOnlyHint": true, "openWorldHint": false }),
        meta: None,
    }
}

pub fn manage_definition() -> Definition {
    Definition {
        name: MANAGE_NAME,
        title: "Take a backup or adopt the backup folder",
        description: "Use to take a backup now, or to adopt an unmarked backup folder as the instance's store. Adopting forgets the old store's copies and backups, so it first previews: show the person, and call again with the same arguments and confirm. Restoring a backup is not offered here.",
        input: json!({
            "type": "object",
            "properties": {
                "action": { "type": "string", "enum": ["take", "adopt_folder"] },
                "confirm": confirm_property(),
            },
            "required": ["action"],
            "additionalProperties": false,
        }),
        output: json!({
            "type": "object",
            "properties": {
                "backup": { "type": "object" },
                "adopted": { "type": "object" },
                "preview": { "type": "object" },
                "confirm": { "type": "string" },
                "expires_at": { "type": "string" },
                "next": { "type": "string" },
            },
        }),
        annotations: json!({
            "readOnlyHint": false,
            "destructiveHint": true,
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

pub async fn manage(app: &Arc<App>, caller: &Caller, arguments: Map<String, Value>) -> Outcome {
    caller.require(Permission::BackupsManage)?;
    if text(&arguments, "action").as_deref() == Some("take") {
        let backup = app.run_backup(caller).await?;
        return Ok(json!({ "backup": backup }));
    }
    let shown = |(target, state): (Value, String)| Shown {
        tool: MANAGE_NAME,
        arguments: &arguments,
        state,
        preview: json!({
            "action": "adopt_folder",
            "folder": target["folder"],
            "replaced_store_id": target["replaced_store_id"],
            "effect": "The backup folder is taken as a new store, and the old store's copies and backups are forgotten.",
        }),
        what: "which folder is adopted and what adopting it forgets",
    };
    let target = app.backup_folder_state(caller).await?;
    let Some(confirming) = confirmed::confirming(app, caller, MANAGE_NAME, &arguments) else {
        return confirmed::preview(app, caller, shown(target));
    };
    match app
        .adopt_backup_folder_confirmed(caller, confirming)
        .await?
    {
        Confirmed::Done(adopted) => Ok(json!({ "adopted": adopted })),
        Confirmed::Stale => {
            let now = app.backup_folder_state(caller).await?;
            Err(confirmed::stale(app, caller, shown(now)))
        }
    }
}
