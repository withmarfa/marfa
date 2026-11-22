//! `marfa_overview`: what the credential reaches, or one type's fields and tables.

use std::sync::Arc;

use serde_json::{Map, Value, json};

use super::Definition;
use crate::app::access::Caller;
use crate::app::refusal::{Code, Refusal};
use crate::app::{App, overview, types};
use crate::http::mcp::results::{Outcome, Stop};

pub const NAME: &str = "marfa_overview";

pub fn definition() -> Definition {
    Definition {
        name: NAME,
        title: "Overview of this Marfa",
        description: "Call first. Without arguments, returns what this Marfa holds and what you may do. With `type`, one id or up to 20, returns those types and their guidance. Read a type here before saving an item of it, and choose the type whose guidance fits.",
        input: json!({
            "type": "object",
            "properties": {
                "type": {
                    "description": "One type id, or 1 to 20 distinct ids, such as `core.note`.",
                    "anyOf": [
                        { "type": "string", "minLength": 1 },
                        {
                            "type": "array",
                            "minItems": 1,
                            "maxItems": 20,
                            "uniqueItems": true,
                            "items": { "type": "string", "minLength": 1 },
                        },
                    ],
                },
            },
            "additionalProperties": false,
        }),
        output: json!({
            "type": "object",
            "properties": {
                "instance": { "type": "object" },
                "credential": { "type": "object" },
                "types": { "type": "array", "items": { "type": "object" },
                    "description": "Without arguments, each type you can read, with `parent` when it has one. With several type ids, those types in the order asked." },
                "unknown": { "type": "array", "items": { "type": "string" },
                    "description": "Ids from a type array that are not types. Absent when every id is a type." },
                "unreadable": { "type": "array", "items": { "type": "string" },
                    "description": "Ids from a type array whose stored definition cannot be read now. Absent when every type reads." },
                "total": { "type": "integer" },
                "edge_types": { "type": "array", "items": { "type": "object" } },
                "tags": { "type": "array", "items": { "type": "object" } },
                "views": { "type": "array", "items": { "type": "object" } },
                "folders": { "type": "array", "items": { "type": "object" } },
                "truncated": { "type": "object" },
                "type": { "type": "object",
                    "description": "The one type asked for, with `guidance` and `ancestor_guidance` when any is set, and each status word's description." },
            },
        }),
        annotations: super::reads(),
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
    if let Some(guidance) = schema
        .get("guidance")
        .and_then(Value::as_str)
        .filter(|guidance| !guidance.is_empty())
    {
        out.insert("guidance".into(), guidance.into());
    }
    if let Some(above) = schema
        .get("ancestor_guidance")
        .and_then(Value::as_array)
        .filter(|above| !above.is_empty())
    {
        out.insert("ancestor_guidance".into(), Value::Array(above.clone()));
    }
    Value::Object(out)
}

pub async fn run(app: &Arc<App>, caller: &Caller, arguments: Map<String, Value>) -> Outcome {
    match arguments.get("type") {
        Some(asked) => asked_types(app, asked).await,
        None => Ok(overview::read(app, caller).await?),
    }
}

async fn asked_types(app: &Arc<App>, asked: &Value) -> Outcome {
    let ids: Vec<String> = match asked {
        Value::String(id) => {
            return Ok(json!({ "type": compact(&types::get(app, id.clone()).await?) }));
        }
        Value::Array(ids) => ids
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect(),
        _ => {
            return Err(Stop::invalid(
                "type must be a string or an array of type ids.",
            ));
        }
    };
    let mut found = Vec::new();
    let mut unknown = Vec::new();
    let mut unreadable = Vec::new();
    let mut first_fault = None;
    for id in ids {
        match types::get(app, id.clone()).await {
            Ok(schema) => found.push(compact(&schema)),
            Err(refusal) if refusal.code == Code::TypeNotFound => unknown.push(id),
            Err(refusal) => {
                unreadable.push(id);
                first_fault.get_or_insert(refusal);
            }
        }
    }
    if found.is_empty()
        && let Some(refusal) = first_fault
    {
        return Err(refusal.into());
    }
    if found.is_empty() {
        let message = match unknown.as_slice() {
            [id] => format!("Type \"{id}\" not found"),
            other => format!("Type \"{}\" not found", other.join("\", \"")),
        };
        return Err(Refusal::new(Code::TypeNotFound, message).into());
    }
    let mut out = Map::new();
    out.insert("types".into(), Value::Array(found));
    if !unknown.is_empty() {
        out.insert("unknown".into(), json!(unknown));
    }
    if !unreadable.is_empty() {
        out.insert("unreadable".into(), json!(unreadable));
    }
    Ok(Value::Object(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_type_keeps_what_writing_an_item_needs_and_drops_the_rest() {
        let compacted = compact(&json!({
            "id": "user.recipe",
            "label": "Recipe",
            "provenance": { "origin": "registered" },
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

    #[test]
    fn guidance_and_status_word_descriptions_stay_and_empty_guidance_is_left_out() {
        let kept = compact(&json!({
            "id": "user.child",
            "guidance": "Own.",
            "ancestor_guidance": [{ "type": "core.note", "guidance": "From the parent." }],
            "fields": {
                "status": {
                    "type": "status",
                    "label": "Status",
                    "status_values": [{
                        "value": "open",
                        "group": "not_started",
                        "description": "Not begun.",
                    }],
                },
            },
        }));
        assert_eq!(kept["guidance"], "Own.");
        assert_eq!(kept["ancestor_guidance"][0]["type"], "core.note");
        assert_eq!(
            kept["fields"]["status"]["status_values"][0]["description"],
            "Not begun."
        );
        assert!(kept["fields"]["status"].get("label").is_none());
        let bare = compact(&json!({
            "id": "core.entity",
            "guidance": "",
            "ancestor_guidance": [],
            "fields": {},
        }));
        assert!(bare.get("guidance").is_none());
        assert!(bare.get("ancestor_guidance").is_none());
    }
}
