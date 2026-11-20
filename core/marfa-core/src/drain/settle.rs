//! Taking an answer: what a success or a refusal does to the row, its followers and the copy.

use std::sync::atomic::AtomicBool;

use super::address::Shape;
use super::classify::{Classified, limited_by_server};
use super::create_edges;
use super::read_back::{
    Bin, ReachChange, ReadBack, apply_read_back_unchecked, changes_reach, check_read_back,
    ends_the_pass, names_no_row, read_owed, reconcile, restore_settled_overlay,
};
use super::report::DrainVerdict;
use super::send::{unavailable, unavailable_by};
use crate::catch_up::ask_unless_stopped;
use crate::error::CoreError;
use crate::http::Answer;
use crate::model::{BlockedReason, QueuedWrite, Refusal, RowConflict, Subject, Verdict, WriteKind};
use crate::store;
use crate::telemetry;
use crate::wire::{WireEdgeAnswer, WireItem, WireWriteAnswer};
use crate::{Core, Result};

pub(super) struct AnsweredAt<'a> {
    pub(super) version: i64,
    pub(super) item: Option<&'a WireItem>,
    /// The version the create made, where the answer is a later read of the
    /// row rather than the create's own answer.
    pub(super) made: Option<i64>,
}

/// Behind a create, only edits based on 0 move: the placeholder an
/// unanswered create holds, which the server never mints. A create
/// acknowledged as a repeat answers the row as it stands now, so the edits
/// behind it go on 1, the version that create made. So does a create a page
/// made, which a later read answers, unless the row as read holds what the
/// edit read.
pub(super) fn move_edits_behind(
    conn: &rusqlite::Connection,
    row: &QueuedWrite,
    verdict: Verdict,
    acknowledged: bool,
    subject: &str,
    at: &AnsweredAt<'_>,
) -> Result<()> {
    let version = at.version;
    let landed = matches!(verdict, Verdict::Accepted | Verdict::Merged);
    for (id, base) in store::edits_behind(conn, row, subject)? {
        let to = match row.kind {
            WriteKind::CreateItem | WriteKind::CreateEdge => {
                if base != Some(0) {
                    continue;
                }
                match row.base_version {
                    _ if acknowledged => 1,
                    // Another device can have changed the row since the
                    // create, and an edit that read none of it must not
                    // overwrite it.
                    _ if let Some(made) = at.made
                        && version > made =>
                    {
                        if holds(conn, &id, at)? {
                            version
                        } else {
                            made
                        }
                    }
                    Some(created_on) if created_on > 0 && version > created_on + 1 => {
                        if holds(conn, &id, at)? {
                            version
                        } else {
                            created_on
                        }
                    }
                    _ => version,
                }
            }
            WriteKind::UpdateItem | WriteKind::UpdateEdge => {
                let before = base.is_some_and(|base| base < version);
                // Catch-up can already have supplied this receipt's version.
                // A later edit that read its values has no base to rewind.
                if landed
                    && base == Some(version)
                    && (row.kind == WriteKind::UpdateEdge || holds(conn, &id, at)?)
                {
                    continue;
                }
                // An edge is never merged, so its answer is the edit applied
                // to the version it named.
                let onto = landed
                    && before
                    && if row.kind == WriteKind::UpdateEdge {
                        base == Some(version - 1)
                    } else {
                        holds(conn, &id, at)?
                    };
                if onto {
                    version
                } else if let Some(back) = back_to(conn, row, &id, base)? {
                    back
                } else {
                    continue;
                }
            }
            _ => return Ok(()),
        };
        let onto = at.item.filter(|_| to == version);
        store::move_edit(conn, &id, to, onto.map(|item| &item.properties))?;
    }
    Ok(())
}

/// A delete or a tag replace behind `row` is based on the version it read of
/// the row, and the server refuses it where another writer has moved the row
/// on. Behind this device's own answered write it moves on to the version
/// that write made, only where the answer holds all the write read.
fn move_versioned_behind(
    conn: &rusqlite::Connection,
    row: &QueuedWrite,
    answered: &WireItem,
    acknowledged: bool,
) -> Result<()> {
    for kind in [WriteKind::DeleteItem, WriteKind::ReplaceTags] {
        for (id, base) in store::unsent_writes_behind(conn, row, &answered.id, kind)? {
            if base.is_none_or(|base| base >= answered.version) {
                continue;
            }
            // A new row's first receipt confirms only this device's create.
            // Later receipts must still hold everything the write read.
            let own_create = row.kind == WriteKind::CreateItem
                && !acknowledged
                && answered.version == 1
                && base == Some(0);
            let unchanged = if let Some(read) = store::read_of(conn, &id)? {
                if own_create {
                    let mut read: serde_json::Value = serde_json::from_str(&read)?;
                    // These fields are fixed by the create, never by an edit behind it.
                    // Keep the later local edits in the rest of the write's read.
                    read["source"] = serde_json::json!(answered.source);
                    read["occurred_at"] = serde_json::json!(answered.occurred_at);
                    read["schema_version"] = serde_json::json!(answered.schema_version);
                    store::record_read(conn, &id, &read)?;
                }
                let read: WireItem = serde_json::from_str(&read)?;
                read.properties == answered.properties
                    && read.r#type == answered.r#type
                    && read.tier == answered.tier
                    && read.source == answered.source
                    && read.source_id == answered.source_id
                    && read.occurred_at == answered.occurred_at
                    && read.schema_version == answered.schema_version
            } else {
                false
            };
            if own_create || unchanged {
                if kind == WriteKind::ReplaceTags {
                    store::rebase_column(conn, &id, answered.version)?;
                } else {
                    store::rebase(conn, &id, answered.version)?;
                }
            }
        }
    }
    Ok(())
}

