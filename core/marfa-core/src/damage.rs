//! Recovery of readable writes from a damaged store.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use rusqlite::{Connection, config::DbConfig, types::Value};
use serde::{Deserialize, Serialize};

use crate::error::CoreError;
use crate::model::{BlockedReason, Verdict, WriteKind};
use crate::store::{self, SCHEMA_VERSION};

/// What a set-aside did.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SetAside {
    /// Where the damaged store now is, with its logs beside it.
    pub set_aside: String,
    /// The writes the new store holds that the server has not taken.
    pub carried: u64,
    /// The writes found in the old queue that could not be read.
    pub unread: u64,
    /// The id of each unread write whose id could be read.
    pub unread_ids: Vec<String>,
    /// Whether every write the old queue holds was found, and every record
    /// that decides how a carried write is sent was read. Where not, the
    /// store set aside may hold writes or records the new store lacks.
    pub whole: bool,
    /// The carried writes held `blocked` with the reason `instance_changed`,
    /// because which instance the old store was built from could not be
    /// read. A caller releases one to send it to the instance the new store
    /// is hydrated from.
    pub held: u64,
    /// The carried writes held `blocked` with the reason `record_unread`,
    /// because a record that decides how each is sent could not be read. A
    /// caller releases one to send it without that record.
    pub record_unread: u64,
}

/// Where a set-aside makes the new store before it takes the old one's name.
fn carrying(path: &Path) -> PathBuf {
    store::suffixed(path, ".carrying")
}

// These markers let a later call resume interrupted renames, and show that
// a set-aside made the file at `carrying`.
const META_SET_ASIDE_TO: &str = "set_aside_to";
const META_SET_ASIDE: &str = "set_aside";
const META_SET_ASIDE_MAKING: &str = "set_aside_making";

/// Each record meta keeps under a write's id, with the kinds of write it
/// decides how to send.
const BY_WRITE: [(&str, &[WriteKind]); 5] = [
    ("chosen_tier/", &[WriteKind::CreateItem]),
    ("cleared_time/", &[WriteKind::CreateItem]),
    ("dead_effect/", &[]),
    ("receipt_pending/", &[]),
    ("upload_sent_as/", &[]),
];

/// Each table that keeps a record under a write's id, with the kinds of
/// write it decides how to send.
const TABLES_BY_WRITE: [(&str, &[WriteKind]); 2] = [
    (
        "body_edges",
        &[WriteKind::CreateEdge, WriteKind::DeleteEdge],
    ),
    (
        "body_checks",
        &[WriteKind::CreateItem, WriteKind::UpdateItem],
    ),
];

static MET: AtomicU64 = AtomicU64::new(0);

/// Counts the damage SQLite reports, on any store.
pub(crate) fn note_met() {
    MET.fetch_add(1, Ordering::Relaxed);
}

/// What `keep_log_if_met` compares against.
pub(crate) fn seen() -> u64 {
    MET.load(Ordering::Relaxed)
}

/// Where damage was met since `seen`, leaves the write-ahead log as it is
/// when `conn` closes, since a checkpoint on close would fold it into a file
/// that does not read and delete it. The count is the process's, so damage
/// met on another store keeps this one's log too, which its next open reads.
pub(crate) fn keep_log_if_met(conn: &Connection, seen: u64) {
    if self::seen() != seen {
        let _ = conn.set_db_config(DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE, true);
    }
}

pub(crate) fn refusal(path: &Path, reason: String) -> CoreError {
    CoreError::StoreDamaged {
        path: path.display().to_string(),
        reason,
        unsent: store::open_refused(path)
            .ok()
            .and_then(|conn| store::untaken_count(&conn)),
    }
}

pub(crate) fn at_path(error: CoreError, path: &Path) -> CoreError {
    match error {
        CoreError::StoreDamaged {
            path: named,
            reason,
            ..
        } if named.is_empty() => refusal(path, reason),
        other => other,
    }
}

