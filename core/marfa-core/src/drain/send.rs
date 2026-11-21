//! The walk over the queue, one row at a time, and the requests a row's send makes on its behalf.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::AtomicBool;

use super::address::{
    Door, Owned, Readiness, Sendable, Shape, address, ends_the_drain, held_back, readiness,
    send_uploads_as, upload,
};
use super::classify::{
    Classified, ENVIRONMENTAL_STREAK, Phase, Role, STREAK_FLOOR_MILLIS, Standing, Suspect,
    block_failing_alone, classify, failure_of, held_to_most, leave_waiting, limiting, next_test,
    not_the_writes, put_verdict, rate_limited, refine, set_aside, tell, unconfirmed,
};
use super::read_back::{ReachChange, read_owed_backs, reconcile};
use super::report::DrainReport;
use super::resend::{self, Judged};
use super::settle::{
    Settled, committed, finish_counted, found_answer, receipt_key, settle, verdict_of,
};
use super::{create_edges, pages, rows};
use super::{judged, read_limit_refused};
use crate::error::{ContractRefusal, CoreError};
use crate::http::{Answer, Http, INSTANCE_CHANGED};
use crate::model::{BlockedReason, LastFailure, QueuedWrite, Verdict, WriteKind};
use crate::store;
use crate::telemetry;
use crate::{Core, Result};