pub(super) fn move_edits_back(conn: &rusqlite::Connection, row: &QueuedWrite) -> Result<()> {
    if !matches!(row.kind, WriteKind::UpdateItem | WriteKind::UpdateEdge) {
        return Ok(());
    }
    let Some(subject) = row.subject_id() else {
        return Ok(());
    };
    for (id, base) in store::edits_behind(conn, row, subject)? {
        if let Some(back) = back_to(conn, row, &id, base)? {
            store::move_edit(conn, &id, back, None)?;
        }
    }
    Ok(())
}

/// An edit sharing a property with `row` took that value from `row`, not
/// the server, so on its own base the server would take it as newer than a
/// value this device never read. On `row`'s base the server merges or
/// conflicts instead.
fn back_to(
    conn: &rusqlite::Connection,
    row: &QueuedWrite,
    id: &str,
    base: Option<i64>,
) -> Result<Option<i64>> {
    let Some(ahead) = row.base_version else {
        return Ok(None);
    };
    if base.is_none_or(|base| base <= ahead) {
        return Ok(None);
    }
    let carried = |id: &str| -> Result<Vec<String>> {
        let body: serde_json::Value = serde_json::from_str(&store::payload_of(conn, id)?)?;
        Ok(body
            .get("properties")
            .and_then(serde_json::Value::as_object)
            .into_iter()
            .flat_map(|properties| properties.keys().cloned())
            .chain(store::cleared(&body).map(str::to_string))
            .collect())
    };
    let ahead_carries = carried(&row.id)?;
    let shared = carried(id)?
        .iter()
        .any(|property| ahead_carries.contains(property));
    Ok(shared.then_some(ahead))
}

/// What an item edit's body sends for `key`: its value, null where it clears
/// the property, and nothing where it leaves the property alone.
fn sent_value<'a>(body: &'a serde_json::Value, key: &str) -> Option<&'a serde_json::Value> {
    const CLEARED: serde_json::Value = serde_json::Value::Null;
    body.pointer(&format!("/properties/{}", pointer_token(key)))
        .or_else(|| {
            store::cleared(body)
                .any(|name| name == key)
                .then_some(&CLEARED)
        })
}

/// A property carried at the value read is not checked: a move drops it.
/// Nor is a natural key: the server gives a key both writes changed to the
/// later writer, so on its own base the edit's key lands all the same.
pub(super) fn holds(conn: &rusqlite::Connection, id: &str, at: &AnsweredAt<'_>) -> Result<bool> {
    let Some(item) = at.item else {
        return Ok(false);
    };
    let Some(read) = store::read_of(conn, id)? else {
        return Ok(false);
    };
    let read: serde_json::Value = serde_json::from_str(&read)?;
    let body: serde_json::Value = serde_json::from_str(&store::payload_of(conn, id)?)?;
    let null = serde_json::Value::Null;
    if let Some(serde_json::Value::Object(properties)) = read.get("properties") {
        for (key, value) in properties {
            let sent = sent_value(&body, key);
            if sent == Some(value) {
                continue;
            }
            if item.properties.get(key).unwrap_or(&null) != value {
                return Ok(false);
            }
        }
    }
    Ok(true)
}

/// Whether a conflicted edit collided only with this device's own earlier
/// write, so the copy set aside holds the newest and the row an older one.
fn against_its_own(
    conn: &rusqlite::Connection,
    row: &QueuedWrite,
    answer: &WireWriteAnswer,
) -> Result<bool> {
    let Some(resolution) = &answer.conflict_resolution else {
        return Ok(false);
    };
    let Some(read) = store::read_of(conn, &row.id)? else {
        return Ok(false);
    };
    let read: serde_json::Value = serde_json::from_str(&read)?;
    let body: serde_json::Value = serde_json::from_str(&store::payload_of(conn, &row.id)?)?;
    let null = serde_json::Value::Null;
    let mut kept = 0;
    for field in &resolution.fields {
        let token = pointer_token(field);
        let Some(sent) = sent_value(&body, field) else {
            continue;
        };
        let held = answer.item.properties.get(field).unwrap_or(&null);
        if held == sent {
            continue;
        }
        kept += 1;
        if read.pointer(&format!("/properties/{token}")) != Some(held) {
            return Ok(false);
        }
    }
    Ok(kept > 0)
}

fn pointer_token(key: &str) -> String {
    key.replace('~', "~0").replace('/', "~1")
}

