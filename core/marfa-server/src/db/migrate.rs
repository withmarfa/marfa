//! Numbered, forward-only migrations built into the program. `user_version`
//! records how far a file has come, inside the transaction that took it there.

use std::path::{Path, PathBuf};

use rusqlite::{Connection, TransactionBehavior};

use super::schema::{self, Differences};
use super::volume;
use crate::failure::Failure;
use crate::settings::start::MigrationFault;

#[derive(Debug)]
pub struct Migration {
    pub version: u32,
    pub sql: &'static str,
}

pub const MIGRATIONS: &[Migration] = &[Migration {
    version: 1,
    sql: include_str!("migrations/0001_baseline.sql"),
}];

const RETIRED_TABLES: [&str; 2] = ["custom_types", "custom_edge_types"];
const RETIRED_SETTING: &str = "space_config";
const WAY_FORWARD: &str = "Export with the build that wrote the file, start on a fresh file and \
                           restore the archive there. The restore can refuse an archive the \
                           writing build did not write.";

#[derive(Debug, PartialEq, Eq)]
pub enum Standing {
    Current,
    /// New, or left partway through making its tables and holding no rows.
    Unfinished,
    Behind(u32),
}

pub struct Update<'a> {
    pub migrations: &'a [Migration],
    pub file: Option<&'a Path>,
    pub label: &'a str,
    pub fault: Option<MigrationFault>,
    pub free_disk_bytes: Option<u64>,
}

fn latest(migrations: &[Migration]) -> u32 {
    migrations.last().map_or(0, |migration| migration.version)
}

fn failed(label: &str, error: rusqlite::Error) -> Failure {
    match error.sqlite_error_code() {
        Some(rusqlite::ErrorCode::NotADatabase) => {
            Failure::start(format!("{label} is not a database"))
        }
        _ => Failure::start(format!("{label} could not be read: {error}")),
    }
}

fn not_this_builds(label: &str, found: &str) -> Failure {
    Failure::database(format!(
        "{label} is not this build's: {found}. {WAY_FORWARD}"
    ))
}

/// Reads a file without changing it.
pub fn judge(
    conn: &Connection,
    migrations: &[Migration],
    label: &str,
) -> Result<Standing, Failure> {
    let read = |error| failed(label, error);
    for table in RETIRED_TABLES {
        if schema::table_exists(conn, table).map_err(read)? {
            return Err(Failure::database(format!(
                "The type registry in {label} is still held in {table}. {WAY_FORWARD}"
            )));
        }
    }
    if schema::table_exists(conn, "settings").map_err(read)? {
        let retired: bool = conn
            .query_row(
                "SELECT EXISTS (SELECT 1 FROM settings WHERE key = ?1)",
                [RETIRED_SETTING],
                |row| row.get(0),
            )
            .map_err(read)?;
        if retired {
            return Err(Failure::database(format!(
                "The settings in {label} are still keyed {RETIRED_SETTING}. {WAY_FORWARD}"
            )));
        }
    }
    let version: u32 = conn
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(read)?;
    let newest = latest(migrations);
    if version > newest {
        return Err(Failure::database(format!(
            "{label} is at schema version {version}, which a newer build wrote; this build \
             reads schema version {newest}."
        )));
    }
    if version > 0 && version < newest {
        return Ok(Standing::Behind(version));
    }
    let declared = schema::declared(migrations).map_err(read)?;
    let differences = schema::compare(conn, &declared).map_err(read)?;
    judge_differences(conn, differences, version == newest, label)
}

fn judge_differences(
    conn: &Connection,
    differences: Differences,
    stamped: bool,
    label: &str,
) -> Result<Standing, Failure> {
    let Differences {
        missing_tables,
        found,
        present_tables,
    } = differences;
    if !found.is_empty() {
        return Err(not_this_builds(label, &found.join("; ")));
    }
    if missing_tables.is_empty() {
        return Ok(if stamped {
            Standing::Current
        } else {
            Standing::Unfinished
        });
    }
    let failed = |error| failed(label, error);
    for table in &present_tables {
        if schema::is_shadow(conn, table).map_err(failed)? {
            continue;
        }
        if schema::holds_rows(conn, table).map_err(failed)? {
            let lacks = missing_tables
                .iter()
                .map(|missing| format!("the file lacks the {missing} table"))
                .collect::<Vec<_>>()
                .join("; ");
            return Err(not_this_builds(label, &lacks));
        }
    }
    Ok(Standing::Unfinished)
}

/// Applies every migration to a new or unfinished file, which holds no rows.
pub fn complete(conn: &mut Connection, migrations: &[Migration]) -> rusqlite::Result<()> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    for migration in migrations {
        tx.execute_batch(migration.sql)?;
    }
    tx.pragma_update(None, "user_version", latest(migrations))?;
    tx.commit()
}

fn wal_of(file: &Path) -> PathBuf {
    let mut name = file.as_os_str().to_owned();
    name.push("-wal");
    PathBuf::from(name)
}

