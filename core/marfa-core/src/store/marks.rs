//! Marks that a row was purged or removed, and the pins that keep a row.

use super::Cached;
use super::meta::{meta_delete, meta_get, meta_set, prefix_end};
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
    conn.execute_cached("DELETE FROM body_pins WHERE item_id = ?1", [id])?;
    let changed =
        conn.execute_cached("INSERT OR IGNORE INTO pins (item_id) VALUES (?1)", [id])? > 0;
    if changed {
        crate::reach::pins_changed(conn)?;
    }
    Ok(changed)
}

/// Whether it was pinned.
pub fn unpin(conn: &Connection, id: &str) -> Result<bool, CoreError> {
    let changed = conn.execute_cached("DELETE FROM pins WHERE item_id = ?1", [id])? > 0;
    if changed {
        crate::reach::pins_changed(conn)?;
    }
    Ok(changed)
}

pub fn pinned(conn: &Connection, id: &str) -> Result<bool, CoreError> {
    Ok(conn
        .query_row_cached("SELECT 1 FROM pins WHERE item_id = ?1", [id], |_| Ok(()))
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
        .query_row_cached("SELECT 1 FROM items WHERE id = ?1", [id], |_| Ok(()))
        .optional()?
        .is_some())
}
