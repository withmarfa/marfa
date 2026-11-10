//! `marfa_overview`: what the credential reaches, or one type's fields and tables.

use std::sync::Arc;

use serde_json::{Map, Value, json};

use super::{Definition, text};
use crate::app::access::Caller;
use crate::app::{App, overview, types};
use crate::http::mcp::results::Outcome;

pub const NAME: &str = "marfa_overview";

pub fn definition() -> Definition {
    Definition {
        name: NAME,
        title: "Overview of this Marfa",
        description: "Call first, before finding or saving anything. Without arguments, returns what this Marfa holds and what you may do: the item types with counts, edge types, the most used tags, views and folders. With `type`, returns that type's fields and tables.",
        input: json!({
            "type": "object",
            "properties": {
                "type": { "type": "string", "minLength": 1,
                    "description": "A type's ID, such as `core.note`, to see its fields and tables." },
            },
            "additionalProperties": false,
        }),
        output: json!({
            "type": "object",
            "properties": {
                "instance": { "type": "object" },
                "credential": { "type": "object" },
                "types": { "type": "array", "items": { "type": "object" } },
                "total": { "type": "integer" },
                "edge_types": { "type": "array", "items": { "type": "object" } },
                "tags": { "type": "array", "items": { "type": "object" } },
                "views": { "type": "array", "items": { "type": "object" } },
                "folders": { "type": "array", "items": { "type": "object" } },
                "truncated": { "type": "object" },
                "type": { "type": "object" },
            },
        }),
        annotations: json!({ "readOnlyHint": true, "openWorldHint": false }),
        meta: None,
    }
}

const FIELD_KEYS: [&str; 9] = [
    "type",
    "description",
    "enum_values",
    "status_values",
    "items_type",
    "items_fields",
    "format",
    "minimum",
    "maximum",
];

const COLUMN_KEYS: [&str; 8] = [
    "type",
    "description",
    "enum_values",
    "format",
    "minimum",
    "maximum",
    "type_constraints",
    "adds_up",
];

fn compact_tables(given: &Map<String, Value>) -> Map<String, Value> {
    let mut tables = Map::new();
    for (name, table) in given {
        let mut kept = Map::new();
        if let Some(description) = table.get("description").filter(|d| d.is_string()) {
            kept.insert("description".into(), description.clone());
        }
        let mut columns = Map::new();
        for (column, definition) in table
            .get("columns")
            .and_then(Value::as_object)
            .into_iter()
            .flatten()
        {
            let mut held = Map::new();
            for key in COLUMN_KEYS {
                if let Some(value) = definition.get(key) {
                    held.insert(key.into(), value.clone());
                }
            }
            if definition.get("required") == Some(&Value::Bool(true)) {
                held.insert("required".into(), true.into());
            }
            columns.insert(column.clone(), Value::Object(held));
        }
        kept.insert("columns".into(), Value::Object(columns));
        if let Some(order) = table.get("order").filter(|order| order.is_string()) {
            kept.insert("order".into(), order.clone());
        }
        tables.insert(name.clone(), Value::Object(kept));
    }
    tables
}

/// A type with only what an agent writing an item of it needs.
pub fn compact(schema: &Value) -> Value {
    let mut fields = Map::new();
    if let Some(given) = schema.get("fields").and_then(Value::as_object) {
        for (name, field) in given {
            let mut kept = Map::new();
            for key in FIELD_KEYS {
                if let Some(value) = field.get(key) {
                    kept.insert(key.into(), value.clone());
                }
            }
            if field.get("required") == Some(&Value::Bool(true)) {
                kept.insert("required".into(), true.into());
            }
            fields.insert(name.clone(), Value::Object(kept));
        }
    }
    let mut out = Map::new();
    for key in ["id", "label", "description", "parent"] {
        if let Some(value) = schema.get(key).filter(|value| value.is_string()) {
            out.insert(key.into(), value.clone());
        }
    }
    out.insert("fields".into(), Value::Object(fields));
    if let Some(tables) = schema
        .get("tables")
        .and_then(Value::as_object)
        .filter(|tables| !tables.is_empty())
    {
        out.insert("tables".into(), Value::Object(compact_tables(tables)));
    }
    if let Some(link) = schema.get("link_field").filter(|value| value.is_string()) {
        out.insert("link_field".into(), link.clone());
    }
    for key in ["title_field", "body_field"] {
        if let Some(value) = schema
            .get("display_hints")
            .and_then(|hints| hints.get(key))
            .filter(|value| value.is_string())
        {
            out.insert(key.into(), value.clone());
        }
    }
    Value::Object(out)
}

pub async fn run(app: &Arc<App>, caller: &Caller, arguments: Map<String, Value>) -> Outcome {
    match text(&arguments, "type") {
        Some(id) => Ok(json!({ "type": compact(&types::get(app, id).await?) })),
        None => Ok(overview::read(app, caller).await?),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_type_keeps_what_writing_an_item_needs_and_drops_the_rest() {
        let compacted = compact(&json!({
            "id": "user.recipe",
            "label": "Recipe",
            "provenance": { "origin": "user" },
            "display_hints": { "title_field": "title", "icon": "x" },
            "fields": {
                "title": { "type": "string", "required": true, "label": "Title" },
                "serves": { "type": "integer", "minimum": 1 },
            },
        }));
        assert_eq!(compacted["id"], "user.recipe");
        assert_eq!(compacted["title_field"], "title");
        assert!(compacted.get("provenance").is_none());
        assert_eq!(
            compacted["fields"]["title"],
            json!({ "type": "string", "required": true })
        );
        assert_eq!(compacted["fields"]["serves"]["minimum"], 1);
    }
}