pub(super) fn send_queue(
    core: &Core,
    http: &Http,
    generation: u64,
    stop: &AtomicBool,
    pass: &mut ReachChange,
    report: &mut DrainReport,
    caught_up: &mut bool,
) -> Result<()> {
    let waiting = store::waiting_writes(&*core.conn()?)?;
    let owed = !store::owed_read_backs(&*core.conn()?)?.is_empty()
        || create_edges::any_owed(&*core.conn()?)?;
    let names_wait = crate::body::rule::waiting(&*core.conn()?)?;
    let body_answers = crate::body::rule::has_answer_work(&*core.conn()?)?;
    if waiting.is_empty() && !owed && !names_wait && !body_answers {
        // This pass has no work. Return before later reads could observe a
        // concurrent edit and apply its deferred work without admission.
        return read_limit_refused(core, http, stop);
    }
    {
        // A relocation must be admitted before this pass changes local queue
        // verdicts or resolves body dependencies. Same-origin transport has
        // no relocation gate, and an empty pass does not reach this one.
        match crate::catch_up::ask_unless_stopped(stop, http, Http::confirm_origin) {
            Ok(()) => {}
            Err(error) if error.is_environmental() => {
                telemetry::degraded!(&error);
                report.unavailable = Some(unconfirmed(&error));
                report.limited = error.is_limit_named();
                report.undelivered = waiting.len();
                waited(report, error.retry_after().map(|wait| wait.as_secs()));
                return Ok(());
            }
            Err(error) => return Err(error),
        }
    }
    // Confirmed once, and only where the pass talks to the server: a pass
    // with nothing to send, read or look up sends nothing at all, and one that cannot
    // confirm the instance is a server that cannot take writes, since a
    // restart is when another instance appears.
    let mut confirmed = false;
    let mut confirm = |report: &mut DrainReport| -> Result<bool> {
        if confirmed {
            return Ok(true);
        }
        let result = crate::catch_up::refuse_another_instance_until(core, http, stop);
        crate::catch_up::refuse_if_stopped(stop)?;
        match result {
            Ok(_) => {
                confirmed = true;
                Ok(true)
            }
            Err(error) if error.is_environmental() => {
                telemetry::degraded!(&error);
                report.unavailable = Some(unconfirmed(&error));
                report.limited = error.is_limit_named();
                waited(report, error.retry_after().map(|wait| wait.as_secs()));
                Ok(false)
            }
            Err(error) => Err(error),
        }
    };
    // A refused server leaves the queue as it was, so its release is read
    // before any row changes. Only a pass that has a row to return reads the
    // root here; the rest read it where they send.
    if store::any_self_clearing(&*core.conn()?)? {
        confirm(report)?;
    }
    {
        let conn = core.conn()?;
        // Left blocked, a self-clearing row would skip a dependency that has
        // since been answered.
        store::unblock_self_clearing(&conn)?;
    }
    send_uploads_as(core, http)?;
    // A server that cannot be read cannot be written to either, so nothing
    // is sent.
    let unconfirmed = owed && !confirm(report)?;
    if !unconfirmed && let Some(why) = read_owed_backs(core, stop, pass)? {
        report.unavailable = Some(why.reason);
        report.limited = why.limited;
        waited(report, why.retry_after_seconds);
    }
    if !unconfirmed
        && report.unavailable.is_none()
        && let Some(why) = create_edges::read_all(core, pass, stop)?
    {
        report.unavailable = Some(why.reason);
        report.limited = why.limited;
        waited(report, why.retry_after_seconds);
    }

    // Before the queue is read, so an edge a name now resolves to goes out in
    // this pass, after the writes it waits on.
    crate::body::rule::after_answers(&mut *core.conn()?)?;
    if report.unavailable.is_none() && !unconfirmed && crate::body::rule::waiting(&*core.conn()?)? {
        // A server that cannot be asked about names is no failure of the
        // pass: they wait for the next, and a write sent later confirms the
        // instance again.
        let (unavailable, limited, retry_after) = (
            report.unavailable.clone(),
            report.limited,
            report.retry_after_seconds,
        );
        if confirm(report)? {
            core.settle_bodies(stop)?;
        } else {
            report.unavailable = unavailable;
            report.limited = limited;
            report.retry_after_seconds = retry_after;
        }
    }

    let all = {
        let conn = core.conn()?;
        store::queued_writes(&conn)?
    };
    let mut answers: HashMap<String, Option<Verdict>> = all
        .iter()
        .map(|row| (row.id.clone(), row.verdict))
        .collect();

    let rows: HashMap<&str, &QueuedWrite> = all.iter().map(|row| (row.id.as_str(), row)).collect();
    let mut landing = store::pending_landings(&*core.conn()?)?;
    // Sent and unanswered, or held, this pass. A write to the same subject
    // behind one waits for the next pass: once sent under its key, a body
    // cannot be moved onto the answer ahead of it.
    let mut waiting: HashSet<String> = HashSet::new();
    let mut lookups = Lookups::new();
    // The write being asked about, until the pass settles it.
    let mut suspect: Option<Suspect> = None;
    // Sent out of queue order as a test, so the walk does not reach it again.
    let mut tested: HashSet<String> = HashSet::new();
    let mut cursor = 0;

    if report.unavailable.is_none() && !pass.changed() {
        let defer = !pass.later;
        let deferred = pages::send(
            &pages::Sender {
                core,
                http,
                generation,
                stop,
            },
            pass,
            report,
            &mut pages::Standing {
                all: &all,
                rows: &rows,
                answers: &mut answers,
                landing: &landing,
            },
            &mut confirm,
            defer,
        )?;
        // The walk leaves them for the next pass.
        pass.deferred += deferred.len();
        tested.extend(deferred);
    }

    'walk: loop {
        crate::catch_up::refuse_if_stopped(stop)?;
        // A page refused for its credential parked the queue.
        if report.stopped.is_some() {
            break;
        }
        // The pass ended before the suspect was sent again.
        if report.unavailable.is_some()
            && let Some(stuck) = suspect.take()
        {
            leave_waiting(&stuck, report);
        }
        let mut role = Role::Walk;
        let mut resending: Option<Suspect> = None;
        let mut next: Option<&QueuedWrite> = None;
        match suspect.as_ref().map(|stuck| (stuck.phase, stuck.at)) {
            Some((Phase::Resending, at)) => {
                // From here the write is sent as any other, so every path
                // below settles it and counts it once.
                resending = suspect.take();
                role = Role::Resend;
                next = Some(&all[at]);
            }
            Some((Phase::Testing, _)) => {
                let at = next_test(
                    core,
                    &all,
                    cursor,
                    &tested,
                    &Standing {
                        rows: &rows,
                        answers: &answers,
                        waiting: &waiting,
                        landing: &landing,
                    },
                )?;
                match at {
                    Some(at) => {
                        tested.insert(all[at].id.clone());
                        role = Role::Test;
                        next = Some(&all[at]);
                    }
                    None => {
                        // No write could test it, so the pass ends here.
                        if let Some(stuck) = suspect.take() {
                            leave_waiting(&stuck, report);
                        }
                    }
                }
            }
            None => {}
        }
        let row = match next {
            Some(row) => row,
            None => {
                let Some(row) = all.get(cursor) else {
                    break;
                };
                cursor += 1;
                if tested.contains(&row.id) {
                    continue;
                }
                row
            }
        };
        if answers.get(&row.id).and_then(Option::as_ref).is_some() {
            continue;
        }
        let replacing = resending.as_ref().map(|stuck| stuck.verdict_at);
        if let Some(stuck) = &resending {
            // Released, withdrawn or answered while the test was out: not the
            // same attempt any more, and nothing is sent for it.
            let same = store::queued_write(&*core.conn()?, &row.id)?
                .is_some_and(|now| now.verdict.is_none() && now.idempotency_key == stuck.key);
            if !same {
                continue;
            }
        }
        // Read again: an earlier answer this pass can have moved the row onto
        // the one a create landed on.
        let current = {
            let conn = core.conn()?;
            store::queued_write(&conn, &row.id)?
        };
        let row = current.as_ref().unwrap_or(row);
        // Sent in another write's batch, which that write answers for.
        if row.batched_with.is_some() {
            continue;
        }
        // Answered since the pass read the queue, as a settled create refuses
        // the writes to an edge it did not make.
        if let Some(answered) = current.as_ref().and_then(|now| now.verdict) {
            if answered == Verdict::Blocked {
                waiting.insert(row.id.clone());
            }
            answers.insert(row.id.clone(), Some(answered));
            if answered != Verdict::Blocked {
                // Refused unsent by the store: still a write the pass came to.
                report.unsent += 1;
                put_verdict(
                    report,
                    replacing,
                    verdict_of(
                        row,
                        &Settled::plain(Some(answered), row.reason.clone(), row.refusals),
                        None,
                    ),
                );
            }
            continue;
        }

        let waits = held_back(&*core.conn()?, row)?;
        let ready = match readiness(row, &rows, &answers, &waiting, &landing, waits) {
            Readiness::Ready => match crate::body::rule::lost_body(&*core.conn()?, row)? {
                Some(reason) => Readiness::RefusedWith(reason),
                None => Readiness::Ready,
            },
            other => other,
        };
        match ready {
            // It was ready when it was first sent this pass. What changed
            // since is not for a send again to decide: it waits as it was.
            _ if role == Role::Resend && !matches!(ready, Readiness::Ready) => {
                if let Some(stuck) = &resending {
                    leave_waiting(stuck, report);
                }
                continue;
            }
            Readiness::Held => {
                // Decided on the verdicts read when the pass began, which a
                // withdraw or a discard since may have answered, or a
                // hydration from another instance blocked
                // (`device/queue-other-instance-held`): their verdict stands.
                #[cfg(debug_assertions)]
                crate::fault::hold(|| format!("drain-holding:{}", row.id));
                let mut conn = core.conn()?;
                let tx = conn.transaction()?;
                let now = store::queued_write(&tx, &row.id)?;
                match now.as_ref().map(|now| (now.verdict, now.reason.as_deref())) {
                    None => continue,
                    Some((None, _))
                    | Some((Some(Verdict::Blocked), Some(crate::model::AWAITING_DEPENDENCY))) => {}
                    Some((answered, _)) => {
                        if answered == Some(Verdict::Blocked) {
                            waiting.insert(row.id.clone());
                        }
                        answers.insert(row.id.clone(), answered);
                        continue;
                    }
                }
                store::record_verdict(
                    &tx,
                    &row.id,
                    &store::Answered {
                        verdict: Verdict::Blocked,
                        reason: Some(crate::model::AWAITING_DEPENDENCY),
                        answer: None,
                        conflicted_copy_id: None,
                    },
                )?;
                tx.commit()?;
                answers.insert(row.id.clone(), Some(Verdict::Blocked));
                waiting.insert(row.id.clone());
                report.held += 1;
                continue;
            }
            // The server cannot take writes: what is held stays held, so the
            // queue still says what waits on what, and nothing else is
            // touched or counted.
            _ if report.unavailable.is_some() => {
                waiting.insert(row.id.clone());
                report.undelivered += 1;
                continue;
            }
            Readiness::RefusedWith(_) | Readiness::Ready if !confirm(report)? => {
                waiting.insert(row.id.clone());
                report.undelivered += 1;
                continue;
            }
            Readiness::RefusedWith(reason) => {
                refuse_unsent(core, stop, row, reason, None, replacing, pass, report)?;
                answers.insert(row.id.clone(), Some(Verdict::Refused));
                continue;
            }
            Readiness::Ready => {}
        }

        let after = all
            .iter()
            .position(|queued| queued.id == row.id)
            .map_or(&all[..0], |at| &all[at + 1..]);
        let batched = rows::gather(
            core,
            row,
            after,
            &rows::Standing {
                rows: &rows,
                answers: &answers,
                waiting: &waiting,
                landing: &landing,
            },
        )?;
        // Here rather than as the drain starts, so writes queued ahead are not held.
        if !*caught_up {
            let conn = core.conn()?;
            let mut judging = judged(&conn, row)?;
            for joined in &batched {
                judging = judging || judged(&conn, joined)?;
            }
            drop(conn);
            if judging {
                *caught_up = true;
                core.catch_up_before_rows(stop)?;
            }
        }
        let payload = match payload_to_send(core, http, stop, row, &all, &mut lookups)? {
            Ok(_) if row.kind == WriteKind::WriteRows => rows::body(row, &batched),
            Ok(payload) => payload,
            Err(CoreError::Unauthorized { server, .. }) => {
                park_for_credential(core, report, server)?;
                break;
            }
            Err(error) => {
                telemetry::degraded!(&error);
                report.unavailable = Some(format!(
                    "the server could not say whether a row holds the natural key the create {} carries, so nothing more was sent: {}",
                    row.id,
                    unavailable_by(&error).unwrap_or_else(|| error.to_string())
                ));
                report.limited = error.is_limit_named();
                waited(report, error.retry_after().map(|wait| wait.as_secs()));
                waiting.insert(row.id.clone());
                report.undelivered += 1;
                continue;
            }
        };
        // Read again where the body was decided, so the answer is taken as
        // the answer to the body sent.
        let decided;
        let body: serde_json::Value = serde_json::from_str(&payload)?;
        let row = if body == row.body {
            row
        } else {
            decided = store::queued_write(&*core.conn()?, &row.id)?
                .ok_or_else(|| CoreError::Store(format!("the queued write {} is gone", row.id)))?;
            &decided
        };
        // Only a write never sent: one sent before may have landed, and goes
        // again under its key for the server to say.
        let limit = store::request_limit(&*core.conn()?)?;
        if row.kind != WriteKind::UploadBlob
            && let Some(over) = crate::model::RequestLimit::over(payload.len(), limit)
            && store::unsent(&*core.conn()?, &row.id)?
        {
            let reason = format!("{}{}", crate::model::OVER_REQUEST_LIMIT_WRITE, over.words());
            store::note_limit_refused(&*core.conn()?)?;
            refuse_unsent(
                core,
                stop,
                row,
                reason,
                Some(over.stored()),
                replacing,
                pass,
                report,
            )?;
            answers.insert(row.id.clone(), Some(Verdict::Refused));
            continue;
        }
        // Opened before anything is marked sent, so missing bytes settle as
        // refused rather than failing the pass.
        let sendable = match address(row, &payload)? {
            Door::Json(outgoing, shape) => Sendable::Json(outgoing, shape),
            Door::Upload { hash, mime_type } => {
                let opened = core.cache()?.open_held(hash);
                match opened {
                    Ok(bytes) => Sendable::Upload { bytes, mime_type },
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                        let reason = format!(
                            "the bytes of {hash} are no longer held beside the working copy, so there is nothing to send"
                        );
                        let mut conn = core.conn()?;
                        let tx = conn.transaction()?;
                        store::record_refusal(&tx, row, &reason, None, false)?;
                        tx.commit()?;
                        drop(conn);
                        answers.insert(row.id.clone(), Some(Verdict::Refused));
                        report.unsent += 1;
                        put_verdict(
                            report,
                            replacing,
                            verdict_of(
                                row,
                                &Settled::plain(Some(Verdict::Refused), Some(reason), row.refusals),
                                None,
                            ),
                        );
                        continue;
                    }
                    // A local file error counts toward setting aside, never toward dead.
                    Err(error) => {
                        let reason = format!("the bytes of {hash} could not be opened: {error}");
                        let failure = LastFailure::of(None, reason.as_bytes());
                        let streak = {
                            let conn = core.conn()?;
                            let met = store::queued_write(&conn, &row.id)?
                                .and_then(|queued| queued.last_failure);
                            if met.is_some_and(|met| met != failure) {
                                store::clear_environmental(&conn, &row.id)?;
                            }
                            store::count_environmental(&conn, &row.id, &failure)?
                        };
                        if streak.count >= ENVIRONMENTAL_STREAK
                            && store::now_millis() - streak.began_ms >= STREAK_FLOOR_MILLIS
                        {
                            for write in
                                block_failing_alone(core, &row.id, &row.idempotency_key, &failure)?
                            {
                                answers.insert(write.id.clone(), Some(Verdict::Blocked));
                                waiting.insert(write.id.clone());
                                report.undelivered += 1;
                                put_verdict(
                                    report,
                                    replacing,
                                    verdict_of(
                                        &write,
                                        &Settled::plain(
                                            Some(Verdict::Blocked),
                                            Some(BlockedReason::FailingAlone.as_str().into()),
                                            write.refusals,
                                        ),
                                        None,
                                    ),
                                );
                            }
                            continue;
                        }
                        report.undelivered += 1;
                        put_verdict(
                            report,
                            replacing,
                            verdict_of(
                                row,
                                &Settled::plain(None, Some(reason), row.refusals),
                                None,
                            ),
                        );
                        continue;
                    }
                }
            }
        };
        let credential = store::credential_digest(&http.authorization());
        let owes_judging = matches!(sendable, Sendable::Json(..)) && {
            let conn = core.conn()?;
            core.write_down_renewals(&conn)?;
            resend::owed(&conn, row, &body, &credential)?
        };
        // Named by a send under a credential other than the one that first
        // sent it, from then on under its key.
        let mut resent_at = None;
        let applied = if !owes_judging {
            None
        } else if pass.changed() {
            // The server would refuse the read; the write waits for the
            // copy built again.
            waiting.insert(row.id.clone());
            report.undelivered += 1;
            continue;
        } else {
            let own = lookups.own.clone().flatten();
            match resend::judge(core, http, stop, pass, row, &body, own.as_deref()) {
                Ok(Judged::Applied(found)) => Some(found),
                Ok(Judged::Send { read }) => {
                    if read {
                        resent_at = store::sent_at_version(&*core.conn()?, &row.id)?;
                    }
                    None
                }
                Ok(Judged::Undecided { reason, status }) => {
                    let refusals = store::count_refusal(&*core.conn()?, &row.id)?;
                    let mut settled = finish_counted(core, row, refusals, None)?;
                    // After the count and the verdict, which each clear it.
                    store::note_last_failure(
                        &*core.conn()?,
                        &row.id,
                        &LastFailure::of(status, reason.as_bytes()),
                    )?;
                    if settled.verdict.is_none() {
                        settled.reason = Some(reason);
                        waiting.insert(row.id.clone());
                    }
                    answers.insert(row.id.clone(), settled.verdict);
                    report.undelivered += 1;
                    put_verdict(report, replacing, verdict_of(row, &settled, None));
                    continue;
                }
                Err(error) if error == CoreError::Canceled => return Err(error),
                Err(CoreError::CopyExpired { reason, server }) if reason == INSTANCE_CHANGED => {
                    return Err(left_for_another_instance(core, row, generation, server)?);
                }
                Err(error) => match failed(error) {
                    Failed::Fatal(error) => return Err(error),
                    Failed::Unanswered(CoreError::Unauthorized { server, .. }) => {
                        park_for_credential(core, report, server)?;
                        break;
                    }
                    Failed::Unanswered(error) => {
                        telemetry::degraded!(&error);
                        report.unavailable = Some(format!(
                            "the server could not say whether it holds the write {}, sent before under another credential, so it was not sent again: {}",
                            row.id,
                            unavailable_by(&error).unwrap_or_else(|| error.to_string())
                        ));
                        report.limited = error.is_limit_named();
                        waited(report, error.retry_after().map(|wait| wait.as_secs()));
                        waiting.insert(row.id.clone());
                        report.undelivered += 1;
                        continue;
                    }
                    // A read refused for good says nothing of the write,
                    // which the server answers for itself.
                    Failed::Refused(_) => None,
                },
            }
        };
        let applied = applied.and_then(|found| match &sendable {
            Sendable::Json(_, shape) => Some(found_answer(row, *shape, found)),
            Sendable::Upload { .. } => None,
        });
        let taken_as_applied = applied.is_some();
        let (answer, shape, resent) = 'sent: {
            // Taken as the answer the first send lost; nothing goes again.
            if let Some((answer, shape)) = applied {
                if row.kind == WriteKind::CreateItem {
                    lookups.forget(&row.body);
                }
                break 'sent (Ok(answer), shape, true);
            }
            // The connection is not held across the send, or `queue`, read while
            // a drain runs, would wait on the network.
            crate::catch_up::refuse_if_stopped(stop)?;
            #[cfg(debug_assertions)]
            crate::fault::hold(|| format!("drain-sending:{}", row.id));
            let (resent, named_version) = {
                // Before the send: one whose answer never arrives has still
                // reached the server, and treating it as unsent would write twice.
                let mut conn = core.conn()?;
                let tx = conn.transaction()?;
                if rows::held_since(&tx, row, &batched, generation, |id| rows.contains_key(id))? {
                    if let Some(stuck) = &resending {
                        leave_waiting(stuck, report);
                        continue 'walk;
                    }
                    let held = rows::hold(&tx, row, &batched)?;
                    tx.commit()?;
                    for (id, verdict, newly) in held {
                        if verdict == Some(Verdict::Blocked) {
                            waiting.insert(id.clone());
                        }
                        answers.insert(id, verdict);
                        report.held += usize::from(newly);
                    }
                    continue 'walk;
                }
                let resent = !store::unsent(&tx, &row.id)?;
                store::mark_sent(&tx, &row.id)?;
                rows::mark_joined(&tx, row, &batched)?;
                store::record_sent_as(&tx, &row.id, &credential)?;
                if row.kind == WriteKind::CreateItem
                    && body.get("source").is_none()
                    && body.get("source_id").is_some()
                    && let Some(source) = &lookups.own
                {
                    store::record_sent_source(&tx, &row.id, source.as_deref())?;
                }
                let own = lookups.own.clone().flatten();
                if !resent
                    && let Some(version) = resend::version_at_send(&tx, row, &body, own.as_deref())?
                {
                    store::record_sent_at_version(&tx, &row.id, version)?;
                }
                if let Some(version) = resent_at {
                    store::record_resent_at_version(&tx, &row.id, version)?;
                }
                let named_version = store::resent_at_version(&tx, &row.id)?;
                tx.commit()?;
                (resent, named_version)
            };
            let (answer, shape) = {
                let write = telemetry::operation!("write", kind, status);
                telemetry::record!(write, kind = row.kind.as_str());
                // Left behind at a stop where sending it again cannot write twice,
                // so a server that never answers, as one taking an upload can,
                // does not hold the drain: the row stays sent under its key, and
                // the next drain sends it again.
                let sent = match sendable {
                    Sendable::Json(outgoing, shape) => {
                        let owned = Owned::of(&outgoing).at_version(row.kind, named_version)?;
                        let answer = crate::catch_up::ask_unless_stopped(stop, http, move |http| {
                            http.send(&owned.outgoing())
                        });
                        (answer, shape)
                    }
                    Sendable::Upload { bytes, mime_type } => {
                        let answer = crate::catch_up::ask_unless_stopped(stop, http, move |http| {
                            upload(http, bytes, &mime_type)
                        });
                        (answer, Shape::Blob)
                    }
                };
                telemetry::ended!(
                    write,
                    sent.0.as_ref(),
                    |answer| {
                        outcome = if answer.is_environmental() {
                            "unavailable"
                        } else {
                            "answered"
                        },
                        status = answer.status,
                    },
                    unanswered ends_the_drain
                );
                sent
            };
            if row.kind == WriteKind::CreateItem {
                lookups.forget(&row.body);
            }
            // Not read, so the write stays sent and unanswered; every later
            // answer would come from the same server.
            let answer = match answer {
                Err(CoreError::CopyExpired { reason, server }) if reason == INSTANCE_CHANGED => {
                    return Err(left_for_another_instance(core, row, generation, server)?);
                }
                // The server acted on nothing, so a first attempt leaves the write
                // unsent, and only one sent before keeps an outcome unknown.
                Err(CoreError::ContractMismatch {
                    origin,
                    served,
                    expected,
                    status,
                    write_sent,
                    refusal: ContractRefusal::Declined,
                }) => {
                    let refusal = if resent {
                        ContractRefusal::DeclinedAfterEarlierAttempt
                    } else {
                        let mut conn = core.conn()?;
                        let tx = conn.transaction()?;
                        crate::row_writes::leave_unsent(&tx, &row.id)?;
                        tx.commit()?;
                        ContractRefusal::Declined
                    };
                    return Err(CoreError::ContractMismatch {
                        origin,
                        served,
                        expected,
                        status,
                        write_sent,
                        refusal,
                    });
                }
                Err(error) if ends_the_drain(&error) || error == CoreError::Canceled => {
                    return Err(error);
                }
                answer => answer,
            };
            (answer, shape, resent)
        };
        if let Ok(answer) = &answer {
            waited(report, answer.retry_after_seconds);
        }
        let class = if taken_as_applied {
            Classified::Success
        } else {
            refine(row, &payload, &answer, classify(&answer))
        };
        let environmental = class == Classified::Environmental;
        let landed = matches!(class, Classified::Landed { .. } | Classified::Delivered);
        let taken = match store_fault(row) {
            Some(error) => Err(error),
            None if row.kind.rows() => rows::settle(core, row, &answer, class, resent),
            None => settle(core, stop, row, &answer, class, shape, pass),
        };
        let mut settled = match taken {
            Ok(settled) => settled,
            Err(error) => {
                // A verdict is committed before the read it owes, and that
                // read can end the pass, as a changed reach does. The
                // drain began by clearing every verdict a row is sent with, so
                // one held now is this answer's, and is told.
                if let Some(current) = store::queued_write(&*core.conn()?, &row.id)?
                    && current.verdict.is_some()
                {
                    if answer.is_ok() {
                        report.answered += 1;
                    } else {
                        report.unmade += 1;
                    }
                    put_verdict(
                        report,
                        replacing,
                        verdict_of(
                            &current,
                            &committed(&current, answer.as_ref().ok(), shape, landed),
                            current.answer.as_deref(),
                        ),
                    );
                    if row.kind.rows() {
                        for member in rows::joined(&*core.conn()?, &row.id)? {
                            let settled = committed(&member, None, shape, false);
                            tell(
                                report,
                                verdict_of(&member, &settled, member.answer.as_deref()),
                            );
                        }
                    }
                    return Err(error);
                }
                if matches!(
                    error,
                    CoreError::Redirected { .. }
                        | CoreError::ContractMismatch { .. }
                        | CoreError::RenewalFailed(_)
                        | CoreError::SignedOut { .. }
                        | CoreError::NoKeychain(_)
                        | CoreError::StorageFull(_)
                        | CoreError::StoreBusy(_)
                        | CoreError::CopyExpired { .. }
                        | CoreError::StreamIncomplete { .. }
                        | CoreError::Canceled
                ) {
                    return Err(error);
                }
                // The server answered and the copy could not take the answer:
                // a further attempt may clear it, nothing clears it on its own.
                let reason = format!("the copy could not take the answer: {error}");
                let envelope = answer.as_ref().ok().map(|answer| answer.body.clone());
                if row.kind.rows() {
                    let members = rows::joined(&*core.conn()?, &row.id)?;
                    let writes: Vec<&QueuedWrite> = std::iter::once(row).chain(&members).collect();
                    rows::counted(core, &writes, envelope.as_deref(), Some(reason))?
                } else {
                    let refusals = store::count_refusal(&*core.conn()?, &row.id)?;
                    let mut settled = finish_counted(core, row, refusals, envelope)?;
                    // A dead write carries no reason, in the queue or here.
                    if settled.verdict.is_none() {
                        settled.reason = Some(reason);
                    }
                    settled
                }
            }
        };
        if settled.again {
            for entry in std::mem::take(&mut settled.joined) {
                answers.insert(entry.id.clone(), entry.verdict);
                if tell(report, entry) {
                    report.answered += 1;
                }
            }
            if role == Role::Walk {
                cursor -= 1;
            }
            continue;
        }
        // Held until its bytes go again, in the follow-up pass.
        if settled.bytes_again {
            answers.insert(row.id.clone(), settled.verdict);
            waiting.insert(row.id.clone());
            report.held += 1;
            if role == Role::Test
                && let Some(stuck) = suspect.as_mut()
            {
                stuck.phase = Phase::Resending;
            }
            continue;
        }
        // What the write met is kept for every answer it had from the server,
        // a rate limit included. A failure that came before the write was
        // answered says nothing of it.
        let mut counted = false;
        let mut met_again = None;
        if environmental && !not_the_writes(&answer) {
            let failure = failure_of(&answer);
            if rate_limited(&answer) {
                // Says nothing of the write: the streak, and so the start of
                // it, stand as they were.
                store::note_last_failure(&*core.conn()?, &row.id, &failure)?;
            } else if role == Role::Resend {
                // The same drain's failure: the streak was counted when the
                // write first met it.
                met_again = Some(failure);
            } else {
                let streak = store::count_environmental(&*core.conn()?, &row.id, &failure)?;
                // A write sent to test another that meets the failure as well
                // ends the pass, however long its own run.
                counted = role == Role::Walk
                    && streak.count >= ENVIRONMENTAL_STREAK
                    && store::now_millis() - streak.began_ms >= STREAK_FLOOR_MILLIS;
            }
        }
        if answer.is_ok() && (settled.unavailable.is_none() || settled.verdict.is_some()) {
            report.answered += 1;
        } else if answer.is_err() && settled.unavailable.is_none() {
            report.unmade += 1;
        }
        waited(report, settled.retry_after_seconds);
        answers.insert(row.id.clone(), settled.verdict);
        if row.kind == WriteKind::CreateItem
            && let Some(target) = store::meta_get(&*core.conn()?, &receipt_key(&row.id))?
                .and_then(|receipt| receipt.strip_prefix("land:").map(str::to_string))
        {
            landing.insert(row.id.clone(), target);
        }
        // A credential refusal can hide a receipt for a committed write.
        // Its followers must keep their bodies unsent until that receipt arrives.
        let credential_block = settled.verdict == Some(Verdict::Blocked)
            && settled.reason.as_deref() == Some(BlockedReason::CredentialRefused.as_str());
        if settled.verdict.is_none() || credential_block {
            waiting.insert(row.id.clone());
        }
        for (other, verdict, reason) in &settled.also {
            answers.insert(other.id.clone(), Some(*verdict));
            if *verdict == Verdict::Blocked {
                waiting.insert(other.id.clone());
            }
            report.unsent += 1;
            report.verdicts.push(verdict_of(
                other,
                &Settled::plain(Some(*verdict), Some(reason.clone()), other.refusals),
                None,
            ));
        }
        if let Some(source) = &settled.unclaimed
            && !report.unclaimed_sources.contains(source)
        {
            report.unclaimed_sources.push(source.clone());
        }
        let stop = settled.stops_the_drain;
        // Read again: a create's answer can have moved the copy onto the
        // server's row, and the id minted here would name nothing.
        let settled_row = {
            let conn = core.conn()?;
            store::queued_write(&conn, &row.id)?
        };
        let answered = settled_row.as_ref().unwrap_or(row);
        put_verdict(
            report,
            replacing,
            verdict_of(answered, &settled, answered.answer.as_deref()),
        );
        for entry in std::mem::take(&mut settled.joined) {
            answers.insert(entry.id.clone(), entry.verdict);
            let verdict = entry.verdict;
            if verdict.is_none() {
                waiting.insert(entry.id.clone());
            }
            if !tell(report, entry) {
                continue;
            }
            if verdict.is_some() || settled.unavailable.is_none() && answer.is_ok() {
                report.answered += 1;
            } else if settled.unavailable.is_some() {
                report.undelivered += 1;
            } else {
                report.unmade += 1;
            }
        }
        // The write has met the failure in three drains in a row, the first
        // five minutes ago: it waits for a write to test it.
        let mut carry_on = counted;
        if counted {
            suspect = Some(Suspect {
                id: row.id.clone(),
                key: row.idempotency_key.clone(),
                at: cursor - 1,
                unavailable: settled.unavailable.clone().unwrap_or_default(),
                limited: settled.limited,
                verdict_at: report
                    .verdicts
                    .iter()
                    .position(|told| told.id == row.id)
                    .unwrap_or(report.verdicts.len() - 1),
                phase: Phase::Testing,
            });
        }
        // The server answered a write that does not depend on the suspect,
        // and now the suspect is sent again.
        if answer.is_ok()
            && !environmental
            && !stop
            && role == Role::Test
            && let Some(stuck) = suspect.as_mut()
        {
            stuck.phase = Phase::Resending;
        }
        // Sent again after the test landed and met the failure again: set
        // aside, and the pass goes on.
        if let (Some(failure), Some(stuck)) = (&met_again, &resending) {
            set_aside(core, stuck, failure, report, &mut answers)?;
            carry_on = true;
        }
        if stop {
            let refusal = answer.as_ref().ok().map(Answer::server_answer);
            park_for_credential(core, report, refusal)?;
            break;
        }
        if settled.unavailable.is_some() && !carry_on {
            if settled.verdict.is_none() {
                report.undelivered += 1;
            }
            report.unavailable = settled.unavailable;
            report.limited = settled.limited;
        }
        // A test that failed before the server could answer it, such as a
        // request that cannot be built, says nothing of the server. The pass
        // ends with the suspect waiting, so one test at most reaches the
        // server for it.
        if role == Role::Test
            && !environmental
            && let Err(error) = &answer
            && let Some(stuck) = &suspect
            && report.unavailable.is_none()
        {
            report.unavailable = Some(format!(
                "the write {} could not be sent to test {}, so nothing more was sent: {error}",
                row.id, stuck.id
            ));
        }
    }

    crate::body::rule::after_answers(&mut *core.conn()?)?;
    Ok(())
}