/// `answer` is the answer the queue stored for the row, which the refusal
/// is read from.
pub(super) fn verdict_of(
    row: &QueuedWrite,
    settled: &Settled,
    answer: Option<&str>,
) -> DrainVerdict {
    DrainVerdict {
        id: row.id.clone(),
        kind: row.kind,
        item_id: row.item_id.clone(),
        edge_id: row.edge_id.clone(),
        verdict: settled.verdict,
        reason: settled.reason.clone(),
        refusal: Refusal::for_write(settled.verdict, settled.reason.as_deref(), answer),
        conflicted_copy_id: settled.conflicted_copy_id.clone(),
        refusals: settled.refusals,
        replayed: settled.replayed,
        merged_fields: settled.merged_fields.clone(),
        conflicts: settled.conflicts.clone(),
    }
}

/// The verdict the queue holds for a write whose settling ended the pass
/// after it was committed, with what its answer adds. A write `landed`, on a
/// natural key or a receipt the server no longer keeps whole, was replayed.
pub(super) fn committed(
    row: &QueuedWrite,
    answer: Option<&Answer>,
    shape: Shape,
    landed: bool,
) -> Settled {
    let item = answer
        .filter(|_| shape == Shape::Item)
        .and_then(|answer| serde_json::from_str::<WireWriteAnswer>(&answer.body).ok());
    let edge = answer
        .filter(|_| shape == Shape::Edge)
        .and_then(|answer| serde_json::from_str::<WireEdgeAnswer>(&answer.body).ok());
    let succeeded = matches!(
        row.verdict,
        Some(Verdict::Accepted | Verdict::Merged | Verdict::Conflicted)
    );
    Settled {
        conflicted_copy_id: row.conflicted_copy_id.clone(),
        replayed: succeeded
            && (landed
                || answer.is_some_and(|answer| answer.replayed)
                || item.as_ref().is_some_and(|item| item.acknowledged)
                || edge.as_ref().is_some_and(|edge| edge.acknowledged)),
        merged_fields: item
            .and_then(|item| item.conflict_resolution)
            .filter(|_| succeeded)
            .map(|resolution| resolution.fields)
            .unwrap_or_default(),
        ..Settled::plain(row.verdict, row.reason.clone(), row.refusals)
    }
}

pub(super) struct Settled {
    pub(super) verdict: Option<Verdict>,
    pub(super) reason: Option<String>,
    pub(super) conflicted_copy_id: Option<String>,
    pub(super) refusals: i64,
    pub(super) stops_the_drain: bool,
    pub(super) replayed: bool,
    pub(super) merged_fields: Vec<String>,
    pub(super) also: Vec<(QueuedWrite, Verdict, String)>,
    pub(super) unclaimed: Option<String>,
    /// From the read a landed create makes, besides the answer's own.
    pub(super) retry_after_seconds: Option<u64>,
    /// Set where this write, or a read it needed, could not get through: the
    /// pass ends here.
    pub(super) unavailable: Option<String>,
    /// Whether `unavailable` is the server limiting requests.
    pub(super) limited: bool,
    pub(super) conflicts: Vec<RowConflict>,
    /// The other writes of this one's batch.
    pub(super) joined: Vec<DrainVerdict>,
    /// Refused for another write's operation, so this one goes again at once.
    pub(super) again: bool,
    /// Blocked until the bytes it names go again (`waits_for_bytes_again`).
    pub(super) bytes_again: bool,
}

impl Settled {
    pub(super) fn plain(
        verdict: Option<Verdict>,
        reason: Option<String>,
        refusals: i64,
    ) -> Settled {
        Settled {
            verdict,
            reason,
            conflicted_copy_id: None,
            refusals,
            stops_the_drain: false,
            replayed: false,
            merged_fields: Vec::new(),
            also: Vec::new(),
            unclaimed: None,
            retry_after_seconds: None,
            unavailable: None,
            limited: false,
            conflicts: Vec::new(),
            joined: Vec::new(),
            again: false,
            bytes_again: false,
        }
    }
}

pub(super) fn receipt_key(id: &str) -> String {
    format!("receipt_pending/{id}")
}

pub(super) fn same_attempt(conn: &rusqlite::Connection, row: &QueuedWrite) -> Result<()> {
    let current = store::queued_write(conn, &row.id)?;
    if current.as_ref().is_none_or(|current| {
        current.idempotency_key != row.idempotency_key
            || current.body != row.body
            || current.kind != row.kind
            || current.base_version != row.base_version
            || current.item_id != row.item_id
            || current.edge_id != row.edge_id
    }) {
        return Err(CoreError::StreamIncomplete {
            reason: "local_queue_changed".into(),
            server: None,
        });
    }
    Ok(())
}

/// A transaction that records what the server answered, made again from its
/// first read where another program's commit refuses it. A stop does not cut
/// it short: a write the server took must not be left looking refused.
pub(super) fn recorded<T>(core: &Core, write: impl FnMut() -> Result<T>) -> Result<T> {
    crate::busy::retrying(&core.conn, &AtomicBool::new(false), write)
}

