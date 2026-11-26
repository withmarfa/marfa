//! Forgetting answered writes and discarding writes.

use super::attachments::BYTES_ABSENT;
use super::dead::effect_key;
use super::laying::put_back;
use super::marks::{item_held, pinned, unpin};
use super::meta::{meta_delete, meta_get, prefix_end};
use super::queue::{queued_write, read_writes};
use super::reach::{edge_write_ends, let_go_of_ends};
use super::rows::remove_item;
use super::stamps::{Owed, owe_read_back, settle_read_back};
use super::verdicts::{RECEIPT_PENDING, held_for, take_out};
use super::write_state::{
    READ_REVISION, REFUSED_WHEN_MOVED, RESENT_AT_VERSION, SENT_AS, SENT_AT_VERSION, SENT_SOURCE,
    forget_write_state,
};
use crate::error::CoreError;
use crate::model::{EdgeDraft, Subject, Verdict, WriteKind};
use rusqlite::{Connection, named_params, params};
use serde_json::{Map, Value};
use std::collections::HashSet;

/// Keeps releasable writes, refused content and uploads still needed by dependents.
pub fn forget_answered(conn: &Connection) -> Result<usize, CoreError> {
    forget_answered_inner(conn, None, None, true)
}

/// `forget_answered`, restricted to the rows named: every other answered row
/// stays, and an id that names no row, or one not answered, is ignored.
pub fn forget_answered_ids(conn: &Connection, ids: &[String]) -> Result<usize, CoreError> {
    if ids.is_empty() {
        return Ok(0);
    }
    let only = serde_json::to_string(ids)
        .map_err(|error| CoreError::Invalid(format!("the ids cannot be named: {error}")))?;
    forget_answered_inner(conn, Some(&only), None, true)
}

/// `forget_answered`, keeping every row `kept` names whatever its verdict.
pub fn forget_answered_except(
    conn: &Connection,
    kept: &HashSet<String>,
) -> Result<usize, CoreError> {
    let except = serde_json::to_string(kept)
        .map_err(|error| CoreError::Invalid(format!("the ids cannot be named: {error}")))?;
    forget_answered_inner(conn, None, Some(&except), true)
}

/// Whether the queue holds a write `forget_answered` may clear: one the
/// server answered, but a refused write that carried content, which leaves
/// only by `discard`. Read through the index on the verdict.
pub fn holds_clearable_answers(conn: &Connection) -> Result<bool, CoreError> {
    let free = content_free_kinds();
    Ok(conn.query_row(
        &format!(
            "SELECT EXISTS (SELECT 1 FROM queue
              WHERE verdict IN (?1, ?2, ?3) OR (verdict = ?4 AND kind IN ({free})))"
        ),
        [
            Verdict::Accepted.as_str(),
            Verdict::Merged.as_str(),
            Verdict::Conflicted.as_str(),
            Verdict::Refused.as_str(),
        ],
        |row| row.get(0),
    )?)
}

/// Whether the queue holds an edge create the server refused, through the
/// index on the verdict, so a drain with none reads nothing more for them.
pub(crate) fn holds_refused_edge_create(conn: &Connection) -> Result<bool, CoreError> {
    Ok(conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM queue
          WHERE verdict = 'refused' AND kind = 'create_edge' AND sent = 1)",
        [],
        |row| row.get(0),
    )?)
}

/// An edge create the server refused, and what it asked for.
pub(crate) struct RefusedEdgeCreate {
    pub id: String,
    seq: i64,
    edge_id: Option<String>,
    pub asked: EdgeDraft,
}

