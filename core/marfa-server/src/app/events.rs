//! The log of what writes announce. An entry goes in with the write it tells of and holds
//! what a later stream sends without reading a row that may have changed since.

mod expiry;
mod frame;
mod page;
mod stream;

use rusqlite::{Transaction, params};

use super::App;
use super::access::Caller;
use super::items::reading;
use super::query::judge_type;
use super::refusal::Result;

pub use expiry::expire;
pub use frame::Filter;
pub use stream::{Opening, PING, Viewer, Viewers, open};

/// Refuses a type entry that names no type, or one the caller may not read.
pub async fn judge_types(app: &App, caller: &Caller, entries: Vec<String>) -> Result<()> {
    reading(app, caller, move |read| {
        entries.iter().try_for_each(|entry| judge_type(read, entry))
    })
    .await
}

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
