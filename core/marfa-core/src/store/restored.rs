//! What tells a copy that its server was restored to an earlier point, and
//! what the copy held when it was: the receipts of writes the server took,
//! the event the copy last took, and the rows set aside until a hydration has
//! compared them with what the server holds now.

use std::collections::HashSet;

use super::Cached;
use super::queue::{untaken_create_for_edge, untaken_creates_for_item};
use super::stamps::{Stamp, beneath_edge, beneath_item, stamp};
use super::time::now_millis;
use crate::error::CoreError;
use crate::model::{Edge, Item, QueuedWrite, Subject, WriteKind};
use crate::wire::EventPayload;
use rusqlite::{Connection, OptionalExtension, params};

/// How long a receipt is kept after its answer, so a restore made later still
/// finds a removal the person made.
pub(crate) const RECEIPTS_KEPT_MILLIS: i64 = 30 * 24 * 60 * 60 * 1000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Receipt {
    pub(crate) write_id: String,
    pub(crate) subject: Subject,
    pub(crate) id: String,
    pub(crate) version: Option<i64>,
    /// The server's time on the row the answer named, or for a removal on
    /// the event that showed it.
    pub(crate) updated_at: Option<String>,
    pub(crate) removal: bool,
    pub(crate) answered_at: i64,
}

impl Receipt {
    /// The version and time it holds the server to, where it names a version.
    pub(crate) fn stamp(&self) -> Option<Stamp> {
        Some(Stamp {
            version: self.version?,
            // A time that does not read leaves the version alone to order.
            updated_at: self.updated_at.clone().unwrap_or_default(),
        })
    }
}

fn subject_name(subject: Subject) -> &'static str {
    match subject {
        Subject::Item => "item",
        Subject::Edge => "edge",
    }
}

fn subject_named(name: &str) -> Result<Subject, CoreError> {
    match name {
        "item" => Ok(Subject::Item),
        "edge" => Ok(Subject::Edge),
        other => Err(CoreError::Store(format!(
            "a receipt names {other:?}, which is no subject"
        ))),
    }
}

/// Keeps what the server said it holds after taking `row`: the version and
/// time its answer names, or for a removal the version the removal was made
/// over. A tag or extension write answers no version, so it keeps none.
pub(crate) fn keep_receipt(
    conn: &Connection,
    row: &QueuedWrite,
    answer: Option<&str>,
) -> Result<(), CoreError> {
    let answered = answer.and_then(|body| serde_json::from_str::<serde_json::Value>(body).ok());
    let named = |key: &str| {
        let row = answered.as_ref()?.get(key)?;
        Some((
            row.get("id")?.as_str()?.to_string(),
            row.get("version")?.as_i64()?,
            row.get("updated_at")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string),
        ))
    };
    let (subject, id, version, updated_at, removal) = match row.kind {
        WriteKind::CreateItem
        | WriteKind::UpdateItem
        | WriteKind::RestoreItem
        | WriteKind::TransitionItem => match named("item") {
            Some((id, version, at)) => (Subject::Item, id, Some(version), at, false),
            None => return Ok(()),
        },
        WriteKind::CreateEdge | WriteKind::UpdateEdge => match named("edge") {
            Some((id, version, at)) => (Subject::Edge, id, Some(version), at, false),
            None => return Ok(()),
        },
        WriteKind::DeleteItem => match (&row.item_id, row.base_version) {
            (Some(id), Some(version)) => (Subject::Item, id.clone(), Some(version), None, true),
            _ => return Ok(()),
        },
        WriteKind::DeleteEdge => match &row.edge_id {
            Some(id) => (Subject::Edge, id.clone(), None, None, true),
            None => return Ok(()),
        },
        _ => return Ok(()),
    };
    let now = now_millis();
    let_go_of_old(conn, now)?;
    if row.kind == WriteKind::RestoreItem {
        // The person took the item back out of the bin, so a removal made
        // before is not put back.
        conn.prepare_cached(
            "DELETE FROM answer_receipts WHERE subject = ?1 AND id = ?2 AND removal = 1",
        )?
        .execute(params![subject_name(subject), id])?;
    }
    keep(
        conn,
        &row.id,
        subject,
        &id,
        version,
        updated_at.as_deref(),
        removal,
        now,
    )
}

