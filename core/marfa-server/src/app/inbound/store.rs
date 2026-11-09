//! The rows of inbound sources, endpoints, deliveries and bodies.

use rusqlite::{OptionalExtension, Row, Transaction, params};

use crate::app::clock::{Stamp, readable};
use crate::app::refusal::Result;

pub struct Endpoint {
    pub id: String,
    pub token_last4: String,
    pub label: Option<String>,
    pub duplicate_header: Option<String>,
    pub created_at: String,
    pub retired_at: Option<String>,
}

pub struct Delivery {
    pub seq: i64,
    pub id: String,
    pub endpoint_id: String,
    pub received_at: String,
    pub method: String,
    pub query: String,
    pub headers: Vec<(String, String)>,
    pub size: i64,
    pub sha256: String,
    pub dedupe_key: Option<String>,
    pub handled_at: Option<String>,
    pub outcome: Option<String>,
}

/// An endpoint a sender may post to, and the registration that holds it.
pub struct Target {
    pub endpoint_id: String,
    pub connector_id: String,
    pub source: String,
    pub duplicate_header: Option<String>,
}

pub struct Tally {
    pub pending: i64,
    pub pending_bytes: i64,
    pub retained: i64,
    pub retained_bytes: i64,
}

pub struct Fresh<'a> {
    pub id: &'a str,
    pub source: &'a str,
    pub token_hash: &'a str,
    pub token_last4: &'a str,
    pub label: Option<&'a str>,
    pub duplicate_header: Option<&'a str>,
    pub at: &'a str,
}

pub struct Receipt<'a> {
    pub id: &'a str,
    pub endpoint_id: &'a str,
    pub source: &'a str,
    pub at: &'a str,
    pub query: &'a str,
    pub headers: &'a str,
    pub size: i64,
    pub sha256: &'a str,
    pub dedupe_key: Option<&'a str>,
    pub charge: i64,
}

fn unread(row: &Row<'_>, column: &str, what: &str) -> rusqlite::Error {
    let index = row.as_ref().column_index(column).unwrap_or(0);
    rusqlite::Error::FromSqlConversionFailure(
        index,
        rusqlite::types::Type::Text,
        format!("{column} is not {what}").into(),
    )
}

/// A stored time that does not read is a fault, never a default.
fn moment(row: &Row<'_>, column: &str) -> rusqlite::Result<String> {
    row.get::<_, Stamp>(column).map(Stamp::text)
}

fn optional_moment(row: &Row<'_>, column: &str) -> rusqlite::Result<Option<String>> {
    Ok(row.get::<_, Option<Stamp>>(column)?.map(Stamp::text))
}

fn endpoint(row: &Row<'_>) -> rusqlite::Result<Endpoint> {
    Ok(Endpoint {
        id: row.get("id")?,
        token_last4: row.get("token_last4")?,
        label: row.get("label")?,
        duplicate_header: row.get("duplicate_header")?,
        created_at: moment(row, "created_at")?,
        retired_at: optional_moment(row, "retired_at")?,
    })
}

fn delivery(row: &Row<'_>) -> rusqlite::Result<Delivery> {
    let headers: String = row.get("headers")?;
    Ok(Delivery {
        seq: row.get("seq")?,
        id: row.get("id")?,
        endpoint_id: row.get("endpoint_id")?,
        received_at: moment(row, "received_at")?,
        method: row.get("method")?,
        query: row.get("query")?,
        headers: serde_json::from_str(&headers)
            .map_err(|_| unread(row, "headers", "a list of pairs"))?,
        size: row.get("size")?,
        sha256: row.get("sha256")?,
        dedupe_key: row.get("dedupe_key")?,
        handled_at: optional_moment(row, "handled_at")?,
        outcome: row.get("outcome")?,
    })
}

pub fn bind(tx: &Transaction<'_>, source: &str, connector_id: &str) -> Result<()> {
    tx.prepare_cached(
        "INSERT INTO inbound_sources (source, connector_id) VALUES (?1, ?2) \
         ON CONFLICT (source) DO UPDATE SET connector_id = ?2",
    )?
    .execute(params![source, connector_id])?;
    Ok(())
}

pub fn kept_for(tx: &Transaction<'_>, source: &str) -> Result<bool> {
    Ok(tx
        .prepare_cached(
            "SELECT 1 FROM inbound_sources WHERE source = ?1 \
             UNION ALL SELECT 1 FROM inbound_endpoints WHERE source = ?1 LIMIT 1",
        )?
        .exists([source])?)
}

/// Whether the registration is the one that holds its source's endpoints and deliveries.
pub fn holds(tx: &Transaction<'_>, source: &str, connector_id: &str) -> Result<bool> {
    Ok(tx
        .prepare_cached("SELECT 1 FROM inbound_sources WHERE source = ?1 AND connector_id = ?2")?
        .exists(params![source, connector_id])?)
}