impl RefusedEdgeCreate {
    /// Whether the copy holds the edge asked for as the server last gave it,
    /// with everything the create carried. A row of the copy's own has version
    /// 0, and one with a write waiting or a read owed may not be the server's
    /// as it stands.
    pub(crate) fn satisfied_by_server(&self, conn: &Connection) -> Result<bool, CoreError> {
        let mut statement = conn.prepare_cached(
            "SELECT properties FROM edges AS edge
              WHERE from_id = ?1 AND edge_type = ?2 AND to_id = ?3 AND version > 0
                AND NOT EXISTS (SELECT 1 FROM queue AS write WHERE write.edge_id = edge.id
                      AND (write.verdict IS NULL OR write.verdict IN ('blocked', 'dead')))
                AND NOT EXISTS (SELECT 1 FROM read_backs AS owed
                      WHERE owed.subject = 'edge' AND owed.id = edge.id)",
        )?;
        let held = statement.query_map(
            params![self.asked.from_id, self.asked.edge_type, self.asked.to_id],
            |row| row.get::<_, String>(0),
        )?;
        for properties in held {
            if serde_json::from_str::<Map<String, Value>>(&properties?)
                .is_ok_and(|properties| carries(&properties, &self.asked.properties))
            {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// Whether a later create of the same edge carries everything this one
    /// did. An answer the server took says nothing yet of what the copy holds,
    /// and a dead create or one refused unsent has no answer to stand on. A
    /// later create can still leave unanswered, withdrawn or lost with its
    /// body. The file's line and flag still hold the request then, and a
    /// refused row is never sent again, so this row adds nothing to them.
    pub(crate) fn carried_by_later_create(&self, conn: &Connection) -> Result<bool, CoreError> {
        let mut statement = conn.prepare_cached(
            "SELECT payload FROM queue
              WHERE item_id = ?1 AND to_id = ?2 AND kind = 'create_edge' AND seq > ?3
                AND (verdict IS NULL OR verdict = 'blocked' OR (verdict = 'refused' AND sent = 1))",
        )?;
        let later = statement.query_map(
            params![self.asked.from_id, self.asked.to_id, self.seq],
            |row| row.get::<_, String>(0),
        )?;
        for payload in later {
            if EdgeDraft::from_payload(&payload?).is_ok_and(|(_, later)| {
                later.from_id == self.asked.from_id
                    && later.to_id == self.asked.to_id
                    && later.edge_type == self.asked.edge_type
                    && carries(&later.properties, &self.asked.properties)
            }) {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// Whether nothing still rests on this row: no write depends on or follows
    /// it, and no receipt or read is owed for it. Finding what depends on it
    /// reads the queue, so call this last.
    pub(crate) fn nothing_rests_on_it(&self, conn: &Connection) -> Result<bool, CoreError> {
        Ok(conn.query_row(
            "SELECT NOT EXISTS (SELECT 1 FROM meta WHERE key = 'receipt_pending/' || ?1)
                AND NOT EXISTS (SELECT 1 FROM read_backs WHERE subject = 'edge' AND id = ?2)
                AND NOT EXISTS (SELECT 1 FROM queue WHERE id <> ?1
                      AND (follows = ?1 OR instr(depends_on, ?1) > 0))",
            params![self.id, self.edge_id],
            |row| row.get(0),
        )?)
    }
}

/// Whether `held` holds each of `asked`'s properties with its value.
fn carries(held: &Map<String, Value>, asked: &Map<String, Value>) -> bool {
    asked
        .iter()
        .all(|(name, value)| held.get(name) == Some(value))
}

/// The edge creates the server refused, oldest first, through the index on
/// the verdict. One refused unsent has no answer from the server and may yet
/// be released, and one whose payload cannot be read asks for nothing this can
/// compare, so neither is among them.
pub(crate) fn refused_edge_creates(conn: &Connection) -> Result<Vec<RefusedEdgeCreate>, CoreError> {
    let mut statement = conn.prepare_cached(
        "SELECT id, seq, edge_id, payload FROM queue
          WHERE verdict = 'refused' AND kind = 'create_edge' AND sent = 1 ORDER BY seq",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, Option<String>>(2)?,
            row.get::<_, String>(3)?,
        ))
    })?;
    let mut refused = Vec::new();
    for row in rows {
        let (id, seq, edge_id, payload) = row?;
        if let Ok((_, asked)) = EdgeDraft::from_payload(&payload) {
            refused.push(RefusedEdgeCreate {
                id,
                seq,
                edge_id,
                asked,
            });
        }
    }
    Ok(refused)
}

/// `only` is a JSON array of the ids to clear, or `None` for any; `except` a
/// JSON array of the ids to keep, or `None` for none.
pub(super) fn forget_answered_inner(
    conn: &Connection,
    only: Option<&str>,
    except: Option<&str>,
    clean_effects: bool,
) -> Result<usize, CoreError> {
    let mut cleared = 0;
    loop {
        let pass = forget_answered_once(conn, only, except)?;
        if pass == 0 {
            if clean_effects {
                for prefix in [
                    "dead_effect/",
                    "chosen_tier/",
                    SENT_AS,
                    SENT_SOURCE,
                    SENT_AT_VERSION,
                    RESENT_AT_VERSION,
                    READ_REVISION,
                    REFUSED_WHEN_MOVED,
                    "cleared_time/",
                    "bytes_sent_again/",
                ] {
                    conn.execute(
                        "DELETE FROM main.meta
                          WHERE key >= :prefix AND key < :end
                            AND substr(key, length(:prefix) + 1) NOT IN (SELECT id FROM main.queue)
                            AND (:only IS NULL
                                 OR substr(key, length(:prefix) + 1) IN (SELECT value FROM json_each(:only)))",
                        named_params! { ":prefix": prefix, ":end": prefix_end(prefix), ":only": only },
                    )?;
                }
            }
            return Ok(cleared);
        }
        cleared += pass;
    }
}

fn forget_answered_once(
    conn: &Connection,
    only: Option<&str>,
    except: Option<&str>,
) -> Result<usize, CoreError> {
    let free = content_free_kinds();
    // Kept while an unanswered or releasable row names it, which would
    // otherwise wait on a write no drain can find.
    let unreleasable = conn.execute(
        &format!(
            "DELETE FROM queue
          WHERE NOT EXISTS (SELECT 1 FROM meta WHERE key = 'receipt_pending/' || queue.id)
            AND (:only IS NULL OR queue.id IN (SELECT value FROM json_each(:only)))
            AND (:except IS NULL OR queue.id NOT IN (SELECT value FROM json_each(:except)))
            AND verdict = :refused AND sent = 0 AND kind IN ({free})
            AND EXISTS (
              SELECT 1 FROM json_each(queue.depends_on) AS named
               WHERE named.value NOT IN (SELECT id FROM queue)
            )
            AND NOT EXISTS (
              SELECT 1 FROM queue AS waiting, json_each(waiting.depends_on) AS named
               WHERE named.value = queue.id
                 AND (waiting.verdict IS NULL OR waiting.verdict IN (:blocked, :dead))
            )"
        ),
        named_params! {
            ":only": only,
            ":except": except,
            ":refused": Verdict::Refused.as_str(),
            ":blocked": Verdict::Blocked.as_str(),
            ":dead": Verdict::Dead.as_str(),
        },
    )?;
    Ok(unreleasable
        + conn.execute(
            &format!(
                "DELETE FROM queue
          WHERE NOT EXISTS (SELECT 1 FROM meta WHERE key = 'receipt_pending/' || queue.id)
            AND (:only IS NULL OR queue.id IN (SELECT value FROM json_each(:only)))
            AND (:except IS NULL OR queue.id NOT IN (SELECT value FROM json_each(:except)))
            AND verdict IN (:accepted, :merged, :conflicted, :refused)
            AND NOT (verdict = :refused AND sent = 0)
            AND NOT (verdict = :refused AND kind NOT IN ({free}))
            AND NOT EXISTS (
              SELECT 1 FROM queue AS waiting
               WHERE (waiting.verdict IS NULL
                      OR waiting.verdict IN (:blocked, :dead)
                      OR (waiting.verdict = :refused AND waiting.sent = 0)
                      OR (waiting.verdict = :refused AND waiting.reason = :bytes_absent
                          AND queue.kind = :upload))
                 AND waiting.depends_on LIKE '%' || queue.id || '%'
            )"
            ),
            named_params! {
                ":only": only,
                ":except": except,
                ":accepted": Verdict::Accepted.as_str(),
                ":merged": Verdict::Merged.as_str(),
                ":conflicted": Verdict::Conflicted.as_str(),
                ":refused": Verdict::Refused.as_str(),
                ":blocked": Verdict::Blocked.as_str(),
                ":dead": Verdict::Dead.as_str(),
                ":bytes_absent": BYTES_ABSENT,
                ":upload": WriteKind::UploadBlob.as_str(),
            },
        )?)
}

/// The kinds `carries_content` does not name, as an SQL list. Named by what
/// carries nothing, so a kind this build does not know, held by an earlier
/// build's queue that it is counting, is kept as content.
fn content_free_kinds() -> String {
    WriteKind::ALL
        .into_iter()
        .filter(|kind| !kind.carries_content())
        .map(|kind| format!("'{}'", kind.as_str()))
        .collect::<Vec<_>>()
        .join(", ")
}

/// Takes a refused write out of the queue, the one way a refused write that
/// carried content leaves it. Answers `false` for a row not refused, or one a
/// write still waits on, which would then wait on nothing. A create refused
/// onto a row no read has found goes all the same, and the writes waiting on
/// it are refused unsent: each names a row the server never held. A row write
/// goes with every write of its batch, or none does. Call in a transaction.
pub fn discard(conn: &Connection, id: &str) -> Result<bool, CoreError> {
    let Some(row) = queued_write(conn, id)? else {
        return Err(CoreError::NotFound {
            server: None,
            code: "queued_write_not_found".into(),
            message: format!("{id} is not a write this queue holds"),
        });
    };
    if row.verdict != Some(Verdict::Refused) {
        return Ok(false);
    }
    let batch = crate::row_writes::batch_of(conn, id)?;
    if batch.len() > 1 {
        for write in &batch {
            let refused = queued_write(conn, write)?
                .is_some_and(|write| write.verdict == Some(Verdict::Refused));
            if !refused || !held_for(conn, write)?.is_empty() {
                return Ok(false);
            }
        }
        for write in batch.iter().rev() {
            conn.execute("DELETE FROM queue WHERE id = ?1", [write])?;
            meta_delete(conn, &effect_key(write))?;
            forget_write_state(conn, write)?;
        }
        return Ok(true);
    }
    let receipt = format!("receipt_pending/{id}");
    let landing = match meta_get(conn, &receipt)? {
        None => None,
        Some(shape) if row.kind == WriteKind::CreateItem => match shape.strip_prefix("land:") {
            Some(target) => Some(target.to_string()),
            None => return Ok(false),
        },
        Some(_) => return Ok(false),
    };
    let held = held_for(conn, id)?;
    let Some(target) = landing else {
        if !held.is_empty() {
            return Ok(false);
        }
        conn.execute("DELETE FROM queue WHERE id = ?1", [id])?;
        meta_delete(conn, &effect_key(id))?;
        forget_write_state(conn, id)?;
        return Ok(true);
    };
    take_out(conn, &row, &held, "discarded")?;
    meta_delete(conn, &receipt)?;
    if !read_of_row_owed_elsewhere(conn, &target)? {
        settle_read_back(conn, Subject::Item, &target)?;
    }
    // Only a read can say the server holds no such row, which is what lets a
    // pin go (`device/pin-refused-create`).
    if let Some(minted) = row.item_id.as_deref()
        && pinned(conn, minted)?
    {
        owe_read_back(
            conn,
            &Owed {
                subject: Subject::Item,
                id: minted.into(),
                from_id: None,
                edge_type: None,
                moved: false,
            },
        )?;
    }
    Ok(true)
}

/// The debt of a read carries no owner, so it stays wherever another write
/// could have owed it: one that names the row, another create landing on it,
/// or the copy's own row under that id, which a refusal may have put back.
pub(super) fn read_of_row_owed_elsewhere(conn: &Connection, id: &str) -> Result<bool, CoreError> {
    Ok(item_held(conn, id)?
        || conn.query_row(
            "SELECT EXISTS (SELECT 1 FROM queue WHERE item_id = ?1 OR to_id = ?1)
                 OR EXISTS (SELECT 1 FROM meta
                             WHERE key >= ?2 AND key < ?3 AND value = 'land:' || ?1)",
            params![id, RECEIPT_PENDING, prefix_end(RECEIPT_PENDING)],
            |row| row.get(0),
        )?)
}

/// Every write to the edge not accepted, refused ones included, leaves the
/// queue, and the copy is put back as it was beneath them. With `through`, a
/// queue id, only those queued no later than it leave. Answers the ids that
/// left.
pub fn withdraw_edge_writes(
    conn: &Connection,
    edge_id: &str,
    through: Option<&str>,
) -> Result<Vec<String>, CoreError> {
    let rows = read_writes(
        conn,
        "WHERE edge_id = ?1 AND (verdict IS NULL OR verdict IN (?2, ?3, ?4))
           AND (?5 IS NULL OR seq <= (SELECT seq FROM queue WHERE id = ?5))",
        params![
            edge_id,
            Verdict::Blocked.as_str(),
            Verdict::Refused.as_str(),
            Verdict::Dead.as_str(),
            through,
        ],
    )?;
    let mut ends = Vec::new();
    for row in &rows {
        ends.extend(edge_write_ends(conn, &row.id)?);
        conn.execute("DELETE FROM queue WHERE id = ?1", [&row.id])?;
        meta_delete(conn, &effect_key(&row.id))?;
        forget_write_state(conn, &row.id)?;
    }
    for row in &rows {
        put_back(conn, row)?;
    }
    ends.sort();
    ends.dedup();
    let_go_of_ends(conn, &ends)?;
    Ok(rows.into_iter().map(|row| row.id).collect())
}

pub fn forget_item(conn: &Connection, id: &str) -> Result<(), CoreError> {
    unpin(conn, id)?;
    forget_row(conn, id)
}

/// `forget_item`, keeping a pin.
pub(super) fn forget_row(conn: &Connection, id: &str) -> Result<(), CoreError> {
    remove_item(conn, id, "from_id = ?1 OR to_id = ?1", &[])?;
    Ok(())
}