/// Refuses `row` with the device's own `reason`, nothing sent. Told before
/// the read it owes, which can end the pass.
#[allow(clippy::too_many_arguments)]
fn refuse_unsent(
    core: &Core,
    stop: &AtomicBool,
    row: &QueuedWrite,
    reason: String,
    answer: Option<String>,
    replacing: Option<usize>,
    pass: &mut ReachChange,
    report: &mut DrainReport,
) -> Result<()> {
    {
        let mut conn = core.conn()?;
        let tx = conn.transaction()?;
        store::record_verdict(
            &tx,
            &row.id,
            &store::Answered {
                verdict: Verdict::Refused,
                reason: Some(&reason),
                answer: answer.as_deref(),
                conflicted_copy_id: None,
            },
        )?;
        if let Some(owed) = store::owed_of(&tx, row)? {
            store::owe_read_back(&tx, &owed)?;
            store::meta_set(&tx, &receipt_key(&row.id), "refused")?;
        }
        tx.commit()?;
    }
    report.unsent += 1;
    put_verdict(
        report,
        replacing,
        verdict_of(
            row,
            &Settled::plain(Some(Verdict::Refused), Some(reason), row.refusals),
            answer.as_deref(),
        ),
    );
    if let Some(unread) = reconcile(core, stop, row, pass)? {
        report.unavailable = Some(unread.reason);
        report.limited = unread.limited;
        waited(report, unread.retry_after_seconds);
    }
    Ok(())
}