#[allow(clippy::too_many_arguments)]
fn keep(
    conn: &Connection,
    write_id: &str,
    subject: Subject,
    id: &str,
    version: Option<i64>,
    updated_at: Option<&str>,
    removal: bool,
    now: i64,
) -> Result<(), CoreError> {
    conn.prepare_cached(
        "INSERT INTO answer_receipts (write_id, subject, id, version, updated_at, removal, answered_at, seen)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0)
         ON CONFLICT (write_id) DO UPDATE SET
           subject = excluded.subject, id = excluded.id, version = excluded.version,
           updated_at = excluded.updated_at, removal = excluded.removal,
           answered_at = excluded.answered_at, seen = 0",
    )?
    .execute(params![
        write_id,
        subject_name(subject),
        id,
        version,
        updated_at,
        removal,
        now
    ])?;
    Ok(())
}

fn let_go_of_old(conn: &Connection, now: i64) -> Result<(), CoreError> {
    conn.prepare_cached("DELETE FROM answer_receipts WHERE answered_at < ?1")?
        .execute([now.saturating_sub(RECEIPTS_KEPT_MILLIS)])?;
    Ok(())
}

/// Keeps a row the server gave the copy, which a read after a refusal found
/// missing, as a change with no version: the stream shows it purged, or the
/// check after the stream finds the server has lost it. `false` where the
/// copy holds no row the server gave, which nothing then keeps.
pub(crate) fn keep_missing(
    conn: &Connection,
    subject: Subject,
    id: &str,
) -> Result<bool, CoreError> {
    if !server_gave(conn, subject, id)? {
        return Ok(false);
    }
    let now = now_millis();
    let_go_of_old(conn, now)?;
    let write_id = format!("missing {} {id}", subject_name(subject));
    keep(conn, &write_id, subject, id, None, None, false, now)?;
    Ok(true)
}

/// Whether the copy holds `id` as the server gave it: at a version the
/// server answered, beneath any writes waiting on it, and with no create of
/// it waiting to be sent. A row this device removed, or asked to, is not:
/// the removal answers for its absence.
pub(crate) fn server_gave(
    conn: &Connection,
    subject: Subject,
    id: &str,
) -> Result<bool, CoreError> {
    let (removal, back, column) = match subject {
        Subject::Item => (WriteKind::DeleteItem, WriteKind::RestoreItem, "item_id"),
        Subject::Edge => (WriteKind::DeleteEdge, WriteKind::CreateEdge, "edge_id"),
    };
    // Any answer to the removal, or none yet: a removal taken also leaves
    // nothing for a read to find, and one refused as gone found nothing.
    let removing = conn
        .prepare_cached(&format!(
            "SELECT 1 FROM queue AS removal
              WHERE removal.kind = ?1 AND removal.{column} = ?2
                AND NOT EXISTS (
                  SELECT 1 FROM queue AS later
                   WHERE later.kind = ?3 AND later.{column} = ?2 AND later.seq > removal.seq)
              LIMIT 1"
        ))?
        .query_row(params![removal.as_str(), id, back.as_str()], |_| Ok(()))
        .optional()?
        .is_some();
    if removing || super::marks::removal_marked(conn, subject, id)? {
        return Ok(false);
    }
    let beneath = match subject {
        Subject::Item => {
            if !untaken_creates_for_item(conn, id)?.is_empty() {
                return Ok(false);
            }
            beneath_item(conn, id)?.map(|item| item.version)
        }
        Subject::Edge => {
            if !untaken_create_for_edge(conn, id)?.is_empty() {
                return Ok(false);
            }
            beneath_edge(conn, id)?.map(|edge| edge.version)
        }
    };
    let version = match beneath {
        Some(version) => Some(version),
        None => stamp(conn, subject, id)?.map(|held| held.version),
    };
    Ok(version.is_some_and(|version| version > 0))
}

