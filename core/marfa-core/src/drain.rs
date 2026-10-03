//! One pass per call: each sendable row is attempted once, and the pass ends
//! at the first failure of the environment. Going on would ask a server that
//! cannot answer once for every row, a connection timeout each.

use std::collections::{HashMap, HashSet};
use std::fs::File;

use serde::Serialize;

use crate::catalog::Catalog;
use crate::error::CoreError;
use crate::http::{Answer, Call, CallBody, Http, Method, Outgoing};
use crate::model::{BlockedReason, QueuedWrite, Refusal, Subject, Verdict, WriteKind};
use crate::store;
use crate::wire::{WireEdge, WireEdgeAnswer, WireErrorEnvelope, WireItem, WireWriteAnswer};
use crate::{Core, Result};

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DrainReport {
    /// Writes the server answered this pass, whatever it answered.
    pub answered: usize,
    pub held: usize,
    /// Writes this pass could not deliver: the one the server could not take
    /// and every write left behind it, and one whose bytes could not be
    /// opened. Each waits, uncounted, for the next drain.
    pub undelivered: usize,
    /// Writes this pass gave a verdict without sending them: refused for a
    /// write they waited on or for bytes no longer held, or settled by
    /// another write's answer.
    pub unsent: usize,
    /// Writes whose request could not be made, such as a header the
    /// transport would not build: each is counted against its write and
    /// waits for the next drain, or is dead at the ceiling. With `answered`,
    /// `held`, `undelivered` and `unsent`, every write the pass came to; the
    /// writes a refused credential parks are counted in `stopped`.
    pub unmade: usize,
    /// Why the pass ended before the queue was through: the server could not
    /// be reached, failed, or asked to be left alone for a while.
    pub unavailable: Option<String>,
    /// Also holds rows settled without being sent, by another write's answer.
    pub verdicts: Vec<DrainVerdict>,
    /// Set when a refused credential parks the queue. An answer on another
    /// contract ends the drain as an error instead.
    pub stopped: Option<String>,
    /// Reported because `credential_refused` alone reads as a key that no
    /// longer works.
    pub unclaimed_sources: Vec<String>,
    /// The longest `Retry-After` of the pass, not the last: a caller waits
    /// once for the whole pass.
    pub retry_after_seconds: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DrainVerdict {
    pub id: String,
    pub kind: WriteKind,
    /// An edge write's source; otherwise the row written to.
    pub item_id: Option<String>,
    pub edge_id: Option<String>,
    /// `None` where the write was sent and not answered.
    pub verdict: Option<Verdict>,
    pub reason: Option<String>,
    /// A terminal or credential refusal, read from what the queue stored.
    pub refusal: Option<Refusal>,
    pub conflicted_copy_id: Option<String>,
    pub refusals: i64,
    /// Set by either the `Idempotency-Replayed` header or the answer's
    /// `acknowledged`.
    pub replayed: bool,
    pub merged_fields: Vec<String>,
}

impl DrainVerdict {
    pub fn outcome(&self) -> Result<Option<crate::model::Outcome>> {
        crate::model::Outcome::of(
            self.verdict,
            self.reason.as_deref(),
            self.conflicted_copy_id.as_deref(),
            self.merged_fields.clone(),
            self.refusal.as_ref(),
        )
    }
}

#[derive(Debug, Clone, PartialEq)]
enum Classified {
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
}

/// Reads a create's answer again: a key that landed on a held row, an
/// unclaimed source and a trashed row cannot be told from the status and
/// code alone.
fn refine(
    row: &QueuedWrite,
    payload: &str,
    answer: &std::result::Result<Answer, CoreError>,
    class: Classified,
) -> Classified {
    if row.kind != WriteKind::CreateItem {
        return class;
    }
    let Ok(answer) = answer else {
        return class;
    };
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
        _ => class,
    }
}

fn classify(answer: &std::result::Result<Answer, CoreError>) -> Classified {
    let answer = match answer {
        Ok(answer) => answer,
        Err(CoreError::Network(_)) => return Classified::Environmental,
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
        // second would kill every queued write within seconds. And 408 is a
        // proxy's about the network, 425 asks for the same request again.
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
        (409, "ancestor_unavailable") => Classified::Block(BlockedReason::AncestorUnavailable),
        (409, "version_conflict") => Classified::Block(BlockedReason::ConflictUnresolved),
        // The server has not finished answering this key, and nothing clears
        // it on its own, so it counts.
        (409, "idempotency_key_in_flight") => Classified::Counted,
        // Not only 400, 403 and 404: a 405 or 410 read as retryable would
        // loop on a refusal that never changes.
        (400..=499, _) => Classified::Contract,
        // A 1xx or 3xx here is one the HTTP agent did not resolve, and the
        // next attempt may.
        _ => Classified::Counted,
    }
}

/// Only some doors answer with an item: tags, metadata and extensions answer
/// the sidecar they changed, a delete answers `{"ok": true}`, an edge the
/// edge, and an upload the hash.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Shape {
    Item,
    Edge,
    Plain,
    Blob,
}

