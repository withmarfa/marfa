use std::collections::{HashMap, HashSet};
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
use crate::wire::{WireCatalog, WireEdge, WireItem, WireType};

pub const SCHEMA: &str = include_str!("schema.sql");

pub const META_SCHEMA_VERSION: &str = "schema_version";
pub const META_SERVER_ORIGIN: &str = "server_origin";
pub const META_SLICE_TYPES: &str = "slice_types";
pub const META_SLICE_TIER: &str = "slice_tier";
pub const META_SLICE_EDGE_TYPES: &str = "slice_edge_types";
pub const META_EVENT_CURSOR: &str = "event_cursor";
/// The instance the copy was hydrated from, as the server's root names it.
pub const META_INSTANCE_ID: &str = "instance_id";
pub const META_HYDRATE_STATE: &str = "hydrate_state";
/// Absent until a catalog is first held, which is how a copy that has never
/// held one is told from an instance with no types.
pub const META_CATALOG_VERSION: &str = "catalog_version";
pub const HYDRATE_IN_PROGRESS: &str = "in_progress";
pub const SCHEMA_VERSION: &str = "0";

const META_TABLE: &str =
    "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);";

const ITEM_COLUMNS: &str = "id, type, state, tier, version, schema_version, source, source_id, occurred_at, created_at, updated_at, properties";
const EDGE_COLUMNS: &str =
    "id, source_id, target_id, edge_type, properties, version, created_at, updated_at";

pub fn open(path: &Path) -> Result<Connection, CoreError> {
    let conn = Connection::open(path)?;
    // The store may have been named by an environment variable rather than
    // typed, so the refusal names its path.
    prepare(&conn).map_err(|error| at_path(error, path))?;
    Ok(conn)
}

fn at_path(error: CoreError, path: &Path) -> CoreError {
    match error {
        CoreError::WrongSchema { reason, unsent, .. } => CoreError::WrongSchema {
            path: path.display().to_string(),
            reason,
            unsent,
        },
        other => other,
    }
}

/// Opens another process's store to read: makes no store and applies no
/// schema. Read-only in SQLite rather than by promise, because a read-write
/// connection that closes last checkpoints the writer's journal into the file.
/// SQLite may still create the WAL's two side files, which a WAL reader needs.
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
    let no_schema = || {
        CoreError::Invalid(format!(
            "{} is not a store: it has no schema to read",
            path.display()
        ))
    };
    let held = held_shape(&conn).map_err(|error| match &error {
        rusqlite::Error::SqliteFailure(_, Some(message))
            if message.contains("file is not a database") =>
        {
            no_schema()
        }
        _ => CoreError::from(error),
    })?;
    if !held.contains_key("meta") {
        return Err(no_schema());
    }
    refuse_misshapen(&conn, &held, true).map_err(|error| at_path(error, path))?;
    Ok(conn)
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
    conn.execute_batch(META_TABLE)?;
    // Before the schema is applied: `CREATE TABLE IF NOT EXISTS` is silent
    // about a table that exists with other columns. A store of another shape
    // is refused, never discarded, because it may hold writes the server has
    // never seen.
    refuse_misshapen(conn, &held_shape(conn)?, false)?;
    conn.execute_batch(SCHEMA)?;
    // Only when absent: writing it on every open would make a reading command
    // take a write lock.
    if meta_get(conn, META_SCHEMA_VERSION)?.is_none() {
        meta_set(conn, META_SCHEMA_VERSION, SCHEMA_VERSION)?;
    }
    Ok(())
}

/// Each table's statement as SQLite recorded it, keyed by table.
type Shape = HashMap<String, String>;

/// Without comments or whitespace, so a comment or a line break in
/// `schema.sql` is no change of shape. SQLite records a table's statement as
/// it was written, comments inside its parentheses included.
fn statement(sql: &str) -> String {
    sql.lines()
        .flat_map(|line| line.split("--").next().unwrap_or_default().chars())
        .filter(|character| !character.is_whitespace())
        .collect()
}

fn held_shape(conn: &Connection) -> rusqlite::Result<Shape> {
    let mut query = conn
        .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND sql IS NOT NULL")?;
    let rows = query.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            statement(&row.get::<_, String>(1)?),
        ))
    })?;
    rows.collect()
}

/// The shape this build makes, read from SQLite rather than from the file so
/// it is compared as SQLite records it.
fn built_shape() -> Result<&'static Shape, CoreError> {
    static BUILT: std::sync::OnceLock<Shape> = std::sync::OnceLock::new();
    if let Some(built) = BUILT.get() {
        return Ok(built);
    }
    let conn = Connection::open_in_memory()?;
    conn.execute_batch(META_TABLE)?;
    conn.execute_batch(SCHEMA)?;
    let built = held_shape(&conn)?;
    Ok(BUILT.get_or_init(|| built))
}

/// The version stays put until the first public release, so it alone cannot
/// tell two builds' stores apart: every table the store holds is held to the
/// statement this build makes it with. A table it lacks is one a writer
/// creates on open, which a reader cannot.
fn refuse_misshapen(conn: &Connection, held: &Shape, reading: bool) -> Result<(), CoreError> {
    let built = built_shape()?;
    let differs = |name: &str| {
        held.get(name)
            .is_some_and(|statement| built.get(name) != Some(statement))
    };
    let refuse = |reason: String| {
        Err(CoreError::WrongSchema {
            path: String::new(),
            reason,
            unsent: untaken_count(conn),
        })
    };
    if differs("meta") {
        return refuse("its table meta is not the shape this build reads".into());
    }
    if held.contains_key("meta") {
        match meta_get(conn, META_SCHEMA_VERSION)? {
            Some(found) if found != SCHEMA_VERSION => {
                return refuse(format!(
                    "it was written by schema {found}, and this build reads schema {SCHEMA_VERSION}"
                ));
            }
            None if reading => return refuse("it names no schema version".into()),
            _ => {}
        }
    }
    let mut names: Vec<&String> = built.keys().collect();
    names.sort();
    if let Some(name) = names.iter().find(|name| differs(name)) {
        return refuse(format!(
            "its table {name} is not the shape this build reads"
        ));
    }
    // Not another build's store: one this build's writer completes on open.
    if reading && let Some(name) = names.iter().find(|name| !held.contains_key(name.as_str())) {
        return Err(CoreError::Invalid(format!(
            "this store has no table {name} yet, which this build's writer adds when it opens the store: open it once with this build's writer, then read it"
        )));
    }
    Ok(())
}

/// Every write the server has not taken that clearing answered writes would
/// keep: waiting, blocked, refused or dead. Read by clearing a copy of the
/// queue in the connection's own temporary space, so the count is what
/// `forget_answered` keeps and a reading connection can take it too. `None`
/// where a queue of another shape cannot be counted.
fn untaken_count(conn: &Connection) -> Option<u64> {
    let counted = (|| -> Result<i64, CoreError> {
        conn.execute_batch("CREATE TEMP TABLE queue AS SELECT * FROM main.queue")?;
        forget_answered(conn)?;
        Ok(conn.query_row(
            "SELECT COUNT(*) FROM temp.queue WHERE verdict IS NULL OR verdict NOT IN (?1, ?2, ?3)",
            [
                Verdict::Accepted.as_str(),
                Verdict::Merged.as_str(),
                Verdict::Conflicted.as_str(),
            ],
            |row| row.get(0),
        )?)
    })();
    let _ = conn.execute_batch("DROP TABLE IF EXISTS temp.queue");
    counted.ok().and_then(|count| u64::try_from(count).ok())
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

/// Says nothing about whether a hydration has ever run: a fresh store has no
/// in-progress marker either.
pub fn hydration_complete(conn: &Connection) -> Result<bool, CoreError> {
    Ok(meta_get(conn, META_HYDRATE_STATE)?.as_deref() != Some(HYDRATE_IN_PROGRESS))
}

/// False where the event cursor has gone: catch-up deletes it when the log
/// has aged past it, and such a store cannot be kept current.
pub fn hydrated(conn: &Connection) -> Result<bool, CoreError> {
    if !hydration_complete(conn)? {
        return Ok(false);
    }
    if meta_get(conn, META_EVENT_CURSOR)?.is_none() {
        return Ok(false);
    }
    holds_slice(conn)
}

pub fn holds_slice(conn: &Connection) -> Result<bool, CoreError> {
    Ok(slice(conn)?.is_some_and(|(types, _)| !types.is_empty()))
}

/// Pinned rows count, even in a copy that has never hydrated.
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

pub const EVERY_TYPE: &str = "*";

/// `EVERY_TYPE` takes what a bare server listing answers, which leaves out
/// `system.*`.
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

pub fn slice(conn: &Connection) -> Result<Option<(Vec<String>, Tier)>, CoreError> {
    let Some(tier) = meta_get(conn, META_SLICE_TIER)? else {
        return Ok(None);
    };
    let Some(types) = meta_get(conn, META_SLICE_TYPES)? else {
        return Ok(None);
    };
    Ok(Some((serde_json::from_str(&types)?, tier.parse()?)))
}

pub fn refuse_unless_hydrated(conn: &Connection) -> Result<(), CoreError> {
    if hydrated(conn)? {
        Ok(())
    } else {
        Err(CoreError::HydrationIncomplete)
    }
}

/// Where a row or an edge stands in the order the server writes it: the
/// version, then the modification time. The version moves only on a write to
/// the fields, so a transition, a delete, a restore and a tag write share it
/// with the row before them; the time the server stamps on every write, and
/// never moves back, orders those.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stamp {
    pub version: i64,
    pub updated_at: String,
}

