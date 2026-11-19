//! What tells a copy that its server was restored to an earlier point, and
//! what the copy held when it was: the receipts of writes the server took,
//! the event the copy last took, and the rows set aside until a hydration has
//! compared them with what the server holds now.

use super::Cached;
use super::queue::{untaken_create_for_edge, untaken_creates_for_item};
use super::stamps::{beneath_edge, beneath_item};
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
    pub(crate) removal: bool,
    pub(crate) answered_at: i64,
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

/// Keeps what the server said it holds after taking `row`: the version its
/// answer names, or for a removal the version the removal was made over.
/// A tag or extension write answers no version, so it keeps none.
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
        ))
    };
    let (subject, id, version, removal) = match row.kind {
        WriteKind::CreateItem
        | WriteKind::UpdateItem
        | WriteKind::RestoreItem
        | WriteKind::TransitionItem => match named("item") {
            Some((id, version)) => (Subject::Item, id, Some(version), false),
            None => return Ok(()),
        },
        WriteKind::CreateEdge | WriteKind::UpdateEdge => match named("edge") {
            Some((id, version)) => (Subject::Edge, id, Some(version), false),
            None => return Ok(()),
        },
        WriteKind::DeleteItem => match (&row.item_id, row.base_version) {
            (Some(id), Some(version)) => (Subject::Item, id.clone(), Some(version), true),
            _ => return Ok(()),
        },
        WriteKind::DeleteEdge => match &row.edge_id {
            Some(id) => (Subject::Edge, id.clone(), None, true),
            None => return Ok(()),
        },
        _ => return Ok(()),
    };
    let now = now_millis();
    conn.prepare_cached("DELETE FROM answer_receipts WHERE answered_at < ?1")?
        .execute([now.saturating_sub(RECEIPTS_KEPT_MILLIS)])?;
    conn.prepare_cached(
        "INSERT INTO answer_receipts (write_id, subject, id, version, removal, answered_at, seen)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0)
         ON CONFLICT (write_id) DO UPDATE SET
           subject = excluded.subject, id = excluded.id, version = excluded.version,
           removal = excluded.removal, answered_at = excluded.answered_at, seen = 0",
    )?
    .execute(params![
        row.id,
        subject_name(subject),
        id,
        version,
        removal,
        now
    ])?;
    Ok(())
}

/// What the stream carried settles the receipts it shows the server holds: a
/// change at a receipt's version or later, or a removal undone since.
pub(crate) fn receipts_seen(
    conn: &Connection,
    kind: &str,
    payload: &EventPayload,
) -> Result<(), CoreError> {
    let (subject, id, version) = match (&payload.item, &payload.edge) {
        (Some(item), _) => (Subject::Item, item.id.as_str(), item.version),
        (None, Some(edge)) => (Subject::Edge, edge.id.as_str(), edge.version),
        (None, None) => return Ok(()),
    };
    let gone = kind == "item.purged" || kind == "edge.deleted";
    conn.prepare_cached(
        "DELETE FROM answer_receipts
          WHERE subject = ?1 AND id = ?2 AND removal = 0 AND (?4 OR version <= ?3)",
    )?
    .execute(params![subject_name(subject), id, version, gone])?;
    // A removal is seen by an event made after it, and kept: a restore that
    // undoes it is found when the comparison reads the server.
    conn.prepare_cached(
        "UPDATE answer_receipts SET seen = 1
          WHERE subject = ?1 AND id = ?2 AND removal = 1 AND seen = 0
            AND (?4 OR version IS NULL OR version < ?3)",
    )?
    .execute(params![subject_name(subject), id, version, gone])?;
    Ok(())
}

fn receipts_where(
    conn: &Connection,
    clause: &str,
    bound: impl rusqlite::Params,
) -> Result<Vec<Receipt>, CoreError> {
    let mut statement = conn.prepare_cached(&format!(
        "SELECT write_id, subject, id, version, removal, answered_at
           FROM answer_receipts {clause}"
    ))?;
    let rows = statement
        .query_map(bound, |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<i64>>(3)?,
                row.get::<_, bool>(4)?,
                row.get::<_, i64>(5)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    rows.into_iter()
        .map(|(write_id, subject, id, version, removal, answered_at)| {
            Ok(Receipt {
                write_id,
                subject: subject_named(&subject)?,
                id,
                version,
                removal,
                answered_at,
            })
        })
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
    let mut latest: Vec<Receipt> = Vec::new();
    for receipt in receipts_where(
        conn,
        "WHERE removal = 1 AND answered_at >= ?1 ORDER BY answered_at DESC",
        [floor],
    )? {
        if !latest
            .iter()
            .any(|kept| kept.subject == receipt.subject && kept.id == receipt.id)
        {
            latest.push(receipt);
        }
    }
    Ok(latest)
}

/// A receipt the server was read to hold: a change is let go, and a removal
/// kept as seen.
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
    let edges: Vec<(String, String, String)> = conn
        .prepare("SELECT id, from_id, to_id FROM edges")?
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
        .collect::<Result<_, _>>()?;
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
        let mut item = testing::note(id, "t", "b", "2026-11-19T10:00:00.000Z");
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

        // An event at an earlier version is not the one the write made.
        receipts_seen(&conn, "item.updated", &event("a", 1)).unwrap();
        receipts_seen(&conn, "item.updated", &event("b", 4)).unwrap();
        assert_eq!(unseen(&conn).len(), 2);

        receipts_seen(&conn, "item.updated", &event("a", 2)).unwrap();
        receipts_seen(&conn, "item.trashed", &event("b", 5)).unwrap();
        assert_eq!(unseen(&conn), vec![]);
        // The removal is still kept for a comparison to find.
        let removals = removal_receipts(&conn).unwrap();
        assert_eq!(
            removals.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
            ["b"]
        );
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
