//! How an answer to a write is read: its class, what it says about the server, and the streaks that set a write aside.

use std::collections::{HashMap, HashSet};

use super::address::{Readiness, held_back, readiness};
use super::report::{DrainReport, DrainVerdict};
use super::rows;
use super::settle::{Settled, move_edits_back, verdict_of};
use crate::error::CoreError;
use crate::http::Answer;
use crate::model::{BlockedReason, LastFailure, QueuedWrite, Refusal, Verdict, WriteKind};
use crate::store;
use crate::{Core, Result};

#[derive(Debug, Clone, PartialEq)]
pub(super) enum Classified {
    Success,
    Environmental,
    Contract,
    Counted,
    Block(BlockedReason),
    BlockQueue(BlockedReason),
    /// The create's natural key resolved the held row `id`.
    Landed {
        id: String,
        code: String,
    },
    Unclaimed {
        source: String,
    },
    Trashed,
    /// The write ran, and the server kept no answer to repeat, or a guarded
    /// write's refusal shows the server holds what the write leaves.
    Delivered,
}

/// The drains in a row in which a write meets an environmental failure
/// before the drain asks whether it fails alone.
pub(super) const ENVIRONMENTAL_STREAK: i64 = 3;

/// How long a streak has run, from its first failure, before the drain asks
/// whether the write fails alone: a gateway that restarts or flaps for a few
/// minutes is over before it counts.
pub(super) const STREAK_FLOOR_MILLIS: i64 = 5 * 60 * 1000;

/// Why a write is sent at this point of the pass.
#[derive(Clone, Copy, PartialEq)]
pub(super) enum Role {
    /// Its place in the queue.
    Walk,
    /// Out of queue order, to learn whether the server answers a write that
    /// does not depend on the suspect.
    Test,
    /// The suspect again, once the server has answered its test.
    Resend,
}

/// Where a suspect stands.
#[derive(Clone, Copy, PartialEq)]
pub(super) enum Phase {
    /// Waiting for a write to test it.
    Testing,
    /// A write has landed, so the suspect is sent once more.
    Resending,
}

/// A write that has met an environmental failure in three drains in a row, the
/// first five minutes ago, and so is asked about: whether the server answers a
/// write that does not depend on it, and then takes this one.
pub(super) struct Suspect {
    pub(super) id: String,
    pub(super) key: String,
    /// Where the write stands in the queue the pass read.
    pub(super) at: usize,
    pub(super) unavailable: String,
    pub(super) limited: bool,
    /// Where the write's entry stands in the report's verdicts.
    pub(super) verdict_at: usize,
    pub(super) phase: Phase,
}

/// What a pass has decided so far, which says which writes are ready.
pub(super) struct Standing<'a> {
    pub(super) rows: &'a HashMap<&'a str, &'a QueuedWrite>,
    pub(super) answers: &'a HashMap<String, Option<Verdict>>,
    pub(super) waiting: &'a HashSet<String>,
    pub(super) landing: &'a HashMap<String, String>,
}

/// The write that tests a suspect: of the writes from `from` on that are ready
/// and depend on no write ahead of them that has not been sent, the one sent
/// least recently, by the number of its send. A write never sent counts as the
/// least recent, and a tie goes to the earlier in the queue. Its streak does
/// not decide, so the test moves through the queue and a stuck write cannot
/// hold it for good.
pub(super) fn next_test(
    core: &Core,
    all: &[QueuedWrite],
    from: usize,
    tested: &HashSet<String>,
    standing: &Standing,
) -> Result<Option<usize>> {
    let mut ahead = standing.waiting.clone();
    let mut ready: Vec<(Option<i64>, usize, QueuedWrite)> = Vec::new();
    for (at, candidate) in all.iter().enumerate().skip(from) {
        if tested.contains(&candidate.id)
            || standing
                .answers
                .get(&candidate.id)
                .and_then(Option::as_ref)
                .is_some()
        {
            continue;
        }
        let current = store::queued_write(&*core.conn()?, &candidate.id)?;
        let candidate = current.as_ref().unwrap_or(candidate);
        if candidate.verdict.is_none()
            && matches!(
                readiness(
                    candidate,
                    standing.rows,
                    standing.answers,
                    &ahead,
                    standing.landing,
                    held_back(&*core.conn()?, candidate)?,
                ),
                Readiness::Ready
            )
        {
            let sent = store::last_sent_seq(&*core.conn()?, &candidate.id)?;
            ready.push((sent, at, candidate.clone()));
        }
        // Chosen or not, a later write on the same subject is not sent ahead
        // of it.
        ahead.insert(candidate.id.clone());
    }
    // `None` orders before every number, and the sort is stable, so a tie
    // stays in queue order.
    ready.sort_by_key(|candidate| candidate.0);
    for (_, at, candidate) in ready {
        if crate::body::rule::lost_body(&*core.conn()?, &candidate)?.is_none() {
            return Ok(Some(at));
        }
    }
    Ok(None)
}

