use std::collections::HashMap;
use std::path::Path;

use rusqlite::{Connection, OptionalExtension, params, params_from_iter};
use serde_json::{Map, Value};
use uuid::Uuid;

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
pub const SCHEMA_VERSION: &str = "5";

/// The schema the version above names, hashed as the folder mapping hashes
/// bytes. A change to `schema.sql` without a new version would open a store
/// from the earlier build and fail on its first read of a column that build
/// never wrote; the test that holds this hash is what makes the version move
/// with the schema.
#[cfg(test)]
const SCHEMA_HASH: &str = "47eee38026c40172";

const ITEM_COLUMNS: &str = "id, type, state, tier, version, schema_version, source, source_id, device, occurred_at, created_at, updated_at, properties";
const EDGE_COLUMNS: &str =
    "id, source_id, target_id, edge_type, properties, version, created_at, updated_at";

pub fn open(path: &Path) -> Result<Connection, CoreError> {
    let conn = Connection::open(path)?;
    // The path travels with the refusal. A person told to delete a store and
    // not told where it is cannot act on the advice, and the store may have
    // been named by an environment variable rather than typed.
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
    // Only when absent. Writing it on every open would make `marfa device
    // queue` and `marfa device status` take a write lock to answer a
    // question about what is already there, which a reading handle must not
    // do (`device.md` 3).
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
/// **One predicate, read by the guard and by the status report alike**, and
/// one rather than two because a second implementation would have to agree
/// with this on parts that are easy to read differently: whether an empty
/// type list counts as hydrated, and whether the tier counts at all when
/// catch-up requires it. A pair that disagreed would let a store report
/// that it had never hydrated and answer a listing in the same breath.
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

/// What a caller is asking the server to do, before it has been asked.
///
/// The kind is one of the closed set (`queue-and-verdicts.md` 32) and is
/// checked before a row is written, because the set is the contract's and a
/// store carrying a kind outside it is one no drain can send.
pub struct NewWrite<'a> {
    pub kind: &'a str,
    pub item_id: Option<&'a str>,
    pub target_id: Option<&'a str>,
    pub edge_id: Option<&'a str>,
    pub namespace: Option<&'a str>,
    pub tag: Option<&'a str>,
    pub base_version: Option<i64>,
    pub payload: &'a str,
    pub depends_on: &'a [String],
}

/// The kinds a queue holds (`queue-and-verdicts.md` 32).
///
/// A purge is not among them (`device.md` 25), and neither is a bulk door or
/// a bulk action: those are the server's way of doing many things in one
/// request rather than a thing a device holds a write for.
pub const WRITE_KINDS: &[&str] = &[
    "create_item",
    "update_item",
    "delete_item",
    "restore_item",
    "transition_item",
    "create_edge",
    "update_edge",
    "delete_edge",
    "replace_metadata",
    "merge_metadata",
    "add_tag",
    "remove_tag",
    "write_extension",
    "delete_extension",
    "upload_blob",
];

/// Queues a write and returns the row as the queue will report it.
///
/// The idempotency key is minted at enqueue, not at send, because
/// `queue-and-verdicts.md` 3 turns on it: a key minted at send time would be
/// a fresh key on every retry, and a write whose answer the device never saw
/// would be written a second time. `release` is the one other minter, and it
/// mints deliberately — a released row is a new attempt under a fresh key
/// (`queue-and-verdicts.md` 27), with the spent one kept beside it.
pub fn enqueue(conn: &Connection, write: &NewWrite<'_>) -> Result<QueuedWrite, CoreError> {
    if !WRITE_KINDS.contains(&write.kind) {
        return Err(CoreError::Invalid(format!(
            "{:?} is not a kind a queue holds",
            write.kind
        )));
    }
    let id = Uuid::now_v7().to_string();
    let key = Uuid::now_v7().to_string();
    let depends_on = if write.depends_on.is_empty() {
        None
    } else {
        Some(serde_json::to_string(write.depends_on)?)
    };
    conn.execute(
        "INSERT INTO queue (
             id, kind, item_id, target_id, edge_id, namespace, tag,
             base_version, idempotency_key, payload, depends_on, queued_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
            id,
            write.kind,
            write.item_id,
            write.target_id,
            write.edge_id,
            write.namespace,
            write.tag,
            write.base_version,
            key,
            write.payload,
            depends_on,
            now_iso(),
        ],
    )?;
    queued_write(conn, &id)?.ok_or_else(|| CoreError::Store("the queued write vanished".into()))
}

