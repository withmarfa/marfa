use std::collections::HashMap;
use std::path::Path;

use rusqlite::{Connection, OptionalExtension, params, params_from_iter};
use serde_json::{Map, Value};

use crate::error::CoreError;
use crate::model::{Edge, Item, ItemState, Tier};
use crate::wire::{WireEdge, WireItem, WireType};

pub const SCHEMA: &str = include_str!("schema.sql");

pub const META_SCHEMA_VERSION: &str = "schema_version";
pub const META_SERVER_ORIGIN: &str = "server_origin";
pub const META_SLICE_TYPES: &str = "slice_types";
pub const META_SLICE_TIER: &str = "slice_tier";
pub const META_EVENT_CURSOR: &str = "event_cursor";
pub const META_HYDRATE_STATE: &str = "hydrate_state";
pub const HYDRATE_IN_PROGRESS: &str = "in_progress";
pub const SCHEMA_VERSION: &str = "provisional-1";

const ITEM_COLUMNS: &str = "id, type, state, tier, version, schema_version, source, source_id, device, timestamp, created_at, updated_at, properties";
const EDGE_COLUMNS: &str =
    "id, source_id, target_id, edge_type, properties, version, created_at, updated_at";

pub fn open(path: &Path) -> Result<Connection, CoreError> {
    let conn = Connection::open(path)?;
    prepare(&conn)?;
    Ok(conn)
}

pub fn open_in_memory() -> Result<Connection, CoreError> {
    let conn = Connection::open_in_memory()?;
    prepare(&conn)?;
    Ok(conn)
}

fn prepare(conn: &Connection) -> Result<(), CoreError> {
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA foreign_keys = ON;",
    )?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    conn.execute_batch(SCHEMA)?;
    if meta_get(conn, META_SCHEMA_VERSION)?.is_none() {
        meta_set(conn, META_SCHEMA_VERSION, SCHEMA_VERSION)?;
    }
    Ok(())
}

pub fn meta_get(conn: &Connection, key: &str) -> Result<Option<String>, CoreError> {
    Ok(conn
        .query_row("SELECT value FROM meta WHERE key = ?1", [key], |row| {
            row.get(0)
        })
        .optional()?)
}

pub fn meta_set(conn: &Connection, key: &str, value: &str) -> Result<(), CoreError> {
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?1, ?2)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

pub fn meta_delete(conn: &Connection, key: &str) -> Result<(), CoreError> {
    conn.execute("DELETE FROM meta WHERE key = ?1", [key])?;
    Ok(())
}

pub fn hydration_complete(conn: &Connection) -> Result<bool, CoreError> {
    Ok(meta_get(conn, META_HYDRATE_STATE)?.as_deref() != Some(HYDRATE_IN_PROGRESS))
}

pub fn refuse_unless_hydrated(conn: &Connection) -> Result<(), CoreError> {
    if hydration_complete(conn)? {
        Ok(())
    } else {
        Err(CoreError::HydrationIncomplete)
    }
}

pub fn replace_types(conn: &Connection, types: &[WireType]) -> Result<(), CoreError> {
    conn.execute("DELETE FROM types", [])?;
    let mut insert = conn.prepare(
        "INSERT INTO types (id, parent, label, title_field, json)
         VALUES (?1, ?2, ?3, ?4, ?5)",
    )?;
    for entry in types {
        let hints = entry.display_hints.clone().unwrap_or_default();
        let mut json = entry.rest.clone();
        json.insert("id".into(), Value::String(entry.id.clone()));
        if let Some(parent) = &entry.parent {
            json.insert("parent".into(), Value::String(parent.clone()));
        }
        if let Some(label) = &entry.label {
            json.insert("label".into(), Value::String(label.clone()));
        }
        insert.execute(params![
            entry.id,
            entry.parent,
            entry.label,
            hints.title_field,
            Value::Object(json).to_string(),
        ])?;
    }
    Ok(())
}

pub fn clear_slice(conn: &Connection) -> Result<(), CoreError> {
    conn.execute_batch(
        "DELETE FROM tags;
         DELETE FROM edges;
         DELETE FROM items;
         DELETE FROM items_fts;",
    )?;
    Ok(())
}