/// `read` is a page's read of what its create made at version 1, made
/// before the answer was settled; the row can have moved past 1 since.
#[allow(clippy::too_many_arguments)]
pub(super) fn settle_success(
    core: &Core,
    stop: &AtomicBool,
    row: &QueuedWrite,
    answer: &Answer,
    shape: Shape,
    pass: &mut ReachChange,
    answered_now: bool,
    read: Option<ReadBack>,
) -> Result<Settled> {
    let item = if shape == Shape::Item {
        serde_json::from_str::<WireWriteAnswer>(&answer.body).ok()
    } else {
        None
    };
    let edge = if shape == Shape::Edge {
        serde_json::from_str::<WireEdgeAnswer>(&answer.body).ok()
    } else {
        None
    };
    let blob_matches = shape != Shape::Blob
        || serde_json::from_str::<serde_json::Value>(&answer.body)
            .ok()
            .and_then(|value| {
                value
                    .get("hash")
                    .and_then(|hash| hash.as_str())
                    .map(str::to_owned)
            })
            .as_deref()
            == row.blob.as_deref();
    if shape == Shape::Item && item.is_none()
        || shape == Shape::Edge && edge.is_none()
        || !blob_matches
    {
        let refusals = store::count_refusal(&*core.conn()?, &row.id)?;
        return finish_counted(core, row, refusals, Some(answer.body.clone()));
    }
    let (verdict, conflicted_copy_id, merged_fields) = match item
        .as_ref()
        .and_then(|item| item.conflict_resolution.as_ref())
    {
        None => (Verdict::Accepted, None, Vec::new()),
        Some(resolution) => (
            if resolution.conflicted_copy_id.is_some() {
                Verdict::Conflicted
            } else {
                Verdict::Merged
            },
            resolution.conflicted_copy_id.clone(),
            resolution.fields.clone(),
        ),
    };
    let mut settled = Settled {
        verdict: Some(verdict),
        conflicted_copy_id: conflicted_copy_id.clone(),
        merged_fields,
        replayed: answer.replayed
            || item.as_ref().is_some_and(|item| item.acknowledged)
            || edge.as_ref().is_some_and(|edge| edge.acknowledged),
        ..Settled::plain(None, None, row.refusals)
    };
    let owed = recorded(core, || {
        let mut conn = core.conn()?;
        let tx = conn.transaction()?;
        same_attempt(&tx, row)?;
        let mut owed = store::owed_of(&tx, row)?;
        if let (Some(owed), Some(item)) = (&mut owed, &item) {
            owed.id = item.item.id.clone();
        }
        if let (Some(owed), Some(edge)) = (&mut owed, &edge) {
            owed.id = edge.edge.id.clone();
        }
        // A receipt kept from an earlier pass holds the verdict and says how
        // the answer it settles on reads.
        let kept = store::meta_get(&tx, &receipt_key(&row.id))?.is_some();
        #[cfg(debug_assertions)]
        crate::fault::gate("gate-drain-receipt");
        if !kept {
            if !settled.replayed {
                store::readmit_attempt(&tx, &row.idempotency_key)?;
            }
            store::record_verdict(
                &tx,
                &row.id,
                &store::Answered {
                    verdict,
                    reason: None,
                    answer: Some(&answer.body),
                    conflicted_copy_id: conflicted_copy_id.as_deref(),
                },
            )?;
        }
        if let Some(owed) = &owed {
            store::owe_read_back(&tx, owed)?;
            if !kept {
                store::meta_set(
                    &tx,
                    &receipt_key(&row.id),
                    match shape {
                        Shape::Item => "item",
                        Shape::Edge => "edge",
                        _ => "plain",
                    },
                )?;
            }
        }
        tx.commit()?;
        Ok(owed)
    })?;
    let Some(owed) = owed else {
        return Ok(settled);
    };
    let made = read.is_some().then_some(1);
    let read = match read.map(Ok).unwrap_or_else(|| {
        read_owed(
            core,
            stop,
            &owed,
            Bin::Held,
            pass,
            answered_now && changes_reach(row),
        )
    }) {
        Ok(read) => read,
        Err(error) if error.is_environmental() => {
            telemetry::degraded!(&error);
            settled.unavailable = unavailable_by(&error).or_else(|| Some(error.to_string()));
            settled.limited = error.is_limit_named();
            settled.retry_after_seconds = error.retry_after().map(|wait| wait.as_secs());
            return Ok(settled);
        }
        Err(error) => return Err(error),
    };
    let follows = recorded(core, || {
        let mut conn = core.conn()?;
        let tx = conn.transaction()?;
        same_attempt(&tx, row)?;
        check_read_back(&tx, &read)?;
        restore_settled_overlay(&tx, row, &read)?;
        // Only a row this copy minted and holds as the answer settles: an
        // answer naming another id landed on a row made elsewhere.
        let mut made_here = None;
        if let Some(parsed) = &item {
            if row.kind == WriteKind::CreateItem
                && let Some(local) = row.item_id.as_deref()
            {
                if local == parsed.item.id
                    && row.base_version.is_none_or(|base| base == 0)
                    && store::held_version(&tx, local)?.is_some()
                {
                    made_here = Some(if parsed.acknowledged {
                        1
                    } else {
                        made.unwrap_or(parsed.item.version)
                    });
                }
                drop_projected_edges(&tx, row, local, Some(&parsed.item))?;
                store::adopt_answered_id(&tx, local, &parsed.item.id)?;
                store::refollow(&tx, &parsed.item.id, &row.id)?;
                take_answered_edges(&tx, &parsed.item)?;
                create_edges::owe(&tx, row, &parsed.item)?;
            }
            move_edits_behind(
                &tx,
                row,
                verdict,
                parsed.acknowledged,
                &parsed.item.id,
                &AnsweredAt {
                    version: parsed.item.version,
                    item: Some(&parsed.item),
                    made,
                },
            )?;
            if matches!(verdict, Verdict::Accepted | Verdict::Merged) {
                move_versioned_behind(&tx, row, &parsed.item, parsed.acknowledged)?;
            }
            if verdict == Verdict::Conflicted
                && row.kind == WriteKind::UpdateItem
                && against_its_own(&tx, row, parsed)?
            {
                store::untake_latest_save(&tx, row, &parsed.item.id, parsed.item.version)?;
            }
        }
        if let Some(parsed) = &edge {
            move_edits_behind(
                &tx,
                row,
                verdict,
                parsed.acknowledged,
                &parsed.edge.id,
                &AnsweredAt {
                    version: parsed.edge.version,
                    item: None,
                    made,
                },
            )?;
        }
        // The receipt can rename a pin, but the fresh response was checked
        // against the exact pre-adoption pin set while this transaction held
        // the writer.
        apply_read_back_unchecked(&tx, &read)?;
        if let (Some(version), Some(parsed)) = (made_here, &item)
            && store::held_version(&tx, &parsed.item.id)?.is_some()
        {
            store::note_made(&tx, &parsed.item.id, version)?;
        }
        let follows = match &item {
            Some(parsed) if row.kind == WriteKind::CreateItem => {
                queue_owed_time_clear(&tx, row, &parsed.item, verdict)?
            }
            _ => false,
        };
        // Everything the receipt settles is settled; an unread answer leaves
        // only the read owed, for the pass after the copy is built again.
        if !matches!(read, ReadBack::Unread) {
            store::settle_read_back(&tx, owed.subject, &owed.id)?;
        }
        store::meta_delete(&tx, &receipt_key(&row.id))?;
        tx.commit()?;
        Ok(follows)
    })?;
    pass.follow_up |= follows;
    if row.kind == WriteKind::CreateItem
        && let Some(parsed) = &item
    {
        // The create is settled whatever the read meets: one that fails is
        // left owed, for the read before the next pass sends anything. One no
        // later read gets past ends the pass, as `read_owed_backs` does, after
        // the caller has reported the committed verdict.
        match create_edges::read(core, pass, stop, &parsed.item.id) {
            Ok(()) => {}
            Err(error) if ends_the_pass(&error) => return Err(error),
            Err(error) if error.is_environmental() => {
                telemetry::degraded!(&error);
                settled.unavailable = unavailable_by(&error).or_else(|| Some(error.to_string()));
                settled.limited = error.is_limit_named();
                settled.retry_after_seconds = error.retry_after().map(|wait| wait.as_secs());
            }
            Err(error) => telemetry::degraded!(&error),
        }
    }
    Ok(settled)
}

