//! `marfa_purge`: previews purging chosen items or a page of the trash, then purges on confirm.

use std::sync::Arc;

use serde_json::{Map, Value, json};

use super::{Definition, item_id, text, texts};
use crate::app::App;
use crate::app::access::Caller;
use crate::app::items::{self, Choosing, PurgePreview};
use crate::app::mcp::confirm;
use crate::app::mcp::purge::{self, Confirmed};
use crate::app::refusal::Refusal;
use crate::http::mcp::results::{ANSWER_BUDGET_CHARS, Outcome, Stop, fit_list, json_length};

pub const NAME: &str = "marfa_purge";

/// The most ids one call names, and so the largest page a preview takes.
const MAX_IDS: usize = 200;
const ROOM: usize = ANSWER_BUDGET_CHARS - 2_000;

const PREVIEW_NEXT: &str = "Nothing has been purged. Purging cannot be undone. Show the person what would be purged and ask them; only if they agree, call marfa_purge again with these ids and confirm.";
const EMPTY_NEXT: &str = "There is nothing to purge here.";
const PURGED_NEXT: &str = "Purged. These items cannot be restored.";
const REPEATED_NEXT: &str =
    "This confirmation already purged these items. This call changed nothing.";
const STALE: &str = "This confirmation does not hold for these items. This call purged nothing. Preview again to get a new confirmation.";
const CHANGED: &str =
    "What the preview showed has changed. This call purged nothing; here is a new preview.";
const CHANGED_GONE: &str =
    "What the preview showed has changed. This call purged nothing. Preview again.";
const FILES: &str = "Purging does not say when a file's stored bytes are freed.";

