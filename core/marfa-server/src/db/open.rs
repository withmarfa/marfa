use std::fs::File;
use std::io::Read;
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{Connection, ErrorCode, OpenFlags};

use super::migrate::{self, Migration, Standing, Update};
use crate::failure::Failure;
use crate::settings::DatabasePath;
use crate::settings::start::MigrationFault;

const HEADER: &[u8; 16] = b"SQLite format 3\0";

#[derive(Debug)]
pub struct Options {
    pub path: DatabasePath,
    pub busy_budget: Duration,
    pub readers: usize,
    pub migrations: &'static [Migration],
    pub migration_fault: Option<MigrationFault>,
    pub free_disk_bytes: Option<u64>,
}

pub struct Opened {
    pub writer: Connection,
    pub readers: Vec<Connection>,
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

fn refused_open(label: &str, error: rusqlite::Error) -> Failure {
    match error.sqlite_error_code() {
        Some(ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked) => {
            Failure::start(format!("{label} is locked by another process"))
        }
        Some(ErrorCode::NotADatabase) => Failure::start(format!("{label} is not a database")),
        _ => Failure::start(format!("{label} could not be opened: {error}")),
    }
}

/// Leaves the file's bytes and folder as they were: with no log to apply, SQLite is told
/// not to look for one, since a reader of a WAL file would make side files.
fn judge_file(path: &Path, options: &Options, label: &str) -> Result<Standing, Failure> {
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
        .busy_timeout(options.busy_budget)
        .map_err(|error| refused_open(label, error))?;
    migrate::judge(&inspected, options.migrations, label)
}

fn prepare_writer(conn: &Connection, options: &Options) -> rusqlite::Result<()> {
    conn.busy_timeout(options.busy_budget)?;
    conn.pragma_update_and_check(None, "journal_mode", "WAL", |_| Ok(()))?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "foreign_keys", true)?;
    Ok(())
}

fn prepare_reader(conn: &Connection, options: &Options) -> rusqlite::Result<()> {
    conn.busy_timeout(options.busy_budget)?;
    conn.pragma_update(None, "foreign_keys", true)?;
    conn.pragma_update(None, "query_only", true)?;
    Ok(())
}

/// Nothing is written until the judgment has passed.
pub fn open(options: &Options) -> Result<Opened, Failure> {
    let target = Target::of(&options.path);
    let label = target.label();
    let standing = match &target {
        Target::File(path) => {
            if let Some(folder) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
                std::fs::create_dir_all(folder).map_err(|error| {
                    Failure::start(format!(
                        "{} could not be created: {error}",
                        folder.display()
                    ))
                })?;
            }
            judge_file(path, options, &label)?
        }
        Target::Uri(_) => {
            let read_only = OpenFlags::SQLITE_OPEN_READ_ONLY;
            match target.open(read_only) {
                Ok(conn) => migrate::judge(&conn, options.migrations, &label)?,
                Err(_) => Standing::Unfinished,
            }
        }
        Target::Memory(_) => Standing::Unfinished,
    };

    let write_flags = OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE;
    let refused = |error| refused_open(&label, error);
    let mut writer = target.open(write_flags).map_err(refused)?;
    prepare_writer(&writer, options).map_err(refused)?;
    match standing {
        Standing::Current => {}
        Standing::Unfinished => {
            migrate::complete(&mut writer, options.migrations).map_err(refused)?;
        }
        Standing::Behind(from) => {
            let file = match &target {
                Target::File(path) => Some(path.as_path()),
                _ => None,
            };
            migrate::update(
                &mut writer,
                from,
                &Update {
                    migrations: options.migrations,
                    file,
                    label: &label,
                    fault: options.migration_fault,
                    free_disk_bytes: options.free_disk_bytes,
                },
            )?;
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
    Ok(Opened { writer, readers })
}