impl Stamp {
    /// A time either side cannot read leaves the version alone to order
    /// them, so an equal version is never later.
    pub fn later_than(&self, other: &Stamp) -> bool {
        if self.version != other.version {
            return self.version > other.version;
        }
        match (instant_of(&self.updated_at), instant_of(&other.updated_at)) {
            (Some(held), Some(other)) => held > other,
            _ => false,
        }
    }
}

pub fn stamp(conn: &Connection, subject: Subject, id: &str) -> Result<Option<Stamp>, CoreError> {
    let table = match subject {
        Subject::Item => "items",
        Subject::Edge => "edges",
    };
    Ok(conn
        .query_row(
            &format!("SELECT version, updated_at FROM {table} WHERE id = ?1"),
            [id],
            |row| {
                Ok(Stamp {
                    version: row.get(0)?,
                    updated_at: row.get(1)?,
                })
            },
        )
        .optional()?)
}

/// Whether the copy holds `id` at a stamp later than the one given.
pub fn holds_later(
    conn: &Connection,
    subject: Subject,
    id: &str,
    version: i64,
    updated_at: &str,
) -> Result<bool, CoreError> {
    let other = Stamp {
        version,
        updated_at: updated_at.to_string(),
    };
    Ok(stamp(conn, subject, id)?.is_some_and(|held| held.later_than(&other)))
}

/// Nanoseconds since the epoch, from an RFC 3339 time with any fraction of a
/// second and a `Z` or numeric offset. `None` for anything else.
pub fn instant_of(stamp: &str) -> Option<i128> {
    let bytes = stamp.as_bytes();
    if bytes.len() < 20
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || !matches!(bytes[10], b'T' | b't')
        || bytes[13] != b':'
        || bytes[16] != b':'
    {
        return None;
    }
    let number = |from: usize, to: usize| -> Option<i64> {
        let digits = stamp.get(from..to)?;
        if !digits.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        digits.parse().ok()
    };
    let (year, month, day) = (number(0, 4)?, number(5, 7)?, number(8, 10)?);
    let (hour, minute, second) = (number(11, 13)?, number(14, 16)?, number(17, 19)?);
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 60
    {
        return None;
    }
    let mut at = 19;
    let mut nanos: i128 = 0;
    if bytes.get(at) == Some(&b'.') {
        at += 1;
        let start = at;
        while bytes.get(at).is_some_and(u8::is_ascii_digit) {
            at += 1;
        }
        let digits = stamp.get(start..at)?;
        if digits.is_empty() {
            return None;
        }
        let kept = &digits[..digits.len().min(9)];
        nanos = kept.parse::<i128>().ok()? * 10_i128.pow(9 - kept.len() as u32);
    }
    let offset: i64 = match stamp.get(at..)? {
        "Z" | "z" => 0,
        zone if zone.len() == 6
            && matches!(zone.as_bytes()[0], b'+' | b'-')
            && zone.as_bytes()[3] == b':' =>
        {
            let hours = number(at + 1, at + 3)?;
            let minutes = number(at + 4, at + 6)?;
            let sign = if zone.starts_with('-') { -1 } else { 1 };
            sign * (hours * 3_600 + minutes * 60)
        }
        _ => return None,
    };
    // Days since the epoch, by the days-from-civil algorithm.
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let day_of_year = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days = era * 146_097 + day_of_era - 719_468;
    let seconds = days * 86_400 + hour * 3_600 + minute * 60 + second - offset;
    Some(i128::from(seconds) * 1_000_000_000 + nanos)
}

/// The one way a server's row comes into the copy, whatever brought it: a
/// write's answer, a read-back, a landed create, a pin, an event or a
/// hydration. Refused where the copy holds the row at a later stamp, which a
/// follow on the same core can have brought while the row was being read;
/// answers whether it wrote. Either way the copy now holds a row the server
/// wrote, so a read-back owed for it is settled.
pub fn put_server_item(
    conn: &Connection,
    item: &WireItem,
    tags: Option<&[String]>,
    indexing: &Indexing,
) -> Result<bool, CoreError> {
    settle_read_back(conn, Subject::Item, &item.id)?;
    if holds_later(
        conn,
        Subject::Item,
        &item.id,
        item.version,
        &item.updated_at,
    )? {
        return Ok(false);
    }
    let beneath_tags = match tags {
        Some(tags) => Some(tags.to_vec()),
        None => beneath_item(conn, &item.id)?.map(|held| held.tags),
    };
    upsert_item(conn, item, tags, indexing)?;
    keep_beneath_item(conn, &item.id, beneath_tags)?;
    Ok(true)
}

/// `put_server_item` for an edge.
pub fn put_server_edge(conn: &Connection, edge: &WireEdge) -> Result<bool, CoreError> {
    settle_read_back(conn, Subject::Edge, &edge.id)?;
    if holds_later(
        conn,
        Subject::Edge,
        &edge.id,
        edge.version,
        &edge.updated_at,
    )? {
        return Ok(false);
    }
    upsert_edge(conn, edge)?;
    if edge_write_waits(conn, &edge.id)?
        && let Some(held) = edge_by_id(conn, &edge.id)?
    {
        set_beneath(
            conn,
            Subject::Edge,
            &edge.id,
            &serde_json::to_string(&held)?,
        )?;
    } else {
        drop_beneath(conn, Subject::Edge, &edge.id)?;
    }
    Ok(true)
}

fn subject_name(subject: Subject) -> &'static str {
    match subject {
        Subject::Item => "item",
        Subject::Edge => "edge",
    }
}

fn set_beneath(conn: &Connection, subject: Subject, id: &str, row: &str) -> Result<(), CoreError> {
    conn.execute(
        "INSERT INTO beneath (subject, id, row) VALUES (?1, ?2, ?3)
         ON CONFLICT (subject, id) DO UPDATE SET row = excluded.row",
        params![subject_name(subject), id, row],
    )?;
    Ok(())
}

fn drop_beneath(conn: &Connection, subject: Subject, id: &str) -> Result<(), CoreError> {
    conn.execute(
        "DELETE FROM beneath WHERE subject = ?1 AND id = ?2",
        params![subject_name(subject), id],
    )?;
    Ok(())
}

fn beneath_row(conn: &Connection, subject: Subject, id: &str) -> Result<Option<String>, CoreError> {
    Ok(conn
        .query_row(
            "SELECT row FROM beneath WHERE subject = ?1 AND id = ?2",
            params![subject_name(subject), id],
            |row| row.get(0),
        )
        .optional()?)
}

pub fn beneath_item(conn: &Connection, id: &str) -> Result<Option<Item>, CoreError> {
    match beneath_row(conn, Subject::Item, id)? {
        Some(row) => Ok(Some(serde_json::from_str(&row)?)),
        None => Ok(None),
    }
}

pub fn beneath_edge(conn: &Connection, id: &str) -> Result<Option<Edge>, CoreError> {
    match beneath_row(conn, Subject::Edge, id)? {
        Some(row) => Ok(Some(serde_json::from_str::<Edge>(&row)?)),
        None => Ok(None),
    }
}

/// Keeps the row the copy holds as the one beneath its waiting writes, with
/// `tags` where the copy's own may carry a waiting tag write, or lets it go
/// where none waits. Call only while the copy holds the server's row as
/// written, before anything is laid over it.
fn keep_beneath_item(
    conn: &Connection,
    id: &str,
    tags: Option<Vec<String>>,
) -> Result<(), CoreError> {
    if !row_writes_wait(conn, id)? {
        return drop_beneath(conn, Subject::Item, id);
    }
    let Some(mut held) = items_by_ids(conn, std::slice::from_ref(&id.to_string()))?.pop() else {
        return drop_beneath(conn, Subject::Item, id);
    };
    if let Some(tags) = tags {
        held.tags = tags;
    }
    set_beneath(conn, Subject::Item, id, &serde_json::to_string(&held)?)
}

/// Before a local write changes a row: the row as the copy holds it is what
/// the server holds, unless writes already wait on it, which have kept what
/// is beneath them, or it is this device's own create the server has not
/// taken, which has nothing beneath it.
pub fn hold_beneath_item(conn: &Connection, id: &str) -> Result<(), CoreError> {
    if beneath_row(conn, Subject::Item, id)?.is_some()
        || !untaken_creates_for_item(conn, id)?.is_empty()
    {
        return Ok(());
    }
    if let Some(held) = items_by_ids(conn, std::slice::from_ref(&id.to_string()))?.pop() {
        set_beneath(conn, Subject::Item, id, &serde_json::to_string(&held)?)?;
    }
    Ok(())
}

/// `hold_beneath_item` for an edge.
pub fn hold_beneath_edge(conn: &Connection, id: &str) -> Result<(), CoreError> {
    if beneath_row(conn, Subject::Edge, id)?.is_some()
        || !untaken_create_for_edge(conn, id)?.is_empty()
    {
        return Ok(());
    }
    if let Some(held) = edge_by_id(conn, id)? {
        set_beneath(conn, Subject::Edge, id, &serde_json::to_string(&held)?)?;
    }
    Ok(())
}

