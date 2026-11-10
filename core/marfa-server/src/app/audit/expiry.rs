use rusqlite::{Transaction, params};

use super::super::clock::{Unread, readable};
use super::super::refusal::Result;

pub const UNREAD: Unread<'static> = Unread {
    table: "audit_log",
    time: "created_at",
    scope: "1",
};

pub fn expire(tx: &Transaction<'_>, before: &str, limit: i64) -> Result<i64> {
    let removed = tx.execute(
        &format!(
            "DELETE FROM audit_log WHERE id IN (SELECT id FROM audit_log \
             WHERE {} AND created_at < ?1 ORDER BY created_at, id LIMIT ?2)",
            readable("created_at")
        ),
        params![before, limit],
    )?;
    Ok(removed as i64)
}
