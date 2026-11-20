//! `marfa_trash`: what is in the bin.

use std::sync::Arc;

use serde_json::{Map, Value, json};

use super::{Definition, parsed, text};
use crate::app::App;
use crate::app::access::{Caller, Permission};
use crate::app::items::{self, Listing};
use crate::app::types::check_id;
use crate::http::mcp::results::{ANSWER_BUDGET_CHARS, Outcome, fitted_page};

pub const NAME: &str = "marfa_trash";

const BIN_PAGE: i64 = 25;
const MAX_PAGE: i64 = 200;
const ROOM: usize = ANSWER_BUDGET_CHARS - 500;

pub fn definition() -> Definition {
    Definition {
        name: NAME,
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
            },
            "required": ["items", "next_cursor"],
        }),
        annotations: super::reads(),
        meta: None,
    }
}

pub async fn run(app: &Arc<App>, caller: &Caller, arguments: Map<String, Value>) -> Outcome {
    caller.require(Permission::ItemsPurge)?;
    let type_id = text(&arguments, "type");
    if let Some(type_id) = &type_id {
        check_id(type_id, "type")?;
    }
    let q = text(&arguments, "q").unwrap_or_default();
    let cursor = text(&arguments, "cursor");
    let limit = arguments
        .get("limit")
        .and_then(Value::as_i64)
        .unwrap_or(BIN_PAGE);
    let read = fitted_page(limit, ROOM, |limit| {
        let listing = Listing {
            type_id: type_id.clone(),
            q: q.clone(),
            limit,
            cursor: cursor.clone(),
        };
        async move { parsed(&items::bin(app, caller, listing).await?) }
    })
    .await?;
    Ok(json!({
        "items": read["data"],
        "next_cursor": read["next_cursor"],
        "retention_days": read["retention_days"],
    }))
}