/// A refused write's subject the copy owes a read of the server's row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Owed {
    pub subject: Subject,
    pub id: String,
    /// An edge's source, whose listing of the edge's type it is read from.
    pub source_id: Option<String>,
    pub edge_type: Option<String>,
    /// The refused write moved the row, so a read outside the slice lets it go.
    pub moved: bool,
}

/// What a read-back of `row` reads, or `None` where it names nothing the
/// copy holds a row for.
pub fn owed_of(conn: &Connection, row: &QueuedWrite) -> Result<Option<Owed>, CoreError> {
    match row.kind.subject() {
        Some(Subject::Item) => Ok(row.item_id.as_ref().map(|id| Owed {
            subject: Subject::Item,
            id: id.clone(),
            source_id: None,
            edge_type: None,
            moved: row.kind == WriteKind::UpdateItem && moves(&row.body),
        })),
        Some(Subject::Edge) => {
            let (Some(source), Some(id)) = (row.item_id.as_ref(), row.edge_id.as_ref()) else {
                return Ok(None);
            };
            // A delete emptied the copy at queue time, so the type can come
            // only from the payload.
            let edge_type = match edge_by_id(conn, id)? {
                Some(edge) => Some(edge.edge_type),
                None => row
                    .body
                    .get("edge_type")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            };
            Ok(Some(Owed {
                subject: Subject::Edge,
                id: id.clone(),
                source_id: Some(source.clone()),
                edge_type,
                moved: false,
            }))
        }
        None => Ok(None),
    }
}

/// An update that moves the row to another type or tier.
pub fn moves(body: &Value) -> bool {
    body.get("retype") == Some(&Value::Bool(true)) || body.get("tier").is_some()
}

pub fn owe_read_back(conn: &Connection, owed: &Owed) -> Result<(), CoreError> {
    conn.execute(
        "INSERT INTO read_backs (subject, id, source_id, edge_type, moved)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (subject, id) DO UPDATE SET
           source_id = coalesce(excluded.source_id, source_id),
           edge_type = coalesce(excluded.edge_type, edge_type),
           moved = moved OR excluded.moved",
        params![
            subject_name(owed.subject),
            owed.id,
            owed.source_id,
            owed.edge_type,
            owed.moved
        ],
    )?;
    Ok(())
}

pub fn owed_read_backs(conn: &Connection) -> Result<Vec<Owed>, CoreError> {
    let mut statement = conn.prepare(
        "SELECT subject, id, source_id, edge_type, moved FROM read_backs ORDER BY subject, id",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            Owed {
                subject: Subject::Item,
                id: row.get(1)?,
                source_id: row.get(2)?,
                edge_type: row.get(3)?,
                moved: row.get(4)?,
            },
        ))
    })?;
    let mut owed = Vec::new();
    for row in rows {
        let (subject, mut entry) = row?;
        entry.subject = if subject == "edge" {
            Subject::Edge
        } else {
            Subject::Item
        };
        owed.push(entry);
    }
    Ok(owed)
}

pub fn settle_read_back(conn: &Connection, subject: Subject, id: &str) -> Result<(), CoreError> {
    conn.execute(
        "DELETE FROM read_backs WHERE subject = ?1 AND id = ?2",
        params![subject_name(subject), id],
    )?;
    Ok(())
}

pub fn held_version(conn: &Connection, id: &str) -> Result<Option<i64>, CoreError> {
    Ok(conn
        .query_row("SELECT version FROM items WHERE id = ?1", [id], |row| {
            row.get(0)
        })
        .optional()?)
}

const QUEUE_COLUMNS: &str = "id, kind, item_id, target_id, edge_id, namespace, tag, \
     base_version, idempotency_key, depends_on, verdict, reason, answer, \
     conflicted_copy_id, refusals, queued_at, answered_at, blob, follows, payload";

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

/// The idempotency key is minted here, not at send: a key minted per send
/// would let a retry of a write whose answer was lost write it twice.
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
    // A create carrying this row's natural key lands on this row, so it is a
    // write to it too.
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

/// The last write queued to `named` that the server has not written. A
/// refused one counts: one the drain refused unsent can still be released.
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

/// Orders a create carrying a held row's natural key behind that row's last
/// unwritten write, since the server lands the create on that row.
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

/// Rebuilds `follows` for the writes to `item_id` in queue order, for a row
/// a landed create's writes were just moved onto. `answered` is that create,
/// which orders nothing.
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

pub fn queued_write(conn: &Connection, id: &str) -> Result<Option<QueuedWrite>, CoreError> {
    Ok(read_writes(conn, "WHERE id = ?1", [id])?.pop())
}

/// A blocked create counts: a write sent past one is refused
/// `item_not_found`, and the reconcile that follows forgets the row.
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

pub fn queued_writes(conn: &Connection) -> Result<Vec<QueuedWrite>, CoreError> {
    read_writes(conn, "", [])
}

pub fn waiting_writes(conn: &Connection) -> Result<Vec<QueuedWrite>, CoreError> {
    read_writes(
        conn,
        "WHERE verdict IS NULL OR verdict IN (?1, ?2)",
        [Verdict::Blocked.as_str(), Verdict::Dead.as_str()],
    )
}

pub fn unsent_uploads(conn: &Connection) -> Result<HashSet<String>, CoreError> {
    let mut statement = conn.prepare(
        "SELECT DISTINCT blob FROM queue
          WHERE kind = ?1 AND blob IS NOT NULL
            AND (verdict IS NULL OR verdict NOT IN (?2, ?3, ?4))",
    )?;
    let hashes = statement
        .query_map(
            [
                WriteKind::UploadBlob.as_str(),
                Verdict::Accepted.as_str(),
                Verdict::Merged.as_str(),
                Verdict::Conflicted.as_str(),
            ],
            |row| row.get::<_, String>(0),
        )?
        .collect::<Result<HashSet<_>, _>>()?;
    Ok(hashes)
}

/// Whether a write to the row itself waits, not an edge from it.
fn row_writes_wait(conn: &Connection, id: &str) -> Result<bool, CoreError> {
    Ok(waiting_writes_for_item(conn, id)?
        .iter()
        .any(|row| row.kind.subject() == Some(Subject::Item)))
}

pub fn item_waits(conn: &Connection, id: &str) -> Result<bool, CoreError> {
    Ok(!waiting_writes_for_item(conn, id)?.is_empty())
}

/// Through the index rather than the whole queue: this runs once per answer
/// and once per event.
pub fn waiting_writes_for_item(conn: &Connection, id: &str) -> Result<Vec<QueuedWrite>, CoreError> {
    read_writes(
        conn,
        "WHERE item_id = ?1 AND (verdict IS NULL OR verdict IN (?2, ?3))",
        [id, Verdict::Blocked.as_str(), Verdict::Dead.as_str()],
    )
}

pub fn edge_write_waits(conn: &Connection, id: &str) -> Result<bool, CoreError> {
    Ok(!waiting_writes_for_edge(conn, id)?.is_empty())
}

fn waiting_writes_for_edge(conn: &Connection, id: &str) -> Result<Vec<QueuedWrite>, CoreError> {
    read_writes(
        conn,
        "WHERE edge_id = ?1 AND (verdict IS NULL OR verdict IN (?2, ?3))",
        [id, Verdict::Blocked.as_str(), Verdict::Dead.as_str()],
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
    // Positional, in `QUEUE_COLUMNS` order: two columns of the same type
    // swapped here would read as valid data.
    //
    // Unreadable dependencies are a refusal, not none: none would tell a
    // drain that nothing holds the write.
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
            payload: row.get(19)?,
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
        let body = serde_json::from_str(&raw.payload).map_err(|error| {
            CoreError::Store(format!(
                "queued write {} carries a body this build cannot read ({error})",
                raw.id
            ))
        })?;
        let refusal =
            crate::model::Refusal::for_write(verdict, raw.reason.as_deref(), raw.answer.as_deref());
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
            refusal,
            body,
            conflicted_copy_id: raw.conflicted_copy_id,
            refusals: raw.refusals,
            queued_at: raw.queued_at,
            answered_at: raw.answered_at,
        });
    }
    Ok(writes)
}

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
    payload: String,
}

type TypeRow = (
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    String,
);

fn thumbnail_field_of(declared: &Map<String, Value>) -> Option<String> {
    declared
        .get("fields")?
        .as_object()?
        .iter()
        .find(|(_, field)| field.get("type").and_then(Value::as_str) == Some("thumbnail"))
        .map(|(name, _)| name.clone())
}

