//! Row writes in batches recorded before they go, so a resend is the same request.

use std::collections::{HashMap, HashSet};

use rusqlite::{Connection, params};
use serde_json::{Value, json};
use uuid::Uuid;

use super::{
    Classified, ReachChange, Readiness, Settled, Shape, readiness, recorded, same_attempt,
    verdict_of,
};
use crate::error::CoreError;
use crate::http::{Answer, REQUEST_LIMIT};
use crate::model::{QueuedWrite, RowConflict, Verdict, WriteKind};
use crate::row_writes::{self, MAX_OPERATIONS, Taken};
use crate::{Core, Result, store};

pub(super) struct Standing<'a> {
    pub rows: &'a HashMap<&'a str, &'a QueuedWrite>,
    pub answers: &'a HashMap<String, Option<Verdict>>,
    pub waiting: &'a HashSet<String>,
    pub landing: &'a HashMap<String, String>,
}

fn operations_of(write: &QueuedWrite) -> Vec<Value> {
    write
        .body
        .get("operations")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

pub(super) fn joined(conn: &Connection, lead: &str) -> Result<Vec<QueuedWrite>> {
    store::read_writes(conn, "WHERE batched_with = ?1", [lead])
}

/// As sent, or the ready row writes to the table queued straight after it.
pub(super) fn gather(
    core: &Core,
    lead: &QueuedWrite,
    after: &[QueuedWrite],
    standing: &Standing<'_>,
) -> Result<Vec<QueuedWrite>> {
    let conn = core.conn()?;
    if lead.kind != WriteKind::WriteRows {
        return Ok(Vec::new());
    }
    if !store::unsent(&conn, &lead.id)? {
        return joined(&conn, &lead.id);
    }
    let limit =
        store::request_limit(&conn)?.map_or(REQUEST_LIMIT, |limit| limit.min(REQUEST_LIMIT));
    let mut operations = operations_of(lead).len();
    let mut bytes = lead.body.to_string().len();
    let mut members = Vec::new();
    for next in after {
        if standing
            .answers
            .get(&next.id)
            .and_then(Option::as_ref)
            .is_some()
        {
            continue;
        }
        let Some(next) = store::queued_write(&conn, &next.id)? else {
            continue;
        };
        if next.verdict.is_some() {
            continue;
        }
        let same = next.kind == WriteKind::WriteRows
            && next.item_id == lead.item_id
            && next.table == lead.table
            && next.batched_with.is_none()
            && store::unsent(&conn, &next.id)?;
        let ready = same
            && matches!(
                readiness(
                    &next,
                    standing.rows,
                    standing.answers,
                    standing.waiting,
                    standing.landing,
                    false,
                ),
                Readiness::Ready
            );
        if !ready {
            break;
        }
        let more = operations_of(&next).len();
        let size = next.body.to_string().len();
        if operations + more > MAX_OPERATIONS || bytes + size > limit {
            break;
        }
        operations += more;
        bytes += size;
        members.push(next);
    }
    Ok(members)
}

pub(super) fn body(lead: &QueuedWrite, members: &[QueuedWrite]) -> String {
    let operations: Vec<Value> = std::iter::once(lead)
        .chain(members)
        .flat_map(operations_of)
        .collect();
    json!({ "operations": operations }).to_string()
}

/// In the transaction that marks `lead` sent.
pub(super) fn mark_joined(
    conn: &Connection,
    lead: &QueuedWrite,
    members: &[QueuedWrite],
) -> Result<()> {
    for member in members {
        conn.execute(
            "UPDATE queue SET batched_with = ?2 WHERE id = ?1",
            params![member.id, lead.id],
        )?;
        store::mark_sent(conn, &member.id)?;
    }
    Ok(())
}

fn unjoin(conn: &Connection, writes: &[&QueuedWrite]) -> Result<()> {
    for write in writes {
        conn.execute(
            "UPDATE queue SET batched_with = NULL WHERE id = ?1",
            [&write.id],
        )?;
    }
    Ok(())
}

pub(super) fn settle(
    core: &Core,
    row: &QueuedWrite,
    answer: &std::result::Result<Answer, CoreError>,
    class: Classified,
    pass: &mut ReachChange,
) -> Result<Settled> {
    let members = joined(&*core.conn()?, &row.id)?;
    match (row.kind, &class, answer) {
        (WriteKind::UndoRows, Classified::Success | Classified::Delivered, Ok(answer)) => {
            undone(core, row, answer)
        }
        (WriteKind::WriteRows, Classified::Success, Ok(answer)) => {
            taken(core, row, &members, Some(answer))
        }
        (WriteKind::WriteRows, Classified::Delivered, Ok(_)) => taken(core, row, &members, None),
        (WriteKind::WriteRows, Classified::Contract, Ok(refused)) => match operation_of(refused) {
            Some(at) => split(core, row, &members, refused, at),
            None => whole(core, row, &members, answer, class, pass),
        },
        _ => whole(core, row, &members, answer, class, pass),
    }
}

fn undone(core: &Core, row: &QueuedWrite, answer: &Answer) -> Result<Settled> {
    let body = (!answer.body.is_empty()).then_some(answer.body.as_str());
    recorded(core, || {
        let mut conn = core.conn()?;
        let tx = conn.transaction()?;
        same_attempt(&tx, row)?;
        store::record_verdict(
            &tx,
            &row.id,
            &store::Answered {
                verdict: Verdict::Accepted,
                reason: None,
                answer: body,
                conflicted_copy_id: None,
            },
        )?;
        tx.commit()?;
        Ok(())
    })?;
    Ok(Settled {
        replayed: answer.replayed,
        ..Settled::plain(Some(Verdict::Accepted), None, row.refusals)
    })
}

/// `answer` is `None` where the server kept no answer to repeat.
fn taken(
    core: &Core,
    lead: &QueuedWrite,
    members: &[QueuedWrite],
    answer: Option<&Answer>,
) -> Result<Settled> {
    let parsed: Value = answer
        .and_then(|answer| serde_json::from_str(&answer.body).ok())
        .unwrap_or(Value::Null);
    let batch = parsed.get("batch").and_then(Value::as_str);
    let results = parsed
        .get("results")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let writes: Vec<&QueuedWrite> = std::iter::once(lead).chain(members).collect();
    let counts: Vec<usize> = writes
        .iter()
        .map(|write| operations_of(write).len())
        .collect();
    let results = if results.len() == counts.iter().sum::<usize>() {
        results
    } else {
        Vec::new()
    };
    let mut shares: Vec<&[Value]> = Vec::with_capacity(writes.len());
    let mut from = 0;
    for count in &counts {
        shares.push(results.get(from..from + count).unwrap_or(&[]));
        from += count;
    }
    let item = lead.item_id.as_deref().unwrap_or_default();
    let table = lead.table.as_deref().unwrap_or_default();
    let verdicts = recorded(core, || {
        let mut conn = core.conn()?;
        let tx = conn.transaction()?;
        for write in &writes {
            same_attempt(&tx, write)?;
        }
        #[cfg(debug_assertions)]
        crate::fault::gate("gate-drain-receipt");
        let takens: Vec<Taken<'_>> = writes
            .iter()
            .zip(&shares)
            .map(|(write, results)| Taken { write, results })
            .collect();
        let conflicts = row_writes::taken(&tx, item, table, batch, &takens)?;
        let mut verdicts = Vec::with_capacity(writes.len());
        for ((write, results), conflicts) in writes.iter().zip(&shares).zip(conflicts) {
            let verdict = if conflicts.is_empty() {
                Verdict::Accepted
            } else {
                Verdict::Conflicted
            };
            let own = answer.map(|_| {
                json!({
                    "batch": batch,
                    "last_activity_at": parsed.get("last_activity_at"),
                    "results": results,
                })
                .to_string()
            });
            store::record_verdict(
                &tx,
                &write.id,
                &store::Answered {
                    verdict,
                    reason: None,
                    answer: own.as_deref(),
                    conflicted_copy_id: None,
                },
            )?;
            let named = (!conflicts.is_empty())
                .then(|| serde_json::to_string(&conflicts))
                .transpose()?;
            tx.execute(
                "UPDATE queue SET conflicts = ?2 WHERE id = ?1",
                params![write.id, named],
            )?;
            verdicts.push((verdict, conflicts));
        }
        row_writes::flush(&tx)?;
        tx.commit()?;
        Ok(verdicts)
    })?;
    let replayed = answer.is_none_or(|answer| answer.replayed);
    let told = |write: &QueuedWrite, verdict: Verdict, conflicts: Vec<RowConflict>| -> Result<_> {
        let now = store::queued_write(&*core.conn()?, &write.id)?.unwrap_or_else(|| write.clone());
        let mut told = verdict_of(
            &now,
            &Settled {
                replayed,
                ..Settled::plain(Some(verdict), None, now.refusals)
            },
            now.answer.as_deref(),
        );
        told.conflicts = conflicts;
        Ok(told)
    };
    let mut verdicts = verdicts.into_iter();
    let (verdict, conflicts) = verdicts
        .next()
        .ok_or_else(|| CoreError::Store("a batch's answer settled no write".into()))?;
    let joined = members
        .iter()
        .zip(verdicts)
        .map(|(member, (verdict, conflicts))| told(member, verdict, conflicts))
        .collect::<Result<_>>()?;
    Ok(Settled {
        replayed,
        conflicts,
        joined,
        ..Settled::plain(Some(verdict), None, lead.refusals)
    })
}

fn operation_of(refused: &Answer) -> Option<usize> {
    let body: Value = serde_json::from_str(&refused.body).ok()?;
    let at = body.pointer("/error/details/operation")?.as_u64()?;
    usize::try_from(at).ok()
}

/// The server wrote none of the batch, so only the named write is refused.
fn split(
    core: &Core,
    lead: &QueuedWrite,
    members: &[QueuedWrite],
    refused: &Answer,
    at: usize,
) -> Result<Settled> {
    let writes: Vec<&QueuedWrite> = std::iter::once(lead).chain(members).collect();
    let mut from = 0;
    let mut owner = None;
    for (index, write) in writes.iter().enumerate() {
        let count = operations_of(write).len();
        if at < from + count {
            owner = Some((index, at - from));
            break;
        }
        from += count;
    }
    let Some((owner, local)) = owner else {
        return Err(CoreError::Store(format!(
            "the server refused operation {at} of a batch of {from}"
        )));
    };
    let mut envelope: Value = serde_json::from_str(&refused.body)?;
    if let Some(operation) = envelope.pointer_mut("/error/details/operation") {
        *operation = json!(local);
    }
    let envelope = envelope.to_string();
    let code = if refused.code.is_empty() {
        "unknown".to_string()
    } else {
        refused.code.clone()
    };
    recorded(core, || {
        let mut conn = core.conn()?;
        let tx = conn.transaction()?;
        for write in &writes {
            same_attempt(&tx, write)?;
        }
        unjoin(&tx, &writes)?;
        store::record_verdict(
            &tx,
            &writes[owner].id,
            &store::Answered {
                verdict: Verdict::Refused,
                reason: Some(&code),
                answer: Some(&envelope),
                conflicted_copy_id: None,
            },
        )?;
        for (index, write) in writes.iter().enumerate() {
            if index == owner {
                continue;
            }
            store::mark_unsent(&tx, &write.id)?;
            if index == 0 {
                spend_key(&tx, write)?;
            }
        }
        row_writes::flush(&tx)?;
        tx.commit()?;
        Ok(())
    })?;
    let refused_write = store::queued_write(&*core.conn()?, &writes[owner].id)?
        .unwrap_or_else(|| writes[owner].clone());
    let told = verdict_of(
        &refused_write,
        &Settled::plain(
            Some(Verdict::Refused),
            Some(code.clone()),
            refused_write.refusals,
        ),
        refused_write.answer.as_deref(),
    );
    if owner == 0 {
        return Ok(Settled::plain(
            Some(Verdict::Refused),
            Some(code),
            lead.refusals,
        ));
    }
    Ok(Settled {
        again: true,
        joined: vec![told],
        ..Settled::plain(None, None, lead.refusals)
    })
}

/// Kept so a late answer to the refused batch is not read as the next one's.
fn spend_key(conn: &Connection, write: &QueuedWrite) -> Result<()> {
    let spent: Option<String> = conn.query_row(
        "SELECT spent_keys FROM queue WHERE id = ?1",
        [&write.id],
        |row| row.get(0),
    )?;
    let mut keys: Vec<String> = match spent {
        Some(json) => serde_json::from_str(&json)?,
        None => Vec::new(),
    };
    keys.push(write.idempotency_key.clone());
    conn.execute(
        "UPDATE queue SET spent_keys = ?2, idempotency_key = ?3 WHERE id = ?1",
        params![
            write.id,
            serde_json::to_string(&keys)?,
            Uuid::now_v7().to_string()
        ],
    )?;
    Ok(())
}

/// Settles each write as one sent alone.
fn whole(
    core: &Core,
    lead: &QueuedWrite,
    members: &[QueuedWrite],
    answer: &std::result::Result<Answer, CoreError>,
    class: Classified,
    pass: &mut ReachChange,
) -> Result<Settled> {
    let mut settled = super::settle(core, lead, answer, class.clone(), Shape::Rows, pass)?;
    for member in members {
        let own = super::settle(core, member, answer, class.clone(), Shape::Rows, pass)?;
        let now =
            store::queued_write(&*core.conn()?, &member.id)?.unwrap_or_else(|| member.clone());
        settled
            .joined
            .push(verdict_of(&now, &own, now.answer.as_deref()));
    }
    if settled.verdict.is_some() {
        let writes: Vec<&QueuedWrite> = std::iter::once(lead).chain(members).collect();
        let mut conn = core.conn()?;
        let tx = conn.transaction()?;
        unjoin(&tx, &writes)?;
        row_writes::flush(&tx)?;
        tx.commit()?;
    }
    Ok(settled)
}