/// The pass ended before the suspect was sent again: it waits as any write
/// does that met an environmental failure. Its streak and last answer were
/// kept when it failed, so this counts it undelivered and no more.
pub(super) fn leave_waiting(stuck: &Suspect, report: &mut DrainReport) {
    report.undelivered += 1;
    if report.unavailable.is_none() {
        report.unavailable = Some(stuck.unavailable.clone());
        report.limited = stuck.limited;
    }
}

/// Puts the write's entry in place of the one it has, or last, answering
/// whether it had none.
pub(super) fn tell(report: &mut DrainReport, entry: DrainVerdict) -> bool {
    match report.verdicts.iter_mut().find(|told| told.id == entry.id) {
        Some(told) => {
            *told = entry;
            false
        }
        None => {
            report.verdicts.push(entry);
            true
        }
    }
}

/// Puts the write's entry in the report: in place of the one it already has,
/// where it has one, and last otherwise.
pub(super) fn put_verdict(report: &mut DrainReport, replacing: Option<usize>, entry: DrainVerdict) {
    match replacing.and_then(|at| report.verdicts.get_mut(at)) {
        Some(slot) => *slot = entry,
        None => report.verdicts.push(entry),
    }
}

/// Whether the server asked the caller to slow down, which says nothing of
/// the write that met it.
pub(super) fn rate_limited(answer: &std::result::Result<Answer, CoreError>) -> bool {
    match answer {
        Ok(answer) => answer.status == 429,
        Err(error) => error.is_rate_limited(),
    }
}

/// Whether the server itself limited the request, which is what a report's
/// `limited` says: a `429` naming no contract is something in front of it.
pub(super) fn limited_by_server(answer: &std::result::Result<Answer, CoreError>) -> bool {
    match answer {
        Ok(answer) => answer.status == 429 && answer.contract_named,
        Err(error) => error.is_limit_named(),
    }
}

/// How a limit reads in a drain's report, which waits for nothing itself.
pub(super) fn limiting(wait: Option<u64>) -> String {
    match held_to_most(wait) {
        Some(wait) => {
            format!("the server is limiting requests (429) and asked for a wait of {wait}s")
        }
        None => "the server is limiting requests (429)".into(),
    }
}

/// A wait the server asked for, never longer than a device waits.
pub(super) fn held_to_most(wait: Option<u64>) -> Option<u64> {
    wait.map(|wait| wait.min(crate::error::RETRY_AFTER_MOST.as_secs()))
}

/// Why the server could not say which instance it is.
pub(super) fn unconfirmed(error: &CoreError) -> String {
    if error.is_limit_named() {
        limiting(error.retry_after().map(|wait| wait.as_secs()))
    } else {
        format!("the server could not say which instance it is, so nothing was sent: {error}")
    }
}

/// Whether the failure came before the write was answered, from the credential
/// renewal or the device's own disk, and so says nothing of the write.
pub(super) fn not_the_writes(answer: &std::result::Result<Answer, CoreError>) -> bool {
    matches!(
        answer,
        Err(CoreError::RenewalFailed(_) | CoreError::StorageFull(_) | CoreError::Io(_))
    )
}

/// What a write met that was no answer to it: the server's status where it
/// answered, a rate limit's and a gateway's included.
pub(super) fn failure_of(answer: &std::result::Result<Answer, CoreError>) -> LastFailure {
    match answer {
        Ok(answer) => LastFailure::of(Some(answer.status), answer.body.as_bytes()),
        Err(CoreError::Unnamed { status, .. } | CoreError::Server { status, .. }) => {
            LastFailure::of(Some(*status), b"")
        }
        Err(CoreError::RateLimited { .. }) => LastFailure::of(Some(429), b""),
        Err(_) => LastFailure::of(None, b""),
    }
}

