use rusqlite::{Transaction, params};

use super::super::refusal::Result;

/// A device catching up reads the log as unbroken from its oldest id, so stop at the
/// first entry not older than `before`: an old entry behind a newer one stays.
pub fn expire(tx: &Transaction<'_>, before: &str, limit: i64) -> Result<i64> {
    let removed = tx.execute(
        "WITH head AS (SELECT id, at FROM event_log ORDER BY id LIMIT ?2) \
         DELETE FROM event_log \
         WHERE id <= (SELECT MAX(id) FROM head) \
         AND id < COALESCE((SELECT MIN(id) FROM head WHERE at >= ?1), \
                           (SELECT MAX(id) FROM event_log))",
        params![before, limit],
    )?;
    Ok(removed as i64)
}