/// The person cleared the time of the item a create makes after the create's
/// body was fixed, so the answer can carry a time of the server's own: a
/// keyed create's held row keeps its time, and a sent create named one. The
/// clear is queued as the edit it would have been once the row was known:
/// the row's creation time. Answers whether it queued one.
///
/// An edit of this row the copy refuses is dropped with the clear, since the
/// same edit would be refused at every later pass. Any other error fails the
/// settle, which keeps the receipt and the clear for the next drain.
fn queue_owed_time_clear(
    conn: &rusqlite::Connection,
    row: &QueuedWrite,
    answered: &WireItem,
    verdict: Verdict,
) -> Result<bool> {
    let key = store::cleared_time_key(&row.id);
    if store::meta_get(conn, &key)?.is_none() {
        return Ok(false);
    }
    store::meta_delete(conn, &key)?;
    if !matches!(verdict, Verdict::Accepted | Verdict::Merged)
        || answered.occurred_at == answered.created_at
    {
        return Ok(false);
    }
    // The read of the answer can find the row in the bin or gone, or leave
    // it outside the copy's slice: there is no row here to edit.
    let Some(held) = store::item_by_id(conn, &answered.id)? else {
        return Ok(false);
    };
    let catalog = crate::catalog::load(conn)?;
    let queued = store::catalog_scope(conn, |conn| {
        #[cfg(debug_assertions)]
        if crate::fault::fails(|| "owed-time-clear") {
            return Err(CoreError::StorageFull("database or disk is full".into()));
        }
        crate::queue_update(
            conn,
            &catalog,
            &answered.id,
            &crate::model::Edit {
                base_version: Some(answered.version.min(held.version)),
                clear_occurred_at: true,
                ..Default::default()
            },
            &[],
            crate::Based::AsRead,
        )
    });
    match queued {
        Ok(_) => Ok(true),
        Err(
            error @ (CoreError::NotFound { .. }
            | CoreError::Forbidden { .. }
            | CoreError::Validation { .. }
            | CoreError::UnknownType { .. }
            | CoreError::Invalid(_)),
        ) => {
            telemetry::degraded!(&error);
            Ok(false)
        }
        Err(error) => Err(error),
    }
}