enum Door<'a> {
    Json(Outgoing<'a>, Shape),
    Upload { hash: &'a str, mime_type: String },
}

enum Sendable<'a> {
    Json(Outgoing<'a>, Shape),
    Upload { bytes: File, mime_type: String },
}

enum Readiness {
    Ready,
    Held,
    RefusedWith(String),
}

fn readiness(
    row: &QueuedWrite,
    rows: &HashMap<&str, &QueuedWrite>,
    verdicts: &HashMap<String, Option<Verdict>>,
    waiting: &HashSet<String>,
) -> Readiness {
    // Ordering before dependencies, so a write that would be refused does
    // not let the writes behind it past the one ahead.
    if row
        .follows
        .as_deref()
        .is_some_and(|ahead| waiting.contains(ahead))
    {
        return Readiness::Held;
    }
    for dependency in &row.depends_on {
        let Some(verdict) = verdicts.get(dependency.as_str()) else {
            // A dependency missing from the queue has no answer either.
            return Readiness::Held;
        };
        match verdict {
            Some(Verdict::Accepted | Verdict::Merged | Verdict::Conflicted) => {}
            Some(terminal @ (Verdict::Refused | Verdict::Dead)) => {
                let kind = rows
                    .get(dependency.as_str())
                    .map(|write| write.kind.as_str())
                    .unwrap_or("write");
                return Readiness::RefusedWith(format!("the {kind} it waits for was {terminal}"));
            }
            _ => return Readiness::Held,
        }
    }
    Readiness::Ready
}

fn address<'a>(row: &'a QueuedWrite, payload: &'a str) -> Result<Door<'a>> {
    let item_id = || -> Result<&str> {
        row.item_id.as_deref().ok_or_else(|| {
            CoreError::Store(format!(
                "the queued {} names no item, so there is nowhere to send it",
                row.kind
            ))
        })
    };
    let edge_id = || -> Result<&str> {
        row.edge_id.as_deref().ok_or_else(|| {
            CoreError::Store(format!(
                "the queued {} names no edge, so there is nowhere to send it",
                row.kind
            ))
        })
    };
    let namespace = || -> Result<&str> {
        row.namespace.as_deref().ok_or_else(|| {
            CoreError::Store(format!(
                "the queued {} names no namespace, so there is nowhere to send it",
                row.kind
            ))
        })
    };
    let tag = || -> Result<&str> {
        row.tag.as_deref().ok_or_else(|| {
            CoreError::Store(format!(
                "the queued {} names no tag, so there is nothing to remove",
                row.kind
            ))
        })
    };
    let to = |method: Method, segments: Vec<String>, shape: Shape| {
        Ok(Door::Json(
            Outgoing {
                method,
                segments,
                params: Vec::new(),
                body: payload,
                idempotency_key: &row.idempotency_key,
            },
            shape,
        ))
    };
    match row.kind {
        WriteKind::CreateItem => to(Method::Post, vec!["items".into()], Shape::Item),
        WriteKind::UpdateItem => Ok(Door::Json(
            Outgoing {
                method: Method::Patch,
                segments: vec!["items".into(), item_id()?.into()],
                // The device resolves nothing itself: the server resolves inside
                // its own transaction rather than leaving two writes.
                params: vec![("conflict".into(), "auto".into())],
                body: payload,
                idempotency_key: &row.idempotency_key,
            },
            Shape::Item,
        )),
        WriteKind::DeleteItem => to(
            Method::Delete,
            vec!["items".into(), item_id()?.into()],
            Shape::Plain,
        ),
        WriteKind::RestoreItem => to(
            Method::Post,
            vec!["items".into(), item_id()?.into(), "restore".into()],
            Shape::Item,
        ),
        WriteKind::TransitionItem => to(
            Method::Post,
            vec!["items".into(), item_id()?.into(), "transition".into()],
            Shape::Item,
        ),
        WriteKind::CreateEdge => to(Method::Post, vec!["edges".into()], Shape::Edge),
        WriteKind::UpdateEdge => to(
            Method::Patch,
            vec!["edges".into(), edge_id()?.into()],
            Shape::Edge,
        ),
        WriteKind::DeleteEdge => to(
            Method::Delete,
            vec!["edges".into(), edge_id()?.into()],
            Shape::Plain,
        ),
        WriteKind::ReplaceMetadata => to(
            Method::Put,
            vec!["items".into(), item_id()?.into(), "metadata".into()],
            Shape::Plain,
        ),
        WriteKind::MergeMetadata => to(
            Method::Patch,
            vec!["items".into(), item_id()?.into(), "metadata".into()],
            Shape::Plain,
        ),
        WriteKind::AddTag => to(
            Method::Post,
            vec!["items".into(), item_id()?.into(), "tags".into()],
            Shape::Plain,
        ),
        WriteKind::RemoveTag => to(
            Method::Delete,
            vec![
                "items".into(),
                item_id()?.into(),
                "tags".into(),
                tag()?.into(),
            ],
            Shape::Plain,
        ),
        WriteKind::WriteExtension => to(
            Method::Put,
            vec![
                "items".into(),
                item_id()?.into(),
                "extensions".into(),
                namespace()?.into(),
            ],
            Shape::Plain,
        ),
        WriteKind::DeleteExtension => to(
            Method::Delete,
            vec![
                "items".into(),
                item_id()?.into(),
                "extensions".into(),
                namespace()?.into(),
            ],
            Shape::Plain,
        ),
        WriteKind::UploadBlob => {
            let hash = row.blob.as_deref().ok_or_else(|| {
                CoreError::Store(format!(
                    "the queued upload {} names no blob, so there is nothing to send",
                    row.id
                ))
            })?;
            let mime_type = serde_json::from_str::<serde_json::Value>(payload)?
                .get("mime_type")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| {
                    CoreError::Store(format!(
                        "the queued upload {} names no MIME type to send its bytes under",
                        row.id
                    ))
                })?
                .to_string();
            Ok(Door::Upload { hash, mime_type })
        }
    }
}

/// No idempotency key: the door is idempotent by content and reads none.
/// The stream is spent by a send, so a `401` renewed is sent again here from
/// the start of the file.
fn upload(http: &Http, bytes: File, mime_type: &str) -> std::result::Result<Answer, CoreError> {
    let again = bytes
        .try_clone()
        .map_err(|error| CoreError::Store(format!("the upload's bytes cannot be read: {error}")))?;
    let send = |bytes: File| {
        http.call(Call {
            method: Method::Post,
            segments: &["blobs"],
            params: &[],
            headers: &[("Content-Type", mime_type)],
            body: CallBody::Reader(Box::new(bytes)),
            credential: true,
            stream: false,
        })
    };
    let sent = http.authorization();
    let mut reply = send(bytes)?;
    if reply.status == 401 && http.authorization() != sent {
        let mut again = again;
        std::io::Seek::rewind(&mut again).map_err(|error| {
            CoreError::Store(format!("the upload's bytes cannot be read: {error}"))
        })?;
        reply = send(again)?;
    }
    let body = reply.body;
    let code = match serde_json::from_str::<WireErrorEnvelope>(&body) {
        Ok(envelope) => envelope.error.code,
        Err(_) => String::new(),
    };
    Ok(Answer {
        status: reply.status,
        code,
        body,
        retry_after_seconds: reply.retry_after_seconds,
        replayed: false,
        contract_named: reply.contract.is_some(),
    })
}

