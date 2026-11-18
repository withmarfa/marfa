//! Marks that a row was purged or removed, and the pins that keep a row.

use super::meta::{meta_delete, meta_delete_under, meta_get, meta_set, meta_under, prefix_end};
use super::rows::WAITING;
use crate::error::CoreError;
use crate::model::{Subject, WriteKind};
use rusqlite::{Connection, OptionalExtension, params};

/// The start of the meta key that remembers a pinned row's purge.
pub(crate) const PURGED_PIN: &str = "purged_pin/";

pub(super) fn purged_key(id: &str) -> String {
    format!("{PURGED_PIN}{id}")
}

pub fn purged(conn: &Connection, id: &str) -> Result<bool, CoreError> {
    Ok(meta_get(conn, &purged_key(id))?.is_some())
}

pub fn forget_purged(conn: &Connection, id: &str) -> Result<(), CoreError> {
    meta_delete(conn, &purged_key(id))
}

/// The start of the meta key, `removal/item/<id>` or `removal/edge/<id>`,
/// of a removal this device sent: `sent` while it is out or waits, then
/// `accepted` once the server takes it, until the copy reads the event of the
/// removal or is filled again. Every event before that one is older than the
/// removal (`device/deleted-stays-gone`).
const REMOVAL: &str = "removal/";

const REMOVAL_SENT: &str = "sent";

const REMOVAL_ACCEPTED: &str = "accepted";

fn removal_key(subject: Subject, id: &str) -> String {
    let subject = match subject {
        Subject::Item => "item",
        Subject::Edge => "edge",
    };
    format!("{REMOVAL}{subject}/{id}")
}

/// Before the removal can reach the server: the event of a removal read
/// meanwhile takes the mark away, which tells `removal_accepted` the copy is
/// already past it. An `accepted` mark stays as it is, since the event of
/// that removal is still ahead whatever becomes of this one.
pub fn removal_sent(conn: &Connection, subject: Subject, id: &str) -> Result<(), CoreError> {
    let key = removal_key(subject, id);
    if meta_get(conn, &key)?.as_deref() != Some(REMOVAL_ACCEPTED) {
        meta_set(conn, &key, REMOVAL_SENT)?;
    }
    Ok(())
}

pub fn removal_accepted(conn: &Connection, subject: Subject, id: &str) -> Result<(), CoreError> {
    let key = removal_key(subject, id);
    if meta_get(conn, &key)?.as_deref() == Some(REMOVAL_SENT) {
        meta_set(conn, &key, REMOVAL_ACCEPTED)?;
    }
    Ok(())
}

/// A removal refused, withdrawn or never answered, which leaves the row the
/// server's to tell of. An `accepted` mark belongs to an earlier removal.
pub fn removal_unsent(conn: &Connection, subject: Subject, id: &str) -> Result<(), CoreError> {
    let key = removal_key(subject, id);
    if meta_get(conn, &key)?.as_deref() == Some(REMOVAL_SENT) {
        meta_delete(conn, &key)?;
    }
    Ok(())
}

/// The event of the removal was read: every event after it is newer.
pub fn removal_read(conn: &Connection, subject: Subject, id: &str) -> Result<(), CoreError> {
    meta_delete(conn, &removal_key(subject, id))
}

/// The start of the meta key `removing/<id>` of an item a trash or a purge
/// this device has out at the server, whose value names which. In meta rather
/// than in memory so that `enqueue` reads it under the lock of the write it
/// refuses; a temporary table would not do, since a change of `temp_store`
/// drops them. Every key goes when a writer opens the store.
const REMOVING: &str = "removing/";

/// Held for every item, by a trash whose preview cut what it takes.
pub(crate) const EVERY_ITEM: &str = "*";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Removing {
    Trash,
    Purge,
}

impl Removing {
    fn as_str(self) -> &'static str {
        match self {
            Removing::Trash => "trash",
            Removing::Purge => "purge",
        }
    }
}

fn removing_key(id: &str) -> String {
    format!("{REMOVING}{id}")
}

/// The item, of `ids`, that a removal already out holds, and which removal.
fn removing_of(conn: &Connection, ids: &[String]) -> Result<Option<(String, String)>, CoreError> {
    let held = meta_under(conn, REMOVING)?;
    for id in ids {
        let found = held
            .iter()
            .find(|(by_id, _)| id == EVERY_ITEM || by_id == id || by_id == EVERY_ITEM);
        if let Some((by_id, by)) = found {
            let named = if id == EVERY_ITEM { by_id } else { id };
            return Ok(Some((named.clone(), by.clone())));
        }
    }
    Ok(None)
}

fn being_removed(id: &str, by: &str) -> CoreError {
    let what = if id == EVERY_ITEM {
        "an item".to_string()
    } else {
        id.to_string()
    };
    let how = match by {
        "purge" => "purged",
        _ => "moved to the bin",
    };
    CoreError::Validation {
        server: None,
        code: ITEM_BEING_REMOVED.into(),
        message: format!(
            "{what} is being {how} on the server; try again once that has been answered"
        ),
        details: (id != EVERY_ITEM).then(|| Box::new(serde_json::json!({ "id": id }))),
    }
}