/// Given to an edit or delete of an edge a create was shown with that the
/// server did not make.
const UNMADE: &str =
    "the server made no edge to this item when it answered the create the edge was drawn with";

/// The edges a created item was drawn with while its write waited carry
/// device-own ids. Each leaves where `answered`, the item the server answered
/// with, shows what the server holds in its place: the answer's edges of its
/// type are whole, or name the same pair. The answer can carry fewer, as one
/// page of each type, none under a source filter, or none at all for an
/// acknowledged repeat, so any other stays until the read
/// [`create_edges::owe`] records brings the server's edge, which takes its
/// place. With no answer, as for a refused create, the server drew none of
/// them.
pub(super) fn drop_projected_edges(
    conn: &rusqlite::Connection,
    row: &QueuedWrite,
    local: &str,
    answered: Option<&WireItem>,
) -> Result<()> {
    let draft = crate::model::Draft::from_payload(&store::payload_of(conn, &row.id)?)?;
    for (edge_type, target) in draft.edge_pairs() {
        let kept = answered.is_some_and(|item| {
            !item
                .edges
                .as_ref()
                .and_then(|edges| edges.get(&edge_type))
                .is_some_and(|block| {
                    block.next_cursor.is_none()
                        || block.data.iter().any(|edge| edge.to_id == target)
                })
        });
        if !kept {
            let id = crate::model::projected_edge_id(local, &edge_type, &target);
            store::forget_edge(conn, &id)?;
            store::refuse_edge_writes(conn, &id, UNMADE)?;
        }
    }
    Ok(())
}

/// The edges the server answered a create with, first page of each type. The
/// rest are read by [`create_edges::read`].
fn take_answered_edges(conn: &rusqlite::Connection, item: &WireItem) -> Result<()> {
    for block in item.edges.iter().flat_map(|edges| edges.values()) {
        for edge in &block.data {
            store::take_server_edge(conn, edge)?;
        }
    }
    Ok(())
}

/// `queue-and-verdicts/upload-again-bytes-absent`.
fn waits_for_bytes_again(
    core: &Core,
    row: &QueuedWrite,
    answer: &std::result::Result<Answer, CoreError>,
) -> Result<bool> {
    let refused = answer
        .as_ref()
        .is_ok_and(|answer| answer.status == 404 && answer.code == store::BYTES_ABSENT);
    if !refused || row.kind == WriteKind::UploadBlob {
        return Ok(false);
    }
    let cache = core.cache().ok();
    recorded(core, || {
        let mut conn = core.conn()?;
        let tx = conn.transaction()?;
        same_attempt(&tx, row)?;
        let waits = store::send_bytes_again(&tx, &row.id, |hash| {
            cache.is_some_and(|cache| cache.held(hash).is_ok_and(|held| held.is_some()))
        })?;
        tx.commit()?;
        Ok(waits)
    })
}