/// The one way a catalog the server answered is written: both catalogs and
/// a new catalog version where either changed or none was held, all or
/// nothing. A savepoint rather than a transaction, so it holds alone and
/// inside a hydration's. Answers whether the version moved.
pub fn replace_catalog(conn: &Connection, catalog: &WireCatalog) -> Result<bool, CoreError> {
    catalog_scope(conn, |conn| {
        let types = replace_types(conn, &catalog.types)?;
        let edge_types = replace_edge_types(conn, &catalog.edge_types)?;
        let held = catalog_version(conn)?;
        if !types && !edge_types && held.is_some() {
            return Ok(false);
        }
        let next = held.map_or(1, |version| version + 1);
        meta_set(conn, META_CATALOG_VERSION, &next.to_string())?;
        Ok(true)
    })
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
/// A change reindexes every held row. Answers whether it changed. Outside
/// tests, only `replace_catalog` calls it.
pub fn replace_types(conn: &Connection, types: &[WireType]) -> Result<bool, CoreError> {
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
            // The block whole, present or not: the nearest type that has one
            // gives a subtype all of its hints.
            if let Some(declared) = &entry.display_hints {
                let mut block = Map::new();
                if let Some(title) = &declared.title_field {
                    block.insert("title_field".into(), Value::String(title.clone()));
                }
                if let Some(body) = &declared.body_field {
                    block.insert("body_field".into(), Value::String(body.clone()));
                }
                json.insert("display_hints".into(), Value::Object(block));
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
        return Ok(false);
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
    reindex(conn)?;
    Ok(true)
}

/// Writes nothing where the catalog is unchanged, as `replace_types` does.
/// Answers whether it changed.
fn replace_edge_types(conn: &Connection, rows: &[Value]) -> Result<bool, CoreError> {
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

/// Each type as `(id, json)`, by id.
pub fn type_rows(conn: &Connection) -> Result<Vec<(String, String)>, CoreError> {
    rows_of(conn, "SELECT id, json FROM types ORDER BY id")
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
         DELETE FROM items_fts;
         DELETE FROM beneath;
         DELETE FROM read_backs;",
    )?;
    Ok(())
}

/// `tags` replaces the item's tags when given and leaves them alone when not.
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

/// Moves everything the copy says about the minted id `local` onto
/// `answered`, the id the server answered its create with: a create carrying
/// a natural key the server holds lands on that row.
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
    drop_beneath(conn, Subject::Item, local)?;
    settle_read_back(conn, Subject::Item, local)?;
    // The writes just moved onto `answered` wait on the row as the copy
    // holds it now, which nothing has laid them over yet.
    if beneath_row(conn, Subject::Item, answered)?.is_none() {
        keep_beneath_item(conn, answered, None)?;
    }
    // An edge create carries its endpoints in its payload too.
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

/// Moves the copy onto `answered`, the held row a refused create's natural
/// key resolved, and returns the dependent writes it refused. Only writes
/// that add (a tag, an edge) carry over: any other was made against this
/// device's row and would act on another device's.
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
            // Its row is the minted one, which goes below: there is nothing
            // of the server's to read back.
            record_refusal(conn, &row, &reason, None, false)?;
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

/// Marks the files bound to `item_id` as holding bytes no row has, read at
/// `version`, unless an update later than `edit` is queued: the file then
/// holds that one's bytes and waits on its answer.
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

/// Blocks every unanswered create naming `source` under `credential_refused`
/// and returns their ids: each carries the same credential and would be
/// refused the same way.
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

pub fn purge_item(conn: &Connection, id: &str) -> Result<bool, CoreError> {
    let unpinned = unpin(conn, id)?;
    let removed = remove_item(conn, id, "source_id = ?1 OR target_id = ?1", &[])?;
    Ok(removed || unpinned)
}

/// Keeps the edges of a type in `whole`, and edges drawn to the item, as a
/// hydration holds them.
pub fn evict_item(conn: &Connection, id: &str, whole: &[String]) -> Result<bool, CoreError> {
    let kept = vec!["?"; whole.len()].join(", ");
    let edges = if whole.is_empty() {
        "source_id = ?1".to_string()
    } else {
        format!("source_id = ?1 AND edge_type NOT IN ({kept})")
    };
    remove_item(conn, id, &edges, whole)
}

/// The one way a row leaves the copy, with the edges `edges` names (a
/// condition on `edges`, `?1` the row's id, then `kept`): what is kept
/// beneath them and any read-back owed for them go too, so a refusal cannot
/// put back what the copy let go of. Whether the copy changed: a purge of an
/// item already evicted still takes the edges held items drew to it.
fn remove_item(
    conn: &Connection,
    id: &str,
    edges: &str,
    kept: &[String],
) -> Result<bool, CoreError> {
    drop_beneath(conn, Subject::Item, id)?;
    settle_read_back(conn, Subject::Item, id)?;
    conn.execute(
        "DELETE FROM items_fts WHERE rowid IN (SELECT seq FROM items WHERE id = ?1)",
        [id],
    )?;
    conn.execute("DELETE FROM tags WHERE item_id = ?1", [id])?;
    // An edge hidden behind this device's own waiting delete is in
    // `beneath` alone, and leaves with the row all the same. An edge still in
    // `edges` is matched by its ends there, which a waiting write may have
    // moved, never by the ones `beneath` recorded.
    let leaving: Vec<String> = conn
        .prepare(&format!(
            "SELECT id FROM (
               SELECT id, source_id, target_id, edge_type FROM edges
               UNION
               SELECT id, json_extract(row, '$.source_id') AS source_id,
                      json_extract(row, '$.target_id') AS target_id,
                      json_extract(row, '$.edge_type') AS edge_type
                 FROM beneath
                WHERE subject = 'edge' AND id NOT IN (SELECT id FROM edges)
             ) WHERE {edges}"
        ))?
        .query_map(
            params_from_iter(std::iter::once(id).chain(kept.iter().map(String::as_str))),
            |row| row.get(0),
        )?
        .collect::<Result<_, _>>()?;
    let mut changed = false;
    for edge in leaving {
        changed |= forget_edge(conn, &edge)?;
    }
    Ok(conn.execute("DELETE FROM items WHERE id = ?1", [id])? > 0 || changed)
}

pub fn whole_edge_types(conn: &Connection) -> Result<Vec<String>, CoreError> {
    match meta_get(conn, META_SLICE_EDGE_TYPES)? {
        Some(json) => Ok(serde_json::from_str(&json)?),
        None => Ok(Vec::new()),
    }
}

pub fn takes_edge(
    conn: &Connection,
    source_id: &str,
    edge_type: &str,
    whole: &[String],
) -> Result<bool, CoreError> {
    Ok(whole.iter().any(|held| held == edge_type) || item_held(conn, source_id)?)
}

/// Keeps an edge a waiting write of this device's is laid over.
pub fn let_go_of_untaken_edge(conn: &Connection, id: &str) -> Result<bool, CoreError> {
    let Some(edge) = edge_by_id(conn, id)? else {
        return Ok(false);
    };
    if takes_edge(
        conn,
        &edge.source_id,
        &edge.edge_type,
        &whole_edge_types(conn)?,
    )? || edge_write_waits(conn, id)?
    {
        return Ok(false);
    }
    forget_edge(conn, id)
}

/// Whether it was not pinned already.
pub fn pin(conn: &Connection, id: &str) -> Result<bool, CoreError> {
    Ok(conn.execute("INSERT OR IGNORE INTO pins (item_id) VALUES (?1)", [id])? > 0)
}

/// Whether it was pinned.
pub fn unpin(conn: &Connection, id: &str) -> Result<bool, CoreError> {
    Ok(conn.execute("DELETE FROM pins WHERE item_id = ?1", [id])? > 0)
}

pub fn pinned(conn: &Connection, id: &str) -> Result<bool, CoreError> {
    Ok(conn
        .query_row("SELECT 1 FROM pins WHERE item_id = ?1", [id], |_| Ok(()))
        .optional()?
        .is_some())
}

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

/// Takes the edge out of what the copy shows and nothing else: for a write
/// of this device's laid over it. An edge leaving the copy goes by
/// `forget_edge`.
pub fn delete_edge(conn: &Connection, id: &str) -> Result<bool, CoreError> {
    Ok(conn.execute("DELETE FROM edges WHERE id = ?1", [id])? > 0)
}

/// The one way an edge leaves the copy, with what is kept beneath it and any
/// read-back owed for it.
pub fn forget_edge(conn: &Connection, id: &str) -> Result<bool, CoreError> {
    drop_beneath(conn, Subject::Edge, id)?;
    settle_read_back(conn, Subject::Edge, id)?;
    delete_edge(conn, id)
}

/// Nothing for a trashed row, as the server answers a read by id.
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

pub fn edges_of_type(conn: &Connection, edge_type: &str) -> Result<Vec<Edge>, CoreError> {
    edges_at(conn, "edge_type", edge_type)
}

/// `column` is spliced into the query, so it is a literal, never a caller's text.
fn edges_at(conn: &Connection, column: &'static str, value: &str) -> Result<Vec<Edge>, CoreError> {
    let sql =
        format!("SELECT {EDGE_COLUMNS} FROM edges WHERE {column} = ?1 ORDER BY created_at, id");
    let mut statement = conn.prepare(&sql)?;
    let rows = statement.query_map([value], row_to_edge)?;
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

/// A thumbnail is never indexed, not even where a type names it the title.
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

/// Also fixed by the `refusals` `CHECK` in `schema.sql`. Raised above it,
/// SQLite refuses the write; lowered below it, nothing complains.
pub const CEILING: i64 = 5;

pub fn payload_of(conn: &Connection, id: &str) -> Result<String, CoreError> {
    conn.query_row("SELECT payload FROM queue WHERE id = ?1", [id], |row| {
        row.get(0)
    })
    .optional()?
    .ok_or_else(|| CoreError::Store(format!("queued write {id} has no payload")))
}

pub struct Answered<'a> {
    pub verdict: Verdict,
    pub reason: Option<&'a str>,
    pub answer: Option<&'a str>,
    pub conflicted_copy_id: Option<&'a str>,
}

pub fn mark_sent(conn: &Connection, id: &str) -> Result<(), CoreError> {
    conn.execute("UPDATE queue SET sent = 1 WHERE id = ?1", [id])?;
    Ok(())
}

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

pub fn block_unanswered(conn: &Connection, reason: BlockedReason) -> Result<usize, CoreError> {
    Ok(conn.execute(
        "UPDATE queue SET verdict = ?1, reason = ?2, answered_at = ?3
          WHERE verdict IS NULL",
        params![Verdict::Blocked.as_str(), reason.as_str(), now_iso()],
    )?)
}

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

/// The released row goes out under a fresh key; the spent one is kept so a
/// late answer under it is not taken for an answer to the new attempt.
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
    // A refused row is releasable only if it was never sent. `sent` is the
    // test, not `depends_on`: a row the server refused can carry a dependency
    // too, and releasing it would send it a second time.
    let verdict = verdict.as_deref().map(str::parse::<Verdict>).transpose()?;
    let refused_by_dependency = verdict == Some(Verdict::Refused) && !sent;
    if !matches!(verdict, Some(Verdict::Blocked | Verdict::Dead)) && !refused_by_dependency {
        return Ok(false);
    }
    // Released, a row whose dependency was withdrawn would wait for a write
    // the queue no longer holds, which a drain holds forever.
    if refused_by_dependency && waits_for_withdrawn(conn, id)? {
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
    // The writes refused because this one was go with it: no caller would
    // know to release them.
    for dependant in dependants_refused_with(conn, id)? {
        release(conn, &dependant)?;
    }
    Ok(true)
}

/// Read from `depends_on`, never the reason, which is prose.
fn dependants_refused_with(conn: &Connection, id: &str) -> Result<Vec<String>, CoreError> {
    Ok(queued_writes(conn)?
        .into_iter()
        .filter(|row| {
            row.verdict == Some(Verdict::Refused) && row.depends_on.iter().any(|held| held == id)
        })
        .map(|row| row.id)
        .collect())
}

/// Whether a row waits, itself or through rows refused unsent before it, for
/// one the queue no longer holds. Clearing keeps every row such a row waits
/// for, so a missing one was withdrawn.
fn waits_for_withdrawn(conn: &Connection, id: &str) -> Result<bool, CoreError> {
    Ok(conn.query_row(
        "WITH RECURSIVE chain(id) AS (
           SELECT ?1
           UNION
           SELECT named.value FROM queue, chain, json_each(queue.depends_on) AS named
            WHERE queue.id = chain.id AND queue.verdict = ?2 AND queue.sent = 0
         )
         SELECT EXISTS (SELECT 1 FROM chain WHERE id NOT IN (SELECT id FROM queue))",
        [id, Verdict::Refused.as_str()],
        |row| row.get(0),
    )?)
}

