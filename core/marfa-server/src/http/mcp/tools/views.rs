//! `marfa_save_view`: makes a saved view or changes one from the version read.

use std::sync::Arc;

use serde_json::{Map, Value, json};

use super::{Definition, item_id, parsed, text};
use crate::app::App;
use crate::app::access::Caller;
use crate::app::items::write::{self, Change};
use crate::app::refusal::Refusal;
use crate::http::mcp::results::{Outcome, Stop};
use crate::http::views::{creating, updating};

pub const NAME: &str = "marfa_save_view";

pub fn definition() -> Definition {
    Definition {
        name: NAME,
        title: "Save a view",
        description: "Use to make a saved view: a named list of items with a query, sort and grouping. With id, changes a view: each setting you send replaces the current one.",
        input: json!({
            "type": "object",
            "properties": {
                "id": { "type": "string", "minLength": 1,
                    "description": "The view to change. Leave out to make one." },
                "version": { "type": "integer", "minimum": 1,
                    "description": "The version of the view you read. Required to change one." },
                "title": { "type": "string", "minLength": 1, "description": "Required to make a view." },
                "query": { "type": "object",
                    "description": "Which items the view lists: types, a filter expression as marfa_find takes, state, tier or beneath (an item ID)." },
                "sort": { "type": "array", "items": { "type": "object" },
                    "description": "The keys the view sorts by, first key first, each {\"by\": \"properties.due\", \"direction\": \"asc\"}." },
                "group": { "type": ["object", "null"],
                    "description": "How the view groups items, such as {\"by\": \"properties.status\"}; null removes the grouping." },
            },
            "additionalProperties": false,
        }),
        output: json!({
            "type": "object",
            "properties": {
                "id": { "type": "string" },
                "version": { "type": "integer" },
                "title": { "type": "string" },
                "query": { "type": "object" },
                "sort": { "type": "array", "items": { "type": "object" } },
                "group": { "type": ["object", "null"] },
            },
            "required": ["id", "version"],
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

fn view_of(done: &write::Done) -> Result<Value, Stop> {
    let body = parsed(&done.body)?;
    let item = body.get("item").unwrap_or(&Value::Null);
    let properties = item.get("properties").unwrap_or(&Value::Null);
    let (Some(id), Some(version)) = (
        item.get("id").and_then(Value::as_str),
        item.get("version").and_then(Value::as_i64),
    ) else {
        return Err(Stop::refused(Refusal::internal(
            "a view write answered no item",
        )));
    };
    let mut view = Map::new();
    view.insert("id".into(), id.into());
    view.insert("version".into(), version.into());
    for name in ["title", "query", "sort", "group"] {
        if let Some(value) = properties.get(name) {
            view.insert(name.into(), value.clone());
        }
    }
    Ok(Value::Object(view))
}

pub async fn run(app: &Arc<App>, caller: &Caller, arguments: Map<String, Value>) -> Outcome {
    let id = text(&arguments, "id");
    let mut sent = Map::new();
    for name in ["title", "query", "sort", "group", "version"] {
        if let Some(value) = arguments.get(name) {
            sent.insert(name.into(), value.clone());
        }
    }
    let change = match id {
        None => {
            if sent.contains_key("version") {
                return Err(Stop::invalid("version is sent only to change a view."));
            }
            if !sent.contains_key("title") {
                return Err(Stop::coded(
                    "missing_required_field",
                    "A new view needs a title.",
                ));
            }
            if sent.get("group").is_some_and(Value::is_null) {
                sent.remove("group");
            }
            creating(sent)?
        }
        Some(id) => {
            item_id(&id)?;
            if !sent.contains_key("version") {
                return Err(Stop::coded(
                    "missing_required_field",
                    "Send the version of the view you read.",
                )
                .with("hint", "Find the view with marfa_get to read its version."));
            }
            updating(id, sent)?
        }
    };
    let done = write::run(app, caller, None, Change::View(change)).await?;
    view_of(&done)
}
