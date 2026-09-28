use std::collections::HashMap;
use std::path::Path;

use rusqlite::{Connection, OptionalExtension, named_params, params, params_from_iter};
use serde_json::{Map, Value};
use uuid::Uuid;

use crate::catalog::Indexing;
use crate::error::CoreError;
use crate::js;
use crate::model::{
    BlockedReason, Edge, Item, ItemState, QueuedWrite, Subject, Tier, Verdict, WriteKind,
};
use crate::wire::{WireEdge, WireItem, WireType};

pub const SCHEMA: &str = include_str!("schema.sql");

pub const META_SCHEMA_VERSION: &str = "schema_version";
pub const META_SERVER_ORIGIN: &str = "server_origin";
pub const META_SLICE_TYPES: &str = "slice_types";
pub const META_SLICE_TIER: &str = "slice_tier";
pub const META_SLICE_EDGE_TYPES: &str = "slice_edge_types";
pub const META_EVENT_CURSOR: &str = "event_cursor";
pub const META_HYDRATE_STATE: &str = "hydrate_state";
pub const HYDRATE_IN_PROGRESS: &str = "in_progress";
pub const SCHEMA_VERSION: &str = "10";

/// Each schema version from 6 and the statements it names, hashed as the
/// folder mapping hashes bytes. While no store is live the version does not
/// move: a change to `schema.sql` rewrites the hash in the current version's
/// row, and the test holds the statements to that row.
///
/// Over the statements SQLite executes, not the file, so a comment moves no
/// hash.
#[cfg(test)]
const SCHEMA_HASHES: &[(&str, &str)] = &[
    ("6", "f73a05f772245511"),
    ("7", "b0e4c59d5dbd0471"),
    ("8", "662310c80f2c6871"),
    ("9", "23d541400ea60681"),
    ("10", "f83718abdf25de8e"),
];

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

/// Whether the copy keeps this row: pinned, or taken by the slice. A copy
/// that has never hydrated keeps nothing.
pub fn slice_holds(
    conn: &Connection,
    catalog: &crate::catalog::Catalog,
    item: &crate::wire::WireItem,
) -> Result<bool, CoreError> {
    if pinned(conn, &item.id)? {
        return Ok(true);
    }
    let Some((types, tier)) = slice(conn)? else {
        return Ok(false);
    };
    Ok(slice_takes(
        catalog,
        &types,
        tier,
        &item.r#type,
        Tier::parse_wire(item.tier.as_deref())?,
    ))
}

/// A folder's slice of every type the key reads (`folders.md` 2), which a
/// hydration declares no other way.
pub const EVERY_TYPE: &str = "*";

/// Whether a slice of `types` at `tier` takes a row: one of its types, with
/// the subtree, at its tier. `EVERY_TYPE` is what a bare listing answers,
/// which leaves `system.*` out.
pub fn slice_takes(
    catalog: &crate::catalog::Catalog,
    types: &[String],
    tier: Tier,
    row_type: &str,
    row_tier: Option<Tier>,
) -> bool {
    row_tier == Some(tier)
        && types.iter().any(|declared| {
            if declared == EVERY_TYPE {
                !row_type.starts_with("system.")
            } else {
                catalog.matches(declared, row_type)
            }
        })
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

/// Whether the copy holds the row or edge `id` at a version past `version`:
/// an answer at `version` is then older than what the copy holds, and is not
/// adopted over it (`queue-and-verdicts.md` 9).
pub fn holds_newer(
    conn: &Connection,
    subject: Subject,
    id: &str,
    version: i64,
) -> Result<bool, CoreError> {
    let held = match subject {
        Subject::Item => held_version(conn, id)?,
        Subject::Edge => edge_by_id(conn, id)?.map(|edge| edge.version),
    };
    Ok(held.is_some_and(|held| held > version))
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
     conflicted_copy_id, refusals, queued_at, answered_at, blob, follows";

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
    let follows = write_ahead(conn, write)?;
    conn.execute(
        "INSERT INTO queue (
             id, kind, item_id, target_id, edge_id, namespace, tag, blob,
             base_version, idempotency_key, payload, depends_on, queued_at,
             follows
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
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
            follows,
        ],
    )?;
    queued_write(conn, &id)?.ok_or_else(|| CoreError::Store("the queued write vanished".into()))
}