/// Transitive: a write two steps behind a withdrawn one can land no more than
/// the one between, and left unanswered it would wait on a row clearing may
/// take.
pub fn held_for(conn: &Connection, id: &str) -> Result<Vec<QueuedWrite>, CoreError> {
    read_writes(
        conn,
        "WHERE id IN (
           WITH RECURSIVE held(id) AS (
             SELECT ?1
             UNION
             SELECT waiting.id FROM queue AS waiting, held, json_each(waiting.depends_on) AS named
              WHERE named.value = held.id
                AND waiting.sent = 0 AND (waiting.verdict IS NULL OR waiting.verdict = ?2)
           )
           SELECT id FROM held WHERE id <> ?1
         )",
        [id, Verdict::Blocked.as_str()],
    )
}

/// Also refuses each of `held`, unsent, and puts the copy back as it was
/// beneath each. The caller has read their rows back already.
pub fn withdraw(
    conn: &Connection,
    row: &QueuedWrite,
    held: &[QueuedWrite],
) -> Result<(), CoreError> {
    let reason = format!("the {} it waits for was withdrawn", row.kind);
    for dependant in held {
        record_refusal(conn, dependant, &reason, None, false)?;
    }
    conn.execute("DELETE FROM queue WHERE id = ?1", [&row.id])?;
    put_back(conn, row)
}

/// Never clears a row `release` takes (blocked, dead, or refused unsent), nor
/// one an unanswered or releasable row depends on: written as a list of
/// verdicts instead, a release would leave a row waiting forever on a
/// dependency that is gone. Nor a refused row carrying content, which goes
/// only by `discard`. A row refused unsent behind a withdrawn write can never
/// be released and is cleared; passes repeat until one clears nothing, since
/// each can free what the last kept.
pub fn forget_answered(conn: &Connection) -> Result<usize, CoreError> {
    let mut cleared = 0;
    loop {
        let pass = forget_answered_once(conn)?;
        if pass == 0 {
            return Ok(cleared);
        }
        cleared += pass;
    }
}

