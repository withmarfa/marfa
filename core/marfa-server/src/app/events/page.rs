//! Reads of the event log, which a stream pages through in id order.

use rusqlite::{Row, Transaction, params};

use super::frame::Head;
use crate::app::refusal::Result;

/// Where the log stands in one snapshot.
pub(super) struct Bounds {
    /// The newest id, or 0 for a log that holds nothing.
    pub head: i64,
    pub oldest: Option<i64>,
}

/// Two subqueries, because `MAX` and `MIN` in one select scan the whole log, where each alone is one seek.
pub(super) fn bounds(tx: &Transaction<'_>) -> Result<Bounds> {
    Ok(tx.query_row(
        "SELECT (SELECT COALESCE(MAX(id), 0) FROM event_log), (SELECT MIN(id) FROM event_log)",
        [],
        |row| {
            Ok(Bounds {
                head: row.get(0)?,
                oldest: row.get(1)?,
            })
        },
    )?)
}

/// One row of the log. The payload is read only when asked for, so a row a stream withholds costs no more than its columns.
pub(super) struct Entry<'a, 'r> {
    pub id: i64,
    pub event_type: String,
    pub type_id: String,
    pub source: String,
    row: &'a Row<'r>,
}

impl Entry<'_, '_> {
    pub fn head(&self) -> Head<'_> {
        Head {
            id: self.id,
            event_type: &self.event_type,
            type_id: &self.type_id,
            source: &self.source,
        }
    }

    pub fn payload(&self) -> Result<String> {
        Ok(self.row.get(4)?)
    }
}

pub(super) enum Next {
    Continue,
    Stop,
}

/// Calls `each` for up to `limit` rows after `after`, oldest first, until it answers `Stop`.
pub(super) fn scan(
    tx: &Transaction<'_>,
    after: i64,
    limit: usize,
    mut each: impl FnMut(&Entry<'_, '_>) -> Result<Next>,
) -> Result<()> {
    let mut statement = tx.prepare_cached(
        "SELECT id, event_type, type, source, payload FROM event_log \
         WHERE id > ?1 ORDER BY id LIMIT ?2",
    )?;
    let mut rows = statement.query(params![after, limit as i64])?;
    while let Some(row) = rows.next()? {
        let entry = Entry {
            id: row.get(0)?,
            event_type: row.get(1)?,
            type_id: row.get(2)?,
            source: row.get(3)?,
            row,
        };
        if matches!(each(&entry)?, Next::Stop) {
            break;
        }
    }
    Ok(())
}