/// One queued write by id.
pub fn queued_write(conn: &Connection, id: &str) -> Result<Option<QueuedWrite>, CoreError> {
    Ok(queued_writes(conn)?.into_iter().find(|row| row.id == id))
}

/// Queue rows naming this item that the server has not answered.
///
/// What makes a local read show a write nobody has answered yet
/// (`queue-and-verdicts.md` 31), and what a second write to the same row
/// reads to find the version it should be based on.
pub fn unanswered_for_item(
    conn: &Connection,
    item_id: &str,
) -> Result<Vec<QueuedWrite>, CoreError> {
    Ok(queued_writes(conn)?
        .into_iter()
        .filter(|row| row.verdict.is_none() && row.item_id.as_deref() == Some(item_id))
        .collect())
}

/// The unanswered creates naming this item.
///
/// What a later write to the same item waits for (`queue-and-verdicts.md`
/// 4): the row does not exist on the server until its create is answered.
/// Only creates, because statement 16 is about a row the server never
/// accepted — a sibling write that failed for its own reasons has nothing
/// to do with whether this one can be sent.
pub fn unanswered_creates_for_item(
    conn: &Connection,
    item_id: &str,
) -> Result<Vec<String>, CoreError> {
    Ok(unanswered_for_item(conn, item_id)?
        .into_iter()
        .filter(|row| row.kind == "create_item")
        .map(|row| row.id)
        .collect())
}

/// The moment a row was queued, in the one shape the wire uses.
pub fn now_iso() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs() as i64;
    let millis = now.subsec_millis();
    let days = secs.div_euclid(86_400);
    let time = secs.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        time / 3600,
        (time % 3600) / 60,
        time % 60
    )
}

