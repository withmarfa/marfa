//! The rows of connectors, their runs, holds, state documents and agreements.

use rusqlite::{OptionalExtension, Row, Transaction, params};
use serde_json::{Map, Value};

use crate::app::clock::Stamp;
use crate::app::refusal::{Refusal, Result};

pub struct Registration {
    pub id: String,
    pub key_id: String,
    pub source: String,
    pub name: String,
    pub description: Option<String>,
    pub read_only_types: Vec<String>,
    pub registered_at: String,
    pub updated_at: String,
    pub last_heartbeat_at: Option<String>,
}

pub struct Run {
    pub seq: i64,
    pub id: String,
    pub connector_id: String,
    pub outcome: String,
    pub started_at: String,
    pub finished_at: String,
    pub summary: Option<String>,
    pub error: Option<String>,
    pub reported_at: String,
}

pub struct Hold {
    pub process: String,
    pub expires_at: String,
    expires: Stamp,
}

impl Hold {
    /// Whether the hold still stands at the stored-form moment `at`.
    pub fn stands_at(&self, at: &str) -> Result<bool> {
        Ok(self.expires > Stamp::read(at)?)
    }
}

pub struct Document {
    pub state: Map<String, Value>,
    pub problems: Map<String, Value>,
    pub updated_at: String,
}

pub struct Agreement {
    pub item_id: String,
    pub waiting: bool,
    pub record: Map<String, Value>,
    pub updated_at: String,
}

/// A JSON column that does not read is a fault, never an empty value.
fn stored<T: serde::de::DeserializeOwned>(row: &Row<'_>, column: &str) -> rusqlite::Result<T> {
    let index = row.as_ref().column_index(column)?;
    let text: String = row.get(index)?;
    serde_json::from_str(&text).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            index,
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })
}

fn moment(row: &Row<'_>, column: &str) -> rusqlite::Result<String> {
    row.get::<_, Stamp>(column).map(Stamp::text)
}

fn optional_moment(row: &Row<'_>, column: &str) -> rusqlite::Result<Option<String>> {
    Ok(row.get::<_, Option<Stamp>>(column)?.map(Stamp::text))
}

fn registration(row: &Row<'_>) -> rusqlite::Result<Registration> {
    Ok(Registration {
        id: row.get("id")?,
        key_id: row.get("key_id")?,
        source: row.get("source")?,
        name: row.get("name")?,
        description: row.get("description")?,
        read_only_types: stored(row, "read_only_types")?,
        registered_at: moment(row, "registered_at")?,
        updated_at: moment(row, "updated_at")?,
        last_heartbeat_at: optional_moment(row, "last_heartbeat_at")?,
    })
}

fn run(row: &Row<'_>) -> rusqlite::Result<Run> {
    Ok(Run {
        seq: row.get("seq")?,
        id: row.get("id")?,
        connector_id: row.get("connector_id")?,
        outcome: row.get("outcome")?,
        started_at: moment(row, "started_at")?,
        finished_at: moment(row, "finished_at")?,
        summary: row.get("summary")?,
        error: row.get("error")?,
        reported_at: moment(row, "reported_at")?,
    })
}

fn agreement(row: &Row<'_>) -> rusqlite::Result<Agreement> {
    Ok(Agreement {
        item_id: row.get("item_id")?,
        waiting: row.get::<_, i64>("waiting")? == 1,
        record: stored(row, "record")?,
        updated_at: moment(row, "updated_at")?,
    })
}

pub fn by_id(tx: &Transaction<'_>, id: &str) -> Result<Option<Registration>> {
    Ok(tx
        .prepare_cached("SELECT * FROM connectors WHERE id = ?1")?
        .query_row([id], registration)
        .optional()?)
}

pub fn by_key(tx: &Transaction<'_>, key_id: &str) -> Result<Option<Registration>> {
    Ok(tx
        .prepare_cached("SELECT * FROM connectors WHERE key_id = ?1")?
        .query_row([key_id], registration)
        .optional()?)
}

