//! The shipped catalog: the types and lists a copy holds before it reaches a server.

use std::collections::HashMap;
use std::sync::OnceLock;

use serde_json::{Map, Value};

use crate::error::RuleError;
use crate::wire::{WireCatalog, WireType};

const CATALOG: &str = include_str!("builtin_catalog.json");

pub fn catalog() -> Result<WireCatalog, RuleError> {
    static PARSED: OnceLock<Result<WireCatalog, String>> = OnceLock::new();
    PARSED
        .get_or_init(|| {
            let mut document: Value = serde_json::from_str(CATALOG).map_err(|e| e.to_string())?;
            let edge_types = match document["edge_types"].take() {
                Value::Array(rows) => rows,
                _ => return Err("the shipped catalog has no edge types".into()),
            };
            let types: Vec<WireType> =
                serde_json::from_value(document["types"].take()).map_err(|e| e.to_string())?;
            Ok(WireCatalog { types, edge_types })
        })
        .clone()
        .map_err(|error| RuleError::decoding(format!("the shipped catalog: {error}")))
}

fn list(key: &str) -> Result<Vec<String>, RuleError> {
    static PARSED: OnceLock<Result<HashMap<String, Vec<String>>, String>> = OnceLock::new();
    PARSED
        .get_or_init(|| {
            let document: Value = serde_json::from_str(CATALOG).map_err(|e| e.to_string())?;
            [
                "field_types",
                "entry_member_types",
                "reserved_type_roots",
                "reserved_field_names",
                "searched_field_names",
            ]
            .into_iter()
            .map(|key| {
                serde_json::from_value(document[key].clone())
                    .map(|names| (key.to_string(), names))
                    .map_err(|e| format!("{key}: {e}"))
            })
            .collect()
        })
        .clone()
        .map_err(|error| RuleError::decoding(format!("the shipped catalog's lists: {error}")))
        .and_then(|lists| {
            lists
                .get(key)
                .cloned()
                .ok_or_else(|| RuleError::decoding(format!("the shipped catalog has no {key}")))
        })
}

pub fn field_types() -> Result<Vec<String>, RuleError> {
    list("field_types")
}

pub fn entry_member_types() -> Result<Vec<String>, RuleError> {
    list("entry_member_types")
}

/// The kind each string format turns into; a format absent from it annotates the string and leaves it one.
pub fn format_field_types() -> Result<&'static HashMap<String, String>, RuleError> {
    static PARSED: OnceLock<Result<HashMap<String, String>, String>> = OnceLock::new();
    PARSED
        .get_or_init(|| {
            let document: Value = serde_json::from_str(CATALOG).map_err(|e| e.to_string())?;
            serde_json::from_value(document["format_field_types"].clone())
                .map_err(|e| e.to_string())
        })
        .as_ref()
        .map_err(|error| RuleError::decoding(format!("the shipped catalog's formats: {error}")))
}

pub fn reserved_type_roots() -> Result<Vec<String>, RuleError> {
    list("reserved_type_roots")
}

pub fn reserved_field_names() -> Result<Vec<String>, RuleError> {
    list("reserved_field_names")
}

pub fn searched_field_names() -> Result<Vec<String>, RuleError> {
    list("searched_field_names")
}

pub fn ships(id: &str) -> Result<bool, RuleError> {
    Ok(catalog()?.types.iter().any(|shipped| shipped.id == id))
}

pub fn shipped_types() -> Result<&'static [Map<String, Value>], RuleError> {
    static PARSED: OnceLock<Result<Vec<Map<String, Value>>, String>> = OnceLock::new();
    PARSED
        .get_or_init(|| {
            let mut document: Value = serde_json::from_str(CATALOG).map_err(|e| e.to_string())?;
            let mut types: Vec<Map<String, Value>> =
                serde_json::from_value(document["types"].take()).map_err(|e| e.to_string())?;
            types.sort_by(|a, b| {
                a.get("id")
                    .and_then(Value::as_str)
                    .cmp(&b.get("id").and_then(Value::as_str))
            });
            Ok(types)
        })
        .as_ref()
        .map(Vec::as_slice)
        .map_err(|error| RuleError::decoding(format!("the shipped catalog: {error}")))
}

pub fn shipped_edge_types() -> Result<&'static [Value], RuleError> {
    static PARSED: OnceLock<Result<Vec<Value>, String>> = OnceLock::new();
    PARSED
        .get_or_init(|| {
            let mut document: Value = serde_json::from_str(CATALOG).map_err(|e| e.to_string())?;
            match document["edge_types"].take() {
                Value::Array(rows) => Ok(rows),
                _ => Err("the shipped catalog has no edge types".into()),
            }
        })
        .as_ref()
        .map(Vec::as_slice)
        .map_err(|error| RuleError::decoding(format!("the shipped catalog: {error}")))
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use serde_json::{Map, Value, json};

    use super::catalog;

    #[test]
    fn the_shipped_game_and_rating_are_judged_as_the_server_judges_them() {
        let shipped = catalog().unwrap();
        let game = shipped
            .types
            .iter()
            .find(|t| t.id == "core.media.game")
            .unwrap();
        let fields: BTreeMap<&str, &Value> = game.rest["fields"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(name, definition)| (name.as_str(), definition))
            .collect();
        let judged = |properties: Value| {
            let Value::Object(properties): Value = properties else {
                unreachable!()
            };
            crate::validation::properties(&fields, &properties, true)
                .err()
                .map(|e| e.to_string())
        };
        let title = |extra: Value| {
            let mut properties = Map::from_iter([("title".to_string(), json!("A game"))]);
            properties.extend(extra.as_object().unwrap().clone());
            Value::Object(properties)
        };
        assert_eq!(
            judged(title(
                json!({"platforms": ["PC", "Tabletop"], "min_players": 1, "max_players": 4, "rating": 5})
            )),
            None
        );
        for bad in [
            json!({"rating": 0}),
            json!({"rating": 6}),
            json!({"rating": 3.5}),
            json!({"min_players": 0}),
            json!({"max_players": -1}),
            json!({"platforms": ["PC", 1]}),
        ] {
            let name = bad.as_object().unwrap().keys().next().unwrap().clone();
            let refusal = judged(title(bad.clone()));
            assert!(
                refusal.is_some_and(|message| message.contains(&name)),
                "{bad}"
            );
        }
    }
}
