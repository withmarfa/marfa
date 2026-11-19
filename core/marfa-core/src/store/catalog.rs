//! The types and edge types the copy holds.

use super::attachments::reconcile_attachments;
use super::index::reindex;
use super::meta::{META_CATALOG_VERSION, META_LOCAL_CATALOG, meta_delete, meta_get, meta_set};
use crate::error::CoreError;
use marfa_rules::wire::{WireCatalog, WireType};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Map, Value};
use uuid::Uuid;

type TypeRow = (
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    String,
);

/// What a replacement did to the catalog held, decided once, where the rows
/// are compared, for every reader of the verdict: the reindex and a hydration
/// that may resume.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CatalogChange {
    /// The same catalog; nothing was written.
    Unchanged,
    /// A server's catalog was held and the new one differs from it in nothing
    /// but types' icons, which no index reads. The version moved.
    IconsOnly,
    /// Anything else, a first catalog and a copy's own replaced included. The
    /// version moved.
    Changed,
}

impl CatalogChange {
    /// Whether the catalog version moved.
    pub fn is_changed(self) -> bool {
        self != Self::Unchanged
    }
}

/// The one way a catalog the server answered is written: both catalogs and
/// a new catalog version where either changed or none was held, all or
/// nothing. A savepoint rather than a transaction, so it holds alone and
/// inside a hydration's.
pub fn replace_catalog(
    conn: &Connection,
    catalog: &WireCatalog,
) -> Result<CatalogChange, CoreError> {
    catalog_scope(conn, |conn| {
        let types = replace_types(conn, &catalog.types)?;
        #[cfg(debug_assertions)]
        crate::fault::hold(|| "catalog-replacing");
        let edge_types = replace_edge_types(conn, &catalog.edge_types)?;
        // A server's catalog replaces the copy's own, which is a change
        // whether or not the rows differ.
        let local = meta_get(conn, META_LOCAL_CATALOG)?.is_some();
        meta_delete(conn, META_LOCAL_CATALOG)?;
        let held = catalog_version(conn)?;
        if types == CatalogChange::Unchanged && !edge_types && !local && held.is_some() {
            return Ok(CatalogChange::Unchanged);
        }
        let next = held.map_or(1, |version| version + 1);
        meta_set(conn, META_CATALOG_VERSION, &next.to_string())?;
        // Which types are files is the catalog's to say.
        reconcile_attachments(conn)?;
        crate::tables::reconcile_all(conn)?;
        Ok(
            if types == CatalogChange::IconsOnly && !edge_types && !local {
                CatalogChange::IconsOnly
            } else {
                CatalogChange::Changed
            },
        )
    })
}

/// Whether the copy holds a catalog to read: a server's, or its own.
pub fn catalog_held(conn: &Connection) -> Result<bool, CoreError> {
    Ok(catalog_version(conn)?.is_some() || meta_get(conn, META_LOCAL_CATALOG)?.is_some())
}

/// The catalog of a copy that has never held a server's: the types and edge
/// types Marfa ships, and the types the app declared. The same tables a
/// server's catalog goes in, so every read of a type reads this the same way
/// until a hydration replaces it. Left alone where a server's is held, and
/// written only where it changes.
pub fn hold_local_catalog(conn: &Connection) -> Result<(), CoreError> {
    if catalog_version(conn)?.is_some() {
        return Ok(());
    }
    let (types, edge_types) = local_catalog(conn)?;
    catalog_scope(conn, |conn| {
        replace_types(conn, &types)?;
        replace_edge_types(conn, &edge_types)?;
        if meta_get(conn, META_LOCAL_CATALOG)?.as_deref() != Some("1") {
            meta_set(conn, META_LOCAL_CATALOG, "1")?;
        }
        Ok(())
    })
}

