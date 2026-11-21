//! Migrations apply in one transaction; a file a newer build wrote is refused.

use rusqlite::{Connection, TransactionBehavior};

use super::schema::{self, Differences};
use crate::failure::Failure;

#[derive(Debug)]
pub struct Migration {
    pub version: u32,
    pub sql: &'static str,
    /// A query that returns true when an unfinished file already has this migration's changes.
    pub done: Option<&'static str>,
}

pub const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        sql: include_str!("migrations/0001_baseline.sql"),
        done: None,
    },
    Migration {
        version: 2,
        sql: include_str!("migrations/0002_consent_login_after.sql"),
        done: Some(
            "SELECT EXISTS (SELECT 1 FROM pragma_table_info('oauth_consents') \
             WHERE name = 'login_after')",
        ),
    },
    // Removing a key twice changes nothing, so no `done` check.
    Migration {
        version: 3,
        sql: include_str!("migrations/0003_remove_compatible_with.sql"),
        done: None,
    },
    Migration {
        version: 4,
        sql: include_str!("migrations/0004_plugins.sql"),
        done: Some("SELECT EXISTS (SELECT 1 FROM sqlite_schema WHERE name = 'plugins')"),
    },
];

const WAY_FORWARD: &str = "Export with the build that wrote the file, start on a fresh file and \
                           restore the archive there. A restore reads archive versions from 1 \
                           through its own. It refuses an archive at a later version, and one \
                           whose manifest.json names no format or another format, as every \
                           release before 0.0.72 wrote, and says which build or format it \
                           found. Within a version, a restore skips a field or a kind of line \
                           it does not know, and names each kind it skips.";

#[derive(Debug, PartialEq, Eq)]
pub enum Standing {
    Current,
    /// New, or left partway through making its tables and holding no rows.
    Unfinished,
    /// Written whole by an earlier build, at this version.
    Behind(u32),
}

#[cfg(test)]
pub fn make_all(conn: &Connection) -> rusqlite::Result<()> {
    MIGRATIONS
        .iter()
        .try_for_each(|migration| conn.execute_batch(migration.sql))
}

pub(super) fn latest(migrations: &[Migration]) -> u32 {
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

/// Why migrations did not leave the connection ready.
#[derive(Debug)]
pub enum Unapplied {
    /// Nothing was committed.
    Failed(rusqlite::Error),
    /// Nothing was committed: each child table, its parent and its rows with no parent row.
    Dangling(Vec<(String, String, i64)>),
    /// SQLite did not take the foreign key setting asked for.
    KeysUnchanged { on: bool },
    /// The migrations committed, and foreign keys did not come back on.
    Committed(Box<Unapplied>),
    /// `COMMIT` failed, which does not prove the log did not take the transaction.
    CommitFailed(rusqlite::Error),
}

impl From<rusqlite::Error> for Unapplied {
    fn from(error: rusqlite::Error) -> Unapplied {
        Unapplied::Failed(error)
    }
}

impl Unapplied {
    fn why(&self) -> String {
        match self {
            Unapplied::Failed(error) => error.to_string(),
            Unapplied::Dangling(tables) => format!(
                "it would leave rows that refer to rows that are not there ({})",
                tables
                    .iter()
                    .map(|(table, parent, rows)| format!("{rows} in {table}, to {parent}"))
                    .collect::<Vec<_>>()
                    .join("; ")
            ),
            Unapplied::KeysUnchanged { on } => format!(
                "SQLite did not turn its foreign key checks {}",
                if *on { "on" } else { "off" }
            ),
            Unapplied::Committed(cause) => cause.why(),
            Unapplied::CommitFailed(error) => error.to_string(),
        }
    }

    pub fn failure(&self, label: &str, from: Option<u32>, migrations: &[Migration]) -> Failure {
        let to = latest(migrations);
        let why = self.why();
        let message = match (self, from) {
            (Unapplied::Committed(_), Some(from)) => format!(
                "{label} was upgraded from schema version {from} to {to}, but then {why}. \
                 Start the server again."
            ),
            (Unapplied::Committed(_), None) => format!(
                "{label} was made at schema version {to}, but then {why}. Start the server again."
            ),
            (Unapplied::CommitFailed(_), Some(from)) => format!(
                "{label} may have been upgraded from schema version {from} to {to}: the upgrade \
                 did not commit cleanly ({why}), and SQLite may still have written it. Start the \
                 server again, which reads the version the file holds."
            ),
            (Unapplied::CommitFailed(_), None) => format!(
                "{label} may have been made at schema version {to}: its tables did not commit \
                 cleanly ({why}). Start the server again."
            ),
            (_, Some(from)) => format!(
                "{label} was not upgraded from schema version {from} to {to}, because {why}. \
                 Nothing was changed."
            ),
            (_, None) => format!("{label} could not be made at schema version {to}: {why}"),
        };
        // Starting again meets the same rows.
        if matches!(self, Unapplied::Dangling(_)) {
            Failure::database(message)
        } else {
            Failure::start(message)
        }
    }
}

/// Applies the migrations after `from` to a file an earlier build wrote whole.
pub fn upgrade(
    conn: &mut Connection,
    migrations: &[Migration],
    from: u32,
) -> Result<(), Unapplied> {
    let steps = migrations
        .iter()
        .filter(|migration| migration.version > from);
    apply(conn, steps, latest(migrations), false)
}

pub fn complete(conn: &mut Connection, migrations: &[Migration]) -> Result<(), Unapplied> {
    apply(conn, migrations.iter(), latest(migrations), true)
}

/// Foreign keys are off outside the transaction, so dropping a rebuilt table neither cascades
/// nor fails.
fn apply<'a>(
    conn: &mut Connection,
    steps: impl Iterator<Item = &'a Migration>,
    version: u32,
    skip_done: bool,
) -> Result<(), Unapplied> {
    set_foreign_keys(conn, false)?;
    let applied = in_one_transaction(conn, steps, version, skip_done);
    let restored = set_foreign_keys(conn, true);
    applied?;
    restored.map_err(|cause| Unapplied::Committed(Box::new(cause)))
}

fn in_one_transaction<'a>(
    conn: &mut Connection,
    steps: impl Iterator<Item = &'a Migration>,
    version: u32,
    skip_done: bool,
) -> Result<(), Unapplied> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    for migration in steps {
        if let (true, Some(done)) = (skip_done, migration.done)
            && tx.query_row(done, [], |row| row.get::<_, bool>(0))?
        {
            continue;
        }
        tx.execute_batch(migration.sql)?;
    }
    let dangling: Vec<(String, String, i64)> = tx
        .prepare(
            "SELECT \"table\", parent, count(*) FROM pragma_foreign_key_check \
             GROUP BY \"table\", parent ORDER BY \"table\", parent",
        )?
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
        .collect::<rusqlite::Result<_>>()?;
    if !dangling.is_empty() {
        return Err(Unapplied::Dangling(dangling));
    }
    tx.pragma_update(None, "user_version", version)?;
    tx.commit().map_err(Unapplied::CommitFailed)
}

/// SQLite ignores the setting inside a transaction without a word, so it is read back.
fn set_foreign_keys(conn: &Connection, on: bool) -> Result<(), Unapplied> {
    conn.pragma_update(None, "foreign_keys", on)?;
    let now: bool = conn.pragma_query_value(None, "foreign_keys", |row| row.get(0))?;
    if now == on {
        Ok(())
    } else {
        Err(Unapplied::KeysUnchanged { on })
    }
}
