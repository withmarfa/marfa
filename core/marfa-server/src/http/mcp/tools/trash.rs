//! `marfa_trash` and `marfa_purge_trash`: the bin, and removing what is in it for good.

use std::sync::Arc;

use serde_json::{Map, Value, json};

use super::confirmed::{self, Shown, confirm_property};
use super::{Definition, parsed, text};
use crate::app::App;
use crate::app::access::{Caller, Permission};
use crate::app::items::write;
use crate::app::items::{self, Listing, emptied};
use crate::app::mcp::confirm::Confirmed;
use crate::app::types::check_id;
use crate::http::items::check_item_id;
use crate::http::mcp::results::{ANSWER_BUDGET_CHARS, Outcome, Stop, fit_list};

pub const READ_NAME: &str = "marfa_trash";
pub const PURGE_NAME: &str = "marfa_purge_trash";

const BIN_PAGE: i64 = 25;
const MAX_PAGE: i64 = 200;
const ROOM: usize = ANSWER_BUDGET_CHARS - 500;

pub fn read_definition() -> Definition {
    Definition {
        name: READ_NAME,
        title: "List the trash",
        description: "Use to see what is in the trash and when each item becomes eligible for deletion. Pass next_cursor to read further.",
        input: json!({
            "type": "object",
            "properties": {
                "type": { "type": "string", "minLength": 1, "description": "Only items of this type." },
                "q": { "type": "string", "maxLength": 500, "description": "Only items that match this text." },
                "limit": { "type": "integer", "minimum": 1, "maximum": MAX_PAGE,
                    "description": format!("How many items, {BIN_PAGE} when left out.") },
                "cursor": { "type": "string", "minLength": 1 },
            },
            "additionalProperties": false,
        }),
        output: json!({
            "type": "object",
            "properties": {
                "items": { "type": "array", "items": { "type": "object" } },
                "next_cursor": { "type": ["string", "null"] },
                "retention_days": { "type": "integer" },
                "left_out": { "type": "integer" },
            },
            "required": ["items", "next_cursor"],
        }),
        annotations: json!({ "readOnlyHint": true, "openWorldHint": false }),
        meta: None,
    }
}

