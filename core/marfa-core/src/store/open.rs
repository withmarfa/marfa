//! Opening a store: making it, checking its shape, and setting aside or replacing one this build cannot use.

use super::meta::{META_STORE_ID, meta_get, meta_set};
use super::unsent::{folder_unsent, unsendable, untaken, untaken_count};
use crate::error::CoreError;
use rusqlite::Connection;
use std::collections::HashMap;
use std::path::Path;

pub const SCHEMA: &str = include_str!("../schema.sql");

/// SQLite's `user_version`; a shape change increments it and appends to `SHAPES`.
pub const SCHEMA_VERSION: i64 = 6;

/// Moves with `SCHEMA_VERSION` until the first compatible release, then stays fixed.
pub(super) const OLDEST_UPGRADED: i64 = SCHEMA_VERSION;

/// One SQL step per version, starting at `OLDEST_UPGRADED`.
pub(super) const UPGRADES: &[&str] = &[];

fn upgraded(found: i64) -> bool {
    (OLDEST_UPGRADED..SCHEMA_VERSION).contains(&found)
}

pub fn open(path: &Path) -> Result<Connection, CoreError> {
    crate::damage::refuse_emptied(path)?;
    let seen = crate::damage::seen();
    let conn = Connection::open(path)?;
    // The store may have been named by an environment variable rather than
    // typed, so the refusal names its path.
    prepare(&conn).map_err(|error| {
        crate::damage::keep_log_if_met(&conn, seen);
        crate::damage::at_path(at_path(error, path), path)
    })?;
    Ok(conn)
}

