//! The types Marfa ships, as a fresh server lists them, which a copy that has
//! never reached a server holds as its catalog. Written from the registry by
//! `scripts/generate-core-catalog.ts`.

use std::collections::HashMap;
use std::sync::OnceLock;

use serde_json::Value;

use crate::error::CoreError;
use crate::wire::{WireCatalog, WireType};

const CATALOG: &str = include_str!("builtin_catalog.json");

pub(crate) fn catalog() -> Result<WireCatalog, CoreError> {
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
        .map_err(|error| CoreError::Decoding(format!("the shipped catalog: {error}")))
}

/// The lists the catalog carries beside its types, each read once.
fn list(key: &str) -> Result<Vec<String>, CoreError> {
    static PARSED: OnceLock<Result<HashMap<String, Vec<String>>, String>> = OnceLock::new();
    PARSED
        .get_or_init(|| {
            let document: Value = serde_json::from_str(CATALOG).map_err(|e| e.to_string())?;
            [
                "field_types",
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
        .map_err(|error| CoreError::Decoding(format!("the shipped catalog's lists: {error}")))
        .and_then(|lists| {
            lists
                .get(key)
                .cloned()
                .ok_or_else(|| CoreError::Decoding(format!("the shipped catalog has no {key}")))
        })
}

/// The field types a type may declare, as the registry takes them.
pub(crate) fn field_types() -> Result<Vec<String>, CoreError> {
    list("field_types")
}

/// The roots the type grammar reserves, which no publisher may take as its own.
pub(crate) fn reserved_type_roots() -> Result<Vec<String>, CoreError> {
    list("reserved_type_roots")
}

/// The names an item has of its own, which a type cannot declare as a field.
pub(crate) fn reserved_field_names() -> Result<Vec<String>, CoreError> {
    list("reserved_field_names")
}

/// The field names search reads whatever their type, which a thumbnail
/// cannot take.
pub(crate) fn searched_field_names() -> Result<Vec<String>, CoreError> {
    list("searched_field_names")
}

/// Whether Marfa ships a type by this id.
pub(crate) fn ships(id: &str) -> Result<bool, CoreError> {
    Ok(catalog()?.types.iter().any(|shipped| shipped.id == id))
}
