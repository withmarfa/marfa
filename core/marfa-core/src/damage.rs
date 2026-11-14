//! Recovery of readable writes from a damaged store.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::File;
use std::io::{Read as _, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use rusqlite::{Connection, config::DbConfig, types::Value};
use serde::{Deserialize, Serialize};

use crate::error::CoreError;
use crate::model::{Verdict, WriteKind};
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
    /// that decides how a carried write is sent, and of the bytes an earlier
    /// set-aside keeps, was read. Where not, or where a write did not read,
    /// the store set aside may hold writes or records the new store lacks,
    /// and every byte the cache held as it was set aside stays until that
    /// store is removed or moved from where the set-aside put it.
    pub whole: bool,
    /// The carried writes held `blocked` with the reason `instance_changed`,
    /// because which instance the old store was built from could not be
    /// read. A caller releases one to send it to the instance the new store
    /// is hydrated from.
    pub held: u64,
    /// The carried writes held `blocked` with the reason `record_unread`,
    /// because a record that decides how each is sent could not be read. A
    /// caller releases one to send it without that record. Where the store
    /// is built from another instance than the one it was made against, or
    /// the set-aside could not tell which, a release holds it
    /// `instance_changed` instead.
    pub record_unread: u64,
}

/// Where a set-aside makes the new store before it takes the old one's name.
fn carrying(path: &Path) -> PathBuf {
    store::suffixed(path, ".carrying")
}

/// Where the new store is made and marked before it takes `carrying`.
fn making(path: &Path) -> PathBuf {
    store::suffixed(path, ".making")
}

// Markers distinguish an interrupted set-aside from an unrelated file.
const META_SET_ASIDE_TO: &str = "set_aside_to";
const META_SET_ASIDE: &str = "set_aside";
const META_SET_ASIDE_MAKING: &str = "set_aside_making";

/// `<prefix><set-aside name>/<hex>`: bytes kept while that store stands.
const META_KEEPS: &str = "set_aside_keeps/";
/// The first key after every `META_KEEPS` key.
const META_KEEPS_END: &str = "set_aside_keeps0";

// Unread records block only the write kinds whose sending they govern.
const BY_WRITE: [(&str, &[WriteKind]); 5] = [
    ("chosen_tier/", &[WriteKind::CreateItem]),
    ("cleared_time/", &[WriteKind::CreateItem]),
    ("dead_effect/", &[]),
    ("receipt_pending/", &[]),
    ("upload_sent_as/", &[]),
];

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

pub(crate) fn note_met() {
    MET.fetch_add(1, Ordering::Relaxed);
}

pub(crate) fn seen() -> u64 {
    MET.load(Ordering::Relaxed)
}

// Healthy stores' logs also stay; their next open replays them.
pub(crate) fn keep_log_if_met(conn: &Connection, seen: u64) {
    if self::seen() != seen {
        let _ = conn.set_db_config(DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE, true);
    }
}

/// SQLite deletes a log beside an empty file as it opens the file, even to
/// read, so a store whose log holds committed writes beside an empty file is
/// refused before SQLite opens it.
pub(crate) fn refuse_emptied(path: &Path) -> Result<(), CoreError> {
    if emptied(path) {
        return Err(emptied_refusal(path));
    }
    Ok(())
}

#[cfg(unix)]
pub(crate) fn refuse_emptied_in(
    state: &crate::directory::Directory,
    label: &Path,
) -> Result<(), CoreError> {
    let name = Path::new(store::FOLDER_STORE);
    let log = store::suffixed(name, "-wal");
    if state.entry_metadata(name).is_ok_and(|held| held.len() == 0)
        && commits(state.open_file(
            &log,
            crate::directory::OFlags::RDONLY,
            crate::directory::Mode::empty(),
        ))
    {
        return Err(emptied_refusal(label));
    }
    Ok(())
}