/// `hold_local_catalog` for a connection in no transaction, as an open is.
/// It reads first, so an open with nothing to change takes no write lock.
/// Where it changes something it takes the write lock before the reads it
/// acts on: in WAL mode a read transaction that turns into a write while
/// another connection writes is refused at once, without the busy timeout.
pub fn hold_local_catalog_alone(conn: &Connection) -> Result<(), CoreError> {
    if catalog_version(conn)?.is_some() || local_catalog_held(conn)? {
        return Ok(());
    }
    let tx = rusqlite::Transaction::new_unchecked(conn, rusqlite::TransactionBehavior::Immediate)?;
    hold_local_catalog(&tx)?;
    tx.commit()?;
    Ok(())
}

fn local_catalog(conn: &Connection) -> Result<(Vec<WireType>, Vec<Value>), CoreError> {
    let shipped = marfa_rules::builtin::catalog()?;
    let mut types = shipped.types;
    for (id, json) in declared_type_rows(conn)? {
        let unreadable = |error: serde_json::Error| {
            CoreError::Store(format!("the declared type {id} cannot be read: {error}"))
        };
        // Held as the registry holds it, as a server's catalog already is.
        let declared = marfa_rules::catalog::normalized_type(
            &serde_json::from_str(&json).map_err(unreadable)?,
        )?;
        types.push(serde_json::from_value(declared).map_err(unreadable)?);
    }
    Ok((types, shipped.edge_types))
}

/// Whether the store holds the local catalog as `hold_local_catalog` writes
/// it. False where a server's catalog is held.
fn local_catalog_held(conn: &Connection) -> Result<bool, CoreError> {
    let (types, edge_types) = local_catalog(conn)?;
    Ok(meta_get(conn, META_LOCAL_CATALOG)?.as_deref() == Some("1")
        && held_type_rows(conn)? == type_rows_of(&types)
        && edge_type_rows(conn)? == edge_rows_of(&edge_types)?)
}

/// The types the app declared, by id, each as the JSON the server lists a
/// type as.
pub fn declared_type_rows(conn: &Connection) -> Result<Vec<(String, String)>, CoreError> {
    rows_of(conn, "SELECT id, json FROM declared_types ORDER BY id")
}

pub fn declare_type(conn: &Connection, id: &str, json: &str) -> Result<(), CoreError> {
    conn.execute(
        "INSERT INTO declared_types (id, json) VALUES (?1, ?2)
         ON CONFLICT (id) DO UPDATE SET json = excluded.json",
        params![id, json],
    )?;
    Ok(())
}

pub fn clear_declared_types(conn: &Connection) -> Result<(), CoreError> {
    conn.execute("DELETE FROM declared_types", [])?;
    Ok(())
}

/// Both reads and replacements nest inside a caller's transaction. The
/// connection is shared immutably, so rusqlite's mutable savepoint guard
/// cannot represent this scope.
pub(crate) fn catalog_scope<T>(
    conn: &Connection,
    operation: impl FnOnce(&Connection) -> Result<T, CoreError>,
) -> Result<T, CoreError> {
    // Distinct names let an outer scope unwind past an inner scope whose
    // rollback failed, without accidentally releasing the inner one only.
    let name = format!("marfa_catalog_{}", Uuid::now_v7().simple());
    conn.execute_batch(&format!("SAVEPOINT {name}"))?;
    let mut scope = CatalogScope {
        conn,
        name,
        finished: false,
    };
    let error = match operation(conn) {
        Ok(value) => match scope.release() {
            Ok(()) => return Ok(value),
            Err(error) => CoreError::from(error),
        },
        Err(error) => error,
    };
    match scope.rollback() {
        Ok(()) => Err(error),
        Err(cleanup) => Err(CoreError::Store(format!(
            "{error}; catalog rollback failed: {cleanup}; cleanup could not be confirmed"
        ))),
    }
}

struct CatalogScope<'a> {
    conn: &'a Connection,
    name: String,
    finished: bool,
}

impl CatalogScope<'_> {
    fn release(&mut self) -> rusqlite::Result<()> {
        self.conn.execute_batch(&format!("RELEASE {}", self.name))?;
        self.finished = true;
        Ok(())
    }

    fn rollback(&mut self) -> rusqlite::Result<()> {
        // SQLite can abort the entire transaction on an I/O failure or
        // RAISE(ROLLBACK); in that case there is no scope left to close.
        if self.conn.is_autocommit() {
            self.finished = true;
            return Ok(());
        }
        self.conn
            .execute_batch(&format!("ROLLBACK TO {}", self.name))?;
        // Releasing after a failed rollback could commit partial writes.
        self.release()
    }
}