/// Days since the epoch to a calendar date, by Howard Hinnant's algorithm.
/// Written out rather than pulled in: one date conversion is not worth a
/// dependency, and the wire shape this feeds is fixed.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

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

    /// The version names this schema and no other: a change to the file
    /// moves both, or this says so.
    #[test]
    fn the_schema_version_names_the_schema_as_it_is() {
        assert_eq!(
            crate::folder::state::hash(SCHEMA.as_bytes()),
            SCHEMA_HASH,
            "schema.sql changed: move SCHEMA_VERSION on and set SCHEMA_HASH to the new value"
        );
    }

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
        // The order the copy holds them in, not the map type's. Nothing
        // reads it back — this is one blob to match against — and it is
        // pinned only so a change to it is seen.
        assert_eq!(body, "T\nx\ny");
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

        // Each part of the slice on its own: an empty type list and a
        // missing tier must each refuse, because catch-up requires both
        // and a guard reading one predicate would pass one of them.
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
        // read back. `payload`, `spent_keys` and `sent` are read through their
        // own queries rather than this list, because each is wanted on its own
        // at a different moment: the payload when a row is sent, the other two
        // when one is released.
        table.retain(|name| !matches!(name.as_str(), "seq" | "payload" | "spent_keys" | "sent"));
        table.sort();
        named.sort();
        assert_eq!(
            named, table,
            "the column list the queue reader indexes into no longer matches \
             the table it reads from, so a write comes back with one field's \
             value in another field and nothing anywhere reports it"
        );
    }

    /// What `forget_answered` may and may not clear.
    ///
    /// The predicate had no test at all, and was twice rewritten from a
    /// reading of which verdicts look final rather than from which rows a
    /// caller can still act on. Both mistakes end the same way: a write the
    /// person made, gone with no verdict, no report and no row.
    #[test]
    fn forgetting_spares_every_row_a_caller_can_still_release() {
        let conn = conn();
        let row = |id: &str, verdict: &str, sent: i64, depends: &str| {
            conn.execute(
                "INSERT INTO queue (id, kind, idempotency_key, payload, verdict, sent, depends_on, queued_at)
                 VALUES (?1, 'update_item', ?1, '{}', ?2, ?3, ?4, '2026-01-01T00:00:00Z')",
                params![id, verdict, sent, depends],
            )
            .unwrap();
        };
        // Cleared: answered, sent, and nothing waits on it.
        row("plain", "accepted", 1, "[]");
        // Kept: refused without going out, which `release` takes.
        row("unsent", "refused", 0, "[]");
        // Kept: refused after going out, but a releasable row names it.
        row("dependency", "refused", 1, "[]");
        row("dependant", "blocked", 1, "[\"dependency\"]");
        // And the same again where the waiter is the *third* releasable kind
        // — refused without going out. Without this pair the protection
        // clause added for that kind is unwitnessed: the `blocked` waiter
        // above is matched by the clause that was already there, so the new
        // one could be deleted and this test would still pass.
        row("kept-for-unsent", "accepted", 1, "[]");
        row("unsent-waiter", "refused", 0, "[\"kept-for-unsent\"]");

        let cleared = forget_answered(&conn).unwrap();
        let left: Vec<String> = conn
            .prepare("SELECT id FROM queue ORDER BY id")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert_eq!(
            left,
            vec![
                "dependant".to_string(),
                "dependency".to_string(),
                "kept-for-unsent".to_string(),
                "unsent".to_string(),
                "unsent-waiter".to_string()
            ],
            "a row a caller can still release, or one a releasable row waits on, \
             was cleared: releasing then produces a write whose dependency cannot \
             be found, which reads as unanswered and is held forever"
        );
        // The control: something was cleared, so the assertion above is not
        // satisfied by a function that deletes nothing at all.
        assert_eq!(
            cleared, 1,
            "nothing was cleared, so the queue grows without bound and every \
             later write reads a longer one"
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

    /// The closed set of kinds refuses one outside it.
    ///
    /// Its effect, not its contents. A test comparing `WRITE_KINDS` to a
    /// literal goes red when the list is edited and stays green when the
    /// list stops being consulted, which is the failure mode it exists to
    /// prevent: the guard passes review because the constant is checked.
    #[test]
    fn a_kind_outside_the_closed_set_is_refused() {
        let conn = conn();
        let write = |kind: &str| {
            enqueue(
                &conn,
                &NewWrite {
                    kind,
                    item_id: Some("an-item"),
                    target_id: None,
                    edge_id: None,
                    namespace: None,
                    tag: None,
                    base_version: None,
                    payload: "{}",
                    depends_on: &[],
                },
            )
        };

        // The control first: a kind the contract names goes in, so the
        // refusals below are the guard rather than a queue that takes
        // nothing at all.
        assert!(write("create_item").is_ok());

        // A purge is the one worth naming, because it is not an oversight:
        // `device.md` 25 says a device never purges, so the kind must not be
        // holdable rather than merely unimplemented.
        assert!(matches!(write("purge_item"), Err(CoreError::Invalid(_))));
        assert!(matches!(write("bulk_action"), Err(CoreError::Invalid(_))));
        assert!(matches!(write(""), Err(CoreError::Invalid(_))));

        // And every kind the contract does name is accepted, so the guard
        // cannot be satisfied by a list that has quietly lost entries.
        for kind in WRITE_KINDS {
            let queued = enqueue(
                &conn,
                &NewWrite {
                    kind,
                    item_id: Some("an-item"),
                    target_id: None,
                    edge_id: None,
                    namespace: None,
                    tag: None,
                    base_version: None,
                    payload: "{}",
                    depends_on: &[],
                },
            );
            assert!(queued.is_ok(), "{kind} is in the set and was refused");
        }
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
             it offers names a store the person reading it may only know by \
             the variable that named it"
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

/// The six (`queue-and-verdicts.md` 7).
///
/// Here for the reason `WRITE_KINDS` and `BLOCKED_REASONS` are: the set is
/// closed, and a set closed only by a `CHECK` in the schema is one a typo
/// reaches at run time, when SQLite refuses the row and the write the server
/// already took has no verdict.
pub const VERDICTS: &[&str] = &[
    "accepted",
    "merged",
    "conflicted",
    "refused",
    "blocked",
    "dead",
];

/// The ceiling (`queue-and-verdicts.md` 25).
///
/// Written in three places, and deliberately: this constant is what the drain
/// counts against, `schema.sql`'s `CHECK` is what outlives the process, and
/// the CLI prints it as the denominator. The safety the duplication buys is
/// one-sided — a ceiling raised above the schema's is refused by SQLite, and
/// one lowered below it saturates quietly and the `CHECK` never fires. The
/// lowered case is caught by `device/classification.test.ts › reaches the
/// ceiling on the fifth refusal`, which counts the attempts rather than
/// trusting either number.
pub const CEILING: i64 = 5;

/// The five reasons a row can be blocked (`queue-and-verdicts.md` 26).
pub const BLOCKED_REASONS: &[&str] = &[
    "credential_refused",
    "key_spent",
    "ancestor_unavailable",
    "conflict_unresolved",
    "awaiting_dependency",
];

/// The two blocked reasons that clear without a caller
/// (`queue-and-verdicts.md` 24 and 27).
///
/// A drain returns these rows to unanswered before it starts, so the block is
/// the last drain's finding rather than a state that sticks: a dependency
/// answered since then releases its dependent, and a replaced credential is
/// proved by one request rather than by a caller remembering to release
/// every row a single 401 parked.
pub const SELF_CLEARING_REASONS: &[&str] = &["awaiting_dependency", "credential_refused"];

/// The body a queued write will send. Not on `QueuedWrite`, which is the
/// shape a caller is shown: the payload is the wire's, and a queue report
/// that carried it would put the fields of every outstanding write into
/// every listing of them.
pub fn payload_of(conn: &Connection, id: &str) -> Result<String, CoreError> {
    conn.query_row("SELECT payload FROM queue WHERE id = ?1", [id], |row| {
        row.get(0)
    })
    .optional()?
    .ok_or_else(|| CoreError::Store(format!("queued write {id} has no payload")))
}

/// What the server said, as the queue records it.
pub struct Answered<'a> {
    pub verdict: &'a str,
    pub reason: Option<&'a str>,
    pub answer: Option<&'a str>,
    pub conflicted_copy_id: Option<&'a str>,
}

/// Writes a verdict onto a queued row.
///
/// The verdict set is the schema's `CHECK`; the blocked reasons are checked
/// here, because `reason` also carries the server's own refusal codes under
/// `refused` and the schema cannot hold a copy of the server's error
/// vocabulary without going stale.
/// Records that a write has gone out on the wire.
pub fn mark_sent(conn: &Connection, id: &str) -> Result<(), CoreError> {
    conn.execute("UPDATE queue SET sent = 1 WHERE id = ?1", [id])?;
    Ok(())
}

pub fn record_verdict(
    conn: &Connection,
    id: &str,
    answered: &Answered<'_>,
) -> Result<(), CoreError> {
    if !VERDICTS.contains(&answered.verdict) {
        return Err(CoreError::Invalid(format!(
            "{:?} is not one of the six verdicts a write is answered with",
            answered.verdict
        )));
    }
    if answered.verdict == "blocked" {
        let reason = answered.reason.unwrap_or_default();
        if !BLOCKED_REASONS.contains(&reason) {
            return Err(CoreError::Invalid(format!(
                "{reason:?} is not one of the five reasons a write is blocked"
            )));
        }
    }
    let changed = conn.execute(
        "UPDATE queue
            SET verdict = ?2, reason = ?3, answer = ?4,
                conflicted_copy_id = ?5, answered_at = ?6
          WHERE id = ?1",
        params![
            id,
            answered.verdict,
            answered.reason,
            answered.answer,
            answered.conflicted_copy_id,
            now_iso(),
        ],
    )?;
    if changed == 0 {
        return Err(CoreError::Store(format!(
            "no queued write {id} to answer; the row went while the drain was sending it"
        )));
    }
    Ok(())
}

/// Counts one refusal against a row and answers with the new count.
///
/// Refusals, not attempts (`queue-and-verdicts.md` 25). The caller decides
/// what the count means; this only records that the server refused.
pub fn count_refusal(conn: &Connection, id: &str) -> Result<i64, CoreError> {
    conn.execute(
        "UPDATE queue SET refusals = MIN(refusals + 1, ?2) WHERE id = ?1",
        params![id, CEILING],
    )?;
    conn.query_row("SELECT refusals FROM queue WHERE id = ?1", [id], |row| {
        row.get(0)
    })
    .optional()?
    .ok_or_else(|| CoreError::Store(format!("no queued write {id} to count a refusal against")))
}

/// Parks every write the server has not answered, under one reason.
///
/// What a `401` does (`queue-and-verdicts.md` 20): every queued write carries
/// the same credential, so a credential the server refused refuses all of
/// them, and working through the rest of the queue would be spending requests
/// to be told the same thing once per row.
pub fn block_unanswered(conn: &Connection, reason: &str) -> Result<usize, CoreError> {
    if !BLOCKED_REASONS.contains(&reason) {
        return Err(CoreError::Invalid(format!(
            "{reason:?} is not one of the five reasons a write is blocked"
        )));
    }
    Ok(conn.execute(
        "UPDATE queue SET verdict = 'blocked', reason = ?1, answered_at = ?2
          WHERE verdict IS NULL",
        params![reason, now_iso()],
    )?)
}

/// Returns the rows blocked for a reason that clears on its own to unanswered.
pub fn unblock_self_clearing(conn: &Connection) -> Result<usize, CoreError> {
    let places = SELF_CLEARING_REASONS
        .iter()
        .map(|_| "?")
        .collect::<Vec<_>>()
        .join(", ");
    let reasons: Vec<&dyn rusqlite::ToSql> = SELF_CLEARING_REASONS
        .iter()
        .map(|reason| reason as &dyn rusqlite::ToSql)
        .collect();
    Ok(conn.execute(
        &format!(
            "UPDATE queue SET verdict = NULL, reason = NULL, answered_at = NULL
              WHERE verdict = 'blocked' AND reason IN ({places})"
        ),
        reasons.as_slice(),
    )?)
}

/// Sends a blocked or dead row again, under a fresh key
/// (`queue-and-verdicts.md` 27).
///
/// The spent key is kept rather than dropped: the server has answered under
/// it, and a late answer arriving under a key nothing recognizes is
/// indistinguishable from an answer to the new attempt.
pub fn release(conn: &Connection, id: &str) -> Result<bool, CoreError> {
    let Some((verdict, key, spent, sent)) = conn
        .query_row(
            "SELECT verdict, idempotency_key, spent_keys, sent FROM queue WHERE id = ?1",
            [id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, i64>(3)? != 0,
                ))
            },
        )
        .optional()?
    else {
        return Err(CoreError::NotFound {
            code: "queued_write_not_found".into(),
            message: format!("{id} is not a write this queue holds"),
        });
    };
    // The two terminal-until-released verdicts, and the third case: a row
    // the drain refused because something it waits for was refused. That row
    // was never sent, so releasing it cannot write twice — which is what this
    // guard is for. An `accepted`, `merged` or `conflicted` row has been
    // written and is never released.
    //
    // **`sent` is the test, not `depends_on`.** A row the *server* refused
    // can carry a dependency too — queue a create, edit before the drain
    // runs, and the update names the create — so releasing on a dependency
    // alone cleared a terminal refusal and sent the write again. A refusal
    // that later stops applying would then land content the caller had
    // watched disappear from their copy.
    let refused_by_dependency = verdict.as_deref() == Some("refused") && !sent;
    if !matches!(verdict.as_deref(), Some("blocked") | Some("dead")) && !refused_by_dependency {
        return Ok(false);
    }
    let mut keys: Vec<String> = match spent {
        Some(json) => serde_json::from_str(&json)?,
        None => Vec::new(),
    };
    keys.push(key);
    conn.execute(
        "UPDATE queue
            SET verdict = NULL, reason = NULL, answer = NULL,
                conflicted_copy_id = NULL, answered_at = NULL,
                refusals = 0, spent_keys = ?2, idempotency_key = ?3
          WHERE id = ?1",
        params![
            id,
            serde_json::to_string(&keys)?,
            Uuid::now_v7().to_string()
        ],
    )?;
    // And the writes this one refused by being refused itself
    // (`queue-and-verdicts.md` 16). They were never sent and were never
    // wrong; they were told the row they name would not exist. Releasing
    // only the row they wait for would leave them `refused` forever: this
    // door takes such a row on its own, but nobody would know to ask for it,
    // so the caller would have released the create, watched it succeed, and
    // had no way to send the update that was waiting on it.
    for dependant in dependants_refused_with(conn, id)? {
        release(conn, &dependant)?;
    }
    Ok(true)
}

