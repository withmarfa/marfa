use std::collections::HashMap;
use std::path::Path;

use rusqlite::{Connection, OptionalExtension, named_params, params, params_from_iter};
use serde_json::{Map, Value};
use uuid::Uuid;

use crate::catalog::Indexing;
use crate::error::CoreError;
use crate::model::{BlockedReason, Edge, Item, ItemState, QueuedWrite, Tier, Verdict, WriteKind};
use crate::wire::{WireEdge, WireItem, WireType};

pub const SCHEMA: &str = include_str!("schema.sql");

pub const META_SCHEMA_VERSION: &str = "schema_version";
pub const META_SERVER_ORIGIN: &str = "server_origin";
pub const META_SLICE_TYPES: &str = "slice_types";
pub const META_SLICE_TIER: &str = "slice_tier";
pub const META_EVENT_CURSOR: &str = "event_cursor";
pub const META_HYDRATE_STATE: &str = "hydrate_state";
pub const HYDRATE_IN_PROGRESS: &str = "in_progress";
pub const SCHEMA_VERSION: &str = "8";

/// The schema the version above names, hashed as the folder mapping hashes
/// bytes. A change to `schema.sql` without a new version would open a store
/// from the earlier build and fail on its first read of a column that build
/// never wrote; the test that holds this hash is what makes the version move
/// with the schema.
///
/// Over the statements SQLite executes, not the file: a comment cannot make
/// one build read a column another build never wrote, and a hash that moved
/// on one would price every edit to the prose at a version bump that refuses
/// every working copy on disk.
#[cfg(test)]
const SCHEMA_HASH: &str = "662310c80f2c6871";

const ITEM_COLUMNS: &str = "id, type, state, tier, version, schema_version, source, source_id, occurred_at, created_at, updated_at, properties";
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

/// Opens a store another process made, to read it: no store is made where
/// none is, no schema is applied, and the store's file is never written, so
/// a reader started before the writer can never lock the writer out or leave
/// a store half made. Read-only rather than a promise, because a read-write
/// connection that is the last to close checkpoints the writer's journal
/// into the file. SQLite may still make the journal's two files beside the
/// store, where a writer closed and took them away, because a reader of a
/// store in WAL mode reads through them.
pub fn open_to_read(path: &Path) -> Result<Connection, CoreError> {
    let conn = Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| {
        CoreError::Invalid(format!(
            "{} is not a store to read ({error}); a reading open never makes one",
            path.display()
        ))
    })?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    let found = conn
        .query_row(
            "SELECT value FROM meta WHERE key = ?1",
            [META_SCHEMA_VERSION],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| match &error {
            rusqlite::Error::SqliteFailure(_, Some(message))
                if message.starts_with("no such table")
                    || message.contains("file is not a database") =>
            {
                CoreError::Invalid(format!(
                    "{} is not a store: it has no schema to read",
                    path.display()
                ))
            }
            _ => CoreError::from(error),
        })?;
    match found {
        Some(found) if found == SCHEMA_VERSION => Ok(conn),
        found => Err(CoreError::WrongSchema {
            expected: SCHEMA_VERSION.to_string(),
            found: found.unwrap_or_else(|| "none".into()),
            path: path.display().to_string(),
        }),
    }
}

/// A number that moves each time another connection commits to the store,
/// which is how a reader learns the writer saved.
pub fn data_version(conn: &Connection) -> Result<i64, CoreError> {
    Ok(conn.query_row("PRAGMA data_version", [], |row| row.get(0))?)
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
/// the cursor, and a read and a catch-up need both.
///
/// The cursor is the one that moves afterwards: catch-up advances it on
/// every applied event and deletes it when the log has aged past it. A store
/// whose cursor has gone cannot be kept current, so it refuses reads until
/// it is hydrated again (`device.md` 4).
///
/// **The slice half is `holds_slice` and this composes it**, rather than
/// testing the same keys a second time, because the guard and the status
/// report both ask it and a pair that read an empty type list differently
/// would let one store report that it had never hydrated and answer a
/// listing in the same breath.
pub fn hydrated(conn: &Connection) -> Result<bool, CoreError> {
    if !hydration_complete(conn)? {
        return Ok(false);
    }
    if meta_get(conn, META_EVENT_CURSOR)?.is_none() {
        return Ok(false);
    }
    holds_slice(conn)
}

/// Whether this store holds a slice at all, the cursor aside.
///
/// The part of `hydrated` a hydration writes once and nothing afterwards
/// takes away. Split out because the two halves fail for different reasons
/// and a caller is owed the difference: no slice is a store that has never
/// hydrated, and a slice whose cursor has gone is one that hydrated and
/// then aged out of the log. The guard needs both and still asks
/// `hydrated`; the report asks this as well, so it can name the second case
/// rather than calling it the first (`device.md` 5).
pub fn holds_slice(conn: &Connection) -> Result<bool, CoreError> {
    Ok(slice(conn)?.is_some_and(|(types, _)| !types.is_empty()))
}

/// The slice a hydration declared: its types and its tier, or nothing where
/// no hydration has declared one.
pub fn slice(conn: &Connection) -> Result<Option<(Vec<String>, Tier)>, CoreError> {
    let Some(tier) = meta_get(conn, META_SLICE_TIER)? else {
        return Ok(None);
    };
    let Some(types) = meta_get(conn, META_SLICE_TYPES)? else {
        return Ok(None);
    };
    Ok(Some((serde_json::from_str(&types)?, tier.parse()?)))
}

/// Refuses a read on a store that cannot answer one.
///
/// Three stores cannot: one that has never hydrated, one whose hydration was
/// interrupted, and one whose cursor has aged out. A device that answered a
/// listing from the first would hand a caller an empty page for a question
/// it never asked the server, and nothing in the answer would say so: an
/// empty slice and a slice that was never pulled read the same. The third
/// holds a whole copy and refuses anyway, because it has silently stopped
/// tracking (`device.md` 4). What the three are told apart by is the report,
/// not this (`device.md` 5).
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
     conflicted_copy_id, refusals, queued_at, answered_at, blob";

/// What a caller is asking the server to do, before it has been asked.
pub struct NewWrite<'a> {
    pub kind: WriteKind,
    pub item_id: Option<&'a str>,
    pub target_id: Option<&'a str>,
    pub edge_id: Option<&'a str>,
    pub namespace: Option<&'a str>,
    pub tag: Option<&'a str>,
    pub blob: Option<&'a str>,
    pub base_version: Option<i64>,
    pub payload: &'a str,
    pub depends_on: &'a [String],
}