impl Drop for CatalogScope<'_> {
    fn drop(&mut self) {
        if !self.finished {
            // Also protects unwinding and retries a transient cleanup error.
            // An ordinary return reports any failure before this fallback.
            let _ = self.rollback();
        }
    }
}

pub fn catalog_version(conn: &Connection) -> Result<Option<u64>, CoreError> {
    meta_get(conn, META_CATALOG_VERSION)?
        .map(|text| {
            text.parse().map_err(|_| {
                CoreError::Store(format!(
                    "the stored catalog version {text:?} is not a number"
                ))
            })
        })
        .transpose()
}

/// Writes nothing where the catalog is unchanged: a follow fetches it on
/// every stream it opens, and a reader would be told of a save each time.
/// A change reindexes every held row, except one that touches only types'
/// icons, which nothing indexed reads. `IconsOnly` is what the types alone
/// did; `replace_catalog` says whether the rest of the catalog moved with
/// them. Outside tests, only `replace_catalog` calls it.
pub fn replace_types(conn: &Connection, types: &[WireType]) -> Result<CatalogChange, CoreError> {
    let rows = type_rows_of(types);
    let held = held_type_rows(conn)?;
    if held == rows {
        return Ok(CatalogChange::Unchanged);
    }
    let icons_only = without_icons(&held) == without_icons(&rows);
    conn.execute("DELETE FROM types", [])?;
    {
        let mut insert = conn.prepare(
            "INSERT INTO types (id, parent, label, title_field, thumbnail_field, json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        )?;
        for row in rows {
            insert.execute(params![row.0, row.1, row.2, row.3, row.4, row.5])?;
        }
    }
    if icons_only {
        return Ok(CatalogChange::IconsOnly);
    }
    reindex(conn)?;
    Ok(CatalogChange::Changed)
}

/// Each row with the icon its definition declares taken out, and an
/// emptied `display_hints` with it, so two sets compare equal where they
/// differ in icons alone.
fn without_icons(rows: &[TypeRow]) -> Vec<TypeRow> {
    rows.iter()
        .map(|row| {
            let mut row = row.clone();
            if let Ok(Value::Object(mut json)) = serde_json::from_str::<Value>(&row.5) {
                if let Some(Value::Object(hints)) = json.get_mut("display_hints") {
                    hints.remove("icon");
                    if hints.is_empty() {
                        json.remove("display_hints");
                    }
                }
                row.5 = Value::Object(json).to_string();
            }
            row
        })
        .collect()
}

fn held_type_rows(conn: &Connection) -> Result<Vec<TypeRow>, CoreError> {
    Ok(conn
        .prepare(
            "SELECT id, parent, label, title_field, thumbnail_field, json FROM types ORDER BY id",
        )?
        .query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
            ))
        })?
        .collect::<Result<_, _>>()?)
}

fn type_rows_of(types: &[WireType]) -> Vec<TypeRow> {
    let mut rows: Vec<TypeRow> = types
        .iter()
        .map(|entry| {
            let hints = entry.display_hints.clone().unwrap_or_default();
            let mut json = entry.rest.clone();
            json.insert("id".into(), Value::String(entry.id.clone()));
            if let Some(parent) = &entry.parent {
                json.insert("parent".into(), Value::String(parent.clone()));
            }
            if let Some(label) = &entry.label {
                json.insert("label".into(), Value::String(label.clone()));
            }
            // The hints as the type declares them, not as it inherits them:
            // each hint is resolved from the nearest type that sets it.
            if let Some(declared) = &entry.display_hints {
                let mut block = Map::new();
                if let Some(title) = &declared.title_field {
                    block.insert("title_field".into(), Value::String(title.clone()));
                }
                if let Some(body) = &declared.body_field {
                    block.insert("body_field".into(), Value::String(body.clone()));
                }
                if let Some(named) = declared.name_from_body {
                    block.insert("name_from_body".into(), Value::Bool(named));
                }
                if let Some(icon) = &declared.icon {
                    block.insert("icon".into(), Value::String(icon.clone()));
                }
                json.insert("display_hints".into(), Value::Object(block));
            }
            (
                entry.id.clone(),
                entry.parent.clone(),
                entry.label.clone(),
                hints.title_field,
                marfa_rules::catalog::thumbnail_field_of(&entry.rest),
                Value::Object(json).to_string(),
            )
        })
        .collect();
    rows.sort();
    rows
}