pub fn definition() -> Definition {
    Definition {
        name: NAME,
        title: "Purge items from the trash",
        description: "Use to delete items in the trash for good, with their history, tags, extensions and table rows. Name ids, or pass page to take one page of the trash: {} for the first page, then the next_cursor a preview returned. The first call only previews; show the person and ask. Only if they agree, call again with the ids the preview returned and confirm. A confirmation works once, for this credential only. This cannot be undone.",
        input: json!({
            "type": "object",
            "properties": {
                "ids": { "type": "array", "minItems": 1, "maxItems": MAX_IDS,
                    "items": { "type": "string", "minLength": 1 },
                    "description": format!("The items' IDs, at most {MAX_IDS}. Each must be in the trash.") },
                "page": { "type": "object",
                    "properties": { "cursor": { "type": "string", "minLength": 1,
                        "description": "A next_cursor from a preview, or from marfa_trash called without type or q." } },
                    "additionalProperties": false,
                    "description": "Preview one page of the trash instead of naming ids." },
                "confirm": { "type": "string", "minLength": 1,
                    "description": "The confirm token from the preview, sent with the ids it returned. Leave out to preview." },
            },
            "additionalProperties": false,
        }),
        output: json!({
            "type": "object",
            "properties": {
                "ids": { "type": "array", "items": { "type": "string" },
                    "description": "The ids to send with confirm." },
                "next_cursor": { "type": ["string", "null"] },
                "items": { "type": "array", "items": {
                    "type": "object",
                    "properties": {
                        "id": { "type": "string" },
                        "type": { "type": "string" },
                        "title": { "type": "string" },
                        "version": { "type": "integer" },
                    },
                    "required": ["id", "type", "title", "version"],
                } },
                "left_out": { "type": "integer" },
                "hidden": { "type": "object", "properties": {
                    "items": { "type": "integer" },
                    "edges": { "type": "integer" },
                } },
                "edges": { "type": "integer" },
                "goes_with": { "type": "object", "properties": {
                    "versions": { "type": "integer", "description": "Earlier versions of the items." },
                    "tags": { "type": "integer" },
                    "extensions": { "type": "integer" },
                    "table_rows": { "type": "integer" },
                    "connector_agreements": { "type": "integer" },
                } },
                "files": { "type": "string" },
                "total": { "type": "integer" },
                "confirm": { "type": "string" },
                "expires_at": { "type": "string" },
                "purged": { "type": "integer" },
                "already_purged": { "type": "boolean" },
                "trash_remaining": { "type": ["integer", "null"] },
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

/// What the purge would take, with a token that confirms exactly it.
fn preview_body(
    app: &App,
    caller: &Caller,
    preview: PurgePreview,
    paged: bool,
) -> Result<Map<String, Value>, Refusal> {
    let mut body = Map::new();
    let total = preview.items.len() + preview.hidden_items;
    body.insert("ids".into(), json!(preview.ids));
    if paged {
        body.insert("next_cursor".into(), json!(preview.next_cursor));
    }
    if preview.ids.is_empty() {
        body.insert("items".into(), json!([]));
        body.insert("total".into(), 0.into());
        body.insert("next".into(), EMPTY_NEXT.into());
        return Ok(body);
    }
    let token = purge::token_for(app, caller, &preview)?;
    let entries: Vec<Value> = preview
        .items
        .iter()
        .map(|going| {
            json!({
                "id": going.id,
                "type": going.type_id,
                "title": going.name,
                "version": going.version,
            })
        })
        .collect();
    let room = ROOM.saturating_sub(json_length(&body["ids"]));
    let (kept, left_out) = fit_list(entries, room);
    let held = &preview.goes_with;
    body.insert("items".into(), Value::Array(kept));
    if left_out > 0 {
        body.insert("left_out".into(), left_out.into());
    }
    body.insert(
        "hidden".into(),
        json!({ "items": preview.hidden_items, "edges": preview.hidden_edges }),
    );
    body.insert("edges".into(), preview.edges.into());
    body.insert(
        "goes_with".into(),
        json!({
            "versions": held.versions,
            "tags": held.tags,
            "extensions": held.extensions,
            "table_rows": held.table_rows,
            "connector_agreements": held.connector_agreements,
        }),
    );
    body.insert("files".into(), FILES.into());
    body.insert("total".into(), total.into());
    body.insert("confirm".into(), token.text.into());
    body.insert("expires_at".into(), token.expires_at.text().into());
    body.insert("next".into(), PREVIEW_NEXT.into());
    Ok(body)
}

fn stale(message: &str, body: Option<Map<String, Value>>) -> Stop {
    let mut stop = Stop::coded("confirmation_stale", message);
    for (name, value) in body.into_iter().flatten() {
        stop.error.insert(name, value);
    }
    stop
}

fn choosing(arguments: &Map<String, Value>) -> Result<Choosing, Stop> {
    let named = arguments.contains_key("ids");
    match (named, arguments.get("page")) {
        (true, None) => {
            let ids = texts(arguments, "ids");
            for id in &ids {
                item_id(id)?;
            }
            Ok(Choosing::Ids(ids))
        }
        (false, Some(page)) => {
            if arguments.contains_key("confirm") {
                return Err(Stop::invalid(
                    "Confirm a page by sending the ids its preview returned, not the page.",
                ));
            }
            Ok(Choosing::Page {
                cursor: page.as_object().and_then(|page| text(page, "cursor")),
                limit: MAX_IDS as i64,
            })
        }
        _ => Err(Stop::invalid("Send either ids or page.")),
    }
}

/// The bin's count after the commit, or null where that read fails.
async fn remaining(app: &App, caller: &Caller) -> Value {
    items::bin_total(app, caller)
        .await
        .map_or(Value::Null, Value::from)
}

pub async fn run(app: &Arc<App>, caller: &Caller, arguments: Map<String, Value>) -> Outcome {
    let choosing = choosing(&arguments)?;
    let paged = matches!(choosing, Choosing::Page { .. });
    let Some(token) = text(&arguments, "confirm") else {
        let preview = purge::preview(app, caller, choosing).await?;
        return Ok(Value::Object(preview_body(app, caller, preview, paged)?));
    };
    let Choosing::Ids(ids) = choosing else {
        return Err(Stop::invalid("Send either ids or page."));
    };
    let Some(bound) = confirm::parse_bound(&token) else {
        return Err(stale(STALE, None));
    };
    match purge::confirmed(app, caller, ids.clone(), bound).await? {
        Confirmed::Purged { total } => Ok(json!({
            "purged": total,
            "trash_remaining": remaining(app, caller).await,
            "next": PURGED_NEXT,
        })),
        Confirmed::AlreadyPurged { total } => Ok(json!({
            "purged": total,
            "already_purged": true,
            "trash_remaining": remaining(app, caller).await,
            "next": REPEATED_NEXT,
        })),
        Confirmed::Stale => Err(stale(STALE, None)),
        Confirmed::Changed => match purge::preview(app, caller, Choosing::Ids(ids)).await {
            Ok(preview) => Err(stale(
                CHANGED,
                Some(preview_body(app, caller, preview, false)?),
            )),
            Err(_) => Err(stale(CHANGED_GONE, None)),
        },
    }
}