pub(super) fn settle(
    core: &Core,
    stop: &AtomicBool,
    row: &QueuedWrite,
    answer: &std::result::Result<Answer, CoreError>,
    class: Classified,
    shape: Shape,
    pass: &mut ReachChange,
) -> Result<Settled> {
    let envelope = answer.as_ref().ok().map(|answer| answer.body.clone());
    if class == Classified::Contract && waits_for_bytes_again(core, row, answer)? {
        pass.follow_up = true;
        return Ok(Settled {
            bytes_again: true,
            ..Settled::plain(
                Some(Verdict::Blocked),
                Some(crate::model::AWAITING_DEPENDENCY.into()),
                row.refusals,
            )
        });
    }
    match class {
        Classified::Success => settle_success(
            core,
            stop,
            row,
            answer.as_ref().expect("a success has a response"),
            shape,
            pass,
            true,
            None,
        ),
        Classified::Environmental => Ok(Settled {
            retry_after_seconds: answer
                .as_ref()
                .err()
                .and_then(CoreError::retry_after)
                .map(|wait| wait.as_secs()),
            unavailable: unavailable(answer),
            limited: limited_by_server(answer),
            ..Settled::plain(None, None, row.refusals)
        }),
        Classified::Contract => {
            let code = answer
                .as_ref()
                .ok()
                .map(|answer| answer.code.clone())
                .filter(|code| !code.is_empty())
                .unwrap_or_else(|| "unknown".into());
            // The verdict before the read: the other order loses the refusal
            // when the read fails, and the write goes out again.
            recorded(core, || {
                let mut conn = core.conn()?;
                let tx = conn.transaction()?;
                same_attempt(&tx, row)?;
                store::record_verdict(
                    &tx,
                    &row.id,
                    &store::Answered {
                        verdict: Verdict::Refused,
                        reason: Some(&code),
                        answer: envelope.as_deref(),
                        conflicted_copy_id: None,
                    },
                )?;
                store::forget_bytes_sent_again(&tx, &row.id)?;
                if let Some(owed) = store::owed_of(&tx, row)? {
                    store::owe_read_back(&tx, &owed)?;
                    store::meta_set(&tx, &receipt_key(&row.id), "refused")?;
                }
                tx.commit()?;
                Ok(())
            })?;
            let unread = reconcile(core, stop, row, pass)?;
            Ok(Settled {
                retry_after_seconds: unread
                    .as_ref()
                    .and_then(|unread| unread.retry_after_seconds),
                limited: unread.as_ref().is_some_and(|unread| unread.limited),
                unavailable: unread.map(|unread| unread.reason),
                ..Settled::plain(Some(Verdict::Refused), Some(code), row.refusals)
            })
        }
        Classified::Counted => {
            let conn = core.conn()?;
            let refusals = store::count_refusal(&conn, &row.id)?;
            drop(conn);
            finish_counted(core, row, refusals, envelope)
        }
        Classified::Landed { id, code } => land(core, stop, row, answer, &id, code, pass),
        Classified::Delivered => settle_delivered(core, stop, row, shape, pass),
        Classified::Trashed => {
            let mut response = answer.clone();
            if let Ok(answer) = &mut response {
                answer.code = "trashed".into();
            }
            settle(
                core,
                stop,
                row,
                &response,
                Classified::Contract,
                shape,
                pass,
            )
        }
        Classified::Unclaimed { source } => {
            let mut conn = core.conn()?;
            let tx = conn.transaction()?;
            store::record_verdict(
                &tx,
                &row.id,
                &store::Answered {
                    verdict: Verdict::Blocked,
                    reason: Some(BlockedReason::CredentialRefused.as_str()),
                    answer: envelope.as_deref(),
                    conflicted_copy_id: None,
                },
            )?;
            let blocked = store::block_creates_naming(&tx, &source)?;
            let mut also = Vec::new();
            for id in blocked {
                if let Some(other) = store::queued_write(&tx, &id)? {
                    also.push((
                        other,
                        Verdict::Blocked,
                        BlockedReason::CredentialRefused.as_str().to_string(),
                    ));
                }
            }
            tx.commit()?;
            Ok(Settled {
                also,
                unclaimed: Some(source),
                ..Settled::plain(
                    Some(Verdict::Blocked),
                    Some(BlockedReason::CredentialRefused.as_str().into()),
                    row.refusals,
                )
            })
        }
        Classified::Block(reason) | Classified::BlockQueue(reason) => {
            let mut conn = core.conn()?;
            let tx = conn.transaction()?;
            same_attempt(&tx, row)?;
            store::record_verdict(
                &tx,
                &row.id,
                &store::Answered {
                    verdict: Verdict::Blocked,
                    reason: Some(reason.as_str()),
                    answer: envelope.as_deref(),
                    conflicted_copy_id: None,
                },
            )?;
            if reason != BlockedReason::CredentialRefused {
                // The later edit read this failed edit's optimistic fields.
                // Correct its unsent base, without adopting any server data.
                move_edits_back(&tx, row)?;
            }
            tx.commit()?;
            Ok(Settled {
                stops_the_drain: matches!(class, Classified::BlockQueue(_)),
                ..Settled::plain(
                    Some(Verdict::Blocked),
                    Some(reason.as_str().into()),
                    row.refusals,
                )
            })
        }
    }
}

/// Settles a write whose first answer succeeded and was too large for the
/// server to keep, with the row or edge as a read by id finds it now in place
/// of that answer. Like any repeat, it answers the subject as it stands
/// (`queue-and-verdicts/not-retained-accepted`). Where the read finds
/// nothing, the write settles with no answer to take a version from.
fn settle_delivered(
    core: &Core,
    stop: &AtomicBool,
    row: &QueuedWrite,
    shape: Shape,
    pass: &mut ReachChange,
) -> Result<Settled> {
    let subject = match shape {
        Shape::Item => row.item_id.as_deref().map(|id| ("items", id)),
        Shape::Edge => row.edge_id.as_deref().map(|id| ("edges", id)),
        Shape::Plain | Shape::Blob | Shape::Rows => None,
    };
    let read = match subject {
        None => None,
        // The server would refuse the read; sent again, the write is
        // answered the same way once the copy is built again.
        Some(_) if pass.changed() => return Ok(Settled::plain(None, None, row.refusals)),
        Some((collection, id)) => {
            let context = pass.context(&*core.conn()?)?;
            let http = context.http(core.http()?);
            let (collection, id) = (collection.to_string(), id.to_string());
            match ask_unless_stopped(stop, &http, move |http| {
                http.read_whole(&[collection.as_str(), id.as_str()])
            }) {
                Ok(found) => found,
                Err(CoreError::Forbidden { .. }) => None,
                Err(error) if names_no_row(&error) => None,
                Err(error) if error.is_environmental() => {
                    telemetry::degraded!(&error);
                    return Ok(Settled {
                        retry_after_seconds: error.retry_after().map(|wait| wait.as_secs()),
                        unavailable: unavailable_by(&error).or_else(|| Some(error.to_string())),
                        limited: error.is_limit_named(),
                        ..Settled::plain(None, None, row.refusals)
                    });
                }
                Err(error) => return Err(context.failed(core, error)?),
            }
        }
    };
    let (answer, shape) = found_answer(row, shape, read);
    settle_success(core, stop, row, &answer, shape, pass, true, None)
}