/// Refuses `StoreDamaged` while a file stands where a set-aside makes the
/// new store, so nothing opens, replaces or removes the store at `path`
/// while what a set-aside carried waits to take its place.
pub(crate) fn refuse_unfinished(path: &Path) -> Result<(), CoreError> {
    let made = carrying(path);
    if made.symlink_metadata().is_err() {
        return Ok(());
    }
    let (reason, unsent) = match markers(&made) {
        Markers::Done(..) => (
            format!(
                "setting it aside stopped part way, and {} holds the writes it carried until a set-aside finishes",
                made.display()
            ),
            store::open_refused(&made)
                .ok()
                .and_then(|conn| store::untaken_count(&conn)),
        ),
        Markers::Making => (
            format!(
                "setting it aside stopped part way, before {} carried anything",
                made.display()
            ),
            None,
        ),
        Markers::Unknown => (
            format!(
                "{} stands where a set-aside makes its new store, and is not one a set-aside made",
                made.display()
            ),
            None,
        ),
    };
    Err(CoreError::StoreDamaged {
        path: path.display().to_string(),
        reason,
        unsent,
    })
}

enum Markers {
    Done(String, SetAside),
    /// Made by a set-aside that stopped before it carried anything.
    Making,
    /// Not shown to be a set-aside's.
    Unknown,
}

fn markers(made: &Path) -> Markers {
    let Ok(conn) = store::open_refused(made) else {
        return Markers::Unknown;
    };
    let get = |key| store::meta_get(&conn, key);
    match (
        get(META_SET_ASIDE_TO),
        get(META_SET_ASIDE),
        get(META_SET_ASIDE_MAKING),
    ) {
        (Ok(Some(to)), Ok(Some(done)), _) => {
            serde_json::from_str(&done).map_or(Markers::Unknown, |done| Markers::Done(to, done))
        }
        (Ok(None), Ok(None), Ok(Some(_))) => Markers::Making,
        _ => Markers::Unknown,
    }
}

/// Requires the store's writer lock.
pub(crate) fn check(path: &Path) -> Result<(), CoreError> {
    let damaged = |error: CoreError| match error {
        CoreError::StoreDamaged { reason, .. } => refusal(path, reason),
        other => other,
    };
    let conn = store::open_refused(path).map_err(damaged)?;
    let found = store::version(&conn).map_err(|error| damaged(error.into()))?;
    let empty = found == 0 && !store::holds_tables(&conn).map_err(|error| damaged(error.into()))?;
    if found != SCHEMA_VERSION && !empty {
        return Err(store::at_path(store::refused(&conn, found), path));
    }
    let said = (|| -> rusqlite::Result<Vec<String>> {
        let mut query = conn.prepare("PRAGMA quick_check")?;
        let rows = query.query_map([], |row| row.get::<_, String>(0))?;
        rows.collect()
    })()
    .map_err(|error| damaged(error.into()))?;
    match said.first() {
        Some(ok) if said.len() == 1 && ok == "ok" => Ok(()),
        first => Err(refusal(
            path,
            first
                .cloned()
                .unwrap_or_else(|| "its pages do not read".into()),
        )),
    }
}

/// Requires the store's writer lock.
pub(crate) fn set_aside(path: &Path) -> Result<SetAside, CoreError> {
    if let Some(done) = finish(path)? {
        return Ok(done);
    }
    if path.symlink_metadata().is_err() {
        return Err(CoreError::Invalid(format!(
            "{} holds no store to set aside",
            path.display()
        )));
    }
    store::refuse_folders(path)?;
    match check(path) {
        Err(CoreError::StoreDamaged { .. }) => {}
        Ok(()) => {
            return Err(CoreError::Invalid(format!(
                "{} opens as it is, so there is nothing to set aside",
                path.display()
            )));
        }
        Err(other) => return Err(other),
    }
    let aside = store::free_set_aside(path, ".damaged")?;
    let made = carrying(path);
    // `finish` left nothing at `made`, so what a failed carry leaves is its own.
    carry(path, &made, &aside).inspect_err(|_| {
        let _ = store::remove(&made);
    })?;
    finish(path)?.ok_or_else(|| {
        CoreError::Store(format!(
            "{} was made but does not say what it carries",
            made.display()
        ))
    })
}

