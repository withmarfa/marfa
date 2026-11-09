//! The webhook sender's reads of the log, which it walks once, in id order.

use rusqlite::{Row, Transaction, params};

use super::frame::Head;
use crate::app::refusal::Result;

/// The payload is read only when asked for, so an event that fans out to nobody costs its columns.
pub struct Logged<'a, 'r> {
    pub id: i64,
    pub event_type: String,
    pub type_id: String,
    pub source: String,
    pub fanout: bool,
    row: &'a Row<'r>,
}

impl Logged<'_, '_> {
    pub fn head(&self) -> Head<'_> {
        Head {
            id: self.id,
            event_type: &self.event_type,
            type_id: &self.type_id,
            source: &self.source,
        }
    }

    pub fn payload(&self) -> Result<String> {
        Ok(self.row.get(5)?)
    }
}

/// The newest id, or 0 for a log that holds nothing.
pub fn newest(tx: &Transaction<'_>) -> Result<i64> {
    Ok(
        tx.query_row("SELECT COALESCE(MAX(id), 0) FROM event_log", [], |row| {
            row.get(0)
        })?,
    )
}

/// How many entries the log holds with an id in `after + 1 ..= through`.
pub fn held_between(tx: &Transaction<'_>, after: i64, through: i64) -> Result<i64> {
    Ok(tx.query_row(
        "SELECT COUNT(*) FROM event_log WHERE id > ?1 AND id <= ?2",
        params![after, through],
        |row| row.get(0),
    )?)
}

/// Calls `each` for up to `limit` entries after `after`, oldest first, until it answers `false`.
pub fn walk(
    tx: &Transaction<'_>,
    after: i64,
    limit: usize,
    mut each: impl FnMut(&Logged<'_, '_>) -> Result<bool>,
) -> Result<()> {
    let mut statement = tx.prepare_cached(
        "SELECT id, event_type, type, source, fanout, payload FROM event_log \
         WHERE id > ?1 ORDER BY id LIMIT ?2",
    )?;
    let mut rows = statement.query(params![after, limit as i64])?;
    while let Some(row) = rows.next()? {
        let logged = Logged {
            id: row.get(0)?,
            event_type: row.get(1)?,
            type_id: row.get(2)?,
            source: row.get(3)?,
            fanout: row.get(4)?,
            row,
        };
        if !each(&logged)? {
            break;
        }
    }
    Ok(())
}
