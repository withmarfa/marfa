//! `marfa_trash` and `marfa_purge_trash`: the bin, and removing what is in it for good.

use std::sync::Arc;

use serde_json::{Map, Value, json};

use super::confirmed::{self, Step, confirm_property};
use super::{Definition, item_id, parsed, text};
use crate::app::App;
use crate::app::access::{Caller, Permission};
use crate::app::items::write::{self, Change};
use crate::app::items::{self, Listing, emptied};
use crate::app::types::check_id;
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
        description: "Use to purge one item from the trash, or to empty it a page at a time. Neither can be undone, so each first previews: show the person, and call again with the same arguments and confirm. A confirmation holds only for the arguments it previewed, and for emptying, only for the page it previewed. Emptying purges up to 200 items and returns next_cursor while more remain.",
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
                "purged": { "type": ["integer", "string"] },
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
    item_id(&id)?;
    let Some(version) = arguments.get("version").and_then(Value::as_i64) else {
        return Err(Stop::coded(
            "missing_required_field",
            "Name the version marfa_trash shows (version).",
        ));
    };
    if arguments.contains_key("cursor") {
        return Err(Stop::invalid("Purging one item takes id and version only."));
    }
    let preview = json!({
        "action": "purge",
        "id": id,
        "version": version,
        "effect": "The item and its history are removed for good.",
    });
    let step = confirmed::gate(
        app,
        caller,
        PURGE_NAME,
        arguments,
        "",
        preview,
        "which item is removed for good",
    )?;
    if let Step::Preview(body) = step {
        return Ok(body);
    }
    write::run(
        app,
        caller,
        None,
        Change::Purge {
            id: id.clone(),
            version: Some(version),
        },
    )
    .await?;
    Ok(json!({ "purged": 1, "id": id }))
}

async fn empty(app: &Arc<App>, caller: &Caller, arguments: &Map<String, Value>) -> Outcome {
    if arguments.contains_key("id") || arguments.contains_key("version") {
        return Err(Stop::invalid("Emptying the trash takes a cursor only."));
    }
    let cursor = text(arguments, "cursor");
    let (selected, next) =
        items::bin_selection(app, caller, emptied::page_of(cursor.clone())).await?;
    let covers = selected
        .iter()
        .map(|(id, version)| format!("{id}:{version}"))
        .collect::<Vec<_>>()
        .join(",");
    let preview = json!({
        "action": "empty",
        "items": selected.len(),
        "more_after_this_page": next.is_some(),
        "effect": "These items and their history are removed for good.",
    });
    let step = confirmed::gate(
        app,
        caller,
        PURGE_NAME,
        arguments,
        &covers,
        preview,
        "how many items are removed for good",
    )?;
    if let Step::Preview(body) = step {
        return Ok(body);
    }
    Ok(emptied::empty_page(app, caller, cursor).await?.to_json())
}