/// Parks every unanswered write until the credential is replaced, and says
/// so: the rest of the pass would meet the same refusal.
pub(super) fn park_for_credential(
    core: &Core,
    report: &mut DrainReport,
    refusal: Option<Box<crate::error::ServerAnswer>>,
) -> Result<()> {
    let parked = store::block_unanswered(&*core.conn()?, BlockedReason::CredentialRefused)?;
    report.refused_by = refusal;
    report.stopped = Some(format!(
        "the server refused the credential, so every queued write is blocked and the drain stopped; {parked} row(s) parked"
    ));
    Ok(())
}

/// What a lookup this pass said of a natural key.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Known {
    Held,
    Unheld,
    /// The lookup was refused for good, or the key is one no lookup takes.
    Unknown,
}

/// What lookups this pass answered, by type, source and `source_id`, and the
/// source a create naming none falls under, once learned.
struct Lookups {
    keys: HashMap<(String, String, String), Known>,
    own: Option<Option<String>>,
}

impl Lookups {
    fn new() -> Lookups {
        Lookups {
            keys: HashMap::new(),
            own: None,
        }
    }

    fn source(&self, body: &serde_json::Value) -> Option<String> {
        match body.get("source").and_then(serde_json::Value::as_str) {
            Some(source) => Some(source.into()),
            None => self.own.clone().flatten(),
        }
    }

