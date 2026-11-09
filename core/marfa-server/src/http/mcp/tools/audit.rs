//! `marfa_audit`: the audit log, newest first, narrowed by filters.

use std::sync::Arc;

use serde_json::{Map, Value, json};

use super::Definition;
use crate::app::App;
use crate::app::access::Caller;
use crate::app::audit::{self, Filter};
use crate::http::mcp::results::{ANSWER_BUDGET_CHARS, Outcome, fit_list};

pub const NAME: &str = "marfa_audit";

const DEFAULT_LIMIT: i64 = 20;
const MAX_LIMIT: i64 = 50;
const ROOM: usize = ANSWER_BUDGET_CHARS - 500;

pub fn definition() -> Definition {
    Definition {
        name: NAME,
        title: "Read the audit log",
        description: "Use to see what changed and who did it: changes, sign-ins, exports and the files tools fetched, newest first. Narrow it with the filters, and pass next_cursor to read further back.",
        input: json!({
            "type": "object",
            "properties": {
                "q": { "type": "string", "minLength": 1,
                    "description": "Only entries that hold every word of this text." },
                "action": { "type": "string", "minLength": 1, "description": "Such as `key.create`." },
                "resource_type": { "type": "string", "minLength": 1, "description": "Such as `key`." },
                "resource_id": { "type": "string", "minLength": 1 },
                "kind": { "type": "string", "enum": ["access", "data", "settings", "housekeeping"] },
                "created_after": { "type": "string", "description": "An RFC 3339 time." },
                "created_before": { "type": "string", "description": "An RFC 3339 time." },
                "limit": { "type": "integer", "minimum": 1, "maximum": MAX_LIMIT,
                    "description": format!("How many entries, {DEFAULT_LIMIT} when left out.") },
                "cursor": { "type": "string", "minLength": 1 },
            },
            "additionalProperties": false,
        }),
        output: json!({
            "type": "object",
            "properties": {
                "entries": { "type": "array", "items": { "type": "object" } },
                "next_cursor": { "type": ["string", "null"] },
                "left_out": { "type": "integer" },
                "next": { "type": "string" },
            },
            "required": ["entries", "next_cursor"],
        }),
        annotations: json!({ "readOnlyHint": true, "openWorldHint": false }),
        meta: None,
    }
}

pub async fn run(app: &Arc<App>, caller: &Caller, arguments: Map<String, Value>) -> Outcome {
    let mut pairs: Vec<(String, String)> = Vec::new();
    for (name, value) in &arguments {
        match value {
            Value::String(text) => pairs.push((name.clone(), text.clone())),
            Value::Number(number) => pairs.push((name.clone(), number.to_string())),
            _ => {}
        }
    }
    if !arguments.contains_key("limit") {
        pairs.push(("limit".into(), DEFAULT_LIMIT.to_string()));
    }
    let filter = Filter::from_query(&pairs)?;
    let (entries, next_cursor) = audit::list(app, caller, filter).await?;
    let (kept, left_out) = fit_list(entries, ROOM);
    if left_out == 0 {
        return Ok(json!({ "entries": kept, "next_cursor": next_cursor }));
    }
    Ok(json!({
        "entries": kept,
        "next_cursor": null,
        "left_out": left_out,
        "next": format!(
            "{left_out} entries did not fit. Call again with limit {} or less, and page from there.",
            kept.len().max(1)
        ),
    }))
}