fn forget_answered_once(conn: &Connection) -> Result<usize, CoreError> {
    let kept = content_kinds();
    // Kept while an unanswered or releasable row names it, which would
    // otherwise wait on a write no drain can find.
    let unreleasable = conn.execute(
        &format!(
            "DELETE FROM queue
          WHERE verdict = ?1 AND sent = 0 AND kind NOT IN ({kept})
            AND EXISTS (
              SELECT 1 FROM json_each(queue.depends_on) AS named
               WHERE named.value NOT IN (SELECT id FROM queue)
            )
            AND NOT EXISTS (
              SELECT 1 FROM queue AS waiting, json_each(waiting.depends_on) AS named
               WHERE named.value = queue.id
                 AND (waiting.verdict IS NULL OR waiting.verdict IN (?2, ?3))
            )"
        ),
        [
            Verdict::Refused.as_str(),
            Verdict::Blocked.as_str(),
            Verdict::Dead.as_str(),
        ],
    )?;
    Ok(unreleasable
        + conn.execute(
            &format!(
                "DELETE FROM queue
          WHERE verdict IN (:accepted, :merged, :conflicted, :refused)
            AND NOT (verdict = :refused AND sent = 0)
            AND NOT (verdict = :refused AND kind IN ({kept}))
            AND NOT EXISTS (
              SELECT 1 FROM queue AS waiting
               WHERE (waiting.verdict IS NULL
                      OR waiting.verdict IN (:blocked, :dead)
                      OR (waiting.verdict = :refused AND waiting.sent = 0))
                 AND waiting.depends_on LIKE '%' || queue.id || '%'
            )"
            ),
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

/// The kinds `carries_content` names, as an SQL list.
fn content_kinds() -> String {
    WriteKind::ALL
        .into_iter()
        .filter(|kind| kind.carries_content())
        .map(|kind| format!("'{}'", kind.as_str()))
        .collect::<Vec<_>>()
        .join(", ")
}

/// Takes a refused write out of the queue, the one way a refused write that
/// carried content leaves it. Answers `false` for a row not refused, or one a
/// write still waits on, which would then wait on nothing.
pub fn discard(conn: &Connection, id: &str) -> Result<bool, CoreError> {
    let Some(row) = queued_write(conn, id)? else {
        return Err(CoreError::NotFound {
            code: "queued_write_not_found".into(),
            message: format!("{id} is not a write this queue holds"),
        });
    };
    if row.verdict != Some(Verdict::Refused) || !held_for(conn, id)?.is_empty() {
        return Ok(false);
    }
    conn.execute("DELETE FROM queue WHERE id = ?1", [id])?;
    Ok(true)
}

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

pub fn forget_item(conn: &Connection, id: &str) -> Result<(), CoreError> {
    unpin(conn, id)?;
    forget_row(conn, id)
}

/// `forget_item`, keeping a pin.
fn forget_row(conn: &Connection, id: &str) -> Result<(), CoreError> {
    remove_item(conn, id, "source_id = ?1 OR target_id = ?1", &[])?;
    Ok(())
}

/// Call after anything puts the server's row into the copy. The row is
/// indexed as the type it is laid over as, since a waiting retype moves it.
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
        lay_write(conn, &mut item, &mut tags, &row)?;
    }
    tags.sort();
    upsert_item(conn, &item.as_wire(), Some(&tags), &indexing(&item.r#type))
}

fn lay_write(
    conn: &Connection,
    item: &mut Item,
    tags: &mut Vec<String>,
    row: &QueuedWrite,
) -> Result<(), CoreError> {
    let payload = &row.body;
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
        WriteKind::CreateItem => {
            let draft = crate::model::Draft::from_payload(&serde_json::to_string(payload)?)?;
            item.properties.extend(draft.properties);
            item.r#type = draft.r#type;
            if let Some(tier) = draft.tier {
                item.tier = Some(tier);
            }
            if let Some(source) = draft.source {
                item.source = source;
            }
            if let Some(source_id) = draft.source_id {
                item.source_id = Some(source_id);
            }
            if let Some(occurred_at) = draft.occurred_at {
                item.occurred_at = crate::time::projected(&occurred_at);
            }
        }
        WriteKind::UpdateItem => {
            if let Some(Value::Object(properties)) = payload.get("properties") {
                // Only an edit that read the copy knows which properties it
                // cleared; one said to be read earlier is laid over.
                let read = match read_of(conn, &row.id)? {
                    Some(read) if replaces_properties(payload) => {
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
                    let projected = if properties.values().any(Value::is_null) {
                        crate::catalog::Catalog::load(conn)?.projected_properties(
                            payload
                                .get("type")
                                .and_then(Value::as_str)
                                .unwrap_or(&item.r#type),
                            properties,
                            replaces_properties(payload),
                        )
                    } else {
                        properties.clone()
                    };
                    item.properties.extend(projected);
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
        WriteKind::ReplaceMetadata => *tags = named_tags(),
        WriteKind::CreateEdge
        | WriteKind::UpdateEdge
        | WriteKind::DeleteEdge
        | WriteKind::WriteExtension
        | WriteKind::DeleteExtension
        | WriteKind::UploadBlob => {}
    }
    Ok(())
}

/// The one way a refusal is recorded, whoever refused: the verdict, and the
/// copy put back at once to what was beneath the write, so it stops showing
/// what the server did not take even while the server cannot be read. With
/// `owe`, the copy owes a read of the server's row, which every drain tries
/// until it lands; a read the caller has already made, or a row only this
/// device ever held, owes none.
pub fn record_refusal(
    conn: &Connection,
    row: &QueuedWrite,
    reason: &str,
    answer: Option<&str>,
    owe: bool,
) -> Result<(), CoreError> {
    let owed = if owe { owed_of(conn, row)? } else { None };
    record_verdict(
        conn,
        &row.id,
        &Answered {
            verdict: Verdict::Refused,
            reason: Some(reason),
            answer,
            conflicted_copy_id: None,
        },
    )?;
    put_back(conn, row)?;
    if let Some(owed) = owed {
        owe_read_back(conn, &owed)?;
    }
    Ok(())
}

/// Puts the copy back as it was beneath `row`, which no longer waits: the
/// server's row as last taken, with every write still waiting laid back
/// over it. A create's row was only ever this device's, so it goes; its pin
/// stays until a read says whether the server holds the id.
pub fn put_back(conn: &Connection, row: &QueuedWrite) -> Result<(), CoreError> {
    match row.kind.subject() {
        Some(Subject::Item) => {
            let Some(id) = row.item_id.as_deref() else {
                return Ok(());
            };
            if row.kind == WriteKind::CreateItem {
                return forget_row(conn, id);
            }
            let catalog = crate::catalog::Catalog::load(conn)?;
            if let Some(held) = beneath_item(conn, id)?
                && item_held(conn, id)?
            {
                upsert_item(
                    conn,
                    &held.as_wire(),
                    Some(&held.tags),
                    &catalog.indexing(&held.r#type),
                )?;
            }
            lay_waiting_writes_over(conn, id, &|laid| catalog.indexing(laid))?;
            if !row_writes_wait(conn, id)? {
                drop_beneath(conn, Subject::Item, id)?;
            }
        }
        Some(Subject::Edge) => {
            let Some(id) = row.edge_id.as_deref() else {
                return Ok(());
            };
            if row.kind == WriteKind::CreateEdge {
                delete_edge(conn, id)?;
                return drop_beneath(conn, Subject::Edge, id);
            }
            if let Some(held) = beneath_edge(conn, id)? {
                upsert_edge(conn, &held.as_wire())?;
            }
            lay_waiting_edge_writes_over(conn, id)?;
            if !edge_write_waits(conn, id)? {
                drop_beneath(conn, Subject::Edge, id)?;
            }
            // Where the server moved it to a source the copy does not hold
            // while the refused write waited.
            let_go_of_untaken_edge(conn, id)?;
        }
        None => {}
    }
    Ok(())
}

/// An answer that carries no row says the server took `row` as sent, so the
/// row beneath the writes still waiting now holds it too: put back over a
/// later refusal, it would otherwise undo a write the server took.
pub fn fold_into_beneath(conn: &Connection, row: &QueuedWrite) -> Result<(), CoreError> {
    match row.kind.subject() {
        Some(Subject::Item) => {
            let Some(id) = row.item_id.as_deref() else {
                return Ok(());
            };
            if !row_writes_wait(conn, id)? {
                return drop_beneath(conn, Subject::Item, id);
            }
            if let Some(mut held) = beneath_item(conn, id)? {
                let mut tags = held.tags.clone();
                lay_write(conn, &mut held, &mut tags, row)?;
                tags.sort();
                held.tags = tags;
                set_beneath(conn, Subject::Item, id, &serde_json::to_string(&held)?)?;
            }
        }
        Some(Subject::Edge) => {
            if let Some(id) = row.edge_id.as_deref()
                && (row.kind == WriteKind::DeleteEdge || !edge_write_waits(conn, id)?)
            {
                drop_beneath(conn, Subject::Edge, id)?;
            }
        }
        None => {}
    }
    Ok(())
}

pub fn lay_waiting_edge_writes_over(conn: &Connection, edge_id: &str) -> Result<(), CoreError> {
    let waiting = waiting_writes_for_edge(conn, edge_id)?;
    let Some(mut edge) = edge_by_id(conn, edge_id)? else {
        return Ok(());
    };
    for row in waiting {
        match row.kind {
            WriteKind::CreateEdge => {
                let (_, draft) =
                    crate::model::EdgeDraft::from_payload(&payload_of(conn, &row.id)?)?;
                edge.source_id = draft.source_id;
                edge.target_id = draft.target_id;
                edge.edge_type = draft.edge_type;
                edge.properties.extend(draft.properties);
            }
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

/// Drops every property the edit carries unchanged from what it read: sent on
/// another version it would overwrite whatever another device wrote since.
/// An edit with no recorded read moves as it stands.
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
            Some(Value::Null) => {
                row.shift_remove(key);
            }
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
        if !read.contains_key(key) && !value.is_null() {
            row.insert(key.clone(), value.clone());
        }
    }
}

pub fn replaces_properties(body: &Value) -> bool {
    body.get("properties_mode").and_then(Value::as_str) == Some("replace")
}

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

/// The payload and the column both move, so the queue reports what was sent.
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

/// Only edits never sent: a sent body is fixed by the key it went under, and
/// a changed one is refused as that key reused.
pub fn edits_behind(
    conn: &Connection,
    answered: &QueuedWrite,
    subject: &str,
) -> Result<Vec<(String, Option<i64>)>, CoreError> {
    let Some(kind) = answered.kind.edit() else {
        return Ok(Vec::new());
    };
    unsent_writes_behind(conn, answered, subject, kind)
}

pub fn unsent_writes_behind(
    conn: &Connection,
    answered: &QueuedWrite,
    subject: &str,
    kind: WriteKind,
) -> Result<Vec<(String, Option<i64>)>, CoreError> {
    let Some(subject_kind) = kind.subject() else {
        return Ok(Vec::new());
    };
    let column = subject_kind.column();
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

pub fn record_read(conn: &Connection, id: &str, read: &Value) -> Result<(), CoreError> {
    conn.execute(
        "UPDATE queue SET read = ?2 WHERE id = ?1",
        params![id, read.to_string()],
    )?;
    Ok(())
}

pub fn read_of(conn: &Connection, id: &str) -> Result<Option<String>, CoreError> {
    Ok(conn
        .query_row("SELECT read FROM queue WHERE id = ?1", [id], |row| {
            row.get::<_, Option<String>>(0)
        })
        .optional()?
        .flatten())
}

pub fn add_tags(conn: &Connection, item_id: &str, tags: &[String]) -> Result<(), CoreError> {
    for tag in tags {
        conn.execute(
            "INSERT OR IGNORE INTO tags (item_id, tag) VALUES (?1, ?2)",
            params![item_id, tag],
        )?;
    }
    Ok(())
}

pub fn remove_tag(conn: &Connection, item_id: &str, tag: &str) -> Result<(), CoreError> {
    conn.execute(
        "DELETE FROM tags WHERE item_id = ?1 AND tag = ?2",
        params![item_id, tag],
    )?;
    Ok(())
}

pub fn replace_tags(conn: &Connection, item_id: &str, tags: &[String]) -> Result<(), CoreError> {
    conn.execute("DELETE FROM tags WHERE item_id = ?1", [item_id])?;
    add_tags(conn, item_id, tags)
}

/// The version and the time are the server's, untouched: a row the server
/// writes after this is ordered against them (`Stamp`).
pub fn set_item_state(conn: &Connection, id: &str, state: ItemState) -> Result<bool, CoreError> {
    let changed = conn.execute(
        "UPDATE items SET state = ?2 WHERE id = ?1",
        params![id, state.as_str()],
    )?;
    if changed > 0 && state == ItemState::Trashed {
        // A trashed row is out of the local index, as in `index_row`.
        conn.execute(
            "DELETE FROM items_fts WHERE rowid IN (SELECT seq FROM items WHERE id = ?1)",
            [id],
        )?;
    }
    Ok(changed > 0)
}

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

/// The only write an edit or a delete of the edge cannot go without; the
/// writes ahead of one only order it.
pub fn untaken_create_for_edge(conn: &Connection, edge_id: &str) -> Result<Vec<String>, CoreError> {
    Ok(waiting_writes_for_edge(conn, edge_id)?
        .into_iter()
        .filter(|row| row.kind == WriteKind::CreateEdge)
        .map(|row| row.id)
        .collect())
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

    /// The hash names this schema's statements as they are.
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

    /// Every value distinct: the helpers repeat a timestamp, which would hide
    /// a positional read shifted by one.
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
        assert!(purge_item(&conn, "n1").unwrap());
        assert!(edges_from(&conn, "n2").unwrap().is_empty());
    }

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
        assert_eq!(body, "T\nx\ny");
    }

    #[test]
    fn meta_and_the_hydration_guard() {
        let conn = conn();
        assert_eq!(
            meta_get(&conn, META_SCHEMA_VERSION).unwrap().as_deref(),
            Some(SCHEMA_VERSION)
        );
        assert_eq!(
            refuse_unless_hydrated(&conn),
            Err(CoreError::HydrationIncomplete)
        );
        meta_set(&conn, META_EVENT_CURSOR, "10").unwrap();
        meta_set(&conn, META_SLICE_TYPES, "[\"core.note\"]").unwrap();
        meta_set(&conn, META_SLICE_TIER, "library").unwrap();
        assert!(refuse_unless_hydrated(&conn).is_ok());

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
        row("plain", "accepted", 1, "[]");
        row("unsent", "refused", 0, "[]");
        row("dependency", "refused", 1, "[]");
        row("dependant", "blocked", 1, "[\"dependency\"]");
        row("kept-for-unsent", "accepted", 1, "[]");
        row("unsent-waiter", "refused", 0, "[\"kept-for-unsent\"]");
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
        assert_eq!(
            cleared, 3,
            "nothing was cleared, so the queue grows without bound and every \
             later write reads a longer one"
        );
    }

    #[test]
    fn a_withdraw_refuses_the_chain_behind_it_and_clearing_takes_all_of_it() {
        let conn = conn();
        // Deletes, which carry nothing a clearing could lose.
        let row = |id: &str, verdict: Option<&str>, sent: i64, depends: &str| {
            conn.execute(
                "INSERT INTO queue (id, kind, idempotency_key, payload, verdict, reason, sent, depends_on, queued_at)
                 VALUES (?1, 'delete_item', ?1, '{}', ?2, ?3, ?4, ?5, '2026-01-01T00:00:00Z')",
                params![
                    id,
                    verdict,
                    verdict.map(|_| "conflict_unresolved"),
                    sent,
                    depends
                ],
            )
            .unwrap();
        };
        row("stuck", Some("blocked"), 1, "[]");
        row("next", None, 0, "[\"stuck\"]");
        row("after-next", None, 0, "[\"next\"]");
        let ids = |rows: Vec<QueuedWrite>| rows.into_iter().map(|r| r.id).collect::<Vec<_>>();
        let held = held_for(&conn, "stuck").unwrap();
        assert_eq!(
            ids(held.clone()),
            vec!["next".to_string(), "after-next".to_string()],
            "the write two steps behind is held for the withdrawn one too"
        );

        let stuck = queued_write(&conn, "stuck").unwrap().unwrap();
        withdraw(&conn, &stuck, &held).unwrap();
        assert!(
            !release(&conn, "after-next").unwrap(),
            "a write refused behind one refused for a withdrawn write was released, \
             to be refused again by the next drain"
        );
        row("ahead", Some("refused"), 1, "[]");
        row("behind", Some("refused"), 0, "[\"ahead\"]");
        assert!(release(&conn, "behind").unwrap());

        row("orphan", Some("refused"), 0, "[\"gone\"]");
        row("waiting-on-orphan", None, 0, "[\"orphan\"]");
        forget_answered(&conn).unwrap();
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
                "ahead".to_string(),
                "behind".to_string(),
                "orphan".to_string(),
                "waiting-on-orphan".to_string()
            ],
            "the refused chain should go whole, and a row an unanswered one names should stay"
        );
    }

    #[test]
    fn a_queued_write_round_trips_through_every_column() {
        let conn = conn();
        // Every value distinct, because the reader is positional.
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
        // A device never purges, so the kind must not be holdable at all.
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

        verdict_row("stray", "blocked", Some("no_such_reason")).unwrap();
        assert!(matches!(queued_writes(&conn), Err(CoreError::Store(_))));
    }

    #[test]
    fn timestamp_reprojection_preserves_the_queued_request_and_retry_key() {
        for (spelling, expected) in [
            ("2026-01-01T01:00:00.500+0100", "2026-01-01T00:00:00.500Z"),
            ("invalid", "invalid"),
        ] {
            let conn = conn();
            let row = note("held", "server", "", "2026-01-01T00:00:00.000Z");
            upsert_item(&conn, &row, None, &Indexing::default()).unwrap();
            let payload = serde_json::json!({ "type": "core.note", "occurred_at": spelling, "properties": {} }).to_string();
            let queued = enqueue(
                &conn,
                &NewWrite {
                    kind: WriteKind::CreateItem,
                    item_id: Some("held"),
                    target_id: None,
                    edge_id: None,
                    namespace: None,
                    tag: None,
                    blob: None,
                    base_version: None,
                    payload: &payload,
                    depends_on: &[],
                },
            )
            .unwrap();
            for _ in 0..2 {
                lay_waiting_writes_over(&conn, "held", &|_| Indexing::default()).unwrap();
                let item = items_by_ids(&conn, &["held".into()])
                    .unwrap()
                    .pop()
                    .unwrap();
                assert_eq!(item.occurred_at, expected);
                let waiting = waiting_writes_for_item(&conn, "held")
                    .unwrap()
                    .pop()
                    .unwrap();
                assert_eq!(waiting.body, queued.body);
                assert_eq!(waiting.idempotency_key, queued.idempotency_key);
            }
        }
    }

    /// The device fixtures reach an edit, a tag and a delete; this reaches
    /// the other kinds and their order.
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

        queue(WriteKind::DeleteItem, "{}", None);
        lay_waiting_writes_over(&conn, "n1", &|_| Indexing::titled("title")).unwrap();
        let item = items_by_ids(&conn, &["n1".into()]).unwrap().pop().unwrap();
        assert_eq!(item.state, ItemState::Trashed);

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

    #[test]
    fn a_store_made_before_the_tables_beneath_and_read_backs_opens_and_gains_them() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("older.sqlite");
        {
            let conn = open(&path).unwrap();
            upsert_item(
                &conn,
                &note("row", "t", "b", "2026-01-01T00:00:00Z"),
                None,
                &Indexing::default(),
            )
            .unwrap();
            conn.execute_batch("DROP TABLE beneath; DROP TABLE read_backs;")
                .unwrap();
        }
        let conn = open(&path).unwrap();
        assert!(item_held(&conn, "row").unwrap());
        assert_eq!(beneath_item(&conn, "row").unwrap(), None);
        assert!(owed_read_backs(&conn).unwrap().is_empty());
    }

    #[test]
    fn a_row_is_older_than_a_later_version_held_or_one_stamped_later_at_the_same() {
        let conn = conn();
        let held_at = "2026-01-01T00:00:01.500Z";
        let mut row = note("row", "title", "body", "2026-01-01T00:00:00Z");
        row.version = 5;
        row.updated_at = held_at.into();
        upsert_item(&conn, &row, None, &Indexing::default()).unwrap();
        let mut edge = wire_edge("link", "row", "row", "references");
        edge.version = 5;
        edge.updated_at = held_at.into();
        upsert_edge(&conn, &edge).unwrap();
        for (subject, id) in [(Subject::Item, "row"), (Subject::Edge, "link")] {
            assert!(holds_later(&conn, subject, id, 4, "2027-01-01T00:00:00Z").unwrap());
            assert!(holds_later(&conn, subject, id, 5, "2026-01-01T00:00:01Z").unwrap());
            // The same instant written another way is a tie, which is no
            // later.
            assert!(!holds_later(&conn, subject, id, 5, "2026-01-01T01:00:01.5+01:00").unwrap());
            assert!(!holds_later(&conn, subject, id, 5, "2026-01-01T00:00:02Z").unwrap());
            assert!(!holds_later(&conn, subject, id, 6, "2020-01-01T00:00:00Z").unwrap());
            // A time that cannot be read leaves the version alone to order.
            assert!(!holds_later(&conn, subject, id, 5, "yesterday").unwrap());
            assert!(!holds_later(&conn, subject, "elsewhere", 1, held_at).unwrap());
        }
    }

    #[test]
    fn a_server_row_never_goes_in_over_a_later_one() {
        let conn = conn();
        let mut later = note("row", "later", "body", "2026-01-01T00:00:00Z");
        later.version = 3;
        later.state = "archived".into();
        later.updated_at = "2026-01-02T00:00:00.000Z".into();
        assert!(put_server_item(&conn, &later, None, &Indexing::default()).unwrap());
        let mut older = later.clone();
        older.state = "active".into();
        older.properties.insert("title".into(), "older".into());
        older.updated_at = "2026-01-01T12:00:00.000Z".into();
        owe_read_back(
            &conn,
            &Owed {
                subject: Subject::Item,
                id: "row".into(),
                source_id: None,
                edge_type: None,
                moved: false,
            },
        )
        .unwrap();
        assert!(
            !put_server_item(&conn, &older, None, &Indexing::default()).unwrap(),
            "a row stamped before the one held went in over it"
        );
        let held = item_by_id(&conn, "row").unwrap().unwrap();
        assert_eq!(held.state, ItemState::Archived);
        assert_eq!(held.properties["title"], "later");
        assert!(
            owed_read_backs(&conn).unwrap().is_empty(),
            "a server row in the copy left the read-back owed for it"
        );

        let mut edge = wire_edge("link", "row", "row", "references");
        edge.version = 2;
        edge.updated_at = "2026-01-02T00:00:00Z".into();
        assert!(put_server_edge(&conn, &edge).unwrap());
        let mut stale = edge.clone();
        stale.version = 1;
        stale.updated_at = "2026-03-01T00:00:00Z".into();
        assert!(!put_server_edge(&conn, &stale).unwrap());
        assert_eq!(edge_by_id(&conn, "link").unwrap().unwrap().version, 2);
    }

    #[test]
    fn an_instant_reads_any_fraction_and_offset() {
        let at = |stamp| instant_of(stamp).unwrap();
        assert_eq!(at("1970-01-01T00:00:00Z"), 0);
        assert_eq!(at("1970-01-01T00:00:01.25Z"), 1_250_000_000);
        assert_eq!(at("1970-01-01T01:00:00+01:00"), 0);
        assert_eq!(at("1969-12-31T23:00:00-01:00"), 0);
        assert_eq!(
            at("2026-01-01T00:00:00.123456789123Z") % 1_000_000_000,
            123_456_789
        );
        for unreadable in [
            "",
            "2026-01-01",
            "2026-13-01T00:00:00Z",
            "2026-01-01T00:00:00",
            "2026-01-01T00:00:00.Z",
        ] {
            assert_eq!(
                instant_of(unreadable),
                None,
                "{unreadable:?} read as an instant"
            );
        }
    }

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

        insert("ok", "accepted", 0, "key-ok").unwrap();

        assert!(insert("bad-verdict", "maybe", 0, "key-a").is_err());

        assert!(insert("over-ceiling", "dead", 6, "key-b").is_err());

        assert!(insert("duplicate-key", "accepted", 0, "key-ok").is_err());
    }

    fn refusal_of(path: &Path) -> (String, Option<u64>, String) {
        match open(path) {
            Err(error @ CoreError::WrongSchema { .. }) => {
                let said = error.to_string();
                let CoreError::WrongSchema { reason, unsent, .. } = error else {
                    unreachable!()
                };
                (reason, unsent, said)
            }
            other => panic!("{} opened as {other:?}", path.display()),
        }
    }

    fn queue_one(conn: &Connection) {
        conn.execute(
            "INSERT INTO queue (id, kind, idempotency_key, payload, queued_at)
             VALUES ('q1', 'create_item', 'k1', '{}', '2026-01-01T00:00:00Z')",
            [],
        )
        .unwrap();
    }

    #[test]
    fn a_store_counts_every_write_the_server_has_not_taken() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("core.sqlite");
        let refused_with = |verdict: Option<&str>| {
            {
                let conn = open(&path).unwrap();
                conn.execute_batch("DELETE FROM queue").unwrap();
                queue_one(&conn);
                conn.execute("UPDATE queue SET verdict = ?1, sent = 1", [verdict])
                    .unwrap();
                meta_set(&conn, META_SCHEMA_VERSION, SCHEMA_VERSION).unwrap();
                conn.execute_batch("DROP TABLE pins; CREATE TABLE pins (other TEXT);")
                    .unwrap();
            }
            let refused = refusal_of(&path);
            Connection::open(&path)
                .unwrap()
                .execute_batch(
                    "DROP TABLE pins; CREATE TABLE pins (item_id TEXT PRIMARY KEY) WITHOUT ROWID;",
                )
                .unwrap();
            refused
        };
        for verdict in [None, Some("blocked"), Some("refused"), Some("dead")] {
            let (_, unsent, said) = refused_with(verdict);
            assert_eq!(unsent, Some(1), "a {verdict:?} write was not counted");
            assert!(!said.contains("loses nothing"), "{said}");
        }
        // A refused write that carried nothing, sent, is one clearing drops.
        {
            let conn = open(&path).unwrap();
            conn.execute_batch("DELETE FROM queue").unwrap();
            conn.execute(
                "INSERT INTO queue (id, kind, idempotency_key, payload, queued_at, verdict, sent)
                 VALUES ('d1', 'delete_item', 'kd', '{}', '2026-01-01T00:00:00Z', 'refused', 1)",
                [],
            )
            .unwrap();
            conn.execute_batch("DROP TABLE pins; CREATE TABLE pins (other TEXT);")
                .unwrap();
        }
        let (_, unsent, said) = refusal_of(&path);
        assert_eq!(
            unsent,
            Some(0),
            "a refused delete that clearing drops was counted"
        );
        assert!(said.contains("loses nothing"), "{said}");
        Connection::open(&path)
            .unwrap()
            .execute_batch(
                "DROP TABLE pins; CREATE TABLE pins (item_id TEXT PRIMARY KEY) WITHOUT ROWID;",
            )
            .unwrap();
        assert!(
            open_to_read(&path).is_ok(),
            "counting left the reader's temporary queue in place"
        );

        // The witness: a write the server took is no loss.
        let (_, unsent, said) = refused_with(Some("accepted"));
        assert_eq!(unsent, Some(0));
        assert!(said.contains("loses nothing"), "{said}");
    }

    #[test]
    fn a_store_written_by_another_schema_is_refused_with_what_it_holds() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("core.sqlite");
        {
            let conn = open(&path).unwrap();
            queue_one(&conn);
            meta_set(&conn, META_SCHEMA_VERSION, "something-else").unwrap();
        }
        let (reason, unsent, said) = refusal_of(&path);
        assert!(reason.contains("something-else"), "{reason}");
        assert_eq!(unsent, Some(1));
        assert!(
            said.contains(&path.display().to_string()),
            "the refusal does not say which file, which a person may know only by the variable that named it: {said}"
        );
        assert!(said.contains("1 write the server has not taken"), "{said}");
        assert!(!said.to_lowercase().contains("delete"), "{said}");
    }

    #[test]
    fn a_store_of_another_shape_at_this_version_is_refused_by_name() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("core.sqlite");
        {
            let conn = open(&path).unwrap();
            queue_one(&conn);
            conn.execute_batch("ALTER TABLE queue RENAME COLUMN follows TO after_write")
                .unwrap();
            assert_eq!(
                meta_get(&conn, META_SCHEMA_VERSION).unwrap().as_deref(),
                Some(SCHEMA_VERSION)
            );
        }
        let (reason, unsent, _) = refusal_of(&path);
        assert!(reason.contains("queue"), "{reason}");
        assert_eq!(unsent, Some(1));
        assert!(matches!(
            open_to_read(&path),
            Err(CoreError::WrongSchema {
                unsent: Some(1),
                ..
            })
        ));

        // A queue whose shape hides its count is refused all the same, and
        // says it cannot tell.
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch("ALTER TABLE queue RENAME COLUMN verdict TO answer_kind")
                .unwrap();
        }
        let (_, unsent, said) = refusal_of(&path);
        assert_eq!(unsent, None);
        assert!(said.contains("cannot be read"), "{said}");
    }

    #[test]
    fn a_store_made_before_a_table_this_build_adds_opens_and_gains_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("core.sqlite");
        {
            let conn = open(&path).unwrap();
            conn.execute_batch("DROP TABLE beneath; DROP TABLE read_backs;")
                .unwrap();
        }
        // A reader cannot make the tables, so it waits on this build's
        // writer, and says so rather than sending the person to another build.
        assert!(matches!(
            open_to_read(&path),
            Err(CoreError::Invalid(said)) if said.contains("this build's writer")
        ));
        let conn = open(&path).unwrap();
        let tables: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name IN ('beneath', 'read_backs')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(tables, 2);
        assert!(open_to_read(&path).is_ok());
    }

    /// A change to a table's shape refuses every store made before it, so
    /// it is made on purpose: write the new hash here when it is.
    #[test]
    fn the_shape_this_build_makes_is_the_one_meant() {
        let built = built_shape().unwrap();
        let mut tables: Vec<_> = built.iter().collect();
        tables.sort();
        let named: String = tables
            .iter()
            .map(|(name, statement)| format!("{name}:{statement}\n"))
            .collect();
        assert_eq!(
            crate::folder::state::hash(named.as_bytes()),
            "7fceeb039d327cd2",
            "the shape of a table changed, which refuses every store made before it"
        );
        // The comment strip reads `--` alone, so a block comment would ride
        // through it and change the shape by its prose.
        assert!(!SCHEMA.contains("/*"), "schema.sql grew a block comment");
    }

    #[test]
    fn a_comment_or_a_line_break_is_no_change_of_shape() {
        assert_eq!(
            statement("CREATE TABLE t (\n  -- why\n  a TEXT, -- more\n  b INTEGER\n)"),
            statement("CREATE TABLE t (a TEXT, b INTEGER)")
        );
        assert_ne!(
            statement("CREATE TABLE t (a TEXT)"),
            statement("CREATE TABLE t (a INTEGER)")
        );
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
