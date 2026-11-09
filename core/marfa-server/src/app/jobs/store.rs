//! Every statement about bulk-action jobs.

use rusqlite::{OptionalExtension, Row, Transaction, params};
use serde_json::Value;

use super::Queued;
use crate::app::access::Maker;
use crate::app::clock::readable;
use crate::app::items::Selected;
use crate::app::refusal::{Refusal, Result};

pub const QUEUED: &str = "queued";
pub const RUNNING: &str = "in_progress";
pub const COMPLETED: &str = "completed";
pub const FAILED: &str = "failed";
pub const CANCELED: &str = "canceled";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Note {
    Changed,
    Error,
    Carried,
    Blob,
}

impl Note {
    const fn word(self) -> &'static str {
        match self {
            Note::Changed => "changed",
            Note::Error => "error",
            Note::Carried => "carried",
            Note::Blob => "blob",
        }
    }
}

#[derive(Clone, Debug)]
pub struct Job {
    pub id: String,
    pub queued: Queued,
    pub holder: Maker,
    pub status: String,
    pub matched: i64,
    pub processed: i64,
    pub succeeded: i64,
    pub errored: i64,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub error: Option<String>,
    pub result: Option<Value>,
}

impl Job {
    pub fn is_open(&self) -> bool {
        self.status == QUEUED || self.status == RUNNING
    }
}

const JOB: &str = "SELECT id, input, key_id, grant_id, status, matched, processed, succeeded, \
     errored, started_at, finished_at, error, result FROM bulk_jobs";

fn unreadable(column: usize, error: serde_json::Error) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(column, rusqlite::types::Type::Text, error.into())
}

fn job_of(row: &Row<'_>) -> rusqlite::Result<Job> {
    let input: String = row.get(1)?;
    let holder = match (
        row.get::<_, Option<String>>(2)?,
        row.get::<_, Option<String>>(3)?,
    ) {
        (Some(id), _) => Maker::Key(id),
        (None, Some(id)) => Maker::Grant(id),
        (None, None) => {
            return Err(rusqlite::Error::InvalidColumnType(
                2,
                "key_id".into(),
                rusqlite::types::Type::Null,
            ));
        }
    };
    let result: Option<String> = row.get(12)?;
    Ok(Job {
        id: row.get(0)?,
        queued: serde_json::from_str(&input).map_err(|error| unreadable(1, error))?,
        holder,
        status: row.get(4)?,
        matched: row.get(5)?,
        processed: row.get(6)?,
        succeeded: row.get(7)?,
        errored: row.get(8)?,
        started_at: row.get(9)?,
        finished_at: row.get(10)?,
        error: row.get(11)?,
        result: result
            .map(|text| serde_json::from_str(&text).map_err(|error| unreadable(12, error)))
            .transpose()?,
    })
}

fn holder_columns(holder: &Maker) -> (Option<&str>, Option<&str>) {
    match holder {
        Maker::Key(id) => (Some(id), None),
        Maker::Grant(id) => (None, Some(id)),
    }
}

pub fn insert(
    tx: &Transaction<'_>,
    id: &str,
    queued: &Queued,
    holder: &Maker,
    items: &[Selected],
    at: &str,
) -> Result<()> {
    let input = serde_json::to_string(queued)
        .map_err(|_| Refusal::internal("a job's input did not print"))?;
    let (key_id, grant_id) = holder_columns(holder);
    tx.execute(
        "INSERT INTO bulk_jobs (id, action, input, key_id, grant_id, status, matched, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, 'queued', ?6, ?7)",
        params![
            id,
            queued.action.name(),
            input,
            key_id,
            grant_id,
            items.len() as i64,
            at
        ],
    )?;
    let mut statement = tx.prepare_cached(
        "INSERT INTO bulk_job_items (job_id, position, item_id, version, state) \
         VALUES (?1, ?2, ?3, ?4, ?5)",
    )?;
    for (position, item) in items.iter().enumerate() {
        statement.execute(params![
            id,
            position as i64,
            item.id,
            item.version,
            item.state
        ])?;
    }
    Ok(())
}

pub fn by_id(tx: &Transaction<'_>, id: &str) -> Result<Option<Job>> {
    let mut statement = tx.prepare_cached(&format!("{JOB} WHERE id = ?1"))?;
    Ok(statement.query_row([id], job_of).optional()?)
}

