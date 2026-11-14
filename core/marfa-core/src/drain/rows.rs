//! Row writes in batches recorded before they go, so a resend is the same request.
//!
//! A batch is settled in one transaction: every write of it takes its verdict,
//! or none does.

use std::collections::{HashMap, HashSet};

use rusqlite::{Connection, params};
use serde_json::{Map, Value, json};

use super::{
    Classified, Readiness, Settled, limited_by_server, readiness, recorded, same_attempt,
    store_fault, unavailable, verdict_of,
};
use crate::error::CoreError;
use crate::http::{Answer, REQUEST_LIMIT};
use crate::model::{QueuedWrite, RowConflict, Verdict, WriteKind};
use crate::row_writes::{self, Op, Taken};
use crate::{Core, Result, store};
use marfa_rules::rows::MAX_OPERATIONS;

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
    let settled = |verdict: Option<Verdict>| {
        matches!(
            verdict,
            Some(Verdict::Accepted | Verdict::Merged | Verdict::Conflicted | Verdict::Refused)
        )
    };
    for next in after {
        if settled(standing.answers.get(&next.id).copied().flatten()) {
            continue;
        }
        let Some(next) = store::queued_write(&conn, &next.id)? else {
            continue;
        };
        if settled(next.verdict) {
            continue;
        }
        let same = next.kind == WriteKind::WriteRows
            && next.verdict.is_none()
            && standing.answers.get(&next.id).copied().flatten().is_none()
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

fn batch_of<'a>(lead: &'a QueuedWrite, members: &'a [QueuedWrite]) -> Vec<&'a QueuedWrite> {
    std::iter::once(lead).chain(members).collect()
}

/// Each write of the batch as it now stands, as a drain tells it.
fn told_as(
    core: &Core,
    writes: &[&QueuedWrite],
    settle: impl Fn(&QueuedWrite) -> Settled,
) -> Result<Vec<(Settled, crate::drain::DrainVerdict)>> {
    let conn = core.conn()?;
    writes
        .iter()
        .map(|write| {
            let now = store::queued_write(&conn, &write.id)?.unwrap_or_else(|| (*write).clone());
            let settled = settle(&now);
            let told = verdict_of(&now, &settled, now.answer.as_deref());
            Ok((settled, told))
        })
        .collect()
}

/// The first write's settlement, with the others told beside it.
fn lead_with_joined(mut told: Vec<(Settled, crate::drain::DrainVerdict)>) -> Result<Settled> {
    if told.is_empty() {
        return Err(CoreError::Store("a batch settled no write".into()));
    }
    let (mut lead, _) = told.remove(0);
    lead.joined = told.into_iter().map(|(_, told)| told).collect();
    Ok(lead)
}

/// `resent` where the batch went out before this request: only a refusal from
/// the key's record then says no attempt under the record wrote the batch.
pub(super) fn settle(
    core: &Core,
    row: &QueuedWrite,
    answer: &std::result::Result<Answer, CoreError>,
    class: Classified,
    resent: bool,
) -> Result<Settled> {
    let members = joined(&*core.conn()?, &row.id)?;
    let writes = batch_of(row, &members);
    match (row.kind, &class, answer) {
        (WriteKind::UndoRows, Classified::Success, Ok(answer)) => {
            match undo_answer(row, &answer.body) {
                Ok(()) => undone(core, row, Some(answer)),
                Err(why) => counted(core, &writes, Some(&answer.body), Some(why)),
            }
        }
        (WriteKind::UndoRows, Classified::Delivered, Ok(_)) => undone(core, row, None),
        (WriteKind::WriteRows, Classified::Success, Ok(answer)) => {
            match rows_answer(&writes, &answer.body) {
                Ok(read) => taken(core, &writes, Some((answer, read))),
                Err(why) => counted(core, &writes, Some(&answer.body), Some(why)),
            }
        }
        (WriteKind::WriteRows, Classified::Delivered, Ok(_)) => taken(core, &writes, None),
        (WriteKind::WriteRows, Classified::Contract, Ok(refused)) => {
            match operation_of(refused, &writes).filter(|_| !resent || refused.replayed) {
                Some(at) => split(core, &writes, refused, at),
                None => whole(core, &writes, answer, class),
            }
        }
        _ => whole(core, &writes, answer, class),
    }
}

struct RowsAnswer {
    batch: Option<String>,
    last_activity_at: Option<Value>,
    results: Vec<Value>,
}

fn valid_id(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .filter(|id| marfa_rules::validation::id("id", id).is_ok())
}

fn answer_object(body: &str) -> std::result::Result<Map<String, Value>, String> {
    match serde_json::from_str::<Value>(body) {
        Ok(Value::Object(answer)) => Ok(answer),
        Ok(_) => Err("the answer is not an object".into()),
        Err(error) => Err(format!("the answer is not JSON: {error}")),
    }
}

fn answered_batch(answer: &Map<String, Value>) -> std::result::Result<Option<String>, String> {
    match answer.get("batch") {
        Some(Value::Null) => Ok(None),
        batch => valid_id(batch)
            .map(|batch| Some(batch.to_string()))
            .ok_or_else(|| "the answer names no batch".into()),
    }
}

fn rows_answer(writes: &[&QueuedWrite], body: &str) -> std::result::Result<RowsAnswer, String> {
    let answer = answer_object(body)?;
    let results = answer
        .get("results")
        .and_then(Value::as_array)
        .ok_or("the answer holds no results")?;
    let ops: Vec<Op> = writes
        .iter()
        .map(|write| row_writes::queued_ops(&write.body))
        .collect::<Result<Vec<_>>>()
        .map_err(|error| error.to_string())?
        .into_iter()
        .flatten()
        .collect();
    if results.len() != ops.len() {
        return Err(format!(
            "the answer holds {} results for {} operations",
            results.len(),
            ops.len()
        ));
    }
    let mut changed = false;
    for (at, (result, op)) in results.iter().zip(&ops).enumerate() {
        let outcome = result.get("outcome").and_then(Value::as_str);
        let fits = match op {
            Op::Put { .. } => matches!(outcome, Some("created" | "replaced" | "unchanged")),
            Op::Patch { .. } => matches!(outcome, Some("patched" | "unchanged")),
            Op::Delete { .. } => matches!(outcome, Some("deleted" | "absent")),
        };
        if result.get("id").and_then(Value::as_str) != Some(op.id()) || !fits {
            return Err(format!(
                "result {at} does not answer operation {at}, {} of row {}",
                op.name(),
                op.id()
            ));
        }
        changed |= !matches!(outcome, Some("unchanged" | "absent"));
    }
    let batch = answered_batch(&answer)?;
    if batch.is_some() != changed {
        return Err(if changed {
            "the answer names no batch for the rows it changed".into()
        } else {
            "the answer names a batch that changed no row".into()
        });
    }
    Ok(RowsAnswer {
        batch,
        last_activity_at: answer.get("last_activity_at").cloned(),
        results: results.clone(),
    })
}

fn undo_answer(row: &QueuedWrite, body: &str) -> std::result::Result<(), String> {
    let answer = answer_object(body)?;
    let results = answer
        .get("results")
        .and_then(Value::as_array)
        .ok_or("the answer holds no results")?;
    for (at, result) in results.iter().enumerate() {
        let outcome = result.get("outcome").and_then(Value::as_str);
        if valid_id(result.get("id")).is_none()
            || !matches!(
                outcome,
                Some("created" | "replaced" | "deleted" | "unchanged")
            )
        {
            return Err(format!("result {at} is not a row an undo answers"));
        }
    }
    if answered_batch(&answer)?.is_some()
        && answer.get("undoes").and_then(Value::as_str)
            != row.body.get("batch").and_then(Value::as_str)
    {
        return Err("the answer undoes another batch".into());
    }
    Ok(())
}

/// `answer` is `None` where the server kept no answer to repeat.
fn undone(core: &Core, row: &QueuedWrite, answer: Option<&Answer>) -> Result<Settled> {
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
                answer: answer.map(|answer| answer.body.as_str()),
                conflicted_copy_id: None,
            },
        )?;
        tx.commit()?;
        Ok(())
    })?;
    Ok(Settled {
        replayed: answer.is_none_or(|answer| answer.replayed),
        ..Settled::plain(Some(Verdict::Accepted), None, row.refusals)
    })
}

