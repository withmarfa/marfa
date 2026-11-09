//! A key revoked or expired stays a while, so that a request bearing it is refused as ended
//! rather than unknown.

use rusqlite::{Transaction, params};

use super::super::folders;
use super::super::refusal::Result;

pub const KEPT_DAYS: i64 = 30;

const ENDED: &str = "(revoked_at < ?1 OR (revoked_at IS NULL AND expires_at < ?1))";

pub fn any(tx: &Transaction<'_>, before: &str) -> Result<bool> {
    Ok(tx.query_row(
        &format!("SELECT EXISTS (SELECT 1 FROM api_keys WHERE {ENDED})"),
        [before],
        |row| row.get(0),
    )?)
}

pub fn remove(tx: &Transaction<'_>, before: &str, limit: i64) -> Result<i64> {
    let mut chosen = tx.prepare(&format!(
        "SELECT id FROM api_keys WHERE {ENDED} ORDER BY id LIMIT ?2"
    ))?;
    let ids = chosen
        .query_map(params![before, limit], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for id in &ids {
        folders::remove_reports_of(tx, "key", id)?;
        tx.execute("DELETE FROM api_key_sources WHERE key_id = ?1", [id])?;
        tx.execute("DELETE FROM api_keys WHERE id = ?1", [id])?;
    }
    Ok(ids.len() as i64)
}