fn carry(path: &Path, made: &Path, aside: &Path) -> Result<(), CoreError> {
    let old = store::open_refused(path).ok();
    crate::owner_only(made)?;
    let mut conn = store::open(made)?;
    store::meta_set(&conn, META_SET_ASIDE_MAKING, "true")?;
    let columns = columns(&conn, "queue")?;
    let read = old
        .as_ref()
        .map_or_else(Read::none, |old| read_queue(old, &columns));
    let meta = old.as_ref().map_or_else(Meta::none, Meta::read);
    let tx = conn.transaction()?;
    let id_at = columns.iter().position(|column| column == "id");
    let mut unread_ids: Vec<String> = read.unread.iter().flatten().cloned().collect();
    let mut unread = read.unread.len() as u64;
    {
        let list = columns
            .iter()
            .map(|column| format!("\"{column}\""))
            .collect::<Vec<_>>()
            .join(", ");
        let marks = (1..=columns.len())
            .map(|at| format!("?{at}"))
            .collect::<Vec<_>>()
            .join(", ");
        let mut insert = tx.prepare(&format!("INSERT INTO queue ({list}) VALUES ({marks})"))?;
        for row in read.rows {
            let id = id_at.and_then(|at| match &row[at] {
                Value::Text(id) => Some(id.clone()),
                _ => None,
            });
            if insert.execute(rusqlite::params_from_iter(row)).is_err() {
                unread += 1;
                unread_ids.extend(id);
            }
        }
    }
    let carried = kinds(&tx)?;
    let mut whole = read.whole;
    let mut unchecked = Vec::new();
    for key in [
        store::META_SERVER_ORIGIN,
        store::META_INSTANCE_ID,
        crate::file_cache::META_BUDGET,
    ] {
        if let Said::Known(Some(value)) = meta.get(old.as_ref(), key) {
            let _ = store::meta_set(&tx, key, &value);
        }
    }
    for (id, kind) in &carried {
        let mut known = true;
        for (prefix, guards) in BY_WRITE {
            let key = format!("{prefix}{id}");
            match meta.get(old.as_ref(), &key) {
                Said::Known(Some(value)) => {
                    let _ = store::meta_set(&tx, &key, &value);
                }
                Said::Known(None) => {}
                Said::Unknown => {
                    whole = false;
                    known &= !guarded(guards, *kind);
                }
            }
        }
        if !known {
            unchecked.push(id.clone());
        }
    }
    for (table, guards) in TABLES_BY_WRITE {
        let (copied, read_whole) = old.as_ref().map_or((BTreeSet::new(), false), |old| {
            copy_by_write(old, &tx, table, &carried)
        });
        if read_whole {
            continue;
        }
        for (id, kind) in &carried {
            if !copied.contains(id) {
                whole = false;
                if guarded(guards, *kind) {
                    unchecked.push(id.clone());
                }
            }
        }
    }
    if let Some(old) = &old {
        let _ = copy_rows(old, &tx, "declared_types");
    }
    let ids: Vec<String> = carried.keys().cloned().collect();
    lay_rows(&tx, &ids);
    let record_unread = store::hold(&tx, &unchecked, BlockedReason::RecordUnread)? as u64;
    let held = match meta.get(old.as_ref(), store::META_INSTANCE_ID) {
        Said::Unknown if !carried.is_empty() => {
            store::block_for_another_instance_but(&tx, BlockedReason::RecordUnread)? as u64
        }
        _ => 0,
    };
    let done = SetAside {
        set_aside: aside.display().to_string(),
        carried: 0,
        unread,
        unread_ids,
        whole,
        held,
        record_unread,
    };
    store::meta_set(
        &tx,
        META_SET_ASIDE_TO,
        &aside.file_name().unwrap_or_default().to_string_lossy(),
    )?;
    store::meta_set(&tx, META_SET_ASIDE, &serde_json::to_string(&done)?)?;
    store::meta_delete(&tx, META_SET_ASIDE_MAKING)?;
    tx.commit()?;
    store::without_log(&conn)?;
    Ok(())
}

/// The kind of each write the new store carries, by its id, `None` where
/// this build names no such kind.
fn kinds(tx: &Connection) -> Result<BTreeMap<String, Option<WriteKind>>, CoreError> {
    let mut query = tx.prepare("SELECT id, kind FROM queue")?;
    let rows = query.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut kinds = BTreeMap::new();
    for row in rows {
        let (id, kind) = row?;
        kinds.insert(id, kind.parse().ok());
    }
    Ok(kinds)
}

/// Whether a record kept for `guards` may decide how a write of `kind` is
/// sent: a kind this build does not name may be one.
fn guarded(guards: &[WriteKind], kind: Option<WriteKind>) -> bool {
    kind.is_none_or(|kind| guards.contains(&kind))
}