/// What the stream carried settles the receipts it shows the server holds: a
/// change at a receipt's version and time or later, or any event of a row
/// found missing. A removal is seen only by its own event, a move to the bin
/// or a purge, whose time it keeps, and is kept: a restore that undoes it is
/// found when the comparison reads the server.
pub(crate) fn receipts_seen(
    conn: &Connection,
    kind: &str,
    payload: &EventPayload,
) -> Result<(), CoreError> {
    let (subject, carried) = match (&payload.item, &payload.edge) {
        (Some(item), _) => (
            Subject::Item,
            (item.id.as_str(), item.version, item.updated_at.as_str()),
        ),
        (None, Some(edge)) => (
            Subject::Edge,
            (edge.id.as_str(), edge.version, edge.updated_at.as_str()),
        ),
        (None, None) => return Ok(()),
    };
    let (id, version, updated_at) = carried;
    let event = Stamp {
        version,
        updated_at: updated_at.to_string(),
    };
    let gone = kind == "item.purged" || kind == "edge.deleted";
    let removed = gone || kind == "item.trashed";
    for receipt in receipts_where(
        conn,
        "WHERE subject = ?1 AND id = ?2",
        params![subject_name(subject), id],
    )? {
        if receipt.removal {
            if removed && receipt.version.is_none_or(|over| version >= over) {
                conn.prepare_cached(
                    "UPDATE answer_receipts SET seen = 1, updated_at = ?2
                      WHERE write_id = ?1 AND seen = 0",
                )?
                .execute(params![receipt.write_id, updated_at])?;
            }
        } else if gone
            || receipt
                .stamp()
                .is_none_or(|taken| !taken.later_than(&event))
        {
            conn.prepare_cached("DELETE FROM answer_receipts WHERE write_id = ?1")?
                .execute([&receipt.write_id])?;
        }
    }
    Ok(())
}

