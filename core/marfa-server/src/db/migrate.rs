//! The migrations built into the program, applied to a new file in one transaction.
//! `user_version` records which build's schema the file holds. A file at any other
//! version is refused, since nothing older is carried forward.

use rusqlite::{Connection, TransactionBehavior};

use super::schema::{self, Differences};
use crate::failure::Failure;

#[derive(Debug)]
pub struct Migration {
    pub version: u32,
    pub sql: &'static str,
}

pub const MIGRATIONS: &[Migration] = &[Migration {
    version: 1,
    sql: include_str!("migrations/0001_baseline.sql"),
}];

const WAY_FORWARD: &str = "Export with the build that wrote the file, start on a fresh file and \
                           restore the archive there. The restore can refuse an archive the \
                           writing build did not write.";

#[derive(Debug, PartialEq, Eq)]
pub enum Standing {
    Current,
    /// New, or left partway through making its tables and holding no rows.
    Unfinished,
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
        return Err(not_this_builds(
            label,
            &format!("it is at schema version {version} and this build's is {newest}"),
        ));
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
