//! The types and edge types the server holds: the core's shipped catalog,
//! written into the shared `types` and `edge_types` tables at each start.

use marfa_core::server::{self, Catalog};
use rusqlite::{Connection, TransactionBehavior, params};
use serde_json::{Map, Value};

/// Writes the shipped catalog where it differs from what is held, and marks
/// the catalog held, which the core's type reads ask for.
pub fn seed(conn: &mut Connection) -> Result<(), String> {
    let shipped = server::builtin_catalog().map_err(|error| error.to_string())?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    server::replace_types(&tx, &shipped.types).map_err(|error| error.to_string())?;
    server::replace_edge_types(&tx, &shipped.edge_types).map_err(|error| error.to_string())?;
    // A working copy holds an edge type whole only if it says so; this server
    // holds every edge, so the core's `backref` terms are answered.
    let edge_ids: Vec<&str> = shipped
        .edge_types
        .iter()
        .filter_map(|edge_type| edge_type.get("id")?.as_str())
        .collect();
    server::meta_set(
        &tx,
        server::META_SLICE_EDGE_TYPES,
        &serde_json::to_string(&edge_ids).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    tx.execute(
        "INSERT INTO meta (key, value) VALUES (?1, '1') ON CONFLICT (key) DO NOTHING",
        params![server::META_CATALOG_VERSION],
    )
    .map_err(|error| error.to_string())?;
    tx.commit().map_err(|error| error.to_string())
}

pub fn load(conn: &Connection) -> Result<Catalog, String> {
    Catalog::load(conn).map_err(|error| error.to_string())
}

/// Each held type's definition as it was declared, by id.
pub fn type_rows(conn: &Connection) -> rusqlite::Result<Vec<Map<String, Value>>> {
    let mut statement = conn.prepare_cached("SELECT json FROM types ORDER BY id")?;
    let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
    let mut types = Vec::new();
    for json in rows {
        if let Ok(Value::Object(definition)) = serde_json::from_str(&json?) {
            types.push(definition);
        }
    }
    Ok(types)
}

pub fn edge_type_rows(conn: &Connection) -> rusqlite::Result<Vec<Value>> {
    let mut statement = conn.prepare_cached("SELECT json FROM edge_types ORDER BY id")?;
    let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
    let mut types = Vec::new();
    for json in rows {
        if let Ok(definition) = serde_json::from_str(&json?) {
            types.push(definition);
        }
    }
    Ok(types)
}