/// One refusal counted against each write, and `dead` at the ceiling.
pub(super) fn counted(
    core: &Core,
    writes: &[&QueuedWrite],
    envelope: Option<&str>,
    reason: Option<String>,
) -> Result<Settled> {
    let ends = recorded(core, || {
        let mut conn = core.conn()?;
        let tx = conn.transaction()?;
        let mut ends = Vec::with_capacity(writes.len());
        for write in writes {
            same_attempt(&tx, write)?;
            let refusals = store::count_refusal(&tx, &write.id)?;
            let dead = refusals >= store::CEILING;
            if dead {
                store::record_verdict(
                    &tx,
                    &write.id,
                    &store::Answered {
                        verdict: Verdict::Dead,
                        reason: None,
                        answer: envelope,
                        conflicted_copy_id: None,
                    },
                )?;
            }
            ends.push((write.id.clone(), refusals, dead));
        }
        row_writes::flush(&tx)?;
        tx.commit()?;
        Ok(ends)
    })?;
    let told = told_as(core, writes, |now| {
        let (_, refusals, dead) = ends
            .iter()
            .find(|(id, _, _)| *id == now.id)
            .cloned()
            .unwrap_or((now.id.clone(), now.refusals, false));
        if dead {
            Settled::plain(Some(Verdict::Dead), None, refusals)
        } else {
            Settled::plain(None, reason.clone(), refusals)
        }
    })?;
    lead_with_joined(told)
}