/// Sets the suspect aside as `failing_alone`: the server answered another
/// write that does not depend on it, and the suspect met the failure again, so
/// it is this write that cannot be taken. `failure` is what it met this time.
pub(super) fn set_aside(
    core: &Core,
    stuck: &Suspect,
    failure: &LastFailure,
    report: &mut DrainReport,
    answers: &mut HashMap<String, Option<Verdict>>,
) -> Result<()> {
    let set_aside = block_failing_alone(core, &stuck.id, &stuck.key, failure)?;
    let told = |write: &QueuedWrite| {
        verdict_of(
            write,
            &Settled::plain(
                Some(Verdict::Blocked),
                Some(BlockedReason::FailingAlone.as_str().into()),
                write.refusals,
            ),
            None,
        )
    };
    for (at, write) in set_aside.iter().enumerate() {
        answers.insert(write.id.clone(), Some(Verdict::Blocked));
        report.answered += 1;
        if at == 0 {
            if let Some(entry) = report.verdicts.get_mut(stuck.verdict_at) {
                *entry = told(write);
            }
        } else if !tell(report, told(write)) {
            // Told undelivered when the batch first met the failure this pass.
            report.undelivered = report.undelivered.saturating_sub(1);
        }
    }
    Ok(())
}

/// A verdict belongs only to the attempt that met the failure.
pub(super) fn block_failing_alone(
    core: &Core,
    id: &str,
    key: &str,
    failure: &LastFailure,
) -> Result<Vec<QueuedWrite>> {
    let mut conn = core.conn()?;
    let tx = conn.transaction()?;
    let Some(row) = store::queued_write(&tx, id)?
        .filter(|row| row.verdict.is_none() && row.idempotency_key == key)
    else {
        return Ok(Vec::new());
    };
    // The server may hold the batch under its key, so its writes stay together.
    let members = if row.kind == WriteKind::WriteRows {
        rows::joined(&tx, &row.id)?
    } else {
        Vec::new()
    };
    store::note_last_failure(&tx, &row.id, failure)?;
    for write in std::iter::once(&row).chain(&members) {
        store::record_verdict(
            &tx,
            &write.id,
            &store::Answered {
                verdict: Verdict::Blocked,
                reason: Some(BlockedReason::FailingAlone.as_str()),
                answer: None,
                conflicted_copy_id: None,
            },
        )?;
    }
    // The later edit read this edit's optimistic fields, which will not reach
    // the server until a person releases it.
    move_edits_back(&tx, &row)?;
    crate::row_writes::flush(&tx)?;
    let mut set_aside = Vec::with_capacity(members.len() + 1);
    for write in std::iter::once(&row).chain(&members) {
        set_aside.push(store::queued_write(&tx, &write.id)?.unwrap_or_else(|| write.clone()));
    }
    tx.commit()?;
    Ok(set_aside)
}

/// Reads a create's answer again: a key that landed on a held row, an
/// unclaimed source, a trashed row and a lost answer to a create naming no
/// id cannot be told from the status and code alone.
pub(super) fn refine(
    row: &QueuedWrite,
    payload: &str,
    answer: &std::result::Result<Answer, CoreError>,
    class: Classified,
    resent: bool,
) -> Classified {
    let Ok(answer) = answer else {
        return class;
    };
    if matches!(
        row.kind,
        WriteKind::WriteExtension | WriteKind::DeleteExtension
    ) {
        return refine_extension(row, payload, answer, class, resent);
    }
    if row.kind != WriteKind::CreateItem {
        return class;
    }
    let sent = serde_json::from_str::<serde_json::Value>(payload).unwrap_or_default();
    let body = serde_json::from_str::<serde_json::Value>(&answer.body).unwrap_or_default();
    let keyed = sent
        .get("source_id")
        .is_some_and(serde_json::Value::is_string);
    match &class {
        // A keyed create names no id of its own, so an acknowledgment is
        // never a replay of this device's create. Taking it as `accepted`
        // would bind the file to a trashed row and drop what it holds.
        Classified::Success
            if keyed
                && body
                    .get("acknowledged")
                    .and_then(serde_json::Value::as_bool)
                    == Some(true)
                && body
                    .pointer("/item/state")
                    .and_then(serde_json::Value::as_str)
                    == Some("trashed") =>
        {
            Classified::Trashed
        }
        // A create carrying the id it minted resolves no row but that one.
        Classified::Block(
            BlockedReason::AncestorUnavailable | BlockedReason::ConflictUnresolved,
        ) if keyed => {
            match body
                .pointer("/current/id")
                .and_then(serde_json::Value::as_str)
            {
                Some(id) if Some(id) != row.item_id.as_deref() => Classified::Landed {
                    id: id.to_string(),
                    code: answer.code.clone(),
                },
                _ => class,
            }
        }
        // The source allow-list's refusal has the same status and code but
        // names the type beside the list, and no claim granted later clears
        // it. Only a refusal naming the source alone is the claim's.
        Classified::Contract if answer.status == 403 && answer.code == "forbidden" => {
            let named = body
                .pointer("/error/details")
                .and_then(serde_json::Value::as_object)
                .filter(|details| details.len() == 1)
                .and_then(|details| details.get("source"))
                .and_then(serde_json::Value::as_str);
            match named {
                Some(source)
                    if sent.get("source").and_then(serde_json::Value::as_str) == Some(source) =>
                {
                    Classified::Unclaimed {
                        source: source.to_string(),
                    }
                }
                _ => class,
            }
        }
        // A create naming no id lands on whatever row its key resolves, so
        // no read by id finds the row it wrote.
        Classified::Delivered if !sent.get("id").is_some_and(serde_json::Value::is_string) => {
            Classified::Contract
        }
        _ => class,
    }
}

