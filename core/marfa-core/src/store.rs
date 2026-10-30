use std::collections::{HashMap, HashSet};
use std::path::Path;

use rusqlite::{Connection, OptionalExtension, named_params, params, params_from_iter};
use serde_json::{Map, Value};
use uuid::Uuid;

use crate::catalog::Indexing;
use crate::error::CoreError;
use crate::js;
use crate::model::{
    BlockedReason, Completeness, Edge, Item, ItemState, QueuedWrite, SliceTier, Subject, Tier,
    Verdict, WriteKind,
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
/// Set by a hydration from the server's count of its slice when it started,
/// and absent where the server did not answer one.
pub const META_ITEMS_EXPECTED: &str = "items_expected";
/// How many rows the listings of the hydration under way have brought, set
/// with each page so it reads against `META_ITEMS_EXPECTED`.
pub const META_ITEMS_LISTED: &str = "items_listed";
/// Where the hydration under way has reached: the listing it walks, the page
/// cursor it sends next and the pages it has read. Set with each page, so an
/// interrupted hydration carries on from the last page it committed.
pub const META_HYDRATE_RESUME: &str = "hydrate_resume";
/// Present while the copy is to be filled again in place: from the moment the
/// event log let its cursor go, under the instance and reach it was built
/// under (`Refill`), until a hydration has walked the slice again, replayed
/// the log and taken out what the walk did not bring. Any other expiry, and a
/// hydration that clears the copy, removes it.
pub const META_REFILL: &str = "refill";
/// Absent until a catalog is first held, which is how a copy that has never
/// held one is told from an instance with no types.
pub const META_CATALOG_VERSION: &str = "catalog_version";
/// Set while the catalog the copy holds is its own, the types Marfa ships and
/// the ones the app declared, and cleared by the first catalog a server gives.
pub const META_LOCAL_CATALOG: &str = "local_catalog";
/// Present while writes the server has not taken wait for a stream to be had
/// again: set when the server was lost or a drain left a write undelivered,
/// and cleared by a drain that left none or found no work.
pub const META_DRAIN_OWED: &str = "drain_owed";
/// Moved by the triggers in `schema.sql` with every change to a row of the
/// copy or the queue, so a reader can tell the copy changed even where its
/// own connection made the change.
pub const META_COPY_REVISION: &str = "copy_revision";
/// Set once, when a writer first opens the store, so a cursor of
/// `Core::changes_since` taken from one store is told from another's at the
/// same path.
pub const META_STORE_ID: &str = "store_id";
/// The latest change of an edge `edge_changes` no longer records
/// (`prune_edge_changes`).
pub const META_EDGE_CHANGES_FLOOR: &str = "edge_changes_floor";
/// How many of the latest changes `edge_changes` keeps whatever they name.
/// The writer, as it opens the store, lets go of older rows of edges the
/// copy no longer holds once there are more than twice this many.
pub const EDGE_CHANGES_KEPT: usize = 10_000;
pub const HYDRATE_IN_PROGRESS: &str = "in_progress";
pub const SCHEMA_VERSION: &str = "0";

const META_TABLE: &str =
    "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);";

const ITEM_COLUMNS: &str = "id, type, state, tier, version, schema_version, source, source_id, occurred_at, created_at, updated_at, properties, capture_latitude, capture_longitude";
const EDGE_COLUMNS: &str =
    "id, source_id, target_id, edge_type, properties, version, created_at, updated_at";

pub fn open(path: &Path) -> Result<Connection, CoreError> {
    let conn = Connection::open(path)?;
    // The store may have been named by an environment variable rather than
    // typed, so the refusal names its path.
    prepare(&conn).map_err(|error| at_path(error, path))?;
    Ok(conn)
}

#[cfg(unix)]
pub(crate) fn open_directory(
    vfs: &crate::directory_vfs::DirectoryVfs,
    label: &Path,
) -> Result<Connection, CoreError> {
    let conn = vfs.open(
        FOLDER_STORE,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE
            | rusqlite::OpenFlags::SQLITE_OPEN_CREATE
            | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    prepare(&conn).map_err(|error| in_folder(error, label, &conn))?;
    Ok(conn)
}

fn at_path(error: CoreError, path: &Path) -> CoreError {
    match error {
        CoreError::WrongSchema {
            reason,
            unsent,
            folder,
            ..
        } => CoreError::WrongSchema {
            path: path.display().to_string(),
            reason,
            unsent,
            folder,
        },
        other => other,
    }
}

/// A refusal of the store a folder keeps in its state directory, which
/// `conn` opened.
#[cfg(unix)]
fn in_folder(error: CoreError, label: &Path, conn: &Connection) -> CoreError {
    match at_path(error, label) {
        CoreError::WrongSchema {
            path,
            reason,
            unsent,
            ..
        } => match folder_store(conn) {
            Ok(folder) => CoreError::WrongSchema {
                path,
                reason,
                unsent: unsent.and(folder_unsent(conn)),
                folder: Some(folder),
            },
            Err(error) => error,
        },
        other => other,
    }
}

/// The tables in which a folder records its files: which item each is, what
/// the folder last read and wrote there, which files went missing, and the
/// pins that keep each bound item in the copy whatever the query says of it.
/// A hydration keeps them and brings none of them back, so a replacement of a
/// folder's store carries them.
#[cfg(unix)]
pub(crate) const FOLDER_TABLES: [&str; 4] =
    ["folder_files", "folder_journal", "folder_stats", "pins"];

/// What this build's folder commands can do with the folder store `conn`
/// opened, which this build refuses `wrong_schema`.
#[cfg(unix)]
fn folder_store(conn: &Connection) -> Result<crate::FolderStore, CoreError> {
    if meta_get(conn, crate::folder::settings_file::META_FOLDER)?.is_none() {
        return Ok(crate::FolderStore::Unnamed);
    }
    Ok(match uncarried(conn)? {
        Some(table) => crate::FolderStore::Uncarried(table.to_string()),
        None => crate::FolderStore::Replaceable,
    })
}

/// The first of the folder's tables that `conn`'s store holds in a shape
/// other than this build's, which a replacement cannot carry.
#[cfg(unix)]
fn uncarried(conn: &Connection) -> Result<Option<&'static str>, CoreError> {
    let held = held_shape(conn)?;
    let built = built_shape()?;
    Ok(FOLDER_TABLES.into_iter().find(|table| {
        held.get(*table)
            .is_some_and(|statement| built.get(*table) != Some(statement))
    }))
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
    read_connection(conn, path)
}

/// Why a writer would refuse the store at `path`, read without changing it:
/// `None` where a writer would open it.
pub(crate) fn refusal(path: &Path) -> Result<Option<CoreError>, CoreError> {
    let conn = open_refused(path)?;
    match refuse_misshapen(&conn, &held_shape(&conn)?, false) {
        Ok(()) => Ok(None),
        Err(error @ CoreError::WrongSchema { .. }) => Ok(Some(at_path(error, path))),
        Err(other) => Err(other),
    }
}

/// The store at `path` opened to read, whatever its shape, for the caller
/// that holds its writer lock. SQLite may make a `-shm` index beside a log to
/// read it.
fn open_refused(path: &Path) -> Result<Connection, CoreError> {
    let flags =
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let logged = ["-wal", "-journal"]
        .iter()
        .any(|suffix| suffixed(path, suffix).symlink_metadata().is_ok());
    // Without a log the file alone is the store, and the caller's writer
    // lock keeps it so: read as immutable, SQLite makes no log beside it.
    let conn = match path.to_str() {
        Some(name) if !logged => Connection::open_with_flags(
            format!(
                "file:{}?immutable=1",
                name.replace('%', "%25")
                    .replace('?', "%3f")
                    .replace('#', "%23")
            ),
            flags | rusqlite::OpenFlags::SQLITE_OPEN_URI,
        )?,
        _ => Connection::open_with_flags(path, flags)?,
    };
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    Ok(conn)
}

/// The file budget the store at `path` records, which this build refuses
/// `wrong_schema`, read with raw SQL so the store's shape does not matter.
/// `None` where the store holds none this build reads as a setting, or
/// cannot be read: the new store then has the default.
pub(crate) fn refused_file_budget(path: &Path) -> Option<crate::FileBudget> {
    let conn = open_refused(path).ok()?;
    let text: String = conn
        .query_row(
            "SELECT value FROM meta WHERE key = ?1",
            [crate::file_cache::META_BUDGET],
            |row| row.get(0),
        )
        .ok()?;
    Some(crate::FileBudget::stored(Some(&text))).filter(|setting| setting.to_stored().is_some())
}

/// The writes the store at `path` holds that the server has not taken, as
/// `wrong_schema` counts them, read whatever the store's shape for the caller
/// that holds its writer lock. A store with no table holds none. `None` where
/// they cannot be counted, as in a file that is not a store. Refuses a
/// folder's store, which only its folder's removal may take.
pub(crate) fn removal_count(path: &Path) -> Result<Option<u64>, CoreError> {
    let Ok(conn) = open_refused(path) else {
        return Ok(None);
    };
    let Ok(tables) = conn.query_row("SELECT COUNT(*) FROM sqlite_schema", [], |row| {
        row.get::<_, i64>(0)
    }) else {
        return Ok(None);
    };
    if tables == 0 {
        return Ok(Some(0));
    }
    // A folder's store is bound to the folder, and is also known by where
    // the folder keeps it, so one a crash left before it was bound is still
    // the folder's.
    let kept_by_folder = path.file_name() == Some(FOLDER_STORE.as_ref())
        && path.parent().and_then(Path::file_name) == Some(crate::folder::STATE_DIR.as_ref());
    if kept_by_folder
        || meta_get(&conn, crate::folder::settings_file::META_FOLDER)
            .ok()
            .flatten()
            .is_some()
    {
        return Err(CoreError::Invalid(format!(
            "{} is a folder's store: remove the folder instead (`marfa folders remove`), which keeps its registry and its files in step",
            path.display()
        )));
    }
    Ok(untaken_count(&conn))
}

/// Removes the store at `path` and the logs beside it, logs first, so a log
/// is never left beside a name a new store can take. A symbolic link at one
/// of these names is removed, never what it leads to.
pub(crate) fn remove(path: &Path) -> Result<(), CoreError> {
    for suffix in STORE_FILES.iter().rev() {
        crate::remove_name(&suffixed(path, suffix))?;
    }
    Ok(())
}

/// The store file, then the logs SQLite keeps beside it. A log is read into
/// whatever store holds its name, so each one moves with its store.
const STORE_FILES: [&str; 4] = ["", "-journal", "-wal", "-shm"];

fn suffixed(path: &Path, suffix: &str) -> std::path::PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    name.into()
}

/// The most set-aside copies one store's name can have beside it. Reached
/// only where something other than a copy keeps taking the names.
const MOST_SET_ASIDE: u32 = 1000;

/// The name, `<store>.refused-<n>` for the first `n` from 1 whose store file
/// and logs are all absent, so a copy a replacement left is never overwritten
/// or mistaken for part of this one.
pub(crate) fn free_set_aside(path: &Path) -> Result<std::path::PathBuf, CoreError> {
    for n in 1..=MOST_SET_ASIDE {
        let aside = suffixed(path, &format!(".refused-{n}"));
        let mut free = true;
        for suffix in STORE_FILES {
            let name = suffixed(&aside, suffix);
            match name.symlink_metadata() {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(CoreError::Store(format!(
                        "{} cannot be replaced: {} cannot be checked: {error}",
                        path.display(),
                        name.display()
                    )));
                }
                Ok(_) => free = false,
            }
        }
        if free {
            return Ok(aside);
        }
    }
    Err(CoreError::Store(format!(
        "{} cannot be replaced: {MOST_SET_ASIDE} copies set aside beside it are left; remove them first",
        path.display()
    )))
}

/// Replaces the store at `path` with an empty one of this build's shape. The
/// caller holds the writer lock and has found nothing unsent. The old store
/// is set aside under a name of its own (`free_set_aside`), logs first, so a
/// log is never left beside a store that is not its own; it is put back if
/// the new store cannot be made, and removed only once it has been.
pub(crate) fn replace(path: &Path) -> Result<Connection, CoreError> {
    let aside = free_set_aside(path)?;
    let mut moved = Vec::new();
    for suffix in STORE_FILES.iter().rev() {
        let (from, to) = (suffixed(path, suffix), suffixed(&aside, suffix));
        match std::fs::rename(&from, &to) {
            Ok(()) => moved.push(*suffix),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                let unmoved = restore_set_aside(path, &aside, &moved);
                return Err(CoreError::Store(format!(
                    "{} cannot be set aside: {error}{unmoved}",
                    from.display()
                )));
            }
        }
    }
    let made = (|| -> Result<Connection, CoreError> {
        crate::owner_only(path)?;
        let conn = open(path)?;
        // After the new store's files exist, so a failure leaves a partial
        // store to clean up.
        #[cfg(debug_assertions)]
        if crate::fault::fails(|| "replace-refused-make") {
            return Err(CoreError::Store("replace-refused-make".into()));
        }
        Ok(conn)
    })();
    match made {
        Ok(conn) => {
            for suffix in &moved {
                let _ = std::fs::remove_file(suffixed(&aside, suffix));
            }
            Ok(conn)
        }
        Err(error) => {
            for suffix in STORE_FILES.iter().rev() {
                let _ = std::fs::remove_file(suffixed(path, suffix));
            }
            let unmoved = restore_set_aside(path, &aside, &moved);
            Err(CoreError::Store(format!(
                "{} cannot be replaced: {error}{unmoved}",
                path.display()
            )))
        }
    }
}

/// Moves what `replace` set aside back to `path`, the store file first.
/// Names what could not be moved, so the store is never lost from view.
fn restore_set_aside(path: &Path, aside: &Path, moved: &[&str]) -> String {
    let mut order: Vec<&str> = moved.to_vec();
    order.sort_by_key(|suffix| STORE_FILES.iter().position(|one| one == suffix));
    let stranded: Vec<String> = order
        .into_iter()
        .filter_map(|suffix| {
            let from = suffixed(aside, suffix);
            std::fs::rename(&from, suffixed(path, suffix))
                .err()
                .map(|error| format!("{} ({error})", from.display()))
        })
        .collect();
    if stranded.is_empty() {
        String::new()
    } else {
        format!(
            "; the old store could not be put back and is still at {}",
            stranded.join(", ")
        )
    }
}

/// A folder's store, in the folder's state directory.
#[cfg(unix)]
pub(crate) const FOLDER_STORE: &str = "core.sqlite";

/// Where a replacement makes a folder's new store before it takes the old
/// one's name.
#[cfg(unix)]
pub(crate) const FOLDER_STORE_MADE: &str = "core.sqlite.replacing";

