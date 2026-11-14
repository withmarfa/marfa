use std::fs::File;
use std::io::Read;
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{Connection, ErrorCode, OpenFlags, OptionalExtension};

use super::migrate::{self, Migration, Standing};
use super::volume;
use crate::app::faults::{Faults, Volume};
use crate::failure::Failure;
use crate::server_lock::{self, Untaken};
use crate::settings::DatabasePath;
use crate::settings::registry::{DISK_RESERVE_BYTES, Seeds, Snapshot};

const HEADER: &[u8; 16] = b"SQLite format 3\0";
/// What the log is cut back to once a checkpoint has moved it into the file.
const JOURNAL_SIZE_LIMIT: i64 = 64 * 1024 * 1024;
/// Each checkpoint syncs the log and the file in full, so they come about every 32 MiB of log.
const AUTOCHECKPOINT_PAGES: i64 = 8192;

#[derive(Debug)]
pub struct Options {
    pub path: DatabasePath,
    pub write_wait: Duration,
    pub readers: usize,
    pub migrations: &'static [Migration],
    /// The free space a copy before an upgrade must leave, unless the file stores its own.
    pub reserve: u64,
}

/// The suffix of the copy kept beside the database from before its last upgrade.
pub const BEFORE_UPGRADE: &str = ".before-upgrade";

/// The suffix of the file a server holds locked beside its database while it has it open.
pub const SERVER_LOCK: &str = ".server-lock";

pub struct Opened {
    pub writer: Connection,
    pub readers: Vec<Connection>,
    /// None for a database with no file of its own.
    pub lock: Option<File>,
}

enum Target {
    File(PathBuf),
    Uri(String),
    Memory(String),
}

impl Target {
    fn of(path: &DatabasePath) -> Target {
        match path {
            DatabasePath::File(path) => Target::File(path.clone()),
            DatabasePath::Uri(uri) => Target::Uri(uri.clone()),
            DatabasePath::Memory => {
                Target::Memory(format!("file:/marfa-{}?vfs=memdb", uuid::Uuid::now_v7()))
            }
        }
    }

    fn label(&self) -> String {
        match self {
            Target::File(path) => path.display().to_string(),
            Target::Uri(uri) => uri.clone(),
            Target::Memory(_) => "the in-memory database".to_string(),
        }
    }

    fn open(&self, flags: OpenFlags) -> rusqlite::Result<Connection> {
        let flags = flags | OpenFlags::SQLITE_OPEN_NO_MUTEX | OpenFlags::SQLITE_OPEN_URI;
        match self {
            Target::File(path) => Connection::open_with_flags(path, flags),
            Target::Uri(uri) | Target::Memory(uri) => Connection::open_with_flags(uri, flags),
        }
    }
}

fn file_uri(path: &Path, query: &str) -> String {
    let mut uri = String::from("file:");
    for &byte in path.as_os_str().as_bytes() {
        match byte {
            b'%' | b'?' | b'#' | 0x80.. => uri.push_str(&format!("%{byte:02X}")),
            _ => uri.push(byte as char),
        }
    }
    uri.push('?');
    uri.push_str(query);
    uri
}

fn has_log(path: &Path) -> bool {
    let mut name = path.as_os_str().to_owned();
    name.push("-wal");
    std::fs::metadata(PathBuf::from(name)).is_ok_and(|meta| meta.len() > 0)
}

fn is_busy(error: &rusqlite::Error) -> bool {
    matches!(
        error.sqlite_error_code(),
        Some(ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked)
    )
}

fn refused_open(label: &str, error: rusqlite::Error) -> Failure {
    if is_busy(&error) {
        return Failure::start(format!("{label} is locked by another process"));
    }
    match error.sqlite_error_code() {
        Some(ErrorCode::NotADatabase) => Failure::start(format!("{label} is not a database")),
        _ => Failure::start(format!("{label} could not be opened: {error}")),
    }
}

/// Taken before anything is read or written, so a second server changes nothing.
fn lock_database(path: &Path, label: &str) -> Result<File, Failure> {
    let lock = sibling(path, SERVER_LOCK);
    server_lock::take(&lock).map_err(|untaken| match untaken {
        Untaken::Held => Failure::start(format!(
            "{label} is open in another Marfa server. Stop that server, or give this one a \
             database of its own."
        )),
        Untaken::Failed(error) => Failure::start(format!(
            "{label} was not opened, because its lock file {} could not be taken: {error}",
            lock.display()
        )),
    })
}

