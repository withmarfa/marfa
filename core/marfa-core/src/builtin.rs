//! The types Marfa ships, as a fresh server lists them, which a copy that has
//! never reached a server holds as its catalog. Written from the registry by
//! `scripts/generate-core-catalog.ts`.

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

/// The field types a type may declare, as the registry takes them.
pub(crate) fn field_types() -> Result<Vec<String>, CoreError> {
    static PARSED: OnceLock<Result<Vec<String>, String>> = OnceLock::new();
    PARSED
        .get_or_init(|| {
            let document: Value = serde_json::from_str(CATALOG).map_err(|e| e.to_string())?;
            serde_json::from_value(document["field_types"].clone()).map_err(|e| e.to_string())
        })
        .clone()
        .map_err(|error| CoreError::Decoding(format!("the shipped field types: {error}")))
}

/// Whether Marfa ships a type by this id.
pub(crate) fn ships(id: &str) -> Result<bool, CoreError> {
    Ok(catalog()?.types.iter().any(|shipped| shipped.id == id))
}