fn finish(path: &Path) -> Result<Option<SetAside>, CoreError> {
    let made = carrying(path);
    if made.symlink_metadata().is_err() {
        return Ok(None);
    }
    let (to, mut done) = match markers(&made) {
        Markers::Done(to, done) => (to, done),
        // Its markers show a set-aside made it, and it carries nothing yet.
        Markers::Making => {
            store::remove(&made)?;
            return Ok(None);
        }
        Markers::Unknown => {
            return Err(CoreError::Store(format!(
                "{} cannot be set aside: {} stands where its new store is made, and is not one a set-aside made, so it is left as it is. Move it elsewhere, then set the store aside again",
                path.display(),
                made.display()
            )));
        }
    };
    {
        let conn = Connection::open(&made)?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        store::without_log(&conn)?;
    }
    for log in ["-wal", "-journal"] {
        if store::suffixed(&made, log).symlink_metadata().is_ok() {
            return Err(CoreError::Store(format!(
                "{} still has its log beside it, so it cannot take {}",
                made.display(),
                path.display()
            )));
        }
    }
    let _ = std::fs::remove_file(store::suffixed(&made, "-shm"));
    let aside = path.with_file_name(&to);
    for suffix in store::STORE_FILES.iter().rev() {
        let (from, onto) = (
            store::suffixed(path, suffix),
            store::suffixed(&aside, suffix),
        );
        if from.symlink_metadata().is_err() {
            continue;
        }
        if onto.symlink_metadata().is_ok() {
            return Err(CoreError::Store(format!(
                "{} cannot be set aside: {} is taken",
                from.display(),
                onto.display()
            )));
        }
        std::fs::rename(&from, &onto).map_err(|error| {
            CoreError::Store(format!("{} cannot be set aside: {error}", from.display()))
        })?;
        stop_if_asked(suffix)?;
    }
    std::fs::rename(&made, path).map_err(|error| {
        CoreError::Store(format!(
            "{} cannot take {}: {error}",
            made.display(),
            path.display()
        ))
    })?;
    if let Some(holder) = path
        .parent()
        .filter(|holder| !holder.as_os_str().is_empty())
    {
        let _ = std::fs::File::open(holder).and_then(|dir| dir.sync_all());
    }
    let conn = store::open(path)?;
    done.carried = store::untaken_count(&conn).unwrap_or_default();
    store::meta_delete(&conn, META_SET_ASIDE_TO)?;
    store::meta_delete(&conn, META_SET_ASIDE)?;
    Ok(Some(done))
}

#[allow(unused_variables)]
fn stop_if_asked(suffix: &str) -> Result<(), CoreError> {
    #[cfg(debug_assertions)]
    {
        let named = if suffix.is_empty() { "store" } else { suffix };
        if crate::fault::named("set-aside-crash").as_deref() == Some(named) {
            eprintln!("crashing after setting aside {named} as MARFA_TEST_FAULT asks");
            std::process::abort();
        }
        if crate::fault::fails(|| format!("set-aside-stop:{named}")) {
            return Err(CoreError::Store(format!("set-aside-stop:{named}")));
        }
    }
    Ok(())
}

/// What could be read of a damaged queue.
struct Read {
    rows: Vec<Vec<Value>>,
    /// Each write found but not read, with its id where an index names it.
    unread: Vec<Option<String>>,
    whole: bool,
}

impl Read {
    fn none() -> Read {
        Read {
            rows: Vec::new(),
            unread: Vec::new(),
            whole: false,
        }
    }
}

fn columns(conn: &Connection, table: &str) -> rusqlite::Result<Vec<String>> {
    let mut query = conn.prepare("SELECT name FROM pragma_table_info(?1)")?;
    let rows = query.query_map([table], |row| row.get(0))?;
    rows.collect()
}

// Intact indexes can identify rows that a damaged table scan misses.
fn read_queue(old: &Connection, columns: &[String]) -> Read {
    let same = store::version(old).ok() == Some(SCHEMA_VERSION)
        && columns_of_queue(old).as_deref() == Some(columns);
    if !same {
        return Read::none();
    }
    let mut found: BTreeMap<i64, Option<String>> = BTreeMap::new();
    let mut whole = walk(old, "SELECT seq, NULL FROM queue NOT INDEXED", &mut found);
    for (index, partial, by_id) in queue_indexes(old) {
        let id = if by_id { "id" } else { "NULL" };
        let walked = walk(
            old,
            &format!("SELECT seq, {id} FROM queue INDEXED BY \"{index}\""),
            &mut found,
        );
        whole |= walked && !partial;
    }
    let list = columns
        .iter()
        .map(|column| format!("\"{column}\""))
        .collect::<Vec<_>>()
        .join(", ");
    let one = format!("SELECT {list} FROM queue NOT INDEXED WHERE seq = ?1");
    let mut read = Read {
        rows: Vec::new(),
        unread: Vec::new(),
        whole,
    };
    for (seq, id) in found {
        let row = old.query_row(&one, [seq], |row| {
            (0..columns.len())
                .map(|at| row.get::<_, Value>(at))
                .collect::<rusqlite::Result<Vec<_>>>()
        });
        match row {
            Ok(row) => read.rows.push(row),
            Err(_) => read.unread.push(id),
        }
    }
    read
}