pub fn newest_first(tx: &Transaction<'_>) -> Result<Vec<Registration>> {
    let mut statement = tx.prepare_cached("SELECT * FROM connectors ORDER BY seq DESC")?;
    let rows = statement.query_map([], registration)?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

pub fn declared_by_keys(tx: &Transaction<'_>) -> Result<Vec<(String, Vec<String>)>> {
    let mut statement = tx.prepare_cached("SELECT key_id, read_only_types FROM connectors")?;
    let rows = statement.query_map([], |row| {
        Ok((row.get("key_id")?, stored(row, "read_only_types")?))
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

pub struct Fresh<'a> {
    pub id: &'a str,
    pub key_id: &'a str,
    pub source: &'a str,
    pub name: &'a str,
    pub description: Option<&'a str>,
    pub declared: &'a [String],
    pub at: &'a str,
}

pub fn insert(tx: &Transaction<'_>, fresh: &Fresh<'_>) -> Result<()> {
    let declared = serde_json::to_string(fresh.declared)
        .map_err(|_| Refusal::internal("read_only_types did not print"))?;
    tx.prepare_cached(
        "INSERT INTO connectors (id, key_id, source, name, description, read_only_types, \
         registered_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
    )?
    .execute(params![
        fresh.id,
        fresh.key_id,
        fresh.source,
        fresh.name,
        fresh.description,
        declared,
        fresh.at
    ])?;
    Ok(())
}

pub fn replace(
    tx: &Transaction<'_>,
    id: &str,
    name: &str,
    description: Option<&str>,
    declared: &[String],
    at: &str,
) -> Result<()> {
    let declared = serde_json::to_string(declared)
        .map_err(|_| Refusal::internal("read_only_types did not print"))?;
    tx.prepare_cached(
        "UPDATE connectors SET name = ?2, description = ?3, read_only_types = ?4, updated_at = ?5 \
         WHERE id = ?1",
    )?
    .execute(params![id, name, description, declared, at])?;
    Ok(())
}

pub fn delete(tx: &Transaction<'_>, id: &str) -> Result<bool> {
    Ok(tx
        .prepare_cached("DELETE FROM connectors WHERE id = ?1")?
        .execute([id])?
        > 0)
}

pub fn heartbeat(tx: &Transaction<'_>, id: &str, at: &str) -> Result<()> {
    tx.prepare_cached("UPDATE connectors SET last_heartbeat_at = ?2 WHERE id = ?1")?
        .execute(params![id, at])?;
    Ok(())
}

pub fn last_run(tx: &Transaction<'_>, connector_id: &str) -> Result<Option<Run>> {
    Ok(tx
        .prepare_cached(
            "SELECT * FROM connector_runs WHERE connector_id = ?1 \
             ORDER BY reported_at DESC, seq DESC LIMIT 1",
        )?
        .query_row([connector_id], run)
        .optional()?)
}

pub fn insert_run(tx: &Transaction<'_>, kept: usize, report: &Run) -> Result<()> {
    tx.prepare_cached(
        "INSERT INTO connector_runs (id, connector_id, outcome, started_at, finished_at, \
         summary, error, reported_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
    )?
    .execute(params![
        report.id,
        report.connector_id,
        report.outcome,
        report.started_at,
        report.finished_at,
        report.summary,
        report.error,
        report.reported_at,
    ])?;
    tx.prepare_cached(
        "DELETE FROM connector_runs WHERE connector_id = ?1 AND seq NOT IN \
         (SELECT seq FROM connector_runs WHERE connector_id = ?1 \
          ORDER BY reported_at DESC, seq DESC LIMIT ?2)",
    )?
    .execute(params![report.connector_id, kept as i64])?;
    Ok(())
}

pub fn runs_page(
    tx: &Transaction<'_>,
    connector_id: &str,
    after: Option<(&str, i64)>,
    limit: i64,
) -> Result<Vec<Run>> {
    let (reported, seq) = after.unwrap_or(("\u{10ffff}", i64::MAX));
    let mut statement = tx.prepare_cached(
        "SELECT * FROM connector_runs WHERE connector_id = ?1 \
         AND (reported_at < ?2 OR (reported_at = ?2 AND seq < ?3)) \
         ORDER BY reported_at DESC, seq DESC LIMIT ?4",
    )?;
    let rows = statement.query_map(params![connector_id, reported, seq, limit], run)?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

pub fn hold(tx: &Transaction<'_>, connector_id: &str) -> Result<Option<Hold>> {
    Ok(tx
        .prepare_cached("SELECT process, expires_at FROM connector_holds WHERE connector_id = ?1")?
        .query_row([connector_id], |row| {
            let expires: Stamp = row.get("expires_at")?;
            Ok(Hold {
                process: row.get("process")?,
                expires_at: expires.text(),
                expires,
            })
        })
        .optional()?)
}

pub fn put_hold(
    tx: &Transaction<'_>,
    connector_id: &str,
    process: &str,
    until: &str,
) -> Result<()> {
    tx.prepare_cached(
        "INSERT INTO connector_holds (connector_id, process, expires_at) VALUES (?1, ?2, ?3) \
         ON CONFLICT (connector_id) DO UPDATE SET process = ?2, expires_at = ?3",
    )?
    .execute(params![connector_id, process, until])?;
    Ok(())
}

pub fn drop_hold(tx: &Transaction<'_>, connector_id: &str, process: &str) -> Result<()> {
    tx.prepare_cached("DELETE FROM connector_holds WHERE connector_id = ?1 AND process = ?2")?
        .execute(params![connector_id, process])?;
    Ok(())
}

pub fn kept_for(tx: &Transaction<'_>, source: &str) -> Result<bool> {
    Ok(tx
        .prepare_cached(
            "SELECT 1 FROM connectors WHERE source = ?1 \
             UNION ALL SELECT 1 FROM connector_states WHERE source = ?1 \
             UNION ALL SELECT 1 FROM connector_agreements WHERE source = ?1 LIMIT 1",
        )?
        .exists([source])?)
}

pub fn document(tx: &Transaction<'_>, source: &str) -> Result<Option<Document>> {
    Ok(tx
        .prepare_cached(
            "SELECT state, problems, updated_at FROM connector_states WHERE source = ?1",
        )?
        .query_row([source], |row| {
            Ok(Document {
                state: stored(row, "state")?,
                problems: stored(row, "problems")?,
                updated_at: moment(row, "updated_at")?,
            })
        })
        .optional()?)
}

pub fn problems(tx: &Transaction<'_>, source: &str) -> Result<Map<String, Value>> {
    Ok(document(tx, source)?
        .map(|held| held.problems)
        .unwrap_or_default())
}

pub fn put_document(
    tx: &Transaction<'_>,
    source: &str,
    state: &str,
    problems: &str,
    at: &str,
) -> Result<()> {
    tx.prepare_cached(
        "INSERT INTO connector_states (source, state, problems, updated_at) VALUES (?1, ?2, ?3, ?4) \
         ON CONFLICT (source) DO UPDATE SET state = ?2, problems = ?3, updated_at = ?4",
    )?
    .execute(params![source, state, problems, at])?;
    Ok(())
}

pub fn clear_document(tx: &Transaction<'_>, source: &str) -> Result<bool> {
    Ok(tx
        .prepare_cached("DELETE FROM connector_states WHERE source = ?1")?
        .execute([source])?
        > 0)
}

pub fn put_agreement(
    tx: &Transaction<'_>,
    source: &str,
    item_id: &str,
    waiting: bool,
    record: &str,
    at: &str,
) -> Result<()> {
    tx.prepare_cached(
        "INSERT INTO connector_agreements (source, item_id, waiting, record, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5) \
         ON CONFLICT (source, item_id) DO UPDATE SET waiting = ?3, record = ?4, updated_at = ?5",
    )?
    .execute(params![source, item_id, i64::from(waiting), record, at])?;
    Ok(())
}

pub fn drop_agreement(tx: &Transaction<'_>, source: &str, item_id: &str) -> Result<usize> {
    Ok(tx
        .prepare_cached("DELETE FROM connector_agreements WHERE source = ?1 AND item_id = ?2")?
        .execute(params![source, item_id])?)
}

pub fn clear_agreements(tx: &Transaction<'_>, source: &str) -> Result<usize> {
    Ok(tx
        .prepare_cached("DELETE FROM connector_agreements WHERE source = ?1")?
        .execute([source])?)
}

pub fn agreement_of(
    tx: &Transaction<'_>,
    source: &str,
    item_id: &str,
) -> Result<Option<Agreement>> {
    Ok(tx
        .prepare_cached("SELECT * FROM connector_agreements WHERE source = ?1 AND item_id = ?2")?
        .query_row(params![source, item_id], agreement)
        .optional()?)
}

pub fn agreements_page(
    tx: &Transaction<'_>,
    source: &str,
    waiting: Option<bool>,
    after: Option<(&str, &str)>,
    limit: i64,
) -> Result<Vec<Agreement>> {
    let (updated, item) = after.unwrap_or(("", ""));
    let mut statement = tx.prepare_cached(
        "SELECT * FROM connector_agreements WHERE source = ?1 \
         AND (?2 IS NULL OR waiting = ?2) \
         AND (updated_at > ?3 OR (updated_at = ?3 AND item_id > ?4)) \
         ORDER BY updated_at, item_id LIMIT ?5",
    )?;
    let rows = statement.query_map(
        params![source, waiting.map(i64::from), updated, item, limit],
        agreement,
    )?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// Every source's state document, by source.
pub fn documents(tx: &Transaction<'_>) -> Result<Vec<(String, Map<String, Value>)>> {
    let mut statement =
        tx.prepare_cached("SELECT source, state FROM connector_states ORDER BY source")?;
    let rows = statement.query_map([], |row| Ok((row.get(0)?, stored(row, "state")?)))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// Every agreement, by source and item.
pub fn every_agreement(tx: &Transaction<'_>) -> Result<Vec<(String, Agreement)>> {
    let mut statement =
        tx.prepare_cached("SELECT * FROM connector_agreements ORDER BY source, item_id")?;
    let rows = statement.query_map([], |row| Ok((row.get("source")?, agreement(row)?)))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}