/// Writes or rewrites an item. `tags` replaces the item's tags when given and
/// leaves them alone when not, which is what an event without metadata means.
pub fn upsert_item(
    conn: &Connection,
    item: &WireItem,
    tags: Option<&[String]>,
    title_field: Option<&str>,
) -> Result<(), CoreError> {
    ItemState::from_str_checked(&item.state)?;
    conn.execute(
        "INSERT INTO items (id, type, state, tier, version, schema_version, source, source_id, device, timestamp, created_at, updated_at, properties)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
         ON CONFLICT (id) DO UPDATE SET
           type = excluded.type, state = excluded.state, tier = excluded.tier,
           version = excluded.version, schema_version = excluded.schema_version,
           source = excluded.source, source_id = excluded.source_id, device = excluded.device,
           timestamp = excluded.timestamp, created_at = excluded.created_at,
           updated_at = excluded.updated_at, properties = excluded.properties",
        params![
            item.id,
            item.r#type,
            item.state,
            item.tier,
            item.version,
            item.schema_version,
            item.source,
            item.source_id,
            item.device,
            item.timestamp,
            item.created_at,
            item.updated_at,
            Value::Object(item.properties.clone()).to_string(),
        ],
    )?;
    let tags: Vec<String> = match tags {
        Some(tags) => {
            conn.execute("DELETE FROM tags WHERE item_id = ?1", [&item.id])?;
            let mut insert =
                conn.prepare_cached("INSERT OR IGNORE INTO tags (item_id, tag) VALUES (?1, ?2)")?;
            for tag in tags {
                insert.execute(params![item.id, tag])?;
            }
            tags.to_vec()
        }
        None => tags_for_one(conn, &item.id)?,
    };
    let (title, body) = fts_text(&item.properties, title_field);
    let seq: i64 = conn.query_row("SELECT seq FROM items WHERE id = ?1", [&item.id], |row| {
        row.get(0)
    })?;
    conn.execute("DELETE FROM items_fts WHERE rowid = ?1", [seq])?;
    conn.execute(
        "INSERT INTO items_fts (rowid, title, body, tags) VALUES (?1, ?2, ?3, ?4)",
        params![seq, title, body, tags.join(" ")],
    )?;
    Ok(())
}

pub fn delete_item(conn: &Connection, id: &str) -> Result<bool, CoreError> {
    conn.execute(
        "DELETE FROM items_fts WHERE rowid IN (SELECT seq FROM items WHERE id = ?1)",
        [id],
    )?;
    conn.execute("DELETE FROM tags WHERE item_id = ?1", [id])?;
    conn.execute(
        "DELETE FROM edges WHERE source_id = ?1 OR target_id = ?1",
        [id],
    )?;
    Ok(conn.execute("DELETE FROM items WHERE id = ?1", [id])? > 0)
}

pub fn item_held(conn: &Connection, id: &str) -> Result<bool, CoreError> {
    Ok(conn
        .query_row("SELECT 1 FROM items WHERE id = ?1", [id], |_| Ok(()))
        .optional()?
        .is_some())
}

pub fn upsert_edge(conn: &Connection, edge: &WireEdge) -> Result<(), CoreError> {
    conn.execute(
        "INSERT INTO edges (id, source_id, target_id, edge_type, properties, version, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT (id) DO UPDATE SET
           source_id = excluded.source_id, target_id = excluded.target_id,
           edge_type = excluded.edge_type, properties = excluded.properties,
           version = excluded.version, created_at = excluded.created_at,
           updated_at = excluded.updated_at",
        params![
            edge.id,
            edge.source_id,
            edge.target_id,
            edge.edge_type,
            Value::Object(edge.properties.clone()).to_string(),
            edge.version,
            edge.created_at,
            edge.updated_at,
        ],
    )?;
    Ok(())
}

pub fn delete_edge(conn: &Connection, id: &str) -> Result<bool, CoreError> {
    Ok(conn.execute("DELETE FROM edges WHERE id = ?1", [id])? > 0)
}

pub fn item_by_id(conn: &Connection, id: &str) -> Result<Option<Item>, CoreError> {
    let mut items = items_by_ids(conn, std::slice::from_ref(&id.to_string()))?;
    Ok(items.pop())
}