/// `answer` is `None` where the server kept no answer to repeat.
fn taken(
    core: &Core,
    writes: &[&QueuedWrite],
    answer: Option<(&Answer, RowsAnswer)>,
) -> Result<Settled> {
    let lead = writes[0];
    let (answered, read) = match answer {
        Some((answered, read)) => (Some(answered), Some(read)),
        None => (None, None),
    };
    let batch = read.as_ref().and_then(|read| read.batch.as_deref());
    let counts: Vec<usize> = writes
        .iter()
        .map(|write| operations_of(write).len())
        .collect();
    let mut shares: Vec<&[Value]> = Vec::with_capacity(writes.len());
    let mut from = 0;
    for count in &counts {
        shares.push(
            read.as_ref()
                .and_then(|read| read.results.get(from..from + count))
                .unwrap_or(&[]),
        );
        from += count;
    }
    let item = lead.item_id.as_deref().unwrap_or_default();
    let table = lead.table.as_deref().unwrap_or_default();
    let verdicts = recorded(core, || {
        let mut conn = core.conn()?;
        let tx = conn.transaction()?;
        for write in writes {
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
            if let Some(error) = store_fault(write) {
                return Err(error);
            }
            let verdict = if conflicts.is_empty() {
                Verdict::Accepted
            } else {
                Verdict::Conflicted
            };
            let own = read.as_ref().map(|read| {
                json!({
                    "batch": batch,
                    "last_activity_at": read.last_activity_at,
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
            verdicts.push((write.id.clone(), verdict, conflicts));
        }
        row_writes::flush(&tx)?;
        tx.commit()?;
        Ok(verdicts)
    })?;
    let replayed = answered.is_none_or(|answered| answered.replayed);
    let conflicts_of = |id: &str| -> (Verdict, Vec<RowConflict>) {
        verdicts
            .iter()
            .find(|(write, _, _)| write == id)
            .map(|(_, verdict, conflicts)| (*verdict, conflicts.clone()))
            .unwrap_or((Verdict::Accepted, Vec::new()))
    };
    let told = told_as(core, writes, |now| {
        let (verdict, conflicts) = conflicts_of(&now.id);
        Settled {
            replayed,
            conflicts,
            ..Settled::plain(Some(verdict), None, now.refusals)
        }
    })?;
    lead_with_joined(told)
}

/// The operation a refusal names, where it is one of the batch's.
fn operation_of(refused: &Answer, writes: &[&QueuedWrite]) -> Option<usize> {
    let body: Value = serde_json::from_str(&refused.body).ok()?;
    let at = usize::try_from(body.pointer("/error/details/operation")?.as_u64()?).ok()?;
    let total: usize = writes.iter().map(|write| operations_of(write).len()).sum();
    (at < total).then_some(at)
}

fn renumbered_path(path: &str, at: usize, local: usize) -> Option<String> {
    let rest = path.strip_prefix("operations.")?;
    let rest = rest.strip_prefix(&at.to_string())?;
    (rest.is_empty() || rest.starts_with('.')).then(|| format!("operations.{local}{rest}"))
}

fn renumber(envelope: &mut Value, at: usize, local: usize) {
    let Some(error) = envelope.get_mut("error") else {
        return;
    };
    let mut first = None;
    if let Some(errors) = error
        .pointer_mut("/details/errors")
        .and_then(Value::as_array_mut)
    {
        for (index, entry) in errors.iter_mut().enumerate() {
            let Some(path) = entry.get("path").and_then(Value::as_str) else {
                continue;
            };
            let Some(renumbered) = renumbered_path(path, at, local) else {
                continue;
            };
            if index == 0 {
                first = Some((
                    path.to_string(),
                    renumbered.clone(),
                    entry.get("message").cloned(),
                ));
            }
            entry["path"] = json!(renumbered);
        }
    }
    if let Some(operation) = error.pointer_mut("/details/operation") {
        *operation = json!(local);
    }
    let Some((was, now, Some(Value::String(problem)))) = first else {
        return;
    };
    if error.get("message").and_then(Value::as_str) == Some(format!("{was}: {problem}").as_str()) {
        error["message"] = json!(format!("{now}: {problem}"));
    }
}

/// The server wrote none of the batch, so only the named write is refused.
fn split(core: &Core, writes: &[&QueuedWrite], refused: &Answer, at: usize) -> Result<Settled> {
    let lead = writes[0];
    let mut from = 0;
    let mut owner = (0, 0);
    for (index, write) in writes.iter().enumerate() {
        let count = operations_of(write).len();
        if at < from + count {
            owner = (index, at - from);
            break;
        }
        from += count;
    }
    let (owner, local) = owner;
    let mut envelope: Value = serde_json::from_str(&refused.body)?;
    renumber(&mut envelope, at, local);
    let envelope = envelope.to_string();
    let code = if refused.code.is_empty() {
        "unknown".to_string()
    } else {
        refused.code.clone()
    };
    recorded(core, || {
        let mut conn = core.conn()?;
        let tx = conn.transaction()?;
        for write in writes {
            same_attempt(&tx, write)?;
            if let Some(error) = store_fault(write) {
                return Err(error);
            }
        }
        unjoin(&tx, writes)?;
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
                row_writes::spend_key(&tx, &write.id)?;
            }
        }
        row_writes::flush(&tx)?;
        tx.commit()?;
        Ok(())
    })?;
    let refused_write = store::queued_write(&*core.conn()?, &writes[owner].id)?
        .unwrap_or_else(|| writes[owner].clone());
    let refusal = Settled::plain(
        Some(Verdict::Refused),
        Some(code.clone()),
        refused_write.refusals,
    );
    if owner == 0 {
        return Ok(refusal);
    }
    Ok(Settled {
        again: true,
        joined: vec![verdict_of(
            &refused_write,
            &refusal,
            refused_write.answer.as_deref(),
        )],
        ..Settled::plain(None, None, lead.refusals)
    })
}

/// Each write as the answer settles one sent on its own.
fn whole(
    core: &Core,
    writes: &[&QueuedWrite],
    answer: &std::result::Result<Answer, CoreError>,
    class: Classified,
) -> Result<Settled> {
    let envelope = answer.as_ref().ok().map(|answer| answer.body.as_str());
    let (verdict, reason) = match &class {
        Classified::Environmental => {
            let retry_after_seconds = answer
                .as_ref()
                .err()
                .and_then(CoreError::retry_after)
                .map(|wait| wait.as_secs());
            let told = told_as(core, writes, |now| Settled {
                retry_after_seconds,
                unavailable: unavailable(answer),
                limited: limited_by_server(answer),
                ..Settled::plain(None, None, now.refusals)
            })?;
            return lead_with_joined(told);
        }
        Classified::Contract => (
            Verdict::Refused,
            answer
                .as_ref()
                .ok()
                .map(|answer| answer.code.clone())
                .filter(|code| !code.is_empty())
                .unwrap_or_else(|| "unknown".into()),
        ),
        Classified::Block(reason) | Classified::BlockQueue(reason) => {
            (Verdict::Blocked, reason.as_str().to_string())
        }
        _ => return counted(core, writes, envelope, None),
    };
    recorded(core, || {
        let mut conn = core.conn()?;
        let tx = conn.transaction()?;
        for write in writes {
            same_attempt(&tx, write)?;
            if let Some(error) = store_fault(write) {
                return Err(error);
            }
            store::record_verdict(
                &tx,
                &write.id,
                &store::Answered {
                    verdict,
                    reason: Some(&reason),
                    answer: envelope,
                    conflicted_copy_id: None,
                },
            )?;
        }
        row_writes::flush(&tx)?;
        tx.commit()?;
        Ok(())
    })?;
    let stops_the_drain = matches!(class, Classified::BlockQueue(_));
    let told = told_as(core, writes, |now| Settled {
        stops_the_drain,
        ..Settled::plain(Some(verdict), Some(reason.clone()), now.refusals)
    })?;
    lead_with_joined(told)
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::{renumber, renumbered_path};

    #[test]
    fn a_path_is_renumbered_only_where_it_names_the_refused_operation() {
        assert_eq!(
            renumbered_path("operations.5", 5, 0).as_deref(),
            Some("operations.0")
        );
        assert_eq!(
            renumbered_path("operations.5.values.qty", 5, 1).as_deref(),
            Some("operations.1.values.qty")
        );
        assert_eq!(renumbered_path("operations.50.values", 5, 0), None);
        assert_eq!(renumbered_path("operations.4.values", 5, 0), None);
        assert_eq!(renumbered_path("operations", 5, 0), None);
        assert_eq!(renumbered_path("values.operations.5", 5, 0), None);
    }

    #[test]
    fn a_refusal_is_numbered_in_its_details_paths_and_message() {
        let mut envelope = json!({"error": {
            "code": "validation_error",
            "message": "operations.5.values.qty: The table declares no such column",
            "details": {"operation": 5, "errors": [
                {"path": "operations.5.values.qty", "message": "The table declares no such column"},
                {"path": "operations.7.values.qty", "message": "Another operation's"},
            ]},
        }});
        renumber(&mut envelope, 5, 0);
        assert_eq!(
            envelope,
            json!({"error": {
                "code": "validation_error",
                "message": "operations.0.values.qty: The table declares no such column",
                "details": {"operation": 0, "errors": [
                    {"path": "operations.0.values.qty", "message": "The table declares no such column"},
                    {"path": "operations.7.values.qty", "message": "Another operation's"},
                ]},
            }})
        );
    }

    #[test]
    fn a_message_the_server_did_not_build_from_the_path_is_left_as_it_was() {
        let mut envelope: Value = json!({"error": {
            "code": "row_not_found",
            "message": "The table holds no row with this id.",
            "details": {"operation": 3, "id": "x"},
        }});
        renumber(&mut envelope, 3, 1);
        assert_eq!(
            envelope,
            json!({"error": {
                "code": "row_not_found",
                "message": "The table holds no row with this id.",
                "details": {"operation": 1, "id": "x"},
            }})
        );
    }
}
