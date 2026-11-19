//! A write's sending and verdict: marking it sent, the streaks that set it aside and releasing it.

use super::Cached;
use super::attachments::forget_bytes_sent_again;
use super::catalog::catalog_scope;
use super::dead::{
    DeadEffect, edit_fields, effect_key, learn_dead_effects, same_tag_subject, supersedes_dead,
    tag_targets,
};
use super::laying::{put_back, record_refusal, replaces_properties};
use super::marks::removal_accepted;
use super::meta::{META_INSTANCE_ID, meta_delete, meta_get, meta_keys, meta_set, meta_under};
use super::queue::{queued_write, queued_writes, read_writes, rows_reached_by};
use super::reach::{edge_write_ends, let_go_of_ends};
use super::removing::refuse_removing;
use super::rows::WAITING;
use super::time::{now_iso, now_millis};
use super::write_state::{cleared_time_key, forget_versions_named, forget_write_state, unsent};
use crate::error::CoreError;
use crate::model::{BlockedReason, QueuedWrite, Subject, Verdict, WriteKind};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;
use std::collections::{HashMap, HashSet};

/// Also fixed by the `refusals` `CHECK` in `schema.sql`. Raised above it,
/// SQLite refuses the write; lowered below it, nothing complains.
pub const CEILING: i64 = 5;

pub fn payload_of(conn: &Connection, id: &str) -> Result<String, CoreError> {
    conn.query_row_cached("SELECT payload FROM queue WHERE id = ?1", [id], |row| {
        row.get(0)
    })
    .optional()?
    .ok_or_else(|| CoreError::Store(format!("queued write {id} has no payload")))
}

pub struct Answered<'a> {
    pub verdict: Verdict,
    pub reason: Option<&'a str>,
    pub answer: Option<&'a str>,
    pub conflicted_copy_id: Option<&'a str>,
}

/// Marks the write sent and numbers the send, one past the highest number any
/// write holds, in the one statement. The order of sends is a number rather
/// than a time so a clock set back cannot reorder it.
pub fn mark_sent(conn: &Connection, id: &str) -> Result<(), CoreError> {
    conn.execute_cached(
        "UPDATE queue
            SET sent = 1,
                last_sent_seq = (SELECT COALESCE(MAX(last_sent_seq), 0) + 1 FROM queue)
          WHERE id = ?1",
        [id],
    )?;
    Ok(())
}

/// The number of the write's last send, or nothing for one never sent. The
/// lower number is the earlier send.
pub fn last_sent_seq(conn: &Connection, id: &str) -> Result<Option<i64>, CoreError> {
    Ok(conn
        .query_row_cached(
            "SELECT last_sent_seq FROM queue WHERE id = ?1",
            [id],
            |row| row.get(0),
        )
        .optional()?
        .flatten())
}

/// Only on an answer that proves the attempt was not applied anywhere.
pub fn mark_unsent(conn: &Connection, id: &str) -> Result<(), CoreError> {
    conn.execute_cached("UPDATE queue SET sent = 0 WHERE id = ?1", [id])?;
    Ok(())
}

pub fn record_verdict(
    conn: &Connection,
    id: &str,
    answered: &Answered<'_>,
) -> Result<(), CoreError> {
    catalog_scope(conn, |conn| record_verdict_inner(conn, id, answered))
}