/// The rows a drain refused because this one was refused.
///
/// Read from `depends_on` rather than from the reason text: the reason is a
/// sentence for a person, and a set this door acts on has to be decided by
/// the same field the drain decided it by.
fn dependants_refused_with(conn: &Connection, id: &str) -> Result<Vec<String>, CoreError> {
    Ok(queued_writes(conn)?
        .into_iter()
        .filter(|row| {
            row.verdict.as_deref() == Some("refused")
                && row.depends_on.iter().any(|held| held == id)
        })
        .map(|row| row.id)
        .collect())
}

/// Clears the rows the server has answered.
///
/// Without it the queue grows without bound: every write door reads the
/// whole queue to find what a new write depends on, so a queue nobody clears
/// makes every write slower forever. This is the caller `schema.sql` has in
/// mind when it argues about what a foreign key would do to one clearing
/// their own answered rows.
///
/// Only the four terminal verdicts. A `blocked` or `dead` row is one a
/// caller may still release, and clearing it would take that away.
///
/// **Releasable is the test, on both sides of it.** A row is releasable when
/// it is `blocked`, `dead`, or `refused` without having been sent — the three
/// `release` takes — and a releasable row is neither cleared itself nor
/// allowed to lose the dependency it names.
///
/// Both halves were wrong in the same way and for the same reason: the set
/// was written as a list of verdicts when the question is whether a caller
/// can still act on the row. A refused-unsent row was cleared although
/// `release` accepts it, and a blocked row left its create unprotected — and
/// the release the caller was told to perform then produced a row whose
/// dependency could not be found, which `readiness` reads as unanswered and
/// holds forever against a write that no longer exists.
pub fn forget_answered(conn: &Connection) -> Result<usize, CoreError> {
    Ok(conn.execute(
        "DELETE FROM queue
          WHERE verdict IN ('accepted', 'merged', 'conflicted', 'refused')
            AND NOT (verdict = 'refused' AND sent = 0)
            AND NOT EXISTS (
              SELECT 1 FROM queue AS waiting
               WHERE (waiting.verdict IS NULL
                      OR waiting.verdict IN ('blocked', 'dead')
                      OR (waiting.verdict = 'refused' AND waiting.sent = 0))
                 AND waiting.depends_on LIKE '%' || queue.id || '%'
            )",
        [],
    )?)
}