fn emptied(path: &Path) -> bool {
    path.metadata()
        .is_ok_and(|held| held.is_file() && held.len() == 0)
        && commits(File::open(store::suffixed(path, "-wal")))
}

fn emptied_refusal(path: &Path) -> CoreError {
    CoreError::StoreDamaged {
        path: path.display().to_string(),
        reason: "its file is empty while its write-ahead log holds committed writes, which SQLite deletes as it opens such a file".into(),
        unsent: None,
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

// Carried writes still need the upload bytes beside the original path.
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
    Done(String),
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
            serde_json::from_str::<SetAside>(&done).map_or(Markers::Unknown, |_| Markers::Done(to))
        }
        (Ok(None), Ok(None), Ok(Some(_))) => Markers::Making,
        _ => Markers::Unknown,
    }
}

/// Requires the store's writer lock. A quick check misses an index entry
/// out of step with its row, which a copy taken mid-write leaves.
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
        let mut query = conn.prepare("PRAGMA integrity_check")?;
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
        // A set-aside that stopped after its new store took the path answers now.
        Ok(()) => {
            return answer(path)?.ok_or_else(|| {
                CoreError::Invalid(format!(
                    "{} opens as it is, so there is nothing to set aside",
                    path.display()
                ))
            });
        }
        Err(other) => return Err(other),
    }
    let aside = store::free_set_aside(path, ".damaged")?;
    let made = carrying(path);
    make(path, &made)?;
    // `make` put a marked store at `made`, so what a failed carry leaves is its own.
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

/// `finish` found nothing at `made`, so it takes the new store only once
/// the store holds its mark.
fn make(path: &Path, made: &Path) -> Result<(), CoreError> {
    let making = making(path);
    clear_left(path, &making)?;
    crate::owner_only(&making)?;
    stop_if_asked("made")?;
    store::make_marked(&making, &[(META_SET_ASIDE_MAKING, "true")])?;
    stop_if_asked("making")?;
    let _ = std::fs::remove_file(store::suffixed(&making, "-shm"));
    std::fs::rename(&making, made).map_err(|error| {
        CoreError::Store(format!(
            "{} cannot take {}: {error}",
            making.display(),
            made.display()
        ))
    })?;
    sync_holder(path);
    Ok(())
}

fn clear_left(path: &Path, making: &Path) -> Result<(), CoreError> {
    let Some(first) = present(making) else {
        return Ok(());
    };
    if !left_part_made(making) {
        return Err(not_made(path, &first));
    }
    store::remove(making)
}

/// Whether `making` holds a set-aside's mark, or nothing at all.
fn left_part_made(making: &Path) -> bool {
    let Ok(held) = making.symlink_metadata() else {
        return false;
    };
    let log = store::suffixed(making, "-wal");
    if !held.is_file()
        || store::suffixed(making, "-journal")
            .symlink_metadata()
            .is_ok()
    {
        return false;
    }
    if held.len() == 0 {
        return !commits(File::open(&log));
    }
    store::open_refused(making).is_ok_and(|conn| match store::holds_tables(&conn) {
        Ok(false) => !commits(File::open(&log)),
        Ok(true) => matches!(store::meta_get(&conn, META_SET_ASIDE_MAKING), Ok(Some(_))),
        Err(_) => false,
    })
}

/// Whether the write-ahead log `log` holds a committed frame, or cannot be
/// shown not to. SQLite reads no log beside an empty file. Only the headers
/// are read, so a log of any size costs no more memory.
fn commits(log: std::io::Result<File>) -> bool {
    let mut log = match log {
        Ok(log) => log,
        Err(error) => return error.kind() != std::io::ErrorKind::NotFound,
    };
    let Ok(length) = log.metadata().map(|held| held.len()) else {
        return true;
    };
    if length == 0 {
        return false;
    }
    let Some(page) = log_page(&mut log) else {
        return true;
    };
    let mut frame = WAL_HEADER;
    while frame < length {
        // A frame's commit word is the database size after a commit, else 0.
        let mut commit = [0; 4];
        if log.seek(SeekFrom::Start(frame + 4)).is_err()
            || log.read_exact(&mut commit).is_err()
            || commit != [0; 4]
        {
            return true;
        }
        frame += FRAME_HEADER + page;
    }
    false
}