/// The answer to a write the server holds as done: `read`, its subject as
/// the server holds it, where its door answers with the subject.
pub(super) fn found_answer(
    row: &QueuedWrite,
    shape: Shape,
    read: Option<serde_json::Value>,
) -> (Answer, Shape) {
    let (body, shape) = match read {
        Some(mut found) => {
            found["acknowledged"] = serde_json::Value::Bool(true);
            (found, shape)
        }
        None if shape == Shape::Blob => (serde_json::json!({ "hash": row.blob }), shape),
        None => (serde_json::json!({}), Shape::Plain),
    };
    let answer = Answer {
        status: 200,
        code: String::new(),
        body: body.to_string(),
        retry_after_seconds: None,
        replayed: true,
        contract_named: true,
        request_id: None,
    };
    (answer, shape)
}

/// A natural-key receipt settles independently of the current read authority.
/// Its identity reconciliation waits until a fresh conditional read can land.
pub(super) fn land(
    core: &Core,
    stop: &AtomicBool,
    row: &QueuedWrite,
    answer: &std::result::Result<Answer, CoreError>,
    id: &str,
    code: String,
    pass: &mut ReachChange,
) -> Result<Settled> {
    let envelope = answer.as_ref().ok().map(|answer| answer.body.clone());
    let owed = store::Owed {
        subject: Subject::Item,
        id: id.into(),
        from_id: None,
        edge_type: None,
        moved: false,
    };
    {
        let mut conn = core.conn()?;
        let tx = conn.transaction()?;
        same_attempt(&tx, row)?;
        if store::meta_get(&tx, &receipt_key(&row.id))?.is_none() {
            store::record_verdict(
                &tx,
                &row.id,
                &store::Answered {
                    verdict: Verdict::Refused,
                    reason: Some(&code),
                    answer: envelope.as_deref(),
                    conflicted_copy_id: None,
                },
            )?;
        }
        store::owe_read_back(&tx, &owed)?;
        store::meta_set(&tx, &receipt_key(&row.id), &format!("land:{id}"))?;
        tx.commit()?;
    }
    let mut settled = Settled::plain(Some(Verdict::Refused), Some(code), row.refusals);
    let read = match read_owed(core, stop, &owed, Bin::NotFound, pass, false) {
        Ok(read @ ReadBack::Item { held: Some(_), .. }) => read,
        // The receipt stays owed and the writes behind the create stay held,
        // but nothing else waits on a row the server may never hold again.
        Ok(_) => return Ok(settled),
        Err(error) if error.is_environmental() => {
            telemetry::degraded!(&error);
            settled.unavailable = unavailable_by(&error).or_else(|| Some(error.to_string()));
            settled.limited = error.is_limit_named();
            settled.retry_after_seconds = error.retry_after().map(|wait| wait.as_secs());
            return Ok(settled);
        }
        Err(error) => return Err(error),
    };
    let mut conn = core.conn()?;
    let tx = conn.transaction()?;
    same_attempt(&tx, row)?;
    check_read_back(&tx, &read)?;
    // The checked response must be admitted under the pin and waiting work
    // that move from the local identity in this same transaction.
    if let Some(local) = row.item_id.as_deref() {
        drop_projected_edges(&tx, row, local, None)?;
    }
    let refused = store::land_on_held_row(&tx, row, id)?;
    apply_read_back_unchecked(&tx, &read)?;
    let catalog = crate::catalog::load(&tx)?;
    // The read-back lays nothing over a later row the copy already holds, so
    // the work moved onto the server's id above is laid over it here.
    store::lay_waiting_writes_over(&tx, id, &|laid| catalog.indexing(laid))?;
    store::settle_read_back(&tx, Subject::Item, id)?;
    store::meta_delete(&tx, &receipt_key(&row.id))?;
    tx.commit()?;
    settled.also = refused
        .into_iter()
        .map(|(other, reason)| (other, Verdict::Refused, reason))
        .collect();
    Ok(settled)
}

pub(super) fn finish_counted(
    core: &Core,
    row: &QueuedWrite,
    refusals: i64,
    envelope: Option<String>,
) -> Result<Settled> {
    if refusals < store::CEILING {
        return Ok(Settled::plain(None, None, refusals));
    }
    let mut conn = core.conn()?;
    let tx = conn.transaction()?;
    same_attempt(&tx, row)?;
    store::record_verdict(
        &tx,
        &row.id,
        &store::Answered {
            verdict: Verdict::Dead,
            reason: None,
            answer: envelope.as_deref(),
            conflicted_copy_id: None,
        },
    )?;
    // Dead does not establish that this edit landed. Followers cannot treat
    // its optimistic value as content read from their newer server version.
    move_edits_back(&tx, row)?;
    tx.commit()?;
    Ok(Settled::plain(Some(Verdict::Dead), None, refusals))
}