fn record_verdict_inner(
    conn: &Connection,
    id: &str,
    answered: &Answered<'_>,
) -> Result<(), CoreError> {
    let already_accepted =
        queued_write(conn, id)?.is_some_and(|row| row.verdict == Some(Verdict::Accepted));
    let ends = edge_write_ends(conn, id)?;
    let changed = conn.execute_cached(
        "UPDATE queue
            SET verdict = ?2, reason = ?3, answer = ?4,
                conflicted_copy_id = ?5, answered_at = ?6,
                environmental_streak = CASE WHEN ?7 THEN environmental_streak ELSE 0 END,
                environmental_since = CASE WHEN ?7 THEN environmental_since ELSE NULL END,
                environmental_last = CASE WHEN ?7 THEN environmental_last ELSE NULL END,
                last_failure = CASE WHEN ?7 THEN last_failure ELSE NULL END
          WHERE id = ?1",
        params![
            id,
            answered.verdict.as_str(),
            answered.reason,
            answered.answer,
            answered.conflicted_copy_id,
            now_iso(),
            answered.verdict == Verdict::Blocked
                && answered.reason == Some(BlockedReason::FailingAlone.as_str()),
        ],
    )?;
    if changed == 0 {
        return Err(CoreError::Store(format!(
            "no queued write {id} to answer; the row went while the drain was sending it"
        )));
    }
    if answered.verdict == Verdict::Accepted {
        meta_delete(conn, &effect_key(id))?;
    }
    // A write refused once sent is never sent again, so no answer is left to
    // carry out a clear of its item's time. One refused unsent can still be
    // released and sent.
    if answered.verdict == Verdict::Refused && !unsent(conn, id)? {
        meta_delete(conn, &cleared_time_key(id))?;
    }
    // A delete refused as already gone did what it asked, and the event of
    // the removal is still ahead wherever its mark is still there.
    if (answered.verdict == Verdict::Accepted
        || answered.verdict == Verdict::Refused && answered.reason == Some("edge_not_found"))
        && let Some(edge) = conn
            .query_row_cached(
                "SELECT edge_id FROM queue WHERE id = ?1 AND kind = ?2",
                params![id, WriteKind::DeleteEdge.as_str()],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten()
    {
        removal_accepted(conn, Subject::Edge, &edge)?;
    }
    if answered.verdict == Verdict::Accepted && !already_accepted {
        learn_dead_effects(conn, &queued_write(conn, id)?.expect("answered row exists"))?;
    }
    // A blocked or dead write still waits, to be released or sent again.
    if !matches!(answered.verdict, Verdict::Blocked | Verdict::Dead) {
        let_go_of_ends(conn, &ends)?;
    }
    Ok(())
}

pub(super) const RECEIPT_PENDING: &str = "receipt_pending/";

/// The id of the row the refused create `id` waits to land on, where it waits
/// for a read that finds that row.
pub fn pending_landing(conn: &Connection, id: &str) -> Result<Option<String>, CoreError> {
    Ok(meta_get(conn, &format!("{RECEIPT_PENDING}{id}"))?
        .and_then(|shape| shape.strip_prefix("land:").map(str::to_owned)))
}

/// The refused creates whose move onto the row their natural key names waits
/// for a read that finds the row, each with the id of that row.
pub fn pending_landings(conn: &Connection) -> Result<HashMap<String, String>, CoreError> {
    Ok(meta_under(conn, RECEIPT_PENDING)?
        .into_iter()
        .filter_map(|(id, shape)| Some((id, shape.strip_prefix("land:")?.to_string())))
        .collect())
}

/// A write's run of environmental failures as a failure leaves it.
pub struct Streak {
    /// The drains in a row in which the write met one.
    pub count: i64,
    /// When the run began, in milliseconds on the store's clock: the first
    /// failure of the run.
    pub began_ms: i64,
}

/// The longest gap between two failures of one run, in milliseconds. A write
/// that failed, then went unsent for longer, starts a run again: a failure
/// long ago says nothing of the one now.
const RUN_GAP_MILLIS: i64 = 15 * 60 * 1000;

/// Counts an environmental failure the write met in this drain: one more on
/// its streak, or the first of a new run where there is no run, the previous
/// failure is more than `RUN_GAP_MILLIS` back, or the previous failure is
/// ahead of the clock (a clock that was set forward and corrected). The start
/// of a run stands until the run ends. None of it touches the refusals.
pub fn count_environmental(
    conn: &Connection,
    id: &str,
    failure: &crate::model::LastFailure,
) -> Result<Streak, CoreError> {
    conn.execute_cached(
        "UPDATE queue
            SET environmental_since = CASE WHEN environmental_streak = 0
                                                OR environmental_since IS NULL
                                                OR environmental_last IS NULL
                                                OR environmental_last > ?3
                                                OR ?3 - environmental_last > ?4
                                           THEN ?3
                                           ELSE environmental_since END,
                environmental_streak = CASE WHEN environmental_streak = 0
                                                 OR environmental_since IS NULL
                                                 OR environmental_last IS NULL
                                                 OR environmental_last > ?3
                                                 OR ?3 - environmental_last > ?4
                                            THEN 1
                                            ELSE environmental_streak + 1 END,
                environmental_last = ?3,
                last_failure = ?2
          WHERE id = ?1",
        params![
            id,
            serde_json::to_string(failure)?,
            now_millis(),
            RUN_GAP_MILLIS
        ],
    )?;
    conn.query_row_cached(
        "SELECT environmental_streak, environmental_since FROM queue WHERE id = ?1",
        [id],
        |row| {
            Ok(Streak {
                count: row.get(0)?,
                began_ms: row.get(1)?,
            })
        },
    )
    .optional()?
    .ok_or_else(|| CoreError::Store(format!("no queued write {id} to count a failure against")))
}

/// Records what the write met when it was answered and the answer says
/// nothing of it that counts: the streak, and so the start of it, stand as
/// they were.
pub fn note_last_failure(
    conn: &Connection,
    id: &str,
    failure: &crate::model::LastFailure,
) -> Result<(), CoreError> {
    conn.execute_cached(
        "UPDATE queue SET last_failure = ?2 WHERE id = ?1",
        params![id, serde_json::to_string(failure)?],
    )?;
    Ok(())
}

/// Sets a write's run of environmental failures back to nothing: it was
/// answered, or released.
pub fn clear_environmental(conn: &Connection, id: &str) -> Result<(), CoreError> {
    conn.execute_cached(
        "UPDATE queue
            SET environmental_streak = 0, environmental_since = NULL,
                environmental_last = NULL, last_failure = NULL
          WHERE id = ?1
            AND (environmental_streak <> 0 OR environmental_since IS NOT NULL
                 OR environmental_last IS NOT NULL OR last_failure IS NOT NULL)",
        [id],
    )?;
    Ok(())
}

pub fn count_refusal(conn: &Connection, id: &str) -> Result<i64, CoreError> {
    clear_environmental(conn, id)?;
    conn.execute_cached(
        "UPDATE queue SET refusals = MIN(refusals + 1, ?2) WHERE id = ?1",
        params![id, CEILING],
    )?;
    conn.query_row_cached("SELECT refusals FROM queue WHERE id = ?1", [id], |row| {
        row.get(0)
    })
    .optional()?
    .ok_or_else(|| CoreError::Store(format!("no queued write {id} to count a refusal against")))
}

pub fn block_unanswered(conn: &Connection, reason: BlockedReason) -> Result<usize, CoreError> {
    Ok(conn.execute_cached(
        "UPDATE queue SET verdict = ?1, reason = ?2, answered_at = ?3
          WHERE verdict IS NULL",
        params![Verdict::Blocked.as_str(), reason.as_str(), now_iso()],
    )?)
}

/// For a copy about to be built from an instance other than the one its
/// writes were queued against: every write a drain or a release could still
/// send is held until a caller releases it, so none reaches rows the copy
/// never held. A refused write stays refused, and one held `record_unread`
/// keeps that reason, so its release still says what it goes without; that
/// release compares the instance with the one its set-aside recorded
/// (`hold_for_instance`). Answers how many it held.
pub fn block_for_another_instance(conn: &Connection) -> Result<usize, CoreError> {
    Ok(conn.execute(
        &format!(
            "UPDATE queue SET verdict = ?1, reason = ?2, answered_at = ?3
              WHERE {WAITING} AND (verdict IS NOT ?1 OR reason IS NOT ?4)"
        ),
        params![
            Verdict::Blocked.as_str(),
            BlockedReason::InstanceChanged.as_str(),
            now_iso(),
            BlockedReason::RecordUnread.as_str()
        ],
    )?)
}

/// The instance the writes a set-aside carried were made for: empty where it
/// could not be read, and absent where they were made for none, which any
/// instance a hydration builds the copy from takes without holding them.
pub(crate) const META_CARRIED_FOR: &str = "carried_for_instance";

/// Holds `instance_changed` every write of `batch` held `record_unread`
/// where the copy is built from another instance than the one its writes
/// were carried for, or that one is unknown. Answers whether it held any.
fn hold_for_instance(conn: &Connection, batch: &[String]) -> Result<bool, CoreError> {
    let Some(made_for) = meta_get(conn, META_CARRIED_FOR)? else {
        return Ok(false);
    };
    if !made_for.is_empty() && meta_get(conn, META_INSTANCE_ID)?.as_ref() == Some(&made_for) {
        return Ok(false);
    }
    Ok(conn.execute_cached(
        "UPDATE queue SET reason = ?2, answered_at = ?3
          WHERE id IN (SELECT value FROM json_each(?1)) AND verdict = ?4 AND reason = ?5",
        params![
            serde_json::to_string(batch)?,
            BlockedReason::InstanceChanged.as_str(),
            now_iso(),
            Verdict::Blocked.as_str(),
            BlockedReason::RecordUnread.as_str()
        ],
    )? > 0)
}

/// Holds each of `ids` the server has not taken `blocked` `record_unread`,
/// whatever it was. A release keeps its key, so a drain judges it again.
/// One refused unsent is held too: releasing what it waits for would send it.
pub(crate) fn hold_record_unread(conn: &Connection, ids: &[String]) -> Result<usize, CoreError> {
    Ok(conn.execute(
        &format!(
            "UPDATE queue SET verdict = ?1, reason = ?2, answered_at = ?3
              WHERE id IN (SELECT value FROM json_each(?4))
                AND ({WAITING} OR (verdict = ?5 AND sent = 0))"
        ),
        params![
            Verdict::Blocked.as_str(),
            BlockedReason::RecordUnread.as_str(),
            now_iso(),
            serde_json::to_string(ids)?,
            Verdict::Refused.as_str()
        ],
    )?)
}

/// A drain returns these rows to unanswered before it starts, so the block
/// is the last drain's finding rather than a state that sticks.
pub fn unblock_self_clearing(conn: &Connection) -> Result<usize, CoreError> {
    let [credential_refused, awaiting] = SELF_CLEARING;
    Ok(conn.execute_cached(
        "UPDATE queue SET verdict = NULL, reason = NULL, answered_at = NULL
          WHERE verdict = ?1 AND reason IN (?2, ?3)",
        params![Verdict::Blocked.as_str(), credential_refused, awaiting],
    )?)
}

/// Whether a drain has a row to return to unanswered
/// (`unblock_self_clearing`).
pub fn any_self_clearing(conn: &Connection) -> Result<bool, CoreError> {
    let [credential_refused, awaiting] = SELF_CLEARING;
    Ok(conn.query_row_cached(
        "SELECT EXISTS (SELECT 1 FROM queue WHERE verdict = ?1 AND reason IN (?2, ?3))",
        params![Verdict::Blocked.as_str(), credential_refused, awaiting],
        |row| row.get(0),
    )?)
}

/// The reasons a block clears itself for: a drain returns these rows to
/// unanswered before it starts (`unblock_self_clearing`).
pub(super) const SELF_CLEARING: [&str; 2] = [
    BlockedReason::CredentialRefused.as_str(),
    crate::model::AWAITING_DEPENDENCY,
];

/// A released write goes to the server, so it is refused as a new one is.
fn refuse_released_while_removing(conn: &Connection, id: &str) -> Result<(), CoreError> {
    let Some(write) = queued_write(conn, id)? else {
        return Ok(());
    };
    if let Some(item) = &write.item_id {
        refuse_removing(conn, item)?;
    }
    for row in rows_reached_by(conn, &write)? {
        refuse_removing(conn, &row)?;
    }
    Ok(())
}

/// A spent key is retained so a late answer cannot settle a new attempt.
pub fn release(conn: &Connection, id: &str) -> Result<bool, CoreError> {
    let Some((verdict, reason, kind, sent)) = conn
        .query_row_cached(
            "SELECT verdict, reason, kind, sent FROM queue WHERE id = ?1",
            [id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)? != 0,
                ))
            },
        )
        .optional()?
    else {
        return Err(CoreError::NotFound {
            server: None,
            code: "queued_write_not_found".into(),
            message: format!("{id} is not a write this queue holds"),
        });
    };
    // A refused row is releasable only if it was never sent. `sent` is the
    // test, not `depends_on`: a row the server refused can carry a dependency
    // too, and releasing it would send it a second time.
    let verdict = verdict.as_deref().map(str::parse::<Verdict>).transpose()?;
    let refused_by_dependency = verdict == Some(Verdict::Refused) && !sent;
    if !matches!(verdict, Some(Verdict::Blocked | Verdict::Dead)) && !refused_by_dependency {
        return Ok(false);
    }
    // Only the answer to the write it waits for releases a held write; a
    // fresh key would let one already sent go out a second time.
    if verdict == Some(Verdict::Blocked)
        && reason.as_deref() == Some(crate::model::AWAITING_DEPENDENCY)
    {
        return Ok(false);
    }
    // Released, a row whose dependency was withdrawn would wait for a write
    // the queue no longer holds, which a drain holds forever. `kept_uploads`
    // keeps bytes for a refused row on these same two tests.
    if refused_by_dependency && waits_for_withdrawn(conn, id)? {
        return Ok(false);
    }
    let batch = crate::row_writes::batch_of(conn, id)?;
    for write in &batch {
        refuse_released_while_removing(conn, write)?;
    }
    if hold_for_instance(conn, &batch)? {
        return Ok(false);
    }
    for write in &batch {
        forget_bytes_sent_again(conn, write)?;
        conn.execute_cached(
            "UPDATE queue
                SET verdict = NULL, reason = NULL, answer = NULL,
                    conflicted_copy_id = NULL, answered_at = NULL,
                    refusals = 0, environmental_streak = 0, environmental_since = NULL,
                    environmental_last = NULL, last_failure = NULL
              WHERE id = ?1",
            [write],
        )?;
    }
    let rows = kind.parse::<WriteKind>()?.rows();
    if fresh_key_on_release(verdict, reason.as_deref()) {
        crate::row_writes::spend_key(conn, &batch[0])?;
        forget_versions_named(conn, &batch[0])?;
    }
    if rows {
        for write in &batch {
            for dependant in dependants_refused_with(conn, write)? {
                release(conn, &dependant)?;
            }
        }
        return Ok(true);
    }
    let released = queued_write(conn, id)?.expect("released row exists");
    let original_fields = edit_fields(conn, &released)?;
    let mut excluded_attempts = HashSet::new();
    for witness in queued_writes(conn)?
        .into_iter()
        .filter(|witness| witness.id != released.id && witness.verdict != Some(Verdict::Accepted))
    {
        let same_edit = witness.kind == released.kind
            && matches!(released.kind, WriteKind::UpdateItem | WriteKind::UpdateEdge)
            && witness.subject_id().is_some()
            && witness.subject_id() == released.subject_id();
        let covered = if same_edit {
            edit_fields(conn, &witness)?
        } else {
            HashSet::new()
        };
        let same_tags = same_tag_subject(&released, &witness)
            && (released.kind == WriteKind::ReplaceTags
                || witness.kind == WriteKind::ReplaceTags
                || tag_targets(&released)
                    .iter()
                    .any(|tag| tag_targets(&witness).contains(tag)));
        if supersedes_dead(&witness, &released)
            || same_tags
            || same_edit
                && (covered.iter().any(|field| original_fields.contains(field))
                    || replaces_properties(&witness.body)
                        && original_fields.iter().any(|field| field.0))
        {
            excluded_attempts.insert(witness.idempotency_key);
        }
    }
    meta_set(
        conn,
        &effect_key(id),
        &serde_json::to_string(&DeadEffect {
            attempt: released.idempotency_key,
            excluded_attempts,
            ..DeadEffect::default()
        })?,
    )?;
    // The writes refused because this one was go with it: no caller would
    // know to release them.
    for dependant in dependants_refused_with(conn, id)? {
        release(conn, &dependant)?;
    }
    Ok(true)
}