const WAL_HEADER: u64 = 32;
const FRAME_HEADER: u64 = 24;

/// The page size a write-ahead log's header names, where it is one. Unlike a
/// database header, a log's header states 65,536 as itself.
fn log_page(log: &mut File) -> Option<u64> {
    let mut header = [0; 12];
    log.seek(SeekFrom::Start(0)).ok()?;
    log.read_exact(&mut header).ok()?;
    let word = |at: usize| {
        u32::from_be_bytes([header[at], header[at + 1], header[at + 2], header[at + 3]])
    };
    if !matches!(word(0), 0x377f_0682 | 0x377f_0683) {
        return None;
    }
    let page = word(8);
    ((512..=65_536).contains(&page) && page.is_power_of_two()).then_some(u64::from(page))
}

/// The old store opened to read, and the copy it is read from where its
/// file is empty: SQLite reads a log over a blank page instead of deleting it.
struct Old {
    conn: Option<Connection>,
    _copy: Option<tempfile::TempDir>,
}

impl Old {
    /// Fails only where the copy cannot be made, before anything is moved,
    /// so asking again at the same path can still carry what the log holds.
    fn open(path: &Path) -> Result<Old, CoreError> {
        if let Ok(conn) = store::open_refused(path) {
            return Ok(Old {
                conn: Some(conn),
                _copy: None,
            });
        }
        let log = store::suffixed(path, "-wal");
        let page = emptied(path)
            .then(|| File::open(&log).ok().and_then(|mut log| log_page(&mut log)))
            .flatten();
        let Some(page) = page else {
            return Ok(Old {
                conn: None,
                _copy: None,
            });
        };
        let failed = |error: std::io::Error| {
            CoreError::Store(format!(
                "{} cannot be set aside: its write-ahead log cannot be copied to be read: {error}",
                path.display()
            ))
        };
        let holder = path
            .parent()
            .filter(|holder| !holder.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        let copy = tempfile::Builder::new()
            .prefix(".marfa-reading")
            .tempdir_in(holder)
            .map_err(failed)?;
        let store = copy.path().join("store");
        std::fs::write(&store, vec![0; page as usize]).map_err(failed)?;
        std::fs::copy(&log, store::suffixed(&store, "-wal")).map_err(failed)?;
        let conn = Connection::open_with_flags(
            &store,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        Ok(Old {
            conn: Some(conn),
            _copy: Some(copy),
        })
    }
}

/// The first of `store`'s file and logs that stands.
fn present(store: &Path) -> Option<PathBuf> {
    store::STORE_FILES
        .iter()
        .map(|suffix| store::suffixed(store, suffix))
        .find(|name| name.symlink_metadata().is_ok())
}

fn not_made(path: &Path, standing: &Path) -> CoreError {
    CoreError::Store(format!(
        "{} cannot be set aside: {} stands where its new store is made, and is not one a set-aside made, so it is left as it is. Move it elsewhere, then set the store aside again",
        path.display(),
        standing.display()
    ))
}

fn sync_holder(path: &Path) {
    if let Some(holder) = path
        .parent()
        .filter(|holder| !holder.as_os_str().is_empty())
    {
        let _ = std::fs::File::open(holder).and_then(|dir| dir.sync_all());
    }
}

fn carry(path: &Path, made: &Path, aside: &Path) -> Result<(), CoreError> {
    let opened = Old::open(path)?;
    let old = opened.conn.as_ref();
    let mut conn = store::open(made)?;
    let columns = columns(&conn, "queue")?;
    let read = old.map_or_else(Read::none, |old| read_queue(old, &columns));
    let meta = old.map_or_else(Meta::none, Meta::read);
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
        if let Said::Known(Some(value)) = meta.get(old, key) {
            let _ = store::meta_set(&tx, key, &value);
        }
    }
    for (id, kind) in &carried {
        let mut known = true;
        for (prefix, guards) in BY_WRITE {
            let key = format!("{prefix}{id}");
            match meta.get(old, &key) {
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
        let (copied, read_whole) = old.map_or((BTreeSet::new(), false), |old| {
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
    if let Some(old) = old {
        let _ = copy_rows(old, &tx, "declared_types");
    }
    let keep_range = META_KEEPS.to_string()..META_KEEPS_END.to_string();
    let kept = meta.rows.range(keep_range.clone()).map(|(key, _)| key);
    let indexed = meta
        .keys
        .iter()
        .flat_map(|keys| keys.range(keep_range.clone()));
    for key in kept.chain(indexed).collect::<BTreeSet<_>>() {
        let aside = key[META_KEEPS.len()..]
            .rsplit_once('/')
            .map(|(aside, _)| aside);
        if aside.is_some_and(|aside| stands(&path.with_file_name(aside))) {
            store::meta_set(&tx, key, "")?;
        }
    }
    // An earlier set-aside's keeps may be among the keys that did not read.
    if !meta.whole && meta.keys.is_none() {
        whole = false;
    }
    if unread > 0 || !whole {
        keep_bytes(&tx, path, aside)?;
    }
    let ids: Vec<String> = carried.keys().cloned().collect();
    lay_rows(&tx, &ids);
    let record_unread = store::hold_record_unread(&tx, &unchecked)? as u64;
    let held = match meta.get(old, store::META_INSTANCE_ID) {
        Said::Unknown if !carried.is_empty() => store::block_for_another_instance(&tx)? as u64,
        _ => 0,
    };
    // An earlier set-aside's writes may have been made for another instance
    // than the old store's, so either unknown leaves the new one unknown.
    let instance = match meta.get(old, store::META_INSTANCE_ID) {
        Said::Known(instance) => Said::Known(instance.filter(|id| !id.is_empty())),
        Said::Unknown => Said::Unknown,
    };
    let made_for = match (instance, meta.get(old, store::META_CARRIED_FOR)) {
        (Said::Known(instance), Said::Known(None)) => instance,
        (Said::Known(None), Said::Known(Some(earlier))) => Some(earlier),
        (Said::Known(Some(instance)), Said::Known(Some(earlier))) if earlier == instance => {
            Some(instance)
        }
        _ => Some(String::new()),
    };
    if let Some(made_for) = made_for {
        store::meta_set(&tx, store::META_CARRIED_FOR, &made_for)?;
    }
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

/// Records every byte the cache beside `path` holds, kept while the store
/// set aside at `aside` stands, since its unread writes may name them.
fn keep_bytes(tx: &Connection, path: &Path, aside: &Path) -> Result<(), CoreError> {
    let cache = crate::blob::Cache::beside(path);
    let held = cache.sizes().map_err(|error| {
        CoreError::Store(format!(
            "{} cannot be set aside: the bytes beside it cannot be listed to be kept: {error}",
            path.display()
        ))
    })?;
    let aside = aside.file_name().unwrap_or_default().to_string_lossy();
    for hex in held.keys().filter(|name| !name.starts_with('.')) {
        store::meta_set(tx, &format!("{META_KEEPS}{aside}/{hex}"), "")?;
    }
    Ok(())
}

/// The bytes each set-aside that could not read every write keeps, by hex,
/// while the store it set aside stands where `beside` names it.
pub(crate) fn kept_bytes(
    conn: &Connection,
    beside: impl Fn(&str) -> PathBuf,
) -> Result<BTreeSet<String>, CoreError> {
    Ok(keeps(conn, beside)?.0)
}

/// Forgets the bytes kept for each store set aside that is gone, since a
/// later set-aside can take its name.
pub(crate) fn forget_gone_keeps(
    conn: &Connection,
    beside: impl Fn(&str) -> PathBuf,
) -> Result<(), CoreError> {
    for aside in keeps(conn, beside)?.1 {
        conn.execute(
            "DELETE FROM meta WHERE key >= ?1 AND key < ?2",
            [
                format!("{META_KEEPS}{aside}/"),
                format!("{META_KEEPS}{aside}0"),
            ],
        )?;
    }
    Ok(())
}

/// The bytes kept, and the stores set aside shown gone.
fn keeps(
    conn: &Connection,
    beside: impl Fn(&str) -> PathBuf,
) -> Result<(BTreeSet<String>, BTreeSet<String>), CoreError> {
    let mut query = conn.prepare_cached("SELECT key FROM meta WHERE key >= ?1 AND key < ?2")?;
    let keys = query
        .query_map([META_KEEPS, META_KEEPS_END], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut standing = BTreeMap::new();
    let (mut kept, mut gone) = (BTreeSet::new(), BTreeSet::new());
    for key in &keys {
        let Some((aside, hex)) = key[META_KEEPS.len()..].rsplit_once('/') else {
            continue;
        };
        let stands = *standing
            .entry(aside.to_string())
            .or_insert_with(|| stands(&beside(aside)));
        if stands {
            kept.insert(hex.to_string());
        } else {
            gone.insert(aside.to_string());
        }
    }
    Ok((kept, gone))
}

/// Unless shown gone, as a store a person moved or removed is.
fn stands(path: &Path) -> bool {
    !matches!(
        path.symlink_metadata(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound
    )
}

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

// Unknown write kinds may need any guarding record.
fn guarded(guards: &[WriteKind], kind: Option<WriteKind>) -> bool {
    kind.is_none_or(|kind| guards.contains(&kind))
}

fn finish(path: &Path) -> Result<Option<SetAside>, CoreError> {
    let made = carrying(path);
    if made.symlink_metadata().is_err() {
        // A log is a set-aside's only beside a store it made.
        return match present(&made) {
            Some(log) => Err(not_made(path, &log)),
            None => Ok(None),
        };
    }
    let to = match markers(&made) {
        Markers::Done(to) => to,
        // Its markers show a set-aside made it, and it carries nothing yet.
        Markers::Making => {
            store::remove(&made)?;
            return Ok(None);
        }
        Markers::Unknown => return Err(not_made(path, &made)),
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
        stop_if_asked(if suffix.is_empty() { "store" } else { suffix })?;
    }
    std::fs::rename(&made, path).map_err(|error| {
        CoreError::Store(format!(
            "{} cannot take {}: {error}",
            made.display(),
            path.display()
        ))
    })?;
    sync_holder(path);
    stop_if_asked("taken")?;
    answer(path)?.map(Some).ok_or_else(|| {
        CoreError::Store(format!(
            "{} took {} but does not say what it carries",
            made.display(),
            path.display()
        ))
    })
}

/// The answer the new store at `path` holds, given once: its markers go
/// as it is read.
fn answer(path: &Path) -> Result<Option<SetAside>, CoreError> {
    let conn = store::open(path)?;
    let (Some(_), Some(done)) = (
        store::meta_get(&conn, META_SET_ASIDE_TO)?,
        store::meta_get(&conn, META_SET_ASIDE)?,
    ) else {
        return Ok(None);
    };
    let mut done: SetAside = serde_json::from_str(&done)?;
    done.carried = store::untaken_count(&conn).unwrap_or_default();
    conn.execute(
        "DELETE FROM meta WHERE key IN (?1, ?2)",
        [META_SET_ASIDE_TO, META_SET_ASIDE],
    )?;
    Ok(Some(done))
}

#[allow(unused_variables)]
fn stop_if_asked(named: &str) -> Result<(), CoreError> {
    #[cfg(debug_assertions)]
    {
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

// A complete key index can prove absence when the table cannot.
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

// A damaged index must not hide readable records.
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
