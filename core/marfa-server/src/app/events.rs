//! The log of what writes announce. An entry goes in with the write it tells
//! of, and holds what a later stream sends without reading a row that may
//! have changed since.

use rusqlite::{Transaction, params};

use super::refusal::Result;

/// One entry. `payload` is the JSON a frame carries, as text, so the numbers
/// in an item's properties stay as they were stored.
pub struct Event<'a> {
    pub event_type: &'static str,
    pub item_id: &'a str,
    pub type_id: &'a str,
    pub source: &'a str,
    pub payload: String,
}

pub(super) fn append(tx: &Transaction<'_>, at: &str, event: &Event<'_>) -> Result<()> {
    tx.execute(
        "INSERT INTO event_log (event_type, item_id, type, source, at, payload) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            event.event_type,
            event.item_id,
            event.type_id,
            event.source,
            at,
            event.payload
        ],
    )?;
    Ok(())
}