pub fn drain(core: &Core) -> Result<DrainReport> {
    // The handle before the server, so a second opener with no server is
    // told the real reason it may not write.
    core.lock.refuse_unless_writer()?;
    let http = core.http()?;
    {
        let conn = core.conn()?;
        // Before anything is read: left blocked, a self-clearing row would
        // make this drain skip a dependency that has since been answered.
        store::unblock_self_clearing(&conn)?;
    }
    let mut report = DrainReport {
        answered: 0,
        held: 0,
        undelivered: 0,
        unsent: 0,
        unmade: 0,
        unavailable: None,
        verdicts: Vec::new(),
        stopped: None,
        unclaimed_sources: Vec::new(),
        retry_after_seconds: None,
    };
    // Confirmed once, and only where the pass talks to the server: a pass
    // with nothing to send or read sends nothing at all, and one that cannot
    // confirm the instance is a server that cannot take writes, since a
    // restart is when another instance appears.
    let mut confirmed = false;
    let mut confirm = |report: &mut DrainReport| -> Result<bool> {
        if confirmed {
            return Ok(true);
        }
        match crate::catch_up::refuse_another_instance(core, http) {
            Ok(()) => {
                confirmed = true;
                Ok(true)
            }
            Err(error) if error.is_environmental() => {
                report.unavailable = Some(format!(
                    "the server could not say which instance it is, so nothing was sent: {error}"
                ));
                waited(report, error.retry_after().map(|wait| wait.as_secs()));
                Ok(false)
            }
            Err(error) => Err(error),
        }
    };
    let owed = !store::owed_read_backs(&*core.conn()?)?.is_empty();
    // A server that cannot be read cannot be written to either, so nothing
    // is sent.
    let unconfirmed = owed && !confirm(&mut report)?;
    if !unconfirmed && let Some(why) = read_owed_backs(core)? {
        report.unavailable = Some(why.reason);
        waited(&mut report, why.retry_after_seconds);
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
    // Sent and unanswered, or held, this pass. A write to the same subject
    // behind one waits for the next pass: once sent under its key, a body
    // cannot be moved onto the answer ahead of it.
    let mut waiting: HashSet<String> = HashSet::new();

    for row in &all {
        if answers.get(&row.id).and_then(Option::as_ref).is_some() {
            continue;
        }
        // Read again: an earlier answer this pass can have moved the row onto
        // the one a create landed on.
        let current = {
            let conn = core.conn()?;
            store::queued_write(&conn, &row.id)?
        };
        let row = current.as_ref().unwrap_or(row);

        match readiness(row, &rows, &answers, &waiting) {
            Readiness::Held => {
                let conn = core.conn()?;
                store::record_verdict(
                    &conn,
                    &row.id,
                    &store::Answered {
                        verdict: Verdict::Blocked,
                        reason: Some(BlockedReason::AwaitingDependency.as_str()),
                        answer: None,
                        conflicted_copy_id: None,
                    },
                )?;
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
            Readiness::RefusedWith(_) | Readiness::Ready if !confirm(&mut report)? => {
                waiting.insert(row.id.clone());
                report.undelivered += 1;
                continue;
            }
            Readiness::RefusedWith(reason) => {
                {
                    let mut conn = core.conn()?;
                    let tx = conn.transaction()?;
                    store::record_refusal(&tx, row, &reason, None, true)?;
                    move_edits_back(&tx, row)?;
                    tx.commit()?;
                }
                answers.insert(row.id.clone(), Some(Verdict::Refused));
                let unread = reconcile(core, row)?;
                report.unsent += 1;
                report.verdicts.push(verdict_of(
                    row,
                    &Settled::plain(Some(Verdict::Refused), Some(reason), row.refusals),
                    None,
                ));
                if let Some(unread) = unread {
                    report.unavailable = Some(unread.reason);
                    waited(&mut report, unread.retry_after_seconds);
                }
                continue;
            }
            Readiness::Ready => {}
        }

        let payload = {
            let conn = core.conn()?;
            store::payload_of(&conn, &row.id)?
        };
        // Opened before anything is marked sent, so missing bytes settle as
        // refused rather than failing the pass.
        let sendable = match address(row, &payload)? {
            Door::Json(outgoing, shape) => Sendable::Json(outgoing, shape),
            Door::Upload { hash, mime_type } => {
                let opened = match core.cache()?.held(hash)? {
                    Some(path) => File::open(path),
                    None => Err(std::io::Error::from(std::io::ErrorKind::NotFound)),
                };
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
                        report.verdicts.push(verdict_of(
                            row,
                            &Settled::plain(Some(Verdict::Refused), Some(reason), row.refusals),
                            None,
                        ));
                        continue;
                    }
                    // A locked file or a process out of handles is not the
                    // write's fault: unanswered and uncounted.
                    Err(error) => {
                        report.undelivered += 1;
                        report.verdicts.push(verdict_of(
                            row,
                            &Settled::plain(
                                None,
                                Some(format!("the bytes of {hash} could not be opened: {error}")),
                                row.refusals,
                            ),
                            None,
                        ));
                        continue;
                    }
                }
            }
        };
        // The connection is not held across the send, or `queue`, read while
        // a drain runs, would wait on the network.
        {
            // Before the send: one whose answer never arrives has still
            // reached the server, and treating it as unsent would write twice.
            let conn = core.conn()?;
            store::mark_sent(&conn, &row.id)?;
        }
        let (answer, shape) = match sendable {
            Sendable::Json(outgoing, shape) => (http.send(&outgoing), shape),
            Sendable::Upload { bytes, mime_type } => (upload(http, bytes, &mime_type), Shape::Blob),
        };
        // Not read, so the write stays sent and unanswered; every later
        // answer would come from the same server.
        let answer = match answer {
            Err(error @ CoreError::ContractMismatch { .. }) => return Err(error),
            answer => answer,
        };
        if let Ok(answer) = &answer {
            waited(&mut report, answer.retry_after_seconds);
        }

        let class = refine(row, &payload, &answer, classify(&answer));
        let settled = match settle(core, row, &answer, class, shape) {
            Ok(settled) => settled,
            Err(error @ CoreError::ContractMismatch { .. }) => return Err(error),
            // The server answered and the copy could not take the answer: a
            // further attempt may clear it, nothing clears it on its own.
            Err(error) => {
                let refusals = store::count_refusal(&*core.conn()?, &row.id)?;
                let mut settled = finish_counted(
                    core,
                    row,
                    refusals,
                    answer.as_ref().ok().map(|answer| answer.body.clone()),
                )?;
                settled.reason = Some(format!("the copy could not take the answer: {error}"));
                settled
            }
        };
        if answer.is_ok() && (settled.unavailable.is_none() || settled.verdict.is_some()) {
            report.answered += 1;
        } else if answer.is_err() && settled.unavailable.is_none() {
            report.unmade += 1;
        }
        waited(&mut report, settled.retry_after_seconds);
        answers.insert(row.id.clone(), settled.verdict);
        // A credential refusal can hide a receipt for a committed write.
        // Its followers must keep their bodies unsent until that receipt arrives.
        let credential_block = settled.verdict == Some(Verdict::Blocked)
            && settled.reason.as_deref() == Some(BlockedReason::CredentialRefused.as_str());
        if settled.verdict.is_none() || credential_block {
            waiting.insert(row.id.clone());
        }
        // A refused credential is not about the edit.
        if matches!(
            settled.verdict,
            Some(Verdict::Refused | Verdict::Blocked | Verdict::Dead)
        ) && !credential_block
        {
            let conn = core.conn()?;
            move_edits_back(&conn, row)?;
        }
        for (other, verdict, reason) in &settled.also {
            answers.insert(other.id.clone(), Some(*verdict));
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
        report
            .verdicts
            .push(verdict_of(answered, &settled, answered.answer.as_deref()));
        if stop {
            let conn = core.conn()?;
            let parked = store::block_unanswered(&conn, BlockedReason::CredentialRefused)?;
            report.stopped = Some(format!(
                "the server refused the credential, so every queued write is blocked and the drain stopped; {parked} row(s) parked"
            ));
            break;
        }
        if settled.unavailable.is_some() {
            if settled.verdict.is_none() {
                report.undelivered += 1;
            }
            report.unavailable = settled.unavailable;
        }
    }

    Ok(report)
}

/// The longest wait of the pass, not the last: a caller waits once for the
/// whole pass.
fn waited(report: &mut DrainReport, wait: Option<u64>) {
    if let Some(wait) = wait {
        report.retry_after_seconds = Some(
            report
                .retry_after_seconds
                .map_or(wait, |held| held.max(wait)),
        );
    }
}

/// Why a request could not get through, in words, where the failure is the
/// environment's; `None` where the server answered about the write.
fn unavailable(answer: &std::result::Result<Answer, CoreError>) -> Option<String> {
    match answer {
        Err(error) => unavailable_by(error),
        Ok(answer) if !answer.contract_named && !answer.is_success() => Some(format!(
            "an answer of {} naming no contract, taken as from something in front of the server; if it repeats while the server otherwise answers, its refusals are losing the contract header on the way",
            answer.status
        )),
        Ok(answer) => match answer.status {
            429 => Some(format!(
                "the server is limiting requests (429){}",
                answer
                    .retry_after_seconds
                    .map(|wait| format!(" and asked for {wait}s before the next"))
                    .unwrap_or_default()
            )),
            408 | 425 | 500..=599 => Some(format!(
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

fn unavailable_by(error: &CoreError) -> Option<String> {
    match error {
        CoreError::Network(reason) => Some(format!("the server could not be reached: {reason}")),
        CoreError::Unnamed { .. } => Some(error.to_string()),
        CoreError::RateLimited { .. } | CoreError::Server { .. } if error.is_environmental() => {
            Some(format!(
                "the server could not take the request now: {error}"
            ))
        }
        _ => None,
    }
}

struct AnsweredAt<'a> {
    version: i64,
    item: Option<&'a WireItem>,
}

/// Behind a create, only edits based on 0 move: the placeholder an
/// unanswered create holds, which the server never mints. A create
/// acknowledged as a repeat answers the row as it stands now, so the edits
/// behind it go on 1, the version that create made.
fn move_edits_behind(
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
                if landed && base == Some(version) && holds(conn, &id, at)? {
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

fn move_edits_back(conn: &rusqlite::Connection, row: &QueuedWrite) -> Result<()> {
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
            .map(|properties| properties.keys().cloned().collect())
            .unwrap_or_default())
    };
    let ahead_carries = carried(&row.id)?;
    let shared = carried(id)?
        .iter()
        .any(|property| ahead_carries.contains(property));
    Ok(shared.then_some(ahead))
}

/// A property carried at the value read is not checked: a move drops it.
/// Nor is a natural key: the server gives a key both writes changed to the
/// later writer, so on its own base the edit's key lands all the same.
fn holds(conn: &rusqlite::Connection, id: &str, at: &AnsweredAt<'_>) -> Result<bool> {
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
            let sent = body.pointer(&format!("/properties/{}", pointer_token(key)));
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
        let Some(sent) = body.pointer(&format!("/properties/{token}")) else {
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
fn verdict_of(row: &QueuedWrite, settled: &Settled, answer: Option<&str>) -> DrainVerdict {
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
    }
}

struct Settled {
    verdict: Option<Verdict>,
    reason: Option<String>,
    conflicted_copy_id: Option<String>,
    refusals: i64,
    stops_the_drain: bool,
    replayed: bool,
    merged_fields: Vec<String>,
    also: Vec<(QueuedWrite, Verdict, String)>,
    unclaimed: Option<String>,
    /// From the read a landed create makes, besides the answer's own.
    retry_after_seconds: Option<u64>,
    /// Set where this write, or a read it needed, could not get through: the
    /// pass ends here.
    unavailable: Option<String>,
}

impl Settled {
    fn plain(verdict: Option<Verdict>, reason: Option<String>, refusals: i64) -> Settled {
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
        }
    }
}

fn settle(
    core: &Core,
    row: &QueuedWrite,
    answer: &std::result::Result<Answer, CoreError>,
    class: Classified,
    shape: Shape,
) -> Result<Settled> {
    let envelope = answer.as_ref().ok().map(|answer| answer.body.clone());
    match class {
        Classified::Success => {
            let body = envelope.clone().unwrap_or_default();
            // Either says replayed: the header comes from the replay cache,
            // `acknowledged` from the route.
            let replayed_header = answer
                .as_ref()
                .map(|answer| answer.replayed)
                .unwrap_or(false);
            match shape {
                Shape::Item => {
                    let Ok(parsed) = serde_json::from_str::<WireWriteAnswer>(&body) else {
                        // Counted, not accepted: the device cannot say what
                        // the server took.
                        let conn = core.conn()?;
                        let refusals = store::count_refusal(&conn, &row.id)?;
                        drop(conn);
                        return finish_counted(core, row, refusals, envelope);
                    };
                    let (verdict, conflicted_copy_id, merged_fields) =
                        match &parsed.conflict_resolution {
                            None => (Verdict::Accepted, None, Vec::new()),
                            Some(resolution) => match &resolution.conflicted_copy_id {
                                None => (Verdict::Merged, None, resolution.fields.clone()),
                                Some(sibling) => (
                                    Verdict::Conflicted,
                                    Some(sibling.clone()),
                                    resolution.fields.clone(),
                                ),
                            },
                        };
                    let mut conn = core.conn()?;
                    let catalog = Catalog::load(&conn)?;
                    let indexing = catalog.indexing(&parsed.item.r#type);
                    let tags = parsed
                        .metadata
                        .as_ref()
                        .map(|metadata| metadata.tags.clone());
                    let tx = conn.transaction()?;
                    // Not over a newer row: a replayed answer can arrive
                    // after a catch-up brought a later version. Only a move
                    // out of the slice lets the row go; an edit to a row held
                    // outside it, such as an attachment, keeps it, and an
                    // answer behind a move does not put back what the move
                    // let go.
                    let newer = store::holds_later(
                        &tx,
                        Subject::Item,
                        &parsed.item.id,
                        parsed.item.version,
                        &parsed.item.updated_at,
                    )?;
                    let moved_out = !newer
                        && row.kind != WriteKind::CreateItem
                        && !store::slice_holds(&tx, &catalog, &parsed.item)?
                        && (!store::item_held(&tx, &parsed.item.id)?
                            || row.kind == WriteKind::UpdateItem && store::moves(&row.body));
                    if moved_out {
                        store::evict_item(&tx, &parsed.item.id, &store::whole_edge_types(&tx)?)?;
                    } else {
                        store::put_server_item(&tx, &parsed.item, tags.as_deref(), &indexing)?;
                    }
                    // A keyed create went without the minted id, so its
                    // answer names the server's row.
                    if row.kind == WriteKind::CreateItem
                        && let Some(local) = row.item_id.as_deref()
                    {
                        store::adopt_answered_id(&tx, local, &parsed.item.id)?;
                        store::refollow(&tx, &parsed.item.id, &row.id)?;
                    }
                    store::record_verdict(
                        &tx,
                        &row.id,
                        &store::Answered {
                            verdict,
                            reason: None,
                            answer: envelope.as_deref(),
                            conflicted_copy_id: conflicted_copy_id.as_deref(),
                        },
                    )?;
                    move_edits_behind(
                        &tx,
                        row,
                        verdict,
                        parsed.acknowledged,
                        &parsed.item.id,
                        &AnsweredAt {
                            version: parsed.item.version,
                            item: Some(&parsed.item),
                        },
                    )?;
                    // Set aside against this device's own earlier save: the
                    // file holds the newest, so the pull leaves it and the
                    // next scan sends it as an edit.
                    if verdict == Verdict::Conflicted
                        && row.kind == WriteKind::UpdateItem
                        && against_its_own(&tx, row, &parsed)?
                    {
                        store::untake_latest_save(&tx, row, &parsed.item.id, parsed.item.version)?;
                    }
                    store::lay_waiting_writes_over(&tx, &parsed.item.id, &|laid| {
                        catalog.indexing(laid)
                    })?;
                    tx.commit()?;
                    Ok(Settled {
                        verdict: Some(verdict),
                        conflicted_copy_id,
                        replayed: parsed.acknowledged || replayed_header,
                        merged_fields,
                        ..Settled::plain(None, None, row.refusals)
                    })
                }
                Shape::Edge => {
                    let Ok(parsed) = serde_json::from_str::<WireEdgeAnswer>(&body) else {
                        let conn = core.conn()?;
                        let refusals = store::count_refusal(&conn, &row.id)?;
                        drop(conn);
                        return finish_counted(core, row, refusals, envelope);
                    };
                    let mut conn = core.conn()?;
                    let tx = conn.transaction()?;
                    store::put_server_edge(&tx, &parsed.edge)?;
                    store::record_verdict(
                        &tx,
                        &row.id,
                        &store::Answered {
                            verdict: Verdict::Accepted,
                            reason: None,
                            answer: envelope.as_deref(),
                            conflicted_copy_id: None,
                        },
                    )?;
                    move_edits_behind(
                        &tx,
                        row,
                        Verdict::Accepted,
                        parsed.acknowledged,
                        &parsed.edge.id,
                        &AnsweredAt {
                            version: parsed.edge.version,
                            item: None,
                        },
                    )?;
                    store::lay_waiting_edge_writes_over(&tx, &parsed.edge.id)?;
                    store::let_go_of_untaken_edge(&tx, &parsed.edge.id)?;
                    tx.commit()?;
                    Ok(Settled {
                        replayed: parsed.acknowledged || replayed_header,
                        ..Settled::plain(Some(Verdict::Accepted), None, row.refusals)
                    })
                }
                Shape::Blob => {
                    // Another hash is unreadable: a file item naming the
                    // queued hash would name nothing.
                    let named = serde_json::from_str::<serde_json::Value>(&body)
                        .ok()
                        .and_then(|answer| Some(answer.get("hash")?.as_str()?.to_string()));
                    if named.as_deref() != row.blob.as_deref() {
                        let conn = core.conn()?;
                        let refusals = store::count_refusal(&conn, &row.id)?;
                        drop(conn);
                        return finish_counted(core, row, refusals, envelope);
                    }
                    let conn = core.conn()?;
                    store::record_verdict(
                        &conn,
                        &row.id,
                        &store::Answered {
                            verdict: Verdict::Accepted,
                            reason: None,
                            answer: envelope.as_deref(),
                            conflicted_copy_id: None,
                        },
                    )?;
                    Ok(Settled::plain(Some(Verdict::Accepted), None, row.refusals))
                }
                Shape::Plain => {
                    let mut conn = core.conn()?;
                    let tx = conn.transaction()?;
                    store::record_verdict(
                        &tx,
                        &row.id,
                        &store::Answered {
                            verdict: Verdict::Accepted,
                            reason: None,
                            answer: envelope.as_deref(),
                            conflicted_copy_id: None,
                        },
                    )?;
                    store::fold_into_beneath(&tx, row)?;
                    tx.commit()?;
                    Ok(Settled {
                        replayed: replayed_header,
                        ..Settled::plain(Some(Verdict::Accepted), None, row.refusals)
                    })
                }
            }
        }
        Classified::Environmental => Ok(Settled {
            unavailable: unavailable(answer),
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
            {
                let mut conn = core.conn()?;
                let tx = conn.transaction()?;
                store::record_refusal(&tx, row, &code, envelope.as_deref(), true)?;
                tx.commit()?;
            }
            let unread = reconcile(core, row)?;
            Ok(Settled {
                retry_after_seconds: unread
                    .as_ref()
                    .and_then(|unread| unread.retry_after_seconds),
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
        Classified::Landed { id, code } => land(core, row, answer, shape, &id, code),
        Classified::Trashed => {
            {
                let mut conn = core.conn()?;
                let tx = conn.transaction()?;
                // Its row was only ever this device's, so nothing is owed.
                store::record_refusal(&tx, row, "trashed", envelope.as_deref(), false)?;
                if let Some(local) = row.item_id.as_deref() {
                    store::unpin(&tx, local)?;
                }
                tx.commit()?;
            }
            Ok(Settled::plain(
                Some(Verdict::Refused),
                Some("trashed".into()),
                row.refusals,
            ))
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
            let conn = core.conn()?;
            store::record_verdict(
                &conn,
                &row.id,
                &store::Answered {
                    verdict: Verdict::Blocked,
                    reason: Some(reason.as_str()),
                    answer: envelope.as_deref(),
                    conflicted_copy_id: None,
                },
            )?;
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

/// The row is read first unless the copy holds it at a version the server
/// still holds. Then the copy keeps it as read, so the next edit is based on
/// that version and the server merges it rather than taking it as newer.
fn land(
    core: &Core,
    row: &QueuedWrite,
    answer: &std::result::Result<Answer, CoreError>,
    shape: Shape,
    id: &str,
    code: String,
) -> Result<Settled> {
    let envelope = answer.as_ref().ok().map(|answer| answer.body.clone());
    // A `version_conflict` says the server still holds the version the
    // create read; an `ancestor_unavailable` says it does not.
    let read_at = row
        .base_version
        .filter(|version| code == "version_conflict" && *version > 0);
    let held = {
        let conn = core.conn()?;
        store::item_held(&conn, id)?
    };
    let read = if held && read_at.is_some() {
        None
    } else {
        match core.http()?.item(id) {
            Ok(Some(found)) => Some(found),
            // The server keeps its answer under the create's key, so the next
            // drain is answered the same way and reads again.
            Err(error) if error.is_environmental() => {
                return Ok(Settled {
                    retry_after_seconds: error.retry_after().map(|wait| wait.as_secs()),
                    unavailable: unavailable_by(&error),
                    ..Settled::plain(None, None, row.refusals)
                });
            }
            // Not read, as for any answer on another contract: the pass
            // ends, and the create goes again under its key.
            Err(error @ CoreError::ContractMismatch { .. }) => return Err(error),
            Err(CoreError::Unauthorized { .. }) => {
                return settle(
                    core,
                    row,
                    answer,
                    Classified::BlockQueue(BlockedReason::CredentialRefused),
                    shape,
                );
            }
            // Gone or out of reach since the refusal: nothing to move onto.
            Ok(None) | Err(CoreError::NotFound { .. } | CoreError::Forbidden { .. }) => {
                let reason = if code == "version_conflict" {
                    BlockedReason::ConflictUnresolved
                } else {
                    BlockedReason::AncestorUnavailable
                };
                return settle(core, row, answer, Classified::Block(reason), shape);
            }
            Err(_) => return settle(core, row, answer, Classified::Counted, shape),
        }
    };
    let mut conn = core.conn()?;
    let catalog = Catalog::load(&conn)?;
    let tx = conn.transaction()?;
    if let Some(found) = &read {
        let indexing = catalog.indexing(&found.item.r#type);
        store::put_server_item(&tx, &found.item, Some(&found.metadata.tags), &indexing)?;
    }
    let refused = store::land_on_held_row(&tx, row, id)?;
    // The copy is on the server's row now; the minted one is gone.
    store::record_refusal(&tx, row, &code, envelope.as_deref(), false)?;
    store::lay_waiting_writes_over(&tx, id, &|laid| catalog.indexing(laid))?;
    tx.commit()?;
    Ok(Settled {
        also: refused
            .into_iter()
            .map(|(other, reason)| (other, Verdict::Refused, reason))
            .collect(),
        ..Settled::plain(Some(Verdict::Refused), Some(code), row.refusals)
    })
}

fn finish_counted(
    core: &Core,
    row: &QueuedWrite,
    refusals: i64,
    envelope: Option<String>,
) -> Result<Settled> {
    if refusals < store::CEILING {
        return Ok(Settled::plain(None, None, refusals));
    }
    let conn = core.conn()?;
    store::record_verdict(
        &conn,
        &row.id,
        &store::Answered {
            verdict: Verdict::Dead,
            reason: None,
            answer: envelope.as_deref(),
            conflicted_copy_id: None,
        },
    )?;
    Ok(Settled::plain(Some(Verdict::Dead), None, refusals))
}

/// A read rather than a wait for catch-up: a refused write produces no
/// event. The verdict and the copy put back are recorded already, and so is
/// the read owed, so a read that fails is tried by the next drain; only an
/// answer on another contract fails this, ending the pass. Answers why where
/// the server could not be read, which ends the pass too.
fn reconcile(core: &Core, row: &QueuedWrite) -> Result<Option<Unreadable>> {
    let Some(owed) = store::owed_of(&*core.conn()?, row)? else {
        return Ok(None);
    };
    match read_owed(core, &owed).and_then(|read| apply_owed(core, &owed, &read)) {
        Err(error @ CoreError::ContractMismatch { .. }) => Err(error),
        Err(error) => {
            // A refused create's id is the server's only if a read finds it.
            if row.kind == WriteKind::CreateItem {
                store::unpin(&*core.conn()?, &owed.id)?;
            }
            Ok(unreadable(&error))
        }
        Ok(()) => Ok(None),
    }
}

struct Unreadable {
    reason: String,
    retry_after_seconds: Option<u64>,
}

fn unreadable(error: &CoreError) -> Option<Unreadable> {
    Some(Unreadable {
        reason: unavailable_by(error)?,
        retry_after_seconds: error.retry_after().map(|wait| wait.as_secs()),
    })
}

/// Every read-back a refusal left owed, tried before anything is sent. One
/// that fails again stays owed, and one that cannot get through ends the
/// pass before anything is sent.
fn read_owed_backs(core: &Core) -> Result<Option<Unreadable>> {
    let owed = store::owed_read_backs(&*core.conn()?)?;
    for entry in owed {
        match read_owed(core, &entry).and_then(|read| apply_owed(core, &entry, &read)) {
            Err(error @ CoreError::ContractMismatch { .. }) => return Err(error),
            Err(error) => {
                if let Some(unread) = unreadable(&error) {
                    return Ok(Some(unread));
                }
            }
            Ok(()) => {}
        }
    }
    Ok(None)
}

fn apply_owed(core: &Core, owed: &store::Owed, read: &ReadBack) -> Result<()> {
    let mut conn = core.conn()?;
    let tx = conn.transaction()?;
    apply_read_back(&tx, read)?;
    store::settle_read_back(&tx, owed.subject, &owed.id)?;
    tx.commit()?;
    Ok(())
}

pub(crate) enum ReadBack {
    Nothing,
    Item {
        id: String,
        held: Option<Box<crate::wire::WireItemWithMetadata>>,
        /// Read before anything changes the queue.
        moved: bool,
        /// The copy's stamp before the read, so a row the read did not find
        /// is forgotten only where nothing has written it since.
        before: Option<store::Stamp>,
    },
    Edge {
        id: String,
        held: Option<Box<WireEdge>>,
        before: Option<store::Stamp>,
    },
}

/// Changes nothing; `apply_read_back` writes what it read.
pub(crate) fn read_back(core: &Core, row: &QueuedWrite) -> Result<ReadBack> {
    let owed = store::owed_of(&*core.conn()?, row)?;
    match owed {
        Some(owed) => read_owed(core, &owed),
        None => Ok(ReadBack::Nothing),
    }
}

fn read_owed(core: &Core, owed: &store::Owed) -> Result<ReadBack> {
    let http = core.http()?;
    let before = store::stamp(&*core.conn()?, owed.subject, &owed.id)?;
    if owed.subject == Subject::Edge {
        let Some(source) = owed.source_id.as_deref() else {
            return Ok(ReadBack::Nothing);
        };
        // Every page: an edge missing from the first may be on a later one,
        // and the copy would delete it with no event to put it back.
        let mut found = None;
        if let Some(edge_type) = &owed.edge_type {
            let mut cursor: Option<String> = None;
            loop {
                // A source whose create never landed holds no edges.
                let page = match http.item_edges_page(source, edge_type, cursor.as_deref()) {
                    Err(CoreError::NotFound { .. }) => break,
                    page => page?,
                };
                found = page.data.into_iter().find(|edge| edge.id == owed.id);
                if found.is_some() {
                    break;
                }
                match page.next_cursor {
                    None => break,
                    // A cursor that does not move would spin forever.
                    Some(next) if Some(&next) != cursor.as_ref() => cursor = Some(next),
                    Some(_) => {
                        return Err(CoreError::Invalid(format!(
                            "the server kept answering with the same cursor while reporting more \
                             edges for {source}, so whether it still holds {} cannot be answered",
                            owed.id
                        )));
                    }
                }
            }
        }
        return Ok(ReadBack::Edge {
            id: owed.id.clone(),
            held: found.map(Box::new),
            before,
        });
    }
    Ok(ReadBack::Item {
        id: owed.id.clone(),
        held: http.item(&owed.id)?.map(Box::new),
        moved: owed.moved,
        before,
    })
}

pub(crate) fn apply_read_back(conn: &rusqlite::Connection, read: &ReadBack) -> Result<()> {
    match read {
        ReadBack::Nothing => {}
        ReadBack::Edge {
            id,
            held: Some(edge),
            ..
        } => {
            if store::put_server_edge(conn, edge)? {
                store::lay_waiting_edge_writes_over(conn, id)?;
                store::let_go_of_untaken_edge(conn, id)?;
            }
        }
        ReadBack::Edge {
            id,
            held: None,
            before,
        } => {
            let now = store::stamp(conn, Subject::Edge, id)?;
            if now.is_none() || now == *before {
                store::forget_edge(conn, id)?;
            }
        }
        ReadBack::Item {
            held: Some(held),
            moved,
            ..
        } => {
            let item = &held.item;
            if store::holds_later(
                conn,
                Subject::Item,
                &item.id,
                item.version,
                &item.updated_at,
            )? {
                store::settle_read_back(conn, Subject::Item, &item.id)?;
                return Ok(());
            }
            let catalog = Catalog::load(conn)?;
            let indexing = catalog.indexing(&item.r#type);
            // Outside the slice: not put back where a move ahead let it go,
            // and let go where this refused write was itself a move. A row
            // held outside the slice for another reason, an attachment,
            // stays.
            let let_go = !store::slice_holds(conn, &catalog, item)?
                && (!store::item_held(conn, &item.id)? || *moved);
            if let_go {
                store::evict_item(conn, &item.id, &store::whole_edge_types(conn)?)?;
                return Ok(());
            }
            store::put_server_item(conn, item, Some(&held.metadata.tags), &indexing)?;
            store::lay_waiting_writes_over(conn, &item.id, &|laid| catalog.indexing(laid))?;
        }
        ReadBack::Item {
            id,
            held: None,
            before,
            ..
        } => {
            let now = store::stamp(conn, Subject::Item, id)?;
            if now.is_none() || now == *before {
                store::forget_item(conn, id)?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn write<'a>(
        kind: WriteKind,
        item_id: &'a str,
        edge_id: Option<&'a str>,
        base_version: Option<i64>,
        depends_on: &'a [String],
    ) -> store::NewWrite<'a> {
        store::NewWrite {
            kind,
            item_id: Some(item_id),
            target_id: None,
            edge_id,
            namespace: None,
            tag: None,
            blob: None,
            base_version,
            payload: "{}",
            depends_on,
        }
    }

    fn based_on(conn: &rusqlite::Connection, id: &str) -> (Option<i64>, Option<i64>) {
        let row = store::queued_write(conn, id).unwrap().unwrap();
        let body: serde_json::Value =
            serde_json::from_str(&store::payload_of(conn, id).unwrap()).unwrap();
        (row.base_version, body["version"].as_i64())
    }

    const SUBJECTS: [(WriteKind, WriteKind, &str, Option<&str>); 2] = [
        (WriteKind::CreateItem, WriteKind::UpdateItem, "mine", None),
        (
            WriteKind::CreateEdge,
            WriteKind::UpdateEdge,
            "link",
            Some("link"),
        ),
    ];

    #[test]
    fn only_an_answer_about_the_row_itself_rebases_an_edit_of_it() {
        let conn = store::open_in_memory().unwrap();
        for (created, edited, subject, edge) in SUBJECTS {
            let create = store::enqueue(&conn, &write(created, "mine", edge, None, &[])).unwrap();
            let depends_on = [create.id.clone()];
            let edit =
                store::enqueue(&conn, &write(edited, "mine", edge, Some(0), &depends_on)).unwrap();
            let issued =
                store::enqueue(&conn, &write(edited, "mine", edge, Some(3), &depends_on)).unwrap();

            move_edits_behind(&conn, &create, Verdict::Accepted, false, "theirs", &at(5)).unwrap();
            assert_eq!(
                based_on(&conn, &edit.id),
                (Some(0), None),
                "an answer about another row rebased an edit of this one"
            );
            move_edits_behind(&conn, &create, Verdict::Accepted, false, subject, &at(5)).unwrap();
            assert_eq!(based_on(&conn, &edit.id), (Some(5), Some(5)));
            assert_eq!(based_on(&conn, &issued.id), (Some(3), None));
        }
    }

    fn at(version: i64) -> AnsweredAt<'static> {
        AnsweredAt {
            version,
            item: None,
        }
    }

    #[test]
    fn an_item_edit_moves_only_onto_a_later_answer_that_holds_what_it_read() {
        let conn = store::open_in_memory().unwrap();
        let queue = |base| {
            store::enqueue(
                &conn,
                &write(WriteKind::UpdateItem, "mine", None, Some(base), &[]),
            )
            .unwrap()
        };
        let first = queue(3);
        let read = queue(3);
        let unread = queue(3);
        let later = queue(6);
        for edit in [&read, &later] {
            store::record_read(&conn, &edit.id, &json!({ "properties": {} })).unwrap();
        }
        let answered = store::testing::note("mine", "title", "body", "2026-01-01T00:00:00Z");
        let answer = AnsweredAt {
            version: 5,
            item: Some(&answered),
        };
        move_edits_behind(&conn, &first, Verdict::Accepted, false, "mine", &answer).unwrap();
        assert_eq!(based_on(&conn, &read.id), (Some(5), Some(5)));
        assert_eq!(
            based_on(&conn, &unread.id),
            (Some(3), None),
            "an edit whose reading was never recorded was moved onto an answer"
        );
        assert_eq!(
            based_on(&conn, &later.id),
            (Some(6), None),
            "an edit made on a later version was moved back onto an older answer"
        );
    }

    #[test]
    fn an_edit_holds_where_the_answer_keeps_every_property_it_changed_as_read() {
        let answered = |properties: serde_json::Value| {
            let mut item = store::testing::note("mine", "title", "body", "2026-01-01T00:00:00Z");
            item.properties = properties.as_object().unwrap().clone();
            item.version = 5;
            item
        };
        for (read, sent, row, expected) in [
            (
                json!({ "body": "first", "title": "held" }),
                json!({ "body": "second", "title": "held" }),
                json!({ "body": "first", "title": "elsewhere" }),
                true,
            ),
            (
                json!({ "body": "first", "title": "held" }),
                json!({ "body": "second", "title": "mine" }),
                json!({ "body": "first", "title": "elsewhere" }),
                false,
            ),
            (
                json!({ "body": "first", "title": "held" }),
                json!({ "body": "second", "title": "mine" }),
                json!({ "body": "first", "title": "held" }),
                true,
            ),
            (
                json!({ "notes": "kept" }),
                json!({ "notes": "mine" }),
                json!({ "body": "first" }),
                false,
            ),
            (
                json!({ "notes": null }),
                json!({ "notes": "mine" }),
                json!({ "body": "first" }),
                true,
            ),
        ] {
            let conn = store::open_in_memory().unwrap();
            let body = json!({ "version": 3, "properties": sent }).to_string();
            let edit = store::enqueue(
                &conn,
                &store::NewWrite {
                    payload: &body,
                    ..write(WriteKind::UpdateItem, "mine", None, Some(3), &[])
                },
            )
            .unwrap();
            store::record_read(&conn, &edit.id, &json!({ "properties": read })).unwrap();
            let item = answered(row.clone());
            let at = AnsweredAt {
                version: 5,
                item: Some(&item),
            };
            assert_eq!(
                holds(&conn, &edit.id, &at).unwrap(),
                expected,
                "an edit that read {read} and carries {sent}, against an answer holding {row}"
            );
        }
    }

    #[test]
    fn an_edit_made_against_one_that_did_not_land_goes_back_onto_its_base() {
        let conn = store::open_in_memory().unwrap();
        let queue = |base: i64, properties: serde_json::Value| {
            let body = json!({ "version": base, "properties": properties }).to_string();
            store::enqueue(
                &conn,
                &store::NewWrite {
                    payload: &body,
                    ..write(WriteKind::UpdateItem, "mine", None, Some(base), &[])
                },
            )
            .unwrap()
        };
        let ahead = queue(3, json!({ "body": "first" }));
        let shares = queue(4, json!({ "body": "second", "title": "held" }));
        let apart = queue(4, json!({ "title": "mine" }));
        let alongside = queue(3, json!({ "body": "third" }));
        store::record_read(
            &conn,
            &shares.id,
            &json!({ "properties": { "body": "first", "title": "held" } }),
        )
        .unwrap();
        move_edits_back(&conn, &ahead).unwrap();
        let moved: serde_json::Value =
            serde_json::from_str(&store::payload_of(&conn, &shares.id).unwrap()).unwrap();
        assert_eq!(
            moved,
            json!({ "version": 3, "properties": { "body": "second" } }),
            "the edit made against the first's body did not go back onto its base"
        );
        assert_eq!(
            store::queued_write(&conn, &apart.id)
                .unwrap()
                .unwrap()
                .base_version,
            Some(4),
            "an edit sharing nothing with the first went back onto its base"
        );
        assert_eq!(
            store::queued_write(&conn, &alongside.id)
                .unwrap()
                .unwrap()
                .base_version,
            Some(3)
        );
    }

    #[test]
    fn a_move_drops_what_the_edit_carries_unchanged() {
        let conn = store::open_in_memory().unwrap();
        let body = json!({ "version": 3, "properties": { "title": "held", "body": "second" } })
            .to_string();
        let edit = store::enqueue(
            &conn,
            &store::NewWrite {
                payload: &body,
                ..write(WriteKind::UpdateItem, "mine", None, Some(3), &[])
            },
        )
        .unwrap();
        store::record_read(
            &conn,
            &edit.id,
            &json!({ "properties": { "title": "held", "body": "first" } }),
        )
        .unwrap();
        store::move_edit(&conn, &edit.id, 5, None).unwrap();
        let moved: serde_json::Value =
            serde_json::from_str(&store::payload_of(&conn, &edit.id).unwrap()).unwrap();
        assert_eq!(
            moved,
            json!({ "version": 5, "properties": { "body": "second" } })
        );
    }

    #[test]
    fn a_whole_edit_moves_as_the_answer_with_its_changes_laid_over() {
        let conn = store::open_in_memory().unwrap();
        let body = json!({
            "version": 3,
            "properties_mode": "replace",
            "properties": { "title": "held", "body": "second" },
        })
        .to_string();
        let edit = store::enqueue(
            &conn,
            &store::NewWrite {
                payload: &body,
                ..write(WriteKind::UpdateItem, "mine", None, Some(3), &[])
            },
        )
        .unwrap();
        store::record_read(
            &conn,
            &edit.id,
            &json!({ "properties": { "title": "held", "body": "first", "notes": "gone" } }),
        )
        .unwrap();
        let answer = json!({ "title": "theirs", "body": "first", "notes": "gone", "added": 1 });
        store::move_edit(&conn, &edit.id, 5, answer.as_object()).unwrap();
        let moved: serde_json::Value =
            serde_json::from_str(&store::payload_of(&conn, &edit.id).unwrap()).unwrap();
        assert_eq!(
            moved["properties"],
            json!({ "title": "theirs", "body": "second", "added": 1 })
        );
        assert_eq!(moved["properties_mode"], "replace");
        assert_eq!(moved["version"], 5);
    }

    #[test]
    fn only_the_waiting_unsent_edits_queued_after_it_are_behind_it() {
        let conn = store::open_in_memory().unwrap();
        let queue = |item: &str| {
            store::enqueue(
                &conn,
                &write(WriteKind::UpdateItem, item, None, Some(3), &[]),
            )
            .unwrap()
        };
        let _earlier = queue("mine");
        let first = queue("mine");
        let sent = queue("mine");
        store::mark_sent(&conn, &sent.id).unwrap();
        let refused = queue("mine");
        let blocked = queue("mine");
        for (id, verdict) in [
            (&refused.id, Verdict::Refused),
            (&blocked.id, Verdict::Blocked),
        ] {
            store::record_verdict(
                &conn,
                id,
                &store::Answered {
                    verdict,
                    reason: (verdict == Verdict::Blocked)
                        .then_some(BlockedReason::AwaitingDependency.as_str()),
                    answer: None,
                    conflicted_copy_id: None,
                },
            )
            .unwrap();
        }
        let waiting = queue("mine");
        let _other = queue("theirs");

        let behind = store::edits_behind(&conn, &first, "mine").unwrap();
        assert_eq!(
            behind,
            vec![(blocked.id.clone(), Some(3)), (waiting.id.clone(), Some(3))],
            "the edits behind named one queued before the answered one, one already sent, one refused by the drain, or one of another row"
        );
    }

    /// A copy holding `rows` as the server answered them, each deleted
    /// locally, so each is one write to a door of its own.
    fn deleting(server: &crate::scripted::Scripted, rows: &[&str]) -> (tempfile::TempDir, Core) {
        let dir = tempfile::tempdir().unwrap();
        let core = Core::open(
            dir.path().join("core.sqlite"),
            Some(crate::Server {
                url: server.url(),
                key: "k".into(),
            }),
        )
        .unwrap();
        {
            let conn = core.conn().unwrap();
            store::meta_set(&conn, store::META_EVENT_CURSOR, "10").unwrap();
            store::meta_set(&conn, store::META_SLICE_TYPES, "[\"core.note\"]").unwrap();
            store::meta_set(&conn, store::META_SLICE_TIER, "library").unwrap();
            for id in rows {
                let item = store::testing::note(id, id, "", "2026-01-01T00:00:00Z");
                store::upsert_item(&conn, &item, None, &Default::default()).unwrap();
            }
        }
        for id in rows {
            core.delete_item(id).unwrap();
        }
        (dir, core)
    }

    #[test]
    fn a_read_reconciling_a_refusal_refused_naming_no_contract_ends_the_pass() {
        let server = crate::scripted::Scripted::start();
        let rows = ["a", "b"];
        // `a` is refused and read back; the read meets a proxy, so `b` waits.
        server.on(
            "/items/a",
            vec![
                crate::scripted::refusal(400, "invalid"),
                crate::scripted::unnamed(400, "bad_request"),
            ],
        );
        server.on(
            "/items/b",
            vec![crate::scripted::json(200, r#"{"ok":true}"#)],
        );
        let (_dir, core) = deleting(&server, &rows);
        let report = core.drain().unwrap();
        assert_eq!(
            server.seen("/items/b").len(),
            0,
            "the pass went on past a read something in front of the server refused"
        );
        assert!(
            report
                .unavailable
                .as_deref()
                .is_some_and(|why| why.contains("naming no contract")),
            "{report:?}"
        );
        assert_eq!((report.answered, report.undelivered), (1, 1));
    }

    #[test]
    fn drains_at_once_send_each_write_once_and_count_only_their_own() {
        let server = crate::scripted::Scripted::start();
        let rows = ["a", "b", "c"];
        for id in rows {
            server.on(
                &format!("/items/{id}"),
                vec![crate::scripted::Answer::Slow {
                    after: std::time::Duration::from_millis(150),
                    answer: Box::new(crate::scripted::json(200, r#"{"ok":true}"#)),
                }],
            );
        }
        let (_dir, core) = deleting(&server, &rows);

        let answered: Vec<usize> = std::thread::scope(|scope| {
            let drains: Vec<_> = (0..3)
                .map(|_| scope.spawn(|| core.drain().unwrap().answered))
                .collect();
            drains
                .into_iter()
                .map(|drain| drain.join().unwrap())
                .collect()
        });

        let sent: Vec<usize> = rows
            .iter()
            .map(|id| server.seen(&format!("/items/{id}")).len())
            .collect();
        assert_eq!(
            sent,
            [1, 1, 1],
            "drains at once sent a write more than once"
        );
        assert_eq!(
            answered.iter().sum::<usize>(),
            3,
            "the drains counted writes another drain had answered: {answered:?}"
        );
    }

    #[test]
    fn a_pass_ends_at_the_first_write_the_server_cannot_take() {
        for (cannot, says) in [
            (crate::scripted::refusal(503, "unavailable"), "503"),
            (crate::scripted::refusal(429, "rate_limited"), "429"),
            (crate::scripted::Answer::Stall, "reached"),
        ] {
            let server = crate::scripted::Scripted::start();
            let rows = ["a", "b", "c"];
            server.on("/items/a", vec![cannot]);
            for id in &rows[1..] {
                server.on(
                    &format!("/items/{id}"),
                    vec![crate::scripted::json(200, r#"{"ok":true}"#)],
                );
            }
            let (_dir, core) = deleting(&server, &rows);
            if says == "reached" {
                // Gone rather than waited out: a refused connection.
                drop(server);
                let report = core.drain().unwrap();
                assert!(
                    report
                        .unavailable
                        .as_deref()
                        .is_some_and(|why| why.contains(says)),
                    "{report:?}"
                );
                assert_eq!((report.answered, report.undelivered), (0, 3));
                continue;
            }
            let report = core.drain().unwrap();
            assert_eq!(
                (server.seen("/items/b").len(), server.seen("/items/c").len()),
                (0, 0),
                "the pass went on to the writes behind one the server could not take"
            );
            assert_eq!((report.answered, report.undelivered), (0, 3));
            assert!(
                report
                    .unavailable
                    .as_deref()
                    .is_some_and(|why| why.contains(says)),
                "{report:?}"
            );
            assert!(
                core.queue()
                    .unwrap()
                    .iter()
                    .all(|row| row.verdict.is_none() && row.refusals == 0),
                "a write left behind was answered or counted"
            );
        }
    }

    #[test]
    fn a_refused_renewal_parks_the_queue_and_one_the_network_stopped_waits() {
        let refused = |renewal: CoreError| {
            let server = crate::scripted::Scripted::start();
            server.on(
                "/blobs",
                vec![crate::scripted::refusal(401, "unauthorized")],
            );
            let http = Http::new(&server.url(), "k").unwrap();
            let renewal = std::sync::Mutex::new(Some(renewal));
            http.renew_with(Box::new(move |_| {
                Err(renewal.lock().unwrap().take().expect("renewed once"))
            }));
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("bytes");
            std::fs::write(&path, b"hello").unwrap();
            classify(&upload(&http, File::open(&path).unwrap(), "text/plain"))
        };

        assert_eq!(
            refused(CoreError::Unauthorized {
                code: "signed_out".into(),
                message: "the sign-in ended".into(),
            }),
            Classified::BlockQueue(BlockedReason::CredentialRefused)
        );
        assert_eq!(
            refused(CoreError::Network(
                "the token endpoint did not answer".into()
            )),
            Classified::Environmental
        );
    }

    #[test]
    fn an_upload_refused_for_its_token_is_sent_again_whole_under_a_renewed_one() {
        let server = crate::scripted::Scripted::start();
        server.on(
            "/blobs",
            vec![
                crate::scripted::refusal(401, "unauthorized"),
                crate::scripted::json(201, r#"{"hash":"sha256:00","size_bytes":5}"#),
            ],
        );
        let http = Http::new(&server.url(), "k").unwrap();
        http.renew_with(Box::new(|_| Ok("fresh".into())));
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bytes");
        std::fs::write(&path, b"hello").unwrap();

        let answer = upload(&http, File::open(&path).unwrap(), "text/plain").unwrap();

        assert_eq!(answer.status, 201);
        let sent: Vec<_> = server
            .seen("/blobs")
            .into_iter()
            .map(|seen| (seen.authorization, seen.body))
            .collect();
        assert_eq!(
            sent,
            vec![
                (Some("Bearer k".into()), b"hello".to_vec()),
                (Some("Bearer fresh".into()), b"hello".to_vec()),
            ]
        );
    }
}