/// Excludes retired endpoints and revoked keys; the caller checks expiry.
pub fn target(tx: &Transaction<'_>, token_hash: &str) -> Result<Option<(Target, Option<String>)>> {
    Ok(tx
        .prepare_cached(
            "SELECT e.id, e.source, e.duplicate_header, s.connector_id, k.expires_at \
             FROM inbound_endpoints e \
             JOIN inbound_sources s ON s.source = e.source \
             JOIN connectors c ON c.id = s.connector_id \
             JOIN api_keys k ON k.id = c.key_id \
             WHERE e.token_hash = ?1 AND e.retired_at IS NULL AND k.revoked_at IS NULL",
        )?
        .query_row([token_hash], |row| {
            Ok((
                Target {
                    endpoint_id: row.get("id")?,
                    connector_id: row.get("connector_id")?,
                    source: row.get("source")?,
                    duplicate_header: row.get("duplicate_header")?,
                },
                optional_moment(row, "expires_at")?,
            ))
        })
        .optional()?)
}

pub fn live_endpoints(tx: &Transaction<'_>, source: &str) -> Result<i64> {
    Ok(tx
        .prepare_cached(
            "SELECT COUNT(*) FROM inbound_endpoints WHERE source = ?1 AND retired_at IS NULL",
        )?
        .query_row([source], |row| row.get(0))?)
}

