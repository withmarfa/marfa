//! The log of what writes announce. An entry goes in with the write it tells of and holds
//! what a later stream sends without reading a row that may have changed since.

mod expiry;
mod frame;
mod page;
mod stream;

use marfa_rules::query::list_entry;
use rusqlite::{Transaction, params};
use serde_json::json;

use super::App;
use super::access::Caller;
use super::items::reading;
use super::query::judge_type;
use super::refusal::{Refusal, Result};

pub use expiry::expire;
pub use frame::Filter;
pub use stream::{Hangup, Opening, PING, Viewer, Viewers, open};

/// Judge each entry's syntax and access before proceeding to the next.
pub async fn judge_types(app: &App, caller: &Caller, entries: Vec<String>) -> Result<()> {
    reading(app, caller, move |read| {
        entries.iter().try_for_each(|entry| {
            list_entry(entry).map_err(|error| {
                Refusal::validation(error.message.clone())
                    .with_detail("field", "type")
                    .with_detail(
                        "errors",
                        json!([{ "path": "type", "message": error.message }]),
                    )
            })?;
            judge_type(read, entry)
        })
    })
    .await
}

/// The stored payload precedes subscriber filtering and frame decoration.
pub struct Event<'a> {
    pub event_type: &'static str,
    pub item_id: &'a str,
    pub type_id: &'a str,
    pub source: &'a str,
    pub payload: String,
}

/// Fan-out controls webhooks only; streams still read every event.
pub(super) fn append(
    tx: &Transaction<'_>,
    at: &str,
    fanout: bool,
    event: &Event<'_>,
) -> Result<()> {
    tx.execute(
        "INSERT INTO event_log (event_type, item_id, type, source, at, payload, fanout) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            event.event_type,
            event.item_id,
            event.type_id,
            event.source,
            at,
            event.payload,
            fanout
        ],
    )?;
    Ok(())
}