fn copy_path(file: &Path, from: u32, to: u32) -> PathBuf {
    let stem = format!("{}.schema-{from}-to-{to}", file.display());
    let first = PathBuf::from(format!("{stem}.bak"));
    if !first.exists() {
        return first;
    }
    (1u32..)
        .map(|attempt| PathBuf::from(format!("{stem}.{attempt}.bak")))
        .find(|path| !path.exists())
        .unwrap_or(first)
}

fn check_room(file: &Path, free_disk_bytes: Option<u64>, label: &str) -> Result<(), Failure> {
    let size = |path: &Path| std::fs::metadata(path).map_or(0, |meta| meta.len());
    let needed = (size(file) + size(&wal_of(file))) * 2;
    let folder = file.parent().filter(|p| !p.as_os_str().is_empty());
    let free = free_disk_bytes.or_else(|| volume::free_bytes(folder.unwrap_or(Path::new("."))));
    match free {
        Some(free) if free < needed => Err(Failure::database(format!(
            "{label} needs {needed} bytes free to update and its volume has {free}."
        ))),
        _ => Ok(()),
    }
}

fn table_rows(conn: &Connection) -> rusqlite::Result<Vec<(String, String, i64)>> {
    let tables: Vec<(String, String)> = conn
        .prepare(
            "SELECT name, sql FROM sqlite_schema \
             WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'",
        )?
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    tables
        .into_iter()
        .map(|(name, sql)| {
            let quoted = name.replace('"', "\"\"");
            let count =
                conn.query_row(&format!("SELECT count(*) FROM \"{quoted}\""), [], |row| {
                    row.get(0)
                })?;
            Ok((name, sql, count))
        })
        .collect()
}

fn apply_fault(
    conn: &Connection,
    fault: Option<MigrationFault>,
    rows: &[(String, String, i64)],
) -> rusqlite::Result<()> {
    match fault {
        None => {}
        Some(MigrationFault::Hold) => loop {
            std::thread::park();
        },
        Some(MigrationFault::LoseRow) => {
            if let Some((table, _, _)) = rows.iter().find(|(_, _, count)| *count > 0) {
                let quoted = table.replace('"', "\"\"");
                conn.execute(
                    &format!("DELETE FROM \"{quoted}\" WHERE rowid IN (SELECT rowid FROM \"{quoted}\" LIMIT 1)"),
                    [],
                )?;
            }
        }
        Some(MigrationFault::ChangeShape) => {
            conn.execute_batch("ALTER TABLE settings ADD COLUMN undeclared TEXT")?;
        }
    }
    Ok(())
}

/// Updates in one transaction, after a complete copy is on disk. A refusal
/// leaves the file as it was.
pub fn update(conn: &mut Connection, from: u32, update: &Update<'_>) -> Result<(), Failure> {
    let to = latest(update.migrations);
    let label = update.label;
    let refused = |copy: &Path, what: String| {
        Failure::database(format!(
            "The update of {label} from schema version {from} to {to} failed: {what}. Nothing \
             changed; a copy is at {}.",
            copy.display()
        ))
    };
    let file = update
        .file
        .ok_or_else(|| Failure::start(format!("{label} has no file to take a copy of")))?;
    check_room(file, update.free_disk_bytes, label)?;
    let copy = copy_path(file, from, to);
    conn.execute("VACUUM INTO ?1", [copy.to_string_lossy()])
        .map_err(|error| Failure::start(format!("{label} could not be copied: {error}")))?;

    let run = |conn: &mut Connection| -> Result<(), String> {
        let text = |error: rusqlite::Error| error.to_string();
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(text)?;
        let before = table_rows(&tx).map_err(text)?;
        for migration in update.migrations.iter().filter(|m| m.version > from) {
            tx.execute_batch(migration.sql).map_err(text)?;
        }
        tx.pragma_update(None, "user_version", to).map_err(text)?;
        apply_fault(&tx, update.fault, &before).map_err(text)?;

        let declared = schema::declared(update.migrations).map_err(text)?;
        let differences = schema::compare(&tx, &declared).map_err(text)?;
        if let Some(found) = differences
            .found
            .first()
            .or(differences.missing_tables.first())
        {
            return Err(format!(
                "it would leave a schema other than this build's: {found}"
            ));
        }
        let after = table_rows(&tx).map_err(text)?;
        for (table, sql, count) in &before {
            let lost = after
                .iter()
                .any(|(name, now, rows)| name == table && now == sql && rows < count);
            if lost {
                return Err(format!("it would leave fewer rows in {table}"));
            }
        }
        tx.commit().map_err(text)
    };
    run(conn).map_err(|what| refused(&copy, what))?;
    tracing::info!(
        schema_from = from,
        schema_to = to,
        backup_path = %copy.display(),
        "Updated {label}, keeping a copy at {}",
        copy.display()
    );
    Ok(())
}