/// Leaves the file's bytes and folder as they were: with no log to apply, SQLite is told
/// not to look for one, since a reader of a WAL file would make side files.
fn judge_file(
    path: &Path,
    options: &Options,
    faults: &Faults,
    label: &str,
) -> Result<Standing, Failure> {
    let unreadable =
        |error: std::io::Error| Failure::start(format!("{label} could not be read: {error}"));
    let mut header = [0u8; 16];
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Standing::Unfinished);
        }
        Err(error) => return Err(unreadable(error)),
    };
    let read = file.read(&mut header).map_err(unreadable)?;
    if read == 0 {
        return Ok(Standing::Unfinished);
    }
    if read < header.len() || &header != HEADER {
        return Err(Failure::start(format!("{label} is not a database")));
    }
    let read_only = OpenFlags::SQLITE_OPEN_READ_ONLY
        | OpenFlags::SQLITE_OPEN_URI
        | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let inspected = if has_log(path) {
        Connection::open_with_flags(file_uri(path, "mode=ro"), read_only)
    } else {
        Connection::open_with_flags(file_uri(path, "immutable=1"), read_only)
    }
    .map_err(|error| refused_open(label, error))?;
    inspected
        .busy_timeout(options.write_wait)
        .map_err(|error| refused_open(label, error))?;
    let standing = migrate::judge(&inspected, options.migrations, label)?;
    if let Standing::Behind(from) = standing {
        let holds = migrate::holds_rows(&inspected).map_err(|error| refused_open(label, error))?;
        if holds {
            copy_before_upgrade(&inspected, path, options, faults, label, from)?;
        }
    }
    Ok(standing)
}

fn sibling(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

/// The reserve the file stores, read by the settings' own rule, or the one the server was
/// started with where it stores none. A stored reserve that does not read refuses the start.
fn reserve_of(conn: &Connection, options: &Options, label: &str) -> Result<u64, Failure> {
    let key = DISK_RESERVE_BYTES.entry.key;
    let unread = |error: rusqlite::Error| {
        Failure::start(format!(
            "{label} was not upgraded, because its stored settings could not be read: {error}. \
             Nothing was changed."
        ))
    };
    let has_settings: bool = conn
        .query_row(
            "SELECT EXISTS (SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'settings')",
            [],
            |row| row.get(0),
        )
        .map_err(unread)?;
    if !has_settings {
        return Ok(options.reserve);
    }
    let stored: Option<String> = conn
        .query_row("SELECT value FROM settings WHERE key = ?1", [key], |row| {
            row.get(0)
        })
        .optional()
        .map_err(unread)?;
    let rows: Vec<(String, String)> = stored
        .into_iter()
        .map(|text| (key.to_string(), text))
        .collect();
    let resolved = Snapshot::resolve(&Seeds::new(), &rows, 0);
    if resolved.unreadable().contains(&key) {
        return Err(Failure::start(format!(
            "{label} was not upgraded, because its stored setting {key} does not read as {}. \
             Correct that row, then start again. Nothing was changed.",
            DISK_RESERVE_BYTES.entry.words().to_lowercase()
        )));
    }
    Ok(match resolved.stored(DISK_RESERVE_BYTES.entry) {
        Some(_) => resolved.get(DISK_RESERVE_BYTES),
        None => options.reserve,
    })
}

/// Writes the file as it stands to `<file>.before-upgrade`, in place of the last such copy,
/// or refuses the start with nothing changed beside it.
fn copy_before_upgrade(
    conn: &Connection,
    path: &Path,
    options: &Options,
    faults: &Faults,
    label: &str,
    from: u32,
) -> Result<(), Failure> {
    let copy = sibling(path, BEFORE_UPGRADE);
    let partial = sibling(path, &format!("{BEFORE_UPGRADE}.partial"));
    let refused = |why: String| {
        Failure::start(format!(
            "{label} was not upgraded from schema version {from}, because the copy kept \
             before an upgrade could not be written to {}: {why}. Nothing was changed.",
            copy.display()
        ))
    };
    let pages = |pragma: &str| {
        conn.pragma_query_value(None, pragma, |row| row.get::<_, i64>(0))
            .map(|count| u64::try_from(count).unwrap_or(0))
            .map_err(|error| refused(error.to_string()))
    };
    let needed =
        pages("page_count")?.saturating_sub(pages("freelist_count")?) * pages("page_size")?;
    let reserve = reserve_of(conn, options, label)?;
    let folder = path.parent().unwrap_or(Path::new("."));
    let free = match faults.free(Volume::Database) {
        Some(set) => set,
        None => volume::free_bytes(folder),
    };
    if let Some(free) = free
        && free < needed.saturating_add(reserve)
    {
        return Err(refused(format!(
            "it needs {needed} bytes and must leave the disk reserve of {reserve} bytes, \
             and {free} bytes are free"
        )));
    }
    let written = (|| -> std::io::Result<()> {
        match std::fs::remove_file(&partial) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error),
            _ => {}
        }
        conn.execute("VACUUM INTO ?1", [partial.to_string_lossy().as_ref()])
            .map_err(std::io::Error::other)?;
        File::open(&partial)?.sync_all()?;
        std::fs::rename(&partial, &copy)?;
        File::open(folder)?.sync_all()
    })();
    if let Err(error) = written {
        let _ = std::fs::remove_file(&partial);
        return Err(refused(error.to_string()));
    }
    tracing::info!(copy = %copy.display(), from, "The database was copied before its upgrade");
    Ok(())
}