/// An answer to `attempt` the server did not replay was applied after every dead write's release.
pub(crate) fn readmit_attempt(conn: &Connection, attempt: &str) -> Result<(), CoreError> {
    for key in meta_keys(conn, "dead_effect/")? {
        let Some(json) = meta_get(conn, &key)? else {
            continue;
        };
        let Ok(mut effect) = serde_json::from_str::<DeadEffect>(&json) else {
            continue;
        };
        if effect.excluded_attempts.remove(attempt) {
            meta_set(conn, &key, &serde_json::to_string(&effect)?)?;
        }
    }
    Ok(())
}

/// Only where the server holds an answer under the key that applied none of the write.
fn fresh_key_on_release(verdict: Option<Verdict>, reason: Option<&str>) -> bool {
    verdict == Some(Verdict::Blocked)
        && matches!(
            reason.and_then(|reason| reason.parse::<BlockedReason>().ok()),
            Some(
                BlockedReason::KeySpent
                    | BlockedReason::ConflictUnresolved
                    | BlockedReason::AncestorUnavailable
            )
        )
}

/// Read from `depends_on`, never the reason, which is prose.
fn dependants_refused_with(conn: &Connection, id: &str) -> Result<Vec<String>, CoreError> {
    Ok(queued_writes(conn)?
        .into_iter()
        .filter(|row| {
            row.verdict == Some(Verdict::Refused) && row.depends_on.iter().any(|held| held == id)
        })
        .map(|row| row.id)
        .collect())
}

