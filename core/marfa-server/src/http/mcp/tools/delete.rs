//! `marfa_delete`: a preview of what the trash would take, and the trash on a confirmation that
//! allows it once.

use std::sync::Arc;

use chrono::{DateTime, SecondsFormat};
use serde_json::{Map, Value, json};

use super::{Definition, item_id, texts};
use crate::app::App;
use crate::app::access::Caller;
use crate::app::items::captions;
use crate::app::mcp::trash::{self, Confirmed, Preview};
use crate::app::refusal::Refusal;
use crate::http::mcp::results::{Outcome, Stop};

pub const NAME: &str = "marfa_delete";

const MAX_IDS: usize = 20;

const PREVIEW_NEXT: &str = "Nothing has been deleted. Show the person what would go to the trash and ask them; only if they agree, call marfa_delete again with the same ids and confirm.";
const TRASHED_NEXT: &str =
    "Moved to the trash. Restore an item with marfa_update and state active.";
const REPEATED_NEXT: &str = "This confirmation already moved these items to the trash, and nothing more was changed. Restore an item with marfa_update and state active.";

pub fn definition() -> Definition {
    Definition {
        name: NAME,
        title: "Move items to the trash",
        description: "Use to delete notes, tasks, records, files or other items, which moves them to the trash. The first call only previews what would go, including items that go with them. Show the person and ask; only if they agree, call again with the same ids and confirm. A confirmation works once. Restore with marfa_update.",
        input: json!({
            "type": "object",
            "properties": {
                "ids": { "type": "array", "minItems": 1, "maxItems": MAX_IDS,
                    "items": { "type": "string", "minLength": 1 },
                    "description": format!("The items' IDs, at most {MAX_IDS}.") },
                "confirm": { "type": "string", "minLength": 1,
                    "description": "The confirm token from the preview. Leave out to preview." },
            },
            "required": ["ids"],
            "additionalProperties": false,
        }),
        output: json!({
            "type": "object",
            "properties": {
                "preview": { "type": "array", "items": {
                    "type": "object",
                    "properties": {
                        "id": { "type": "string" },
                        "type": { "type": "string" },
                        "title": { "type": "string" },
                        "version": { "type": "integer" },
                        "also_trashes": { "type": "array", "items": {
                            "type": "object",
                            "properties": { "id": { "type": "string" }, "type": { "type": "string" } },
                            "required": ["id", "type"],
                        } },
                        "count": { "type": "integer",
                            "description": "How many items trashing it moves to the trash, itself included." },
                        "truncated": { "type": "boolean" },
                    },
                    "required": ["id", "type", "version", "also_trashes", "count"],
                } },
                "total": { "type": "integer" },
                "confirm": { "type": "string" },
                "expires_at": { "type": "string" },
                "next": { "type": "string" },
                "trashed": { "type": "array", "items": { "type": "string" } },
                "already_trashed": { "type": "boolean" },
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

/// What the trash would take, with a token that confirms exactly it.
async fn preview_body(
    app: &Arc<App>,
    caller: &Caller,
    ids: &[String],
    preview: &Preview,
) -> Result<Map<String, Value>, Refusal> {
    let names = captions(app, caller, ids.to_vec()).await?;
    let token = trash::token_for(app, caller, ids, preview)?;
    let shown: Vec<Value> = preview
        .items
        .iter()
        .map(|entry| {
            let id = entry.get("id").and_then(Value::as_str).unwrap_or_default();
            let mut out = Map::new();
            out.insert("id".into(), id.into());
            out.insert(
                "type".into(),
                entry.get("type").cloned().unwrap_or(Value::Null),
            );
            if let Some(caption) = names.get(id) {
                out.insert("title".into(), caption.name.clone().into());
            }
            out.insert(
                "version".into(),
                entry.get("version").cloned().unwrap_or(Value::Null),
            );
            let also: Vec<Value> = entry
                .get("takes")
                .and_then(Value::as_array)
                .map(|takes| {
                    takes
                        .iter()
                        .map(|item| {
                            json!({
                                "id": item.get("id").cloned().unwrap_or(Value::Null),
                                "type": item.get("type").cloned().unwrap_or(Value::Null),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            out.insert("also_trashes".into(), Value::Array(also));
            out.insert(
                "count".into(),
                entry.get("count").cloned().unwrap_or(Value::Null),
            );
            if entry.get("truncated").and_then(Value::as_bool) == Some(true) {
                out.insert("truncated".into(), true.into());
            }
            Value::Object(out)
        })
        .collect();
    let mut body = Map::new();
    body.insert("preview".into(), Value::Array(shown));
    body.insert("total".into(), preview.count.into());
    body.insert("confirm".into(), token.text.into());
    body.insert("expires_at".into(), instant(token.expires_at_ms).into());
    body.insert("next".into(), PREVIEW_NEXT.into());
    Ok(body)
}

fn stale(body: Map<String, Value>, expired: bool) -> Stop {
    let mut stop = Stop::coded(
        "confirmation_stale",
        if expired {
            "The confirmation expired. Nothing was deleted; here is a new preview."
        } else {
            "What the preview showed changed, or the confirmation is not this preview's, or it was already used. Nothing was deleted; here is a new preview."
        },
    );
    for (name, value) in body {
        stop.error.insert(name, value);
    }
    stop
}

pub async fn run(app: &Arc<App>, caller: &Caller, arguments: Map<String, Value>) -> Outcome {
    let mut unique: Vec<String> = Vec::new();
    for id in texts(&arguments, "ids") {
        item_id(&id)?;
        if !unique.contains(&id) {
            unique.push(id);
        }
    }
    let fresh = trash::preview(app, caller, unique.clone()).await;
    let Some(token) = arguments.get("confirm").and_then(Value::as_str) else {
        let preview = fresh?;
        return Ok(Value::Object(
            preview_body(app, caller, &unique, &preview).await?,
        ));
    };
    match trash::confirmed(app, caller, unique.clone(), fresh.clone(), token).await? {
        Confirmed::Trashed { total } => Ok(json!({
            "trashed": unique,
            "total": total,
            "next": TRASHED_NEXT,
        })),
        Confirmed::AlreadyTrashed { total } => Ok(json!({
            "trashed": unique,
            "total": total,
            "already_trashed": true,
            "next": REPEATED_NEXT,
        })),
        Confirmed::Stale => {
            let preview = fresh?;
            let expired = trash::is_expired(app, token);
            Err(stale(
                preview_body(app, caller, &unique, &preview).await?,
                expired,
            ))
        }
    }
}