fn receipts_where(
    conn: &Connection,
    clause: &str,
    bound: impl rusqlite::Params,
) -> Result<Vec<Receipt>, CoreError> {
    let mut statement = conn.prepare_cached(&format!(
        "SELECT write_id, subject, id, version, updated_at, removal, answered_at
           FROM answer_receipts {clause}"
    ))?;
    let rows = statement
        .query_map(bound, |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<i64>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, bool>(5)?,
                row.get::<_, i64>(6)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    rows.into_iter()
        .map(
            |(write_id, subject, id, version, updated_at, removal, answered_at)| {
                Ok(Receipt {
                    write_id,
                    subject: subject_named(&subject)?,
                    id,
                    version,
                    updated_at,
                    removal,
                    answered_at,
                })
            },
        )
        .collect()
}

/// The receipts the stream has not shown the server holds, answered before
/// `before`, in milliseconds on the store's clock.
pub(crate) fn unseen_receipts(conn: &Connection, before: i64) -> Result<Vec<Receipt>, CoreError> {
    receipts_where(
        conn,
        "WHERE seen = 0 AND answered_at >= ?1 AND answered_at < ?2 ORDER BY answered_at",
        [now_millis().saturating_sub(RECEIPTS_KEPT_MILLIS), before],
    )
}

/// Every removal still kept, the latest for each subject.
pub(crate) fn removal_receipts(conn: &Connection) -> Result<Vec<Receipt>, CoreError> {
    let floor = now_millis().saturating_sub(RECEIPTS_KEPT_MILLIS);
    let mut named: HashSet<(Subject, String)> = HashSet::new();
    Ok(receipts_where(
        conn,
        "WHERE removal = 1 AND answered_at >= ?1 ORDER BY answered_at DESC",
        [floor],
    )?
    .into_iter()
    .filter(|receipt| named.insert((receipt.subject, receipt.id.clone())))
    .collect())
}

/// A receipt the server was read to hold, or whose read said nothing of it:
/// a change is let go, and a removal kept as seen.
pub(crate) fn receipt_confirmed(conn: &Connection, receipt: &Receipt) -> Result<(), CoreError> {
    if receipt.removal {
        conn.prepare_cached("UPDATE answer_receipts SET seen = 1 WHERE write_id = ?1")?
            .execute([&receipt.write_id])?;
    } else {
        conn.prepare_cached("DELETE FROM answer_receipts WHERE write_id = ?1")?
            .execute([&receipt.write_id])?;
    }
    Ok(())
}

pub(crate) fn forget_receipts(conn: &Connection) -> Result<(), CoreError> {
    conn.execute("DELETE FROM answer_receipts", [])?;
    Ok(())
}

/// Lets go of the receipts that are not removals, once a comparison has
/// kept what they named or found the server holds it.
pub(crate) fn forget_change_receipts(conn: &Connection) -> Result<(), CoreError> {
    conn.execute("DELETE FROM answer_receipts WHERE removal = 0", [])?;
    conn.execute("UPDATE answer_receipts SET seen = 1 WHERE seen = 0", [])?;
    Ok(())
}

/// What tells one event from another at the same id: its kind, the row it
/// names and the version and time it carries, or a row batch and its time.
pub(crate) fn event_print(kind: &str, payload: &EventPayload) -> String {
    if let Some(rows) = &payload.rows {
        return format!(
            "{kind} {} {} {} {}",
            rows.item.id, rows.table, rows.batch, rows.last_activity_at
        );
    }
    if let Some(item) = &payload.item {
        return format!("{kind} {} {} {}", item.id, item.version, item.updated_at);
    }
    match &payload.edge {
        Some(edge) => format!("{kind} {} {} {}", edge.id, edge.version, edge.updated_at),
        None => kind.to_string(),
    }
}

/// Keeps `id` as the last event the copy took, with what it named.
pub(crate) fn set_anchor(conn: &Connection, id: &str, print: &str) -> Result<(), CoreError> {
    let Some(id) = crate::reach::cursor(id).and_then(|id| i64::try_from(id).ok()) else {
        return forget_anchor(conn);
    };
    conn.execute_cached(
        "INSERT INTO event_anchor (only, id, print) VALUES (1, ?1, ?2)
           ON CONFLICT (only) DO UPDATE SET id = excluded.id, print = excluded.print",
        params![id, print],
    )?;
    Ok(())
}

pub(crate) fn anchor(conn: &Connection) -> Result<Option<(u64, String)>, CoreError> {
    let held: Option<(i64, String)> = conn
        .query_row_cached("SELECT id, print FROM event_anchor", [], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .optional()?;
    Ok(held.and_then(|(id, print)| Some((u64::try_from(id).ok()?, print))))
}

pub(crate) fn forget_anchor(conn: &Connection) -> Result<(), CoreError> {
    conn.execute_cached("DELETE FROM event_anchor", [])?;
    Ok(())
}

/// Sets aside what the copy holds as the server last answered it, before the
/// copy is cleared: the row beneath any writes waiting on it, or the row
/// itself. A create still waiting is left out, since the queue keeps it, and
/// so is the edge such a create draws. So are a row a connector holds read
/// only, which this device did not make, and a `system.*` row, which no
/// item write makes. A row already set aside stays as it was first set aside.
pub(crate) fn hold_copy(conn: &Connection) -> Result<(), CoreError> {
    let ids: Vec<String> = conn
        .prepare("SELECT id FROM items WHERE read_only = 0 AND type NOT LIKE 'system.%'")?
        .query_map([], |row| row.get(0))?
        .collect::<Result<_, _>>()?;
    hold_items(conn, &ids)?;
    let edges: Vec<(String, String, String)> = conn
        .prepare("SELECT id, from_id, to_id FROM edges")?
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
        .collect::<Result<_, _>>()?;
    hold_edges(conn, edges)
}

/// Sets aside, as `hold_copy` does, only the rows `named` names.
pub(crate) fn hold_named(conn: &Connection, named: &[(Subject, String)]) -> Result<(), CoreError> {
    let mut ids = Vec::new();
    let mut edges = Vec::new();
    for (subject, id) in named {
        match subject {
            Subject::Item => {
                let held = conn
                    .prepare_cached(
                        "SELECT 1 FROM items
                          WHERE id = ?1 AND read_only = 0 AND type NOT LIKE 'system.%'",
                    )?
                    .query_row([id], |_| Ok(()))
                    .optional()?;
                if held.is_some() {
                    ids.push(id.clone());
                }
            }
            Subject::Edge => {
                if let Some(edge) = super::reads::edge_by_id(conn, id)? {
                    edges.push((edge.id, edge.from_id, edge.to_id));
                }
            }
        }
    }
    hold_items(conn, &ids)?;
    hold_edges(conn, edges)
}

fn hold_items(conn: &Connection, ids: &[String]) -> Result<(), CoreError> {
    for batch in ids.chunks(500) {
        for item in super::reads::items_by_ids(conn, batch)? {
            if !untaken_creates_for_item(conn, &item.id)?.is_empty() {
                continue;
            }
            let held = beneath_item(conn, &item.id)?.unwrap_or(item);
            hold(
                conn,
                Subject::Item,
                &held.id,
                &serde_json::to_string(&held)?,
            )?;
        }
    }
    Ok(())
}

fn hold_edges(conn: &Connection, edges: Vec<(String, String, String)>) -> Result<(), CoreError> {
    for (id, from_id, to_id) in edges {
        if !untaken_create_for_edge(conn, &id)?.is_empty()
            || !untaken_creates_for_item(conn, &from_id)?.is_empty()
            || !untaken_creates_for_item(conn, &to_id)?.is_empty()
        {
            continue;
        }
        let held = match beneath_edge(conn, &id)? {
            Some(edge) => edge,
            None => match super::reads::edge_by_id(conn, &id)? {
                Some(edge) => edge,
                None => continue,
            },
        };
        hold(conn, Subject::Edge, &id, &serde_json::to_string(&held)?)?;
    }
    Ok(())
}

/// The hashes the rows set aside name as their bytes, which the file cache
/// keeps until a comparison has queued their uploads or let them go.
pub(crate) fn held_bytes(conn: &Connection) -> Result<Vec<String>, CoreError> {
    Ok(conn
        .prepare_cached(
            "SELECT DISTINCT json_extract(row, '$.properties.blob_ref') FROM held_back
              WHERE subject = 'item' AND json_valid(row)
                AND json_type(row, '$.properties.blob_ref') = 'text'",
        )?
        .query_map([], |row| row.get(0))?
        .collect::<Result<_, _>>()?)
}

fn hold(conn: &Connection, subject: Subject, id: &str, row: &str) -> Result<(), CoreError> {
    conn.prepare_cached("INSERT OR IGNORE INTO held_back (subject, id, row) VALUES (?1, ?2, ?3)")?
        .execute(params![subject_name(subject), id, row])?;
    Ok(())
}

/// Whether rows are set aside that no comparison has read yet.
pub(crate) fn holds_back(conn: &Connection) -> Result<bool, CoreError> {
    Ok(conn
        .prepare_cached("SELECT 1 FROM held_back LIMIT 1")?
        .query_row([], |_| Ok(()))
        .optional()?
        .is_some())
}

pub(crate) fn held_back(conn: &Connection) -> Result<(Vec<Item>, Vec<Edge>), CoreError> {
    let mut statement = conn.prepare("SELECT subject, row FROM held_back ORDER BY subject, id")?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let (mut items, mut edges) = (Vec::new(), Vec::new());
    for (subject, row) in rows {
        match subject_named(&subject)? {
            Subject::Item => items.push(serde_json::from_str(&row)?),
            Subject::Edge => edges.push(serde_json::from_str(&row)?),
        }
    }
    Ok((items, edges))
}

/// Makes the write `id` wait on `depends_on`, all of it.
pub(crate) fn wait_on(conn: &Connection, id: &str, depends_on: &[String]) -> Result<(), CoreError> {
    conn.prepare_cached("UPDATE queue SET depends_on = ?2 WHERE id = ?1")?
        .execute(params![id, serde_json::to_string(depends_on)?])?;
    Ok(())
}

/// Makes a write sent for a row the server holds no longer unsent, under a
/// fresh key: the server holds nothing the write could have changed.
pub(crate) fn send_afresh(conn: &Connection, id: &str) -> Result<(), CoreError> {
    let sent: bool =
        conn.query_row_cached("SELECT sent FROM queue WHERE id = ?1", [id], |row| {
            row.get(0)
        })?;
    if sent {
        crate::row_writes::spend_key(conn, id)?;
        super::verdicts::mark_unsent(conn, id)?;
    }
    Ok(())
}

/// Lets the write `id` go without waiting on the write queued ahead of it on
/// its row.
pub(crate) fn follow_nothing(conn: &Connection, id: &str) -> Result<(), CoreError> {
    conn.prepare_cached("UPDATE queue SET follows = NULL WHERE id = ?1")?
        .execute([id])?;
    Ok(())
}

pub(crate) fn release_held_back(conn: &Connection) -> Result<(), CoreError> {
    conn.execute("DELETE FROM held_back", [])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{self, testing};

    fn queued(conn: &Connection, kind: WriteKind, id: &str, base: Option<i64>) -> QueuedWrite {
        store::enqueue(
            conn,
            &store::NewWrite {
                kind,
                item_id: Some(id),
                to_id: None,
                edge_id: None,
                namespace: None,
                tag: None,
                blob: None,
                base_version: base,
                payload: "{}",
                depends_on: &[],
            },
        )
        .unwrap()
    }

    fn event(id: &str, version: i64) -> EventPayload {
        event_at(id, version, "2026-11-19T10:00:00.000Z")
    }

    fn event_at(id: &str, version: i64, at: &str) -> EventPayload {
        let mut item = testing::note(id, "t", "b", at);
        item.version = version;
        EventPayload {
            event_type: "item.updated".into(),
            item: Some(item),
            ..EventPayload::default()
        }
    }

    fn unseen(conn: &Connection) -> Vec<(String, Option<i64>, bool)> {
        unseen_receipts(conn, i64::MAX)
            .unwrap()
            .into_iter()
            .map(|receipt| (receipt.id, receipt.version, receipt.removal))
            .collect()
    }

    #[test]
    fn a_receipt_is_kept_until_the_stream_shows_the_server_holds_it() {
        let conn = testing::conn();
        let update = queued(&conn, WriteKind::UpdateItem, "a", Some(1));
        keep_receipt(&conn, &update, Some(r#"{"item":{"id":"a","version":2}}"#)).unwrap();
        let delete = queued(&conn, WriteKind::DeleteItem, "b", Some(4));
        keep_receipt(&conn, &delete, None).unwrap();
        // A tag write answers no version to hold the server to.
        let tags = queued(&conn, WriteKind::ReplaceTags, "a", None);
        keep_receipt(&conn, &tags, Some(r#"{"tags":["x"]}"#)).unwrap();
        assert_eq!(
            unseen(&conn),
            vec![("a".into(), Some(2), false), ("b".into(), Some(4), true)]
        );

        // An event at an earlier version is not the one the write made, and
        // only the removal's own event shows the server took it, though any
        // other carries a later version.
        receipts_seen(&conn, "item.updated", &event("a", 1)).unwrap();
        receipts_seen(&conn, "item.updated", &event("b", 5)).unwrap();
        assert_eq!(unseen(&conn).len(), 2);

        receipts_seen(&conn, "item.updated", &event("a", 2)).unwrap();
        // A move to the bin keeps the version it was made over.
        receipts_seen(
            &conn,
            "item.trashed",
            &event_at("b", 4, "2026-11-19T11:00:00.000Z"),
        )
        .unwrap();
        assert_eq!(unseen(&conn), vec![]);
        // The removal is still kept for a comparison to find, with the time
        // of its event.
        let removals = removal_receipts(&conn).unwrap();
        assert_eq!(
            removals
                .iter()
                .map(|r| (r.id.as_str(), r.updated_at.as_deref()))
                .collect::<Vec<_>>(),
            [("b", Some("2026-11-19T11:00:00.000Z"))]
        );
    }

    #[test]
    fn a_change_at_the_same_version_is_seen_only_at_its_time_or_later() {
        let conn = testing::conn();
        let moved = queued(&conn, WriteKind::TransitionItem, "a", None);
        keep_receipt(
            &conn,
            &moved,
            Some(r#"{"item":{"id":"a","version":3,"updated_at":"2026-11-19T10:05:00.000Z"}}"#),
        )
        .unwrap();
        receipts_seen(
            &conn,
            "item.updated",
            &event_at("a", 3, "2026-11-19T10:00:00.000Z"),
        )
        .unwrap();
        assert_eq!(
            unseen(&conn).len(),
            1,
            "an earlier event at the version saw it"
        );
        receipts_seen(
            &conn,
            "item.transitioned",
            &event_at("a", 3, "2026-11-19T10:05:00.000Z"),
        )
        .unwrap();
        assert_eq!(unseen(&conn), vec![]);
    }

    #[test]
    fn a_move_out_of_the_bin_lets_go_of_the_removal_before_it() {
        let conn = testing::conn();
        let delete = queued(&conn, WriteKind::DeleteItem, "a", Some(2));
        keep_receipt(&conn, &delete, None).unwrap();
        // The witness: the removal is kept.
        assert_eq!(removal_receipts(&conn).unwrap().len(), 1);
        let restore = queued(&conn, WriteKind::RestoreItem, "a", None);
        keep_receipt(
            &conn,
            &restore,
            Some(r#"{"item":{"id":"a","version":2,"updated_at":"2026-11-19T10:05:00.000Z"}}"#),
        )
        .unwrap();
        assert!(removal_receipts(&conn).unwrap().is_empty());
        assert_eq!(unseen(&conn), vec![("a".into(), Some(2), false)]);
    }

    #[test]
    fn a_row_found_missing_is_kept_only_where_the_server_gave_it() {
        let conn = testing::conn();
        let mut given = testing::note("given", "t", "b", "2026-11-19T10:00:00.000Z");
        given.version = 3;
        store::upsert_item(&conn, &given, None, &Default::default()).unwrap();
        let mut made = testing::note("made", "t", "b", "2026-11-19T10:00:00.000Z");
        made.version = 0;
        store::upsert_item(&conn, &made, None, &Default::default()).unwrap();

        assert!(keep_missing(&conn, Subject::Item, "given").unwrap());
        assert!(!keep_missing(&conn, Subject::Item, "made").unwrap());
        assert!(!keep_missing(&conn, Subject::Item, "absent").unwrap());
        assert_eq!(unseen(&conn), vec![("given".into(), None, false)]);

        // Any event of the row shows the server holds it, or let it go.
        receipts_seen(&conn, "item.updated", &event("given", 1)).unwrap();
        assert_eq!(unseen(&conn), vec![]);
        keep_missing(&conn, Subject::Item, "given").unwrap();
        receipts_seen(&conn, "item.purged", &event("given", 3)).unwrap();
        assert_eq!(unseen(&conn), vec![]);
    }

    #[test]
    fn a_receipt_older_than_thirty_days_is_neither_read_nor_kept() {
        let conn = testing::conn();
        let update = queued(&conn, WriteKind::UpdateItem, "a", Some(1));
        keep_receipt(&conn, &update, Some(r#"{"item":{"id":"a","version":2}}"#)).unwrap();
        let delete = queued(&conn, WriteKind::DeleteItem, "b", Some(4));
        keep_receipt(&conn, &delete, None).unwrap();
        let old = now_millis() - RECEIPTS_KEPT_MILLIS - 1;
        conn.execute("UPDATE answer_receipts SET answered_at = ?1", [old])
            .unwrap();
        assert_eq!(unseen(&conn), vec![]);
        assert!(removal_receipts(&conn).unwrap().is_empty());

        let next = queued(&conn, WriteKind::UpdateItem, "c", Some(1));
        keep_receipt(&conn, &next, Some(r#"{"item":{"id":"c","version":2}}"#)).unwrap();
        let held: i64 = conn
            .query_row("SELECT count(*) FROM answer_receipts", [], |row| row.get(0))
            .unwrap();
        assert_eq!(held, 1, "the next receipt kept did not let the old ones go");
    }

    #[test]
    fn a_stream_opened_before_an_answer_does_not_read_its_receipt() {
        let conn = testing::conn();
        let opened = now_millis();
        let update = queued(&conn, WriteKind::UpdateItem, "a", Some(1));
        keep_receipt(&conn, &update, Some(r#"{"item":{"id":"a","version":2}}"#)).unwrap();
        conn.execute("UPDATE answer_receipts SET answered_at = ?1", [opened])
            .unwrap();
        assert!(unseen_receipts(&conn, opened).unwrap().is_empty());
        assert_eq!(unseen_receipts(&conn, opened + 1).unwrap().len(), 1);
    }

    /// With `MARFA_RECEIPT_BENCH_ROWS` set, keeps that many receipts, half of
    /// them removals, and prints what keeping one more, settling one from
    /// the stream and reading the removals cost. Run it in a release build:
    ///
    /// ```sh
    /// MARFA_RECEIPT_BENCH_ROWS=50000 cargo nextest run --release -p marfa-core --lib receipt_bench --no-capture
    /// ```
    #[test]
    fn receipt_bench_times_keeping_and_settling() {
        let rows: usize = std::env::var("MARFA_RECEIPT_BENCH_ROWS")
            .ok()
            .and_then(|rows| rows.parse().ok())
            .unwrap_or(500);
        let conn = testing::conn();
        let now = now_millis();
        {
            let mut insert = conn
                .prepare(
                    "INSERT INTO answer_receipts (write_id, subject, id, version, removal, answered_at, seen)
                     VALUES (?1, 'item', ?2, 2, ?3, ?4, 0)",
                )
                .unwrap();
            for index in 0..rows {
                insert
                    .execute(params![
                        format!("w{index}"),
                        format!("i{index}"),
                        index % 2 == 0,
                        now - i64::try_from(index).unwrap(),
                    ])
                    .unwrap();
            }
        }
        let calls = 200;
        let started = std::time::Instant::now();
        for index in 0..calls {
            let update = queued(&conn, WriteKind::UpdateItem, &format!("n{index}"), Some(1));
            keep_receipt(
                &conn,
                &update,
                Some(&format!(r#"{{"item":{{"id":"n{index}","version":2}}}}"#)),
            )
            .unwrap();
        }
        let kept = started.elapsed() / calls;
        let started = std::time::Instant::now();
        for index in 0..calls {
            receipts_seen(&conn, "item.updated", &event(&format!("i{index}"), 3)).unwrap();
        }
        let settled = started.elapsed() / calls;
        let started = std::time::Instant::now();
        let removals = removal_receipts(&conn).unwrap();
        let read = started.elapsed();
        assert_eq!(removals.len(), rows.div_ceil(2));
        println!(
            "{rows} receipts: keep one {kept:?}, settle one {settled:?}, read the removals {read:?}"
        );
    }

    #[test]
    fn an_anchor_keeps_the_print_of_the_event_it_names() {
        let conn = testing::conn();
        assert_eq!(anchor(&conn).unwrap(), None);
        let print = event_print("item.updated", &event("a", 2));
        set_anchor(&conn, "17", &print).unwrap();
        assert_eq!(anchor(&conn).unwrap(), Some((17, print.clone())));
        assert_ne!(print, event_print("item.updated", &event("a", 3)));
        assert_ne!(print, event_print("item.trashed", &event("a", 2)));
        forget_anchor(&conn).unwrap();
        assert_eq!(anchor(&conn).unwrap(), None);
    }
}