    /// A create sent under the key can have made the row since it was asked.
    fn forget(&mut self, body: &serde_json::Value) {
        let source_id = body.get("source_id").and_then(serde_json::Value::as_str);
        if let (Some(source), Some(source_id)) = (self.source(body), source_id) {
            self.keys.retain(|(_, held_source, held_id), _| {
                (held_source.as_str(), held_id.as_str()) != (source.as_str(), source_id)
            });
        }
    }
}

/// How a request the drain makes on a write's behalf failed.
enum Failed {
    /// Ends the drain, as it would on the write itself.
    Fatal(CoreError),
    /// Says nothing yet: the write waits, or the queue parks on a `401`.
    Unanswered(CoreError),
    /// For good. `true` where a smaller request might be answered.
    Refused(bool),
}

fn failed(error: CoreError) -> Failed {
    match error {
        CoreError::Redirected { .. }
        | CoreError::ContractMismatch { .. }
        | CoreError::SignedOut { .. }
        | CoreError::NoKeychain(_)
        | CoreError::StorageFull(_)
        | CoreError::CopyExpired { .. }
        | CoreError::StreamIncomplete { .. }
        | CoreError::Store(_)
        | CoreError::StoreBusy(_)
        | CoreError::Canceled => Failed::Fatal(error),
        CoreError::RenewalFailed(_) if !error.is_environmental() => Failed::Fatal(error),
        CoreError::Unauthorized { .. } => Failed::Unanswered(error),
        CoreError::Server { status, .. } if crate::error::environmental_status(status) => {
            Failed::Unanswered(error)
        }
        error if error.is_environmental() || unavailable_by(&error).is_some() => {
            Failed::Unanswered(error)
        }
        CoreError::Validation { .. } | CoreError::Server { status: 413, .. } => {
            Failed::Refused(true)
        }
        _ => Failed::Refused(false),
    }
}