/// The values `keys` hold in the meta of the folder store in `vfs`'s
/// directory, read without its shape checked, as from a store this build
/// refuses `wrong_schema`. A key the store does not hold is absent.
#[cfg(unix)]
pub(crate) fn refused_folder_meta(
    vfs: &crate::directory_vfs::DirectoryVfs,
    keys: &[&str],
) -> Result<HashMap<String, String>, CoreError> {
    let conn = vfs.open(
        FOLDER_STORE,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    meta_of(&conn, keys)
}

/// Whether the folder store holds this build's `meta` but lacks a table this
/// build makes, which its writer adds on open (`device/added-table`).
#[cfg(unix)]
pub(crate) fn folder_store_lacks_table(
    vfs: &crate::directory_vfs::DirectoryVfs,
) -> Result<bool, CoreError> {
    let conn = vfs.open(
        FOLDER_STORE,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    let held = held_shape(&conn)?;
    Ok(held.contains_key("meta") && built_shape()?.keys().any(|name| !held.contains_key(name)))
}

#[cfg(unix)]
fn meta_of(conn: &Connection, keys: &[&str]) -> Result<HashMap<String, String>, CoreError> {
    let mut held = HashMap::new();
    for key in keys {
        if let Some(value) = meta_get(conn, key)? {
            held.insert((*key).to_string(), value);
        }
    }
    Ok(held)
}

/// Leaves the store `conn` opened as one file, with no log beside it that a
/// store later at its name would read as its own.
#[cfg(unix)]
fn without_log(conn: &Connection) -> Result<(), CoreError> {
    let mode: String = conn.query_row("PRAGMA journal_mode = DELETE", [], |row| row.get(0))?;
    if !mode.eq_ignore_ascii_case("delete") {
        return Err(CoreError::Store(
            "another process has it open, so its log cannot be let go; try again once that process ends".into(),
        ));
    }
    Ok(())
}

/// Replaces the folder store in `state`, which this build refuses
/// `wrong_schema`, with one of this build's shape that holds the old store's
/// rows of `FOLDER_TABLES` and the values of its meta keys `carried` keeps,
/// and answers those values. The caller holds the writer lock and has found
/// nothing unsent. The new store is made whole under another name, then
/// takes the old one's in one rename, so a failure or a crash at any step
/// leaves one whole store at the name.
#[cfg(unix)]
pub(crate) fn replace_folder_store(
    state: &crate::directory::Directory,
    label: &Path,
    carried: impl Fn(&str) -> bool,
) -> Result<HashMap<String, String>, CoreError> {
    let unreplaced = |reason: String| {
        CoreError::Store(format!("{} cannot be replaced: {reason}", label.display()))
    };
    let vfs = crate::directory_vfs::DirectoryVfs::new(state.file())?;
    let named = |store: &str, suffix: &str| std::path::PathBuf::from(format!("{store}{suffix}"));
    let log_beside = |store: &str| {
        ["-wal", "-journal"]
            .into_iter()
            .map(|suffix| named(store, suffix))
            .find(|log| state.entry_kind(log).is_ok())
    };
    // A store a replacement left part made is that replacement's, never the
    // person's.
    let clear_made = || {
        for suffix in STORE_FILES {
            let _ = state.unlink(&named(FOLDER_STORE_MADE, suffix));
        }
    };
    let old = vfs.open(
        FOLDER_STORE,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    old.busy_timeout(std::time::Duration::from_secs(5))?;
    let read = (|| -> Result<(HashMap<String, String>, Vec<&'static str>), CoreError> {
        if let Some(table) = uncarried(&old)? {
            return Err(CoreError::Store(format!(
                "its table {table} is not of this build's shape"
            )));
        }
        let held = held_shape(&old)?;
        let tables = FOLDER_TABLES
            .into_iter()
            .filter(|table| held.contains_key(*table))
            .collect();
        let mut statement = old.prepare("SELECT key, value FROM meta")?;
        let kept = statement
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get(1)?)))?
            .filter(|row| row.as_ref().map_or(true, |(key, _)| carried(key)))
            .collect::<rusqlite::Result<_>>()?;
        Ok((kept, tables))
    })();
    let (kept, tables) = read.map_err(|error| {
        unreplaced(format!(
            "what it records of the folder cannot be read: {error}"
        ))
    })?;
    without_log(&old).map_err(|error| unreplaced(error.to_string()))?;
    if let Some(log) = log_beside(FOLDER_STORE) {
        return Err(unreplaced(format!(
            "its log {} is still beside it",
            log.display()
        )));
    }
    let _ = state.unlink(&named(FOLDER_STORE, "-shm"));
    clear_made();
    let made = (|| -> Result<(), CoreError> {
        let conn = vfs.open(
            FOLDER_STORE_MADE,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE
                | rusqlite::OpenFlags::SQLITE_OPEN_CREATE
                | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        prepare(&conn)?;
        let tx = conn.unchecked_transaction()?;
        for (key, value) in &kept {
            meta_set(&tx, key, value)?;
        }
        for table in &tables {
            carry_rows(&old, &tx, table)?;
        }
        tx.commit()?;
        without_log(&conn)?;
        drop(conn);
        // After the new store's file exists, so a failure leaves one to clear.
        #[cfg(debug_assertions)]
        if crate::fault::fails(|| "replace-refused-make") {
            return Err(CoreError::Store("replace-refused-make".into()));
        }
        if let Some(log) = log_beside(FOLDER_STORE_MADE) {
            return Err(CoreError::Store(format!(
                "the new store's log {} is still beside it",
                log.display()
            )));
        }
        let _ = state.unlink(&named(FOLDER_STORE_MADE, "-shm"));
        state
            .rename(
                Path::new(FOLDER_STORE_MADE),
                state,
                Path::new(FOLDER_STORE),
                false,
            )
            .map_err(|error| CoreError::Store(error.to_string()))
    })();
    drop(old);
    if let Err(error) = made {
        clear_made();
        return Err(unreplaced(error.to_string()));
    }
    let _ = state.sync();
    Ok(kept)
}

/// Copies every row of `table` from `from` to `to`, whose tables are of the
/// same shape. Two connections, since a folder's store is opened through a
/// file system that refuses `ATTACH`.
#[cfg(unix)]
fn carry_rows(from: &Connection, to: &Connection, table: &str) -> Result<(), CoreError> {
    let columns = {
        let mut statement = to.prepare("SELECT name FROM pragma_table_info(?1)")?;
        statement
            .query_map([table], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };
    let list = columns
        .iter()
        .map(|column| format!("\"{column}\""))
        .collect::<Vec<_>>()
        .join(", ");
    let marks = (1..=columns.len())
        .map(|at| format!("?{at}"))
        .collect::<Vec<_>>()
        .join(", ");
    let mut read = from.prepare(&format!("SELECT {list} FROM \"{table}\""))?;
    let mut write = to.prepare(&format!(
        "INSERT INTO \"{table}\" ({list}) VALUES ({marks})"
    ))?;
    let mut rows = read.query([])?;
    while let Some(row) = rows.next()? {
        let values = (0..columns.len())
            .map(|at| row.get::<_, rusqlite::types::Value>(at))
            .collect::<rusqlite::Result<Vec<_>>>()?;
        write.execute(rusqlite::params_from_iter(values))?;
    }
    Ok(())
}

#[cfg(unix)]
pub(crate) fn read_directory(
    vfs: &crate::directory_vfs::DirectoryVfs,
    label: &Path,
) -> Result<Connection, CoreError> {
    let conn = vfs.open(
        FOLDER_STORE,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    read_checked(&conn, label).map_err(|error| in_folder(error, label, &conn))?;
    Ok(conn)
}

fn read_connection(conn: Connection, path: &Path) -> Result<Connection, CoreError> {
    read_checked(&conn, path)?;
    Ok(conn)
}

/// SQLite's default page cache of 2 MiB holds a few thousand rows, so a
/// listing of a larger copy would read every page again from the file. The
/// cache grows only as pages are read. The statement cache holds the
/// statements a read of many bodies prepares for each body.
fn tune(conn: &Connection) -> Result<(), CoreError> {
    conn.execute_batch("PRAGMA cache_size = -32768;")?;
    conn.set_prepared_statement_cache_capacity(64);
    Ok(())
}

fn read_checked(conn: &Connection, path: &Path) -> Result<(), CoreError> {
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    let no_schema = || {
        CoreError::Invalid(format!(
            "{} is not a store: it has no schema to read",
            path.display()
        ))
    };
    let held = held_shape(conn).map_err(|error| match &error {
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
    refuse_misshapen(conn, &held, true).map_err(|error| at_path(error, path))?;
    tune(conn)
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
    tune(conn)?;
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
    if meta_get(conn, META_STORE_ID)?.is_none() {
        meta_set(
            conn,
            META_STORE_ID,
            &uuid::Uuid::now_v7().simple().to_string(),
        )?;
    }
    Ok(())
}

pub(crate) fn store_id(conn: &Connection) -> Result<String, CoreError> {
    meta_get(conn, META_STORE_ID)?.ok_or_else(|| {
        CoreError::Store("the store has no id; open it once with this build's writer".into())
    })
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
            reason: format!("{reason}{}", unsendable(conn)),
            unsent: untaken_count(conn),
            folder: None,
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

/// The writes the server has not taken whose kind this build does not send,
/// which only an earlier build's queue can hold, named by kind. Empty where
/// there are none or the queue cannot be read.
fn unsendable(conn: &Connection) -> String {
    let held = (|| -> rusqlite::Result<Vec<(String, i64)>> {
        let mut query = conn.prepare(
            "SELECT kind, COUNT(*) FROM queue
              WHERE verdict IS NULL OR verdict NOT IN (?1, ?2, ?3)
              GROUP BY kind ORDER BY kind",
        )?;
        let rows = query.query_map(
            [
                Verdict::Accepted.as_str(),
                Verdict::Merged.as_str(),
                Verdict::Conflicted.as_str(),
            ],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        rows.collect()
    })()
    .unwrap_or_default();
    let named: Vec<String> = held
        .into_iter()
        .filter(|(kind, _)| kind.parse::<WriteKind>().is_err())
        .map(|(kind, count)| {
            format!(
                "{count} {} of kind {kind}",
                if count == 1 { "write" } else { "writes" }
            )
        })
        .collect();
    if named.is_empty() {
        return String::new();
    }
    format!(
        ", and its queue holds {}, which this build cannot send",
        named.join(" and ")
    )
}

/// Every write the server has not taken that clearing answered writes would
/// keep: waiting, blocked, refused or dead. Read by clearing a copy of the
/// queue in the connection's own temporary space, so the count is what
/// `forget_answered` keeps and a reading connection can take it too. A
/// folder's store also counts each answered write the queue still holds that
/// a file's state waits on, which a store without the queue would leave
/// waiting for ever. `None` where a queue or a folder's record of another
/// shape cannot be counted.
fn untaken_count(conn: &Connection) -> Option<u64> {
    let counted = (|| -> Result<i64, CoreError> {
        conn.execute_batch("CREATE TEMP TABLE queue AS SELECT * FROM main.queue")?;
        forget_answered_inner(conn, None, false)?;
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

/// The writes a replacement of a folder's store would lose: each not yet
/// sent, as a folder's removal counts them; each refused or dead one but a
/// refusal the folder has dealt with; and each answered one a file's state
/// still waits on.
#[cfg(unix)]
fn folder_unsent(conn: &Connection) -> Option<u64> {
    let counted = (|| -> Result<usize, CoreError> {
        let mut unsent =
            conn.prepare("SELECT id FROM main.queue WHERE verdict IS NULL OR verdict = ?1")?;
        let mut held: HashSet<String> = unsent
            .query_map([Verdict::Blocked.as_str()], |row| row.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        held.extend(unrecorded_answers(conn)?);
        held.extend(awaited_by_files(conn)?);
        Ok(held.len())
    })();
    counted.ok().and_then(|count| u64::try_from(count).ok())
}

/// The refused and dead writes in the queue that the folder has not dealt
/// with, by id. A dead write may yet have landed, and only its own build can
/// release it. A refusal of a change the folder records against a file, to
/// an item a file is bound to (either end, for an edge), the folder has
/// recorded against that file, or has cleared from it once a later save was
/// taken; one it has yet to record is still on the file's waiting list, which
/// `awaited_by_files` counts. That also takes in a placement or a default
/// edge of a bound item, which no file records: each asks only for what the
/// file's path or the folder's settings say, and the replacement keeps both.
/// A refusal of any other kind no file records.
#[cfg(unix)]
fn unrecorded_answers(conn: &Connection) -> Result<HashSet<String>, CoreError> {
    let recorded_against_files = [
        WriteKind::UpdateItem,
        WriteKind::AddTag,
        WriteKind::RemoveTag,
        WriteKind::TransitionItem,
        WriteKind::CreateEdge,
        WriteKind::DeleteEdge,
        WriteKind::UpdateEdge,
    ]
    .map(WriteKind::as_str);
    let bound: HashSet<String> = if held_shape(conn)?.contains_key("folder_files") {
        let mut statement = conn.prepare("SELECT item_id FROM main.folder_files")?;
        statement
            .query_map([], |row| row.get(0))?
            .collect::<rusqlite::Result<_>>()?
    } else {
        HashSet::new()
    };
    let is_bound = |item: &Option<String>| item.as_ref().is_some_and(|item| bound.contains(item));
    let mut statement = conn.prepare(
        "SELECT id, kind, item_id, target_id, verdict, reason
           FROM main.queue WHERE verdict IN (?1, ?2)",
    )?;
    let mut unrecorded = HashSet::new();
    let mut rows = statement.query([Verdict::Refused.as_str(), Verdict::Dead.as_str()])?;
    while let Some(row) = rows.next()? {
        let kind: String = row.get(1)?;
        let (item, target): (Option<String>, Option<String>) = (row.get(2)?, row.get(3)?);
        let refused = row.get::<_, String>(4)? == Verdict::Refused.as_str();
        // A delete of an edge refused as already gone did what it asked.
        let done = kind == WriteKind::DeleteEdge.as_str()
            && row.get::<_, Option<String>>(5)?.as_deref() == Some("edge_not_found");
        let handled = recorded_against_files.contains(&kind.as_str())
            && (is_bound(&item) || is_bound(&target));
        if !(refused && (done || handled)) {
            unrecorded.insert(row.get(0)?);
        }
    }
    Ok(unrecorded)
}

/// The writes in the queue that a folder's file state names as waiting on
/// their answer, by id.
#[cfg(unix)]
fn awaited_by_files(conn: &Connection) -> Result<HashSet<String>, CoreError> {
    let mut statement = match conn.prepare("SELECT writes FROM main.folder_files") {
        Ok(statement) => statement,
        // A store with no folder record of this kind records no file.
        Err(error) => {
            let recorded = conn
                .query_row(
                    "SELECT EXISTS (SELECT 1 FROM main.folder_files)",
                    [],
                    |row| row.get::<_, bool>(0),
                )
                .unwrap_or(false);
            return if recorded {
                Err(error.into())
            } else {
                Ok(HashSet::new())
            };
        }
    };
    let mut named = HashSet::new();
    let mut rows = statement.query([])?;
    while let Some(row) = rows.next()? {
        let writes: serde_json::Value = serde_json::from_str(&row.get::<_, String>(0)?)?;
        let landing = &writes["landing"]["before"]["writes"]["queued"];
        for queued in [&writes["queued"], landing] {
            let Some(queued) = queued.as_array() else {
                continue;
            };
            for entry in queued {
                let Some(id) = entry["id"].as_str() else {
                    return Err(CoreError::Store(format!(
                        "a file's waiting write names no id: {entry}"
                    )));
                };
                named.insert(id.to_string());
            }
        }
    }
    let mut held = HashSet::new();
    for id in named {
        if queued_in_main(conn, &id)? {
            held.insert(id);
        }
    }
    Ok(held)
}

#[cfg(unix)]
fn queued_in_main(conn: &Connection, id: &str) -> Result<bool, CoreError> {
    Ok(conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM main.queue WHERE id = ?1)",
        [id],
        |row| row.get(0),
    )?)
}

pub fn meta_get(conn: &Connection, key: &str) -> Result<Option<String>, CoreError> {
    Ok(conn
        .prepare_cached("SELECT value FROM meta WHERE key = ?1")?
        .query_row([key], |row| row.get(0))
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

pub fn drain_owed(conn: &Connection) -> Result<bool, CoreError> {
    Ok(meta_get(conn, META_DRAIN_OWED)?.is_some())
}

pub fn set_drain_owed(conn: &Connection, owed: bool) -> Result<(), CoreError> {
    match (owed, drain_owed(conn)?) {
        (true, false) => meta_set(conn, META_DRAIN_OWED, "1"),
        (false, true) => meta_delete(conn, META_DRAIN_OWED),
        _ => Ok(()),
    }
}

pub fn meta_delete(conn: &Connection, key: &str) -> Result<(), CoreError> {
    conn.execute("DELETE FROM meta WHERE key = ?1", [key])?;
    Ok(())
}

/// Zero for a store whose copy has never changed.
pub fn copy_revision(conn: &Connection) -> Result<u64, CoreError> {
    match meta_get(conn, META_COPY_REVISION)? {
        Some(value) => value
            .parse()
            .map_err(|_| CoreError::Store(format!("the copy's revision {value:?} is no number"))),
        None => Ok(0),
    }
}

/// A record of the copy's changes: one row an id, numbered by its latest
/// change.
#[derive(Debug, Clone, Copy)]
pub(crate) enum Changes {
    /// `copy_changes`, where `''` stands for every item.
    Items,
    /// `edge_changes`.
    Edges,
}

impl Changes {
    fn table(self) -> (&'static str, &'static str) {
        match self {
            Changes::Items => ("copy_changes", "item_id"),
            Changes::Edges => ("edge_changes", "edge_id"),
        }
    }
}

/// The number of the latest change `of` holds, 0 for none.
pub(crate) fn last_change(conn: &Connection, of: Changes) -> Result<i64, CoreError> {
    let (table, _) = of.table();
    Ok(conn
        .prepare_cached(&format!("SELECT coalesce(max(seq), 0) FROM {table}"))?
        .query_row([], |row| row.get(0))?)
}

/// The ids changed after change `since`, or `None` where more than `most`
/// did or the types changed, which reaches every item.
pub(crate) fn changed_since(
    conn: &Connection,
    of: Changes,
    since: i64,
    most: usize,
) -> Result<Option<HashSet<String>>, CoreError> {
    let (table, column) = of.table();
    let mut statement = conn.prepare_cached(&format!(
        "SELECT {column} FROM {table} WHERE seq > ?1 LIMIT ?2"
    ))?;
    let ids = statement
        .query_map(
            params![since, i64::try_from(most).unwrap_or(i64::MAX - 1) + 1],
            |row| row.get::<_, String>(0),
        )?
        .collect::<rusqlite::Result<HashSet<String>>>()?;
    Ok((ids.len() <= most && !ids.contains("")).then_some(ids))
}

/// The latest change of an edge the copy let go of from `edge_changes`, 0
/// for none: the removals up to it are no longer named.
pub(crate) fn edge_changes_floor(conn: &Connection) -> Result<i64, CoreError> {
    match meta_get(conn, META_EDGE_CHANGES_FLOOR)? {
        Some(value) => value.parse().map_err(|_| {
            CoreError::Store(format!("the edge changes' floor {value:?} is no number"))
        }),
        None => Ok(0),
    }
}

/// Where `edge_changes` holds more than twice `keep` rows of edges the copy
/// no longer holds, lets go of those older than its latest `keep` changes,
/// and raises the floor to the latest let go. The slack makes this run about
/// once in `keep` removals rather than on every open past the limit, since
/// each run reads every held edge's row. A held edge keeps its row, so the
/// table holds at most a row for each held edge and twice `keep` more. A
/// cursor at or past the floor loses nothing, and one before it has seen at
/// least `keep` changes since. The latest row always stays, since the
/// triggers number the next change from it. Only the writer calls this: it
/// writes, and a reading handle never does.
pub(crate) fn prune_edge_changes(conn: &Connection, keep: usize) -> Result<(), CoreError> {
    let keep = i64::try_from(keep.max(1)).unwrap_or(i64::MAX / 2);
    let removed = |conn: &Connection| -> rusqlite::Result<i64> {
        conn.query_row(
            "SELECT (SELECT count(*) FROM edge_changes) - (SELECT count(*) FROM edges)",
            [],
            |row| row.get(0),
        )
    };
    if removed(conn)? <= keep * 2 {
        return Ok(());
    }
    let tx = rusqlite::Transaction::new_unchecked(conn, rusqlite::TransactionBehavior::Immediate)?;
    if removed(&tx)? <= keep * 2 {
        return Ok(());
    }
    let Some(oldest_kept) = tx
        .query_row(
            "SELECT seq FROM edge_changes ORDER BY seq DESC LIMIT 1 OFFSET ?1",
            [keep],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
    else {
        return Ok(());
    };
    let gone =
        "seq <= ?1 AND NOT EXISTS (SELECT 1 FROM edges WHERE edges.id = edge_changes.edge_id)";
    let floor: Option<i64> = tx.query_row(
        &format!("SELECT max(seq) FROM edge_changes WHERE {gone}"),
        [oldest_kept],
        |row| row.get(0),
    )?;
    if let Some(floor) = floor {
        tx.execute(&format!("DELETE FROM edge_changes WHERE {gone}"), [floor])?;
        meta_set(&tx, META_EDGE_CHANGES_FLOOR, &floor.to_string())?;
    }
    tx.commit()?;
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
    if meta_get(conn, META_EVENT_CURSOR)?
        .as_deref()
        .and_then(crate::reach::cursor)
        .is_none()
        || !meta_get(conn, crate::reach::FENCE)?.is_some_and(|f| crate::reach::valid_fence(&f))
        || !meta_get(conn, META_INSTANCE_ID)?.is_some_and(|instance| !instance.is_empty())
    {
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
    Ok(crate::reach::listed(conn, &item.id)?
        && slice_takes(
            catalog,
            &types,
            tier,
            &item.r#type,
            Tier::parse_wire(item.tier.as_deref())?,
        ))
}

pub const EVERY_TYPE: &str = "*";

/// Whether a declaration names the type, tier aside: `EVERY_TYPE` names every
/// type but `system.*`.
pub fn declares_type(catalog: &crate::catalog::Catalog, types: &[String], row_type: &str) -> bool {
    types.iter().any(|declared| {
        if declared == EVERY_TYPE {
            !is_system(row_type)
        } else {
            catalog.matches(declared, row_type)
        }
    })
}

/// `EVERY_TYPE` takes what a bare server listing answers, which leaves out
/// `system.*`. A `system.*` row named by type is taken at either tier: the
/// server stamps one a tier that says nothing about it, and a copy of the
/// feed still needs the folders it shows.
pub fn slice_takes(
    catalog: &crate::catalog::Catalog,
    types: &[String],
    tier: SliceTier,
    row_type: &str,
    row_tier: Option<Tier>,
) -> bool {
    let system = is_system(row_type);
    types.iter().any(|declared| {
        if declared == EVERY_TYPE {
            !system && tier.takes(row_tier)
        } else {
            catalog.matches(declared, row_type) && (system || tier.takes(row_tier))
        }
    })
}

pub(crate) fn is_system(r#type: &str) -> bool {
    r#type.starts_with("system.")
}

pub fn slice(conn: &Connection) -> Result<Option<(Vec<String>, SliceTier)>, CoreError> {
    let Some(tier) = meta_get(conn, META_SLICE_TIER)? else {
        return Ok(None);
    };
    let Some(types) = meta_get(conn, META_SLICE_TYPES)? else {
        return Ok(None);
    };
    Ok(Some((serde_json::from_str(&types)?, slice_tier(&tier)?)))
}

/// A value this build does not read is the store's fault, not the caller's.
pub fn slice_tier(stored: &str) -> Result<SliceTier, CoreError> {
    stored.parse().map_err(|_| {
        CoreError::Store(format!(
            "the store holds a slice tier this build does not read: {stored:?}"
        ))
    })
}

pub fn refuse_unless_hydrated(conn: &Connection) -> Result<(), CoreError> {
    if hydrated(conn)? {
        Ok(())
    } else {
        Err(CoreError::HydrationIncomplete)
    }
}

/// A copy that has never reached a server: no hydration has declared a slice.
/// It keeps what its app saves, which a hydration later sends.
pub fn never_synced(conn: &Connection) -> Result<bool, CoreError> {
    Ok(hydration_complete(conn)? && !holds_slice(conn)?)
}

/// For what a copy can do on its own but answer a list, a search or a read by
/// id (`read_completeness`): queue writes, follow edges, run a folder's pass. A
/// copy part way through a hydration, or one whose cursor has gone, is refused,
/// since what it holds is a piece of a copy or a copy that cannot be kept
/// current.
pub fn refuse_unless_usable(conn: &Connection) -> Result<(), CoreError> {
    if hydrated(conn)? || never_synced(conn)? {
        Ok(())
    } else {
        Err(CoreError::HydrationIncomplete)
    }
}

/// For a local list, search or read by id: a whole copy answers complete; one
/// whose cursor aged out answers the rows it held, as stale, until a hydration
/// fills it again in place; one a hydration has started and not completed
/// answers from the rows that have arrived, as partial. Any other expired copy
/// is refused.
pub fn read_completeness(conn: &Connection) -> Result<Completeness, CoreError> {
    if hydrated(conn)? || never_synced(conn)? {
        Ok(Completeness::Complete)
    } else if refilling(conn)? {
        Ok(Completeness::Stale)
    } else if !hydration_complete(conn)? {
        Ok(Completeness::Partial)
    } else {
        Err(CoreError::HydrationIncomplete)
    }
}

/// The instance and reach a copy whose cursor aged out was built under, which
/// a hydration under the same ones fills again in place, and the cursor it
/// held then.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Refill {
    pub instance: String,
    pub reach: String,
    /// A head behind it is a server restored to an earlier point, which may
    /// never have held the versions the copy holds.
    pub cursor: String,
}

pub fn refill(conn: &Connection) -> Result<Option<Refill>, CoreError> {
    Ok(meta_get(conn, META_REFILL)?.and_then(|json| serde_json::from_str(&json).ok()))
}

pub fn refilling(conn: &Connection) -> Result<bool, CoreError> {
    Ok(meta_get(conn, META_REFILL)?.is_some())
}

/// For a write queued against the copy: a whole copy, one waiting to be filled
/// again in place or being filled so, and one a hydration has started and not
/// completed all take one, sent once the copy is whole again. What the
/// write is to be queued against is told by `refuse_unless_held`.
pub fn refuse_unless_writable(conn: &Connection) -> Result<Completeness, CoreError> {
    read_completeness(conn)
}

/// For an edge write: a copy that is not whole takes none. A page still to
/// arrive can bring the server's edge, at another version or between other
/// ends, beneath a write queued against the edge the copy shows, and leave
/// that write to run against an edge nobody saw.
pub fn refuse_unless_whole(conn: &Connection) -> Result<(), CoreError> {
    refuse_unless_held(refuse_unless_writable(conn)?)
}

/// A row or an edge a copy that is not whole does not hold may be one the
/// server holds and has not yet brought, so a write to it is refused rather
/// than answered not found.
pub fn refuse_unless_held(completeness: Completeness) -> Result<(), CoreError> {
    match completeness {
        Completeness::Complete => Ok(()),
        Completeness::Stale | Completeness::Partial => Err(CoreError::HydrationIncomplete),
    }
}

/// Runs a local read under one snapshot, refused as `refuse_unless_usable`
/// refuses on that snapshot, so a hydration another handle commits between
/// the check and the read cannot slip in.
pub fn read_usable<T>(
    conn: &mut Connection,
    read: impl FnOnce(&Connection) -> Result<T, CoreError>,
) -> Result<T, CoreError> {
    let tx = conn.transaction()?;
    refuse_unless_usable(&tx)?;
    let answer = read(&tx)?;
    tx.commit()?;
    Ok(answer)
}

/// Runs a local read under one snapshot with the completeness it is marked
/// with, so a hydration another handle commits between the two cannot pair a
/// mark with rows from another state.
pub fn read_marked<T>(
    conn: &mut Connection,
    read: impl FnOnce(&Connection, Completeness) -> Result<T, CoreError>,
) -> Result<T, CoreError> {
    let tx = conn.transaction()?;
    let completeness = read_completeness(&tx)?;
    let answer = read(&tx, completeness)?;
    tx.commit()?;
    Ok(answer)
}

/// A row a partial copy does not hold may still be arriving, so its absence
/// is refused rather than answered. A stale copy answers what it holds.
pub fn held_or_refused<T>(
    found: Option<T>,
    completeness: Completeness,
) -> Result<Option<T>, CoreError> {
    match (found, completeness) {
        (None, Completeness::Partial) => Err(CoreError::HydrationIncomplete),
        (found, _) => Ok(found),
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
pub(crate) fn put_server_item(
    conn: &Connection,
    item: &WireItem,
    tags: Option<&[String]>,
    catalog: &crate::catalog::Catalog,
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
    upsert_item(conn, item, tags, &catalog.indexing(&item.r#type))?;
    keep_beneath_item(conn, &item.id, beneath_tags)?;
    if crate::body::rule::drops_on_landing(conn, &item.id)?
        && current_item_writes(conn, &item.id)?.is_empty()
    {
        crate::body::rule::landed(conn, catalog, &item.id)?;
    }
    Ok(true)
}

/// `put_server_item` for an edge.
pub(crate) fn put_server_edge(conn: &Connection, edge: &WireEdge) -> Result<bool, CoreError> {
    settle_read_back(conn, Subject::Edge, &edge.id)?;
    if refilling(conn)? {
        meta_set(conn, &edge_brought(&edge.id), "true")?;
    }
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
            let edge_type = match edge_ends(conn, id)? {
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
     conflicted_copy_id, refusals, queued_at, answered_at, blob, follows, payload, \
     environmental_streak, last_failure";

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

/// Refuses a body the server would refuse for its nesting
/// (`items/json-depth`), and that a later read of the queue could not parse.
/// One pass over the text, with no tree, so it also bounds a hostile value.
fn refuse_too_deep(payload: &str) -> Result<(), CoreError> {
    let (mut depth, mut in_string, mut escaped) = (0usize, false, false);
    for byte in payload.bytes() {
        if in_string {
            match (escaped, byte) {
                (true, _) => escaped = false,
                (false, b'\\') => escaped = true,
                (false, b'"') => in_string = false,
                _ => {}
            }
            continue;
        }
        match byte {
            b'"' => in_string = true,
            b'[' | b'{' => {
                depth += 1;
                if depth > crate::MAX_JSON_DEPTH {
                    return Err(CoreError::Invalid(format!(
                        "a write nests its JSON deeper than {} levels, counting the write's own",
                        crate::MAX_JSON_DEPTH
                    )));
                }
            }
            b']' | b'}' => depth = depth.saturating_sub(1),
            _ => {}
        }
    }
    Ok(())
}

/// The idempotency key is minted here, not at send: a key minted per send
/// would let a retry of a write whose answer was lost write it twice.
pub fn enqueue(conn: &Connection, write: &NewWrite<'_>) -> Result<QueuedWrite, CoreError> {
    refuse_too_deep(write.payload)?;
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

pub fn item_under_key(
    conn: &Connection,
    source: &str,
    source_id: &str,
) -> Result<Option<Item>, CoreError> {
    let id: Option<String> = conn.query_row(
        "SELECT id FROM items WHERE source = ?1 AND source_id = ?2 ORDER BY version DESC, id LIMIT 1",
        params![source, source_id], |row| row.get(0),
    ).optional()?;
    id.map(|id| item_by_id(conn, &id))
        .transpose()
        .map(Option::flatten)
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
    // A create refused onto a row no read has found yet still decides where a
    // later write to its row goes, or whether it goes at all.
    let landing = pending_landings(conn)?;
    Ok(read_writes(
        conn,
        "WHERE item_id = ?1 AND kind = ?2",
        [item_id, WriteKind::CreateItem.as_str()],
    )?
    .into_iter()
    .filter(|row| {
        matches!(row.verdict, None | Some(Verdict::Blocked | Verdict::Dead))
            || landing.contains_key(&row.id)
    })
    .map(|row| row.id)
    .collect())
}

/// The store's clock. A debug build moves it by the milliseconds the
/// `clock-offset` fault names, negative to put it back, so a fixture can pass
/// minutes between two drains, or have the clock go backward, without waiting.
fn clock() -> std::time::SystemTime {
    let now = std::time::SystemTime::now();
    match crate::fault::named("clock-offset").and_then(|ms| ms.parse::<i64>().ok()) {
        Some(ms) if ms >= 0 => now + std::time::Duration::from_millis(ms.unsigned_abs()),
        Some(ms) => now - std::time::Duration::from_millis(ms.unsigned_abs()),
        None => now,
    }
}

pub fn now_iso() -> String {
    iso_at(clock())
}

/// The store's clock as milliseconds since the Unix epoch.
pub fn now_millis() -> i64 {
    clock()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |since| since.as_millis() as i64)
}

pub(crate) fn iso_at(now: std::time::SystemTime) -> String {
    let now = now
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

type EditField = (bool, String);

#[derive(Default, serde::Serialize, serde::Deserialize)]
struct DeadEffect {
    attempt: String,
    excluded_attempts: HashSet<String>,
    fields: HashSet<EditField>,
    whole: bool,
}

fn effect_key(id: &str) -> String {
    format!("dead_effect/{id}")
}

fn chosen_tier_key(id: &str) -> String {
    format!("chosen_tier/{id}")
}

/// The tier a keyed create naming none was given by the copy's slice, which
/// the drain sends only where the server holds no row under its key.
pub fn choose_tier(conn: &Connection, id: &str, tier: Tier) -> Result<(), CoreError> {
    meta_set(conn, &chosen_tier_key(id), tier.as_str())
}

pub fn chosen_tier(conn: &Connection, id: &str) -> Result<Option<Tier>, CoreError> {
    meta_get(conn, &chosen_tier_key(id))?
        .map(|tier| tier.parse())
        .transpose()
}

const META_CREDENTIAL_SOURCE: &str = "credential_source";

/// The source the server stamps a write naming none with: the credential's
/// own (`items/source-own`), as `GET /keys/current` last answered it for the
/// credential `credential` names, a digest of it. `None` where that door
/// would not say, as for a signed-in app's token.
#[derive(serde::Serialize, serde::Deserialize)]
struct CredentialSource {
    credential: String,
    source: Option<String>,
}

pub fn learn_source(
    conn: &Connection,
    credential: &str,
    source: Option<&str>,
) -> Result<(), CoreError> {
    meta_set(
        conn,
        META_CREDENTIAL_SOURCE,
        &serde_json::to_string(&CredentialSource {
            credential: credential.into(),
            source: source.map(str::to_string),
        })?,
    )
}

/// What was learned for `credential`, and `None` where nothing was.
pub fn learned_source(
    conn: &Connection,
    credential: &str,
) -> Result<Option<Option<String>>, CoreError> {
    Ok(meta_get(conn, META_CREDENTIAL_SOURCE)?
        .map(|text| serde_json::from_str::<CredentialSource>(&text))
        .transpose()?
        .filter(|learned| learned.credential == credential)
        .map(|learned| learned.source))
}

/// What a credential is known by in the copy: a digest of what it sends,
/// never the credential itself.
pub fn credential_digest(authorization: &str) -> String {
    use sha2::Digest;
    hex::encode(sha2::Sha256::digest(authorization.as_bytes()))
}

/// The source a write naming `named`, or none, falls under: `named`, or the
/// source learned for `credential`, a digest of the credential the copy
/// sends with. `None` where nothing was learned for that credential, or the
/// copy has no credential to send with, so a drain asks.
pub fn source_of(
    conn: &Connection,
    named: Option<&str>,
    credential: Option<&str>,
) -> Result<Option<String>, CoreError> {
    if let Some(named) = named {
        return Ok(Some(named.into()));
    }
    let Some(credential) = credential else {
        return Ok(None);
    };
    Ok(learned_source(conn, credential)?.flatten())
}

pub fn unsent(conn: &Connection, id: &str) -> Result<bool, CoreError> {
    Ok(conn
        .query_row("SELECT sent FROM queue WHERE id = ?1", [id], |row| {
            row.get::<_, i64>(0)
        })
        .optional()?
        == Some(0))
}

/// Only before the write is first sent: the body sent is the one every
/// retry under its key sends again.
pub fn set_unsent_payload(conn: &Connection, id: &str, payload: &str) -> Result<(), CoreError> {
    conn.execute(
        "UPDATE queue SET payload = ?2 WHERE id = ?1 AND sent = 0",
        params![id, payload],
    )?;
    Ok(())
}

fn dead_effect(conn: &Connection, row: &QueuedWrite) -> Result<DeadEffect, CoreError> {
    let saved: DeadEffect = meta_get(conn, &effect_key(&row.id))?
        .map(|json| serde_json::from_str(&json))
        .transpose()?
        .unwrap_or_default();
    Ok(if saved.attempt == row.idempotency_key {
        saved
    } else {
        DeadEffect {
            attempt: row.idempotency_key.clone(),
            ..DeadEffect::default()
        }
    })
}

fn edit_fields(conn: &Connection, row: &QueuedWrite) -> Result<HashSet<EditField>, CoreError> {
    let mut fields = HashSet::new();
    if let Some(body) = row.body.as_object() {
        for (key, value) in body {
            if matches!(key.as_str(), "version" | "properties_mode" | "retype") {
                continue;
            }
            if key == "properties"
                && let Some(properties) = value.as_object()
            {
                fields.extend(
                    properties
                        .iter()
                        .filter(|(_, value)| {
                            row.kind == WriteKind::UpdateEdge
                                || !value.is_null()
                                || replaces_properties(&row.body)
                        })
                        .map(|(key, _)| (true, key.clone())),
                );
            } else {
                fields.insert((false, key.clone()));
            }
        }
    }
    if replaces_properties(&row.body)
        && let Some(read) = read_of(conn, &row.id)?
    {
        let read: Value = serde_json::from_str(&read)?;
        if let Some(properties) = read.get("properties").and_then(Value::as_object) {
            fields.extend(properties.keys().map(|key| (true, key.clone())));
        }
    }
    Ok(fields)
}

fn is_tag_write(row: &QueuedWrite) -> bool {
    matches!(
        row.kind,
        WriteKind::AddTag | WriteKind::RemoveTag | WriteKind::ReplaceMetadata
    )
}

fn tag_targets(row: &QueuedWrite) -> HashSet<String> {
    if row.kind == WriteKind::RemoveTag {
        return row.tag.iter().cloned().collect();
    }
    row.body
        .get("tags")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|tag| tag.as_str().map(str::to_string))
        .collect()
}

fn tag_field(tag: &str) -> EditField {
    (false, format!("tag/{tag}"))
}

fn same_tag_subject(a: &QueuedWrite, b: &QueuedWrite) -> bool {
    is_tag_write(a) && is_tag_write(b) && a.item_id.is_some() && a.item_id == b.item_id
}

fn supersedes_dead(later: &QueuedWrite, dead: &QueuedWrite) -> bool {
    match (dead.kind, later.kind) {
        (WriteKind::AddTag | WriteKind::RemoveTag, WriteKind::AddTag | WriteKind::RemoveTag) => {
            dead.item_id.is_some()
                && dead.item_id == later.item_id
                && dead.tag.is_some()
                && dead.tag == later.tag
        }
        (
            WriteKind::DeleteItem | WriteKind::RestoreItem | WriteKind::TransitionItem,
            WriteKind::DeleteItem | WriteKind::RestoreItem | WriteKind::TransitionItem,
        ) => dead.item_id.is_some() && dead.item_id == later.item_id,
        (WriteKind::CreateEdge | WriteKind::UpdateEdge, WriteKind::DeleteEdge)
        | (WriteKind::DeleteEdge, WriteKind::CreateEdge) => {
            dead.edge_id.is_some() && dead.edge_id == later.edge_id
        }
        (WriteKind::UploadBlob, WriteKind::UploadBlob) => {
            dead.blob.is_some() && dead.blob == later.blob
        }
        _ => {
            dead.kind == later.kind
                && dead.subject_id().is_some()
                && dead.subject_id() == later.subject_id()
                && dead.namespace == later.namespace
                && dead.body == later.body
        }
    }
}

fn learn_dead_effects(conn: &Connection, accepted: &QueuedWrite) -> Result<(), CoreError> {
    let older = read_writes(
        conn,
        "WHERE verdict = 'dead' AND seq < (SELECT seq FROM queue WHERE id = ?1)
          AND (item_id = ?2 OR edge_id = ?3 OR blob = ?4)",
        params![
            accepted.id,
            accepted.item_id,
            accepted.edge_id,
            accepted.blob
        ],
    )?;
    for dead in older {
        let mut effect = dead_effect(conn, &dead)?;
        if effect.excluded_attempts.contains(&accepted.idempotency_key) {
            continue;
        }
        if same_tag_subject(&dead, accepted) {
            if accepted.kind == WriteKind::ReplaceMetadata {
                effect.whole = true;
            } else {
                let original = tag_targets(&dead);
                let covered = tag_targets(accepted);
                effect.fields.extend(
                    covered
                        .iter()
                        .filter(|tag| {
                            dead.kind == WriteKind::ReplaceMetadata || original.contains(*tag)
                        })
                        .map(|tag| tag_field(tag)),
                );
                if original.is_empty()
                    && dead.kind != WriteKind::ReplaceMetadata
                    && dead.kind == accepted.kind
                    && dead.body == accepted.body
                {
                    effect.whole = true;
                }
            }
        } else if matches!(dead.kind, WriteKind::UpdateItem | WriteKind::UpdateEdge)
            && dead.kind == accepted.kind
            && match dead.kind {
                WriteKind::UpdateItem => dead.item_id.is_some() && dead.item_id == accepted.item_id,
                _ => dead.edge_id.is_some() && dead.edge_id == accepted.edge_id,
            }
        {
            let original = edit_fields(conn, &dead)?;
            let covered = edit_fields(conn, accepted)?;
            effect.fields.extend(
                original
                    .iter()
                    .filter(|field| {
                        covered.contains(*field) || (field.0 && replaces_properties(&accepted.body))
                    })
                    .cloned(),
            );
            if original.is_empty() && dead.body == accepted.body {
                effect.whole = true;
            }
        } else if supersedes_dead(accepted, &dead) {
            effect.whole = true;
        }
        if effect.whole || !effect.fields.is_empty() {
            meta_set(
                conn,
                &effect_key(&dead.id),
                &serde_json::to_string(&effect)?,
            )?;
        }
    }
    Ok(())
}

fn remaining_dead_fields(
    conn: &Connection,
    row: &QueuedWrite,
) -> Result<Option<HashSet<EditField>>, CoreError> {
    let effect = dead_effect(conn, row)?;
    if effect.whole {
        return Ok(Some(HashSet::new()));
    }
    if is_tag_write(row) && row.kind != WriteKind::ReplaceMetadata {
        let mut fields: HashSet<EditField> =
            tag_targets(row).iter().map(|tag| tag_field(tag)).collect();
        if fields.is_empty() {
            return Ok(None);
        }
        fields.retain(|field| !effect.fields.contains(field));
        return Ok(Some(fields));
    }
    if matches!(row.kind, WriteKind::UpdateItem | WriteKind::UpdateEdge) {
        let mut fields = edit_fields(conn, row)?;
        // An unrecognised or empty request remains held until an explicit
        // accepted equivalent settles it.
        if fields.is_empty() {
            return Ok(None);
        }
        fields.retain(|field| !effect.fields.contains(field));
        Ok(Some(fields))
    } else {
        Ok(None)
    }
}

/// Reports and projections use the same current attempt's effects. Queue
/// bodies and captured reads remain immutable, including after cleanup.
pub fn current_waiting_writes(
    conn: &Connection,
    queue: &[QueuedWrite],
) -> Result<Vec<QueuedWrite>, CoreError> {
    let mut waiting = Vec::new();
    for row in queue {
        if matches!(row.verdict, None | Some(Verdict::Blocked))
            || row.verdict == Some(Verdict::Dead)
                && remaining_dead_fields(conn, row)?.is_none_or(|fields| !fields.is_empty())
        {
            waiting.push(row.clone());
        }
    }
    Ok(waiting)
}

fn current_item_writes(conn: &Connection, id: &str) -> Result<Vec<QueuedWrite>, CoreError> {
    current_waiting_writes(conn, &waiting_writes_for_item(conn, id)?)
}

fn current_edge_writes(conn: &Connection, id: &str) -> Result<Vec<QueuedWrite>, CoreError> {
    current_waiting_writes(conn, &waiting_writes_for_edge(conn, id)?)
}

/// Raw unanswered and releasable work, even if its content effects are now
/// covered. Queue lifecycle and recovery guards must still protect it.
pub fn waiting_writes(conn: &Connection) -> Result<Vec<QueuedWrite>, CoreError> {
    read_writes(
        conn,
        "WHERE verdict IS NULL OR verdict IN (?1, ?2)",
        [Verdict::Blocked.as_str(), Verdict::Dead.as_str()],
    )
}

/// Whether any write is yet to be sent or answered. A write the server
/// answered, accepted or refused, or one released only by a person, has a
/// verdict.
pub fn has_unanswered_writes(conn: &Connection) -> Result<bool, CoreError> {
    Ok(conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM queue WHERE verdict IS NULL)",
        [],
        |row| row.get(0),
    )?)
}

/// The items with a create or edit the server has yet to answer: none
/// answered and none dead, since a dead write is not sent again unless it
/// is released.
pub fn items_awaiting_their_write(conn: &Connection) -> Result<HashSet<String>, CoreError> {
    let mut statement = conn.prepare(
        "SELECT DISTINCT item_id FROM queue
          WHERE kind IN (?1, ?2) AND item_id IS NOT NULL
            AND (verdict IS NULL OR verdict = ?3)",
    )?;
    let items = statement
        .query_map(
            [
                WriteKind::CreateItem.as_str(),
                WriteKind::UpdateItem.as_str(),
                Verdict::Blocked.as_str(),
            ],
            |row| row.get::<_, String>(0),
        )?
        .collect::<Result<HashSet<_>, _>>()?;
    Ok(items)
}

/// The largest size any file the copy holds states for the bytes `hash`
/// names, or `None` where none states one. Only `core.file` and its subtypes
/// state the size of their bytes, as the server stamps it. A row whose stored
/// properties are not JSON, or whose size is not a whole number above zero,
/// states none.
pub fn stated_size(conn: &Connection, hash: &str) -> Result<Option<u64>, CoreError> {
    let size: Option<i64> = conn.query_row(
        &format!(
            "WITH RECURSIVE {FILE_TYPES}
             SELECT MAX(size) FROM (
               SELECT CASE WHEN json_valid(properties) THEN
                        CASE WHEN json_extract(properties, '$.blob_ref') = ?1
                              AND json_type(properties, '$.size_bytes') = 'integer'
                             THEN json_extract(properties, '$.size_bytes') END
                      END AS size
                 FROM items AS f WHERE {IS_FILE})
             WHERE size > 0"
        ),
        [hash],
        |row| row.get(0),
    )?;
    Ok(size.and_then(|size| u64::try_from(size).ok()))
}

/// `core.file` and every type the catalog sets beneath it, as a common table
/// expression of a `WITH RECURSIVE`; `UNION` ends a cycle of parents.
const FILE_TYPES: &str = "file_types(id) AS (
    SELECT 'core.file'
    UNION SELECT types.id FROM types JOIN file_types ON types.parent = file_types.id)";

/// Whether the item `f` is of a file type, beneath `FILE_TYPES`.
const IS_FILE: &str = "(f.type LIKE 'core.file.%' OR f.type IN (SELECT id FROM file_types))";

/// A file item the copy holds that is attached to an item the copy holds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Attachment {
    pub item_id: String,
    /// The hash its `blob_ref` names, as written there.
    pub hash: String,
    /// The size it states for its bytes, if it states a whole number above
    /// zero.
    pub stated: Option<u64>,
}

/// Every file item the copy holds, out of the bin, that is the source of an
/// `attached-to` edge whose target the copy holds out of the bin. A row whose
/// stored properties are not JSON, or that names its bytes by no text, is
/// none.
pub fn attachments(conn: &Connection) -> Result<Vec<Attachment>, CoreError> {
    attachments_where(conn, "1", &[])
}

/// The attachments among `ids` and among the sources of `attached-to` edges
/// to `ids`: those a change to the rows or edges of `ids` can make or end.
fn attachments_touching(conn: &Connection, ids: &[&str]) -> Result<Vec<Attachment>, CoreError> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let marks = vec!["?"; ids.len()].join(", ");
    attachments_where(
        conn,
        &format!(
            "(f.id IN ({marks}) OR f.id IN (
               SELECT source_id FROM edges
                WHERE edge_type = '{ATTACHED_TO}' AND target_id IN ({marks})))"
        ),
        &[ids, ids].concat(),
    )
}

fn attachments_where(
    conn: &Connection,
    condition: &str,
    values: &[&str],
) -> Result<Vec<Attachment>, CoreError> {
    let sql = format!(
        "WITH RECURSIVE {FILE_TYPES}
         SELECT id, hash, size FROM (
           SELECT f.id AS id,
                  CASE WHEN json_valid(f.properties) THEN
                    CASE WHEN json_type(f.properties, '$.blob_ref') = 'text'
                         THEN json_extract(f.properties, '$.blob_ref') END
                  END AS hash,
                  CASE WHEN json_valid(f.properties) THEN
                    CASE WHEN json_type(f.properties, '$.size_bytes') = 'integer'
                         THEN json_extract(f.properties, '$.size_bytes') END
                  END AS size
             FROM items AS f
            WHERE {IS_FILE} AND f.state != 'trashed'
              AND EXISTS (
                SELECT 1 FROM edges AS e JOIN items AS t ON t.id = e.target_id
                 WHERE e.source_id = f.id AND e.edge_type = '{ATTACHED_TO}'
                   AND t.state != 'trashed')
              AND {condition})
          WHERE hash IS NOT NULL
          ORDER BY id"
    );
    let mut statement = conn.prepare_cached(&sql)?;
    let found = statement
        .query_map(params_from_iter(values), |row| {
            Ok(Attachment {
                item_id: row.get(0)?,
                hash: row.get(1)?,
                stated: row
                    .get::<_, Option<i64>>(2)?
                    .and_then(|size| u64::try_from(size).ok())
                    .filter(|size| *size > 0),
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(found)
}

/// How many sources of `attached-to` edges to items the copy holds out of
/// the bin the copy holds no row of.
pub fn attachments_not_in_copy(conn: &Connection) -> Result<u64, CoreError> {
    let outside: i64 = conn.query_row(
        &format!(
            "SELECT COUNT(DISTINCT e.source_id)
               FROM edges AS e JOIN items AS t ON t.id = e.target_id
              WHERE e.edge_type = '{ATTACHED_TO}' AND t.state != 'trashed'
                AND NOT EXISTS (SELECT 1 FROM items AS f WHERE f.id = e.source_id)"
        ),
        [],
        |row| row.get(0),
    )?;
    Ok(u64::try_from(outside).unwrap_or(0))
}

const ATTACHED_TO: &str = "attached-to";

/// Present from the start of a hydration until one completes: the copy is
/// not whole, so a file whose rows have not arrived again may still be an
/// attachment, and the kept set (`attachment_bytes`) only grows. Not cleared
/// when the copy expires, which can happen part way.
const META_ATTACHMENTS_GROWING: &str = "attachments_growing";

fn hexes(found: &[Attachment]) -> HashSet<String> {
    found
        .iter()
        .filter_map(|attachment| crate::blob::hex_of(&attachment.hash).ok())
        .map(str::to_string)
        .collect()
}

/// The bytes the file cache keeps for attachments, by the hex of their hash.
pub fn kept_attachments(conn: &Connection) -> Result<HashSet<String>, CoreError> {
    let mut statement = conn.prepare_cached("SELECT hex FROM attachment_bytes")?;
    let found = statement
        .query_map([], |row| row.get(0))?
        .collect::<Result<HashSet<String>, _>>()?;
    Ok(found)
}

/// Whether the kept set may only grow, because the copy is not whole.
pub fn attachments_growing(conn: &Connection) -> Result<bool, CoreError> {
    Ok(meta_get(conn, META_ATTACHMENTS_GROWING)?.is_some())
}

/// Called in the transaction that starts a hydration, before it clears the
/// copy.
pub fn attachments_start_growing(conn: &Connection) -> Result<(), CoreError> {
    meta_set(conn, META_ATTACHMENTS_GROWING, "1")
}

/// Called in the transaction that completes a hydration: the copy is whole,
/// so the kept set becomes exactly its attachments.
pub fn attachments_whole(conn: &Connection) -> Result<(), CoreError> {
    meta_delete(conn, META_ATTACHMENTS_GROWING)?;
    reconcile_attachments(conn)
}

/// Adds every attachment the copy holds to the kept set and, unless it is
/// growing, takes out the bytes no attachment names. For a store opened by
/// this build's writer, whose kept set may not have been kept.
pub fn reconcile_attachments(conn: &Connection) -> Result<(), CoreError> {
    let now = hexes(&attachments(conn)?);
    if !attachments_growing(conn)? {
        for hex in kept_attachments(conn)?.difference(&now) {
            conn.execute("DELETE FROM attachment_bytes WHERE hex = ?1", [hex])?;
        }
    }
    let mut insert =
        conn.prepare_cached("INSERT OR IGNORE INTO attachment_bytes (hex) VALUES (?1)")?;
    for hex in now {
        insert.execute([hex])?;
    }
    Ok(())
}

/// The kept bytes a change to the rows or edges of `ids` can end, read
/// before the change, for `attachments_changed` after it.
fn attachments_before(conn: &Connection, ids: &[&str]) -> Result<HashSet<String>, CoreError> {
    Ok(hexes(&attachments_touching(conn, ids)?))
}

/// Brings the kept set up to a change to the rows or edges of `ids`, in the
/// transaction that made it: the bytes of an attachment it made are added,
/// and the bytes in `before` that no attachment names now go, unless the set
/// is growing.
fn attachments_changed(
    conn: &Connection,
    ids: &[&str],
    before: HashSet<String>,
) -> Result<(), CoreError> {
    let now = hexes(&attachments_touching(conn, ids)?);
    let mut insert =
        conn.prepare_cached("INSERT OR IGNORE INTO attachment_bytes (hex) VALUES (?1)")?;
    for hex in &now {
        insert.execute([hex])?;
    }
    if before.is_subset(&now) || attachments_growing(conn)? {
        return Ok(());
    }
    for hex in before.difference(&now) {
        let named = [format!("{}{hex}", crate::blob::PREFIX), hex.clone()];
        let named: Vec<&str> = named.iter().map(String::as_str).collect();
        let condition = "CASE WHEN json_valid(f.properties)
                           THEN json_extract(f.properties, '$.blob_ref') END IN (?, ?)";
        if attachments_where(conn, condition, &named)?.is_empty() {
            conn.execute("DELETE FROM attachment_bytes WHERE hex = ?1", [hex])?;
        }
    }
    Ok(())
}

/// Why the last fetch of each kept attachment's bytes left them unheld, by
/// hex. Bytes that arrived, or no fetch has failed, have none.
pub fn attachment_misses(conn: &Connection) -> Result<HashMap<String, String>, CoreError> {
    let mut statement =
        conn.prepare_cached("SELECT hex, miss FROM attachment_bytes WHERE miss IS NOT NULL")?;
    let found = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<Result<HashMap<String, String>, _>>()?;
    Ok(found)
}

/// Writes down why a fetch left the bytes `hex` unheld, or clears it with
/// `None` once they arrive. Bytes no attachment names are left alone.
pub fn set_attachment_miss(
    conn: &Connection,
    hex: &str,
    reason: Option<&str>,
) -> Result<(), CoreError> {
    conn.execute(
        "UPDATE attachment_bytes SET miss = ?2 WHERE hex = ?1",
        params![hex, reason],
    )?;
    Ok(())
}

/// The bytes the cache keeps for the queue: those of every upload not yet
/// taken, and those of every taken upload a write that may still be sent
/// waits on, which a drain under another credential sends again
/// (`uploads_to_send_again`). A write may still be sent while it has no
/// verdict, is blocked or dead, or is refused unsent behind no withdrawn
/// write, as `release` decides: released, it waits on the upload again.
pub fn kept_uploads(conn: &Connection) -> Result<HashSet<String>, CoreError> {
    let mut statement = conn.prepare(
        "SELECT DISTINCT blob FROM queue
          WHERE kind = ?1 AND blob IS NOT NULL
            AND (verdict IS NULL OR verdict NOT IN (?2, ?3, ?4))",
    )?;
    let mut hashes = statement
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
    let mut statement = conn.prepare(
        "SELECT DISTINCT upload.blob, waiting.id, waiting.verdict = :refused
           FROM queue AS upload, queue AS waiting, json_each(waiting.depends_on) AS named
          WHERE upload.kind = :upload AND upload.blob IS NOT NULL
            AND upload.verdict IN (:accepted, :merged, :conflicted)
            AND named.value = upload.id
            AND (waiting.verdict IS NULL
                 OR waiting.verdict IN (:blocked, :dead)
                 OR waiting.verdict = :refused AND waiting.sent = 0)",
    )?;
    let waiting = statement
        .query_map(
            named_params! {
                ":upload": WriteKind::UploadBlob.as_str(),
                ":accepted": Verdict::Accepted.as_str(),
                ":merged": Verdict::Merged.as_str(),
                ":conflicted": Verdict::Conflicted.as_str(),
                ":blocked": Verdict::Blocked.as_str(),
                ":dead": Verdict::Dead.as_str(),
                ":refused": Verdict::Refused.as_str(),
            },
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, bool>(2)?,
                ))
            },
        )?
        .collect::<Result<Vec<_>, _>>()?;
    for (hash, waiting, refused) in waiting {
        if hashes.contains(&hash) || refused && waits_for_withdrawn(conn, &waiting)? {
            continue;
        }
        hashes.insert(hash);
    }
    Ok(hashes)
}

fn upload_sent_as_key(id: &str) -> String {
    format!("upload_sent_as/{id}")
}

/// The credential, as `credential_digest` names it, that the upload `id`
/// was last sent with.
pub fn record_upload_sent_as(
    conn: &Connection,
    id: &str,
    credential: &str,
) -> Result<(), CoreError> {
    meta_set(conn, &upload_sent_as_key(id), credential)
}

/// A renewal replaces the bearer a credential sends, not the credential:
/// the server credits an app's uploads to its grant, which the new token
/// carries.
pub fn move_uploads_sent_as(conn: &Connection, from: &str, to: &str) -> Result<(), CoreError> {
    conn.execute(
        "UPDATE meta SET value = ?2 WHERE key LIKE 'upload_sent_as/%' AND value = ?1",
        params![from, to],
    )?;
    Ok(())
}

/// Each taken upload, by its queue id and hash, that was sent with a
/// credential other than `credential` and that a write the next pass sends
/// waits on: one unanswered, or blocked for a reason that clears itself.
///
/// The server refuses a file write from a credential that neither sent its
/// bytes nor may read them (`blobs/proof-file-refused`). A write blocked for
/// good or dead is left until a release makes it unanswered, which the
/// record of the sending credential still covers.
pub fn uploads_to_send_again(
    conn: &Connection,
    credential: &str,
) -> Result<Vec<(String, String)>, CoreError> {
    let [credential_refused, awaiting] = SELF_CLEARING;
    let mut statement = conn.prepare(
        "SELECT upload.id, upload.blob FROM queue AS upload
          WHERE upload.kind = :upload AND upload.blob IS NOT NULL
            AND upload.verdict IN (:accepted, :merged, :conflicted)
            AND (SELECT value FROM meta WHERE key = 'upload_sent_as/' || upload.id)
                IS NOT :credential
            AND EXISTS (
              SELECT 1 FROM queue AS waiting, json_each(waiting.depends_on) AS named
               WHERE named.value = upload.id
                 AND (waiting.verdict IS NULL
                      OR waiting.verdict = :blocked
                         AND waiting.reason IN (:credential_refused, :awaiting))
            )
          ORDER BY upload.seq",
    )?;
    let rows = statement
        .query_map(
            named_params! {
                ":upload": WriteKind::UploadBlob.as_str(),
                ":accepted": Verdict::Accepted.as_str(),
                ":merged": Verdict::Merged.as_str(),
                ":conflicted": Verdict::Conflicted.as_str(),
                ":credential": credential,
                ":blocked": Verdict::Blocked.as_str(),
                ":credential_refused": credential_refused,
                ":awaiting": awaiting,
            },
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// A taken upload made unanswered, so the next pass sends it again before
/// the writes that wait on it. An upload carries no idempotency key: the
/// door is idempotent by content.
pub fn send_upload_again(conn: &Connection, id: &str) -> Result<(), CoreError> {
    conn.execute(
        "UPDATE queue
            SET verdict = NULL, reason = NULL, answer = NULL,
                conflicted_copy_id = NULL, answered_at = NULL,
                refusals = 0, sent = 0
          WHERE id = ?1 AND kind = ?2",
        params![id, WriteKind::UploadBlob.as_str()],
    )?;
    Ok(())
}

/// A keyed create's version-zero row can still name an unseen server target.
/// A natural key added by a later edit does not change a plain create's origin.
pub fn unanswered_keyed_create(conn: &Connection, item: &Item) -> Result<bool, CoreError> {
    if item.version != 0 {
        return Ok(false);
    }
    Ok(waiting_writes_for_item(conn, &item.id)?
        .iter()
        .any(|write| {
            write.kind == WriteKind::CreateItem
                && write
                    .body
                    .get("source_id")
                    .and_then(Value::as_str)
                    .is_some()
        }))
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

/// Raw waiting work through the index, including covered Dead rows that
/// remain releasable. Projection must explicitly request current effects.
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
            environmental_streak: row.get(20)?,
            last_failure: row.get(21)?,
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
        if verdict == Some(Verdict::Blocked)
            && raw.reason.as_deref() != Some(crate::model::AWAITING_DEPENDENCY)
        {
            raw.reason
                .as_deref()
                .unwrap_or_default()
                .parse::<BlockedReason>()
                .map_err(|_| {
                    CoreError::Store(format!(
                        "queued write {} is blocked for a reason outside the five a caller can name: {:?}",
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
        let last_failure = raw
            .last_failure
            .as_deref()
            .map(|json| {
                serde_json::from_str(json).map_err(|error| {
                    CoreError::Store(format!(
                        "queued write {} holds a last failure this build cannot read ({error})",
                        raw.id
                    ))
                })
            })
            .transpose()?;
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
            environmental_streak: raw.environmental_streak,
            last_failure,
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
    environmental_streak: i64,
    last_failure: Option<String>,
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
/// until a hydration replaces it. Left alone where a server's is held.
pub fn hold_local_catalog(conn: &Connection) -> Result<(), CoreError> {
    if catalog_version(conn)?.is_some() {
        return Ok(());
    }
    let shipped = crate::builtin::catalog()?;
    let mut types = shipped.types;
    for (id, json) in declared_type_rows(conn)? {
        types.push(serde_json::from_str(&json).map_err(|error| {
            CoreError::Store(format!("the declared type {id} cannot be read: {error}"))
        })?);
    }
    catalog_scope(conn, |conn| {
        replace_types(conn, &types)?;
        replace_edge_types(conn, &shipped.edge_types)?;
        meta_set(conn, META_LOCAL_CATALOG, "1")
    })
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
                thumbnail_field_of(&entry.rest),
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
        let (properties, _) = split_properties(&properties);
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
    let text = fts_text(properties, indexing);
    conn.execute("DELETE FROM items_fts WHERE rowid = ?1", [seq])?;
    if ItemState::from_str_checked(state)? != ItemState::Trashed {
        conn.execute(
            "INSERT INTO items_fts (rowid, title, body, description, name, extra, tags)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                seq,
                text.title,
                text.body,
                text.description,
                text.name,
                text.extra,
                tags.join(" ")
            ],
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
         DELETE FROM meta WHERE key LIKE 'item_listed/%' OR key LIKE 'edge_brought/%';",
    )?;
    Ok(())
}

fn edge_brought(id: &str) -> String {
    format!("edge_brought/{id}")
}

/// The start of a hydration that fills the copy again in place: nothing has
/// been brought yet, so every row and edge the copy holds is one the sweep at
/// its end takes out unless the walk or the replay brings it again.
pub fn start_refill(conn: &Connection) -> Result<(), CoreError> {
    conn.execute_batch(
        "DELETE FROM meta WHERE key LIKE 'item_listed/%' OR key LIKE 'edge_brought/%';",
    )?;
    Ok(())
}

/// The end of a hydration that filled the copy again in place, after its walk
/// and its replay: takes out each row neither brought, but for a pinned row
/// and one a waiting write names as its item or as an end of an edge, then
/// each such edge but one a waiting write names. Answers the rows and the
/// edges it took out.
pub fn sweep_refill(conn: &Connection) -> Result<(u64, u64), CoreError> {
    let unbrought = |sql: &str| -> Result<Vec<String>, CoreError> {
        let mut statement = conn.prepare(sql)?;
        let rows = statement.query_map([], |row| row.get(0))?;
        Ok(rows.collect::<Result<Vec<String>, _>>()?)
    };
    let whole = whole_edge_types(conn)?;
    // An edge write's ends are the columns it was queued with, the ends a
    // move in its payload names, and the ends the edge the copy shows has.
    let named: HashSet<String> = unbrought(&format!(
        "SELECT id FROM (
         SELECT item_id AS id FROM queue WHERE {WAITING}
         UNION SELECT target_id FROM queue WHERE {WAITING}
         UNION SELECT json_extract(payload, '$.source_id') FROM queue
                WHERE {WAITING} AND edge_id IS NOT NULL AND json_valid(payload)
         UNION SELECT json_extract(payload, '$.target_id') FROM queue
                WHERE {WAITING} AND edge_id IS NOT NULL AND json_valid(payload)
         UNION SELECT edges.source_id FROM edges JOIN queue ON queue.edge_id = edges.id
                WHERE {WAITING}
         UNION SELECT edges.target_id FROM edges JOIN queue ON queue.edge_id = edges.id
                WHERE {WAITING}
         ) WHERE id IS NOT NULL"
    ))?
    .into_iter()
    .collect();
    let mut items = 0;
    for id in unbrought(
        "SELECT id FROM items
          WHERE NOT EXISTS (SELECT 1 FROM meta WHERE key = 'item_listed/' || items.id)
            AND NOT EXISTS (SELECT 1 FROM pins WHERE pins.item_id = items.id)
          ORDER BY id",
    )? {
        if !named.contains(&id) && evict_item(conn, &id, &whole)? {
            items += 1;
        }
    }
    let mut edges = 0;
    for id in unbrought(
        "SELECT id FROM edges
          WHERE NOT EXISTS (SELECT 1 FROM meta WHERE key = 'edge_brought/' || edges.id)
          ORDER BY id",
    )? {
        if !edge_write_waits(conn, &id)? && forget_edge(conn, &id)? {
            edges += 1;
        }
    }
    conn.execute_batch("DELETE FROM meta WHERE key LIKE 'edge_brought/%';")?;
    meta_delete(conn, META_REFILL)?;
    Ok((items, edges))
}

/// `tags` replaces the item's tags when given and leaves them alone when not.
pub fn upsert_item(
    conn: &Connection,
    item: &WireItem,
    tags: Option<&[String]>,
    indexing: &Indexing,
) -> Result<(), CoreError> {
    ItemState::from_str_checked(&item.state)?;
    crate::body::rule::rows_changed(conn)?;
    crate::body::rule::item_changing(conn, &item.id, Some(item))?;
    let before = attachments_before(conn, &[&item.id])?;
    conn.execute(
        "INSERT INTO items (id, type, state, tier, version, schema_version, source, source_id, occurred_at, created_at, updated_at, properties, capture_latitude, capture_longitude)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
         ON CONFLICT (id) DO UPDATE SET
           type = excluded.type, state = excluded.state, tier = excluded.tier,
           version = excluded.version, schema_version = excluded.schema_version,
           source = excluded.source, source_id = excluded.source_id,
           occurred_at = excluded.occurred_at, created_at = excluded.created_at,
           updated_at = excluded.updated_at, properties = excluded.properties,
           capture_latitude = excluded.capture_latitude,
           capture_longitude = excluded.capture_longitude",
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
            js::json(&Value::Object(js::object_order(&item.properties))),
            item.capture_latitude,
            item.capture_longitude,
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
    index_row(conn, seq, &item.id, &item.state, &item.properties, indexing)?;
    attachments_changed(conn, &[&item.id], before)
}

/// Moves everything the copy says about the minted id `local` onto
/// `answered`, the id the server answered its create with: a create carrying
/// a natural key the server holds lands on that row.
pub fn adopt_answered_id(conn: &Connection, local: &str, answered: &str) -> Result<(), CoreError> {
    if local == answered {
        return Ok(());
    }
    let before = attachments_before(conn, &[local, answered])?;
    rename_shown_edges(conn, local, answered)?;
    conn.execute(
        "DELETE FROM items_fts WHERE rowid IN (SELECT seq FROM items WHERE id = ?1)",
        [local],
    )?;
    conn.execute("DELETE FROM tags WHERE item_id = ?1", [local])?;
    conn.execute("DELETE FROM items WHERE id = ?1", [local])?;
    for statement in [
        "UPDATE edges SET source_id = ?2 WHERE source_id = ?1",
        "UPDATE edges SET target_id = ?2 WHERE target_id = ?1",
        "UPDATE queue SET item_id = ?2 WHERE item_id = ?1 AND
         (sent = 0 OR (kind = 'create_item' AND verdict IN ('accepted', 'merged', 'conflicted', 'refused')))",
        "UPDATE queue SET target_id = ?2 WHERE target_id = ?1 AND sent = 0",
        "UPDATE body_checks SET item_id = ?2 WHERE item_id = ?1",
        "UPDATE body_edges SET item_id = ?2 WHERE item_id = ?1",
        "UPDATE body_edges SET other_id = ?2 WHERE other_id = ?1",
        "UPDATE body_names SET other_id = ?2 WHERE other_id = ?1",
        "UPDATE folder_files SET item_id = ?2 WHERE item_id = ?1",
        "UPDATE folder_journal SET item_id = ?2 WHERE item_id = ?1",
    ] {
        conn.execute(statement, params![local, answered])?;
    }
    // The names the create's body carries are the row's now; the landing
    // drops any its answered body does not carry.
    if conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM body_names WHERE item_id = ?1)",
        [local],
        |row| row.get(0),
    )? {
        conn.execute("DELETE FROM body_names WHERE item_id = ?1", [answered])?;
        conn.execute(
            "UPDATE body_names SET item_id = ?2 WHERE item_id = ?1",
            params![local, answered],
        )?;
    }
    let carried = pinned(conn, local)?;
    if conn.execute(
        "UPDATE OR IGNORE pins SET item_id = ?2 WHERE item_id = ?1",
        params![local, answered],
    )? > 0
    {
        crate::reach::pins_changed(conn)?;
    }
    // Left where the server's row was pinned already.
    unpin(conn, local)?;
    // The create's pin is somebody's own on the row it lands on, so the
    // release of a pin the body rule or a folder line made there must not
    // take it.
    if carried {
        conn.execute("DELETE FROM body_pins WHERE item_id = ?1", [answered])?;
        crate::folder::state::disown_edge_end(conn, answered)?;
    }
    drop_beneath(conn, Subject::Item, local)?;
    settle_read_back(conn, Subject::Item, local)?;
    // The writes just moved onto `answered` wait on the row as the copy
    // holds it now, which nothing has laid them over yet.
    if beneath_row(conn, Subject::Item, answered)?.is_none() {
        keep_beneath_item(conn, answered, None)?;
    }
    // Unsent blocked/dead work needs the same identity as its columns.
    // Once sent, both the request body and its addressed row keep their
    // original meaning under the original idempotency key.
    let mut edges = conn.prepare(
        "SELECT id, payload FROM queue WHERE kind IN ('create_edge', 'update_edge') AND sent = 0
         AND (verdict IS NULL OR verdict IN ('blocked', 'dead', 'refused'))",
    )?;
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
    // A create drawn to the minted row is drawn to `answered`.
    let creates = read_writes(
        conn,
        "WHERE kind = ?1 AND sent = 0 AND (verdict IS NULL OR verdict IN ('blocked', 'dead', 'refused'))",
        [WriteKind::CreateItem.as_str()],
    )?;
    for row in creates {
        let mut body: Value = serde_json::from_str(&payload_of(conn, &row.id)?)?;
        let mut moved = false;
        if let Some(edges) = body.get_mut("edges").and_then(Value::as_object_mut) {
            for target in edges.values_mut().filter_map(Value::as_array_mut).flatten() {
                if target.as_str() == Some(local) {
                    *target = Value::String(answered.to_string());
                    moved = true;
                }
            }
        }
        if moved {
            conn.execute(
                "UPDATE queue SET payload = ?2 WHERE id = ?1",
                params![row.id, body.to_string()],
            )?;
        }
    }
    attachments_changed(conn, &[local, answered], before)
}

/// An edge a waiting create is shown with is named by its ends
/// ([`crate::model::projected_edge_id`]), so where one end moves from `local`
/// to `answered` the edge takes the name of its new ends.
fn rename_shown_edges(conn: &Connection, local: &str, answered: &str) -> Result<(), CoreError> {
    let mut shown = conn.prepare(
        "SELECT id, source_id, target_id, edge_type FROM edges
          WHERE version = 0 AND (source_id = ?1 OR target_id = ?1)",
    )?;
    let ends: Vec<(String, String, String, String)> = shown
        .query_map([local], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })?
        .collect::<Result<_, _>>()?;
    let moved = |end: &str| if end == local { answered } else { end }.to_string();
    for (id, source, target, edge_type) in ends {
        if id != crate::model::projected_edge_id(&source, &edge_type, &target) {
            continue;
        }
        let Some(edge) = edge_ends(conn, &id)? else {
            continue;
        };
        let mut wire = edge.as_wire();
        wire.source_id = moved(&source);
        wire.target_id = moved(&target);
        wire.id = crate::model::projected_edge_id(&wire.source_id, &edge_type, &wire.target_id);
        forget_edge(conn, &id)?;
        upsert_edge(conn, &wire)?;
    }
    Ok(())
}

/// Moves the copy onto `answered`, the held row a refused create's natural
/// key resolved, and returns the dependent writes it refused. Only writes
/// that add (a tag, an edge, an edge's end moved to it, an item drawn to it)
/// carry over: any other was made against this device's row and would act on
/// another device's.
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
            WriteKind::AddTag
            | WriteKind::CreateEdge
            | WriteKind::UpdateEdge
            | WriteKind::CreateItem => false,
            WriteKind::UpdateItem
            | WriteKind::DeleteItem
            | WriteKind::RestoreItem
            | WriteKind::TransitionItem
            | WriteKind::ReplaceMetadata
            | WriteKind::RemoveTag
            | WriteKind::WriteExtension
            | WriteKind::DeleteExtension => true,
            // Not written against an item's create, so never one of its
            // dependants; refused all the same should one ever be.
            WriteKind::DeleteEdge | WriteKind::UploadBlob => true,
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

/// A pinned row's purge is remembered, even past a later pin of the gone
/// row, so whatever pinned it can tell a purge from a row it can no longer
/// read; `forget_purged` lets it go.
pub fn purge_item(conn: &Connection, id: &str) -> Result<bool, CoreError> {
    // Even an unheld row may be on its way in an outstanding door readback.
    crate::reach::purged(conn)?;
    let unpinned = unpin(conn, id)?;
    if unpinned {
        meta_set(conn, &purged_key(id), "true")?;
    }
    let removed = remove_item(conn, id, "source_id = ?1 OR target_id = ?1", &[])?;
    Ok(removed || unpinned)
}

/// Keeps the edges of a type in `whole`, edges drawn to the item, as a
/// hydration holds them, and an edge a waiting write names, with what is kept
/// beneath it, until that write is answered.
pub fn evict_item(conn: &Connection, id: &str, whole: &[String]) -> Result<bool, CoreError> {
    crate::body::rule::rows_changed(conn)?;
    crate::body::rule::item_changing(conn, id, None)?;
    let kept = vec!["?"; whole.len()].join(", ");
    let waits =
        format!("id NOT IN (SELECT edge_id FROM queue WHERE edge_id IS NOT NULL AND {WAITING})");
    let edges = if whole.is_empty() {
        format!("source_id = ?1 AND {waits}")
    } else {
        format!("source_id = ?1 AND edge_type NOT IN ({kept}) AND {waits}")
    };
    remove_item(conn, id, &edges, whole)
}

/// A queued write the server has yet to take: unanswered, blocked or dead,
/// as `waiting_writes` reads them.
const WAITING: &str = "(verdict IS NULL OR verdict IN ('blocked', 'dead'))";

/// The one way a row leaves the copy, with the edges `edges` names (a
/// condition on `edges`, `?1` the row's id, then `kept`): what is kept
/// beneath them goes too. Read-back debt requires independent certified
/// settlement. Whether the copy changed: a purge of an
/// item already evicted still takes the edges held items drew to it.
fn remove_item(
    conn: &Connection,
    id: &str,
    edges: &str,
    kept: &[String],
) -> Result<bool, CoreError> {
    let before = attachments_before(conn, &[id])?;
    crate::reach::forget_listed(conn, id)?;
    drop_beneath(conn, Subject::Item, id)?;
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
    let removed = conn.execute("DELETE FROM items WHERE id = ?1", [id])? > 0;
    attachments_changed(conn, &[id], before)?;
    Ok(removed || changed)
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
    let Some(edge) = edge_ends(conn, id)? else {
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

/// The start of the meta key that remembers a pinned row's purge.
pub(crate) const PURGED_PIN: &str = "purged_pin/";

fn purged_key(id: &str) -> String {
    format!("{PURGED_PIN}{id}")
}

pub fn purged(conn: &Connection, id: &str) -> Result<bool, CoreError> {
    Ok(meta_get(conn, &purged_key(id))?.is_some())
}

pub fn forget_purged(conn: &Connection, id: &str) -> Result<(), CoreError> {
    meta_delete(conn, &purged_key(id))
}

/// Whether it was not pinned already.
pub fn pin(conn: &Connection, id: &str) -> Result<bool, CoreError> {
    // A pin asked for again is somebody's own, which the body rule's release
    // must not take.
    conn.execute("DELETE FROM body_pins WHERE item_id = ?1", [id])?;
    let changed = conn.execute("INSERT OR IGNORE INTO pins (item_id) VALUES (?1)", [id])? > 0;
    if changed {
        crate::reach::pins_changed(conn)?;
    }
    Ok(changed)
}

/// Whether it was pinned.
pub fn unpin(conn: &Connection, id: &str) -> Result<bool, CoreError> {
    let changed = conn.execute("DELETE FROM pins WHERE item_id = ?1", [id])? > 0;
    if changed {
        crate::reach::pins_changed(conn)?;
    }
    Ok(changed)
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
    crate::body::rule::edge_changing(conn, edge)?;
    let mut ends = edge_sources(conn, &edge.id)?;
    ends.push(edge.source_id.clone());
    let ends: Vec<&str> = ends.iter().map(String::as_str).collect();
    let before = attachments_before(conn, &ends)?;
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
            Value::Object(js::object_order(&edge.properties)).to_string(),
            edge.version,
            edge.created_at,
            edge.updated_at,
        ],
    )?;
    attachments_changed(conn, &ends, before)
}

/// The source of the edge `id` as the copy holds it, which a change to the
/// edge can make or end an attachment of.
fn edge_sources(conn: &Connection, id: &str) -> Result<Vec<String>, CoreError> {
    let mut statement = conn.prepare_cached("SELECT source_id FROM edges WHERE id = ?1")?;
    let found = statement
        .query_map([id], |row| row.get(0))?
        .collect::<Result<Vec<String>, _>>()?;
    Ok(found)
}

/// Takes the edge out of what the copy shows and nothing else: for a write
/// of this device's laid over it. An edge leaving the copy goes by
/// `forget_edge`.
pub fn delete_edge(conn: &Connection, id: &str) -> Result<bool, CoreError> {
    crate::body::rule::edge_leaving(conn, id)?;
    let ends = edge_sources(conn, id)?;
    let ends: Vec<&str> = ends.iter().map(String::as_str).collect();
    let before = attachments_before(conn, &ends)?;
    let deleted = conn.execute("DELETE FROM edges WHERE id = ?1", [id])? > 0;
    attachments_changed(conn, &ends, before)?;
    Ok(deleted)
}

/// The edge and its baseline leave together. Read-back debt requires its own
/// certified settlement, including when local unpinning removes this edge.
pub fn forget_edge(conn: &Connection, id: &str) -> Result<bool, CoreError> {
    drop_beneath(conn, Subject::Edge, id)?;
    delete_edge(conn, id)
}

/// Nothing for a trashed row, as the server answers a read by id.
pub fn item_by_id(conn: &Connection, id: &str) -> Result<Option<Item>, CoreError> {
    item_by_id_with(conn, id, &mut Unreadable::Refuse)
}

pub fn item_by_id_with(
    conn: &Connection,
    id: &str,
    unreadable: &mut Unreadable,
) -> Result<Option<Item>, CoreError> {
    let mut items = items_by_ids_with(conn, std::slice::from_ref(&id.to_string()), unreadable)?;
    Ok(items.pop().filter(|item| item.state != ItemState::Trashed))
}

/// `ids` without repeats, each where it was first named.
pub(crate) fn unique(ids: &[String]) -> Vec<&str> {
    let mut seen = HashSet::with_capacity(ids.len());
    ids.iter()
        .map(String::as_str)
        .filter(|id| seen.insert(*id))
        .collect()
}

/// The counts an `IN` list is padded to, so the statement cache holds a few
/// shapes of each query rather than one for every count of ids.
const IN_LIST_SIZES: [usize; 4] = [1, 16, 128, 500];

/// `ids` in chunks for `IN (...)`, each beside its placeholders and padded
/// with its last id to one of `IN_LIST_SIZES`. A repeat in an `IN` list
/// matches its row once.
pub(crate) fn in_lists<'a>(
    ids: &'a [&'a str],
) -> impl Iterator<Item = (String, Vec<&'a str>)> + 'a {
    ids.chunks(IN_LIST_SIZES[IN_LIST_SIZES.len() - 1])
        .map(|chunk| {
            let size = IN_LIST_SIZES
                .into_iter()
                .find(|size| *size >= chunk.len())
                .unwrap_or(chunk.len());
            let mut padded = chunk.to_vec();
            padded.resize(size, chunk[chunk.len() - 1]);
            (vec!["?"; size].join(", "), padded)
        })
}

/// Items for `ids`, in the order given, skipping ids not held.
pub fn items_by_ids(conn: &Connection, ids: &[String]) -> Result<Vec<Item>, CoreError> {
    items_by_ids_with(conn, ids, &mut Unreadable::Refuse)
}

/// `items_by_ids`, with `unreadable` deciding what a row whose stored
/// properties cannot be read does.
pub fn items_by_ids_with(
    conn: &Connection,
    ids: &[String],
    unreadable: &mut Unreadable,
) -> Result<Vec<Item>, CoreError> {
    let ids = unique(ids);
    let mut by_id: HashMap<String, Item> = HashMap::new();
    for (placeholders, chunk) in in_lists(&ids) {
        let sql = format!("SELECT {ITEM_COLUMNS} FROM items WHERE id IN ({placeholders})");
        let mut statement = conn.prepare_cached(&sql)?;
        let rows = statement.query_map(params_from_iter(chunk), read_item)?;
        for row in rows {
            let (item, why) = row?;
            if let Some(why) = why {
                unreadable.note("item", &item.id, why)?;
            }
            by_id.insert(item.id.clone(), item);
        }
    }
    let tags = tags_for(conn, &ids)?;
    Ok(ids
        .iter()
        .filter_map(|id| by_id.remove(*id))
        .map(|mut item| {
            item.tags = tags.get(&item.id).cloned().unwrap_or_default();
            item
        })
        .collect())
}

/// Items matching `where_sql`, with `unreadable` deciding what a row whose
/// stored properties cannot be read does.
pub fn items_where(
    conn: &Connection,
    where_sql: &str,
    order_sql: &str,
    limit_sql: &str,
    values: &[Value],
    unreadable: &mut Unreadable,
) -> Result<Vec<Item>, CoreError> {
    let sql = format!("SELECT {ITEM_COLUMNS} FROM items WHERE {where_sql} {order_sql} {limit_sql}");
    let mut statement = conn.prepare(&sql)?;
    let params = values.iter().map(sql_value).collect::<Vec<_>>();
    let rows = statement.query_map(params_from_iter(params.iter()), read_item)?;
    let mut items = Vec::new();
    for row in rows {
        let (item, why) = row?;
        if let Some(why) = why {
            unreadable.note("item", &item.id, why)?;
        }
        items.push(item);
    }
    let ids: Vec<&str> = items.iter().map(|item| item.id.as_str()).collect();
    let tags = tags_for(conn, &ids)?;
    for item in &mut items {
        item.tags = tags.get(&item.id).cloned().unwrap_or_default();
    }
    Ok(items)
}

pub fn edges_from(conn: &Connection, source_id: &str) -> Result<Vec<Edge>, CoreError> {
    edges_at(conn, "source_id", source_id, &mut Unreadable::Refuse)
}

pub fn edges_to(conn: &Connection, target_id: &str) -> Result<Vec<Edge>, CoreError> {
    edges_at(conn, "target_id", target_id, &mut Unreadable::Refuse)
}

/// The items at the other end of each edge of `id` that is not of type
/// `except`, read from the ends alone so an edge whose properties cannot be
/// read still names them.
pub(crate) fn edge_neighbors(
    conn: &Connection,
    id: &str,
    except: &str,
) -> Result<Vec<(String, String)>, CoreError> {
    let mut statement = conn.prepare_cached(
        "SELECT source_id, target_id FROM edges
          WHERE (source_id = ?1 OR target_id = ?1) AND edge_type != ?2",
    )?;
    let ends = statement
        .query_map(params![id, except], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(ends)
}

pub fn edges_of_type(conn: &Connection, edge_type: &str) -> Result<Vec<Edge>, CoreError> {
    edges_at(conn, "edge_type", edge_type, &mut Unreadable::Refuse)
}

/// `column` is spliced into the query, so it is a literal, never a caller's text.
pub fn edges_at(
    conn: &Connection,
    column: &'static str,
    value: &str,
    unreadable: &mut Unreadable,
) -> Result<Vec<Edge>, CoreError> {
    let sql =
        format!("SELECT {EDGE_COLUMNS} FROM edges WHERE {column} = ?1 ORDER BY created_at, id");
    let mut statement = conn.prepare_cached(&sql)?;
    let rows = statement.query_map([value], read_edge)?;
    let mut edges = Vec::new();
    for row in rows {
        let (edge, why) = row?;
        if let Some(why) = why {
            unreadable.note("edge", &edge.id, why)?;
        }
        edges.push(edge);
    }
    Ok(edges)
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

/// `ids` holds no repeat.
fn tags_for(conn: &Connection, ids: &[&str]) -> Result<HashMap<String, Vec<String>>, CoreError> {
    let mut tags: HashMap<String, Vec<String>> = HashMap::new();
    // Reading a tag in turn costs about a quarter of looking up a row's tags
    // by id, so where the copy holds at most four tags for each row asked,
    // as for a listing of most of it, every tag is read once instead.
    if ids.len() > 1000
        && conn.query_row("SELECT count(*) FROM tags", [], |row| row.get::<_, i64>(0))?
            <= i64::try_from(ids.len())
                .unwrap_or(i64::MAX)
                .saturating_mul(4)
    {
        let wanted: HashSet<&str> = ids.iter().copied().collect();
        let mut statement =
            conn.prepare_cached("SELECT item_id, tag FROM tags ORDER BY item_id, tag")?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (item_id, tag) = row?;
            if wanted.contains(item_id.as_str()) {
                tags.entry(item_id).or_default().push(tag);
            }
        }
        return Ok(tags);
    }
    for (placeholders, chunk) in in_lists(ids) {
        let sql = format!(
            "SELECT item_id, tag FROM tags WHERE item_id IN ({placeholders}) ORDER BY item_id, tag"
        );
        let mut statement = conn.prepare_cached(&sql)?;
        let rows = statement.query_map(params_from_iter(chunk), |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (item_id, tag) = row?;
            tags.entry(item_id).or_default().push(tag);
        }
    }
    Ok(tags)
}

/// A row of `items`, with why its properties are empty where the stored text
/// could not be read.
fn read_item(row: &rusqlite::Row<'_>) -> rusqlite::Result<(Item, Option<String>)> {
    let state: String = row.get(2)?;
    let tier: Option<String> = row.get(3)?;
    let properties: String = row.get(11)?;
    let (properties, why) = split_properties(&properties);
    let item = Item {
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
        properties,
        capture_latitude: row.get(12)?,
        capture_longitude: row.get(13)?,
        tags: Vec::new(),
    };
    Ok((item, why))
}

fn read_edge(row: &rusqlite::Row<'_>) -> rusqlite::Result<(Edge, Option<String>)> {
    let properties: String = row.get(4)?;
    let (properties, why) = split_properties(&properties);
    let edge = Edge {
        id: row.get(0)?,
        source_id: row.get(1)?,
        target_id: row.get(2)?,
        edge_type: row.get(3)?,
        properties,
        version: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    };
    Ok((edge, why))
}

const UNREADABLE_PROPERTIES: &str = "the properties of ";

/// Whether a refusing read failed on a row whose stored properties are not
/// one JSON object, rather than on the store.
pub(crate) fn unreadable(error: &CoreError) -> bool {
    matches!(error, CoreError::Store(message) if message.starts_with(UNREADABLE_PROPERTIES))
}

/// What a read does with a row whose stored properties are not one JSON
/// object. The text is not echoed: it is the person's content.
pub enum Unreadable {
    /// The read fails.
    Refuse,
    /// The row stays, with no properties, and its id is noted with the reason.
    Keep(HashMap<String, String>),
}

impl Unreadable {
    pub fn why(&self, id: &str) -> Option<String> {
        match self {
            Unreadable::Refuse => None,
            Unreadable::Keep(kept) => kept.get(id).cloned(),
        }
    }

    fn note(&mut self, kind: &str, id: &str, why: String) -> Result<(), CoreError> {
        match self {
            Unreadable::Refuse => Err(CoreError::Store(format!(
                "{UNREADABLE_PROPERTIES}{kind} {id} cannot be read: {why}"
            ))),
            Unreadable::Keep(kept) => {
                kept.insert(id.to_string(), why);
                Ok(())
            }
        }
    }
}

/// The stored properties, or none and why they could not be read.
fn split_properties(text: &str) -> (Map<String, Value>, Option<String>) {
    match serde_json::from_str::<Value>(text) {
        Ok(Value::Object(map)) => (map, None),
        Ok(_) => (
            Map::new(),
            Some("the stored text is not a JSON object".into()),
        ),
        Err(error) => (
            Map::new(),
            Some(format!("the stored text is not JSON ({error})")),
        ),
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

/// What one row contributes to the index, column by column.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct FtsText {
    pub title: String,
    pub body: String,
    pub description: String,
    pub name: String,
    pub extra: String,
}

/// The server's rule: the four core properties when they hold a string, the
/// type's other declared string properties joined by a space, and nothing the
/// type does not declare. A thumbnail is not a string property, so its base64
/// is never indexed.
pub fn fts_text(properties: &Map<String, Value>, indexing: &Indexing) -> FtsText {
    let core = |name: &str| -> String {
        if indexing.opted_out.iter().any(|opted| opted == name) {
            return String::new();
        }
        properties
            .get(name)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    let extra: Vec<&str> = indexing
        .extra
        .iter()
        .filter_map(|name| properties.get(name).and_then(Value::as_str))
        .filter(|text| !text.is_empty())
        .collect();
    FtsText {
        title: core("title"),
        body: core("body"),
        description: core("description"),
        name: core("name"),
        extra: extra.join(" "),
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

/// Marks the write sent and numbers the send, one past the highest number any
/// write holds, in the one statement. The order of sends is a number rather
/// than a time so a clock set back cannot reorder it.
pub fn mark_sent(conn: &Connection, id: &str) -> Result<(), CoreError> {
    conn.execute(
        "UPDATE queue
            SET sent = 1,
                last_sent_seq = (SELECT COALESCE(MAX(last_sent_seq), 0) + 1 FROM queue)
          WHERE id = ?1",
        [id],
    )?;
    Ok(())
}

/// The number of the write's last send, or nothing for one never sent. The
/// lower number is the earlier send.
pub fn last_sent_seq(conn: &Connection, id: &str) -> Result<Option<i64>, CoreError> {
    Ok(conn
        .query_row(
            "SELECT last_sent_seq FROM queue WHERE id = ?1",
            [id],
            |row| row.get(0),
        )
        .optional()?
        .flatten())
}

/// Only on an answer that proves the attempt was not applied anywhere.
pub fn mark_unsent(conn: &Connection, id: &str) -> Result<(), CoreError> {
    conn.execute("UPDATE queue SET sent = 0 WHERE id = ?1", [id])?;
    Ok(())
}

pub fn record_verdict(
    conn: &Connection,
    id: &str,
    answered: &Answered<'_>,
) -> Result<(), CoreError> {
    catalog_scope(conn, |conn| record_verdict_inner(conn, id, answered))
}

fn record_verdict_inner(
    conn: &Connection,
    id: &str,
    answered: &Answered<'_>,
) -> Result<(), CoreError> {
    let already_accepted =
        queued_write(conn, id)?.is_some_and(|row| row.verdict == Some(Verdict::Accepted));
    let changed = conn.execute(
        "UPDATE queue
            SET verdict = ?2, reason = ?3, answer = ?4,
                conflicted_copy_id = ?5, answered_at = ?6,
                environmental_streak = CASE WHEN ?7 THEN environmental_streak ELSE 0 END,
                environmental_since = CASE WHEN ?7 THEN environmental_since ELSE NULL END,
                environmental_last = CASE WHEN ?7 THEN environmental_last ELSE NULL END,
                last_failure = CASE WHEN ?7 THEN last_failure ELSE NULL END
          WHERE id = ?1",
        params![
            id,
            answered.verdict.as_str(),
            answered.reason,
            answered.answer,
            answered.conflicted_copy_id,
            now_iso(),
            answered.verdict == Verdict::Blocked
                && answered.reason == Some(BlockedReason::FailingAlone.as_str()),
        ],
    )?;
    if changed == 0 {
        return Err(CoreError::Store(format!(
            "no queued write {id} to answer; the row went while the drain was sending it"
        )));
    }
    if answered.verdict == Verdict::Accepted {
        meta_delete(conn, &effect_key(id))?;
    }
    if answered.verdict == Verdict::Accepted && !already_accepted {
        learn_dead_effects(conn, &queued_write(conn, id)?.expect("answered row exists"))?;
    }
    Ok(())
}

/// The refused creates whose move onto the row their natural key names waits
/// for a read that finds the row, each with the id of that row.
pub fn pending_landings(conn: &Connection) -> Result<HashMap<String, String>, CoreError> {
    let mut statement = conn.prepare(
        "SELECT substr(key, length('receipt_pending/') + 1), substr(value, length('land:') + 1)
           FROM meta
          WHERE key LIKE 'receipt_pending/%' AND value LIKE 'land:%'",
    )?;
    let landings = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<Result<HashMap<_, _>, _>>()?;
    Ok(landings)
}

/// A write's run of environmental failures as a failure leaves it.
pub struct Streak {
    /// The drains in a row in which the write met one.
    pub count: i64,
    /// When the run began, in milliseconds on the store's clock: the first
    /// failure of the run.
    pub began_ms: i64,
}

/// The longest gap between two failures of one run, in milliseconds. A write
/// that failed, then went unsent for longer, starts a run again: a failure
/// long ago says nothing of the one now.
const RUN_GAP_MILLIS: i64 = 15 * 60 * 1000;

/// Counts an environmental failure the write met in this drain: one more on
/// its streak, or the first of a new run where there is no run, the previous
/// failure is more than `RUN_GAP_MILLIS` back, or the previous failure is
/// ahead of the clock (a clock that was set forward and corrected). The start
/// of a run stands until the run ends. None of it touches the refusals.
pub fn count_environmental(
    conn: &Connection,
    id: &str,
    failure: &crate::model::LastFailure,
) -> Result<Streak, CoreError> {
    conn.execute(
        "UPDATE queue
            SET environmental_since = CASE WHEN environmental_streak = 0
                                                OR environmental_since IS NULL
                                                OR environmental_last IS NULL
                                                OR environmental_last > ?3
                                                OR ?3 - environmental_last > ?4
                                           THEN ?3
                                           ELSE environmental_since END,
                environmental_streak = CASE WHEN environmental_streak = 0
                                                 OR environmental_since IS NULL
                                                 OR environmental_last IS NULL
                                                 OR environmental_last > ?3
                                                 OR ?3 - environmental_last > ?4
                                            THEN 1
                                            ELSE environmental_streak + 1 END,
                environmental_last = ?3,
                last_failure = ?2
          WHERE id = ?1",
        params![
            id,
            serde_json::to_string(failure)?,
            now_millis(),
            RUN_GAP_MILLIS
        ],
    )?;
    conn.query_row(
        "SELECT environmental_streak, environmental_since FROM queue WHERE id = ?1",
        [id],
        |row| {
            Ok(Streak {
                count: row.get(0)?,
                began_ms: row.get(1)?,
            })
        },
    )
    .optional()?
    .ok_or_else(|| CoreError::Store(format!("no queued write {id} to count a failure against")))
}

/// Records what the write met when it was answered and the answer says
/// nothing of it that counts: the streak, and so the start of it, stand as
/// they were.
pub fn note_last_failure(
    conn: &Connection,
    id: &str,
    failure: &crate::model::LastFailure,
) -> Result<(), CoreError> {
    conn.execute(
        "UPDATE queue SET last_failure = ?2 WHERE id = ?1",
        params![id, serde_json::to_string(failure)?],
    )?;
    Ok(())
}

/// Sets a write's run of environmental failures back to nothing: it was
/// answered, or released.
pub fn clear_environmental(conn: &Connection, id: &str) -> Result<(), CoreError> {
    conn.execute(
        "UPDATE queue
            SET environmental_streak = 0, environmental_since = NULL,
                environmental_last = NULL, last_failure = NULL
          WHERE id = ?1
            AND (environmental_streak <> 0 OR environmental_since IS NOT NULL
                 OR environmental_last IS NOT NULL OR last_failure IS NOT NULL)",
        [id],
    )?;
    Ok(())
}

pub fn count_refusal(conn: &Connection, id: &str) -> Result<i64, CoreError> {
    clear_environmental(conn, id)?;
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

/// A drain returns these rows to unanswered before it starts, so the block
/// is the last drain's finding rather than a state that sticks.
pub fn unblock_self_clearing(conn: &Connection) -> Result<usize, CoreError> {
    let [credential_refused, awaiting] = SELF_CLEARING;
    Ok(conn.execute(
        "UPDATE queue SET verdict = NULL, reason = NULL, answered_at = NULL
          WHERE verdict = ?1 AND reason IN (?2, ?3)",
        params![Verdict::Blocked.as_str(), credential_refused, awaiting],
    )?)
}

/// The reasons a block clears itself for: a drain returns these rows to
/// unanswered before it starts (`unblock_self_clearing`).
const SELF_CLEARING: [&str; 2] = [
    BlockedReason::CredentialRefused.as_str(),
    crate::model::AWAITING_DEPENDENCY,
];

/// The released row goes out under a fresh key; the spent one is kept so a
/// late answer under it is not taken for an answer to the new attempt.
pub fn release(conn: &Connection, id: &str) -> Result<bool, CoreError> {
    let Some((verdict, reason, key, spent, sent)) = conn
        .query_row(
            "SELECT verdict, reason, idempotency_key, spent_keys, sent FROM queue WHERE id = ?1",
            [id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, i64>(4)? != 0,
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
    // Only the answer to the write it waits for releases a held write; a
    // fresh key would let one already sent go out a second time.
    if verdict == Some(Verdict::Blocked)
        && reason.as_deref() == Some(crate::model::AWAITING_DEPENDENCY)
    {
        return Ok(false);
    }
    // Released, a row whose dependency was withdrawn would wait for a write
    // the queue no longer holds, which a drain holds forever. `kept_uploads`
    // keeps bytes for a refused row on these same two tests.
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
                refusals = 0, environmental_streak = 0, environmental_since = NULL,
                environmental_last = NULL, last_failure = NULL,
                spent_keys = ?2, idempotency_key = ?3
          WHERE id = ?1",
        params![
            id,
            serde_json::to_string(&keys)?,
            Uuid::now_v7().to_string()
        ],
    )?;
    let released = queued_write(conn, id)?.expect("released row exists");
    let original_fields = edit_fields(conn, &released)?;
    let mut excluded_attempts = HashSet::new();
    for witness in queued_writes(conn)?
        .into_iter()
        .filter(|witness| witness.id != released.id && witness.verdict != Some(Verdict::Accepted))
    {
        let same_edit = witness.kind == released.kind
            && matches!(released.kind, WriteKind::UpdateItem | WriteKind::UpdateEdge)
            && witness.subject_id().is_some()
            && witness.subject_id() == released.subject_id();
        let covered = if same_edit {
            edit_fields(conn, &witness)?
        } else {
            HashSet::new()
        };
        let same_tags = same_tag_subject(&released, &witness)
            && (released.kind == WriteKind::ReplaceMetadata
                || witness.kind == WriteKind::ReplaceMetadata
                || tag_targets(&released)
                    .iter()
                    .any(|tag| tag_targets(&witness).contains(tag)));
        if supersedes_dead(&witness, &released)
            || same_tags
            || same_edit
                && (covered.iter().any(|field| original_fields.contains(field))
                    || replaces_properties(&witness.body)
                        && original_fields.iter().any(|field| field.0))
        {
            excluded_attempts.insert(witness.idempotency_key);
        }
    }
    meta_set(
        conn,
        &effect_key(id),
        &serde_json::to_string(&DeadEffect {
            attempt: released.idempotency_key,
            excluded_attempts,
            ..DeadEffect::default()
        })?,
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
    take_out(conn, row, held, "withdrawn")
}

/// `row` leaves the queue, with each of `held` refused unsent for it and the
/// copy put back as it was beneath every one of them.
fn take_out(
    conn: &Connection,
    row: &QueuedWrite,
    held: &[QueuedWrite],
    taken: &str,
) -> Result<(), CoreError> {
    let reason = format!("the {} it waits for was {taken}", row.kind);
    for dependant in held {
        record_refusal(conn, dependant, &reason, None, false)?;
    }
    conn.execute("DELETE FROM queue WHERE id = ?1", [&row.id])?;
    meta_delete(conn, &effect_key(&row.id))?;
    meta_delete(conn, &chosen_tier_key(&row.id))?;
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
    forget_answered_inner(conn, None, true)
}

/// `forget_answered`, restricted to the rows named: every other answered row
/// stays, and an id that names no row, or one not answered, is ignored.
pub fn forget_answered_ids(conn: &Connection, ids: &[String]) -> Result<usize, CoreError> {
    if ids.is_empty() {
        return Ok(0);
    }
    let only = serde_json::to_string(ids)
        .map_err(|error| CoreError::Invalid(format!("the ids cannot be named: {error}")))?;
    forget_answered_inner(conn, Some(&only), true)
}

/// `only` is a JSON array of the ids to clear, or `None` for any.
fn forget_answered_inner(
    conn: &Connection,
    only: Option<&str>,
    clean_effects: bool,
) -> Result<usize, CoreError> {
    let mut cleared = 0;
    loop {
        let pass = forget_answered_once(conn, only)?;
        if pass == 0 {
            if clean_effects {
                for prefix in ["dead_effect/", "chosen_tier/", "upload_sent_as/"] {
                    conn.execute(
                        "DELETE FROM main.meta
                          WHERE key LIKE :prefix || '%'
                            AND substr(key, length(:prefix) + 1) NOT IN (SELECT id FROM main.queue)
                            AND (:only IS NULL
                                 OR substr(key, length(:prefix) + 1) IN (SELECT value FROM json_each(:only)))",
                        named_params! { ":prefix": prefix, ":only": only },
                    )?;
                }
            }
            return Ok(cleared);
        }
        cleared += pass;
    }
}

fn forget_answered_once(conn: &Connection, only: Option<&str>) -> Result<usize, CoreError> {
    let free = content_free_kinds();
    // Kept while an unanswered or releasable row names it, which would
    // otherwise wait on a write no drain can find.
    let unreleasable = conn.execute(
        &format!(
            "DELETE FROM queue
          WHERE NOT EXISTS (SELECT 1 FROM meta WHERE key = 'receipt_pending/' || queue.id)
            AND (:only IS NULL OR queue.id IN (SELECT value FROM json_each(:only)))
            AND verdict = :refused AND sent = 0 AND kind IN ({free})
            AND EXISTS (
              SELECT 1 FROM json_each(queue.depends_on) AS named
               WHERE named.value NOT IN (SELECT id FROM queue)
            )
            AND NOT EXISTS (
              SELECT 1 FROM queue AS waiting, json_each(waiting.depends_on) AS named
               WHERE named.value = queue.id
                 AND (waiting.verdict IS NULL OR waiting.verdict IN (:blocked, :dead))
            )"
        ),
        named_params! {
            ":only": only,
            ":refused": Verdict::Refused.as_str(),
            ":blocked": Verdict::Blocked.as_str(),
            ":dead": Verdict::Dead.as_str(),
        },
    )?;
    Ok(unreleasable
        + conn.execute(
            &format!(
                "DELETE FROM queue
          WHERE NOT EXISTS (SELECT 1 FROM meta WHERE key = 'receipt_pending/' || queue.id)
            AND (:only IS NULL OR queue.id IN (SELECT value FROM json_each(:only)))
            AND verdict IN (:accepted, :merged, :conflicted, :refused)
            AND NOT (verdict = :refused AND sent = 0)
            AND NOT (verdict = :refused AND kind NOT IN ({free}))
            AND NOT EXISTS (
              SELECT 1 FROM queue AS waiting
               WHERE (waiting.verdict IS NULL
                      OR waiting.verdict IN (:blocked, :dead)
                      OR (waiting.verdict = :refused AND waiting.sent = 0))
                 AND waiting.depends_on LIKE '%' || queue.id || '%'
            )"
            ),
            named_params! {
                ":only": only,
                ":accepted": Verdict::Accepted.as_str(),
                ":merged": Verdict::Merged.as_str(),
                ":conflicted": Verdict::Conflicted.as_str(),
                ":refused": Verdict::Refused.as_str(),
                ":blocked": Verdict::Blocked.as_str(),
                ":dead": Verdict::Dead.as_str(),
            },
        )?)
}

/// The kinds `carries_content` does not name, as an SQL list. Named by what
/// carries nothing, so a kind this build does not know, held by an earlier
/// build's queue that it is counting, is kept as content.
fn content_free_kinds() -> String {
    WriteKind::ALL
        .into_iter()
        .filter(|kind| !kind.carries_content())
        .map(|kind| format!("'{}'", kind.as_str()))
        .collect::<Vec<_>>()
        .join(", ")
}

/// Takes a refused write out of the queue, the one way a refused write that
/// carried content leaves it. Answers `false` for a row not refused, or one a
/// write still waits on, which would then wait on nothing. A create refused
/// onto a row no read has found goes all the same, and the writes waiting on
/// it are refused unsent: each names a row the server never held. Call in a
/// transaction.
pub fn discard(conn: &Connection, id: &str) -> Result<bool, CoreError> {
    let Some(row) = queued_write(conn, id)? else {
        return Err(CoreError::NotFound {
            code: "queued_write_not_found".into(),
            message: format!("{id} is not a write this queue holds"),
        });
    };
    if row.verdict != Some(Verdict::Refused) {
        return Ok(false);
    }
    let receipt = format!("receipt_pending/{id}");
    let landing = match meta_get(conn, &receipt)? {
        None => None,
        Some(shape) if row.kind == WriteKind::CreateItem => match shape.strip_prefix("land:") {
            Some(target) => Some(target.to_string()),
            None => return Ok(false),
        },
        Some(_) => return Ok(false),
    };
    let held = held_for(conn, id)?;
    let Some(target) = landing else {
        if !held.is_empty() {
            return Ok(false);
        }
        conn.execute("DELETE FROM queue WHERE id = ?1", [id])?;
        meta_delete(conn, &effect_key(id))?;
        meta_delete(conn, &chosen_tier_key(id))?;
        return Ok(true);
    };
    take_out(conn, &row, &held, "discarded")?;
    meta_delete(conn, &receipt)?;
    if !read_of_row_owed_elsewhere(conn, &target)? {
        settle_read_back(conn, Subject::Item, &target)?;
    }
    // Only a read can say the server holds no such row, which is what lets a
    // pin go (`device/pin-refused-create`).
    if let Some(minted) = row.item_id.as_deref()
        && pinned(conn, minted)?
    {
        owe_read_back(
            conn,
            &Owed {
                subject: Subject::Item,
                id: minted.into(),
                source_id: None,
                edge_type: None,
                moved: false,
            },
        )?;
    }
    Ok(true)
}

/// The debt of a read carries no owner, so it stays wherever another write
/// could have owed it: one that names the row, another create landing on it,
/// or the copy's own row under that id, which a refusal may have put back.
fn read_of_row_owed_elsewhere(conn: &Connection, id: &str) -> Result<bool, CoreError> {
    Ok(item_held(conn, id)?
        || conn.query_row(
            "SELECT EXISTS (SELECT 1 FROM queue WHERE item_id = ?1 OR target_id = ?1)
                 OR EXISTS (SELECT 1 FROM meta
                             WHERE key LIKE 'receipt_pending/%' AND value = 'land:' || ?1)",
            [id],
            |row| row.get(0),
        )?)
}

/// Every write to the edge not accepted, refused ones included, leaves the
/// queue, and the copy is put back as it was beneath them. With `through`, a
/// queue id, only those queued no later than it leave. Answers the ids that
/// left.
pub fn withdraw_edge_writes(
    conn: &Connection,
    edge_id: &str,
    through: Option<&str>,
) -> Result<Vec<String>, CoreError> {
    let rows = read_writes(
        conn,
        "WHERE edge_id = ?1 AND (verdict IS NULL OR verdict IN (?2, ?3, ?4))
           AND (?5 IS NULL OR seq <= (SELECT seq FROM queue WHERE id = ?5))",
        params![
            edge_id,
            Verdict::Blocked.as_str(),
            Verdict::Refused.as_str(),
            Verdict::Dead.as_str(),
            through,
        ],
    )?;
    for row in &rows {
        conn.execute("DELETE FROM queue WHERE id = ?1", [&row.id])?;
        meta_delete(conn, &effect_key(&row.id))?;
    }
    for row in &rows {
        put_back(conn, row)?;
    }
    Ok(rows.into_iter().map(|row| row.id).collect())
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

/// Takes the server's row into the copy and, only where that wrote, lays the
/// writes still waiting over it, so the copy keeps showing them. A row refused
/// for a later one held leaves the writes laid over that one. Answers whether
/// the row went in. The contract is `queue-and-verdicts/waiting-over-answer`,
/// `queue-and-verdicts/waiting-over-event`, `device/pin-waiting-write` and
/// `device/catch-up-edge-own-write`.
pub fn take_server_item(
    conn: &Connection,
    item: &WireItem,
    tags: Option<&[String]>,
    catalog: &crate::catalog::Catalog,
) -> Result<bool, CoreError> {
    if !put_server_item(conn, item, tags, catalog)? {
        return Ok(false);
    }
    lay_waiting_writes_over(conn, &item.id, &|laid| catalog.indexing(laid))?;
    Ok(true)
}

/// `take_server_item` for an edge.
pub fn take_server_edge(conn: &Connection, edge: &WireEdge) -> Result<bool, CoreError> {
    if !put_server_edge(conn, edge)? {
        return Ok(false);
    }
    // The edge a create was shown with until the server's came.
    let shown = crate::model::projected_edge_id(&edge.source_id, &edge.edge_type, &edge.target_id);
    if shown != edge.id {
        forget_edge(conn, &shown)?;
    }
    lay_waiting_edge_writes_over(conn, &edge.id)?;
    Ok(true)
}

/// Call after anything puts the server's row into the copy. The row is
/// indexed as the type it is laid over as, since a waiting retype moves it.
pub fn lay_waiting_writes_over(
    conn: &Connection,
    item_id: &str,
    indexing: &dyn Fn(&str) -> Indexing,
) -> Result<(), CoreError> {
    let waiting = current_item_writes(conn, item_id)?;
    if waiting.is_empty() {
        return Ok(());
    }
    // A row whose stored properties cannot be read has nothing to lay the
    // writes over; they stay queued, and a fresh copy from the server takes
    // them when it arrives. Failing here would fail a hydration or a catch-up
    // for one damaged row.
    let mut damaged = Unreadable::Keep(HashMap::new());
    let Some(mut item) = items_by_ids_with(
        conn,
        std::slice::from_ref(&item_id.to_string()),
        &mut damaged,
    )?
    .pop() else {
        return Ok(());
    };
    if damaged.why(item_id).is_some() {
        return Ok(());
    }
    let mut tags = item.tags.clone();
    for mut row in waiting {
        let mut read = read_of(conn, &row.id)?
            .map(|read| serde_json::from_str::<Value>(&read))
            .transpose()?;
        if row.verdict == Some(Verdict::Dead)
            && row.kind == WriteKind::UpdateItem
            && let Some(fields) = remaining_dead_fields(conn, &row)?
        {
            retain_edit_fields(&mut row.body, &fields);
            if let Some(read) = &mut read {
                retain_edit_fields(read, &fields);
            }
        }
        if row.verdict == Some(Verdict::Dead) && is_tag_write(&row) {
            let effect = dead_effect(conn, &row)?;
            let mut desired = tag_targets(&row);
            desired.retain(|tag| !effect.fields.contains(&tag_field(tag)));
            if row.kind == WriteKind::ReplaceMetadata {
                desired.extend(
                    tags.iter()
                        .filter(|tag| effect.fields.contains(&tag_field(tag)))
                        .cloned(),
                );
            }
            if matches!(row.kind, WriteKind::AddTag | WriteKind::ReplaceMetadata) {
                row.body["tags"] = serde_json::to_value(desired)?;
            }
        }
        lay_write(conn, &mut item, &mut tags, &row, read.as_ref())?;
    }
    tags.sort();
    upsert_item(conn, &item.as_wire(), Some(&tags), &indexing(&item.r#type))
}

fn retain_edit_fields(body: &mut Value, fields: &HashSet<EditField>) {
    if let Some(body) = body.as_object_mut() {
        body.retain(|key, _| {
            matches!(
                key.as_str(),
                "version" | "properties_mode" | "retype" | "properties"
            ) || fields.contains(&(false, key.clone()))
        });
        if let Some(properties) = body.get_mut("properties").and_then(Value::as_object_mut) {
            properties.retain(|key, _| fields.contains(&(true, key.clone())));
        }
    }
}

fn lay_write(
    conn: &Connection,
    item: &mut Item,
    tags: &mut Vec<String>,
    row: &QueuedWrite,
    read: Option<&Value>,
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
            if let Some(state) = draft.state {
                item.state = state;
            }
            if draft.capture_latitude.is_some() {
                item.capture_latitude = draft.capture_latitude;
            }
            if draft.capture_longitude.is_some() {
                item.capture_longitude = draft.capture_longitude;
            }
        }
        WriteKind::UpdateItem => {
            if let Some(Value::Object(properties)) = payload.get("properties") {
                // Only an edit that read the copy knows which properties it
                // cleared; one said to be read earlier is laid over.
                let read = match read {
                    Some(read) if replaces_properties(payload) => {
                        read.get("properties").and_then(Value::as_object).cloned()
                    }
                    _ => None,
                };
                if let Some(read) = read {
                    lay_changes(&mut item.properties, properties, &read);
                    // At the row's version the server takes it whole, in the
                    // order it sends; behind it, the server merges.
                    if row.base_version == Some(item.version) {
                        item.properties = in_sent_order(&item.properties, properties);
                    }
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
            if let Some(occurred_at) = payload.get("occurred_at").and_then(Value::as_str) {
                item.occurred_at = crate::time::projected(occurred_at);
            }
        }
        WriteKind::TransitionItem => {
            if let Some(state) = payload.get("state").and_then(Value::as_str) {
                item.state = state.parse()?;
            }
        }
        WriteKind::DeleteItem => item.state = ItemState::Trashed,
        WriteKind::RestoreItem => item.state = ItemState::Active,
        WriteKind::AddTag => {
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

pub fn lay_waiting_edge_writes_over(conn: &Connection, edge_id: &str) -> Result<(), CoreError> {
    let waiting = current_edge_writes(conn, edge_id)?;
    // As for an item: a damaged edge is left as it is under its writes.
    let mut damaged = Unreadable::Keep(HashMap::new());
    let Some(mut edge) = edge_by_id_with(conn, edge_id, &mut damaged)? else {
        return Ok(());
    };
    if damaged.why(edge_id).is_some() {
        return Ok(());
    }
    for mut row in waiting {
        if row.verdict == Some(Verdict::Dead)
            && row.kind == WriteKind::UpdateEdge
            && let Some(fields) = remaining_dead_fields(conn, &row)?
        {
            retain_edit_fields(&mut row.body, &fields);
        }
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
                let payload = &row.body;
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
                *properties = in_sent_order(&moved, properties);
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

/// `row` with the properties `sent` names first, in the order sent, then the
/// rest as the row holds them: the order the server answers a whole edit
/// made at the row's version in (`items/property-order-replace`).
fn in_sent_order(row: &Map<String, Value>, sent: &Map<String, Value>) -> Map<String, Value> {
    let mut ordered: Map<String, Value> = sent
        .keys()
        .filter_map(|key| row.get(key).map(|value| (key.clone(), value.clone())))
        .collect();
    for (key, value) in row {
        if !ordered.contains_key(key) {
            ordered.insert(key.clone(), value.clone());
        }
    }
    ordered
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

pub fn tag_count(conn: &Connection, item_id: &str) -> Result<usize, CoreError> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM tags WHERE item_id = ?1",
        [item_id],
        |row| row.get(0),
    )?;
    Ok(usize::try_from(count).unwrap_or(usize::MAX))
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
    crate::body::rule::rows_changed(conn)?;
    crate::body::rule::item_changing(conn, id, None)?;
    let before = attachments_before(conn, &[id])?;
    let changed = conn.execute(
        "UPDATE items SET state = ?2 WHERE id = ?1",
        params![id, state.as_str()],
    )?;
    attachments_changed(conn, &[id], before)?;
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
    edge_by_id_with(conn, id, &mut Unreadable::Refuse)
}

/// The edge for a reader that needs only its ends and type, such as one
/// asking whether the copy holds it: where its stored properties cannot be
/// read, they are empty. A reader that writes from the properties calls
/// `edge_by_id`, which refuses.
pub fn edge_ends(conn: &Connection, id: &str) -> Result<Option<Edge>, CoreError> {
    edge_by_id_with(conn, id, &mut Unreadable::Keep(HashMap::new()))
}

/// Edges for `ids`, in the order given, once each, skipping ids not held.
pub fn edges_by_ids_with(
    conn: &Connection,
    ids: &[String],
    unreadable: &mut Unreadable,
) -> Result<Vec<Edge>, CoreError> {
    let ids = unique(ids);
    let mut by_id: HashMap<String, Edge> = HashMap::new();
    for (placeholders, chunk) in in_lists(&ids) {
        let sql = format!("SELECT {EDGE_COLUMNS} FROM edges WHERE id IN ({placeholders})");
        let mut statement = conn.prepare_cached(&sql)?;
        let rows = statement.query_map(params_from_iter(chunk), read_edge)?;
        for row in rows {
            let (edge, why) = row?;
            if let Some(why) = why {
                unreadable.note("edge", &edge.id, why)?;
            }
            by_id.insert(edge.id.clone(), edge);
        }
    }
    Ok(ids.iter().filter_map(|id| by_id.remove(*id)).collect())
}

pub fn edge_by_id_with(
    conn: &Connection,
    id: &str,
    unreadable: &mut Unreadable,
) -> Result<Option<Edge>, CoreError> {
    let read = conn
        .query_row(
            "SELECT id, source_id, target_id, edge_type, properties, version, created_at, updated_at
               FROM edges WHERE id = ?1",
            [id],
            read_edge,
        )
        .optional()?;
    let Some((edge, why)) = read else {
        return Ok(None);
    };
    if let Some(why) = why {
        unreadable.note("edge", &edge.id, why)?;
    }
    Ok(Some(edge))
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
                icon: None,
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
            capture_latitude: None,
            capture_longitude: None,
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
    #[test]
    fn the_stated_size_is_the_largest_whole_number_an_item_states_for_the_bytes() {
        let temp = tempfile::tempdir().unwrap();
        let conn = super::open(&temp.path().join("core.sqlite")).unwrap();
        let put_typed = |id: &str, kind: &str, properties: &str| {
            conn.execute(
                "INSERT INTO items (id, type, state, version, schema_version, source,
                   occurred_at, created_at, updated_at, properties)
                 VALUES (?1, ?3, 'active', 1, 1, 'test', 't', 't', 't', ?2)",
                [id, properties, kind],
            )
            .unwrap();
        };
        let put = |id: &str, properties: &str| put_typed(id, "core.file", properties);
        let stated = |hash: &str| super::stated_size(&conn, hash).unwrap();
        assert_eq!(stated("sha256:aa"), None);
        put("one", r#"{"blob_ref":"sha256:aa","size_bytes":300}"#);
        assert_eq!(stated("sha256:aa"), Some(300));
        put("two", r#"{"blob_ref":"sha256:aa","size_bytes":900}"#);
        put("other", r#"{"blob_ref":"sha256:bb","size_bytes":5000}"#);
        put("text", r#"{"blob_ref":"sha256:aa","size_bytes":"99999"}"#);
        put("zero", r#"{"blob_ref":"sha256:aa","size_bytes":0}"#);
        put("broken", "not json");
        assert_eq!(stated("sha256:aa"), Some(900));
        assert_eq!(stated("sha256:cc"), None);

        // Only a file, or a subtype of one, states the size of its bytes: a
        // note naming the same bytes with a smaller size does not bound them.
        put_typed(
            "note",
            "core.note",
            r#"{"blob_ref":"sha256:dd","size_bytes":10}"#,
        );
        assert_eq!(stated("sha256:dd"), None);
        put_typed(
            "image",
            "core.file.image",
            r#"{"blob_ref":"sha256:dd","size_bytes":400}"#,
        );
        put_typed(
            "lookalike",
            "core.filesystem",
            r#"{"blob_ref":"sha256:dd","size_bytes":9999}"#,
        );
        assert_eq!(stated("sha256:dd"), Some(400));
    }

    #[test]
    fn an_attachment_is_a_held_file_attached_to_a_held_item_out_of_the_bin() {
        let temp = tempfile::tempdir().unwrap();
        let conn = super::open(&temp.path().join("core.sqlite")).unwrap();
        let put = |id: &str, kind: &str, state: &str, properties: &str| {
            conn.execute(
                "INSERT INTO items (id, type, state, version, schema_version, source,
                   occurred_at, created_at, updated_at, properties)
                 VALUES (?1, ?2, ?3, 1, 1, 'test', 't', 't', 't', ?4)",
                [id, kind, state, properties],
            )
            .unwrap();
        };
        let edge = |id: &str, source: &str, target: &str, kind: &str| {
            conn.execute(
                "INSERT INTO edges (id, source_id, target_id, edge_type, properties, version,
                   created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, '{}', 1, 't', 't')",
                [id, source, target, kind],
            )
            .unwrap();
        };
        let found = || {
            let found = super::attachments(&conn).unwrap();
            let ids: Vec<String> = found.into_iter().map(|found| found.item_id).collect();
            (ids, super::attachments_not_in_copy(&conn).unwrap())
        };
        put("note", "core.note", "active", "{}");
        put("binned", "core.note", "trashed", "{}");
        put(
            "photo",
            "core.file.image",
            "active",
            r#"{"blob_ref":"sha256:aa","size_bytes":5}"#,
        );
        put(
            "loose",
            "core.file",
            "active",
            r#"{"blob_ref":"sha256:bb"}"#,
        );
        put(
            "to-bin",
            "core.file",
            "active",
            r#"{"blob_ref":"sha256:cc"}"#,
        );
        put(
            "gone",
            "core.file",
            "trashed",
            r#"{"blob_ref":"sha256:dd"}"#,
        );
        put("broken", "core.file", "active", "not json");
        put(
            "lookalike",
            "core.note",
            "active",
            r#"{"blob_ref":"sha256:ee"}"#,
        );
        assert_eq!(found(), (vec![], 0));

        edge("e1", "photo", "note", "attached-to");
        edge("e2", "loose", "note", "references");
        edge("e3", "to-bin", "binned", "attached-to");
        edge("e4", "gone", "note", "attached-to");
        edge("e5", "broken", "note", "attached-to");
        edge("e6", "lookalike", "note", "attached-to");
        edge("e7", "photo", "absent", "attached-to");
        edge("e8", "unheld-file", "note", "attached-to");
        edge("e9", "unheld-file", "binned", "attached-to");
        let (held, outside) = (
            super::attachments(&conn).unwrap(),
            super::attachments_not_in_copy(&conn).unwrap(),
        );
        assert_eq!(
            held,
            [super::Attachment {
                item_id: "photo".into(),
                hash: "sha256:aa".into(),
                stated: Some(5),
            }]
        );
        assert_eq!(outside, 1);

        conn.execute("DELETE FROM edges WHERE id = 'e1'", [])
            .unwrap();
        assert_eq!(found(), (vec![], 1));
    }

    #[test]
    fn admitted_store_does_not_reopen_replacement_sidecars() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("owned");
        std::fs::create_dir(&root).unwrap();
        let path = root.join("core.sqlite");
        let conn = super::open(&path).unwrap();
        super::meta_set(&conn, "witness", "original").unwrap();
        conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
            .unwrap();
        std::fs::rename(&root, temp.path().join("original")).unwrap();
        std::fs::create_dir(&root).unwrap();
        let replacement = super::open(&path).unwrap();
        super::meta_set(&replacement, "witness", "replacement").unwrap();
        let before = std::fs::read(root.join("core.sqlite-wal")).unwrap();
        super::meta_set(&conn, "witness", "updated original").unwrap();
        assert_eq!(
            super::meta_get(&conn, "witness").unwrap().as_deref(),
            Some("updated original")
        );
        drop(conn);
        assert!(
            std::fs::read(root.join("core.sqlite-wal")).unwrap() == before,
            "replacement WAL changed"
        );
        assert_eq!(
            super::meta_get(&replacement, "witness").unwrap().as_deref(),
            Some("replacement")
        );
    }

    #[test]
    fn closing_admitted_store_preserves_replacement_sidecars() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("owned");
        std::fs::create_dir(&root).unwrap();
        let path = root.join("core.sqlite");
        let conn = super::open(&path).unwrap();
        super::meta_set(&conn, "witness", "original").unwrap();
        assert!(root.join("core.sqlite-wal").exists());
        assert!(root.join("core.sqlite-shm").exists());
        std::fs::rename(&root, temp.path().join("original")).unwrap();
        std::fs::create_dir(&root).unwrap();
        let replacement = super::open(&path).unwrap();
        super::meta_set(&replacement, "witness", "replacement").unwrap();
        let wal = std::fs::read(root.join("core.sqlite-wal")).unwrap();
        let shm = std::fs::read(root.join("core.sqlite-shm")).unwrap();
        drop(conn);
        assert_eq!(std::fs::read(root.join("core.sqlite-wal")).unwrap(), wal);
        assert_eq!(std::fs::read(root.join("core.sqlite-shm")).unwrap(), shm);
        assert_eq!(
            super::meta_get(&replacement, "witness").unwrap().as_deref(),
            Some("replacement")
        );
    }

    use serde_json::json;

    use super::testing::*;
    use super::*;
    use crate::model::LastFailure;

    #[test]
    fn a_pinned_rows_purge_is_remembered_until_it_is_let_go() {
        let conn = testing::conn();
        for id in ["pinned", "unpinned"] {
            put_server_item(
                &conn,
                &testing::note(id, id, "", "2026-01-01T00:00:00Z"),
                Some(&[]),
                &crate::catalog::Catalog::empty(),
            )
            .unwrap();
        }
        pin(&conn, "pinned").unwrap();
        assert!(purge_item(&conn, "pinned").unwrap());
        assert!(purge_item(&conn, "unpinned").unwrap());
        assert!(purged(&conn, "pinned").unwrap());
        assert!(!purged(&conn, "unpinned").unwrap());
        pin(&conn, "pinned").unwrap();
        assert!(
            purged(&conn, "pinned").unwrap(),
            "a later pin of the gone row"
        );
        forget_purged(&conn, "pinned").unwrap();
        assert!(!purged(&conn, "pinned").unwrap());
    }

    #[test]
    fn each_change_to_the_copy_names_the_items_it_touches() {
        let conn = testing::conn();
        let since = |from: i64| changed_since(&conn, Changes::Items, from, 8).unwrap();
        let ids = |names: &[&str]| Some(names.iter().map(|id| id.to_string()).collect());
        let empty = crate::catalog::Catalog::empty();
        let from = last_change(&conn, Changes::Items).unwrap();
        for id in ["a", "b", "c"] {
            put_server_item(
                &conn,
                &note(id, id, "", "2026-01-01T00:00:00Z"),
                Some(&[]),
                &empty,
            )
            .unwrap();
        }
        assert_eq!(since(from), ids(&["a", "b", "c"]));

        let from = last_change(&conn, Changes::Items).unwrap();
        assert_eq!(since(from), ids(&[]));
        put_server_edge(&conn, &wire_edge("a-b", "a", "b", "references")).unwrap();
        assert_eq!(since(from), ids(&["a", "b"]));

        let from = last_change(&conn, Changes::Items).unwrap();
        pin(&conn, "c").unwrap();
        assert_eq!(since(from), ids(&["c"]));

        // A change to the types reaches every item, as does one past `most`.
        let from = last_change(&conn, Changes::Items).unwrap();
        replace_types(&conn, &[wire_type("acme.photo", None, None)]).unwrap();
        assert_eq!(since(from), None);
        let from = last_change(&conn, Changes::Items).unwrap();
        for id in 0..9 {
            let id = format!("n{id}");
            put_server_item(
                &conn,
                &note(&id, &id, "", "2026-01-01T00:00:00Z"),
                Some(&[]),
                &empty,
            )
            .unwrap();
        }
        assert_eq!(since(from), None);
        assert_eq!(
            changed_since(&conn, Changes::Items, from, 9)
                .unwrap()
                .map(|ids| ids.len()),
            Some(9)
        );
    }

    #[test]
    fn a_copy_without_reach_proof_is_unreadable() {
        let conn = testing::conn();
        meta_set(&conn, META_EVENT_CURSOR, "10").unwrap();
        meta_set(&conn, META_SLICE_TYPES, "[\"core.note\"]").unwrap();
        meta_set(&conn, META_SLICE_TIER, "library").unwrap();
        assert!(!hydrated(&conn).unwrap());
        assert!(matches!(
            refuse_unless_hydrated(&conn),
            Err(CoreError::HydrationIncomplete)
        ));
    }

    #[test]
    fn a_changed_catalog_indexes_every_held_row_again() {
        let conn = conn();
        let photo = |cover: &str| {
            let mut wire = wire_type("acme.photo", None, None);
            wire.rest.insert(
                "fields".into(),
                json!({ "cover": { "type": cover, "searchable": cover == "string" } }),
            );
            wire
        };
        replace_types(&conn, &[photo("string")]).unwrap();
        let properties = json!({
            "title": "Holiday",
            "cover": "unicornsXYZ",
            "undeclared": "narwhalsABC",
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
                "SELECT extra, tags FROM items_fts WHERE rowid = (SELECT seq FROM items WHERE id = ?1)",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .unwrap()
        };
        let (extra, tags) = entry("held").expect("the held row has no entry");
        assert_eq!(
            extra, "unicornsXYZ",
            "a declared string is indexed, an undeclared one is not"
        );
        assert_eq!(tags, "summer");
        assert_eq!(entry("binned"), None);

        replace_types(&conn, &[photo("thumbnail")]).unwrap();
        let (extra, tags) =
            entry("held").expect("the catalog changed and the held row lost its entry");
        assert_eq!(
            extra, "",
            "the type no longer declares a string there and the entry still holds it"
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

    #[test]
    fn reindex_contains_malformed_properties() {
        check_unreadable_reindex(r#"{"title":"#);
    }

    #[test]
    fn reindex_contains_nonobject_properties() {
        for damaged in ["[1]", "null", "7", "true", r#""text""#] {
            check_unreadable_reindex(damaged);
        }
    }

    fn check_unreadable_reindex(damaged: &str) {
        let conn = conn();
        let catalog = |cover: &str| {
            let mut ty = wire_type("acme.photo", None, Some("title"));
            ty.rest
                .insert("fields".into(), json!({"cover": {"type": cover}}));
            WireCatalog {
                types: vec![ty],
                edge_types: vec![],
            }
        };
        replace_catalog(&conn, &catalog("string")).unwrap();
        let indexing = crate::catalog::Catalog::load(&conn)
            .unwrap()
            .indexing("acme.photo");
        for (id, state) in [
            ("damaged", "active"),
            ("healthy", "active"),
            ("binned", "trashed"),
        ] {
            let row = wire_item(
                id,
                "acme.photo",
                state,
                "2026-01-01T00:00:00Z",
                json!({
                    "title": "staletitle",
                    "body": "stalebody",
                    "description": "staledescription",
                    "name": "stalename",
                    "cover": "stalecover",
                }),
            );
            upsert_item(&conn, &row, Some(&["genuinetag".into()]), &indexing).unwrap();
        }
        let matches = |query: &str| -> Vec<String> {
            conn.prepare(
                "SELECT items.id FROM items_fts
                 JOIN items ON items.seq = items_fts.rowid
                 WHERE items_fts MATCH ?1 ORDER BY items.id",
            )
            .unwrap()
            .query_map([query], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
        };
        for query in [
            "staletitle",
            "stalebody",
            "staledescription",
            "stalename",
            "stalecover",
            "genuinetag",
        ] {
            assert_eq!(matches(query), ["damaged", "healthy"], "{query}");
        }
        conn.execute(
            "UPDATE items SET properties = ?1 WHERE id IN ('damaged', 'binned')",
            [damaged],
        )
        .unwrap();
        assert!(items_by_ids(&conn, &["damaged".into()]).is_err());
        let mut unreadable = Unreadable::Keep(HashMap::new());
        items_by_ids_with(&conn, &["damaged".into()], &mut unreadable).unwrap();
        let why = unreadable.why("damaged").unwrap();
        let version = catalog_version(&conn).unwrap();

        assert!(
            replace_catalog(&conn, &catalog("thumbnail"))
                .unwrap()
                .is_changed(),
            "{damaged}"
        );

        assert_ne!(catalog_version(&conn).unwrap(), version);
        for query in ["staletitle", "stalebody", "staledescription", "stalename"] {
            assert_eq!(matches(query), ["healthy"], "{damaged}: {query}");
        }
        assert!(
            matches("stalecover").is_empty(),
            "the healthy row was not reindexed"
        );
        assert_eq!(matches("genuinetag"), ["damaged", "healthy"]);
        let raw: String = conn
            .query_row(
                "SELECT properties FROM items WHERE id = 'damaged'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(raw, damaged);
        let mut unreadable = Unreadable::Keep(HashMap::new());
        let held = items_by_ids_with(&conn, &["damaged".into()], &mut unreadable).unwrap();
        assert!(held[0].properties.is_empty());
        assert_eq!(unreadable.why("damaged"), Some(why));
        assert!(items_by_ids(&conn, &["damaged".into()]).is_err());
    }

    #[test]
    fn reindex_database_errors_still_roll_back_a_catalog_replacement() {
        let conn = conn();
        let original = WireCatalog {
            types: vec![wire_type("core.note", None, Some("title"))],
            edge_types: vec![],
        };
        replace_catalog(&conn, &original).unwrap();
        upsert_item(
            &conn,
            &note("held", "held", "body", "2026-01-01T00:00:00Z"),
            Some(&[]),
            &Indexing::default(),
        )
        .unwrap();
        let held = type_rows(&conn).unwrap();
        let version = catalog_version(&conn).unwrap();
        let mut changed = original;
        changed.types[0].label = Some("Changed".into());
        conn.execute_batch("DROP TABLE items_fts").unwrap();
        let failure = replace_catalog(&conn, &changed).unwrap_err();
        assert!(matches!(failure, CoreError::Store(_)), "{failure:?}");
        assert_eq!(type_rows(&conn).unwrap(), held);
        assert_eq!(catalog_version(&conn).unwrap(), version);
    }

    /// A refresh that changes only a type's icon adopts the catalog and moves
    /// its version without reindexing a row; any other change reindexes.
    #[test]
    fn an_icon_only_catalog_change_reindexes_no_row() {
        let conn = conn();
        let original = WireCatalog {
            types: vec![wire_type("core.note", None, Some("title"))],
            edge_types: vec![],
        };
        replace_catalog(&conn, &original).unwrap();
        upsert_item(
            &conn,
            &note("held", "findable", "body", "2026-01-01T00:00:00Z"),
            Some(&[]),
            &Indexing::default(),
        )
        .unwrap();
        // Emptying the index is the witness: a reindex writes the row again.
        let indexed = || -> i64 {
            conn.query_row("SELECT count(*) FROM items_fts", [], |row| row.get(0))
                .unwrap()
        };
        let emptied = || conn.execute("DELETE FROM items_fts", []).unwrap();
        let version = catalog_version(&conn).unwrap();

        let mut icon_only = original.clone();
        icon_only.types[0].display_hints.as_mut().unwrap().icon = Some("sticky-note".into());
        emptied();
        assert_eq!(
            replace_catalog(&conn, &icon_only).unwrap(),
            CatalogChange::IconsOnly
        );
        assert_eq!(indexed(), 0, "no row was reindexed");
        assert_ne!(catalog_version(&conn).unwrap(), version);
        assert!(type_rows(&conn).unwrap()[0].1.contains("sticky-note"));

        let mut cleared = icon_only.clone();
        cleared.types[0].display_hints.as_mut().unwrap().icon = None;
        assert_eq!(
            replace_catalog(&conn, &cleared).unwrap(),
            CatalogChange::IconsOnly
        );
        assert_eq!(indexed(), 0, "removing the icon reindexed no row");

        let mut relabelled = icon_only;
        relabelled.types[0].label = Some("Changed".into());
        assert_eq!(
            replace_catalog(&conn, &relabelled).unwrap(),
            CatalogChange::Changed
        );
        assert_eq!(indexed(), 1, "the witness: another change reindexes");
    }

    /// One answer for one replacement: the hydration that decides whether to
    /// resume and the reindex that decides whether to run read the same
    /// verdict, so they cannot disagree.
    #[test]
    fn a_replacement_says_whether_nothing_icons_only_or_more_changed() {
        let conn = conn();
        let original = WireCatalog {
            types: vec![wire_type("core.note", None, Some("title"))],
            edge_types: vec![],
        };
        assert_eq!(
            replace_catalog(&conn, &original).unwrap(),
            CatalogChange::Changed,
            "the first catalog held is a change, not icons only"
        );
        assert_eq!(
            replace_catalog(&conn, &original).unwrap(),
            CatalogChange::Unchanged
        );

        let mut icon_only = original.clone();
        icon_only.types[0].display_hints.as_mut().unwrap().icon = Some("sticky-note".into());
        assert_eq!(
            replace_catalog(&conn, &icon_only).unwrap(),
            CatalogChange::IconsOnly
        );

        let mut and_label = icon_only.clone();
        and_label.types[0].display_hints.as_mut().unwrap().icon = Some("star".into());
        and_label.types[0].label = Some("Changed".into());
        assert_eq!(
            replace_catalog(&conn, &and_label).unwrap(),
            CatalogChange::Changed
        );

        let mut icon_and_edge = and_label.clone();
        icon_and_edge.types[0].display_hints.as_mut().unwrap().icon = Some("moon".into());
        icon_and_edge.edge_types = vec![json!({
            "id": "mentor-of", "source_type_constraints": ["*"],
            "target_type_constraints": ["*"], "cardinality": "many-to-many",
            "cascade_on_delete": "orphan", "property_schema": {},
            "written_at": "source", "shipped": false
        })];
        assert_eq!(
            replace_catalog(&conn, &icon_and_edge).unwrap(),
            CatalogChange::Changed,
            "an icon beside an edge type change is more than icons"
        );

        // A copy's own catalog is replaced by a server's whatever the rows say.
        let local = crate::store::open_in_memory().unwrap();
        hold_local_catalog(&local).unwrap();
        let shipped = crate::builtin::catalog().unwrap();
        assert_eq!(
            replace_catalog(&local, &shipped).unwrap(),
            CatalogChange::Changed
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
            capture_latitude: Some(51.5),
            capture_longitude: Some(-0.25),
            edges: None,
        };
        upsert_item(&conn, &row, None, &Indexing::default()).unwrap();

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
        assert_eq!(item.capture_latitude, Some(51.5));
        assert_eq!(item.capture_longitude, Some(-0.25));
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
            &Indexing::default(),
        )
        .unwrap();
        let item = item_by_id(&conn, "n1").unwrap().unwrap();
        assert_eq!(item.tags, vec!["a", "b"]);
        assert_eq!(item.properties["title"], "Hello");
        assert_eq!(item.state, ItemState::Active);
        assert_eq!(item.tier, Some(Tier::Library));

        let mut renamed = note.clone();
        renamed.properties = json!({ "title": "Renamed", "body": "world" })
            .as_object()
            .unwrap()
            .clone();
        upsert_item(&conn, &renamed, None, &Indexing::default()).unwrap();
        let item = item_by_id(&conn, "n1").unwrap().unwrap();
        assert_eq!(item.properties["title"], "Renamed");
        assert_eq!(item.tags, vec!["a", "b"]);
        assert_eq!(count(&conn, "items_fts").unwrap(), 1);
    }

    #[test]
    fn a_create_answered_with_another_id_moves_everything_onto_it() {
        let conn = conn();
        let indexing = Indexing::default();
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

    /// A create answered with a row the body rule or a folder line pinned
    /// lands its own pin there, which their release must not take
    /// (`device/pin-create-lasts`).
    #[test]
    fn a_create_landing_on_a_row_another_claim_pinned_keeps_its_pin() {
        use crate::folder::state;
        let mut conn = conn();
        for id in ["linked", "linked-alone", "linked-unpinned"] {
            pin(&conn, id).unwrap();
            conn.execute("INSERT INTO body_pins (item_id) VALUES (?1)", [id])
                .unwrap();
        }
        for id in ["lined", "lined-alone", "lined-unpinned"] {
            pin(&conn, id).unwrap();
            state::hold_edge_end(&conn, id, true).unwrap();
        }
        for (minted, answered) in [("minted-a", "linked"), ("minted-b", "lined")] {
            pin(&conn, minted).unwrap();
            adopt_answered_id(&conn, minted, answered).unwrap();
        }
        // A create the copy did not pin leaves each claim its own.
        for (minted, answered) in [
            ("minted-c", "linked-unpinned"),
            ("minted-d", "lined-unpinned"),
        ] {
            adopt_answered_id(&conn, minted, answered).unwrap();
        }

        crate::body::rule::after_answers(&mut conn).unwrap();
        for (id, made) in state::edge_ends(&conn).unwrap() {
            state::release_edge_end(&conn, &id, made).unwrap();
        }

        // The witness: each claim's release takes a pin that is only its own.
        assert_eq!(
            pins(&conn).unwrap(),
            ["lined", "linked"],
            "a create's pin went with a body link's or a folder line's release"
        );
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
    fn what_the_body_rule_and_the_folder_hold_of_a_minted_id_moves_to_the_answered_id() {
        let conn = conn();
        for statement in [
            "INSERT INTO body_checks (write_id, item_id, body) VALUES ('check', 'minted', '')",
            "INSERT INTO body_edges (write_id, item_id, kind, other_id) VALUES ('from', 'minted', 'link', 'other')",
            "INSERT INTO body_edges (write_id, item_id, kind, other_id) VALUES ('to', 'other', 'link', 'minted')",
            "INSERT INTO body_names (item_id, kind, text, state, other_id) VALUES ('minted', 'link', 'other', 'resolved', 'other')",
            "INSERT INTO body_names (item_id, kind, text, state, other_id) VALUES ('answered', 'link', 'before', 'resolved', 'before')",
            "INSERT INTO body_names (item_id, kind, text, state, other_id) VALUES ('other', 'link', 'new', 'resolved', 'minted')",
            "INSERT INTO folder_files (path, item_id, content_hash, links, edge_lines, seen_at) VALUES ('New.md', 'minted', 'h', '[]', '[]', '2026-01-01T00:00:00Z')",
            "INSERT INTO folder_journal (path, item_id, missing_since) VALUES ('Gone.md', 'minted', '2026-01-01T00:00:00Z')",
        ] {
            conn.execute(statement, []).unwrap();
        }
        adopt_answered_id(&conn, "minted", "answered").unwrap();
        let rows = |sql: &str| -> Vec<String> {
            let mut statement = conn.prepare(sql).unwrap();
            statement
                .query_map([], |row| row.get(0))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap()
        };
        assert_eq!(rows("SELECT item_id FROM body_checks"), ["answered"]);
        assert_eq!(
            rows("SELECT item_id || '>' || other_id FROM body_edges ORDER BY write_id"),
            ["answered>other", "other>answered"]
        );
        assert_eq!(
            rows(
                "SELECT item_id || ':' || text || '>' || other_id FROM body_names ORDER BY item_id"
            ),
            ["answered:other>other", "other:new>answered"],
            "the names the create's body carries are not the row's"
        );
        assert_eq!(rows("SELECT item_id FROM folder_files"), ["answered"]);
        assert_eq!(rows("SELECT item_id FROM folder_journal"), ["answered"]);
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
    fn the_index_text_is_the_core_four_and_the_declared_strings() {
        let properties = json!({
            "title": "T",
            "body": "B",
            "name": 5,
            "blurb": "X",
            "empty": "",
            "later": "Y",
            "count": 5,
            "undeclared": "Z",
            "nested": { "deep": ["x"] }
        });
        let indexing = Indexing {
            opted_out: vec!["body".into()],
            extra: vec!["blurb".into(), "empty".into(), "later".into()],
        };
        assert_eq!(
            fts_text(properties.as_object().unwrap(), &indexing),
            FtsText {
                title: "T".into(),
                body: String::new(),
                description: String::new(),
                name: String::new(),
                extra: "X Y".into(),
            }
        );
        assert_eq!(
            fts_text(properties.as_object().unwrap(), &Indexing::default()),
            FtsText {
                title: "T".into(),
                body: "B".into(),
                ..FtsText::default()
            }
        );
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
        meta_set(&conn, crate::reach::FENCE, crate::scripted::FENCE).unwrap();
        meta_set(&conn, META_INSTANCE_ID, crate::scripted::INSTANCE).unwrap();
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
        meta_set(&conn, crate::reach::FENCE, crate::scripted::FENCE).unwrap();
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

    fn queue_row(
        conn: &Connection,
        id: &str,
        kind: &str,
        verdict: Option<&str>,
        sent: i64,
        depends: &str,
    ) {
        conn.execute(
            "INSERT INTO queue (id, kind, idempotency_key, payload, verdict, sent, depends_on, queued_at)
             VALUES (?1, ?2, ?1, '{}', ?3, ?4, ?5, '2026-01-01T00:00:00Z')",
            params![id, kind, verdict, sent, depends],
        )
        .unwrap();
    }

    fn queue_ids(conn: &Connection) -> Vec<String> {
        conn.prepare("SELECT id FROM queue ORDER BY id")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect()
    }

    fn named(ids: &[&str]) -> Vec<String> {
        ids.iter().map(|id| id.to_string()).collect()
    }

    #[test]
    fn forgetting_named_rows_takes_only_those_and_keeps_every_other_answered_row() {
        let build = || {
            let conn = conn();
            queue_row(&conn, "read", "update_item", Some("accepted"), 1, "[]");
            queue_row(&conn, "later", "update_item", Some("merged"), 1, "[]");
            queue_row(&conn, "other", "update_item", Some("conflicted"), 1, "[]");
            conn
        };
        // The witness: an unrestricted clearing takes all three, so the rows
        // kept below were producible.
        let all = build();
        assert_eq!(forget_answered(&all).unwrap(), 3);

        let conn = build();
        assert_eq!(
            forget_answered_ids(&conn, &named(&["read", "other"])).unwrap(),
            2
        );
        assert_eq!(
            queue_ids(&conn),
            named(&["later"]),
            "a clearing of named writes took one nobody named, which an app has not yet read"
        );
    }

    #[test]
    fn forgetting_named_rows_keeps_every_row_a_clearing_keeps() {
        let conn = conn();
        queue_row(&conn, "unanswered", "update_item", None, 0, "[]");
        queue_row(&conn, "sent", "update_item", None, 1, "[]");
        queue_row(&conn, "blocked", "update_item", Some("blocked"), 1, "[]");
        queue_row(&conn, "dead", "update_item", Some("dead"), 1, "[]");
        queue_row(&conn, "unsent", "delete_item", Some("refused"), 0, "[]");
        queue_row(&conn, "content", "update_item", Some("refused"), 1, "[]");
        let every = named(&["unanswered", "sent", "blocked", "dead", "unsent", "content"]);
        let before = queue_ids(&conn);
        assert_eq!(forget_answered_ids(&conn, &every).unwrap(), 0);
        assert_eq!(queue_ids(&conn), before);

        // The witness: the same kinds, answered and carrying nothing, go.
        queue_row(&conn, "refused", "delete_item", Some("refused"), 1, "[]");
        queue_row(&conn, "accepted", "update_item", Some("accepted"), 1, "[]");
        assert_eq!(
            forget_answered_ids(&conn, &named(&["refused", "accepted"])).unwrap(),
            2
        );
        assert_eq!(queue_ids(&conn), before);
    }

    #[test]
    fn forgetting_named_rows_ignores_an_id_the_queue_does_not_hold() {
        let conn = conn();
        queue_row(&conn, "read", "update_item", Some("accepted"), 1, "[]");
        assert_eq!(forget_answered_ids(&conn, &[]).unwrap(), 0);
        assert_eq!(
            forget_answered_ids(&conn, &named(&["nowhere", "%", "rea"])).unwrap(),
            0,
            "an id that names nothing, or only part of one, took a row"
        );
        assert_eq!(queue_ids(&conn), named(&["read"]));
        assert_eq!(
            forget_answered_ids(&conn, &named(&["nowhere", "read", "read"])).unwrap(),
            1
        );
        assert!(queue_ids(&conn).is_empty());
    }

    #[test]
    fn forgetting_a_named_row_keeps_it_while_a_row_that_may_still_be_sent_depends_on_it() {
        for waiting in [
            (None, 0),
            (Some("blocked"), 1),
            (Some("dead"), 1),
            (Some("refused"), 0),
        ] {
            let conn = conn();
            queue_row(&conn, "named", "update_item", Some("accepted"), 1, "[]");
            queue_row(
                &conn,
                "waiter",
                "update_item",
                waiting.0,
                waiting.1,
                "[\"named\"]",
            );
            assert_eq!(
                forget_answered_ids(&conn, &named(&["named"])).unwrap(),
                0,
                "a named row went while {waiting:?} waits on it, which then waits for a write no drain can find"
            );
            assert_eq!(queue_ids(&conn), named(&["named", "waiter"]));
        }
        // The witness: once the waiting row is answered, the dependency goes.
        let conn = conn();
        queue_row(&conn, "named", "update_item", Some("accepted"), 1, "[]");
        queue_row(
            &conn,
            "waiter",
            "update_item",
            Some("accepted"),
            1,
            "[\"named\"]",
        );
        assert_eq!(forget_answered_ids(&conn, &named(&["named"])).unwrap(), 1);
        assert_eq!(queue_ids(&conn), named(&["waiter"]));
    }

    #[test]
    fn forgetting_named_rows_repeats_its_passes_inside_the_names() {
        let build = || {
            let conn = conn();
            queue_row(
                &conn,
                "dependency",
                "update_item",
                Some("accepted"),
                1,
                "[]",
            );
            // Refused unsent behind a write the queue no longer holds: it
            // goes, and then the row it kept can go.
            queue_row(
                &conn,
                "leftover",
                "delete_item",
                Some("refused"),
                0,
                "[\"dependency\", \"gone\"]",
            );
            conn
        };
        let all = build();
        assert_eq!(forget_answered(&all).unwrap(), 2);

        let conn = build();
        assert_eq!(
            forget_answered_ids(&conn, &named(&["dependency"])).unwrap(),
            0,
            "the dependency went while a leftover not named still depends on it"
        );
        assert_eq!(
            forget_answered_ids(&conn, &named(&["leftover"])).unwrap(),
            1
        );
        assert_eq!(queue_ids(&conn), named(&["dependency"]));

        let both = build();
        assert_eq!(
            forget_answered_ids(&both, &named(&["dependency", "leftover"])).unwrap(),
            2,
            "a pass that freed a named row did not repeat"
        );
        assert!(queue_ids(&both).is_empty());
    }

    #[test]
    fn forgetting_named_rows_keeps_a_row_whose_receipt_is_pending() {
        let conn = conn();
        queue_row(&conn, "landing", "create_item", Some("accepted"), 1, "[]");
        meta_set(&conn, "receipt_pending/landing", "land:item").unwrap();
        assert_eq!(forget_answered_ids(&conn, &named(&["landing"])).unwrap(), 0);
        meta_delete(&conn, "receipt_pending/landing").unwrap();
        assert_eq!(forget_answered_ids(&conn, &named(&["landing"])).unwrap(), 1);
    }

    #[test]
    fn forgetting_named_rows_cleans_only_their_own_effect_slots() {
        let conn = conn();
        queue_row(&conn, "named", "update_item", Some("accepted"), 1, "[]");
        queue_row(&conn, "kept", "update_item", Some("accepted"), 1, "[]");
        for id in ["named", "kept", "orphan"] {
            meta_set(&conn, &format!("dead_effect/{id}"), "x").unwrap();
            meta_set(&conn, &format!("chosen_tier/{id}"), "library").unwrap();
            meta_set(&conn, &format!("upload_sent_as/{id}"), "x").unwrap();
        }
        assert_eq!(forget_answered_ids(&conn, &named(&["named"])).unwrap(), 1);
        for prefix in ["dead_effect/", "chosen_tier/", "upload_sent_as/"] {
            assert!(
                meta_get(&conn, &format!("{prefix}named"))
                    .unwrap()
                    .is_none(),
                "{prefix} outlived the row it belongs to"
            );
            assert!(meta_get(&conn, &format!("{prefix}kept")).unwrap().is_some());
            assert!(
                meta_get(&conn, &format!("{prefix}orphan"))
                    .unwrap()
                    .is_some(),
                "{prefix} of a row nobody named was cleaned"
            );
        }
        // The witness: an unrestricted clearing cleans the orphan too.
        forget_answered(&conn).unwrap();
        assert!(meta_get(&conn, "dead_effect/orphan").unwrap().is_none());
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
                 answer, conflicted_copy_id, refusals, environmental_streak,
                 last_failure, queued_at, answered_at
             ) VALUES (
                 'q-id', 'update_item', 'the-item', 'the-target', 'the-edge',
                 'the-namespace', 'the-tag', 'the-blob', 7, 'the-key', '{}',
                 '[\"first\",\"second\"]', 'blocked', 'key_spent',
                 '{\"error\":\"as sent\"}', 'the-sibling', 3, 2,
                 '{\"status\":413,\"text\":\"too large\"}',
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
        assert_eq!(write.environmental_streak, 2);
        assert_eq!(
            write.last_failure,
            Some(LastFailure {
                status: Some(413),
                text: Some("too large".into())
            })
        );
        assert_eq!(write.queued_at, "2026-01-01T00:00:00Z");
        assert_eq!(write.answered_at.as_deref(), Some("2026-01-02T00:00:00Z"));
    }

    #[test]
    fn a_send_is_numbered_one_past_the_highest_and_before_that_has_no_number() {
        let conn = conn();
        let write = enqueue(
            &conn,
            &NewWrite {
                kind: WriteKind::UploadBlob,
                item_id: None,
                target_id: None,
                edge_id: None,
                namespace: None,
                tag: None,
                blob: Some("a-blob"),
                base_version: None,
                payload: "{}",
                depends_on: &[],
            },
        )
        .unwrap();
        assert_eq!(last_sent_seq(&conn, &write.id).unwrap(), None);
        assert_eq!(last_sent_seq(&conn, "no-such-write").unwrap(), None);

        mark_sent(&conn, &write.id).unwrap();
        assert_eq!(last_sent_seq(&conn, &write.id).unwrap(), Some(1));
        let other = enqueue(
            &conn,
            &NewWrite {
                kind: WriteKind::UploadBlob,
                item_id: None,
                target_id: None,
                edge_id: None,
                namespace: None,
                tag: None,
                blob: Some("another-blob"),
                base_version: None,
                payload: "{}",
                depends_on: &[],
            },
        )
        .unwrap();
        mark_sent(&conn, &other.id).unwrap();
        mark_sent(&conn, &write.id).unwrap();
        assert_eq!(
            (
                last_sent_seq(&conn, &other.id).unwrap(),
                last_sent_seq(&conn, &write.id).unwrap()
            ),
            (Some(2), Some(3)),
            "a send was not numbered after every send before it, across writes"
        );
    }

    #[test]
    fn a_streak_of_environmental_failures_ends_with_any_other_outcome() {
        let conn = conn();
        let queue = || {
            enqueue(
                &conn,
                &NewWrite {
                    kind: WriteKind::UploadBlob,
                    item_id: None,
                    target_id: None,
                    edge_id: None,
                    namespace: None,
                    tag: None,
                    blob: Some("a-blob"),
                    base_version: None,
                    payload: "{}",
                    depends_on: &[],
                },
            )
            .unwrap()
        };
        let met = LastFailure::of(Some(413), b"too large");
        let state = |id: &str| {
            let write = queued_write(&conn, id).unwrap().unwrap();
            (write.environmental_streak, write.last_failure.is_some())
        };
        let began = |id: &str| -> Option<i64> {
            conn.query_row(
                "SELECT environmental_since FROM queue WHERE id = ?1",
                [id],
                |row| row.get(0),
            )
            .unwrap()
        };
        let fail = |id: &str, times: i64| {
            for _ in 0..times {
                count_environmental(&conn, id, &met).unwrap();
            }
        };

        // A failure more than fifteen minutes after the last, or after a time
        // the clock has not reached, begins a new run.
        let set_last = |id: &str, behind_ms: i64| {
            conn.execute(
                "UPDATE queue SET environmental_since = environmental_since - ?2,
                                  environmental_last = environmental_last - ?2
                  WHERE id = ?1",
                params![id, behind_ms],
            )
            .unwrap();
        };
        let minute = 60_000;
        let old_run = queue();
        fail(&old_run.id, 2);
        set_last(&old_run.id, 14 * minute);
        let kept = count_environmental(&conn, &old_run.id, &met).unwrap();
        assert_eq!(kept.count, 3, "a gap under fifteen minutes began a new run");
        set_last(&old_run.id, 16 * minute);
        let again = count_environmental(&conn, &old_run.id, &met).unwrap();
        assert_eq!(again.count, 1, "a gap over fifteen minutes kept the run");
        assert!(
            now_millis() - again.began_ms < minute,
            "the new run did not begin at the failure"
        );

        let ahead = queue();
        fail(&ahead.id, 2);
        set_last(&ahead.id, -24 * 60 * minute);
        let restarted = count_environmental(&conn, &ahead.id, &met).unwrap();
        assert_eq!(restarted.count, 1, "a run ahead of the clock was kept");
        assert!(
            restarted.began_ms <= now_millis(),
            "the run still began ahead of the clock"
        );

        let counted = queue();
        assert_eq!(began(&counted.id), None);
        let first = count_environmental(&conn, &counted.id, &met).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        let second = count_environmental(&conn, &counted.id, &met).unwrap();
        assert_eq!(
            (first.count, second.count, second.began_ms),
            (1, 2, first.began_ms),
            "a second failure moved the start of the run"
        );
        assert_eq!(state(&counted.id), (2, true));
        assert_eq!(count_refusal(&conn, &counted.id).unwrap(), 1);
        assert_eq!(
            state(&counted.id),
            (0, false),
            "a refusal counted left the run of environmental failures standing"
        );
        assert_eq!(
            began(&counted.id),
            None,
            "a refusal left the start standing"
        );

        let answered = queue();
        fail(&answered.id, 2);
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
        assert_eq!(state(&answered.id), (0, false));

        // The witness: set aside, the run and the last answer are what the
        // queue shows, so a verdict does not always clear them.
        let aside = queue();
        fail(&aside.id, 3);
        record_verdict(
            &conn,
            &aside.id,
            &Answered {
                verdict: Verdict::Blocked,
                reason: Some(BlockedReason::FailingAlone.as_str()),
                answer: None,
                conflicted_copy_id: None,
            },
        )
        .unwrap();
        assert_eq!(state(&aside.id), (3, true));
        assert!(began(&aside.id).is_some());
        assert!(release(&conn, &aside.id).unwrap());
        assert_eq!(
            (state(&aside.id), began(&aside.id)),
            ((0, false), None),
            "a release left the run of the write it took back"
        );

        // An answer that says nothing of the write is recorded and nothing
        // else moves.
        let limited = queue();
        fail(&limited.id, 2);
        let before = began(&limited.id);
        note_last_failure(&conn, &limited.id, &LastFailure::of(Some(429), b"slow")).unwrap();
        assert_eq!(
            (state(&limited.id), began(&limited.id)),
            ((2, true), before),
            "recording the last answer moved the streak or its start"
        );
        assert_eq!(
            queued_write(&conn, &limited.id)
                .unwrap()
                .unwrap()
                .last_failure
                .map(|failure| failure.status),
            Some(Some(429))
        );
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
        // A device never queues a purge, so the kind must not be holdable at all.
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
            &Indexing::default(),
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
        queue(WriteKind::AddTag, r#"{"tags":["c"]}"#, Some("c"));
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

        lay_waiting_writes_over(&conn, "n1", &|_| Indexing::default()).unwrap();
        let item = items_by_ids(&conn, &["n1".into()]).unwrap().pop().unwrap();
        assert_eq!(item.properties["title"], "edited");
        assert_eq!(
            item.properties.get("body").and_then(Value::as_str),
            Some("server body"),
            "a field no waiting write names keeps the server's value"
        );
        assert_eq!(item.source_id.as_deref(), Some("moved.md"));
        assert_eq!(item.state, ItemState::Active);
        assert_eq!(item.tags, vec!["b", "c"]);

        queue(WriteKind::DeleteItem, "{}", None);
        lay_waiting_writes_over(&conn, "n1", &|_| Indexing::default()).unwrap();
        let item = items_by_ids(&conn, &["n1".into()]).unwrap().pop().unwrap();
        assert_eq!(item.state, ItemState::Trashed);

        queue(WriteKind::TransitionItem, r#"{"state":"archived"}"#, None);
        lay_waiting_writes_over(&conn, "n1", &|_| Indexing::default()).unwrap();
        let item = items_by_ids(&conn, &["n1".into()]).unwrap().pop().unwrap();
        assert_eq!(item.state, ItemState::Archived);
    }

    #[test]
    fn a_row_whose_stored_properties_cannot_be_read_is_left_as_it_is_under_its_waiting_writes() {
        let conn = conn();
        let mut edge = wire_edge("e1", "a", "b", "references");
        edge.properties.insert("weight".into(), Value::from(1));
        upsert_edge(&conn, &edge).unwrap();
        upsert_item(
            &conn,
            &note("n1", "t", "b", "2026-01-01T00:00:00Z"),
            Some(&[]),
            &Indexing::default(),
        )
        .unwrap();
        let queue = |kind: WriteKind, item: &str, edge_id: Option<&str>, payload: &str| {
            enqueue(
                &conn,
                &NewWrite {
                    kind,
                    item_id: Some(item),
                    target_id: edge_id.map(|_| "b"),
                    edge_id,
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
        queue(
            WriteKind::UpdateEdge,
            "a",
            Some("e1"),
            r#"{"properties":{"weight":2}}"#,
        );
        queue(
            WriteKind::UpdateItem,
            "n1",
            None,
            r#"{"properties":{"title":"edited"},"version":1}"#,
        );
        // The witness: the readable rows take what waits.
        lay_waiting_edge_writes_over(&conn, "e1").unwrap();
        lay_waiting_writes_over(&conn, "n1", &|_| Indexing::default()).unwrap();
        assert_eq!(
            edge_by_id(&conn, "e1").unwrap().unwrap().properties["weight"],
            2
        );

        for table in ["edges", "items"] {
            conn.execute(&format!("UPDATE {table} SET properties = '{{\"a\":'"), [])
                .unwrap();
        }
        // Damaged and not fetched again, they cannot have the writes laid
        // over them: they stay as they are, and the writes stay queued.
        lay_waiting_edge_writes_over(&conn, "e1").unwrap();
        lay_waiting_writes_over(&conn, "n1", &|_| Indexing::default()).unwrap();
        let stored: String = conn
            .query_row("SELECT properties FROM edges", [], |row| row.get(0))
            .unwrap();
        assert_eq!(stored, r#"{"a":"#);
        assert_eq!(read_writes(&conn, "", []).unwrap().len(), 2);
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
        for reason in BlockedReason::ALL
            .map(BlockedReason::as_str)
            .into_iter()
            .chain([crate::model::AWAITING_DEPENDENCY])
        {
            conn.execute(
                "INSERT INTO queue (id, kind, idempotency_key, payload, verdict, reason, queued_at)
                 VALUES (?1, 'update_item', ?1, '{}', 'blocked', ?1, '2026-01-01T00:00:00Z')",
                [reason],
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

    /// Each table whose change moves the copy's revision, with a row to
    /// insert, an update of it and its delete.
    const REVISED: [(&str, &str, &str, &str); 8] = [
        (
            "types",
            "INSERT INTO types (id, json) VALUES ('t', '{}')",
            "UPDATE types SET label = 'T' WHERE id = 't'",
            "DELETE FROM types WHERE id = 't'",
        ),
        (
            "edge_types",
            "INSERT INTO edge_types (id, json) VALUES ('e', '{}')",
            "UPDATE edge_types SET json = '{\"id\":\"e\"}' WHERE id = 'e'",
            "DELETE FROM edge_types WHERE id = 'e'",
        ),
        (
            "declared_types",
            "INSERT INTO declared_types (id, json) VALUES ('d', '{}')",
            "UPDATE declared_types SET json = '{\"id\":\"d\"}' WHERE id = 'd'",
            "DELETE FROM declared_types WHERE id = 'd'",
        ),
        (
            "items",
            "INSERT INTO items (id, type, state, version, schema_version, source, occurred_at, created_at, updated_at, properties) VALUES ('i', 'core.note', 'active', 1, 1, 'test', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '{}')",
            "UPDATE items SET version = 2 WHERE id = 'i'",
            "DELETE FROM items WHERE id = 'i'",
        ),
        (
            "edges",
            "INSERT INTO edges (id, source_id, target_id, edge_type, properties, version, created_at, updated_at) VALUES ('g', 'a', 'b', 'references', '{}', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            "UPDATE edges SET version = 2 WHERE id = 'g'",
            "DELETE FROM edges WHERE id = 'g'",
        ),
        (
            "tags",
            "INSERT INTO tags (item_id, tag) VALUES ('held', 'x')",
            "UPDATE tags SET tag = 'y' WHERE item_id = 'held'",
            "DELETE FROM tags WHERE item_id = 'held'",
        ),
        (
            "pins",
            "INSERT INTO pins (item_id) VALUES ('p')",
            "UPDATE pins SET item_id = 'q' WHERE item_id = 'p'",
            "DELETE FROM pins WHERE item_id = 'q'",
        ),
        (
            "queue",
            "INSERT INTO queue (id, kind, idempotency_key, payload, queued_at) VALUES ('w', 'update_item', 'k', '{}', '2026-01-01T00:00:00Z')",
            "UPDATE queue SET verdict = 'accepted' WHERE id = 'w'",
            "DELETE FROM queue WHERE id = 'w'",
        ),
    ];

    #[test]
    fn the_copy_revision_moves_with_each_change_to_the_copy_or_the_queue_alone() {
        let conn = conn();
        upsert_item(
            &conn,
            &note("held", "t", "b", "2026-01-01T00:00:00Z"),
            None,
            &Indexing::default(),
        )
        .unwrap();
        for (table, insert, update, delete) in REVISED {
            for statement in [insert, update, delete] {
                let before = copy_revision(&conn).unwrap();
                assert_eq!(conn.execute(statement, []).unwrap(), 1, "{statement}");
                assert_eq!(
                    copy_revision(&conn).unwrap(),
                    before + 1,
                    "{table}: {statement}"
                );
            }
        }
        // The witness is each change above; the folder's own record, the
        // file cache's bookkeeping and `meta` itself leave it where it is.
        let before = copy_revision(&conn).unwrap();
        conn.execute_batch(
            "INSERT INTO folder_files (path, item_id, content_hash, links, edge_lines, seen_at) VALUES ('a.md', 'held', 'h', '[]', '[]', '2026-01-01T00:00:00Z');
             UPDATE folder_files SET written_hash = 'h' WHERE path = 'a.md';
             INSERT INTO folder_journal (path, item_id, missing_since) VALUES ('a.md', 'held', '2026-01-01T00:00:00Z');
             INSERT INTO folder_stats (path, stat) VALUES ('a.md', '{}');
             INSERT INTO attachment_bytes (hex) VALUES ('00');
             INSERT INTO read_backs (subject, id) VALUES ('item', 'held');",
        )
        .unwrap();
        meta_set(&conn, META_EVENT_CURSOR, "7").unwrap();
        assert_eq!(copy_revision(&conn).unwrap(), before);
        assert_eq!(
            meta_get(&conn, META_COPY_REVISION).unwrap().as_deref(),
            Some(before.to_string().as_str()),
            "the triggers write the key the reader reads"
        );
    }

    #[test]
    fn a_store_made_before_the_copy_revision_gains_its_triggers_when_opened_to_write() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("older.sqlite");
        let triggers = |conn: &Connection| -> Vec<String> {
            let mut statement = conn
                .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE '%\\_revise\\_%' ESCAPE '\\' ORDER BY name")
                .unwrap();
            statement
                .query_map([], |row| row.get(0))
                .unwrap()
                .collect::<rusqlite::Result<_>>()
                .unwrap()
        };
        {
            let conn = open(&path).unwrap();
            let made = triggers(&conn);
            assert_eq!(made.len(), REVISED.len() * 3, "{made:?}");
            for name in &made {
                conn.execute_batch(&format!("DROP TRIGGER {name};"))
                    .unwrap();
            }
            upsert_item(
                &conn,
                &note("row", "t", "b", "2026-01-01T00:00:00Z"),
                None,
                &Indexing::default(),
            )
            .unwrap();
            assert_eq!(copy_revision(&conn).unwrap(), 0);
        }
        let reading = read_connection(
            Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap(),
            &path,
        )
        .unwrap();
        assert!(item_held(&reading, "row").unwrap());
        assert!(triggers(&reading).is_empty(), "a reader wrote the schema");
        drop(reading);

        let conn = open(&path).unwrap();
        assert_eq!(triggers(&conn).len(), REVISED.len() * 3);
        assert!(item_held(&conn, "row").unwrap());
        conn.execute("UPDATE items SET version = 2 WHERE id = 'row'", [])
            .unwrap();
        assert_eq!(copy_revision(&conn).unwrap(), 1);
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
        assert!(put_server_item(&conn, &later, None, &crate::catalog::Catalog::empty()).unwrap());
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
            !put_server_item(&conn, &older, None, &crate::catalog::Catalog::empty()).unwrap(),
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
    fn taking_a_server_item_lays_the_waiting_writes_over_it_unless_the_copy_holds_a_later_one() {
        let conn = conn();
        let catalog = crate::catalog::Catalog::empty();
        enqueue(
            &conn,
            &NewWrite {
                kind: WriteKind::UpdateItem,
                item_id: Some("n1"),
                target_id: None,
                edge_id: None,
                namespace: None,
                tag: None,
                blob: None,
                base_version: None,
                payload: r#"{"properties":{"title":"edited"},"version":1}"#,
                depends_on: &[],
            },
        )
        .unwrap();
        let mut server = note(
            "n1",
            "from the server",
            "server body",
            "2026-01-01T00:00:00Z",
        );
        server.version = 2;
        server.updated_at = "2026-01-02T00:00:00.000Z".into();
        assert!(take_server_item(&conn, &server, Some(&[]), &catalog).unwrap());
        let held = item_by_id(&conn, "n1").unwrap().unwrap();
        assert_eq!(held.properties["title"], "edited");
        assert_eq!(held.properties["body"], "server body");

        // Queued after the take, so not laid over the held row: a refused
        // take must leave it so.
        enqueue(
            &conn,
            &NewWrite {
                kind: WriteKind::UpdateItem,
                item_id: Some("n1"),
                target_id: None,
                edge_id: None,
                namespace: None,
                tag: None,
                blob: None,
                base_version: None,
                payload: r#"{"properties":{"title":"edited again"},"version":2}"#,
                depends_on: &[],
            },
        )
        .unwrap();
        let mut older = server.clone();
        older.version = 1;
        older.updated_at = "2026-01-01T00:00:00.000Z".into();
        older.properties.insert("title".into(), "older".into());
        assert!(!take_server_item(&conn, &older, Some(&[]), &catalog).unwrap());
        assert_eq!(item_by_id(&conn, "n1").unwrap().unwrap(), held);
    }

    #[test]
    fn taking_a_server_edge_lays_the_waiting_writes_over_it_unless_the_copy_holds_a_later_one() {
        let conn = conn();
        enqueue(
            &conn,
            &NewWrite {
                kind: WriteKind::UpdateEdge,
                item_id: Some("a"),
                target_id: Some("b"),
                edge_id: Some("e1"),
                namespace: None,
                tag: None,
                blob: None,
                base_version: None,
                payload: r#"{"properties":{"weight":2}}"#,
                depends_on: &[],
            },
        )
        .unwrap();
        let mut server = wire_edge("e1", "a", "b", "references");
        server.version = 2;
        server.updated_at = "2026-01-02T00:00:00Z".into();
        server.properties.insert("weight".into(), Value::from(1));
        server
            .properties
            .insert("note".into(), Value::from("server"));
        assert!(take_server_edge(&conn, &server).unwrap());
        let held = edge_by_id(&conn, "e1").unwrap().unwrap();
        assert_eq!(held.properties["weight"], 2);
        assert_eq!(held.properties["note"], "server");

        // Queued after the take, so not laid over the held edge: a refused
        // take must leave it so.
        enqueue(
            &conn,
            &NewWrite {
                kind: WriteKind::UpdateEdge,
                item_id: Some("a"),
                target_id: Some("b"),
                edge_id: Some("e1"),
                namespace: None,
                tag: None,
                blob: None,
                base_version: None,
                payload: r#"{"properties":{"weight":3}}"#,
                depends_on: &[],
            },
        )
        .unwrap();
        let mut older = server.clone();
        older.version = 1;
        older.updated_at = "2026-01-01T00:00:00Z".into();
        older.properties.insert("note".into(), Value::from("older"));
        assert!(!take_server_edge(&conn, &older).unwrap());
        assert_eq!(edge_by_id(&conn, "e1").unwrap().unwrap(), held);
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
            13
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

    /// The queue an earlier build made, whose `CHECK` still admits `kind`.
    fn queue_admitting(conn: &Connection, kind: &str) {
        let made: String = conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'queue'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let earlier = made.replacen(
            "'replace_metadata',",
            &format!("'replace_metadata', '{kind}',"),
            1,
        );
        assert_ne!(earlier, made);
        conn.execute_batch(&format!("DROP TABLE queue; {earlier};"))
            .unwrap();
    }

    #[test]
    fn a_queued_write_of_a_kind_this_build_does_not_send_is_refused_by_name() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("core.sqlite");
        let hold = |verdict: Option<&str>| {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch("DELETE FROM queue").unwrap();
            conn.execute(
                "INSERT INTO queue (id, kind, item_id, idempotency_key, payload, queued_at, verdict, sent)
                 VALUES ('q1', 'merge_metadata', 'n1', 'k1', '{\"tags\":[\"a\"]}',
                         '2026-01-01T00:00:00Z', ?1, ?2)",
                params![verdict, verdict.is_some()],
            )
            .unwrap();
        };
        {
            let conn = open(&path).unwrap();
            queue_admitting(&conn, "merge_metadata");
        }
        // A refused write that carried content stays until discarded, so it
        // is counted with the waiting one.
        for verdict in [None, Some("refused"), Some("dead")] {
            hold(verdict);
            let (reason, unsent, said) = refusal_of(&path);
            assert!(
                reason.contains("1 write of kind merge_metadata, which this build cannot send"),
                "{verdict:?}: {reason}"
            );
            assert_eq!(unsent, Some(1), "{verdict:?}");
            assert!(said.contains("1 write the server has not taken"), "{said}");
            assert!(
                matches!(open_to_read(&path), Err(CoreError::WrongSchema { reason, .. })
                    if reason.contains("merge_metadata")),
                "a reader opened it"
            );
            let conn = Connection::open(&path).unwrap();
            assert_eq!(
                conn.query_row("SELECT kind FROM queue", [], |row| row.get::<_, String>(0))
                    .unwrap(),
                "merge_metadata",
                "refusing the store took the write"
            );
        }
        // The witness: the same earlier queue with the write answered names
        // no kind, and is refused only for its shape.
        hold(Some("accepted"));
        let (reason, unsent, _) = refusal_of(&path);
        assert!(!reason.contains("merge_metadata"), "{reason}");
        assert!(reason.contains("its table queue"), "{reason}");
        assert_eq!(unsent, Some(0));
    }

    #[test]
    fn a_store_with_the_older_index_is_refused_with_its_queue_kept() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("core.sqlite");
        {
            let conn = open(&path).unwrap();
            queue_one(&conn);
            conn.execute_batch(
                "DROP TABLE items_fts;
                 CREATE VIRTUAL TABLE items_fts USING fts5 (
                   title, body, tags, tokenize = 'unicode61 remove_diacritics 2'
                 );",
            )
            .unwrap();
        }
        let (reason, unsent, _) = refusal_of(&path);
        assert!(reason.contains("items_fts"), "{reason}");
        assert_eq!(unsent, Some(1));
        let conn = Connection::open(&path).unwrap();
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM queue", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            1,
            "refusing the old index took the write beside it"
        );
    }

    #[test]
    fn a_store_without_folder_presentation_is_refused_without_losing_its_queue() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("core.sqlite");
        {
            let conn = open(&path).unwrap();
            queue_one(&conn);
            conn.execute_batch("ALTER TABLE folder_files DROP COLUMN presentation")
                .unwrap();
        }
        let (reason, unsent, _) = refusal_of(&path);
        assert!(reason.contains("folder_files"), "{reason}");
        assert_eq!(unsent, Some(1));
        let conn = Connection::open(&path).unwrap();
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM queue", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert!(!held_shape(&conn).unwrap()["folder_files"].contains("presentation"));
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
            "319dffa2a6b94db9",
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
    #[test]
    fn a_confirmed_replacement_does_not_replay_a_historical_dead_overlay() {
        let conn = conn();
        let row = note(
            "held",
            "confirmed title",
            "confirmed body",
            "2026-01-01T00:00:00Z",
        );
        upsert_item(&conn, &row, None, &Indexing::default()).unwrap();
        conn.execute("INSERT INTO queue (id,kind,item_id,idempotency_key,payload,sent,verdict,queued_at) VALUES ('dead','update_item','held','dead',?1,1,'dead','2026-01-01T00:00:00Z')", [r#"{"properties":{"title":"old title","body":"old body"},"properties_mode":"replace"}"#]).unwrap();
        conn.execute("INSERT INTO queue (id,kind,item_id,idempotency_key,payload,sent,verdict,queued_at) VALUES ('later','update_item','held','later',?1,1,NULL,'2026-01-01T00:00:01Z')", [r#"{"properties":{"title":"confirmed title","body":"confirmed body"}}"#]).unwrap();
        record_verdict(
            &conn,
            "later",
            &Answered {
                verdict: Verdict::Accepted,
                reason: None,
                answer: None,
                conflicted_copy_id: None,
            },
        )
        .unwrap();
        let original = queued_write(&conn, "dead").unwrap().unwrap();
        for _ in 0..2 {
            lay_waiting_writes_over(&conn, "held", &|_| Indexing::default()).unwrap();
            let item = item_by_id(&conn, "held").unwrap().unwrap();
            assert_eq!(item.properties["body"], "confirmed body");
            assert_eq!(item.properties["title"], "confirmed title");
            forget_answered(&conn).unwrap();
            assert_eq!(queued_write(&conn, "dead").unwrap().unwrap(), original);
        }
    }
    fn effect_fixture() -> Connection {
        let conn = conn();
        replace_types(&conn, &[wire_type("core.note", None, Some("title"))]).unwrap();
        let row = note(
            "held",
            "server title",
            "server body",
            "2026-01-01T00:00:00Z",
        );
        upsert_item(&conn, &row, None, &Indexing::default()).unwrap();
        conn.execute("INSERT INTO queue (id,kind,item_id,idempotency_key,payload,read,sent,verdict,queued_at) VALUES ('dead','update_item','held','old-attempt',?1,?2,1,'dead','2026-01-01T00:00:00Z')", params![r#"{"properties":{"title":"old title","body":"old body"},"properties_mode":"replace"}"#, r#"{"properties":{"title":"before","body":"before","description":"remove me"}}"#]).unwrap();
        conn
    }

    fn effect_answer(conn: &Connection, id: &str, payload: &str, verdict: Verdict) {
        conn.execute("INSERT INTO queue (id,kind,item_id,idempotency_key,payload,sent,queued_at) VALUES (?1,'update_item','held',?1,?2,1,'2026-01-01T00:00:01Z')", params![id, payload]).unwrap();
        record_verdict(
            conn,
            id,
            &Answered {
                verdict,
                reason: None,
                answer: None,
                conflicted_copy_id: None,
            },
        )
        .unwrap();
    }

    #[test]
    fn dead_partial_effects_mask_both_payload_and_read_and_merge_null_is_noop() {
        let conn = effect_fixture();
        let original = queued_write(&conn, "dead").unwrap().unwrap();
        let original_read = read_of(&conn, "dead").unwrap();
        effect_answer(
            &conn,
            "title",
            r#"{"properties":{"title":"server title","body":null}}"#,
            Verdict::Accepted,
        );
        lay_waiting_writes_over(&conn, "held", &|_| Indexing::default()).unwrap();
        let item = item_by_id(&conn, "held").unwrap().unwrap();
        assert_eq!(
            item.properties["title"], "server title",
            "masked captured read must not delete the confirmed title"
        );
        assert_eq!(
            item.properties["body"], "old body",
            "merge null did not apply a body replacement"
        );
        assert!(!item.properties.contains_key("description"));
        assert_eq!(current_item_writes(&conn, "held").unwrap().len(), 1);
        effect_answer(
            &conn,
            "body",
            r#"{"properties":{"body":"confirmed body"}}"#,
            Verdict::Accepted,
        );
        assert_eq!(
            current_item_writes(&conn, "held").unwrap().len(),
            1,
            "unconfirmed removal still waits"
        );
        effect_answer(
            &conn,
            "whole",
            r#"{"properties":{"title":"confirmed title","body":"confirmed body"},"properties_mode":"replace"}"#,
            Verdict::Accepted,
        );
        assert!(current_item_writes(&conn, "held").unwrap().is_empty());
        assert_eq!(queued_write(&conn, "dead").unwrap().unwrap(), original);
        assert_eq!(read_of(&conn, "dead").unwrap(), original_read);
        assert_eq!(forget_answered(&conn).unwrap(), 3);
        assert!(current_item_writes(&conn, "held").unwrap().is_empty());
        assert!(release(&conn, "dead").unwrap());
        let released = queued_write(&conn, "dead").unwrap().unwrap();
        assert_eq!(released.body, original.body);
        assert_ne!(released.idempotency_key, original.idempotency_key);
        lay_waiting_writes_over(&conn, "held", &|_| Indexing::default()).unwrap();
        assert_eq!(
            item_by_id(&conn, "held").unwrap().unwrap().properties["title"],
            "old title"
        );
        record_verdict(
            &conn,
            "dead",
            &Answered {
                verdict: Verdict::Dead,
                reason: None,
                answer: None,
                conflicted_copy_id: None,
            },
        )
        .unwrap();
        assert_eq!(current_item_writes(&conn, "held").unwrap().len(), 1);
    }

    #[test]
    fn only_accepted_effects_settle_dead_intent_and_receipt_rollback_is_atomic() {
        for verdict in [
            Verdict::Merged,
            Verdict::Conflicted,
            Verdict::Refused,
            Verdict::Dead,
            Verdict::Blocked,
        ] {
            let conn = effect_fixture();
            effect_answer(
                &conn,
                "later",
                r#"{"properties":{"title":"new","body":"new"},"properties_mode":"replace"}"#,
                verdict,
            );
            assert!(
                remaining_dead_fields(&conn, &queued_write(&conn, "dead").unwrap().unwrap())
                    .unwrap()
                    .unwrap()
                    .len()
                    >= 3
            );
        }
        let conn = effect_fixture();
        conn.execute("INSERT INTO queue (id,kind,item_id,idempotency_key,payload,sent,queued_at) VALUES ('later','update_item','held','later',?1,1,'2026-01-01T00:00:01Z')", [r#"{"properties":{"title":"new","body":"new"},"properties_mode":"replace"}"#]).unwrap();
        conn.execute_batch("CREATE TRIGGER fail_effect BEFORE INSERT ON meta WHEN NEW.key LIKE 'dead_effect/%' BEGIN SELECT RAISE(ABORT, 'effect write failed'); END;").unwrap();
        assert!(
            record_verdict(
                &conn,
                "later",
                &Answered {
                    verdict: Verdict::Accepted,
                    reason: None,
                    answer: None,
                    conflicted_copy_id: None
                }
            )
            .is_err()
        );
        assert!(
            queued_write(&conn, "later")
                .unwrap()
                .unwrap()
                .verdict
                .is_none()
        );
        assert!(meta_get(&conn, &effect_key("dead")).unwrap().is_none());
        assert!(!current_item_writes(&conn, "held").unwrap().is_empty());
    }

    #[test]
    fn a_dead_delete_is_settled_by_an_accepted_restore_but_release_restores_delete() {
        let conn = effect_fixture();
        conn.execute(
            "UPDATE queue SET kind='delete_item', payload='{}', read=NULL WHERE id='dead'",
            [],
        )
        .unwrap();
        conn.execute("INSERT INTO queue (id,kind,item_id,idempotency_key,payload,sent,queued_at) VALUES ('restore','restore_item','held','restore','{}',1,'2026-01-01T00:00:01Z')", []).unwrap();
        record_verdict(
            &conn,
            "restore",
            &Answered {
                verdict: Verdict::Accepted,
                reason: None,
                answer: None,
                conflicted_copy_id: None,
            },
        )
        .unwrap();
        assert!(current_item_writes(&conn, "held").unwrap().is_empty());
        assert!(release(&conn, "dead").unwrap());
        record_verdict(
            &conn,
            "dead",
            &Answered {
                verdict: Verdict::Dead,
                reason: None,
                answer: None,
                conflicted_copy_id: None,
            },
        )
        .unwrap();
        // Re-reading the old receipt must not suppress the released attempt.
        record_verdict(
            &conn,
            "restore",
            &Answered {
                verdict: Verdict::Accepted,
                reason: None,
                answer: None,
                conflicted_copy_id: None,
            },
        )
        .unwrap();
        lay_waiting_writes_over(&conn, "held", &|_| Indexing::default()).unwrap();
        assert_eq!(
            conn.query_row("SELECT state FROM items WHERE id='held'", [], |row| row
                .get::<_, String>(
                0
            ))
            .unwrap(),
            "trashed"
        );
    }
    #[test]
    fn delayed_pre_release_receipts_do_not_cover_the_new_attempt() {
        let conn = effect_fixture();
        conn.execute("INSERT INTO queue (id,kind,item_id,idempotency_key,payload,sent,queued_at) VALUES ('inflight','update_item','held','old-inflight',?1,1,'2026-01-01T00:00:01Z')", [r#"{"properties":{"title":"new","body":"new"},"properties_mode":"replace"}"#]).unwrap();
        assert!(release(&conn, "dead").unwrap());
        record_verdict(
            &conn,
            "dead",
            &Answered {
                verdict: Verdict::Dead,
                reason: None,
                answer: None,
                conflicted_copy_id: None,
            },
        )
        .unwrap();
        record_verdict(
            &conn,
            "inflight",
            &Answered {
                verdict: Verdict::Accepted,
                reason: None,
                answer: None,
                conflicted_copy_id: None,
            },
        )
        .unwrap();
        assert!(!current_item_writes(&conn, "held").unwrap().is_empty());
        // A released witness has a new attempt key and may cover this work.
        conn.execute("UPDATE queue SET verdict='dead' WHERE id='inflight'", [])
            .unwrap();
        assert!(release(&conn, "inflight").unwrap());
        record_verdict(
            &conn,
            "inflight",
            &Answered {
                verdict: Verdict::Accepted,
                reason: None,
                answer: None,
                conflicted_copy_id: None,
            },
        )
        .unwrap();
        assert!(current_item_writes(&conn, "held").unwrap().is_empty());
    }
    #[test]
    fn partial_dead_edge_projection_keeps_only_unresolved_properties() {
        let conn = conn();
        let mut edge = wire_edge("edge", "source", "target", "references");
        edge.properties =
            serde_json::from_value(serde_json::json!({"a":"server a","b":"server b"})).unwrap();
        upsert_edge(&conn, &edge).unwrap();
        conn.execute("INSERT INTO queue (id,kind,edge_id,idempotency_key,payload,sent,verdict,queued_at) VALUES ('dead','update_edge','edge','dead',?1,1,'dead','2026-01-01T00:00:00Z')", [r#"{"properties":{"a":"old a","b":"old b"}}"#]).unwrap();
        conn.execute("INSERT INTO queue (id,kind,edge_id,idempotency_key,payload,sent,queued_at) VALUES ('later','update_edge','edge','later',?1,1,'2026-01-01T00:00:01Z')", [r#"{"properties":{"a":"server a"}}"#]).unwrap();
        record_verdict(
            &conn,
            "later",
            &Answered {
                verdict: Verdict::Accepted,
                reason: None,
                answer: None,
                conflicted_copy_id: None,
            },
        )
        .unwrap();
        lay_waiting_edge_writes_over(&conn, "edge").unwrap();
        let current = edge_by_id(&conn, "edge").unwrap().unwrap();
        assert_eq!(current.properties["a"], "server a");
        assert_eq!(current.properties["b"], "old b");
        assert_eq!(forget_answered(&conn).unwrap(), 1);
        lay_waiting_edge_writes_over(&conn, "edge").unwrap();
        assert_eq!(
            edge_by_id(&conn, "edge").unwrap().unwrap().properties["a"],
            "server a"
        );
        assert_eq!(
            queued_write(&conn, "dead").unwrap().unwrap().body["properties"]["a"],
            "old a"
        );
    }
    #[test]
    fn review_purge_must_still_refuse_releasable_dead_work() {
        let core = crate::Core::open_in_memory(None).unwrap();
        {
            let conn = core.conn().unwrap();
            conn.execute("INSERT INTO queue (id,kind,item_id,idempotency_key,payload,sent,verdict,queued_at) VALUES ('dead','update_item','held','dead',?1,1,'dead','2026-01-01T00:00:00Z')", [r#"{"properties":{"title":"old"}}"#]).unwrap();
        }
        assert!(
            matches!(core.purge_item("held", Some(1)), Err(CoreError::Invalid(_))),
            "witness: pending dead write blocks before server transport"
        );
        {
            let conn = core.conn().unwrap();
            effect_answer(
                &conn,
                "later",
                r#"{"properties":{"title":"new"}}"#,
                Verdict::Accepted,
            );
            assert_eq!(
                queued_write(&conn, "dead").unwrap().unwrap().verdict,
                Some(Verdict::Dead)
            );
        }
        let result = core.purge_item("held", Some(1));
        eprintln!("covered dead purge result: {result:?}");
        assert!(
            matches!(result, Err(CoreError::Invalid(_))),
            "coverage must not bypass device/purge-waiting protection"
        );
    }

    #[test]
    fn review_accepted_metadata_replace_must_cover_dead_tag() {
        let conn = effect_fixture();
        conn.execute(
            "UPDATE queue SET kind='add_tag',tag='stale',payload=?1,read=NULL WHERE id='dead'",
            [r#"{"tags":["stale"]}"#],
        )
        .unwrap();
        lay_waiting_writes_over(&conn, "held", &|_| Indexing::default()).unwrap();
        assert!(
            item_by_id(&conn, "held")
                .unwrap()
                .unwrap()
                .tags
                .contains(&"stale".to_string()),
            "witness: unresolved tag projects"
        );
        remove_tag(&conn, "held", "stale").unwrap();
        conn.execute("INSERT INTO queue (id,kind,item_id,idempotency_key,payload,sent,queued_at) VALUES ('later','replace_metadata','held','later',?1,1,'2026-01-01T00:00:01Z')", [r#"{"tags":[]}"#]).unwrap();
        record_verdict(
            &conn,
            "later",
            &Answered {
                verdict: Verdict::Accepted,
                reason: None,
                answer: None,
                conflicted_copy_id: None,
            },
        )
        .unwrap();
        lay_waiting_writes_over(&conn, "held", &|_| Indexing::default()).unwrap();
        assert!(
            !item_by_id(&conn, "held")
                .unwrap()
                .unwrap()
                .tags
                .contains(&"stale".to_string()),
            "accepted replacement must keep the dead tag from returning"
        );
    }

    #[test]
    fn review_accepted_edge_null_must_cover_dead_property() {
        let conn = conn();
        let mut edge = wire_edge("edge", "source", "target", "references");
        edge.properties =
            serde_json::from_value(serde_json::json!({"a":null,"b":"server b"})).unwrap();
        upsert_edge(&conn, &edge).unwrap();
        conn.execute("INSERT INTO queue (id,kind,edge_id,idempotency_key,payload,sent,verdict,queued_at) VALUES ('dead','update_edge','edge','dead',?1,1,'dead','2026-01-01T00:00:00Z')", [r#"{"properties":{"a":"old a","b":"old b"}}"#]).unwrap();
        conn.execute("INSERT INTO queue (id,kind,edge_id,idempotency_key,payload,sent,queued_at) VALUES ('later','update_edge','edge','later',?1,1,'2026-01-01T00:00:01Z')", [r#"{"properties":{"a":null}}"#]).unwrap();
        record_verdict(
            &conn,
            "later",
            &Answered {
                verdict: Verdict::Accepted,
                reason: None,
                answer: None,
                conflicted_copy_id: None,
            },
        )
        .unwrap();
        lay_waiting_edge_writes_over(&conn, "edge").unwrap();
        let current = edge_by_id(&conn, "edge").unwrap().unwrap();
        assert_eq!(
            current.properties["b"], "old b",
            "witness: unresolved b remains projected"
        );
        assert!(
            current.properties["a"].is_null(),
            "edge merge stores null; the old dead a must not overwrite it"
        );
    }
    #[test]
    fn metadata_tag_coverage_keeps_partial_membership_and_raw_releasable_work() {
        let cases = [
            (
                "add_tag",
                Some("stale"),
                r#"{"tags":["stale"]}"#,
                "replace_metadata",
                None,
                r#"{"tags":[]}"#,
                vec![],
                vec![],
                false,
            ),
            (
                "remove_tag",
                Some("stale"),
                "{}",
                "replace_metadata",
                None,
                r#"{"tags":["stale"]}"#,
                vec!["stale"],
                vec!["stale"],
                false,
            ),
            (
                "replace_metadata",
                None,
                r#"{"tags":["old","keep"]}"#,
                "replace_metadata",
                None,
                r#"{"tags":["new"]}"#,
                vec!["new"],
                vec!["new"],
                false,
            ),
            (
                "replace_metadata",
                None,
                r#"{"tags":["old","keep"]}"#,
                "add_tag",
                Some("new"),
                r#"{"tags":["new"]}"#,
                vec!["new", "other"],
                vec!["keep", "new", "old"],
                true,
            ),
            (
                "replace_metadata",
                None,
                r#"{"tags":["old","keep"]}"#,
                "remove_tag",
                Some("old"),
                "{}",
                vec![],
                vec!["keep"],
                true,
            ),
            (
                "remove_tag",
                Some("stale"),
                "{}",
                "add_tag",
                Some("stale"),
                r#"{"tags":["stale"]}"#,
                vec!["stale"],
                vec!["stale"],
                false,
            ),
            (
                "add_tag",
                Some("stale"),
                r#"{"tags":["stale"]}"#,
                "add_tag",
                Some("other"),
                r#"{"tags":["other"]}"#,
                vec!["other"],
                vec!["other", "stale"],
                true,
            ),
        ];
        for (
            kind,
            tag,
            payload,
            later_kind,
            later_tag,
            later_payload,
            baseline,
            expected,
            current,
        ) in cases
        {
            let conn = effect_fixture();
            conn.execute(
                "UPDATE queue SET kind=?1, tag=?2, payload=?3, read=NULL WHERE id='dead'",
                params![kind, tag, payload],
            )
            .unwrap();
            replace_tags(
                &conn,
                "held",
                &baseline
                    .iter()
                    .map(|tag| tag.to_string())
                    .collect::<Vec<_>>(),
            )
            .unwrap();
            conn.execute("INSERT INTO queue (id,kind,item_id,tag,idempotency_key,payload,sent,queued_at) VALUES ('later',?1,'held',?2,'later',?3,1,'2026-01-01T00:00:01Z')", params![later_kind,later_tag,later_payload]).unwrap();
            let original = queued_write(&conn, "dead").unwrap().unwrap();
            record_verdict(
                &conn,
                "later",
                &Answered {
                    verdict: Verdict::Accepted,
                    reason: None,
                    answer: None,
                    conflicted_copy_id: None,
                },
            )
            .unwrap();
            for _ in 0..2 {
                lay_waiting_writes_over(&conn, "held", &|_| Indexing::default()).unwrap();
                assert_eq!(
                    item_by_id(&conn, "held").unwrap().unwrap().tags,
                    expected,
                    "{kind} -> {later_kind}"
                );
                assert_eq!(
                    !current_item_writes(&conn, "held").unwrap().is_empty(),
                    current
                );
                assert_eq!(
                    waiting_writes_for_item(&conn, "held").unwrap().len(),
                    1,
                    "covered work remains releasable"
                );
                assert_eq!(queued_write(&conn, "dead").unwrap().unwrap(), original);
                forget_answered(&conn).unwrap();
            }
            release(&conn, "dead").unwrap();
            record_verdict(
                &conn,
                "dead",
                &Answered {
                    verdict: Verdict::Dead,
                    reason: None,
                    answer: None,
                    conflicted_copy_id: None,
                },
            )
            .unwrap();
            assert_eq!(current_item_writes(&conn, "held").unwrap().len(), 1);
        }
    }

    #[test]
    fn partial_dead_edge_null_remains_projected_and_releasable_after_coverage() {
        let conn = conn();
        let mut edge = wire_edge("edge", "source", "target", "references");
        edge.properties =
            serde_json::from_value(serde_json::json!({"a":"server a","b":"new b"})).unwrap();
        upsert_edge(&conn, &edge).unwrap();
        conn.execute("INSERT INTO queue (id,kind,edge_id,idempotency_key,payload,sent,verdict,queued_at) VALUES ('dead','update_edge','edge','dead',?1,1,'dead','2026-01-01T00:00:00Z')", [r#"{"properties":{"a":null,"b":"old b"}}"#]).unwrap();
        conn.execute("INSERT INTO queue (id,kind,edge_id,idempotency_key,payload,sent,queued_at) VALUES ('later','update_edge','edge','later',?1,1,'2026-01-01T00:00:01Z')", [r#"{"properties":{"b":"new b"}}"#]).unwrap();
        record_verdict(
            &conn,
            "later",
            &Answered {
                verdict: Verdict::Accepted,
                reason: None,
                answer: None,
                conflicted_copy_id: None,
            },
        )
        .unwrap();
        lay_waiting_edge_writes_over(&conn, "edge").unwrap();
        let edge = edge_by_id(&conn, "edge").unwrap().unwrap();
        assert!(edge.properties["a"].is_null());
        assert_eq!(edge.properties["b"], "new b");
        assert_eq!(current_edge_writes(&conn, "edge").unwrap().len(), 1);
        assert_eq!(waiting_writes_for_edge(&conn, "edge").unwrap().len(), 1);
    }

    #[test]
    fn clearing_removed_queue_rows_cleans_their_effect_slot_without_mutating_rejected_stores() {
        let conn = effect_fixture();
        release(&conn, "dead").unwrap();
        assert!(meta_get(&conn, &effect_key("dead")).unwrap().is_some());
        conn.execute("UPDATE queue SET kind='remove_tag', tag='stale', verdict='refused', sent=1 WHERE id='dead'",[]).unwrap();
        assert_eq!(forget_answered(&conn).unwrap(), 1);
        assert!(meta_get(&conn, &effect_key("dead")).unwrap().is_none());
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("core.sqlite");
        let malformed = open(&path).unwrap();
        queue_one(&malformed);
        meta_set(
            &malformed,
            "dead_effect/orphan",
            "fixture must survive refusal",
        )
        .unwrap();
        malformed
            .execute_batch("ALTER TABLE queue RENAME COLUMN follows TO after_write")
            .unwrap();
        assert!(matches!(open(&path), Err(CoreError::WrongSchema { .. })));
        assert!(matches!(
            open_to_read(&path),
            Err(CoreError::WrongSchema { .. })
        ));
        assert_eq!(
            meta_get(&malformed, "dead_effect/orphan")
                .unwrap()
                .as_deref(),
            Some("fixture must survive refusal")
        );
    }
}