/// Items for `ids`, in the order given, skipping ids not held.
pub fn items_by_ids(conn: &Connection, ids: &[String]) -> Result<Vec<Item>, CoreError> {
    let mut by_id: HashMap<String, Item> = HashMap::new();
    for chunk in ids.chunks(500) {
        let placeholders = vec!["?"; chunk.len()].join(", ");
        let sql = format!("SELECT {ITEM_COLUMNS} FROM items WHERE id IN ({placeholders})");
        let mut statement = conn.prepare(&sql)?;
        let rows = statement.query_map(params_from_iter(chunk.iter()), row_to_item)?;
        for row in rows {
            let item = row?;
            by_id.insert(item.id.clone(), item);
        }
    }
    let tags = tags_for(conn, ids)?;
    Ok(ids
        .iter()
        .filter_map(|id| by_id.remove(id))
        .map(|mut item| {
            item.tags = tags.get(&item.id).cloned().unwrap_or_default();
            item
        })
        .collect())
}

pub fn items_where(
    conn: &Connection,
    where_sql: &str,
    order_sql: &str,
    limit_sql: &str,
    values: &[Value],
) -> Result<Vec<Item>, CoreError> {
    let sql = format!("SELECT {ITEM_COLUMNS} FROM items WHERE {where_sql} {order_sql} {limit_sql}");
    let mut statement = conn.prepare(&sql)?;
    let params = values.iter().map(sql_value).collect::<Vec<_>>();
    let rows = statement.query_map(params_from_iter(params.iter()), row_to_item)?;
    let mut items = rows.collect::<Result<Vec<Item>, _>>()?;
    let ids: Vec<String> = items.iter().map(|item| item.id.clone()).collect();
    let tags = tags_for(conn, &ids)?;
    for item in &mut items {
        item.tags = tags.get(&item.id).cloned().unwrap_or_default();
    }
    Ok(items)
}

pub fn edges_from(conn: &Connection, source_id: &str) -> Result<Vec<Edge>, CoreError> {
    let sql =
        format!("SELECT {EDGE_COLUMNS} FROM edges WHERE source_id = ?1 ORDER BY created_at, id");
    let mut statement = conn.prepare(&sql)?;
    let rows = statement.query_map([source_id], row_to_edge)?;
    Ok(rows.collect::<Result<Vec<Edge>, _>>()?)
}

pub fn count(conn: &Connection, table: &str) -> Result<u64, CoreError> {
    let sql = format!("SELECT COUNT(*) FROM {table}");
    Ok(conn.query_row(&sql, [], |row| row.get::<_, i64>(0))? as u64)
}

fn sql_value(value: &Value) -> rusqlite::types::Value {
    match value {
        Value::Null => rusqlite::types::Value::Null,
        Value::Bool(flag) => rusqlite::types::Value::Integer(i64::from(*flag)),
        Value::Number(number) => match number.as_i64() {
            Some(integer) => rusqlite::types::Value::Integer(integer),
            None => rusqlite::types::Value::Real(number.as_f64().unwrap_or(0.0)),
        },
        Value::String(text) => rusqlite::types::Value::Text(text.clone()),
        other => rusqlite::types::Value::Text(other.to_string()),
    }
}

fn tags_for_one(conn: &Connection, id: &str) -> Result<Vec<String>, CoreError> {
    let mut statement =
        conn.prepare_cached("SELECT tag FROM tags WHERE item_id = ?1 ORDER BY tag")?;
    let rows = statement.query_map([id], |row| row.get::<_, String>(0))?;
    Ok(rows.collect::<Result<Vec<String>, _>>()?)
}

fn tags_for(conn: &Connection, ids: &[String]) -> Result<HashMap<String, Vec<String>>, CoreError> {
    let mut tags: HashMap<String, Vec<String>> = HashMap::new();
    for chunk in ids.chunks(500) {
        let placeholders = vec!["?"; chunk.len()].join(", ");
        let sql = format!(
            "SELECT item_id, tag FROM tags WHERE item_id IN ({placeholders}) ORDER BY item_id, tag"
        );
        let mut statement = conn.prepare(&sql)?;
        let rows = statement.query_map(params_from_iter(chunk.iter()), |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (item_id, tag) = row?;
            tags.entry(item_id).or_default().push(tag);
        }
    }
    Ok(tags)
}

