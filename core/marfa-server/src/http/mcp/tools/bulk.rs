//! `marfa_bulk_save`: many items in one call, through the page write the REST door uses.

use std::sync::Arc;

use serde_json::{Map, Value, json};

use super::{Definition, parsed};
use crate::app::App;
use crate::app::access::Caller;
use crate::app::items::bulk;
use crate::app::refusal::Refusal;
use crate::http::bulk::asked_from;
use crate::http::mcp::results::{ANSWER_BUDGET_CHARS, Outcome, Stop, fit_list};

pub const NAME: &str = "marfa_bulk_save";

const MAX_ITEMS: usize = 200;

pub fn definition() -> Definition {
    let entry = json!({
        "type": "object",
        "properties": {
            "type": { "type": "string", "minLength": 1 },
            "properties": { "type": "object" },
            "source_id": { "type": "string", "minLength": 1,
                "description": "The item's ID in the place it came from, so saving it again finds the same item." },
            "id": { "type": "string", "minLength": 1 },
            "version": { "type": "integer",
                "description": "The version you read, to update an item only if it is unchanged." },
            "tags": { "type": "array", "items": { "type": "string", "minLength": 1 } },
            "tier": { "type": "string", "enum": ["library", "feed"] },
            "occurred_at": { "type": "string" },
        },
        "required": ["type"],
        "additionalProperties": false,
    });
    Definition {
        name: NAME,
        title: "Save many items at once",
        description: "Use to save many items in one call, at most 200, such as an import. By default it only creates: an entry whose source_id or id is saved already is skipped. With mode upsert, it updates those items instead.",
        input: json!({
            "type": "object",
            "properties": {
                "items": { "type": "array", "minItems": 1, "maxItems": MAX_ITEMS, "items": entry },
                "mode": { "type": "string", "enum": ["create_only", "upsert"],
                    "description": "`create_only` skips saved items; `upsert` updates them. `create_only` when left out." },
                "atomic": { "type": "boolean",
                    "description": "`true` saves nothing if any entry fails; `false` saves the rest. `true` when left out." },
            },
            "required": ["items"],
            "additionalProperties": false,
        }),
        output: json!({
            "type": "object",
            "properties": {
                "counts": { "type": "object" },
                "results": { "type": "array", "items": { "type": "object" } },
                "left_out": { "type": "integer" },
                "next": { "type": "string" },
            },
            "required": ["counts", "results"],
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

pub async fn run(
    app: &Arc<App>,
    caller: &Caller,
    arguments: Map<String, Value>,
    exact: Result<(), Refusal>,
) -> Outcome {
    let mut page = Map::new();
    page.insert(
        "mode".into(),
        arguments
            .get("mode")
            .cloned()
            .unwrap_or_else(|| "create_only".into()),
    );
    for name in ["items", "atomic"] {
        if let Some(value) = arguments.get(name) {
            page.insert(name.into(), value.clone());
        }
    }
    let asked = asked_from(page, || exact)?;
    let answer = parsed(&bulk::write(app, caller, asked).await?)?;
    let counts = answer.get("counts").cloned().unwrap_or(Value::Null);
    let results = match answer.get("results") {
        Some(Value::Array(results)) => results.clone(),
        _ => {
            return Err(Stop::refused(Refusal::internal(
                "a bulk write answered no results",
            )));
        }
    };
    let (kept, left_out) = fit_list(results, ANSWER_BUDGET_CHARS - 500);
    let mut out = Map::new();
    out.insert("counts".into(), counts);
    out.insert("results".into(), Value::Array(kept));
    if left_out > 0 {
        out.insert("left_out".into(), left_out.into());
        out.insert(
            "next".into(),
            "Some results are left out; counts covers every entry.".into(),
        );
    }
    Ok(Value::Object(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_description_names_the_limit_the_schema_holds() {
        let tool = definition();
        assert!(tool.description.contains(&format!("at most {MAX_ITEMS},")));
        assert_eq!(tool.input["properties"]["items"]["maxItems"], MAX_ITEMS);
    }
}
