use std::collections::HashMap;
use std::path::Path;

use rusqlite::{Connection, OptionalExtension, params, params_from_iter};
use serde_json::{Map, Value};

use crate::error::CoreError;
use crate::model::{Edge, Item, ItemState, QueuedWrite, Tier};
use crate::wire::{WireEdge, WireItem, WireType};

pub const SCHEMA: &str = include_str!("schema.sql");

pub const META_SCHEMA_VERSION: &str = "schema_version";
pub const META_SERVER_ORIGIN: &str = "server_origin";
pub const META_SLICE_TYPES: &str = "slice_types";
pub const META_SLICE_TIER: &str = "slice_tier";
pub const META_EVENT_CURSOR: &str = "event_cursor";
pub const META_HYDRATE_STATE: &str = "hydrate_state";
pub const HYDRATE_IN_PROGRESS: &str = "in_progress";
pub const SCHEMA_VERSION: &str = "1";

const ITEM_COLUMNS: &str = "id, type, state, tier, version, schema_version, source, source_id, device, occurred_at, created_at, updated_at, properties";
const EDGE_COLUMNS: &str =
    "id, source_id, target_id, edge_type, properties, version, created_at, updated_at";

pub fn open(path: &Path) -> Result<Connection, CoreError> {
    let conn = Connection::open(path)?;
    // The path travels with the refusal. A person told to delete a store and
    // not told where it is cannot act on the advice: the location is a
    // platform data directory nobody has reason to know by heart.
    prepare(&conn).map_err(|err| match err {
        CoreError::WrongSchema {
            expected, found, ..
        } => CoreError::WrongSchema {
            expected,
            found,
            path: path.display().to_string(),
        },
        other => other,
    })?;
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
    // The version is read before the rest of the schema is applied, not
    // after. `CREATE TABLE IF NOT EXISTS` is silent about a table that
    // already exists with different columns, so running the whole batch
    // first would leave a store half of this schema and half of another and
    // report nothing.
    //
    // There are no migrations. A store this schema does not match is
    // **refused**, naming its own path, and a person discards it and
    // hydrates again — the refusal is not a discard, because this file can
    // hold writes the server has never seen and deleting it on a version
    // mismatch would throw them away without anyone asking. What the absence
    // of migrations buys is `schema.sql` readable as a description of what a
    // device holds rather than as the end of a chain of alterations.
    //
    // `meta` is created on its own first because the check reads it, and a
    // file that has never been opened has no tables at all. Its two columns
    // are the one shape in here that cannot change without changing how a
    // version is read in the first place.
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
    )?;
    if let Some(found) = meta_get(conn, META_SCHEMA_VERSION)?
        && found != SCHEMA_VERSION
    {
        return Err(CoreError::WrongSchema {
            expected: SCHEMA_VERSION.to_string(),
            found,
            path: String::new(),
        });
    }
    conn.execute_batch(SCHEMA)?;
    // Only when absent. Writing it on every open would make `marfa queue`
    // and `marfa status` take a write lock to answer a question about what
    // is already there, which a reading handle must not do (`device.md` 3).
    // The refusal above has already dealt with a version that differs, so
    // the only case left here is a store that carries none.
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

/// Whether the hydration that is running, if one is, has finished.
///
/// Says nothing about whether one has ever run: a fresh store has no marker
/// either, which is why reads consult `refuse_unless_hydrated` rather than
/// this.
pub fn hydration_complete(conn: &Connection) -> Result<bool, CoreError> {
    Ok(meta_get(conn, META_HYDRATE_STATE)?.as_deref() != Some(HYDRATE_IN_PROGRESS))
}

/// Whether this store holds a slice it can answer from.
///
/// Reading the in-progress marker alone cannot answer it: a store that has
/// never hydrated carries no marker either, so it looks exactly like one
/// whose hydration finished. What a hydration leaves behind is the slice and
/// the cursor, and all three are tested here because all three are what a
/// read and a catch-up need.
///
/// The cursor is the one that moves afterwards: catch-up advances it on
/// every applied event and deletes it when the log has aged past it. A store
/// whose cursor has gone cannot be kept current, so it refuses reads until
/// it is hydrated again (`device.md` 4).
///
/// **One predicate, read by the guard and by the status report alike.** They
/// were written separately and disagreed: an empty type list satisfied one
/// and not the other, and the tier satisfied neither while catch-up required
/// it, so a store could report that it had never hydrated and answer a
/// listing in the same breath.
pub fn hydrated(conn: &Connection) -> Result<bool, CoreError> {
    if !hydration_complete(conn)? {
        return Ok(false);
    }
    if meta_get(conn, META_EVENT_CURSOR)?.is_none() {
        return Ok(false);
    }
    if meta_get(conn, META_SLICE_TIER)?.is_none() {
        return Ok(false);
    }
    let types: Vec<String> = match meta_get(conn, META_SLICE_TYPES)? {
        Some(json) => serde_json::from_str(&json)?,
        None => return Ok(false),
    };
    Ok(!types.is_empty())
}