fn columns_of_queue(old: &Connection) -> Option<Vec<String>> {
    columns(old, "queue").ok().filter(|held| !held.is_empty())
}

fn queue_indexes(old: &Connection) -> Vec<(String, bool, bool)> {
    let listed = (|| -> rusqlite::Result<Vec<(String, bool)>> {
        let mut query = old.prepare("SELECT name, partial FROM pragma_index_list('queue')")?;
        let rows = query.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
        rows.collect()
    })()
    .unwrap_or_default();
    listed
        .into_iter()
        .map(|(name, partial)| {
            let by_id = columns_of_index(old, &name).as_deref() == Some(&["id".to_string()][..]);
            (name, partial, by_id)
        })
        .collect()
}

fn columns_of_index(old: &Connection, index: &str) -> Option<Vec<String>> {
    let mut query = old
        .prepare("SELECT name FROM pragma_index_info(?1) ORDER BY seqno")
        .ok()?;
    let rows = query.query_map([index], |row| row.get(0)).ok()?;
    rows.collect::<rusqlite::Result<_>>().ok()
}

fn walk(old: &Connection, sql: &str, found: &mut BTreeMap<i64, Option<String>>) -> bool {
    scan(old, sql, |row| {
        let seq: i64 = row.get(0)?;
        let id = row.get::<_, Option<String>>(1).ok().flatten();
        let named = found.entry(seq).or_default();
        if id.is_some() {
            *named = id;
        }
        Ok(())
    })
}

/// What the old store's meta says of a key.
enum Said {
    Known(Option<String>),
    Unknown,
}

/// The old store's meta as far as it reads: its rows, and whether every
/// key it holds is known, from the table or from an index of its keys.
struct Meta {
    rows: BTreeMap<String, String>,
    whole: bool,
    keys: Option<BTreeSet<String>>,
}

impl Meta {
    fn none() -> Meta {
        Meta {
            rows: BTreeMap::new(),
            whole: false,
            keys: None,
        }
    }

    fn read(old: &Connection) -> Meta {
        let mut rows = BTreeMap::new();
        let whole = scan(old, "SELECT key, value FROM meta NOT INDEXED", |row| {
            rows.insert(row.get(0)?, row.get(1)?);
            Ok(())
        });
        let keys = (!whole)
            .then(|| {
                by_key_index(old, "meta", "key")
                    .into_iter()
                    .find_map(|index| {
                        let mut keys = BTreeSet::new();
                        scan(
                            old,
                            &format!("SELECT key FROM meta INDEXED BY \"{index}\""),
                            |row| {
                                keys.insert(row.get(0)?);
                                Ok(())
                            },
                        )
                        .then_some(keys)
                    })
            })
            .flatten();
        Meta { rows, whole, keys }
    }

    fn get(&self, old: Option<&Connection>, key: &str) -> Said {
        if let Some(value) = self.rows.get(key) {
            return Said::Known(Some(value.clone()));
        }
        if self.whole || self.keys.as_ref().is_some_and(|keys| !keys.contains(key)) {
            return Said::Known(None);
        }
        match old.map(|old| store::meta_get(old, key)) {
            Some(Ok(Some(value))) => Said::Known(Some(value)),
            _ => Said::Unknown,
        }
    }
}

/// Runs `sql`, handing each row to `each`; whether every row read.
fn scan(
    old: &Connection,
    sql: &str,
    mut each: impl FnMut(&rusqlite::Row) -> rusqlite::Result<()>,
) -> bool {
    let Ok(mut query) = old.prepare(sql) else {
        return false;
    };
    let Ok(mut rows) = query.query([]) else {
        return false;
    };
    loop {
        match rows.next() {
            Ok(Some(row)) => {
                if each(row).is_err() {
                    return false;
                }
            }
            Ok(None) => return true,
            Err(_) => return false,
        }
    }
}

