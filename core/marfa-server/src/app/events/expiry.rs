use rusqlite::{Transaction, params};

use super::super::clock::{Unread, readable};
use super::super::refusal::Result;

pub const UNREAD: Unread<'static> = Unread {
    table: "event_log",
    time: "at",
    scope: "1",
};

/// Retain an unbroken suffix from the first event that is recent or whose time does not read,
/// including every event not yet scheduled for webhooks.
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
        &format!(
            "WITH head AS (SELECT id, at FROM event_log ORDER BY id LIMIT ?2) \
             DELETE FROM event_log \
             WHERE id <= (SELECT MAX(id) FROM head) \
             AND id <= ?3 \
             AND id < COALESCE((SELECT MIN(id) FROM head WHERE at >= ?1 OR NOT {}), \
                               (SELECT MAX(id) FROM event_log))",
            readable("at")
        ),
        params![before, limit, scheduled],
    )?;
    Ok(removed as i64)
}