#[cfg(unix)]
pub(crate) fn open_directory(
    vfs: &crate::directory_vfs::DirectoryVfs,
    label: &Path,
) -> Result<Connection, CoreError> {
    let seen = crate::damage::seen();
    let conn = vfs.open(
        FOLDER_STORE,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE
            | rusqlite::OpenFlags::SQLITE_OPEN_CREATE
            | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    prepare(&conn).map_err(|error| {
        crate::damage::keep_log_if_met(&conn, seen);
        in_folder(error, label, &conn)
    })?;
    Ok(conn)
}

pub(crate) fn at_path(error: CoreError, path: &Path) -> CoreError {
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
        CoreError::StoreDamaged { path, reason, .. } if path.is_empty() => {
            CoreError::StoreDamaged {
                path: label.display().to_string(),
                reason,
                unsent: folder_unsent(conn),
            }
        }
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
/// other than this build's, which a replacement cannot carry: its statement,
/// or for `folder_files` also a file's record this build does not read.
#[cfg(unix)]
fn uncarried(conn: &Connection) -> Result<Option<&'static str>, CoreError> {
    let held = held_shape(conn)?;
    let built = built_shape()?;
    if let Some(table) = FOLDER_TABLES.into_iter().find(|table| {
        held.get(*table)
            .is_some_and(|statement| built.get(*table) != Some(statement))
    }) {
        return Ok(Some(table));
    }
    if held.contains_key("folder_files") && crate::folder::state::unreadable_record(conn)?.is_some()
    {
        return Ok(Some("folder_files"));
    }
    Ok(None)
}

/// Opens another process's store to read: makes no store and applies no
/// schema. Read-only in SQLite rather than by promise, because a read-write
/// connection that closes last checkpoints the writer's journal into the file.
/// SQLite may still create the WAL's two side files, which a WAL reader needs.
pub fn open_to_read(path: &Path) -> Result<Connection, CoreError> {
    crate::damage::refuse_emptied(path)?;
    let seen = crate::damage::seen();
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
    read_checked(&conn, path).inspect_err(|_| crate::damage::keep_log_if_met(&conn, seen))?;
    Ok(conn)
}

/// Why a writer would refuse the store at `path`, read without changing it:
/// `None` where a writer would open it.
pub(crate) fn refusal(path: &Path) -> Result<Option<CoreError>, CoreError> {
    let conn = open_refused(path)?;
    match version(&conn)? {
        SCHEMA_VERSION => Ok(None),
        0 if !holds_tables(&conn)? => Ok(None),
        found if upgraded(found) => Ok(None),
        found => Ok(Some(at_path(refused(&conn, found), path))),
    }
}

/// The store at `path` opened to read, whatever its shape, for the caller
/// that holds its writer lock. SQLite may make a `-shm` index beside a log to
/// read it.
pub(crate) fn open_refused(path: &Path) -> Result<Connection, CoreError> {
    crate::damage::refuse_emptied(path)?;
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

/// The writes the store at `path` holds that the server has not taken, in
/// queue order, as `read_unsent` lists them, read whatever the store's shape
/// for the caller that holds its writer lock. A store with no table holds
/// none. `None` where they cannot be read, as in a file that is not a store.
/// The caller refuses a folder's store first (`refuse_folders`).
pub(crate) fn removal_writes(path: &Path) -> Option<Vec<crate::UnsentWrite>> {
    let Ok(conn) = open_refused(path) else {
        return None;
    };
    let Ok(tables) = conn.query_row("SELECT COUNT(*) FROM sqlite_schema", [], |row| {
        row.get::<_, i64>(0)
    }) else {
        return None;
    };
    if tables == 0 {
        return Some(Vec::new());
    }
    untaken(&conn)
}

// The path and registry identify folder stores even when their pages do not read.
pub(crate) fn refuse_folders(path: &Path) -> Result<(), CoreError> {
    let bound = || {
        open_refused(path).is_ok_and(|conn| {
            meta_get(&conn, crate::folder::settings_file::META_FOLDER)
                .ok()
                .flatten()
                .is_some()
        })
    };
    if kept_by_folder(path) || bound() {
        return Err(folders(path));
    }
    Ok(())
}

fn folders(path: &Path) -> CoreError {
    CoreError::Invalid(format!(
        "{} is a folder's store: remove the folder instead (`marfa folders remove`), which keeps its registry and its files in step, and add it again",
        path.display()
    ))
}

fn kept_by_folder(path: &Path) -> bool {
    let named = |name: Option<&std::ffi::OsStr>, expected: &str| {
        name.and_then(|name| name.to_str())
            .is_some_and(|name| name.eq_ignore_ascii_case(expected))
    };
    if !named(path.file_name(), FOLDER_STORE) {
        return false;
    }
    let state = path
        .parent()
        .filter(|state| !state.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    if named(state.file_name(), crate::folder::STATE_DIR) {
        return true;
    }
    let Ok(here) = std::fs::metadata(state) else {
        return false;
    };
    crate::folder::registry::listing().iter().any(|entry| {
        std::fs::metadata(entry.dir.join(crate::folder::STATE_DIR))
            .is_ok_and(|listed| same_file(&listed, &here))
    })
}

#[cfg(unix)]
fn same_file(one: &std::fs::Metadata, other: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    (one.dev(), one.ino()) == (other.dev(), other.ino())
}

#[cfg(not(unix))]
fn same_file(_: &std::fs::Metadata, _: &std::fs::Metadata) -> bool {
    false
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
pub(crate) const STORE_FILES: [&str; 4] = ["", "-journal", "-wal", "-shm"];

pub(crate) fn suffixed(path: &Path, suffix: &str) -> std::path::PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    name.into()
}

/// The most set-aside copies one store's name can have beside it. Reached
/// only where something other than a copy keeps taking the names.
const MOST_SET_ASIDE: u32 = 1000;

/// The name, `<store><label>-<n>` for the first `n` from 1 whose store file
/// and logs are all absent, so a copy set aside before is never overwritten
/// or mistaken for part of this one.
pub(crate) fn free_set_aside(path: &Path, label: &str) -> Result<std::path::PathBuf, CoreError> {
    for n in 1..=MOST_SET_ASIDE {
        let aside = suffixed(path, &format!("{label}-{n}"));
        let mut free = true;
        for suffix in STORE_FILES {
            let name = suffixed(&aside, suffix);
            match name.symlink_metadata() {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(CoreError::Store(format!(
                        "{} cannot be set aside: {} cannot be checked: {error}",
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
        "{} cannot be set aside: {MOST_SET_ASIDE} copies set aside beside it are left; remove them first",
        path.display()
    )))
}

/// Replaces the store at `path` with an empty one of this build's shape. The
/// caller holds the writer lock and has found nothing unsent. The old store
/// is set aside under a name of its own (`free_set_aside`), logs first, so a
/// log is never left beside a store that is not its own; it is put back if
/// the new store cannot be made, and removed only once it has been.
pub(crate) fn replace(path: &Path) -> Result<Connection, CoreError> {
    let aside = free_set_aside(path, ".refused")?;
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
pub(crate) fn without_log(conn: &Connection) -> Result<(), CoreError> {
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
    crate::damage::refuse_emptied_in(state, label)?;
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
    let seen = crate::damage::seen();
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
        crate::damage::keep_log_if_met(&old, seen);
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
    crate::damage::keep_log_if_met(&old, seen);
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
    let seen = crate::damage::seen();
    let conn = vfs.open(
        FOLDER_STORE,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    read_checked(&conn, label).map_err(|error| {
        crate::damage::keep_log_if_met(&conn, seen);
        in_folder(error, label, &conn)
    })?;
    Ok(conn)
}

/// SQLite's default page cache of 2 MiB holds a few thousand rows, so a
/// listing of a larger copy would read every page again from the file. The
/// cache grows only as pages are read. The statement cache holds the
/// statements a read of many bodies prepares for each body, and those a
/// hydration runs for each row it writes.
fn tune(conn: &Connection) -> Result<(), CoreError> {
    conn.execute_batch("PRAGMA cache_size = -32768;")?;
    conn.set_prepared_statement_cache_capacity(64);
    Ok(())
}

/// The pages the log may hold during a hydration. At the default, each
/// checkpoint writes the same pages again.
const HYDRATION_LOG_PAGES: i64 = 32_768;

/// Raises the checkpoint interval to `HYDRATION_LOG_PAGES` and answers the
/// one it replaces, for `restore_log_interval`.
pub(crate) fn lengthen_log_interval(conn: &Connection) -> Result<i64, CoreError> {
    let kept: i64 = conn.query_row("PRAGMA wal_autocheckpoint", [], |row| row.get(0))?;
    conn.execute_batch(&format!(
        "PRAGMA wal_autocheckpoint = {HYDRATION_LOG_PAGES}"
    ))?;
    Ok(kept)
}

/// Gives back the interval `kept` and empties the log into the store without
/// waiting on a reader that holds it. Emptying the log only saves its size, so
/// a failure there is a warning and never the caller's.
pub(crate) fn restore_log_interval(conn: &Connection, kept: i64) -> Result<(), CoreError> {
    conn.execute_batch(&format!("PRAGMA wal_autocheckpoint = {kept}"))?;
    #[allow(
        clippy::redundant_closure_call,
        reason = "the early return exists only with debug assertions"
    )]
    let emptied = (|| {
        #[cfg(debug_assertions)]
        if crate::fault::fails(|| "hydration-checkpoint") {
            return Err(CoreError::Store("hydration-checkpoint".into()));
        }
        crate::reclaim::without_waiting(conn, || crate::reclaim::checkpointed(conn))
    })();
    if let Err(error) = &emptied {
        crate::telemetry::unemptied!(error);
    }
    Ok(())
}

/// `write` in a transaction whose statement journals are held in memory.
///
/// Every write to an indexed table inside a transaction keeps a statement
/// journal. SQLite moves one past 64 KiB to a temporary file, where every
/// later statement in the transaction writes its pages again, which is nearly
/// a third of the time a hydration spends writing a page. The in-memory
/// journal releases pages when the statement or enclosing savepoint ends.
/// It holds the pages changed within that scope, which for one row is small,
/// and for a statement that clears a large copy could be most of it, so the
/// connection takes up the default again once the transaction ends. SQLite
/// reads the setting when the transaction starts to write, and cannot change
/// it inside one.
pub(crate) fn with_journals_in_memory<T>(
    conn: &mut Connection,
    write: impl FnOnce(&rusqlite::Transaction) -> Result<T, CoreError>,
) -> Result<T, CoreError> {
    conn.execute_batch("PRAGMA temp_store = MEMORY;")?;
    let written = (|| -> Result<T, CoreError> {
        let tx = conn.transaction()?;
        let written = write(&tx)?;
        tx.commit()?;
        Ok(written)
    })();
    let restored = conn.execute_batch("PRAGMA temp_store = DEFAULT;");
    let written = written?;
    restored?;
    Ok(written)
}

fn read_checked(conn: &Connection, path: &Path) -> Result<(), CoreError> {
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    let no_schema = || {
        CoreError::Invalid(format!(
            "{} is not a store: it has no schema to read",
            path.display()
        ))
    };
    let found =
        version(conn).map_err(|error| crate::damage::at_path(CoreError::from(error), path))?;
    if found != SCHEMA_VERSION {
        let has_meta: bool = conn
            .query_row(
                "SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta')",
                [],
                |row| row.get(0),
            )
            .map_err(|error| crate::damage::at_path(error.into(), path))?;
        if !has_meta {
            return Err(no_schema());
        }
        return Err(at_path(refused(conn, found), path));
    }
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
    match version(conn)? {
        SCHEMA_VERSION => {}
        0 if !holds_tables(conn)? => make(conn)?,
        found if upgraded(found) => upgrade(conn, OLDEST_UPGRADED, UPGRADES)?,
        found => return Err(refused(conn, found)),
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

/// Makes this build's schema in an empty store, in one transaction, so a
/// crash leaves the store empty or whole.
pub(super) fn make(conn: &Connection) -> Result<(), CoreError> {
    let tx = rusqlite::Transaction::new_unchecked(conn, rusqlite::TransactionBehavior::Immediate)?;
    // Another program may have made it between the read and the lock.
    match version(&tx)? {
        SCHEMA_VERSION => return Ok(()),
        0 if !holds_tables(&tx)? => {}
        found => return Err(refused(&tx, found)),
    }
    tx.execute_batch(SCHEMA)?;
    tx.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    tx.commit()?;
    Ok(())
}

/// Makes a store at `path`, an empty file, with `marks` in its meta, in one
/// transaction, so a crash leaves it holding no tables or holding the marks.
pub(crate) fn make_marked(path: &Path, marks: &[(&str, &str)]) -> Result<(), CoreError> {
    let conn = Connection::open(path)?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    conn.query_row("PRAGMA journal_mode = WAL", [], |_| Ok(()))?;
    let tx = rusqlite::Transaction::new_unchecked(&conn, rusqlite::TransactionBehavior::Immediate)?;
    if version(&tx)? != 0 || holds_tables(&tx)? {
        return Err(CoreError::Store(format!(
            "{} is not empty, so no store is made there",
            path.display()
        )));
    }
    tx.execute_batch(SCHEMA)?;
    tx.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    meta_set(
        &tx,
        META_STORE_ID,
        &uuid::Uuid::now_v7().simple().to_string(),
    )?;
    for (key, value) in marks {
        meta_set(&tx, key, value)?;
    }
    tx.commit()?;
    without_log(&conn)
}

/// A crash must leave the store at its original version or the target version.
pub(super) fn upgrade(conn: &Connection, oldest: i64, steps: &[&str]) -> Result<(), CoreError> {
    let tx = rusqlite::Transaction::new_unchecked(conn, rusqlite::TransactionBehavior::Immediate)?;
    let target = oldest + steps.len() as i64;
    // Another program may have upgraded it between the read and the lock.
    let found = version(&tx)?;
    if found == target {
        return Ok(());
    }
    let Some(from) = usize::try_from(found - oldest)
        .ok()
        .filter(|from| *from < steps.len())
    else {
        return Err(refused(&tx, found));
    };
    for step in &steps[from..] {
        tx.execute_batch(step)?;
    }
    tx.pragma_update(None, "user_version", target)?;
    tx.commit()?;
    Ok(())
}

pub(crate) fn version(conn: &Connection) -> rusqlite::Result<i64> {
    conn.query_row("PRAGMA user_version", [], |row| row.get(0))
}

pub(crate) fn holds_tables(conn: &Connection) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table')",
        [],
        |row| row.get(0),
    )
}

/// The refusal of a store at version `found`, with what it holds.
pub(crate) fn refused(conn: &Connection, found: i64) -> CoreError {
    CoreError::WrongSchema {
        path: String::new(),
        reason: format!(
            "it is at schema version {found}, and this build reads schema version {SCHEMA_VERSION}{}",
            unsendable(conn)
        ),
        unsent: untaken_count(conn),
        folder: None,
    }
}

pub(crate) fn store_id(conn: &Connection) -> Result<String, CoreError> {
    meta_get(conn, META_STORE_ID)?.ok_or_else(|| {
        CoreError::Store("the store has no id; open it once with this build's writer".into())
    })
}

/// Each table's statement as SQLite recorded it, keyed by table.
type Shape = HashMap<String, String>;

/// Without comments or whitespace outside its quoted strings and names, so
/// a comment or a line break in `schema.sql` is no change of shape, and a
/// change inside a string is. SQLite records a statement as it was written,
/// comments inside it included.
pub(super) fn statement(sql: &str) -> String {
    let mut kept = String::with_capacity(sql.len());
    let mut rest = sql.chars().peekable();
    while let Some(character) = rest.next() {
        let closing = match character {
            '\'' | '"' | '`' => Some(character),
            '[' => Some(']'),
            _ => None,
        };
        if let Some(closing) = closing {
            kept.push(character);
            for inside in rest.by_ref() {
                kept.push(inside);
                if inside == closing {
                    break;
                }
            }
        } else if character == '-' && rest.peek() == Some(&'-') {
            rest.by_ref().find(|&skipped| skipped == '\n');
        } else if character == '/' && rest.peek() == Some(&'*') {
            rest.next();
            let mut last = ' ';
            rest.by_ref()
                .find(|&skipped| std::mem::replace(&mut last, skipped) == '*' && skipped == '/');
        } else if !character.is_whitespace() {
            kept.push(character);
        }
    }
    kept
}

pub(super) fn held_shape(conn: &Connection) -> rusqlite::Result<Shape> {
    held_statements(conn, "table")
}

/// Each statement of `kind`, `table` or `trigger`, that SQLite records, keyed
/// by name in lowercase, since SQLite folds the case of ASCII letters in a
/// name.
fn held_statements(conn: &Connection, kind: &str) -> rusqlite::Result<Shape> {
    let mut query =
        conn.prepare("SELECT name, sql FROM sqlite_master WHERE type = ?1 AND sql IS NOT NULL")?;
    let rows = query.query_map([kind], |row| {
        Ok((
            row.get::<_, String>(0)?.to_ascii_lowercase(),
            statement(&row.get::<_, String>(1)?),
        ))
    })?;
    rows.collect()
}

/// The tables this build makes, read from SQLite rather than from the file
/// so they are compared as SQLite records them.
#[cfg(unix)]
fn built_shape() -> Result<&'static Shape, CoreError> {
    static BUILT: std::sync::OnceLock<Shape> = std::sync::OnceLock::new();
    if let Some(built) = BUILT.get() {
        return Ok(built);
    }
    let conn = Connection::open_in_memory()?;
    conn.execute_batch(SCHEMA)?;
    let built = held_shape(&conn)?;
    Ok(BUILT.get_or_init(|| built))
}