/// Drops a row the server holds nothing for.
///
/// What reconciling a refused create means (`queue-and-verdicts.md` 12): the
/// working copy minted the row locally and the server declined it, so there
/// is nothing to reconcile it to and leaving it would be the copy reporting
/// an item that exists nowhere.
pub fn forget_item(conn: &Connection, id: &str) -> Result<(), CoreError> {
    conn.execute(
        "DELETE FROM items_fts WHERE rowid IN (SELECT seq FROM items WHERE id = ?1)",
        [id],
    )?;
    conn.execute("DELETE FROM items WHERE id = ?1", [id])?;
    conn.execute("DELETE FROM tags WHERE item_id = ?1", [id])?;
    conn.execute(
        "DELETE FROM edges WHERE source_id = ?1 OR target_id = ?1",
        [id],
    )?;
    Ok(())
}

/// Adds tags to the row the copy holds.
pub fn add_tags(conn: &Connection, item_id: &str, tags: &[String]) -> Result<(), CoreError> {
    for tag in tags {
        conn.execute(
            "INSERT OR IGNORE INTO tags (item_id, tag) VALUES (?1, ?2)",
            params![item_id, tag],
        )?;
    }
    Ok(())
}

/// Removes one tag from the row the copy holds.
pub fn remove_tag(conn: &Connection, item_id: &str, tag: &str) -> Result<(), CoreError> {
    conn.execute(
        "DELETE FROM tags WHERE item_id = ?1 AND tag = ?2",
        params![item_id, tag],
    )?;
    Ok(())
}