/// A job left running is taken before any queued one, so a restart finishes it first.
pub fn next_open(tx: &Transaction<'_>) -> Result<Option<String>> {
    Ok(tx
        .query_row(
            "SELECT id FROM bulk_jobs WHERE status IN ('queued', 'in_progress') \
             ORDER BY status = 'queued', id LIMIT 1",
            [],
            |row| row.get(0),
        )
        .optional()?)
}

pub fn claim(tx: &Transaction<'_>, id: &str, at: &str) -> Result<()> {
    tx.execute(
        "UPDATE bulk_jobs SET status = 'in_progress', started_at = ?2 \
         WHERE id = ?1 AND status = 'queued'",
        params![id, at],
    )?;
    Ok(())
}

pub fn slice(tx: &Transaction<'_>, id: &str, from: i64, limit: i64) -> Result<Vec<Selected>> {
    let mut statement = tx.prepare_cached(
        "SELECT item_id, version, state FROM bulk_job_items WHERE job_id = ?1 AND position >= ?2 \
         ORDER BY position LIMIT ?3",
    )?;
    let rows = statement.query_map(params![id, from, limit], |row| {
        Ok(Selected {
            id: row.get(0)?,
            version: row.get(1)?,
            state: row.get(2)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

pub fn advance(
    tx: &Transaction<'_>,
    id: &str,
    processed: i64,
    succeeded: i64,
    errored: i64,
) -> Result<()> {
    tx.prepare_cached(
        "UPDATE bulk_jobs SET processed = ?2, succeeded = ?3, errored = ?4 WHERE id = ?1",
    )?
    .execute(params![id, processed, succeeded, errored])?;
    Ok(())
}

pub fn note(
    tx: &Transaction<'_>,
    id: &str,
    kind: Note,
    name: &str,
    body: Option<&str>,
) -> Result<()> {
    tx.prepare_cached(
        "INSERT INTO bulk_job_notes (job_id, kind, name, body) VALUES (?1, ?2, ?3, ?4) \
         ON CONFLICT (job_id, kind, name) DO NOTHING",
    )?
    .execute(params![id, kind.word(), name, body])?;
    Ok(())
}

pub fn noted(tx: &Transaction<'_>, id: &str, kind: Note, name: &str) -> Result<bool> {
    Ok(tx
        .prepare_cached(
            "SELECT EXISTS (SELECT 1 FROM bulk_job_notes WHERE job_id = ?1 AND kind = ?2 AND name = ?3)",
        )?
        .query_row(params![id, kind.word(), name], |row| row.get(0))?)
}

/// In the order they were noted.
pub fn notes(tx: &Transaction<'_>, id: &str, kind: Note) -> Result<Vec<(String, Option<String>)>> {
    let mut statement = tx.prepare_cached(
        "SELECT name, body FROM bulk_job_notes WHERE job_id = ?1 AND kind = ?2 ORDER BY rowid",
    )?;
    let rows = statement.query_map(params![id, kind.word()], |row| {
        Ok((row.get(0)?, row.get(1)?))
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

pub fn count_notes(tx: &Transaction<'_>, id: &str, kind: Note) -> Result<i64> {
    Ok(tx
        .prepare_cached("SELECT COUNT(*) FROM bulk_job_notes WHERE job_id = ?1 AND kind = ?2")?
        .query_row(params![id, kind.word()], |row| row.get(0))?)
}

/// What a job worked from goes once it ends; its answer keeps what it did.
pub fn end(
    tx: &Transaction<'_>,
    id: &str,
    status: &str,
    at: &str,
    error: Option<&str>,
    result: Option<&Value>,
) -> Result<()> {
    tx.execute(
        "UPDATE bulk_jobs SET status = ?2, finished_at = ?3, error = ?4, result = ?5 WHERE id = ?1",
        params![id, status, at, error, result.map(Value::to_string)],
    )?;
    tx.execute("DELETE FROM bulk_job_items WHERE job_id = ?1", [id])?;
    tx.execute("DELETE FROM bulk_job_notes WHERE job_id = ?1", [id])?;
    Ok(())
}

/// Removes up to `limit` jobs that ended before `before`.
pub fn remove_ended(tx: &Transaction<'_>, before: &str, limit: i64) -> Result<i64> {
    let removed = tx.execute(
        &format!(
            "DELETE FROM bulk_jobs WHERE id IN (SELECT id FROM bulk_jobs \
             WHERE {} AND finished_at < ?1 LIMIT ?2)",
            readable("finished_at")
        ),
        params![before, limit],
    )?;
    Ok(removed as i64)
}