pub fn purge_definition() -> Definition {
    Definition {
        name: PURGE_NAME,
        title: "Remove items from the trash for good",
        description: "Use to purge one item from the trash, or to empty it a page at a time. Neither can be undone, so each first previews what goes, including the parts that go with an item: show the person, and call again with the same arguments and confirm. A confirmation works once, and only while what it previewed is unchanged. Emptying purges up to 200 items and returns next_cursor while more remain.",
        input: json!({
            "type": "object",
            "properties": {
                "action": { "type": "string", "enum": ["purge", "empty"] },
                "id": { "type": "string", "minLength": 1, "description": "The trashed item to purge." },
                "version": { "type": "integer", "minimum": 1,
                    "description": "The item's version, as marfa_trash shows it. Required to purge one." },
                "cursor": { "type": "string", "minLength": 1,
                    "description": "Where to continue emptying: the next_cursor of the last page." },
                "confirm": confirm_property(),
            },
            "required": ["action"],
            "additionalProperties": false,
        }),
        output: json!({
            "type": "object",
            "properties": {
                "preview": { "type": "object" },
                "confirm": { "type": "string" },
                "expires_at": { "type": "string" },
                "purged": { "type": "integer",
                    "description": "How many items were removed, the parts that went with them included." },
                "items": { "type": "array", "items": { "type": "object" },
                    "description": "Each item a purge removed whose type the credential reads." },
                "not_shown": { "type": "integer",
                    "description": "How many removed items are of a type the credential does not read." },
                "failures": { "type": "array", "items": { "type": "object" } },
                "next_cursor": { "type": ["string", "null"] },
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

pub async fn read(app: &Arc<App>, caller: &Caller, arguments: Map<String, Value>) -> Outcome {
    caller.require(Permission::ItemsPurge)?;
    let type_id = text(&arguments, "type");
    if let Some(type_id) = &type_id {
        check_id(type_id, "type")?;
    }
    let listing = Listing {
        type_id,
        q: text(&arguments, "q").unwrap_or_default(),
        limit: arguments
            .get("limit")
            .and_then(Value::as_i64)
            .unwrap_or(BIN_PAGE),
        cursor: text(&arguments, "cursor"),
    };
    let read = parsed(&items::bin(app, caller, listing).await?)?;
    let data = read["data"].as_array().cloned().unwrap_or_default();
    let (kept, left_out) = fit_list(data, ROOM);
    let mut answer = Map::new();
    answer.insert("items".into(), Value::Array(kept));
    if left_out == 0 {
        answer.insert("next_cursor".into(), read["next_cursor"].clone());
    } else {
        answer.insert("next_cursor".into(), Value::Null);
        answer.insert("left_out".into(), left_out.into());
    }
    answer.insert("retention_days".into(), read["retention_days"].clone());
    Ok(Value::Object(answer))
}

pub async fn purge(app: &Arc<App>, caller: &Caller, arguments: Map<String, Value>) -> Outcome {
    caller.require(Permission::ItemsPurge)?;
    match text(&arguments, "action").as_deref() {
        Some("purge") => purge_one(app, caller, &arguments).await,
        _ => empty(app, caller, &arguments).await,
    }
}

async fn purge_one(app: &Arc<App>, caller: &Caller, arguments: &Map<String, Value>) -> Outcome {
    let Some(id) = text(arguments, "id") else {
        return Err(Stop::coded(
            "missing_required_field",
            "Name the item with id (id).",
        ));
    };
    check_item_id(&id)?;
    let Some(version) = arguments.get("version").and_then(Value::as_i64) else {
        return Err(Stop::coded(
            "missing_required_field",
            "Name the version marfa_trash shows (version).",
        ));
    };
    if arguments.contains_key("cursor") {
        return Err(Stop::invalid("Purging one item takes id and version only."));
    }
    let shown = |(going, state): (Value, String)| Shown {
        tool: PURGE_NAME,
        arguments,
        state,
        preview: json!({
            "action": "purge",
            "id": id,
            "version": version,
            "goes": going,
            "effect": "The item, the parts that go with it and their history are removed for good.",
        }),
        what: "what is removed for good",
    };
    let going = items::purge_preview(app, caller, id.clone(), version).await?;
    let Some(confirming) = confirmed::confirming(app, caller, PURGE_NAME, arguments) else {
        return confirmed::preview(app, caller, shown(going));
    };
    match write::purge_confirmed(app, caller, id.clone(), version, confirming).await? {
        Confirmed::Done(purged) => Ok(json!({
            "purged": purged.total,
            "items": purged.items,
            "not_shown": purged.not_shown,
        })),
        Confirmed::Stale => {
            let now = items::purge_preview(app, caller, id.clone(), version).await?;
            Err(confirmed::stale(app, caller, shown(now)))
        }
    }
}

async fn empty(app: &Arc<App>, caller: &Caller, arguments: &Map<String, Value>) -> Outcome {
    if arguments.contains_key("id") || arguments.contains_key("version") {
        return Err(Stop::invalid("Emptying the trash takes a cursor only."));
    }
    let cursor = text(arguments, "cursor");
    let shown = |selected: &emptied::Selected| Shown {
        tool: PURGE_NAME,
        arguments,
        state: selected.state(),
        preview: json!({
            "action": "empty",
            "items": selected.rows.len(),
            "more_after_this_page": selected.next_cursor.is_some(),
            "effect": "These items, the parts that go with them and their history are removed for good.",
        }),
        what: "how many items are removed for good",
    };
    let selected = emptied::select_page(app, caller, cursor.clone()).await?;
    let Some(confirming) = confirmed::confirming(app, caller, PURGE_NAME, arguments) else {
        return confirmed::preview(app, caller, shown(&selected));
    };
    match emptied::empty_confirmed(app, caller, selected, confirming).await? {
        Confirmed::Done(emptied) => Ok(emptied.to_json()),
        Confirmed::Stale => {
            let now = emptied::select_page(app, caller, cursor).await?;
            Err(confirmed::stale(app, caller, shown(&now)))
        }
    }
}
