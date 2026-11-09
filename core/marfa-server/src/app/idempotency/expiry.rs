use rusqlite::{Transaction, params};

use super::super::clock::readable;
use super::super::refusal::Result;

pub fn expire(tx: &Transaction<'_>, before: &str, limit: i64) -> Result<i64> {
    let removed = tx.execute(
        &format!(
            "DELETE FROM idempotency_records WHERE (credential, idempotency_key) IN \
             (SELECT credential, idempotency_key FROM idempotency_records \
             WHERE {} AND created_at < ?1 ORDER BY created_at LIMIT ?2)",
            readable("created_at")
        ),
        params![before, limit],
    )?;
    Ok(removed as i64)
}