fn row_to_item(row: &rusqlite::Row<'_>) -> rusqlite::Result<Item> {
    let state: String = row.get(2)?;
    let tier: Option<String> = row.get(3)?;
    let properties: String = row.get(12)?;
    Ok(Item {
        id: row.get(0)?,
        r#type: row.get(1)?,
        state: state.parse().map_err(|_| invalid_row(2, &state))?,
        tier: match tier.as_deref() {
            None => None,
            Some(text) => Some(text.parse().map_err(|_| invalid_row(3, text))?),
        },
        version: row.get(4)?,
        schema_version: row.get(5)?,
        source: row.get(6)?,
        source_id: row.get(7)?,
        device: row.get(8)?,
        timestamp: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
        properties: parse_object(&properties).map_err(|_| invalid_row(12, &properties))?,
        tags: Vec::new(),
    })
}

fn row_to_edge(row: &rusqlite::Row<'_>) -> rusqlite::Result<Edge> {
    let properties: String = row.get(4)?;
    Ok(Edge {
        id: row.get(0)?,
        source_id: row.get(1)?,
        target_id: row.get(2)?,
        edge_type: row.get(3)?,
        properties: parse_object(&properties).map_err(|_| invalid_row(4, &properties))?,
        version: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

fn parse_object(text: &str) -> Result<Map<String, Value>, serde_json::Error> {
    match serde_json::from_str::<Value>(text)? {
        Value::Object(map) => Ok(map),
        _ => Ok(Map::new()),
    }
}

fn invalid_row(column: usize, text: &str) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        column,
        rusqlite::types::Type::Text,
        Box::new(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("unreadable value {text:?}"),
        )),
    )
}