pub fn insert_endpoint(tx: &Transaction<'_>, fresh: &Fresh<'_>) -> Result<()> {
    tx.prepare_cached(
        "INSERT INTO inbound_endpoints (id, source, token_hash, token_last4, label, \
         duplicate_header, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    )?
    .execute(params![
        fresh.id,
        fresh.source,
        fresh.token_hash,
        fresh.token_last4,
        fresh.label,
        fresh.duplicate_header,
        fresh.at
    ])?;
    Ok(())
}

pub fn endpoints(tx: &Transaction<'_>, source: &str) -> Result<Vec<Endpoint>> {
    let mut statement =
        tx.prepare_cached("SELECT * FROM inbound_endpoints WHERE source = ?1 ORDER BY seq DESC")?;
    let rows = statement.query_map([source], endpoint)?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

pub fn endpoint_of(tx: &Transaction<'_>, source: &str, id: &str) -> Result<Option<Endpoint>> {
    Ok(tx
        .prepare_cached("SELECT * FROM inbound_endpoints WHERE source = ?1 AND id = ?2")?
        .query_row(params![source, id], endpoint)
        .optional()?)
}

pub fn retire(tx: &Transaction<'_>, id: &str, at: &str) -> Result<()> {
    tx.prepare_cached("UPDATE inbound_endpoints SET retired_at = ?2 WHERE id = ?1")?
        .execute(params![id, at])?;
    Ok(())
}

pub fn tally(tx: &Transaction<'_>, source: &str) -> Result<Tally> {
    Ok(tx
        .prepare_cached(
            "SELECT COUNT(CASE WHEN handled_at IS NULL THEN 1 END), \
             COALESCE(SUM(CASE WHEN handled_at IS NULL THEN size END), 0), \
             COUNT(*), COALESCE(SUM(charge), 0) \
             FROM inbound_deliveries WHERE source = ?1",
        )?
        .query_row([source], |row| {
            Ok(Tally {
                pending: row.get(0)?,
                pending_bytes: row.get(1)?,
                retained: row.get(2)?,
                retained_bytes: row.get(3)?,
            })
        })?)
}

pub fn insert_delivery(tx: &Transaction<'_>, receipt: &Receipt<'_>) -> Result<i64> {
    tx.prepare_cached(
        "INSERT INTO inbound_deliveries (id, endpoint_id, source, received_at, method, query, \
         headers, size, sha256, dedupe_key, charge) \
         VALUES (?1, ?2, ?3, ?4, 'POST', ?5, ?6, ?7, ?8, ?9, ?10)",
    )?
    .execute(params![
        receipt.id,
        receipt.endpoint_id,
        receipt.source,
        receipt.at,
        receipt.query,
        receipt.headers,
        receipt.size,
        receipt.sha256,
        receipt.dedupe_key,
        receipt.charge
    ])?;
    Ok(tx.last_insert_rowid())
}

pub fn insert_body(tx: &Transaction<'_>, delivery_seq: i64, body: &[u8]) -> Result<()> {
    tx.prepare_cached("INSERT INTO inbound_bodies (delivery_seq, body) VALUES (?1, ?2)")?
        .execute(params![delivery_seq, body])?;
    Ok(())
}

pub fn deliveries_page(
    tx: &Transaction<'_>,
    source: &str,
    state: Option<bool>,
    endpoint_id: Option<&str>,
    after: Option<(&str, i64)>,
    limit: i64,
) -> Result<Vec<Delivery>> {
    let (received, seq) = after.unwrap_or(("", 0));
    let mut statement = tx.prepare_cached(
        "SELECT * FROM inbound_deliveries WHERE source = ?1 \
         AND (?2 IS NULL OR (handled_at IS NOT NULL) = ?2) \
         AND (?3 IS NULL OR endpoint_id = ?3) \
         AND (received_at > ?4 OR (received_at = ?4 AND seq > ?5)) \
         ORDER BY received_at, seq LIMIT ?6",
    )?;
    let rows = statement.query_map(
        params![
            source,
            state.map(i64::from),
            endpoint_id,
            received,
            seq,
            limit
        ],
        delivery,
    )?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

pub fn delivery_of(tx: &Transaction<'_>, source: &str, id: &str) -> Result<Option<Delivery>> {
    Ok(tx
        .prepare_cached("SELECT * FROM inbound_deliveries WHERE source = ?1 AND id = ?2")?
        .query_row(params![source, id], delivery)
        .optional()?)
}

pub fn body(tx: &Transaction<'_>, source: &str, id: &str) -> Result<Option<Vec<u8>>> {
    Ok(tx
        .prepare_cached(
            "SELECT b.body FROM inbound_bodies b \
             JOIN inbound_deliveries d ON d.seq = b.delivery_seq \
             WHERE d.source = ?1 AND d.id = ?2",
        )?
        .query_row(params![source, id], |row| row.get(0))
        .optional()?)
}

/// The earliest retained delivery on the endpoint that carried the value.
pub fn original(
    tx: &Transaction<'_>,
    endpoint_id: &str,
    dedupe_key: &str,
) -> Result<Option<(String, Option<String>)>> {
    Ok(tx
        .prepare_cached(
            "SELECT id, outcome FROM inbound_deliveries WHERE endpoint_id = ?1 AND dedupe_key = ?2 \
             ORDER BY received_at, seq LIMIT 1",
        )?
        .query_row(params![endpoint_id, dedupe_key], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .optional()?)
}

pub fn mark(tx: &Transaction<'_>, id: &str, at: &str, outcome: &str) -> Result<()> {
    tx.prepare_cached(
        "UPDATE inbound_deliveries SET handled_at = ?2, outcome = ?3 \
         WHERE id = ?1 AND handled_at IS NULL",
    )?
    .execute(params![id, at, outcome])?;
    Ok(())
}

/// A delivery past its retention, and what it holds against its registration.
pub struct Expired {
    pub seq: i64,
    pub charge: i64,
}

/// A `None` cutoff keeps that class regardless of age.
pub fn expired(
    tx: &Transaction<'_>,
    handled_before: Option<&str>,
    pending_before: Option<&str>,
    limit: i64,
) -> Result<Vec<Expired>> {
    let mut statement = tx.prepare_cached(&format!(
        "SELECT seq, charge FROM ( \
           SELECT * FROM (SELECT seq, charge, handled_at AS aged FROM inbound_deliveries \
             WHERE {handled} AND handled_at < ?1 ORDER BY handled_at, seq LIMIT ?3) \
           UNION ALL \
           SELECT * FROM (SELECT seq, charge, received_at AS aged FROM inbound_deliveries \
             WHERE handled_at IS NULL AND {received} AND received_at < ?2 \
             ORDER BY received_at, seq LIMIT ?3) \
         ) ORDER BY aged, seq LIMIT ?3",
        handled = readable("handled_at"),
        received = readable("received_at"),
    ))?;
    let rows = statement.query_map(params![handled_before, pending_before, limit], |row| {
        Ok(Expired {
            seq: row.get(0)?,
            charge: row.get(1)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

pub fn remove(tx: &Transaction<'_>, seq: i64) -> Result<()> {
    tx.prepare_cached("DELETE FROM inbound_deliveries WHERE seq = ?1")?
        .execute([seq])?;
    Ok(())
}

pub fn any_expired(
    tx: &Transaction<'_>,
    handled_before: Option<&str>,
    pending_before: Option<&str>,
) -> Result<bool> {
    Ok(tx
        .prepare_cached(&format!(
            "SELECT EXISTS (SELECT 1 FROM inbound_deliveries WHERE {handled} \
               AND handled_at < ?1) \
             OR EXISTS (SELECT 1 FROM inbound_deliveries WHERE handled_at IS NULL \
               AND {received} AND received_at < ?2)",
            handled = readable("handled_at"),
            received = readable("received_at"),
        ))?
        .query_row(params![handled_before, pending_before], |row| row.get(0))?)
}