/// Whether a row waits, itself or through rows refused unsent before it, for
/// one the queue no longer holds. Clearing keeps every row such a row waits
/// for, so a missing one was withdrawn.
pub(super) fn waits_for_withdrawn(conn: &Connection, id: &str) -> Result<bool, CoreError> {
    Ok(conn.query_row_cached(
        "WITH RECURSIVE chain(id) AS (
           SELECT ?1
           UNION
           SELECT named.value FROM queue, chain, json_each(queue.depends_on) AS named
            WHERE queue.id = chain.id AND queue.verdict = ?2 AND queue.sent = 0
         )
         SELECT EXISTS (SELECT 1 FROM chain WHERE id NOT IN (SELECT id FROM queue))",
        [id, Verdict::Refused.as_str()],
        |row| row.get(0),
    )?)
}

/// Sent dependents qualify only through an upload; unsent dependents are transitive.
pub fn held_for(conn: &Connection, id: &str) -> Result<Vec<QueuedWrite>, CoreError> {
    read_writes(
        conn,
        "WHERE id IN (
           WITH RECURSIVE held(id) AS (
             SELECT ?1
             UNION
             SELECT waiting.id FROM queue AS waiting, held, json_each(waiting.depends_on) AS named
              WHERE named.value = held.id
                AND (waiting.verdict IS NULL OR waiting.verdict = ?2)
                AND (waiting.sent = 0
                     OR EXISTS (SELECT 1 FROM queue AS upload
                                 WHERE upload.id = held.id AND upload.kind = ?3))
           )
           SELECT id FROM held WHERE id <> ?1
         )",
        [
            id,
            Verdict::Blocked.as_str(),
            WriteKind::UploadBlob.as_str(),
        ],
    )
}