/// The whole indexes of `table` on `column` alone.
fn by_key_index(old: &Connection, table: &str, column: &str) -> Vec<String> {
    let listed = (|| -> rusqlite::Result<Vec<(String, bool)>> {
        let mut query = old.prepare("SELECT name, partial FROM pragma_index_list(?1)")?;
        let rows = query.query_map([table], |row| Ok((row.get(0)?, row.get(1)?)))?;
        rows.collect()
    })()
    .unwrap_or_default();
    listed
        .into_iter()
        .filter(|(name, partial)| {
            !partial && columns_of_index(old, name).as_deref() == Some(&[column.to_string()][..])
        })
        .map(|(name, _)| name)
        .collect()
}

/// Copies the rows of `table` that name a carried write, read without an
/// index; answers the writes copied and whether every row read.
fn copy_by_write(
    old: &Connection,
    new: &Connection,
    table: &str,
    carried: &BTreeMap<String, Option<WriteKind>>,
) -> (BTreeSet<String>, bool) {
    let mut copied = BTreeSet::new();
    let Ok(columns) = columns(new, table) else {
        return (copied, false);
    };
    let Some(write_at) = columns.iter().position(|column| column == "write_id") else {
        return (copied, false);
    };
    let Ok(mut insert) = new.prepare(&insert_into(table, &columns)) else {
        return (copied, false);
    };
    let whole = scan(
        old,
        &format!("SELECT {} FROM \"{table}\" NOT INDEXED", list(&columns)),
        |row| {
            let values = (0..columns.len())
                .map(|at| row.get::<_, Value>(at))
                .collect::<rusqlite::Result<Vec<_>>>()?;
            if let Value::Text(write) = &values[write_at]
                && carried.contains_key(write)
            {
                let write = write.clone();
                insert.execute(rusqlite::params_from_iter(values))?;
                copied.insert(write);
            }
            Ok(())
        },
    );
    (copied, whole)
}

fn copy_rows(old: &Connection, new: &Connection, table: &str) -> rusqlite::Result<()> {
    let columns = columns(new, table)?;
    let mut read = old.prepare(&format!("SELECT {} FROM \"{table}\"", list(&columns)))?;
    let mut insert = new.prepare(&insert_into(table, &columns))?;
    let mut rows = read.query([])?;
    while let Some(row) = rows.next()? {
        let values = (0..columns.len())
            .map(|at| row.get::<_, Value>(at))
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let _ = insert.execute(rusqlite::params_from_iter(values));
    }
    Ok(())
}

fn list(columns: &[String]) -> String {
    columns
        .iter()
        .map(|column| format!("\"{column}\""))
        .collect::<Vec<_>>()
        .join(", ")
}

fn insert_into(table: &str, columns: &[String]) -> String {
    let marks = (1..=columns.len())
        .map(|at| format!("?{at}"))
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "INSERT OR IGNORE INTO \"{table}\" ({}) VALUES ({marks})",
        list(columns)
    )
}

fn lay_rows(tx: &Connection, carried: &[String]) {
    for id in carried {
        let _ = lay_one(tx, id);
    }
}

fn lay_one(tx: &Connection, id: &str) -> Result<(), CoreError> {
    let Some(write) = store::queued_write(tx, id)? else {
        return Ok(());
    };
    if write.kind != WriteKind::WriteRows || !matches!(write.verdict, None | Some(Verdict::Blocked))
    {
        return Ok(());
    }
    let (Some(item), Some(table)) = (&write.item_id, row_table(tx, id)?) else {
        return Ok(());
    };
    let seq: i64 = tx.query_row("SELECT seq FROM queue WHERE id = ?1", [id], |row| {
        row.get(0)
    })?;
    let body: serde_json::Value = serde_json::from_str(&store::payload_of(tx, id)?)?;
    let ops = crate::row_writes::queued_ops(&body)?;
    crate::row_writes::record_laid(tx, id, seq, item, &table, &ops, &write.queued_at)?;
    Ok(())
}

fn row_table(tx: &Connection, id: &str) -> Result<Option<String>, CoreError> {
    Ok(
        tx.query_row("SELECT row_table FROM queue WHERE id = ?1", [id], |row| {
            row.get(0)
        })?,
    )
}