/// The title column and everything else string-valued, for the FTS row.
pub fn fts_text(properties: &Map<String, Value>, title_field: Option<&str>) -> (String, String) {
    let title_key = title_field.unwrap_or("title");
    let title = properties
        .get(title_key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let mut body = Vec::new();
    for (key, value) in properties {
        if key == title_key {
            continue;
        }
        collect_strings(value, &mut body);
    }
    (title, body.join("\n"))
}

fn collect_strings(value: &Value, into: &mut Vec<String>) {
    match value {
        Value::String(text) => into.push(text.clone()),
        Value::Array(values) => values.iter().for_each(|value| collect_strings(value, into)),
        Value::Object(map) => map.values().for_each(|value| collect_strings(value, into)),
        _ => {}
    }
}

impl ItemState {
    fn from_str_checked(text: &str) -> Result<ItemState, CoreError> {
        text.parse()
    }
}

impl Tier {
    pub(crate) fn parse_wire(text: Option<&str>) -> Result<Option<Tier>, CoreError> {
        match text {
            None => Ok(None),
            Some(text) => text.parse().map(Some),
        }
    }
}

#[cfg(test)]
pub(crate) mod testing {
    use rusqlite::Connection;
    use serde_json::{Map, Value, json};

    use super::*;
    use crate::wire::WireDisplayHints;

    pub fn conn() -> Connection {
        open_in_memory().unwrap()
    }

    pub fn wire_type(id: &str, parent: Option<&str>, title_field: Option<&str>) -> WireType {
        WireType {
            id: id.into(),
            parent: parent.map(str::to_string),
            label: None,
            display_hints: Some(WireDisplayHints {
                title_field: title_field.map(str::to_string),
            }),
            rest: Map::new(),
        }
    }

    pub fn wire_item(
        id: &str,
        type_: &str,
        state: &str,
        timestamp: &str,
        props: Value,
    ) -> WireItem {
        let properties = match props {
            Value::Object(map) => map,
            _ => Map::new(),
        };
        WireItem {
            id: id.into(),
            r#type: type_.into(),
            properties,
            state: state.into(),
            tier: Some("library".into()),
            version: 1,
            schema_version: 1,
            source: "test".into(),
            source_id: None,
            device: None,
            timestamp: timestamp.into(),
            created_at: timestamp.into(),
            updated_at: timestamp.into(),
            edges: None,
        }
    }

    pub fn wire_edge(id: &str, source: &str, target: &str, edge_type: &str) -> WireEdge {
        WireEdge {
            id: id.into(),
            source_id: source.into(),
            target_id: target.into(),
            edge_type: edge_type.into(),
            properties: Map::new(),
            version: 1,
            created_at: "2026-01-01T00:00:00Z".into(),
            updated_at: "2026-01-01T00:00:00Z".into(),
        }
    }

    pub fn note(id: &str, title: &str, body: &str, timestamp: &str) -> WireItem {
        wire_item(
            id,
            "core.note",
            "active",
            timestamp,
            json!({ "title": title, "body": body }),
        )
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::testing::*;
    use super::*;

    #[test]
    fn an_item_round_trips_with_its_tags_and_keeps_them_when_none_are_sent() {
        let conn = conn();
        let note = note("n1", "Hello", "world", "2026-01-01T00:00:00Z");
        upsert_item(&conn, &note, Some(&["a".into(), "b".into()]), Some("title")).unwrap();
        let item = item_by_id(&conn, "n1").unwrap().unwrap();
        assert_eq!(item.tags, vec!["a", "b"]);
        assert_eq!(item.title(Some("title")), Some("Hello"));
        assert_eq!(item.state, ItemState::Active);
        assert_eq!(item.tier, Some(Tier::Library));

        let mut renamed = note.clone();
        renamed.properties = json!({ "title": "Renamed", "body": "world" })
            .as_object()
            .unwrap()
            .clone();
        upsert_item(&conn, &renamed, None, Some("title")).unwrap();
        let item = item_by_id(&conn, "n1").unwrap().unwrap();
        assert_eq!(item.title(None), Some("Renamed"));
        assert_eq!(item.tags, vec!["a", "b"]);
        assert_eq!(count(&conn, "items_fts").unwrap(), 1);
    }

    #[test]
    fn deleting_an_item_takes_its_tags_index_row_and_edges() {
        let conn = conn();
        upsert_item(
            &conn,
            &note("n1", "a", "b", "2026-01-01T00:00:00Z"),
            Some(&["t".into()]),
            None,
        )
        .unwrap();
        upsert_item(
            &conn,
            &note("n2", "c", "d", "2026-01-01T00:00:00Z"),
            None,
            None,
        )
        .unwrap();
        upsert_edge(&conn, &wire_edge("e1", "n1", "n2", "references")).unwrap();
        upsert_edge(&conn, &wire_edge("e2", "n2", "n1", "references")).unwrap();
        assert!(delete_item(&conn, "n1").unwrap());
        assert!(!delete_item(&conn, "n1").unwrap());
        assert_eq!(count(&conn, "tags").unwrap(), 0);
        assert_eq!(count(&conn, "items_fts").unwrap(), 1);
        assert_eq!(count(&conn, "edges").unwrap(), 0);
        assert!(!item_held(&conn, "n1").unwrap());
        assert!(item_held(&conn, "n2").unwrap());
    }

    #[test]
    fn an_unknown_state_is_refused_before_it_is_written() {
        let conn = conn();
        let item = wire_item("x", "core.note", "limbo", "2026-01-01T00:00:00Z", json!({}));
        assert!(matches!(
            upsert_item(&conn, &item, None, None),
            Err(CoreError::Decoding(_))
        ));
        assert_eq!(count(&conn, "items").unwrap(), 0);
    }

    #[test]
    fn the_index_text_splits_the_title_from_every_other_string() {
        let properties = json!({
            "title": "T",
            "body": "B",
            "nested": { "deep": ["x", 1, true, "y"] },
            "n": 5
        });
        let (title, body) = fts_text(properties.as_object().unwrap(), Some("title"));
        assert_eq!(title, "T");
        assert_eq!(body, "B\nx\ny");
        let (title, body) = fts_text(properties.as_object().unwrap(), Some("body"));
        assert_eq!(title, "B");
        assert_eq!(body, "x\ny\nT");
    }

    #[test]
    fn meta_and_the_hydration_guard() {
        let conn = conn();
        assert_eq!(
            meta_get(&conn, META_SCHEMA_VERSION).unwrap().as_deref(),
            Some(SCHEMA_VERSION)
        );
        assert!(refuse_unless_hydrated(&conn).is_ok());
        meta_set(&conn, META_HYDRATE_STATE, HYDRATE_IN_PROGRESS).unwrap();
        assert_eq!(
            refuse_unless_hydrated(&conn),
            Err(CoreError::HydrationIncomplete)
        );
        meta_delete(&conn, META_HYDRATE_STATE).unwrap();
        assert!(refuse_unless_hydrated(&conn).is_ok());
    }

    #[test]
    fn the_file_schema_reopens() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("core.sqlite");
        {
            let conn = open(&path).unwrap();
            upsert_item(
                &conn,
                &note("n1", "a", "b", "2026-01-01T00:00:00Z"),
                None,
                None,
            )
            .unwrap();
        }
        let conn = open(&path).unwrap();
        assert!(item_held(&conn, "n1").unwrap());
    }
}