/// Queues a write and returns the row as the queue will report it.
///
/// The idempotency key is minted at enqueue, not at send, because
/// `queue-and-verdicts.md` 3 turns on it: a key minted at send time would be
/// a fresh key on every retry, and a write whose answer the device never saw
/// would be written a second time. `release` is the one other minter, and it
/// mints deliberately — a released row is a new attempt under a fresh key
/// (`queue-and-verdicts.md` 27), with the spent one kept beside it.
pub fn enqueue(conn: &Connection, write: &NewWrite<'_>) -> Result<QueuedWrite, CoreError> {
    let id = Uuid::now_v7().to_string();
    let key = Uuid::now_v7().to_string();
    let depends_on = if write.depends_on.is_empty() {
        None
    } else {
        Some(serde_json::to_string(write.depends_on)?)
    };
    conn.execute(
        "INSERT INTO queue (
             id, kind, item_id, target_id, edge_id, namespace, tag, blob,
             base_version, idempotency_key, payload, depends_on, queued_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![
            id,
            write.kind.as_str(),
            write.item_id,
            write.target_id,
            write.edge_id,
            write.namespace,
            write.tag,
            write.blob,
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
    Ok(read_writes(conn, "WHERE id = ?1", [id])?.pop())
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
        .filter(|row| row.kind == WriteKind::CreateItem)
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
    read_writes(conn, "", [])
}

/// The writes still waiting (`queue-and-verdicts.md` 35): unanswered, or
/// blocked, which a release sends again.
pub fn waiting_writes(conn: &Connection) -> Result<Vec<QueuedWrite>, CoreError> {
    read_writes(
        conn,
        "WHERE verdict IS NULL OR verdict = ?1",
        [Verdict::Blocked.as_str()],
    )
}

/// The writes still waiting on one item, read through the index rather than
/// by reading the whole queue, because this runs once per answer and once
/// per event.
fn waiting_writes_for_item(conn: &Connection, id: &str) -> Result<Vec<QueuedWrite>, CoreError> {
    read_writes(
        conn,
        "WHERE item_id = ?1 AND (verdict IS NULL OR verdict = ?2)",
        [id, Verdict::Blocked.as_str()],
    )
}

fn waiting_writes_for_edge(conn: &Connection, id: &str) -> Result<Vec<QueuedWrite>, CoreError> {
    read_writes(
        conn,
        "WHERE edge_id = ?1 AND (verdict IS NULL OR verdict = ?2)",
        [id, Verdict::Blocked.as_str()],
    )
}

fn read_writes(
    conn: &Connection,
    filter: &str,
    values: impl rusqlite::Params,
) -> Result<Vec<QueuedWrite>, CoreError> {
    let mut statement = conn.prepare(&format!(
        "SELECT {QUEUE_COLUMNS} FROM queue {filter} ORDER BY seq ASC"
    ))?;
    // Positional, and the order is `QUEUE_COLUMNS`'s. Two columns of the same
    // type swapped here would read as valid data, so the two lists are kept
    // adjacent and a test walks them against the table itself.
    //
    // `depends_on` comes back as raw text and is parsed outside the closure,
    // because a row whose dependencies cannot be read is a refusal rather
    // than a row with none. Reading it as none would tell a drain that
    // nothing holds the write, which is precisely the write it must not send.
    //
    // The kind and the verdict are read as text and parsed outside it too,
    // and a value outside its closed set is refused rather than carried: a
    // store holding one is a store this build cannot read correctly, and the
    // `CHECK`s in `schema.sql` are what keep one from being written.
    let rows = statement.query_map(values, |row| {
        Ok(RawWrite {
            id: row.get(0)?,
            kind: row.get(1)?,
            item_id: row.get(2)?,
            target_id: row.get(3)?,
            edge_id: row.get(4)?,
            namespace: row.get(5)?,
            tag: row.get(6)?,
            base_version: row.get(7)?,
            idempotency_key: row.get(8)?,
            depends_on: row.get(9)?,
            verdict: row.get(10)?,
            reason: row.get(11)?,
            answer: row.get(12)?,
            conflicted_copy_id: row.get(13)?,
            refusals: row.get(14)?,
            queued_at: row.get(15)?,
            answered_at: row.get(16)?,
            blob: row.get(17)?,
        })
    })?;

    let mut writes = Vec::new();
    for row in rows {
        let raw = row?;
        let depends_on = match raw.depends_on {
            Some(json) => serde_json::from_str(&json).map_err(|error| {
                CoreError::Store(format!(
                    "queued write {} holds dependencies this build cannot read ({error}); \
                     the store was written by another build and has no upgrade path",
                    raw.id
                ))
            })?,
            None => Vec::new(),
        };
        let verdict = raw
            .verdict
            .as_deref()
            .map(str::parse::<Verdict>)
            .transpose()?;
        if verdict == Some(Verdict::Blocked) {
            raw.reason
                .as_deref()
                .unwrap_or_default()
                .parse::<BlockedReason>()
                .map_err(|_| {
                    CoreError::Store(format!(
                        "queued write {} is blocked for a reason outside the five: {:?}",
                        raw.id, raw.reason
                    ))
                })?;
        }
        writes.push(QueuedWrite {
            kind: raw.kind.parse()?,
            id: raw.id,
            item_id: raw.item_id,
            target_id: raw.target_id,
            edge_id: raw.edge_id,
            namespace: raw.namespace,
            tag: raw.tag,
            blob: raw.blob,
            base_version: raw.base_version,
            idempotency_key: raw.idempotency_key,
            depends_on,
            verdict,
            reason: raw.reason,
            answer: raw.answer,
            conflicted_copy_id: raw.conflicted_copy_id,
            refusals: raw.refusals,
            queued_at: raw.queued_at,
            answered_at: raw.answered_at,
        });
    }
    Ok(writes)
}

/// A queue row as SQLite hands it back, before its closed sets are read.
struct RawWrite {
    id: String,
    kind: String,
    item_id: Option<String>,
    target_id: Option<String>,
    edge_id: Option<String>,
    namespace: Option<String>,
    tag: Option<String>,
    blob: Option<String>,
    base_version: Option<i64>,
    idempotency_key: String,
    depends_on: Option<String>,
    verdict: Option<String>,
    reason: Option<String>,
    answer: Option<String>,
    conflicted_copy_id: Option<String>,
    refusals: i64,
    queued_at: String,
    answered_at: Option<String>,
}

type TypeRow = (
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    String,
);

/// Replaces the type catalog, and writes nothing where it is the one held:
/// a follow asks for the catalog on every stream it opens, and a reader told
/// of each save would otherwise be told of one every two minutes.
pub fn replace_types(conn: &Connection, types: &[WireType]) -> Result<(), CoreError> {
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
            (
                entry.id.clone(),
                entry.parent.clone(),
                entry.label.clone(),
                hints.title_field,
                Value::Object(json).to_string(),
            )
        })
        .collect();
    rows.sort();
    let held: Vec<TypeRow> = conn
        .prepare("SELECT id, parent, label, title_field, json FROM types ORDER BY id")?
        .query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            ))
        })?
        .collect::<Result<_, _>>()?;
    if held == rows {
        return Ok(());
    }
    conn.execute("DELETE FROM types", [])?;
    let mut insert = conn.prepare(
        "INSERT INTO types (id, parent, label, title_field, json)
         VALUES (?1, ?2, ?3, ?4, ?5)",
    )?;
    for row in rows {
        insert.execute(params![row.0, row.1, row.2, row.3, row.4])?;
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
    indexing: &Indexing,
) -> Result<(), CoreError> {
    ItemState::from_str_checked(&item.state)?;
    conn.execute(
        "INSERT INTO items (id, type, state, tier, version, schema_version, source, source_id, occurred_at, created_at, updated_at, properties)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
         ON CONFLICT (id) DO UPDATE SET
           type = excluded.type, state = excluded.state, tier = excluded.tier,
           version = excluded.version, schema_version = excluded.schema_version,
           source = excluded.source, source_id = excluded.source_id,
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
    let (title, body) = fts_text(&item.properties, indexing);
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

pub(crate) fn sql_value(value: &Value) -> rusqlite::types::Value {
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
    let properties: String = row.get(11)?;
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
        occurred_at: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
        properties: parse_object(&properties).map_err(|_| invalid_row(11, &properties))?,
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
pub fn fts_text(properties: &Map<String, Value>, indexing: &Indexing) -> (String, String) {
    let title_key = indexing.title_field.as_deref().unwrap_or("title");
    let title = properties
        .get(title_key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let mut body = Vec::new();
    for (key, value) in properties {
        if key == title_key || indexing.thumbnail_field.as_deref() == Some(key.as_str()) {
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

    /// The version names this schema and no other: a change to the
    /// statements moves both, or this says so.
    #[test]
    fn the_schema_version_names_the_schema_as_it_is() {
        assert_eq!(
            crate::folder::state::hash(schema_statements().as_bytes()),
            SCHEMA_HASH,
            "schema.sql's statements changed: move SCHEMA_VERSION on and set SCHEMA_HASH to the new value"
        );
    }

    /// `schema.sql` with the prose taken out. Every `--` in the file opens a
    /// comment that runs to the end of its own line and none follows a
    /// statement on one, so dropping those lines and the blank ones leaves
    /// every statement `execute_batch` runs and nothing else. Production
    /// still hands it the whole file, comments and all; this is the text the
    /// version is held against, not the text SQLite is given.
    fn schema_statements() -> String {
        let mut kept = String::new();
        for line in SCHEMA.lines() {
            let line = line.trim_end();
            if line.trim_start().starts_with("--") || line.trim().is_empty() {
                continue;
            }
            kept.push_str(line);
            kept.push('\n');
        }
        kept
    }

    /// The witness for the line above: the file does carry comments, and
    /// taking them out leaves statements behind rather than nothing.
    #[test]
    fn the_hashed_schema_is_the_statements_without_the_prose() {
        let statements = schema_statements();
        assert!(SCHEMA.contains("\n  --"), "schema.sql carries no comments");
        assert!(!statements.contains("--"), "a comment survived the strip");
        // The strip reads `--` alone, so a block comment would ride through
        // it and price prose at a version bump again, silently.
        assert!(!SCHEMA.contains("/*"), "schema.sql grew a block comment");
        assert!(statements.contains("CREATE TABLE IF NOT EXISTS queue ("));
        assert!(statements.len() < SCHEMA.len());
        // And the strip is about prose alone: SQLite runs what is left.
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(&statements).unwrap();
    }

    /// Every column read by position, with every value distinct.
    ///
    /// `row_to_item` indexes `ITEM_COLUMNS` by number, so a column added or
    /// removed in the middle shifts everything after it and one field
    /// silently takes another's value. The helpers give an item the same
    /// string for all three timestamps and no `source_id`, which makes a
    /// shift of one indistinguishable from a correct read, so this builds a
    /// row where no two values are equal.
    #[test]
    fn every_column_lands_in_its_own_field() {
        let conn = conn();
        let row = WireItem {
            id: "positional-1".into(),
            r#type: "core.bookmark".into(),
            properties: json!({ "title": "T", "url": "https://example.invalid" })
                .as_object()
                .unwrap()
                .clone(),
            state: "archived".into(),
            tier: Some("feed".into()),
            version: 7,
            schema_version: 3,
            source: "source-value".into(),
            source_id: Some("source-id-value".into()),
            occurred_at: "1999-12-31T23:59:58Z".into(),
            created_at: "2020-02-02T02:02:02Z".into(),
            updated_at: "2031-03-03T03:03:03Z".into(),
            edges: None,
        };
        upsert_item(&conn, &row, None, &Indexing::titled("title")).unwrap();

        let item = item_by_id(&conn, "positional-1").unwrap().unwrap();
        assert_eq!(item.id, "positional-1");
        assert_eq!(item.r#type, "core.bookmark");
        assert_eq!(item.state, ItemState::Archived);
        assert_eq!(item.tier, Some(Tier::Feed));
        assert_eq!(item.version, 7);
        assert_eq!(item.schema_version, 3);
        assert_eq!(item.source, "source-value");
        assert_eq!(item.source_id.as_deref(), Some("source-id-value"));
        assert_eq!(item.occurred_at, "1999-12-31T23:59:58Z");
        assert_eq!(item.created_at, "2020-02-02T02:02:02Z");
        assert_eq!(item.updated_at, "2031-03-03T03:03:03Z");
        assert_eq!(
            item.properties.get("title").and_then(Value::as_str),
            Some("T")
        );
    }

    #[test]
    fn an_item_round_trips_with_its_tags_and_keeps_them_when_none_are_sent() {
        let conn = conn();
        let note = note("n1", "Hello", "world", "2026-01-01T00:00:00Z");
        upsert_item(
            &conn,
            &note,
            Some(&["a".into(), "b".into()]),
            &Indexing::titled("title"),
        )
        .unwrap();
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
        upsert_item(&conn, &renamed, None, &Indexing::titled("title")).unwrap();
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
            &Indexing::default(),
        )
        .unwrap();
        upsert_item(
            &conn,
            &note("n2", "c", "d", "2026-01-01T00:00:00Z"),
            None,
            &Indexing::default(),
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
            upsert_item(&conn, &item, None, &Indexing::default()),
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
        let (title, body) = fts_text(properties.as_object().unwrap(), &Indexing::titled("title"));
        assert_eq!(title, "T");
        assert_eq!(body, "B\nx\ny");
        let (title, body) = fts_text(properties.as_object().unwrap(), &Indexing::titled("body"));
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
    /// The predicate is easy to write from a reading of which verdicts look
    /// final rather than from which rows a caller can still act on, and
    /// every such reading ends the same way: a write the person made, gone
    /// with no verdict, no report and no row.
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
        // — refused without going out. Without this pair that kind's clause
        // in the waiter set is unwitnessed: the `blocked` waiter above is
        // matched by the `blocked`/`dead` clause, so the refused-unsent one
        // could be deleted and this test would still pass.
        row("kept-for-unsent", "accepted", 1, "[]");
        row("unsent-waiter", "refused", 0, "[\"kept-for-unsent\"]");
        // The other two answers that clear, and the one that does not: a
        // dead row is released like a blocked one, and so is what it waits
        // on kept.
        row("merged", "merged", 1, "[]");
        row("conflicted", "conflicted", 1, "[]");
        row("dead", "dead", 1, "[]");
        row("kept-for-dead", "accepted", 1, "[]");
        row("dead-waiter", "dead", 1, "[\"kept-for-dead\"]");

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
                "dead".to_string(),
                "dead-waiter".to_string(),
                "dependant".to_string(),
                "dependency".to_string(),
                "kept-for-dead".to_string(),
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
            cleared, 3,
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
                 id, kind, item_id, target_id, edge_id, namespace, tag, blob,
                 base_version, idempotency_key, payload, depends_on, verdict, reason,
                 answer, conflicted_copy_id, refusals, queued_at, answered_at
             ) VALUES (
                 'q-id', 'update_item', 'the-item', 'the-target', 'the-edge',
                 'the-namespace', 'the-tag', 'the-blob', 7, 'the-key', '{}',
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
        assert_eq!(write.kind, WriteKind::UpdateItem);
        assert_eq!(write.item_id.as_deref(), Some("the-item"));
        assert_eq!(write.target_id.as_deref(), Some("the-target"));
        assert_eq!(write.edge_id.as_deref(), Some("the-edge"));
        assert_eq!(write.namespace.as_deref(), Some("the-namespace"));
        assert_eq!(write.tag.as_deref(), Some("the-tag"));
        assert_eq!(write.blob.as_deref(), Some("the-blob"));
        assert_eq!(write.base_version, Some(7));
        assert_eq!(write.idempotency_key, "the-key");
        assert_eq!(write.depends_on, vec!["first", "second"]);
        assert_eq!(write.verdict, Some(Verdict::Blocked));
        assert_eq!(write.reason.as_deref(), Some("key_spent"));
        assert_eq!(write.answer.as_deref(), Some("{\"error\":\"as sent\"}"));
        assert_eq!(write.conflicted_copy_id.as_deref(), Some("the-sibling"));
        assert_eq!(write.refusals, 3);
        assert_eq!(write.queued_at, "2026-01-01T00:00:00Z");
        assert_eq!(write.answered_at.as_deref(), Some("2026-01-02T00:00:00Z"));
    }

    /// The three closed sets, held to the schema and to the reader.
    ///
    /// The enums are the sets the code speaks, and `schema.sql`'s `CHECK`s
    /// are the sets the file keeps for a kind and a verdict; this holds the
    /// two to each other in both directions. A blocked reason shares its
    /// column with a refusal's code, which is open text, so the schema cannot
    /// close it and the reader is what refuses one outside the five.
    #[test]
    fn the_closed_sets_agree_with_the_schema_and_the_reader_refuses_the_rest() {
        let conn = conn();
        for kind in WriteKind::ALL {
            let queued = enqueue(
                &conn,
                &NewWrite {
                    kind,
                    item_id: Some("an-item"),
                    target_id: None,
                    edge_id: None,
                    namespace: None,
                    tag: None,
                    blob: None,
                    base_version: None,
                    payload: "{}",
                    depends_on: &[],
                },
            )
            .unwrap_or_else(|error| {
                panic!("{kind} is in the set and the schema refused it: {error}")
            });
            assert_eq!(queued.kind, kind);
        }
        // A purge is the one worth naming, because it is not an oversight:
        // `device.md` 25 says a device never purges, so the kind must not be
        // holdable rather than merely unimplemented.
        assert!("purge_item".parse::<WriteKind>().is_err());
        assert!(
            conn.execute(
                "INSERT INTO queue (id, kind, idempotency_key, payload, queued_at)
                 VALUES ('purge', 'purge_item', 'purge-key', '{}', '2026-01-01T00:00:00Z')",
                [],
            )
            .is_err(),
            "the schema holds a purge"
        );

        let verdict_row = |id: &str, verdict: &str, reason: Option<&str>| {
            conn.execute(
                "INSERT INTO queue (id, kind, idempotency_key, payload, verdict, reason, queued_at)
                 VALUES (?1, 'update_item', ?1, '{}', ?2, ?3, '2026-01-01T00:00:00Z')",
                params![id, verdict, reason],
            )
        };
        for verdict in Verdict::ALL {
            let reason = (verdict == Verdict::Blocked).then_some("key_spent");
            verdict_row(verdict.as_str(), verdict.as_str(), reason).unwrap_or_else(|error| {
                panic!("{verdict} is in the set and the schema refused it: {error}")
            });
        }
        let read = queued_writes(&conn).unwrap();
        for verdict in Verdict::ALL {
            let row = read.iter().find(|row| row.id == verdict.as_str()).unwrap();
            assert_eq!(row.verdict, Some(verdict));
        }
        let blocked = read.iter().find(|row| row.id == "blocked").unwrap();
        assert_eq!(blocked.blocked_reason(), Some(BlockedReason::KeySpent));

        // A blocked row whose reason is not one of the five is a store this
        // build cannot read correctly. The schema cannot refuse it, because
        // the same column carries the server's codes under `refused`, so the
        // reader does.
        verdict_row("stray", "blocked", Some("resolver_missing")).unwrap();
        assert!(matches!(queued_writes(&conn), Err(CoreError::Store(_))));
    }

    /// Every kind that changes an item's row, laid back over the server's
    /// row in queue order. The device fixtures reach an edit, a tag and a
    /// delete; this reaches the rest, and the order: a transition and then
    /// a restore end active, a replace and then a merge end with both sets'
    /// last word.
    #[test]
    fn waiting_writes_are_laid_back_over_the_row_in_queue_order() {
        let conn = conn();
        replace_types(&conn, &[wire_type("core.note", None, Some("title"))]).unwrap();
        let server_row = note(
            "n1",
            "from the server",
            "server body",
            "2026-01-01T00:00:00Z",
        );
        upsert_item(
            &conn,
            &server_row,
            Some(&["kept".into()]),
            &Indexing::titled("title"),
        )
        .unwrap();
        let queue = |kind: WriteKind, payload: &str, tag: Option<&str>| {
            enqueue(
                &conn,
                &NewWrite {
                    kind,
                    item_id: Some("n1"),
                    target_id: None,
                    edge_id: None,
                    namespace: None,
                    tag,
                    blob: None,
                    base_version: None,
                    payload,
                    depends_on: &[],
                },
            )
            .unwrap()
        };
        queue(
            WriteKind::UpdateItem,
            r#"{"properties":{"title":"edited"},"version":1,"source_id":"moved.md"}"#,
            None,
        );
        queue(WriteKind::TransitionItem, r#"{"state":"archived"}"#, None);
        queue(WriteKind::RestoreItem, "{}", None);
        queue(WriteKind::ReplaceMetadata, r#"{"tags":["a","b"]}"#, None);
        queue(WriteKind::MergeMetadata, r#"{"tags":["c"]}"#, None);
        queue(WriteKind::RemoveTag, "{}", Some("a"));
        // An answered write is not laid back: its answer is already the row.
        let answered = queue(
            WriteKind::AddTag,
            r#"{"tags":["answered"]}"#,
            Some("answered"),
        );
        record_verdict(
            &conn,
            &answered.id,
            &Answered {
                verdict: Verdict::Accepted,
                reason: None,
                answer: None,
                conflicted_copy_id: None,
            },
        )
        .unwrap();

        lay_waiting_writes_over(&conn, "n1", &Indexing::titled("title")).unwrap();
        let item = items_by_ids(&conn, &["n1".into()]).unwrap().pop().unwrap();
        assert_eq!(item.title(Some("title")), Some("edited"));
        assert_eq!(
            item.properties.get("body").and_then(Value::as_str),
            Some("server body"),
            "a field no waiting write names keeps the server's value"
        );
        assert_eq!(item.source_id.as_deref(), Some("moved.md"));
        assert_eq!(item.state, ItemState::Active);
        assert_eq!(item.tags, vec!["b", "c"]);

        // A delete waiting after all of them leaves the row in the bin.
        queue(WriteKind::DeleteItem, "{}", None);
        lay_waiting_writes_over(&conn, "n1", &Indexing::titled("title")).unwrap();
        let item = items_by_ids(&conn, &["n1".into()]).unwrap().pop().unwrap();
        assert_eq!(item.state, ItemState::Trashed);

        // And a move to another state after that takes it there.
        queue(WriteKind::TransitionItem, r#"{"state":"archived"}"#, None);
        lay_waiting_writes_over(&conn, "n1", &Indexing::titled("title")).unwrap();
        let item = items_by_ids(&conn, &["n1".into()]).unwrap().pop().unwrap();
        assert_eq!(item.state, ItemState::Archived);
    }

    #[test]
    fn waiting_edge_writes_are_laid_back_over_the_edge() {
        let conn = conn();
        let mut edge = wire_edge("e1", "a", "b", "references");
        edge.properties.insert("weight".into(), Value::from(1));
        upsert_edge(&conn, &edge).unwrap();
        let queue = |kind: WriteKind, payload: &str| {
            enqueue(
                &conn,
                &NewWrite {
                    kind,
                    item_id: Some("a"),
                    target_id: Some("b"),
                    edge_id: Some("e1"),
                    namespace: None,
                    tag: None,
                    blob: None,
                    base_version: None,
                    payload,
                    depends_on: &[],
                },
            )
            .unwrap()
        };
        let answered = queue(
            WriteKind::UpdateEdge,
            r#"{"properties":{"note":"answered"}}"#,
        );
        record_verdict(
            &conn,
            &answered.id,
            &Answered {
                verdict: Verdict::Accepted,
                reason: None,
                answer: None,
                conflicted_copy_id: None,
            },
        )
        .unwrap();
        queue(WriteKind::UpdateEdge, r#"{"properties":{"weight":2}}"#);
        lay_waiting_edge_writes_over(&conn, "e1").unwrap();
        let held = edge_by_id(&conn, "e1").unwrap().unwrap();
        assert_eq!(held.properties.get("weight"), Some(&Value::from(2)));
        assert_eq!(
            held.properties.get("note"),
            None,
            "an answered write was laid back, and its answer is already the edge"
        );
        queue(WriteKind::DeleteEdge, r#"{"edge_type":"references"}"#);
        lay_waiting_edge_writes_over(&conn, "e1").unwrap();
        assert_eq!(edge_by_id(&conn, "e1").unwrap(), None);
    }

    /// Which blocked rows a drain unblocks before it starts
    /// (`queue-and-verdicts.md` 24, 27): the reasons that clear without a
    /// person, and those alone.
    #[test]
    fn a_drain_unblocks_the_reasons_that_clear_and_no_other() {
        let conn = conn();
        for reason in BlockedReason::ALL {
            conn.execute(
                "INSERT INTO queue (id, kind, idempotency_key, payload, verdict, reason, queued_at)
                 VALUES (?1, 'update_item', ?1, '{}', 'blocked', ?1, '2026-01-01T00:00:00Z')",
                [reason.as_str()],
            )
            .unwrap();
        }
        unblock_self_clearing(&conn).unwrap();
        let mut unblocked: Vec<String> = queued_writes(&conn)
            .unwrap()
            .into_iter()
            .filter(|row| row.verdict.is_none())
            .map(|row| row.id)
            .collect();
        unblocked.sort();
        assert_eq!(unblocked, vec!["awaiting_dependency", "credential_refused"]);
    }

    /// The two lookups laid over every answer and event go through their
    /// indexes, rather than scanning a queue that grows with every write
    /// made offline.
    #[test]
    fn waiting_writes_are_found_through_the_indexes() {
        let conn = conn();
        let plan = |column: &str| -> String {
            conn.prepare(&format!(
                "EXPLAIN QUERY PLAN SELECT {QUEUE_COLUMNS} FROM queue
                  WHERE {column} = ?1 AND (verdict IS NULL OR verdict = ?2) ORDER BY seq ASC"
            ))
            .unwrap()
            .query_map(["x", "blocked"], |row| row.get::<_, String>(3))
            .unwrap()
            .map(|detail| detail.unwrap())
            .collect::<Vec<_>>()
            .join("; ")
        };
        assert!(
            plan("item_id").contains("queue_item"),
            "{}",
            plan("item_id")
        );
        assert!(
            plan("edge_id").contains("queue_edge"),
            "{}",
            plan("edge_id")
        );
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
                &Indexing::default(),
            )
            .unwrap();
        }
        let conn = open(&path).unwrap();
        assert!(item_held(&conn, "n1").unwrap());
    }
}

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
    pub verdict: Verdict,
    pub reason: Option<&'a str>,
    pub answer: Option<&'a str>,
    pub conflicted_copy_id: Option<&'a str>,
}

/// Records that a write has gone out on the wire.
pub fn mark_sent(conn: &Connection, id: &str) -> Result<(), CoreError> {
    conn.execute("UPDATE queue SET sent = 1 WHERE id = ?1", [id])?;
    Ok(())
}

/// Writes a verdict onto a queued row.
///
/// The blocked reasons are checked here rather than by the schema, because
/// `reason` also carries the server's own refusal codes under `refused`, and
/// the schema cannot hold a copy of the server's error vocabulary without
/// going stale.
pub fn record_verdict(
    conn: &Connection,
    id: &str,
    answered: &Answered<'_>,
) -> Result<(), CoreError> {
    let changed = conn.execute(
        "UPDATE queue
            SET verdict = ?2, reason = ?3, answer = ?4,
                conflicted_copy_id = ?5, answered_at = ?6
          WHERE id = ?1",
        params![
            id,
            answered.verdict.as_str(),
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
pub fn block_unanswered(conn: &Connection, reason: BlockedReason) -> Result<usize, CoreError> {
    Ok(conn.execute(
        "UPDATE queue SET verdict = ?1, reason = ?2, answered_at = ?3
          WHERE verdict IS NULL",
        params![Verdict::Blocked.as_str(), reason.as_str(), now_iso()],
    )?)
}

/// Returns the rows blocked for a reason that clears on its own to unanswered.
pub fn unblock_self_clearing(conn: &Connection) -> Result<usize, CoreError> {
    let clearing: Vec<&str> = BlockedReason::ALL
        .into_iter()
        .filter(|reason| reason.clears_itself())
        .map(BlockedReason::as_str)
        .collect();
    let places = vec!["?"; clearing.len()].join(", ");
    Ok(conn.execute(
        &format!(
            "UPDATE queue SET verdict = NULL, reason = NULL, answered_at = NULL
              WHERE verdict = ? AND reason IN ({places})"
        ),
        params_from_iter(std::iter::once(Verdict::Blocked.as_str()).chain(clearing)),
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
    // alone clears a terminal refusal and sends the write a second time. A
    // refusal that later stops applying would then land content the caller
    // had watched disappear from their copy.
    let verdict = verdict.as_deref().map(str::parse::<Verdict>).transpose()?;
    let refused_by_dependency = verdict == Some(Verdict::Refused) && !sent;
    if !matches!(verdict, Some(Verdict::Blocked | Verdict::Dead)) && !refused_by_dependency {
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
            row.verdict == Some(Verdict::Refused) && row.depends_on.iter().any(|held| held == id)
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
/// **Whether a caller can still act on the row is the test, on both sides of
/// it.** A row is releasable when it is `blocked`, `dead`, or `refused`
/// without having been sent — the three `release` takes — and a releasable
/// row is never cleared. The dependency side is wider by one: a row is also
/// kept while anything still unanswered names it, because an unanswered row
/// has a verdict coming and may yet become one of those three.
///
/// Both halves go wrong the same way if the set is written as a list of
/// verdicts instead: a refused-unsent row cleared although `release` accepts
/// it, and a blocked row's create left unprotected, so that the release the
/// caller is told to perform produces a row whose dependency cannot be
/// found, which `readiness` reads as unanswered and holds forever against a
/// write that no longer exists.
pub fn forget_answered(conn: &Connection) -> Result<usize, CoreError> {
    Ok(conn.execute(
        "DELETE FROM queue
          WHERE verdict IN (:accepted, :merged, :conflicted, :refused)
            AND NOT (verdict = :refused AND sent = 0)
            AND NOT EXISTS (
              SELECT 1 FROM queue AS waiting
               WHERE (waiting.verdict IS NULL
                      OR waiting.verdict IN (:blocked, :dead)
                      OR (waiting.verdict = :refused AND waiting.sent = 0))
                 AND waiting.depends_on LIKE '%' || queue.id || '%'
            )",
        named_params! {
            ":accepted": Verdict::Accepted.as_str(),
            ":merged": Verdict::Merged.as_str(),
            ":conflicted": Verdict::Conflicted.as_str(),
            ":refused": Verdict::Refused.as_str(),
            ":blocked": Verdict::Blocked.as_str(),
            ":dead": Verdict::Dead.as_str(),
        },
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

/// Lays every write to an item that is still waiting back over the row as
/// the server last sent it (`queue-and-verdicts.md` 35), whole fields in the
/// order they were queued. Called after anything puts the server's row into
/// the copy: an answer the drain adopts, a reconcile, an event, a hydration.
pub fn lay_waiting_writes_over(
    conn: &Connection,
    item_id: &str,
    indexing: &Indexing,
) -> Result<(), CoreError> {
    let waiting = waiting_writes_for_item(conn, item_id)?;
    if waiting.is_empty() {
        return Ok(());
    }
    let Some(mut item) = items_by_ids(conn, std::slice::from_ref(&item_id.to_string()))?.pop()
    else {
        return Ok(());
    };
    let mut tags = item.tags.clone();
    for row in waiting {
        let payload: Value = serde_json::from_str(&payload_of(conn, &row.id)?)?;
        let named_tags = || -> Vec<String> {
            payload
                .get("tags")
                .and_then(Value::as_array)
                .map(|tags| {
                    tags.iter()
                        .filter_map(|tag| tag.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default()
        };
        match row.kind {
            WriteKind::UpdateItem => {
                if let Some(Value::Object(properties)) = payload.get("properties") {
                    for (key, value) in properties {
                        item.properties.insert(key.clone(), value.clone());
                    }
                }
                if let Some(Value::String(key)) = payload.get("source_id") {
                    item.source_id = Some(key.clone());
                }
            }
            WriteKind::TransitionItem => {
                if let Some(state) = payload.get("state").and_then(Value::as_str) {
                    item.state = state.parse()?;
                }
            }
            WriteKind::DeleteItem => item.state = ItemState::Trashed,
            WriteKind::RestoreItem => item.state = ItemState::Active,
            WriteKind::AddTag | WriteKind::MergeMetadata => {
                for tag in named_tags() {
                    if !tags.contains(&tag) {
                        tags.push(tag);
                    }
                }
            }
            WriteKind::RemoveTag => tags.retain(|tag| Some(tag) != row.tag.as_ref()),
            WriteKind::ReplaceMetadata => tags = named_tags(),
            WriteKind::CreateItem
            | WriteKind::CreateEdge
            | WriteKind::UpdateEdge
            | WriteKind::DeleteEdge
            | WriteKind::WriteExtension
            | WriteKind::DeleteExtension
            | WriteKind::UploadBlob => {}
        }
    }
    tags.sort();
    upsert_item(conn, &item.as_wire(), Some(&tags), indexing)
}

/// The same for an edge: an edit still waiting is laid back over the
/// server's properties, and a delete still waiting takes the edge out again.
pub fn lay_waiting_edge_writes_over(conn: &Connection, edge_id: &str) -> Result<(), CoreError> {
    let waiting = waiting_writes_for_edge(conn, edge_id)?;
    let Some(mut edge) = edge_by_id(conn, edge_id)? else {
        return Ok(());
    };
    for row in waiting {
        match row.kind {
            WriteKind::UpdateEdge => {
                let payload: Value = serde_json::from_str(&payload_of(conn, &row.id)?)?;
                if let Some(Value::Object(properties)) = payload.get("properties") {
                    for (key, value) in properties {
                        edge.properties.insert(key.clone(), value.clone());
                    }
                }
            }
            WriteKind::DeleteEdge => {
                delete_edge(conn, edge_id)?;
                return Ok(());
            }
            _ => {}
        }
    }
    upsert_edge(conn, &edge.as_wire())
}

/// Moves a queued write onto the version the server gave the row it was
/// based on, where that row was this device's own create
/// (`queue-and-verdicts.md` 36). The payload and the column both move, so
/// the queue reports what was sent.
pub fn rebase(conn: &Connection, id: &str, version: i64) -> Result<(), CoreError> {
    let mut payload: Value = serde_json::from_str(&payload_of(conn, id)?)?;
    if let Some(body) = payload.as_object_mut() {
        body.insert("version".into(), Value::from(version));
    }
    conn.execute(
        "UPDATE queue SET payload = ?2, base_version = ?3 WHERE id = ?1",
        params![id, payload.to_string(), version],
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