/// Refuses a read on a store that holds no slice yet.
///
/// A device that answered a listing here would hand a caller an empty page
/// for a question it never asked the server, and nothing in the answer would
/// say so: an empty slice and a slice that was never pulled read the same
/// (`device.md` 4).
pub fn refuse_unless_hydrated(conn: &Connection) -> Result<(), CoreError> {
    if hydrated(conn)? {
        Ok(())
    } else {
        Err(CoreError::HydrationIncomplete)
    }
}

/// The version of the row held for `id`, or nothing if it is not held.
pub fn held_version(conn: &Connection, id: &str) -> Result<Option<i64>, CoreError> {
    Ok(conn
        .query_row("SELECT version FROM items WHERE id = ?1", [id], |row| {
            row.get(0)
        })
        .optional()?)
}

const QUEUE_COLUMNS: &str = "id, kind, item_id, target_id, edge_id, namespace, tag, \
     base_version, idempotency_key, depends_on, verdict, reason, answer, \
     conflicted_copy_id, refusals, queued_at, answered_at";

/// Every queued write, in the order it was queued.
///
/// Answered rows stay until a caller clears them: a drain reports the verdict
/// of every write it sent (`queue-and-verdicts.md` 6), and a verdict a caller
/// has not read yet is not a verdict that has been reported.
pub fn queued_writes(conn: &Connection) -> Result<Vec<QueuedWrite>, CoreError> {
    let mut statement = conn.prepare(&format!(
        "SELECT {QUEUE_COLUMNS} FROM queue ORDER BY seq ASC"
    ))?;
    // Positional, and the order is `QUEUE_COLUMNS`'s. Two columns of the same
    // type swapped here would read as valid data, so the two lists are kept
    // adjacent and a test walks them against the table itself.
    //
    // `depends_on` comes back as raw text and is parsed outside the closure,
    // because a row whose dependencies cannot be read is a refusal rather
    // than a row with none. Reading it as none would tell a drain that
    // nothing holds the write, which is precisely the write it must not send.
    let rows = statement.query_map([], |row| {
        Ok((
            QueuedWrite {
                id: row.get(0)?,
                kind: row.get(1)?,
                item_id: row.get(2)?,
                target_id: row.get(3)?,
                edge_id: row.get(4)?,
                namespace: row.get(5)?,
                tag: row.get(6)?,
                base_version: row.get(7)?,
                idempotency_key: row.get(8)?,
                depends_on: Vec::new(),
                verdict: row.get(10)?,
                reason: row.get(11)?,
                answer: row.get(12)?,
                conflicted_copy_id: row.get(13)?,
                refusals: row.get(14)?,
                queued_at: row.get(15)?,
                answered_at: row.get(16)?,
            },
            row.get::<_, Option<String>>(9)?,
        ))
    })?;

    let mut writes = Vec::new();
    for row in rows {
        let (mut write, depends_on) = row?;
        if let Some(json) = depends_on {
            write.depends_on = serde_json::from_str(&json).map_err(|error| {
                CoreError::Store(format!(
                    "queued write {} holds dependencies this build cannot read ({error}); \
                     the store was written by another build and has no upgrade path",
                    write.id
                ))
            })?;
        }
        writes.push(write);
    }
    Ok(writes)
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
        "INSERT INTO items (id, type, state, tier, version, schema_version, source, source_id, device, occurred_at, created_at, updated_at, properties)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
         ON CONFLICT (id) DO UPDATE SET
           type = excluded.type, state = excluded.state, tier = excluded.tier,
           version = excluded.version, schema_version = excluded.schema_version,
           source = excluded.source, source_id = excluded.source_id, device = excluded.device,
           occurred_at = excluded.occurred_at, created_at = excluded.created_at,
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
            item.occurred_at,
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
    // A row in the bin is not indexed, which is the server's own rule on
    // the same index: it drops a trashed row from the index on the write
    // that trashes it, and rebuilds without one. A device that indexed it
    // would answer a search the server it copies answers nothing for, and
    // would do it under every state value rather than one.
    if ItemState::from_str_checked(&item.state)? != ItemState::Trashed {
        conn.execute(
            "INSERT INTO items_fts (rowid, title, body, tags) VALUES (?1, ?2, ?3, ?4)",
            params![seq, title, body, tags.join(" ")],
        )?;
    }
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

/// One item by id, or nothing for a row in the bin.
///
/// A read by id answers every state but the bin, which is the server's own
/// rule on the same door: an archived row stays readable by id and a trashed
/// one reads as absent. A device that answered the trashed row would give a
/// caller a row the server it copies would refuse them.
pub fn item_by_id(conn: &Connection, id: &str) -> Result<Option<Item>, CoreError> {
    let mut items = items_by_ids(conn, std::slice::from_ref(&id.to_string()))?;
    Ok(items.pop().filter(|item| item.state != ItemState::Trashed))
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
        occurred_at: row.get(9)?,
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
        occurred_at: &str,
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
            occurred_at: occurred_at.into(),
            created_at: occurred_at.into(),
            updated_at: occurred_at.into(),
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

    pub fn note(id: &str, title: &str, body: &str, occurred_at: &str) -> WireItem {
        wire_item(
            id,
            "core.note",
            "active",
            occurred_at,
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
        // A store that has never hydrated refuses a read. The two ways to
        // be unhydrated are both here, because they look identical from the
        // marker alone: a fresh store carries none, and so does one whose
        // hydration finished.
        assert_eq!(
            refuse_unless_hydrated(&conn),
            Err(CoreError::HydrationIncomplete)
        );
        meta_set(&conn, META_EVENT_CURSOR, "10").unwrap();
        meta_set(&conn, META_SLICE_TYPES, "[\"core.note\"]").unwrap();
        meta_set(&conn, META_SLICE_TIER, "library").unwrap();
        assert!(refuse_unless_hydrated(&conn).is_ok());

        // Each part of the slice on its own, because the guard and the
        // status report read one predicate and used to read two: an empty
        // type list satisfied one of them and the tier satisfied neither,
        // while catch-up required it.
        meta_set(&conn, META_SLICE_TYPES, "[]").unwrap();
        assert_eq!(
            refuse_unless_hydrated(&conn),
            Err(CoreError::HydrationIncomplete)
        );
        meta_set(&conn, META_SLICE_TYPES, "[\"core.note\"]").unwrap();
        meta_delete(&conn, META_SLICE_TIER).unwrap();
        assert_eq!(
            refuse_unless_hydrated(&conn),
            Err(CoreError::HydrationIncomplete)
        );
        meta_set(&conn, META_SLICE_TIER, "library").unwrap();
        meta_delete(&conn, META_EVENT_CURSOR).unwrap();
        assert_eq!(
            refuse_unless_hydrated(&conn),
            Err(CoreError::HydrationIncomplete)
        );
        meta_set(&conn, META_EVENT_CURSOR, "10").unwrap();
        assert!(refuse_unless_hydrated(&conn).is_ok());

        meta_set(&conn, META_HYDRATE_STATE, HYDRATE_IN_PROGRESS).unwrap();
        assert_eq!(
            refuse_unless_hydrated(&conn),
            Err(CoreError::HydrationIncomplete)
        );
        meta_delete(&conn, META_HYDRATE_STATE).unwrap();
        assert!(refuse_unless_hydrated(&conn).is_ok());
    }

    /// The list the reader indexes into, against the table it reads from.
    ///
    /// The round-trip case below gives every value a distinct string, which
    /// catches the *reader's* indices drifting out of step with
    /// `QUEUE_COLUMNS`. It cannot catch `QUEUE_COLUMNS` drifting out of step
    /// with the table: a column added to the schema and left out of the list
    /// is simply never read, and a column renamed in one place and not the
    /// other fails at runtime on a query nothing in the suite runs.
    #[test]
    fn the_column_list_names_every_column_the_queue_has() {
        let conn = conn();
        let mut table: Vec<String> = conn
            .prepare("SELECT name FROM pragma_table_info('queue')")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .map(|name| name.unwrap())
            .collect();
        let mut named: Vec<String> = QUEUE_COLUMNS
            .split(',')
            .map(|column| column.trim().to_string())
            .collect();
        // `seq` is the rowid the queue is ordered by and is deliberately not
        // read back; `payload` and `spent_keys` are read by the drain through
        // their own queries rather than this list.
        table.retain(|name| !matches!(name.as_str(), "seq" | "payload" | "spent_keys"));
        table.sort();
        named.sort();
        assert_eq!(
            named, table,
            "the column list the queue reader indexes into no longer matches \
             the table it reads from, so a write comes back with one field's \
             value in another field and nothing anywhere reports it"
        );
    }

    #[test]
    fn a_queued_write_round_trips_through_every_column() {
        let conn = conn();
        // Every column carries a value distinct from every other, because
        // the reader is positional: two columns of the same type swapped
        // would come back as valid data and nothing else in the repository
        // inserts a queue row.
        conn.execute(
            "INSERT INTO queue (
                 id, kind, item_id, target_id, edge_id, namespace, tag,
                 base_version, idempotency_key, payload, depends_on, verdict, reason,
                 answer, conflicted_copy_id, refusals, queued_at, answered_at
             ) VALUES (
                 'q-id', 'update_item', 'the-item', 'the-target', 'the-edge',
                 'the-namespace', 'the-tag', 7, 'the-key', '{}',
                 '[\"first\",\"second\"]', 'blocked', 'key_spent',
                 '{\"error\":\"as sent\"}', 'the-sibling', 3,
                 '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z'
             )",
            [],
        )
        .unwrap();

        let writes = queued_writes(&conn).unwrap();
        assert_eq!(writes.len(), 1);
        let write = &writes[0];
        assert_eq!(write.id, "q-id");
        assert_eq!(write.kind, "update_item");
        assert_eq!(write.item_id.as_deref(), Some("the-item"));
        assert_eq!(write.target_id.as_deref(), Some("the-target"));
        assert_eq!(write.edge_id.as_deref(), Some("the-edge"));
        assert_eq!(write.namespace.as_deref(), Some("the-namespace"));
        assert_eq!(write.tag.as_deref(), Some("the-tag"));
        assert_eq!(write.base_version, Some(7));
        assert_eq!(write.idempotency_key, "the-key");
        assert_eq!(write.depends_on, vec!["first", "second"]);
        assert_eq!(write.verdict.as_deref(), Some("blocked"));
        assert_eq!(write.reason.as_deref(), Some("key_spent"));
        assert_eq!(write.answer.as_deref(), Some("{\"error\":\"as sent\"}"));
        assert_eq!(write.conflicted_copy_id.as_deref(), Some("the-sibling"));
        assert_eq!(write.refusals, 3);
        assert_eq!(write.queued_at, "2026-01-01T00:00:00Z");
        assert_eq!(write.answered_at.as_deref(), Some("2026-01-02T00:00:00Z"));
    }

    #[test]
    fn the_queue_refuses_what_the_contract_closes() {
        let conn = conn();
        let insert = |id: &str, verdict: &str, refusals: i64, key: &str| {
            conn.execute(
                "INSERT INTO queue (id, kind, idempotency_key, payload, verdict, refusals, queued_at)
                 VALUES (?1, 'create_item', ?2, '{}', ?3, ?4, '2026-01-01T00:00:00Z')",
                rusqlite::params![id, key, verdict, refusals],
            )
        };

        // The control: a row inside every constraint goes in, so the
        // refusals below are the constraints rather than a broken insert.
        insert("ok", "accepted", 0, "key-ok").unwrap();

        // A verdict outside the six. The set is the contract's, and a store
        // carrying a seventh is one no later build can read correctly.
        assert!(insert("bad-verdict", "maybe", 0, "key-a").is_err());

        // Past the ceiling. Five is a number the contract fixes rather than
        // configuration, and this file outlives the process that writes it.
        assert!(insert("over-ceiling", "dead", 6, "key-b").is_err());

        // A second row under a key that has already been used. The server
        // answers the second from the first's record, so a duplicate means a
        // write silently discarded and a device told it succeeded.
        assert!(insert("duplicate-key", "accepted", 0, "key-ok").is_err());
    }

    #[test]
    fn a_store_written_by_another_schema_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("core.sqlite");
        {
            let conn = open(&path).unwrap();
            meta_set(&conn, META_SCHEMA_VERSION, "something-else").unwrap();
        }
        // Refused rather than migrated, and the message says what to do:
        // there is no upgrade path, so a caller either deletes the file or
        // keeps a store this build cannot read correctly.
        let refused = open(&path);
        assert!(matches!(
            refused,
            Err(CoreError::WrongSchema { ref found, .. }) if found == "something-else"
        ));
        // The refusal names the file, because a person told to delete a store
        // and not told where it is cannot act on the advice.
        assert!(
            format!("{}", refused.unwrap_err()).contains(&path.display().to_string()),
            "the refusal does not say which file to delete, so the one remedy \
             it offers names a path in a platform data directory the person \
             reading it has no way to find"
        );

        // The control: a store this build wrote opens again. Without it the
        // refusal above would pass against an `open` that refused every file.
        //
        // **This is the control and not a demonstration of recovery.** The
        // discard is the person's — nothing here deletes a store on a version
        // mismatch, because the file can hold writes the server has never
        // seen. The `remove_file` is this test doing by hand what the error
        // tells a person to do.
        std::fs::remove_file(&path).unwrap();
        assert!(open(&path).is_ok());
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
