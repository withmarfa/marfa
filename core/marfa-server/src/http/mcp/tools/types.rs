//! `marfa_save_type`: registers a type or merges a change into one's own definition.

use std::sync::Arc;

use serde_json::{Map, Value, json};

use super::overview::compact;
use super::{Definition, text};
use crate::app::App;
use crate::app::access::Caller;
use crate::app::types::{self, Merge};
use crate::http::mcp::results::{Outcome, Stop};

pub const NAME: &str = "marfa_save_type";

pub fn definition() -> Definition {
    Definition {
        name: NAME,
        title: "Register or change a type",
        description: "Use to add a type of item, or to change one's label, description, fields or tables. Changing merges what you send into the type's own definition: a field or table set to null is removed, and items keep their values for a removed field. A field or table the type inherits is changed or removed on the type it comes from.",
        input: json!({
            "type": "object",
            "properties": {
                "action": { "type": "string", "enum": ["register", "change"] },
                "id": { "type": "string", "minLength": 1,
                    "description": "The type's identifier, such as `user.recipe`. A new type goes under `user.*` or `app.*`." },
                "label": { "type": "string", "minLength": 1 },
                "description": { "type": "string" },
                "fields": { "type": "object",
                    "description": "Fields by name. Required to register. To change, the fields to add or replace, and null for each to remove." },
                "tables": { "type": "object",
                    "description": "Tables by name, each with `columns` (a name to a `type`: string, number, integer, boolean, date, datetime, email, url, enum with `enum_values`, or item with `type_constraints`), and optional `label`, `description`, and per column `required`, `adds_up` (sum, average, min, max or count) and `searchable`. To change, a table named here replaces the one of that name, and null removes it." },
                "parent": { "type": "string",
                    "description": "A type to inherit fields from. Only to register." },
            },
            "required": ["action", "id"],
            "additionalProperties": false,
        }),
        output: json!({
            "type": "object",
            "properties": {
                "type": { "type": "object" },
                "next": { "type": "string" },
            },
            "required": ["type"],
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

pub async fn run(app: &Arc<App>, caller: &Caller, arguments: Map<String, Value>) -> Outcome {
    let id = text(&arguments, "id").unwrap_or_default();
    let fields = match arguments.get("fields") {
        Some(Value::Object(fields)) => Some(fields.clone()),
        _ => None,
    };
    let tables = match arguments.get("tables") {
        Some(Value::Object(tables)) => tables.clone(),
        _ => Map::new(),
    };
    if text(&arguments, "action").as_deref() == Some("register") {
        let Some(fields) = fields else {
            return Err(Stop::invalid("A new type needs fields."));
        };
        if let Some((name, _)) = fields.iter().find(|(_, field)| field.is_null()) {
            return Err(Stop::invalid(format!(
                "A new type cannot remove a field ({name} is null)."
            )));
        }
        if let Some((name, _)) = tables.iter().find(|(_, table)| table.is_null()) {
            return Err(Stop::invalid(format!(
                "A new type cannot remove a table ({name} is null)."
            )));
        }
        let mut body = Map::new();
        body.insert("id".into(), id.into());
        body.insert("fields".into(), Value::Object(fields));
        if !tables.is_empty() {
            body.insert("tables".into(), Value::Object(tables));
        }
        for name in ["label", "description", "parent"] {
            if let Some(value) = arguments.get(name) {
                body.insert(name.into(), value.clone());
            }
        }
        let made = types::register(app, caller, body).await?;
        return Ok(json!({
            "type": compact(&made),
            "next": "Registered. Save items of it with marfa_create.",
        }));
    }
    if arguments.contains_key("parent") {
        return Err(Stop::invalid(
            "A type's parent is set when it is registered.",
        ));
    }
    let merge = Merge {
        label: text(&arguments, "label"),
        description: text(&arguments, "description"),
        fields: fields.unwrap_or_default(),
        tables,
    };
    let changed = types::change(app, caller, id, merge).await?;
    Ok(json!({ "type": compact(&changed) }))
}