/// The body a write goes with. A create whose tier the copy's slice chose
/// (`store::choose_tier`) is decided before its first send: with the chosen
/// tier where a lookup answers that no row holds its natural key, and with
/// no `tier` otherwise, so a row a person placed keeps its tier as it stands
/// (`items/tier-upsert`) whether the lookup found it or could not say. The
/// body decided is saved before the send, so every retry under the write's
/// key sends it again. The inner error is a lookup that has not answered
/// yet, which holds the write.
fn payload_to_send(
    core: &Core,
    http: &Http,
    stop: &AtomicBool,
    row: &QueuedWrite,
    all: &[QueuedWrite],
    lookups: &mut Lookups,
) -> Result<std::result::Result<String, CoreError>> {
    let payload = store::payload_of(&*core.conn()?, &row.id)?;
    if row.kind != WriteKind::CreateItem {
        return Ok(Ok(payload));
    }
    let mut body: serde_json::Value = serde_json::from_str(&payload)?;
    let text = |key: &str| {
        body.get(key)
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
    };
    let (Some(r#type), Some(source_id)) = (text("type"), text("source_id")) else {
        return Ok(Ok(payload));
    };
    // Learned for every send: under another credential, the source it was
    // stamped with is where a read finds what it made.
    if text("source").is_none()
        && let Err(error) = own_source(core, http, stop, lookups)?
    {
        return Ok(Err(error));
    }
    let tier = {
        let conn = core.conn()?;
        match store::chosen_tier(&conn, &row.id)? {
            Some(tier) if store::unsent(&conn, &row.id)? => tier,
            _ => return Ok(Ok(payload)),
        }
    };
    let known = match lookups.source(&body) {
        // The lookup's schema refuses an empty value.
        Some(source) if !source.is_empty() && !source_id.is_empty() => {
            let key = (r#type, source, source_id);
            if !lookups.keys.contains_key(&key) {
                let asked = keys_to_ask(core, all, &key, lookups)?;
                if let Err(error) = ask(http, stop, &key.0, &key.1, &asked, &mut lookups.keys)? {
                    return Ok(Err(error));
                }
            }
            lookups.keys.get(&key).copied().unwrap_or(Known::Unknown)
        }
        _ => Known::Unknown,
    };
    let Some(object) = body.as_object_mut() else {
        return Ok(Ok(payload));
    };
    if known == Known::Unheld {
        object.insert("tier".into(), tier.as_str().into());
    } else {
        object.shift_remove("tier");
    }
    let decided = body.to_string();
    if decided != payload {
        store::set_unsent_payload(&*core.conn()?, &row.id, &decided)?;
    }
    Ok(Ok(decided))
}

/// Another instance answers at the origin. Ahead of the classification,
/// which would refuse the write for good, the copy is expired: it is built
/// again from that instance, which holds the write until a person releases
/// it and has seen no attempt of it, so the write is judged there afresh.
fn left_for_another_instance(
    core: &Core,
    row: &QueuedWrite,
    generation: u64,
    server: Option<Box<crate::error::ServerAnswer>>,
) -> Result<CoreError> {
    let mut conn = core.conn()?;
    let tx = conn.transaction()?;
    crate::row_writes::leave_unsent(&tx, &row.id)?;
    let error = crate::catch_up::expire_for_another_instance(&tx, generation, server)?;
    tx.commit()?;
    Ok(error)
}

/// The credential's own source, which the server stamps a write naming none
/// with (`items/source-own`), as `GET /keys/current` answers it, kept for the
/// credential it was learned for. `None` where that door will not say.
fn own_source(
    core: &Core,
    http: &Http,
    stop: &AtomicBool,
    lookups: &mut Lookups,
) -> Result<std::result::Result<(), CoreError>> {
    if lookups.own.is_some() {
        return Ok(Ok(()));
    }
    let credential = store::credential_digest(&http.authorization());
    if let Some(learned) = store::learned_source(&*core.conn()?, &credential)? {
        lookups.own = Some(learned);
        return Ok(Ok(()));
    }
    let learned = match crate::catch_up::ask_unless_stopped(stop, http, Http::current_key) {
        Ok(key) => {
            let learned = key.and_then(|key| {
                key.get("source")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string)
            });
            store::learn_source(&*core.conn()?, &credential, learned.as_deref())?;
            learned
        }
        Err(error) => match failed(error) {
            Failed::Fatal(error) => return Err(error),
            Failed::Unanswered(error) => return Ok(Err(error)),
            Failed::Refused(_) => None,
        },
    };
    lookups.own = Some(learned);
    Ok(Ok(()))
}

/// Asks in requests no larger than one lookup takes, by its keys and by its
/// bytes.
fn ask(
    http: &Http,
    stop: &AtomicBool,
    r#type: &str,
    source: &str,
    asked: &[String],
    keys: &mut HashMap<(String, String, String), Known>,
) -> Result<std::result::Result<(), CoreError>> {
    let mut start = 0;
    while start < asked.len() {
        let mut end = start;
        let mut bytes = serde_json::json!({ "type": r#type, "source": source, "source_ids": [] })
            .to_string()
            .len();
        while end < asked.len() && end - start < crate::http::LOOKUP_LIMIT {
            let more = serde_json::Value::from(asked[end].as_str())
                .to_string()
                .len()
                + 1;
            if end > start && bytes + more > crate::http::LOOKUP_BODY_BYTES {
                break;
            }
            bytes += more;
            end += 1;
        }
        if let Err(error) = ask_batch(http, stop, r#type, source, &asked[start..end], keys)? {
            return Ok(Err(error));
        }
        start = end;
    }
    Ok(Ok(()))
}

/// A batch refused for one key in it, or for its size, is asked again in
/// halves, so a key refused for good is told apart from the keys beside it.
fn ask_batch(
    http: &Http,
    stop: &AtomicBool,
    r#type: &str,
    source: &str,
    batch: &[String],
    keys: &mut HashMap<(String, String, String), Known>,
) -> Result<std::result::Result<(), CoreError>> {
    let asked = (r#type.to_string(), source.to_string(), batch.to_vec());
    let known = match crate::catch_up::ask_unless_stopped(stop, http, move |http| {
        http.keys_held(&asked.0, &asked.1, &asked.2)
    }) {
        Ok(held) => Some(held),
        Err(error) => match failed(error) {
            Failed::Fatal(error) => return Err(error),
            Failed::Unanswered(error) => return Ok(Err(error)),
            Failed::Refused(true) if batch.len() > 1 => {
                let (first, second) = batch.split_at(batch.len() / 2);
                if let Err(error) = ask_batch(http, stop, r#type, source, first, keys)? {
                    return Ok(Err(error));
                }
                return ask_batch(http, stop, r#type, source, second, keys);
            }
            Failed::Refused(_) => None,
        },
    };
    for source_id in batch {
        let answer = match &known {
            Some(held) if held.contains(source_id) => Known::Held,
            Some(_) => Known::Unheld,
            None => Known::Unknown,
        };
        keys.insert((r#type.into(), source.into(), source_id.clone()), answer);
    }
    Ok(Ok(()))
}

/// `key`'s `source_id`, and those of the other unsent creates of its type
/// and source whose tier the slice chose.
fn keys_to_ask(
    core: &Core,
    all: &[QueuedWrite],
    key: &(String, String, String),
    lookups: &Lookups,
) -> Result<Vec<String>> {
    let (r#type, source, source_id) = key;
    let mut asked = vec![source_id.clone()];
    let conn = core.conn()?;
    for other in all {
        if other.kind != WriteKind::CreateItem
            || other.body.get("type").and_then(serde_json::Value::as_str) != Some(r#type)
            || lookups.source(&other.body).as_ref() != Some(source)
        {
            continue;
        }
        let Some(named) = other
            .body
            .get("source_id")
            .and_then(serde_json::Value::as_str)
            .filter(|named| !named.is_empty())
        else {
            continue;
        };
        if asked.iter().any(|asked| asked == named)
            || lookups
                .keys
                .contains_key(&(r#type.clone(), source.clone(), named.to_string()))
            || store::chosen_tier(&conn, &other.id)?.is_none()
            || !store::unsent(&conn, &other.id)?
        {
            continue;
        }
        asked.push(named.to_string());
    }
    Ok(asked)
}

/// A store that fails, or is full, as the answer to the write named is taken.
pub(super) fn store_fault(row: &QueuedWrite) -> Option<CoreError> {
    if crate::fault::named("store-fails-at-answer").as_deref() == Some(row.id.as_str()) {
        return Some(CoreError::Store("disk I/O error".into()));
    }
    if crate::fault::named("store-full-at-answer").as_deref() == Some(row.id.as_str()) {
        return Some(CoreError::StorageFull("database or disk is full".into()));
    }
    None
}

/// The longest wait of the pass, not the last: a caller waits once for the
/// whole pass.
pub(super) fn waited(report: &mut DrainReport, wait: Option<u64>) {
    if let Some(wait) = held_to_most(wait) {
        report.retry_after_seconds = Some(
            report
                .retry_after_seconds
                .map_or(wait, |held| held.max(wait)),
        );
    }
}

/// Why a request could not get through, in words, where the failure is the
/// environment's; `None` where the server answered about the write.
pub(super) fn unavailable(answer: &std::result::Result<Answer, CoreError>) -> Option<String> {
    match answer {
        Err(error) => unavailable_by(error),
        Ok(answer) if !answer.contract_named && !answer.is_success() => Some(format!(
            "an answer of {} naming no contract, taken as from something in front of the server; if it repeats while the server otherwise answers, its refusals are losing the contract header on the way",
            answer.status
        )),
        Ok(answer) => match answer.status {
            429 => Some(limiting(answer.retry_after_seconds)),
            status if crate::error::environmental_status(status) => Some(format!(
                "the server could not take the write now ({}{})",
                answer.status,
                if answer.code.is_empty() {
                    String::new()
                } else {
                    format!(" {}", answer.code)
                }
            )),
            _ => None,
        },
    }
}

pub(super) fn unavailable_by(error: &CoreError) -> Option<String> {
    if error.is_limit_named() {
        return Some(limiting(error.retry_after().map(|wait| wait.as_secs())));
    }
    match error {
        CoreError::RenewalFailed(cause) => unavailable_by(cause),
        CoreError::Io(_) | CoreError::StorageFull(_) => Some(error.to_string()),
        CoreError::Network(_) | CoreError::ConnectionRefused { .. } => {
            Some(format!("the server could not be reached: {error}"))
        }
        CoreError::Unnamed { .. } => Some(error.to_string()),
        CoreError::Server { .. } if error.is_environmental() => Some(format!(
            "the server could not take the request now: {error}"
        )),
        _ => None,
    }
}