/// Writes nothing where the catalog is unchanged, as `replace_types` does.
/// Answers whether it changed.
fn replace_edge_types(conn: &Connection, rows: &[Value]) -> Result<bool, CoreError> {
    let wanted = edge_rows_of(rows)?;
    if edge_type_rows(conn)? == wanted {
        return Ok(false);
    }
    conn.execute("DELETE FROM edge_types", [])?;
    let mut insert = conn.prepare("INSERT INTO edge_types (id, json) VALUES (?1, ?2)")?;
    for (id, json) in wanted {
        insert.execute(params![id, json])?;
    }
    Ok(true)
}

fn edge_rows_of(rows: &[Value]) -> Result<Vec<(String, String)>, CoreError> {
    let mut wanted: Vec<(String, String)> =
        rows.iter()
            .map(|row| {
                let id = row.get("id").and_then(Value::as_str).ok_or_else(|| {
                    CoreError::Decoding(format!("an edge type with no id: {row}"))
                })?;
                Ok((id.to_string(), row.to_string()))
            })
            .collect::<Result<_, CoreError>>()?;
    wanted.sort();
    Ok(wanted)
}

/// Each type as `(id, json)`, by id.
pub fn type_rows(conn: &Connection) -> Result<Vec<(String, String)>, CoreError> {
    rows_of(conn, "SELECT id, json FROM types ORDER BY id")
}

/// The item a part or an excerpt is named after (`types/item-name-part`).
pub(crate) struct NamingHost {
    /// The label of the edge's type.
    pub label: String,
    pub r#type: String,
    pub properties: Map<String, Value>,
}

/// The to item of the oldest edge of a `with-hosts` type or of `excerpt-of`
/// that `id` draws, by `created_at` and then id, among the to items the copy
/// holds out of the bin. The mode is read from the held catalog, so a
/// registered type counts.
pub(crate) fn naming_host(conn: &Connection, id: &str) -> Result<Option<NamingHost>, CoreError> {
    let found: Option<(String, String, String)> = conn
        .prepare_cached(
            "SELECT t.json, h.type, h.properties
               FROM edges e
               JOIN edge_types t ON t.id = e.edge_type
               JOIN items h ON h.id = e.to_id
              WHERE e.from_id = ?1
                AND (e.edge_type = 'excerpt-of'
                     OR CASE WHEN json_valid(t.json)
                        THEN json_extract(t.json, '$.cascade_on_delete') END = 'with-hosts')
                AND h.state <> 'trashed'
              ORDER BY e.created_at, e.id
              LIMIT 1",
        )?
        .query_row([id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .optional()?;
    let Some((edge_type, r#type, properties)) = found else {
        return Ok(None);
    };
    let label = serde_json::from_str::<marfa_rules::wire::WireEdgeType>(&edge_type)
        .map_err(|error| CoreError::Store(format!("a held edge type: {error}")))?
        .label();
    // A host whose stored properties cannot be read is named as one with
    // none, as the server names it.
    let properties = serde_json::from_str(&properties).unwrap_or_default();
    Ok(Some(NamingHost {
        label,
        r#type,
        properties,
    }))
}

/// Each edge type as `(id, json)`, by id.
pub fn edge_type_rows(conn: &Connection) -> Result<Vec<(String, String)>, CoreError> {
    rows_of(conn, "SELECT id, json FROM edge_types ORDER BY id")
}

fn rows_of(conn: &Connection, sql: &str) -> Result<Vec<(String, String)>, CoreError> {
    Ok(conn
        .prepare(sql)?
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<Result<_, _>>()?)
}
