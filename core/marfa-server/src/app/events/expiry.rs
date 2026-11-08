use rusqlite::{Transaction, params};

use super::super::refusal::Result;

/// Retain an unbroken suffix, including every event not yet scheduled for webhooks.
pub fn expire(
    tx: &Transaction<'_>,
    before: &str,
    limit: i64,
    scheduled: Option<i64>,
) -> Result<i64> {
    let Some(scheduled) = scheduled else {
        return Ok(0);
    };
    let removed = tx.execute(
        "WITH head AS (SELECT id, at FROM event_log ORDER BY id LIMIT ?2) \
         DELETE FROM event_log \
         WHERE id <= (SELECT MAX(id) FROM head) \
         AND id <= ?3 \
         AND id < COALESCE((SELECT MIN(id) FROM head WHERE at >= ?1), \
                           (SELECT MAX(id) FROM event_log))",
        params![before, limit, scheduled],
    )?;
    Ok(removed as i64)
}