/// A guarded extension write sent again after its answer was lost meets the
/// revision its own first send made. Where the namespace now holds what the
/// write leaves, the first send took.
fn refine_extension(
    row: &QueuedWrite,
    payload: &str,
    answer: &Answer,
    class: Classified,
    resent: bool,
) -> Classified {
    if !resent || class != Classified::Block(BlockedReason::ConflictUnresolved) {
        return class;
    }
    let body = serde_json::from_str::<serde_json::Value>(&answer.body).unwrap_or_default();
    let Some(held) = body.pointer("/current/document") else {
        return class;
    };
    let holds = if row.kind == WriteKind::WriteExtension {
        serde_json::from_str::<serde_json::Value>(payload)
            .is_ok_and(|sent| marfa_rules::conflict::same(held, &sent))
    } else {
        held.is_null()
    };
    if holds { Classified::Delivered } else { class }
}

pub(super) fn classify(answer: &std::result::Result<Answer, CoreError>) -> Classified {
    let answer = match answer {
        Ok(answer) => answer,
        Err(error) if error.is_environmental() => return Classified::Environmental,
        // An answer on another contract never reaches here; the pass ends on
        // it first. Anything else is about the request, such as a header the
        // transport would not build, so it is counted and reaches the ceiling
        // rather than retrying forever.
        Err(_) => return Classified::Counted,
    };
    if answer.is_success() {
        return Classified::Success;
    }
    match (answer.status, answer.code.as_str()) {
        // Naming no contract, it says nothing of the write or the key: were
        // it counted, a proxy restarting under a watch that drains each
        // second would kill every queued write within seconds. And 408 says a
        // body did not arrive in time, 425 asks for the same request again.
        _ if answer.is_environmental() => Classified::Environmental,
        // Looks environmental, but clears only when a person replaces the
        // credential.
        (401, _) => Classified::BlockQueue(BlockedReason::CredentialRefused),
        (403, _)
            if Refusal::read(&answer.code, Some(&answer.body))
                .grant
                .is_some() =>
        {
            Classified::Block(BlockedReason::CredentialRefused)
        }
        (422, "idempotency_key_reused") => Classified::Block(BlockedReason::KeySpent),
        (422, "idempotency_result_not_retained" | "idempotency_contract_changed")
            if first_succeeded(answer) =>
        {
            Classified::Delivered
        }
        // A kept refusal applied none of the write.
        (422, "idempotency_contract_changed") if first_refused(answer) => {
            Classified::Block(BlockedReason::KeySpent)
        }
        (409, "ancestor_unavailable") => Classified::Block(BlockedReason::AncestorUnavailable),
        (409, "version_conflict") => Classified::Block(BlockedReason::ConflictUnresolved),
        // The server has not finished answering this key, and nothing clears
        // it on its own, so it counts.
        (409, "idempotency_key_in_flight") => Classified::Counted,
        // Not only 400, 403 and 404: a 405 or 410 read as retryable would
        // loop on a refusal that never changes.
        (400..=499, _) => Classified::Contract,
        // An unexpected informational answer may clear on the next attempt.
        _ => Classified::Counted,
    }
}

/// The server keeps the status of a first answer it could not keep whole
/// (`errors/idem-not-retained-status`).
fn first_succeeded(answer: &Answer) -> bool {
    original_status(answer).is_some_and(|status| (200..300).contains(&status))
}

fn first_refused(answer: &Answer) -> bool {
    original_status(answer).is_some_and(|status| (400..600).contains(&status))
}

fn original_status(answer: &Answer) -> Option<u64> {
    serde_json::from_str::<serde_json::Value>(&answer.body)
        .ok()
        .and_then(|body| body.pointer("/error/details/original_status")?.as_u64())
}
