use rusqlite::{Transaction, params};

use super::super::refusal::Result;

pub fn expire(tx: &Transaction<'_>, before: &str, limit: i64) -> Result<i64> {
    let removed = tx.execute(
        "DELETE FROM audit_log WHERE id IN (SELECT id FROM audit_log WHERE created_at < ?1 \
         ORDER BY created_at, id LIMIT ?2)",
        params![before, limit],
    )?;
    Ok(removed as i64)
}