/// Replaces the tags on the row the copy holds.
pub fn replace_tags(conn: &Connection, item_id: &str, tags: &[String]) -> Result<(), CoreError> {
    conn.execute("DELETE FROM tags WHERE item_id = ?1", [item_id])?;
    add_tags(conn, item_id, tags)
}

/// Moves a row to another lifecycle state.
///
/// The version is deliberately untouched: the server bumps `items.version`
/// on a write to an item's fields and on nothing else, and a state change is
/// not one (`device.md` 20, and `catch_up`'s version rule rests on it).
pub fn set_item_state(conn: &Connection, id: &str, state: ItemState) -> Result<bool, CoreError> {
    let changed = conn.execute(
        "UPDATE items SET state = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, state.as_str(), now_iso()],
    )?;
    if changed > 0 && state == ItemState::Trashed {
        // The bin is out of the local index, exactly as it is when the row
        // arrives trashed from the server (`device.md` 33).
        conn.execute(
            "DELETE FROM items_fts WHERE rowid IN (SELECT seq FROM items WHERE id = ?1)",
            [id],
        )?;
    }
    Ok(changed > 0)
}

/// One edge by id, or nothing if the copy does not hold it.
pub fn edge_by_id(conn: &Connection, id: &str) -> Result<Option<Edge>, CoreError> {
    Ok(conn
        .query_row(
            "SELECT id, source_id, target_id, edge_type, properties, version, created_at, updated_at
               FROM edges WHERE id = ?1",
            [id],
            |row| {
                Ok(Edge {
                    id: row.get(0)?,
                    source_id: row.get(1)?,
                    target_id: row.get(2)?,
                    edge_type: row.get(3)?,
                    properties: serde_json::from_str(&row.get::<_, String>(4)?)
                        .unwrap_or_default(),
                    version: row.get(5)?,
                    created_at: row.get(6)?,
                    updated_at: row.get(7)?,
                })
            },
        )
        .optional()?)
}

/// Queue rows naming this edge that the server has not answered.
pub fn unanswered_for_edge(conn: &Connection, edge_id: &str) -> Result<Vec<String>, CoreError> {
    Ok(queued_writes(conn)?
        .into_iter()
        .filter(|row| row.verdict.is_none() && row.edge_id.as_deref() == Some(edge_id))
        .map(|row| row.id)
        .collect())
}