/// Every write that waits on `id` stops waiting on it.
pub fn stop_waiting_on(conn: &Connection, id: &str) -> Result<(), CoreError> {
    for row in read_writes(
        conn,
        "WHERE EXISTS (SELECT 1 FROM json_each(queue.depends_on) AS named WHERE named.value = ?1)",
        [id],
    )? {
        let still: Vec<&String> = row.depends_on.iter().filter(|held| *held != id).collect();
        conn.execute_cached(
            "UPDATE queue SET depends_on = ?2 WHERE id = ?1",
            params![
                row.id,
                if still.is_empty() {
                    None
                } else {
                    Some(serde_json::to_string(&still)?)
                }
            ],
        )?;
    }
    Ok(())
}

/// The caller must read back every affected row before withdrawing it.
pub fn withdraw(
    conn: &Connection,
    row: &QueuedWrite,
    held: &[QueuedWrite],
) -> Result<(), CoreError> {
    take_out(conn, row, held, "withdrawn")
}

pub(super) fn take_out(
    conn: &Connection,
    row: &QueuedWrite,
    held: &[QueuedWrite],
    taken: &str,
) -> Result<(), CoreError> {
    let reason = format!("the {} it waits for was {taken}", row.kind);
    for dependant in held {
        record_refusal(conn, dependant, &reason, None, false)?;
    }
    let ends = edge_write_ends(conn, &row.id)?;
    conn.execute_cached("DELETE FROM queue WHERE id = ?1", [&row.id])?;
    meta_delete(conn, &effect_key(&row.id))?;
    forget_write_state(conn, &row.id)?;
    put_back(conn, row)?;
    let_go_of_ends(conn, &ends)
}

pub fn record_read(conn: &Connection, id: &str, read: &Value) -> Result<(), CoreError> {
    conn.execute_cached(
        "UPDATE queue SET read = ?2 WHERE id = ?1",
        params![id, read.to_string()],
    )?;
    Ok(())
}

pub fn read_of(conn: &Connection, id: &str) -> Result<Option<String>, CoreError> {
    Ok(conn
        .query_row_cached("SELECT read FROM queue WHERE id = ?1", [id], |row| {
            row.get::<_, Option<String>>(0)
        })
        .optional()?
        .flatten())
}