/// The write ahead of `write` to the same row or edge that is still to be
/// written (`queue-and-verdicts.md` 42).
fn write_ahead(conn: &Connection, write: &NewWrite<'_>) -> Result<Option<String>, CoreError> {
    let Some(subject) = write.kind.subject() else {
        return Ok(None);
    };
    let named = match subject {
        Subject::Item => write.item_id,
        Subject::Edge => write.edge_id,
    };
    let Some(named) = named else {
        return Ok(None);
    };
    let direct = last_write_to(conn, subject, named)?;
    if subject != Subject::Item {
        return Ok(direct);
    }
    // A create carrying this row's natural key lands on this row
    // (`queue-and-verdicts.md` 38), so it is a write to it too.
    let keyed: Option<(String, i64)> = conn
        .query_row(
            "SELECT queue.id, queue.seq FROM queue, items
              WHERE items.id = ?1 AND items.source_id IS NOT NULL
                AND queue.kind = ?2 AND queue.item_id != ?1
                AND json_extract(queue.payload, '$.source') = items.source
                AND json_extract(queue.payload, '$.source_id') = items.source_id
                AND (queue.verdict IS NULL OR queue.verdict NOT IN (?3, ?4, ?5))
              ORDER BY queue.seq DESC LIMIT 1",
            params![
                named,
                WriteKind::CreateItem.as_str(),
                Verdict::Accepted.as_str(),
                Verdict::Merged.as_str(),
                Verdict::Conflicted.as_str()
            ],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((keyed, keyed_seq)) = keyed else {
        return Ok(direct);
    };
    let direct_seq: Option<i64> = match &direct {
        Some(id) => conn
            .query_row("SELECT seq FROM queue WHERE id = ?1", [id], |row| {
                row.get(0)
            })
            .optional()?,
        None => None,
    };
    Ok(if direct_seq.is_some_and(|seq| seq > keyed_seq) {
        direct
    } else {
        Some(keyed)
    })
}

/// The last write queued to the row or edge `named` that the server has not
/// written: one unanswered, blocked or dead, which a drain or a release can
/// still send, or one refused. One the drain refused without sending it can
/// be released and sent; one the server refused never will be, and ordering
/// behind it holds nothing, since its answer is in. One the server has
/// written is behind whatever is queued now, and ordering behind it would
/// hold nothing either.
pub fn last_write_to(
    conn: &Connection,
    subject: Subject,
    named: &str,
) -> Result<Option<String>, CoreError> {
    let kinds = subject.kinds();
    let places = vec!["?"; kinds.len()].join(", ");
    Ok(conn
        .query_row(
            &format!(
                "SELECT id FROM queue
                  WHERE {column} = ? AND kind IN ({places})
                    AND (verdict IS NULL OR verdict NOT IN (?, ?, ?))
                  ORDER BY seq DESC LIMIT 1",
                column = subject.column()
            ),
            params_from_iter(
                std::iter::once(named)
                    .chain(kinds.iter().map(|kind| kind.as_str()))
                    .chain([
                        Verdict::Accepted.as_str(),
                        Verdict::Merged.as_str(),
                        Verdict::Conflicted.as_str(),
                    ]),
            ),
            |row| row.get(0),
        )
        .optional()?)
}

/// Orders a create carrying the natural key of a row the copy holds behind
/// that row's last write still to be written: the server lands the create
/// on that row (`queue-and-verdicts.md` 38), so it is a write to it, and
/// sent beside an edit of the row that has no answer it would reach the row
/// out of the order the two were made in.
pub fn follow_row_under_key(
    conn: &Connection,
    create: &QueuedWrite,
    source: &str,
    source_id: &str,
) -> Result<(), CoreError> {
    let held: Option<String> = conn
        .query_row(
            "SELECT id FROM items WHERE source = ?1 AND source_id = ?2 AND id != ?3",
            params![source, source_id, create.item_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(held) = held else {
        return Ok(());
    };
    if let Some(ahead) = last_write_to(conn, Subject::Item, &held)? {
        conn.execute(
            "UPDATE queue SET follows = ?2 WHERE id = ?1",
            params![create.id, ahead],
        )?;
    }
    Ok(())
}

/// Orders the writes to the row `item_id` again by the order they were
/// queued: each still to be written follows the nearest one still to be
/// written ahead of it (`queue-and-verdicts.md` 42). What a write's `follows`
/// says when it is queued, said again for a row the writes of a create that
/// landed on it have just been moved onto (38, 39), when that row may have
/// writes of its own still to go ahead of them. The create itself, which
/// has its answer, is `answered` and orders nothing.
pub fn refollow(conn: &Connection, item_id: &str, answered: &str) -> Result<(), CoreError> {
    let kinds = Subject::Item.kinds();
    let places = vec!["?"; kinds.len()].join(", ");
    let mut statement = conn.prepare(&format!(
        "SELECT id FROM queue
          WHERE item_id = ? AND id != ? AND kind IN ({places})
            AND (verdict IS NULL OR verdict NOT IN (?, ?, ?))
          ORDER BY seq"
    ))?;
    let ids: Vec<String> = statement
        .query_map(
            params_from_iter(
                [item_id, answered]
                    .into_iter()
                    .chain(kinds.iter().map(|kind| kind.as_str()))
                    .chain([
                        Verdict::Accepted.as_str(),
                        Verdict::Merged.as_str(),
                        Verdict::Conflicted.as_str(),
                    ]),
            ),
            |row| row.get(0),
        )?
        .collect::<Result<_, _>>()?;
    let mut ahead: Option<String> = None;
    for id in ids {
        conn.execute(
            "UPDATE queue SET follows = ?2 WHERE id = ?1",
            params![id, ahead],
        )?;
        ahead = Some(id);
    }
    Ok(())
}

/// One queued write by id.
pub fn queued_write(conn: &Connection, id: &str) -> Result<Option<QueuedWrite>, CoreError> {
    Ok(read_writes(conn, "WHERE id = ?1", [id])?.pop())
}

/// The creates naming this item that the server has not taken: unanswered,
/// or blocked, which a release or a reason clearing sends again.
///
/// What a later write to the same item waits for (`queue-and-verdicts.md`
/// 4): the row does not exist on the server until its create lands. A
/// blocked create counts because it is waiting still (35); a write sent past
/// one is refused `item_not_found`, and the reconcile that follows forgets
/// the row the create is still trying to make. Only creates, because
/// statement 16 is about a row the server never accepted — a sibling write
/// that failed for its own reasons has nothing to do with whether this one
/// can be sent.
pub fn untaken_creates_for_item(
    conn: &Connection,
    item_id: &str,
) -> Result<Vec<String>, CoreError> {
    Ok(waiting_writes_for_item(conn, item_id)?
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

/// Whether any write to an item is still waiting.
pub fn item_waits(conn: &Connection, id: &str) -> Result<bool, CoreError> {
    Ok(!waiting_writes_for_item(conn, id)?.is_empty())
}

/// The writes still waiting on one item, read through the index rather than
/// by reading the whole queue, because this runs once per answer and once
/// per event.
pub fn waiting_writes_for_item(conn: &Connection, id: &str) -> Result<Vec<QueuedWrite>, CoreError> {
    read_writes(
        conn,
        "WHERE item_id = ?1 AND (verdict IS NULL OR verdict = ?2)",
        [id, Verdict::Blocked.as_str()],
    )
}

/// Whether a write of this device's to the edge is still to be answered.
pub fn edge_write_waits(conn: &Connection, id: &str) -> Result<bool, CoreError> {
    Ok(!waiting_writes_for_edge(conn, id)?.is_empty())
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
            follows: row.get(18)?,
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
            follows: raw.follows,
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
    follows: Option<String>,
}

type TypeRow = (
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    String,
);

/// The field a type's own declaration makes its thumbnail. Registration
/// allows one, stored as the field type whichever way it was declared.
fn thumbnail_field_of(declared: &Map<String, Value>) -> Option<String> {
    declared
        .get("fields")?
        .as_object()?
        .iter()
        .find(|(_, field)| field.get("type").and_then(Value::as_str) == Some("thumbnail"))
        .map(|(name, _)| name.clone())
}

/// Replaces the type catalog, and writes nothing where it is the one held:
/// a follow asks for the catalog on every stream it opens, and a reader told
/// of each save would otherwise be told of one every two minutes. Where it
/// changes, every held row is indexed again, since a title or a thumbnail
/// the catalog now names changes what a row's entry holds.
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
            if let Some(body) = &hints.body_field {
                json.insert(
                    "display_hints".into(),
                    serde_json::json!({ "body_field": body }),
                );
            }
            (
                entry.id.clone(),
                entry.parent.clone(),
                entry.label.clone(),
                hints.title_field,
                thumbnail_field_of(&entry.rest),
                Value::Object(json).to_string(),
            )
        })
        .collect();
    rows.sort();
    let held: Vec<TypeRow> = conn
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
        .collect::<Result<_, _>>()?;
    if held == rows {
        return Ok(());
    }
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
    reindex(conn)
}

/// Writes every held row's index entry again from the catalog as it is.
fn reindex(conn: &Connection) -> Result<(), CoreError> {
    let catalog = crate::catalog::Catalog::load(conn)?;
    let held: Vec<(i64, String, String, String, String)> = conn
        .prepare("SELECT seq, id, type, state, properties FROM items")?
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
    for (seq, id, type_id, state, properties) in held {
        let properties: Map<String, Value> = serde_json::from_str(&properties)?;
        index_row(
            conn,
            seq,
            &id,
            &state,
            &properties,
            &catalog.indexing(&type_id),
        )?;
    }
    Ok(())
}

/// The row's entry in the local index, from its properties and tags as the
/// store holds them.
fn index_row(
    conn: &Connection,
    seq: i64,
    id: &str,
    state: &str,
    properties: &Map<String, Value>,
    indexing: &Indexing,
) -> Result<(), CoreError> {
    let tags = tags_for_one(conn, id)?;
    let (title, body) = fts_text(properties, indexing);
    conn.execute("DELETE FROM items_fts WHERE rowid = ?1", [seq])?;
    // A row in the bin is not indexed, which is the server's own rule on
    // the same index: it drops a trashed row from the index on the write
    // that trashes it, and rebuilds without one. A device that indexed it
    // would answer a search the server it copies answers nothing for, and
    // would do it under every state value rather than one.
    if ItemState::from_str_checked(state)? != ItemState::Trashed {
        conn.execute(
            "INSERT INTO items_fts (rowid, title, body, tags) VALUES (?1, ?2, ?3, ?4)",
            params![seq, title, body, tags.join(" ")],
        )?;
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
            js::json(&Value::Object(item.properties.clone())),
        ],
    )?;
    if let Some(tags) = tags {
        conn.execute("DELETE FROM tags WHERE item_id = ?1", [&item.id])?;
        let mut insert =
            conn.prepare_cached("INSERT OR IGNORE INTO tags (item_id, tag) VALUES (?1, ?2)")?;
        for tag in tags {
            insert.execute(params![item.id, tag])?;
        }
    }
    let seq: i64 = conn.query_row("SELECT seq FROM items WHERE id = ?1", [&item.id], |row| {
        row.get(0)
    })?;
    index_row(conn, seq, &item.id, &item.state, &item.properties, indexing)
}

/// Moves everything the copy says about the item it minted as `local` onto
/// `answered`, the row the server answered its create with.
///
/// A create carrying a natural key the server already holds lands on that
/// row (`items.md` 5), so the server answers with the row's id rather than
/// the one the device minted. The minted row goes, and every write still
/// waiting on it and every edge names the server's row instead: left alone,
/// each would address an id the server never held.
pub fn adopt_answered_id(conn: &Connection, local: &str, answered: &str) -> Result<(), CoreError> {
    if local == answered {
        return Ok(());
    }
    conn.execute(
        "DELETE FROM items_fts WHERE rowid IN (SELECT seq FROM items WHERE id = ?1)",
        [local],
    )?;
    conn.execute("DELETE FROM tags WHERE item_id = ?1", [local])?;
    conn.execute("DELETE FROM items WHERE id = ?1", [local])?;
    for statement in [
        "UPDATE edges SET source_id = ?2 WHERE source_id = ?1",
        "UPDATE edges SET target_id = ?2 WHERE target_id = ?1",
        "UPDATE queue SET item_id = ?2 WHERE item_id = ?1",
        "UPDATE queue SET target_id = ?2 WHERE target_id = ?1",
        "UPDATE OR IGNORE pins SET item_id = ?2 WHERE item_id = ?1",
    ] {
        conn.execute(statement, params![local, answered])?;
    }
    // Left where the server's row was pinned already.
    unpin(conn, local)?;
    // An edge create carries its endpoints in the body it sends.
    let mut edges = conn
        .prepare("SELECT id, payload FROM queue WHERE kind = 'create_edge' AND verdict IS NULL")?;
    let waiting: Vec<(String, String)> = edges
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<Result<_, _>>()?;
    for (id, payload) in waiting {
        let mut body: Value = serde_json::from_str(&payload)?;
        let mut moved = false;
        for endpoint in ["source_id", "target_id"] {
            if body.get(endpoint).and_then(Value::as_str) == Some(local) {
                body[endpoint] = Value::String(answered.to_string());
                moved = true;
            }
        }
        if moved {
            conn.execute(
                "UPDATE queue SET payload = ?2 WHERE id = ?1",
                params![id, body.to_string()],
            )?;
        }
    }
    Ok(())
}

/// Moves the copy onto `answered`, the row a create's natural key resolved
/// where the server refused the create because that row was there
/// (`queue-and-verdicts.md` 39), and answers the writes it refused on the way.
///
/// The row the create would have made exists, so a write that only adds to
/// it goes to it: a tag added, an edge made to or from it. A write that
/// replaces, takes away or moves the state of the row does not. It was made
/// against the row this device created, and sent to the server's row it
/// would do to another device's item, one this device never read, what was
/// meant for this one: its fields replaced, its metadata or an extension
/// overwritten, a tag it carries taken off, the item archived or deleted. An
/// update is one of those twice over, since it names a version of a row the
/// server never made. Each is refused with the create (16) and never sent.
pub fn land_on_held_row(
    conn: &Connection,
    create: &QueuedWrite,
    answered: &str,
) -> Result<Vec<(QueuedWrite, String)>, CoreError> {
    let Some(local) = create.item_id.as_deref() else {
        return Ok(Vec::new());
    };
    let mut refused = Vec::new();
    for row in waiting_writes(conn)? {
        if !row.depends_on.contains(&create.id) {
            continue;
        }
        let replaces = match row.kind {
            WriteKind::AddTag | WriteKind::CreateEdge => false,
            WriteKind::UpdateItem
            | WriteKind::DeleteItem
            | WriteKind::RestoreItem
            | WriteKind::TransitionItem
            | WriteKind::ReplaceMetadata
            | WriteKind::MergeMetadata
            | WriteKind::RemoveTag
            | WriteKind::WriteExtension
            | WriteKind::DeleteExtension => true,
            // Not written against an item's create, so never one of its
            // dependants; refused all the same should one ever be.
            WriteKind::CreateItem
            | WriteKind::UpdateEdge
            | WriteKind::DeleteEdge
            | WriteKind::UploadBlob => true,
        };
        if replaces {
            let reason = format!(
                "the create it waited on was refused because {answered} already holds its natural key, \
                 and this {} was made against a row the server never made",
                row.kind
            );
            record_verdict(
                conn,
                &row.id,
                &Answered {
                    verdict: Verdict::Refused,
                    reason: Some(&reason),
                    answer: None,
                    conflicted_copy_id: None,
                },
            )?;
            refused.push((row, reason));
            continue;
        }
        let still: Vec<&String> = row
            .depends_on
            .iter()
            .filter(|held| **held != create.id)
            .collect();
        conn.execute(
            "UPDATE queue SET depends_on = ?2 WHERE id = ?1",
            params![
                row.id,
                if still.is_empty() {
                    None
                } else {
                    Some(serde_json::to_string(&still)?)
                }
            ],
        )?;
    }
    adopt_answered_id(conn, local, answered)?;
    refollow(conn, answered, &create.id)?;
    Ok(refused)
}

/// Marks the files bound to `item_id` as holding bytes the row does not, read
/// at `version`, where `edit` is the last update of that row queued: its save
/// was set aside in a conflicted copy against this device's own earlier one
/// (`queue-and-verdicts.md` 42), so what the file holds reached no row. The
/// pull then leaves the file as it is, and the next scan sends it as an edit
/// based on that version (`folders.md` 39). Where a later update is queued,
/// the file holds that one's bytes, and it is left to its own answer.
pub fn untake_latest_save(
    conn: &Connection,
    edit: &QueuedWrite,
    item_id: &str,
    version: i64,
) -> Result<(), CoreError> {
    conn.execute(
        "UPDATE folder_files SET content_hash = ?2
          WHERE item_id = ?1
            AND NOT EXISTS (
              SELECT 1 FROM queue
               WHERE kind = ?3 AND item_id = ?1
                 AND seq > (SELECT seq FROM queue WHERE id = ?4)
            )",
        params![
            item_id,
            crate::folder::state::untaken_read_at(version),
            WriteKind::UpdateItem.as_str(),
            edit.id
        ],
    )?;
    Ok(())
}

/// Blocks every unanswered create naming `source`, under
/// `credential_refused` (`queue-and-verdicts.md` 40), and answers their ids.
///
/// The server refused one because the credential's key does not claim the
/// source, and every other create naming it carries the same credential and
/// the same source: sending each would be asking the same question once per
/// file. Writes naming no source, or another, are left to go.
pub fn block_creates_naming(conn: &Connection, source: &str) -> Result<Vec<String>, CoreError> {
    let mut blocked = Vec::new();
    for row in read_writes(
        conn,
        "WHERE verdict IS NULL AND kind = ?1",
        [WriteKind::CreateItem.as_str()],
    )? {
        let payload: Value = serde_json::from_str(&payload_of(conn, &row.id)?)?;
        if payload.get("source").and_then(Value::as_str) != Some(source) {
            continue;
        }
        record_verdict(
            conn,
            &row.id,
            &Answered {
                verdict: Verdict::Blocked,
                reason: Some(BlockedReason::CredentialRefused.as_str()),
                answer: None,
                conflicted_copy_id: None,
            },
        )?;
        blocked.push(row.id);
    }
    Ok(blocked)
}

/// Drops an item the server purged, with its pin and every edge at either
/// end: an edge to it would point at nothing anywhere.
pub fn purge_item(conn: &Connection, id: &str) -> Result<bool, CoreError> {
    let unpinned = unpin(conn, id)?;
    let removed = remove_item(
        conn,
        id,
        "DELETE FROM edges WHERE source_id = ?1 OR target_id = ?1",
        &[],
    )?;
    Ok(removed || unpinned)
}

/// Drops an item that left the slice with the edges it draws, but those of a
/// type in `whole`; edges drawn to it stay, as a hydration holds them (`device.md` 43).
pub fn evict_item(conn: &Connection, id: &str, whole: &[String]) -> Result<bool, CoreError> {
    let kept = vec!["?"; whole.len()].join(", ");
    let edges = if whole.is_empty() {
        "DELETE FROM edges WHERE source_id = ?1".to_string()
    } else {
        format!("DELETE FROM edges WHERE source_id = ?1 AND edge_type NOT IN ({kept})")
    };
    remove_item(conn, id, &edges, whole)
}

/// Whether the copy changed: a purge of an item already evicted still takes
/// the edges held items drew to it.
fn remove_item(
    conn: &Connection,
    id: &str,
    edges: &str,
    kept: &[String],
) -> Result<bool, CoreError> {
    conn.execute(
        "DELETE FROM items_fts WHERE rowid IN (SELECT seq FROM items WHERE id = ?1)",
        [id],
    )?;
    conn.execute("DELETE FROM tags WHERE item_id = ?1", [id])?;
    let edges = conn.execute(
        edges,
        params_from_iter(std::iter::once(id).chain(kept.iter().map(String::as_str))),
    )?;
    Ok(conn.execute("DELETE FROM items WHERE id = ?1", [id])? + edges > 0)
}

/// The edge types a hydration declared to hold whole, or none.
pub fn whole_edge_types(conn: &Connection) -> Result<Vec<String>, CoreError> {
    match meta_get(conn, META_SLICE_EDGE_TYPES)? {
        Some(json) => Ok(serde_json::from_str(&json)?),
        None => Ok(Vec::new()),
    }
}

/// Holds `id` by id from now on. Answers whether it was not pinned already.
pub fn pin(conn: &Connection, id: &str) -> Result<bool, CoreError> {
    Ok(conn.execute("INSERT OR IGNORE INTO pins (item_id) VALUES (?1)", [id])? > 0)
}

/// Stops holding `id` by id. Answers whether it was pinned.
pub fn unpin(conn: &Connection, id: &str) -> Result<bool, CoreError> {
    Ok(conn.execute("DELETE FROM pins WHERE item_id = ?1", [id])? > 0)
}

pub fn pinned(conn: &Connection, id: &str) -> Result<bool, CoreError> {
    Ok(conn
        .query_row("SELECT 1 FROM pins WHERE item_id = ?1", [id], |_| Ok(()))
        .optional()?
        .is_some())
}

/// Every pinned id, in order.
pub fn pins(conn: &Connection) -> Result<Vec<String>, CoreError> {
    let mut statement = conn.prepare("SELECT item_id FROM pins ORDER BY item_id")?;
    let rows = statement.query_map([], |row| row.get(0))?;
    Ok(rows.collect::<Result<Vec<String>, _>>()?)
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
    edges_at(conn, "source_id", source_id)
}

pub fn edges_to(conn: &Connection, target_id: &str) -> Result<Vec<Edge>, CoreError> {
    edges_at(conn, "target_id", target_id)
}

/// The edges whose `end` column names `id`. A column name is spliced into
/// the query, so it is a literal of this file, never a caller's text.
fn edges_at(conn: &Connection, end: &'static str, id: &str) -> Result<Vec<Edge>, CoreError> {
    let sql = format!("SELECT {EDGE_COLUMNS} FROM edges WHERE {end} = ?1 ORDER BY created_at, id");
    let mut statement = conn.prepare(&sql)?;
    let rows = statement.query_map([id], row_to_edge)?;
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

/// The title column, and every other string-valued property but the
/// thumbnail, for the FTS row. A thumbnail is never indexed, not even as a
/// title a type named it.
pub fn fts_text(properties: &Map<String, Value>, indexing: &Indexing) -> (String, String) {
    let title_key = indexing.title_field.as_deref().unwrap_or("title");
    let title = if indexing.thumbnail_field.as_deref() == Some(title_key) {
        String::new()
    } else {
        properties
            .get(title_key)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };
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
                body_field: None,
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

    /// The current version's row names this schema's statements and no
    /// other version's.
    #[test]
    fn the_schema_version_names_the_schema_as_it_is() {
        let versions: Vec<&str> = SCHEMA_HASHES.iter().map(|(version, _)| *version).collect();
        let hashes: Vec<&str> = SCHEMA_HASHES.iter().map(|(_, hash)| *hash).collect();
        assert_eq!(
            versions.last(),
            Some(&SCHEMA_VERSION),
            "SCHEMA_VERSION is not the newest row of SCHEMA_HASHES: a version moved back, or a row was added without moving it"
        );
        let unique = |list: &[&str]| {
            list.iter().collect::<std::collections::HashSet<_>>().len() == list.len()
        };
        assert!(
            unique(&versions),
            "two rows of SCHEMA_HASHES name one version"
        );
        assert!(
            unique(&hashes),
            "two versions in SCHEMA_HASHES name the same statements"
        );
        assert_eq!(
            crate::folder::state::hash(schema_statements().as_bytes()),
            hashes[hashes.len() - 1],
            "schema.sql's statements changed: write their hash into SCHEMA_HASHES's row for SCHEMA_VERSION"
        );
    }

    /// A catalog that changes writes every held row's entry again: the
    /// thumbnail it now names leaves the entry, the row's tags stay in it,
    /// and a row in the bin is still given none.
    #[test]
    fn a_changed_catalog_indexes_every_held_row_again() {
        let conn = conn();
        let photo = |thumbnail: bool| {
            let mut wire = wire_type("acme.photo", None, Some("title"));
            if thumbnail {
                wire.rest.insert(
                    "fields".into(),
                    json!({ "thumbnail": { "type": "thumbnail" } }),
                );
            }
            wire
        };
        replace_types(&conn, &[photo(false)]).unwrap();
        let properties = json!({
            "title": "Holiday",
            "thumbnail": "data:image/png;base64,iVBORw0KGgoA/unicornsXYZ",
        });
        let indexing = crate::catalog::Catalog::load(&conn)
            .unwrap()
            .indexing("acme.photo");
        for (id, state) in [("held", "active"), ("binned", "trashed")] {
            let row = wire_item(
                id,
                "acme.photo",
                state,
                "2026-01-01T00:00:00Z",
                properties.clone(),
            );
            upsert_item(&conn, &row, Some(&["summer".into()]), &indexing).unwrap();
        }
        let entry = |id: &str| -> Option<(String, String)> {
            conn.query_row(
                "SELECT body, tags FROM items_fts WHERE rowid = (SELECT seq FROM items WHERE id = ?1)",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .unwrap()
        };
        // The witness: before the catalog names the thumbnail its base64 is
        // a string like any other, in the entry beside the tags.
        let (body, tags) = entry("held").expect("the held row has no entry");
        assert!(body.contains("unicornsXYZ"), "{body}");
        assert_eq!(tags, "summer");
        assert_eq!(entry("binned"), None);

        replace_types(&conn, &[photo(true)]).unwrap();
        let (body, tags) =
            entry("held").expect("the catalog changed and the held row lost its entry");
        assert!(
            !body.contains("unicornsXYZ"),
            "the catalog named the thumbnail and the entry still holds its base64: {body}"
        );
        assert_eq!(
            tags, "summer",
            "the entry written again dropped the row's tags"
        );
        assert_eq!(
            entry("binned"),
            None,
            "the entry written again put a row in the bin into the index"
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

    /// Everything that named the minted id names the server's row after a
    /// create lands on one it held (`queue-and-verdicts.md` 38), and nothing
    /// that named another id is touched.
    #[test]
    fn a_create_answered_with_another_id_moves_everything_onto_it() {
        let conn = conn();
        let indexing = Indexing::titled("title");
        for id in ["local", "server", "other"] {
            upsert_item(
                &conn,
                &note(id, id, "b", "2026-01-01T00:00:00Z"),
                None,
                &indexing,
            )
            .unwrap();
        }
        upsert_edge(&conn, &wire_edge("e1", "local", "other", "references")).unwrap();
        upsert_edge(&conn, &wire_edge("e2", "other", "local", "references")).unwrap();
        upsert_edge(&conn, &wire_edge("e3", "other", "other", "references")).unwrap();
        conn.execute(
            "INSERT INTO queue (id, kind, item_id, target_id, payload, idempotency_key, depends_on, queued_at)
             VALUES ('q1', 'create_edge', 'other', 'local', ?1, 'k1', '[]', ''),
                    ('q2', 'update_item', 'local', NULL, '{}', 'k2', '[]', '')",
            [serde_json::json!({ "source_id": "other", "target_id": "local" }).to_string()],
        )
        .unwrap();

        adopt_answered_id(&conn, "local", "server").unwrap();

        assert!(
            item_by_id(&conn, "local").unwrap().is_none(),
            "the minted row is still held"
        );
        assert!(item_by_id(&conn, "server").unwrap().is_some());
        let endpoints = |id: &str| -> (String, String) {
            conn.query_row(
                "SELECT source_id, target_id FROM edges WHERE id = ?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap()
        };
        assert_eq!(endpoints("e1"), ("server".into(), "other".into()));
        assert_eq!(endpoints("e2"), ("other".into(), "server".into()));
        assert_eq!(endpoints("e3"), ("other".into(), "other".into()));
        let queued = |id: &str| -> (Option<String>, Option<String>, String) {
            conn.query_row(
                "SELECT item_id, target_id, payload FROM queue WHERE id = ?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap()
        };
        let (item, target, payload) = queued("q1");
        assert_eq!(
            (item.as_deref(), target.as_deref()),
            (Some("other"), Some("server"))
        );
        let payload: Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(payload["source_id"], "other");
        assert_eq!(payload["target_id"], "server");
        assert_eq!(queued("q2").0.as_deref(), Some("server"));
    }

    #[test]
    fn purging_an_item_takes_its_tags_index_row_and_edges() {
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
        pin(&conn, "n1").unwrap();
        assert!(purge_item(&conn, "n1").unwrap());
        assert!(!purge_item(&conn, "n1").unwrap());
        assert!(!pinned(&conn, "n1").unwrap());
        assert_eq!(count(&conn, "tags").unwrap(), 0);
        assert_eq!(count(&conn, "items_fts").unwrap(), 1);
        assert_eq!(count(&conn, "edges").unwrap(), 0);
        assert!(!item_held(&conn, "n1").unwrap());
        assert!(item_held(&conn, "n2").unwrap());
    }

    #[test]
    fn evicting_an_item_keeps_the_edges_drawn_to_it() {
        let conn = conn();
        for id in ["n1", "n2"] {
            upsert_item(
                &conn,
                &note(id, "a", "b", "2026-01-01T00:00:00Z"),
                Some(&["t".into()]),
                &Indexing::default(),
            )
            .unwrap();
        }
        upsert_edge(&conn, &wire_edge("from", "n1", "n2", "references")).unwrap();
        upsert_edge(&conn, &wire_edge("toward", "n2", "n1", "references")).unwrap();
        assert!(evict_item(&conn, "n1", &[]).unwrap());
        assert!(!evict_item(&conn, "n1", &[]).unwrap());
        assert_eq!(count(&conn, "tags").unwrap(), 1);
        assert_eq!(count(&conn, "items_fts").unwrap(), 1);
        let left: Vec<String> = edges_from(&conn, "n2")
            .unwrap()
            .into_iter()
            .map(|edge| edge.id)
            .collect();
        assert_eq!(left, ["toward"]);
        assert!(edges_from(&conn, "n1").unwrap().is_empty());
        assert!(!item_held(&conn, "n1").unwrap());
        // Purged after it left, the item still takes the edge drawn to it.
        assert!(purge_item(&conn, "n1").unwrap());
        assert!(edges_from(&conn, "n2").unwrap().is_empty());
    }

    /// An edge of a type held whole outlives the eviction of its source, of
    /// either type named, and one of another type does not.
    #[test]
    fn evicting_an_item_keeps_the_edges_of_a_type_held_whole() {
        let conn = conn();
        upsert_item(
            &conn,
            &note("n1", "a", "b", "2026-01-01T00:00:00Z"),
            None,
            &Indexing::default(),
        )
        .unwrap();
        for (id, edge_type) in [
            ("drawn", "references"),
            ("beneath", "parent-of"),
            ("before", "supersedes"),
        ] {
            upsert_edge(&conn, &wire_edge(id, "n1", "n2", edge_type)).unwrap();
        }
        let whole = ["parent-of".to_string(), "supersedes".to_string()];
        assert!(evict_item(&conn, "n1", &whole).unwrap());
        let left: Vec<String> = edges_from(&conn, "n1")
            .unwrap()
            .into_iter()
            .map(|edge| edge.id)
            .collect();
        assert_eq!(left, ["before", "beneath"]);
    }

    /// A pin on a minted id moves to the row the server answered, and one
    /// already on that row is not doubled.
    #[test]
    fn a_pin_moves_to_the_answered_id() {
        let conn = conn();
        assert!(pin(&conn, "minted").unwrap());
        assert!(!pin(&conn, "minted").unwrap());
        adopt_answered_id(&conn, "minted", "answered").unwrap();
        assert_eq!(pins(&conn).unwrap(), ["answered"]);
        pin(&conn, "second").unwrap();
        adopt_answered_id(&conn, "second", "answered").unwrap();
        assert_eq!(pins(&conn).unwrap(), ["answered"]);
        assert!(unpin(&conn, "answered").unwrap());
        assert!(!pinned(&conn, "answered").unwrap());
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
        // read back. `payload`, `spent_keys`, `sent` and `read` are read
        // through their own queries rather than this list, because each is
        // wanted on its own at a different moment: the payload when a row is
        // sent, the next two when one is released, and the last when an
        // answer ahead of it may move it.
        table.retain(|name| {
            !matches!(
                name.as_str(),
                "seq" | "payload" | "spent_keys" | "sent" | "read"
            )
        });
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

        lay_waiting_writes_over(&conn, "n1", &|_| Indexing::titled("title")).unwrap();
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
        lay_waiting_writes_over(&conn, "n1", &|_| Indexing::titled("title")).unwrap();
        let item = items_by_ids(&conn, &["n1".into()]).unwrap().pop().unwrap();
        assert_eq!(item.state, ItemState::Trashed);

        // And a move to another state after that takes it there.
        queue(WriteKind::TransitionItem, r#"{"state":"archived"}"#, None);
        lay_waiting_writes_over(&conn, "n1", &|_| Indexing::titled("title")).unwrap();
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

    /// After a landing, the row's writes still to be written follow one
    /// another in the order they were queued, whichever row each was queued
    /// against, and the create that landed orders nothing. The witness for
    /// the skipped create is the write behind it following the one before.
    #[test]
    fn a_landing_orders_the_row_again_by_the_order_writes_were_queued() {
        let conn = conn();
        let queue = |kind: WriteKind, item: &str| {
            enqueue(
                &conn,
                &NewWrite {
                    kind,
                    item_id: Some(item),
                    target_id: None,
                    edge_id: None,
                    namespace: None,
                    tag: None,
                    blob: None,
                    base_version: Some(1),
                    payload: "{}",
                    depends_on: &[],
                },
            )
            .unwrap()
        };
        let own = queue(WriteKind::UpdateItem, "held");
        let create = queue(WriteKind::CreateItem, "minted");
        let moved = queue(WriteKind::UpdateItem, "minted");
        assert_eq!(moved.follows.as_deref(), Some(create.id.as_str()));
        adopt_answered_id(&conn, "minted", "held").unwrap();
        refollow(&conn, "held", &create.id).unwrap();
        let moved = queued_write(&conn, &moved.id).unwrap().unwrap();
        assert_eq!(
            moved.follows.as_deref(),
            Some(own.id.as_str()),
            "the write moved onto the row does not follow the row's own write ahead of it"
        );
        assert_eq!(queued_write(&conn, &own.id).unwrap().unwrap().follows, None);
    }

    /// An answer is older than the copy only where the copy holds the row or
    /// edge at a later version; the witnesses are the same answer at the
    /// version held and past it, and a row the copy does not hold.
    #[test]
    fn an_answer_is_older_only_than_a_later_version_held() {
        let conn = conn();
        let mut row = note("row", "title", "body", "2026-01-01T00:00:00Z");
        row.version = 5;
        upsert_item(&conn, &row, None, &Indexing::default()).unwrap();
        let mut edge = wire_edge("link", "row", "row", "references");
        edge.version = 5;
        upsert_edge(&conn, &edge).unwrap();
        for (subject, id) in [(Subject::Item, "row"), (Subject::Edge, "link")] {
            assert!(holds_newer(&conn, subject, id, 4).unwrap());
            assert!(!holds_newer(&conn, subject, id, 5).unwrap());
            assert!(!holds_newer(&conn, subject, id, 6).unwrap());
            assert!(!holds_newer(&conn, subject, "elsewhere", 1).unwrap());
        }
    }

    /// Every kind of write to a row is a write to it, and every kind of write
    /// to an edge a write to that edge, so each follows the one queued ahead
    /// of it; and a write ahead that died, or that the drain refused without
    /// sending it, still orders the one behind it, since a release can send
    /// it again. The witness is the upload, which is a write to no row and
    /// follows nothing.
    #[test]
    fn every_write_to_a_row_or_an_edge_follows_the_one_ahead_of_it() {
        let conn = conn();
        let queue = |kind: WriteKind, edge: Option<&str>| {
            enqueue(
                &conn,
                &NewWrite {
                    kind,
                    item_id: Some("row"),
                    target_id: None,
                    edge_id: edge,
                    namespace: None,
                    tag: None,
                    blob: None,
                    base_version: None,
                    payload: "{}",
                    depends_on: &[],
                },
            )
            .unwrap()
        };
        for subject in [Subject::Item, Subject::Edge] {
            let edge = (subject == Subject::Edge).then_some("link");
            let mut ahead: Option<String> = None;
            for kind in subject.kinds() {
                let queued = queue(kind, edge);
                assert_eq!(
                    queued.follows, ahead,
                    "a {kind} does not follow the write to the same {subject:?} ahead of it"
                );
                ahead = Some(queued.id);
            }
            for verdict in [Verdict::Refused, Verdict::Dead] {
                let answered = ahead.clone().unwrap();
                record_verdict(
                    &conn,
                    &answered,
                    &Answered {
                        verdict,
                        reason: None,
                        answer: None,
                        conflicted_copy_id: None,
                    },
                )
                .unwrap();
                let behind = queue(subject.kinds()[0], edge);
                assert_eq!(
                    behind.follows.as_deref(),
                    Some(answered.as_str()),
                    "a write behind a {verdict} one does not follow it"
                );
                ahead = Some(behind.id);
            }
        }
        assert_eq!(queue(WriteKind::UploadBlob, None).follows, None);
        assert_eq!(
            Subject::Item.kinds().len() + Subject::Edge.kinds().len(),
            14
        );
    }

    /// A write follows the nearest write ahead of it to the same row or edge
    /// that is still to be written, and nothing else: not one the server has
    /// written, not a write to another row, and not an edge write, which
    /// names the row it starts from and is a write to the edge. The witness
    /// for each is the write it does follow.
    #[test]
    fn a_write_follows_the_write_ahead_of_it_to_the_same_row() {
        let conn = conn();
        let queue = |kind: WriteKind, item: &str, edge: Option<&str>| {
            enqueue(
                &conn,
                &NewWrite {
                    kind,
                    item_id: Some(item),
                    target_id: None,
                    edge_id: edge,
                    namespace: None,
                    tag: None,
                    blob: None,
                    base_version: Some(1),
                    payload: "{}",
                    depends_on: &[],
                },
            )
            .unwrap()
        };
        let first = queue(WriteKind::UpdateItem, "row", None);
        assert_eq!(first.follows, None);
        let written = queue(WriteKind::AddTag, "row", None);
        assert_eq!(written.follows.as_deref(), Some(first.id.as_str()));
        record_verdict(
            &conn,
            &written.id,
            &Answered {
                verdict: Verdict::Accepted,
                reason: None,
                answer: None,
                conflicted_copy_id: None,
            },
        )
        .unwrap();
        // An edge from the row, and a write to another row, between them.
        let edge = queue(WriteKind::UpdateEdge, "row", Some("link"));
        assert_eq!(edge.follows, None);
        queue(WriteKind::UpdateItem, "other", None);
        let delete = queue(WriteKind::DeleteItem, "row", None);
        assert_eq!(
            delete.follows.as_deref(),
            Some(first.id.as_str()),
            "the delete follows the written tag, an edge or another row rather than the edit ahead of it"
        );
        let next_edge = queue(WriteKind::DeleteEdge, "row", Some("link"));
        assert_eq!(next_edge.follows.as_deref(), Some(edge.id.as_str()));
        let upload = queue(WriteKind::UploadBlob, "row", None);
        assert_eq!(upload.follows, None);
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

/// Takes back every write to an edge that has not landed, for a folder giving
/// way to the placement the server holds (`folders.md` 19).
pub fn withdraw_edge_writes(conn: &Connection, edge_id: &str) -> Result<usize, CoreError> {
    Ok(conn.execute(
        "DELETE FROM queue
          WHERE edge_id = :edge
            AND (verdict IS NULL OR verdict IN (:blocked, :refused, :dead))",
        named_params! {
            ":edge": edge_id,
            ":blocked": Verdict::Blocked.as_str(),
            ":refused": Verdict::Refused.as_str(),
            ":dead": Verdict::Dead.as_str(),
        },
    )?)
}

/// Drops a row the server holds nothing for, with its pin.
///
/// What reconciling a refused create means (`queue-and-verdicts.md` 12): the
/// working copy minted the row locally and the server declined it, so there
/// is nothing to reconcile it to and leaving it would be the copy reporting
/// an item that exists nowhere.
pub fn forget_item(conn: &Connection, id: &str) -> Result<(), CoreError> {
    unpin(conn, id)?;
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
/// The row is indexed as the type it is laid over as, since a waiting retype
/// moves it to another.
pub fn lay_waiting_writes_over(
    conn: &Connection,
    item_id: &str,
    indexing: &dyn Fn(&str) -> Indexing,
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
                    // Only an edit that read the copy knows which properties
                    // it cleared; one said to be read earlier is laid over.
                    let read = match read_of(conn, &row.id)? {
                        Some(read) if replaces_properties(&payload) => {
                            serde_json::from_str::<Value>(&read)?
                                .get("properties")
                                .and_then(Value::as_object)
                                .cloned()
                        }
                        _ => None,
                    };
                    if let Some(read) = read {
                        lay_changes(&mut item.properties, properties, &read);
                    } else {
                        for (key, value) in properties {
                            item.properties.insert(key.clone(), value.clone());
                        }
                    }
                }
                if let Some(Value::String(key)) = payload.get("source_id") {
                    item.source_id = Some(key.clone());
                }
                if payload.get("retype") == Some(&Value::Bool(true))
                    && let Some(Value::String(r#type)) = payload.get("type")
                {
                    item.r#type = r#type.clone();
                }
                if let Some(tier) = payload.get("tier").and_then(Value::as_str) {
                    item.tier = Tier::parse_wire(Some(tier))?;
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
    upsert_item(conn, &item.as_wire(), Some(&tags), &indexing(&item.r#type))
}

/// The same for an edge: an edit still waiting is laid back over the
/// server's properties and ends, and a delete still waiting takes the edge
/// out again.
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
                if let Some(source) = payload.get("source_id").and_then(Value::as_str) {
                    edge.source_id = source.to_string();
                }
                if let Some(target) = payload.get("target_id").and_then(Value::as_str) {
                    edge.target_id = target.to_string();
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

/// Moves an edit behind an answer onto another version
/// (`queue-and-verdicts.md` 36, 42), and drops from its body every property
/// it carries at the value the copy held when it was made: no change of its
/// own, and sent on another version it would assert a value this device
/// read as newer than whatever another device wrote since. An edit whose
/// reading was never recorded is moved as it stands.
pub fn move_edit(
    conn: &Connection,
    id: &str,
    version: i64,
    onto: Option<&Map<String, Value>>,
) -> Result<(), CoreError> {
    if let Some(read) = read_of(conn, id)? {
        let read: Value = serde_json::from_str(&read)?;
        let mut body: Value = serde_json::from_str(&payload_of(conn, id)?)?;
        let whole = replaces_properties(&body);
        if let (Some(Value::Object(read)), Some(Value::Object(properties))) =
            (read.get("properties").cloned(), body.get_mut("properties"))
        {
            if !whole {
                properties.retain(|key, value| read.get(key) != Some(value));
            } else if let Some(onto) = onto {
                // Dropping one would clear it, so whole properties move as the
                // answer's with what the edit changed laid over.
                let mut moved = onto.clone();
                lay_changes(&mut moved, properties, &read);
                *properties = moved;
                // Made against the answer now, so a later move reads its
                // changes from there, not from what it first read.
                record_read(conn, id, &serde_json::json!({ "properties": onto }))?;
            }
        }
        conn.execute(
            "UPDATE queue SET payload = ?2 WHERE id = ?1",
            params![id, body.to_string()],
        )?;
    }
    rebase(conn, id, version)
}

/// Lays what a whole-properties edit changed from what it read over a row's
/// properties: a value it changed, a property it left out cleared, and every
/// other the row's own.
fn lay_changes(row: &mut Map<String, Value>, sent: &Map<String, Value>, read: &Map<String, Value>) {
    for (key, was) in read {
        match sent.get(key) {
            Some(value) if value != was => {
                row.insert(key.clone(), value.clone());
            }
            Some(_) => {}
            None => {
                row.shift_remove(key);
            }
        }
    }
    for (key, value) in sent {
        if !read.contains_key(key) {
            row.insert(key.clone(), value.clone());
        }
    }
}

/// Whether a queued update's body sends its properties whole.
pub fn replaces_properties(body: &Value) -> bool {
    body.get("properties_mode").and_then(Value::as_str) == Some("replace")
}

/// Makes a queued whole-properties update merge its properties instead.
pub fn merge_properties(conn: &Connection, id: &str) -> Result<(), CoreError> {
    let mut body: Value = serde_json::from_str(&payload_of(conn, id)?)?;
    if let Some(body) = body.as_object_mut()
        && body.shift_remove("properties_mode").is_some()
    {
        conn.execute(
            "UPDATE queue SET payload = ?2 WHERE id = ?1",
            params![id, Value::Object(body.clone()).to_string()],
        )?;
    }
    Ok(())
}

/// Moves a queued write onto another version (`queue-and-verdicts.md` 36,
/// 42). The payload and the column both move, so the queue reports what was
/// sent.
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

/// The edits of `subject` waiting behind `answered`, a create or an edit of
/// the same row or edge, with the version each is based on, in the order they
/// were queued: the ones an answer to it can move (`queue-and-verdicts.md`
/// 36, 42).
///
/// Only edits queued after it, because one queued before was made without
/// what it carried. Only edits never sent, because a sent body is fixed by
/// the key it went under (3) and a changed one is refused as that key reused.
/// And only edits still waiting: one the drain refused with what it waited on
/// (16, 39) goes nowhere unless a caller releases it (27).
pub fn edits_behind(
    conn: &Connection,
    answered: &QueuedWrite,
    subject: &str,
) -> Result<Vec<(String, Option<i64>)>, CoreError> {
    let Some((kind, column)) = answered
        .kind
        .edit()
        .and_then(|kind| Some((kind, kind.subject()?.column())))
    else {
        return Ok(Vec::new());
    };
    let mut statement = conn.prepare(&format!(
        "SELECT id, base_version FROM queue
          WHERE kind = ?1 AND {column} = ?2 AND sent = 0
            AND (verdict IS NULL OR verdict = ?3)
            AND seq > (SELECT seq FROM queue WHERE id = ?4)
          ORDER BY seq"
    ))?;
    let behind = statement
        .query_map(
            params![
                kind.as_str(),
                subject,
                Verdict::Blocked.as_str(),
                answered.id
            ],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?
        .collect::<Result<_, _>>()?;
    Ok(behind)
}

/// Records what the copy held, for each property an edit carries, when the
/// edit was made: what the edit was made against (`queue-and-verdicts.md`
/// 42).
pub fn record_read(conn: &Connection, id: &str, read: &Value) -> Result<(), CoreError> {
    conn.execute(
        "UPDATE queue SET read = ?2 WHERE id = ?1",
        params![id, read.to_string()],
    )?;
    Ok(())
}

/// What an edit was made against, where it was recorded.
pub fn read_of(conn: &Connection, id: &str) -> Result<Option<String>, CoreError> {
    Ok(conn
        .query_row("SELECT read FROM queue WHERE id = ?1", [id], |row| {
            row.get::<_, Option<String>>(0)
        })
        .optional()?
        .flatten())
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

/// The create of this edge while the server has not taken it: unanswered, or
/// blocked, for the reason `untaken_creates_for_item` gives. The only write
/// an edit or a delete of the edge cannot go without; the writes to it ahead
/// of one order it and do not refuse it (`queue-and-verdicts.md` 42).
pub fn untaken_create_for_edge(conn: &Connection, edge_id: &str) -> Result<Vec<String>, CoreError> {
    Ok(waiting_writes_for_edge(conn, edge_id)?
        .into_iter()
        .filter(|row| row.kind == WriteKind::CreateEdge)
        .map(|row| row.id)
        .collect())
}
