//! Migrations apply in one transaction; a file a newer build wrote is refused.

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
    /// Written whole by an earlier build, at this version.
    Behind(u32),
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
        let count = migrations
            .iter()
            .take_while(|migration| migration.version <= version)
            .count();
        let earlier = migrations.get(..count).unwrap_or_default();
        if earlier.last().map(|migration| migration.version) != Some(version) {
            return Err(not_this_builds(
                label,
                &format!("this build has no schema version {version}"),
            ));
        }
        let declared = schema::declared(earlier).map_err(read)?;
        let differences = schema::compare(conn, &declared).map_err(read)?;
        if !differences.found.is_empty() || !differences.missing_tables.is_empty() {
            let mut found = differences.found;
            found.extend(
                differences
                    .missing_tables
                    .iter()
                    .map(|missing| format!("the file lacks the {missing} table")),
            );
            return Err(not_this_builds(label, &found.join("; ")));
        }
        return Ok(Standing::Behind(version));
    }
    let declared = schema::declared(migrations).map_err(read)?;
    let differences = schema::compare(conn, &declared).map_err(read)?;
    judge_differences(conn, differences, version == newest, label)
}

/// Whether any table but a virtual table's own holds a row.
pub fn holds_rows(conn: &Connection) -> rusqlite::Result<bool> {
    let tables: Vec<String> = conn
        .prepare(
            "SELECT name FROM sqlite_schema WHERE type = 'table' \
             AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'",
        )?
        .query_map([], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    for table in tables {
        if !schema::is_shadow(conn, &table)? && schema::holds_rows(conn, &table)? {
            return Ok(true);
        }
    }
    Ok(false)
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

/// Applies the migrations after `from` to a file an earlier build wrote whole.
pub fn upgrade(conn: &mut Connection, migrations: &[Migration], from: u32) -> rusqlite::Result<()> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    for migration in migrations
        .iter()
        .filter(|migration| migration.version > from)
    {
        tx.execute_batch(migration.sql)?;
    }
    tx.pragma_update(None, "user_version", latest(migrations))?;
    tx.commit()
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