/// The code a write is refused with while a trash or a purge of its item is out.
pub(crate) const ITEM_BEING_REMOVED: &str = "item_being_removed";

/// Holds `ids` against new writes, refused where a removal already out holds one.
pub(crate) fn hold_removing(
    conn: &Connection,
    ids: &[String],
    by: Removing,
) -> Result<(), CoreError> {
    if let Some((id, held)) = removing_of(conn, ids)? {
        return Err(being_removed(&id, &held));
    }
    for id in ids {
        meta_set(conn, &removing_key(id), by.as_str())?;
    }
    Ok(())
}

pub(crate) fn release_removing(conn: &Connection, ids: &[String]) -> Result<(), CoreError> {
    for id in ids {
        meta_delete(conn, &removing_key(id))?;
    }
    Ok(())
}

/// No removal is out once a writer holds the store afresh.
pub(crate) fn forget_removing(conn: &Connection) -> Result<(), CoreError> {
    meta_delete_under(conn, REMOVING)
}

/// Refuses a write to an item a trash or a purge has out at the server: the
/// write would reach a row in the bin or gone.
pub(crate) fn refuse_removing(conn: &Connection, item: &str) -> Result<(), CoreError> {
    let held: Option<String> = conn
        .prepare_cached("SELECT value FROM meta WHERE key IN (?1, ?2) LIMIT 1")?
        .query_row(
            params![removing_key(item), removing_key(EVERY_ITEM)],
            |row| row.get(0),
        )
        .optional()?;
    match held {
        Some(by) => Err(being_removed(item, &by)),
        None => Ok(()),
    }
}

/// Whether the row has no held item, pin, answer mark or removal record.
pub fn holds_nothing_of(conn: &Connection, id: &str) -> Result<bool, CoreError> {
    Ok(conn
        .prepare_cached(
            "SELECT NOT (EXISTS (SELECT 1 FROM items WHERE id = ?1)
                      OR EXISTS (SELECT 1 FROM pins WHERE item_id = ?1)
                      OR EXISTS (SELECT 1 FROM meta WHERE key IN ('item_listed/' || ?1, ?2)))",
        )?
        .query_row([id, &removal_key(Subject::Item, id)], |row| row.get(0))?)
}

/// Whether an event naming the row or edge is from before a removal the
/// server accepted.
pub fn removed(conn: &Connection, subject: Subject, id: &str) -> Result<bool, CoreError> {
    Ok(meta_get(conn, &removal_key(subject, id))?.as_deref() == Some(REMOVAL_ACCEPTED))
}

/// A copy filled from the first page holds what the server holds after every
/// removal it accepted. An edge delete still waiting keeps its mark.
pub fn forget_removals(conn: &Connection) -> Result<(), CoreError> {
    conn.execute(
        &format!(
            "DELETE FROM meta
              WHERE key >= ?1 AND key < ?2
                AND NOT (value = ?3 AND key IN (
                  SELECT ?4 || edge_id FROM queue
                   WHERE kind = ?5 AND edge_id IS NOT NULL AND {WAITING}))"
        ),
        params![
            REMOVAL,
            prefix_end(REMOVAL),
            REMOVAL_SENT,
            removal_key(Subject::Edge, ""),
            WriteKind::DeleteEdge.as_str(),
        ],
    )?;
    Ok(())
}

/// Whether it was not pinned already.
pub fn pin(conn: &Connection, id: &str) -> Result<bool, CoreError> {
    // A pin asked for again is somebody's own, which the body rule's release
    // must not take.
    conn.execute("DELETE FROM body_pins WHERE item_id = ?1", [id])?;
    let changed = conn.execute("INSERT OR IGNORE INTO pins (item_id) VALUES (?1)", [id])? > 0;
    if changed {
        crate::reach::pins_changed(conn)?;
    }
    Ok(changed)
}

/// Whether it was pinned.
pub fn unpin(conn: &Connection, id: &str) -> Result<bool, CoreError> {
    let changed = conn.execute("DELETE FROM pins WHERE item_id = ?1", [id])? > 0;
    if changed {
        crate::reach::pins_changed(conn)?;
    }
    Ok(changed)
}

pub fn pinned(conn: &Connection, id: &str) -> Result<bool, CoreError> {
    Ok(conn
        .query_row("SELECT 1 FROM pins WHERE item_id = ?1", [id], |_| Ok(()))
        .optional()?
        .is_some())
}

pub fn pins(conn: &Connection) -> Result<Vec<String>, CoreError> {
    let mut statement = conn.prepare("SELECT item_id FROM pins ORDER BY item_id")?;
    let rows = statement.query_map([], |row| row.get(0))?;
    Ok(rows.collect::<Result<Vec<String>, _>>()?)
}

pub fn item_held(conn: &Connection, id: &str) -> Result<bool, CoreError> {
    Ok(conn
        .query_row("SELECT 1 FROM items WHERE id = ?1", [id], |_| Ok(()))
        .optional()?
        .is_some())
}