/// On macOS only the full flush gets past the drive's cache.
fn make_durable(conn: &Connection) -> rusqlite::Result<()> {
    conn.pragma_update(None, "synchronous", "FULL")?;
    conn.pragma_update(None, "fullfsync", true)?;
    conn.pragma_update(None, "checkpoint_fullfsync", true)
}

/// Readers run beside the writer only through the log, and SQLite answers with the mode it
/// kept rather than failing where the file system gives it no shared memory.
fn keep_log(conn: &Connection, label: &str, in_file: bool) -> Result<(), Failure> {
    let mode: String = conn
        .pragma_update_and_check(None, "journal_mode", "WAL", |row| row.get(0))
        .map_err(|error| {
            if is_busy(&error) {
                refused_open(label, error)
            } else {
                Failure::start(format!(
                    "{label} could not be opened with a write-ahead log: {error}"
                ))
            }
        })?;
    if in_file && !mode.eq_ignore_ascii_case("wal") {
        return Err(Failure::start(format!(
            "{label} cannot keep a write-ahead log, which the server needs: SQLite left it in \
             {mode} mode. Keep the database on a local file system."
        )));
    }
    Ok(())
}

fn prepare_writer(conn: &Connection) -> rusqlite::Result<()> {
    make_durable(conn)?;
    conn.pragma_update(None, "foreign_keys", true)?;
    conn.pragma_update(None, "journal_size_limit", JOURNAL_SIZE_LIMIT)?;
    conn.pragma_update(None, "wal_autocheckpoint", AUTOCHECKPOINT_PAGES)?;
    super::rank::register(conn)
}

fn prepare_reader(conn: &Connection, options: &Options) -> rusqlite::Result<()> {
    conn.busy_timeout(options.write_wait)?;
    make_durable(conn)?;
    conn.pragma_update(None, "foreign_keys", true)?;
    conn.pragma_update(None, "query_only", true)?;
    super::rank::register(conn)
}

/// So a new or upgraded file holds its schema without its log.
fn move_schema_into_file(conn: &Connection) {
    if let Err(error) = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)") {
        tracing::warn!(error = %error, "The database log was not moved into its file");
    }
}

/// Nothing is written until the judgment has passed.
pub fn open(options: &Options, faults: &Faults) -> Result<Opened, Failure> {
    let target = Target::of(&options.path);
    let label = target.label();
    if let Target::File(path) = &target
        && let Some(folder) = path.parent().filter(|p| !p.as_os_str().is_empty())
    {
        std::fs::create_dir_all(folder).map_err(|error| {
            Failure::start(format!(
                "{} could not be created: {error}",
                folder.display()
            ))
        })?;
    }
    let file = options.path.file();
    let lock = file
        .as_deref()
        .map(|path| lock_database(path, &label))
        .transpose()?;
    let standing = match &target {
        Target::File(path) => judge_file(path, options, faults, &label)?,
        Target::Uri(_) => {
            let read_only = OpenFlags::SQLITE_OPEN_READ_ONLY;
            match target.open(read_only) {
                Ok(conn) => migrate::judge(&conn, options.migrations, &label)?,
                Err(_) => Standing::Unfinished,
            }
        }
        Target::Memory(_) => Standing::Unfinished,
    };
    if matches!(standing, Standing::Behind(_)) && !matches!(target, Target::File(_)) {
        return Err(Failure::start(format!(
            "{label} is at an earlier schema version, and only a database named by its path is \
             upgraded, since a copy is kept beside it first"
        )));
    }

    let write_flags = OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE;
    let refused = |error| refused_open(&label, error);
    let unapplied = |from: Option<u32>, error: migrate::Unapplied| match error {
        migrate::Unapplied::Failed(error) if is_busy(&error) => refused_open(&label, error),
        error => error.failure(&label, from, options.migrations),
    };
    let mut writer = target.open(write_flags).map_err(refused)?;
    writer.busy_timeout(options.write_wait).map_err(refused)?;
    keep_log(&writer, &label, file.is_some())?;
    prepare_writer(&writer).map_err(refused)?;
    match standing {
        Standing::Current => {}
        Standing::Unfinished => {
            migrate::complete(&mut writer, options.migrations)
                .map_err(|error| unapplied(None, error))?;
            move_schema_into_file(&writer);
        }
        Standing::Behind(from) => {
            migrate::upgrade(&mut writer, options.migrations, from)
                .map_err(|error| unapplied(Some(from), error))?;
            move_schema_into_file(&writer);
        }
    }

    let readers = (0..options.readers)
        .map(|_| {
            let conn = target.open(OpenFlags::SQLITE_OPEN_READ_WRITE)?;
            prepare_reader(&conn, options)?;
            Ok(conn)
        })
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(refused)?;
    Ok(Opened {
        writer,
        readers,
        lock,
    })
}
