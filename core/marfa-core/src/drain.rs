//! Sending what the queue holds, and recording what came back.
//!
//! One pass per call. A drain attempts each sendable row once and returns;
//! "retries without limit" (`queue-and-verdicts.md` 17) is across drains, not
//! inside one. A drain that spun on a row until the network came back would
//! be a call with no bound on it, and the two behaviors are indistinguishable
//! to a caller who runs the drain again.

use std::collections::HashMap;
use std::fs::File;

use serde::Serialize;

use crate::catalog::Catalog;
use crate::error::CoreError;
use crate::http::{Answer, Call, CallBody, Http, Method, Outgoing, ReplyBody};
use crate::model::{BlockedReason, QueuedWrite, Verdict, WriteKind};
use crate::store;
use crate::wire::{WireEdgeAnswer, WireErrorEnvelope, WireWriteAnswer};
use crate::{Core, Result};

/// What a drain did.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DrainReport {
    /// Rows the drain put on the wire.
    pub sent: usize,
    /// Rows it did not send because something they depend on is unanswered.
    pub held: usize,
    /// One entry per row the drain sent (`queue-and-verdicts.md` 6).
    pub verdicts: Vec<DrainVerdict>,
    /// Why the drain stopped before the queue was empty, when it did. A
    /// refused credential parks every row and stops the pass (20); nothing
    /// else ends a drain early.
    pub stopped: Option<String>,
    /// The longest wait the server asked for this pass, where it asked.
    ///
    /// An environmental failure retries on the next drain and the caller
    /// chooses when that is, so a `Retry-After` the device read and did not
    /// report would be the server's instruction arriving nowhere. The
    /// longest rather than the last: a caller waits once for the whole pass.
    pub retry_after_seconds: Option<u64>,
}

/// What became of one write this drain sent.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DrainVerdict {
    pub id: String,
    pub kind: WriteKind,
    pub item_id: Option<String>,
    /// One of the six, or absent where the write was sent and not answered —
    /// which is the absence of a verdict rather than a seventh
    /// (`queue-and-verdicts.md` 6).
    pub verdict: Option<Verdict>,
    pub reason: Option<String>,
    pub conflicted_copy_id: Option<String>,
    pub refusals: i64,
    /// The server answered from its idempotency record rather than writing
    /// (`queue-and-verdicts.md` 3).
    ///
    /// Read off the `Idempotency-Replayed` header and the answer's own
    /// `acknowledged`, either of which says it. Reported because it is the
    /// only way a caller can tell a write that landed now from one that had
    /// already landed and whose answer this device never saw — and telling
    /// those apart is the whole reason the key is minted once.
    pub replayed: bool,
    /// The fields the server resolved, on a `merged` or `conflicted` verdict.
    ///
    /// Whole fields (`queue-and-verdicts.md` 34). Empty on every other
    /// verdict, because nothing was resolved.
    pub merged_fields: Vec<String>,
}

impl DrainVerdict {
    /// What became of this write, with what its verdict carries; nothing
    /// where it was sent and not answered.
    pub fn outcome(&self) -> Result<Option<crate::model::Outcome>> {
        crate::model::Outcome::of(
            self.verdict,
            self.reason.as_deref(),
            self.conflicted_copy_id.as_deref(),
            self.merged_fields.clone(),
        )
    }
}

/// What one answer means for the write that got it.
///
/// Total over every answer and every transport failure, because statement 7
/// makes an answer a device cannot classify a defect in the device. The
/// variants are the classification of `queue-and-verdicts.md` 17 to 23 and
/// nothing else.
#[derive(Debug, Clone, PartialEq)]
enum Classified {
    /// A `2xx`. Which of the three successful verdicts it carries is read
    /// off the body, not decided here.
    Success,
    /// Retries without limit and is never counted (17).
    Environmental,
    /// Refused on the first answer; the server's code travels with it (18).
    Contract,
    /// Retries and is counted. The only class the ceiling exists for (19).
    Counted,
    /// This write stops, under one of the three reasons it carries
    /// (21, 22, 23).
    Block(BlockedReason),
    /// Every write stops and the drain ends (20).
    BlockQueue(BlockedReason),
}

/// Reads an answer, or the lack of one, into its class.
fn classify(answer: &std::result::Result<Answer, CoreError>) -> Classified {
    let answer = match answer {
        Ok(answer) => answer,
        // A dropped connection, a refused connection, a read that timed out:
        // statements about the environment rather than about the write (17).
        Err(CoreError::Network(_)) => return Classified::Environmental,
        // Anything else `send` can return is about the request rather than
        // the environment — a header the transport would not build, say —
        // and retrying it forever uncounted is the failure statement 17's
        // reasoning describes with the classes swapped. It retries and it
        // is counted, so it reaches the ceiling (19).
        Err(_) => return Classified::Counted,
    };
    if answer.is_success() {
        return Classified::Success;
    }
    match (answer.status, answer.code.as_str()) {
        // The one refusal that looks environmental and is not: it clears when
        // a person replaces the credential and never on its own (20).
        (401, _) => Classified::BlockQueue(BlockedReason::CredentialRefused),
        // The key has been answered for a different body, so it is the key
        // that is spent rather than the write (21).
        (422, "idempotency_key_reused") => Classified::Block(BlockedReason::KeySpent),
        // The snapshot the write names is gone, and settling means rebasing
        // on the version the server holds — a new write, not this one (22).
        (409, "ancestor_unavailable") => Classified::Block(BlockedReason::AncestorUnavailable),
        // A server that did not resolve a write that asked it to. A device
        // cannot resolve it itself (`device.md` 21) and re-sending is the
        // same request (23).
        (409, "version_conflict") => Classified::Block(BlockedReason::ConflictUnresolved),
        // The server holds the key and has not finished answering it. A
        // further attempt might clear it and nothing clears it on its own,
        // which is the third class exactly (19).
        (409, "idempotency_key_in_flight") => Classified::Counted,
        // Any `5xx` and a `429` clear without anybody doing anything (17).
        (429, _) => Classified::Environmental,
        (500..=599, _) => Classified::Environmental,
        // A request that timed out and one sent too early are statements
        // about the environment that happen to carry a 4xx: a proxy emits
        // the first about the network and the second asks for the same
        // request again. Refusing either would strand a good write.
        (408 | 425, _) => Classified::Environmental,
        // Every other refusal: the same request sent again is the same
        // request (18). Stated for 400, 403 and 404, and it is the reason
        // rather than the list that decides — a 405 or a 410 is refused for
        // the same reason, and reading one as retryable would loop on a
        // refusal that will never change.
        (400..=499, _) => Classified::Contract,
        // Neither a success nor a refusal: an answer this device cannot
        // read, which retries and is counted (19). A 1xx or a 3xx reaching
        // here is a response the agent did not resolve, and the next attempt
        // may well resolve it.
        _ => Classified::Counted,
    }
}

/// What a door's successful answer carries.
///
/// **Not every write is answered with an item**, and reading one as though
/// it were is how a write the server took came back as a failure. A tag, a
/// metadata write and an extension answer with the sidecar they changed; a
/// delete answers `{"ok": true}`; an edge answers the edge. A single parse
/// against the item shape succeeds for four kinds out of fourteen and reads
/// the other ten as an answer the device cannot understand — which counts a
/// refusal, retries a write the server has already taken, and kills it on
/// the fifth pass.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Shape {
    /// `{item, metadata, conflict_resolution?}`. The three successful
    /// verdicts live here and nowhere else: a resolution is about an item's
    /// fields, and nothing else this queue sends has any.
    Item,
    /// `{edge}`. Adopted, because an edge carries a version and the next
    /// update to it has to name the one the server minted.
    Edge,
    /// Anything else a `2xx` carries. The write is taken and the working
    /// copy already holds the change, so there is nothing to adopt.
    Plain,
    /// `{hash, mime_type, size_bytes}`: the name the server gave the bytes,
    /// which must be the name they were queued under
    /// (`queue-and-verdicts.md` 37).
    Blob,
}

/// Where a queued write goes.
enum Door<'a> {
    /// A JSON body to a door, and the shape of its successful answer.
    Json(Outgoing<'a>, Shape),
    /// The bytes held beside the store under `hash`, streamed as the body.
    Upload { hash: &'a str, mime_type: String },
}

/// A write ready for the wire, its body in hand.
enum Sendable<'a> {
    Json(Outgoing<'a>, Shape),
    Upload { bytes: File, mime_type: String },
}

/// Whether a row can go out yet.
enum Readiness {
    Ready,
    /// Something it names has not been answered (`queue-and-verdicts.md` 4).
    Held,
    /// Something it names was refused, so this one is too, and the reason
    /// names the write that was refused (16).
    RefusedWith(String),
}

fn readiness(
    row: &QueuedWrite,
    rows: &HashMap<&str, &QueuedWrite>,
    verdicts: &HashMap<String, Option<Verdict>>,
) -> Readiness {
    for dependency in &row.depends_on {
        // The verdict as this pass has it, which is not the verdict the pass
        // started with: a create answered a moment ago releases the update
        // waiting on it within the same drain rather than needing another.
        let Some(verdict) = verdicts.get(dependency.as_str()) else {
            // The row it waits for is not in the queue at all. Held rather
            // than sent: the dependency was the reason this write could not
            // go, and a queue that has lost it has not answered it either.
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

/// Where a queued write goes, what it carries, and the shape its door
/// answers a success with.
///
/// Every kind in `WriteKind` addresses here. No kind falls through to a
/// default: a write sent to the wrong door is a write the server takes and
/// the device reads as something else.
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
                // On every update this device sends (`queue-and-verdicts.md`
                // 5). The device resolves nothing itself; this asks the
                // server to resolve inside its own transaction rather than
                // refusing and leaving two writes where one is atomic.
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

/// Streams an upload's bytes to `POST /blobs`, and reads what came back as
/// the drain reads any answer.
///
/// No idempotency key: the door is idempotent by content, since bytes it
/// already holds answer the hash they already have, and it reads no key.
fn upload(http: &Http, bytes: File, mime_type: &str) -> std::result::Result<Answer, CoreError> {
    let reply = http.call(Call {
        method: Method::Post,
        segments: &["blobs"],
        params: &[],
        headers: &[("Content-Type", mime_type)],
        body: CallBody::Reader(Box::new(bytes)),
        credential: true,
        stream: false,
    })?;
    let body = match reply.body {
        ReplyBody::Text(text) => text,
        ReplyBody::Stream(_) => unreachable!("the core's transport reads every answer whole"),
    };
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
    })
}

/// Sends what the queue holds and records what came back.
pub fn drain(core: &Core, http: &Http) -> Result<DrainReport> {
    // A drain writes verdicts and adopts rows, so it is a write door and a
    // reading handle is refused at it exactly as it is at the others.
    core.lock_ref().refuse_unless_writer()?;
    {
        let conn = core.conn()?;
        // Before anything is read: a row blocked for a reason that clears on
        // its own is a finding of the last drain rather than a state, and
        // leaving it blocked here would make this drain skip a dependency
        // that has since been answered (`queue-and-verdicts.md` 24, 27).
        store::unblock_self_clearing(&conn)?;
    }

    let mut report = DrainReport {
        sent: 0,
        held: 0,
        verdicts: Vec::new(),
        stopped: None,
        retry_after_seconds: None,
    };

    // The order the rows were queued in, read once. A row answered during
    // this pass is written back into `answers` so that a write waiting on a
    // create is released by that create's verdict within the same drain
    // rather than needing another (`queue-and-verdicts.md` 24).
    let all = {
        let conn = core.conn()?;
        store::queued_writes(&conn)?
    };
    let mut answers: HashMap<String, Option<Verdict>> = all
        .iter()
        .map(|row| (row.id.clone(), row.verdict))
        .collect();

    let rows: HashMap<&str, &QueuedWrite> = all.iter().map(|row| (row.id.as_str(), row)).collect();

    for row in &all {
        if answers.get(&row.id).and_then(Option::as_ref).is_some() {
            continue;
        }

        match readiness(row, &rows, &answers) {
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
                report.held += 1;
                continue;
            }
            Readiness::RefusedWith(reason) => {
                let conn = core.conn()?;
                store::record_verdict(
                    &conn,
                    &row.id,
                    &store::Answered {
                        verdict: Verdict::Refused,
                        reason: Some(&reason),
                        answer: None,
                        conflicted_copy_id: None,
                    },
                )?;
                drop(conn);
                answers.insert(row.id.clone(), Some(Verdict::Refused));
                // Reconciled like any other refusal: the server never took
                // the write, so the copy must not go on holding it.
                reconcile(core, row);
                report.verdicts.push(verdict_of(
                    row,
                    &Settled::plain(Some(Verdict::Refused), Some(reason), row.refusals),
                ));
                continue;
            }
            Readiness::Ready => {}
        }

        let payload = {
            let conn = core.conn()?;
            if let Some(version) = own_create_version(&conn, row)? {
                store::rebase(&conn, &row.id, version)?;
            }
            store::payload_of(&conn, &row.id)?
        };
        // An upload's bytes are opened before anything is marked sent: bytes
        // gone from beside the store are a write that can never be sent, and
        // it settles here as refused rather than failing the pass.
        let sendable = match address(row, &payload)? {
            Door::Json(outgoing, shape) => Sendable::Json(outgoing, shape),
            Door::Upload { hash, mime_type } => {
                let opened = match core.cache()?.held(hash)? {
                    Some(path) => File::open(path),
                    None => Err(std::io::Error::from(std::io::ErrorKind::NotFound)),
                };
                match opened {
                    Ok(bytes) => Sendable::Upload { bytes, mime_type },
                    // Gone: a write that can never be sent, refused with the
                    // bytes named rather than left waiting for them.
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                        let reason = format!(
                            "the bytes of {hash} are no longer held beside the working copy, so there is nothing to send"
                        );
                        let conn = core.conn()?;
                        store::record_verdict(
                            &conn,
                            &row.id,
                            &store::Answered {
                                verdict: Verdict::Refused,
                                reason: Some(&reason),
                                answer: None,
                                conflicted_copy_id: None,
                            },
                        )?;
                        answers.insert(row.id.clone(), Some(Verdict::Refused));
                        report.verdicts.push(verdict_of(
                            row,
                            &Settled::plain(Some(Verdict::Refused), Some(reason), row.refusals),
                        ));
                        continue;
                    }
                    // Held and not opened now: a file locked, a process out of
                    // handles. Neither is the write's fault, so it stays
                    // unanswered and uncounted for the next drain, and the
                    // report says why.
                    Err(error) => {
                        report.verdicts.push(verdict_of(
                            row,
                            &Settled::plain(
                                None,
                                Some(format!("the bytes of {hash} could not be opened: {error}")),
                                row.refusals,
                            ),
                        ));
                        continue;
                    }
                }
            }
        };
        // The connection is not held across the send. A drain is the one
        // call that waits on a network, and holding the store shut for the
        // length of a queue's worth of requests would make `queue` — the
        // door a caller reads while a drain is running — wait on it.
        {
            // Before the answer, not after: a send whose answer never arrives
            // has still reached the server, and a release that treated it as
            // unsent would write it twice.
            let conn = core.conn()?;
            store::mark_sent(&conn, &row.id)?;
        }
        let (answer, shape) = match sendable {
            Sendable::Json(outgoing, shape) => (http.send(&outgoing), shape),
            Sendable::Upload { bytes, mime_type } => (upload(http, bytes, &mime_type), Shape::Blob),
        };
        report.sent += 1;
        if let Ok(answer) = &answer
            && let Some(wait) = answer.retry_after_seconds
        {
            report.retry_after_seconds = Some(
                report
                    .retry_after_seconds
                    .map_or(wait, |held| held.max(wait)),
            );
        }

        let settled = settle(core, row, &answer, classify(&answer), shape)?;
        answers.insert(row.id.clone(), settled.verdict);
        let stop = settled.stops_the_drain;
        report.verdicts.push(verdict_of(row, &settled));
        if stop {
            let conn = core.conn()?;
            let parked = store::block_unanswered(&conn, BlockedReason::CredentialRefused)?;
            report.stopped = Some(format!(
                "the server refused the credential, so every queued write is blocked and the drain stopped; {parked} row(s) parked"
            ));
            break;
        }
    }

    Ok(report)
}

/// The version a write should be sent on where it was based on this
/// device's own create (`queue-and-verdicts.md` 36): the local row of an
/// unanswered create is at 0, and the create's answer says what the server
/// made of it. Nothing where the write was based on anything else.
fn own_create_version(conn: &rusqlite::Connection, row: &QueuedWrite) -> Result<Option<i64>> {
    let (created, field, subject) = match row.kind {
        WriteKind::UpdateItem => (WriteKind::CreateItem, "item", row.item_id.as_deref()),
        WriteKind::UpdateEdge => (WriteKind::CreateEdge, "edge", row.edge_id.as_deref()),
        _ => return Ok(None),
    };
    if row.base_version != Some(0) {
        return Ok(None);
    }
    for dependency in &row.depends_on {
        let Some(create) = store::queued_write(conn, dependency)? else {
            continue;
        };
        if create.kind != created
            || !matches!(
                create.verdict,
                Some(Verdict::Accepted | Verdict::Merged | Verdict::Conflicted)
            )
        {
            continue;
        }
        // Only an answer about the row this write addresses. A create the
        // server took as an upsert onto another row answers with that row,
        // and its version is not one this write was ever based on.
        let answered = create
            .answer
            .as_deref()
            .and_then(|answer| serde_json::from_str::<serde_json::Value>(answer).ok())
            .and_then(|answer| answer.get(field).cloned());
        let Some(answered) = answered else {
            continue;
        };
        if answered.get("id").and_then(serde_json::Value::as_str) != subject {
            continue;
        }
        if let Some(version) = answered.get("version").and_then(serde_json::Value::as_i64) {
            return Ok(Some(version));
        }
    }
    Ok(None)
}

fn verdict_of(row: &QueuedWrite, settled: &Settled) -> DrainVerdict {
    DrainVerdict {
        id: row.id.clone(),
        kind: row.kind,
        item_id: row.item_id.clone(),
        verdict: settled.verdict,
        reason: settled.reason.clone(),
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
}

impl Settled {
    /// A settlement that reports nothing the server resolved, which is every
    /// one but a successful write.
    fn plain(verdict: Option<Verdict>, reason: Option<String>, refusals: i64) -> Settled {
        Settled {
            verdict,
            reason,
            conflicted_copy_id: None,
            refusals,
            stops_the_drain: false,
            replayed: false,
            merged_fields: Vec::new(),
        }
    }
}

/// Writes one answer's consequence into the store.
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
            // Either says the server answered from its record rather than
            // writing: the header is the replay cache's and `acknowledged`
            // is the route's, and a device that read only one of them would
            // report a second create as a first.
            let replayed_header = answer
                .as_ref()
                .map(|answer| answer.replayed)
                .unwrap_or(false);
            match shape {
                Shape::Item => {
                    let Ok(parsed) = serde_json::from_str::<WireWriteAnswer>(&body) else {
                        // A `2xx` whose body will not read is an answer the
                        // device cannot read: it retries and it is counted
                        // (`queue-and-verdicts.md` 19). It is not
                        // `accepted`, because the device cannot say what the
                        // server took.
                        let conn = core.conn()?;
                        let refusals = store::count_refusal(&conn, &row.id)?;
                        drop(conn);
                        return finish_counted(core, row, refusals, envelope);
                    };
                    // The three a `2xx` can carry, told apart by the
                    // answer's own fields rather than by comparing the row
                    // against the one the device imagined
                    // (`queue-and-verdicts.md` 8).
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
                    // The row the server returned, whole, including the
                    // version and the fields it stamps (9, 10, 11). The
                    // local row was minted at version 0 and this replaces it.
                    store::upsert_item(&tx, &parsed.item, tags.as_deref(), &indexing)?;
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
                    store::lay_waiting_writes_over(&tx, &parsed.item.id, &indexing)?;
                    tx.commit()?;
                    Ok(Settled {
                        verdict: Some(verdict),
                        reason: None,
                        conflicted_copy_id,
                        refusals: row.refusals,
                        stops_the_drain: false,
                        replayed: parsed.acknowledged || replayed_header,
                        merged_fields,
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
                    // Adopted for its version: the local edge was minted at
                    // 0 and the next update to it has to name the one the
                    // server gave it.
                    store::upsert_edge(&tx, &parsed.edge)?;
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
                    store::lay_waiting_edge_writes_over(&tx, &parsed.edge.id)?;
                    tx.commit()?;
                    Ok(Settled {
                        replayed: replayed_header,
                        ..Settled::plain(Some(Verdict::Accepted), None, row.refusals)
                    })
                }
                Shape::Blob => {
                    // The name the server gave the bytes, against the name
                    // they were queued under. Any other is an answer this
                    // device cannot read (19): accepting it would report an
                    // upload landed whose bytes the server holds under
                    // another name, and a file item naming the queued hash
                    // would then name nothing.
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
                    // The write is taken and the working copy already holds
                    // the change, so there is nothing to adopt. `accepted`
                    // and not one of the other two: a resolution is about an
                    // item's fields and none of these doors has any.
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
                    Ok(Settled {
                        replayed: replayed_header,
                        ..Settled::plain(Some(Verdict::Accepted), None, row.refusals)
                    })
                }
            }
        }
        Classified::Environmental => {
            // Nothing is written. The row stays unanswered and uncounted, so
            // a week offline leaves the ceiling where it was (17, 25).
            Ok(Settled::plain(None, None, row.refusals))
        }
        Classified::Contract => {
            let code = answer
                .as_ref()
                .ok()
                .map(|answer| answer.code.clone())
                .filter(|code| !code.is_empty())
                .unwrap_or_else(|| "unknown".into());
            // The verdict first, then the copy. The other order loses both
            // halves when the read that reconciles fails: the refusal is
            // never written, so the write goes out again against statement
            // 12, and the pass returns an error rather than the verdicts it
            // had already reached.
            {
                let conn = core.conn()?;
                store::record_verdict(
                    &conn,
                    &row.id,
                    &store::Answered {
                        verdict: Verdict::Refused,
                        // The server's code verbatim (12). Not translated: a
                        // device reports what it was told.
                        reason: Some(&code),
                        answer: envelope.as_deref(),
                        conflicted_copy_id: None,
                    },
                )?;
            }
            reconcile(core, row);
            Ok(Settled::plain(
                Some(Verdict::Refused),
                Some(code),
                row.refusals,
            ))
        }
        Classified::Counted => {
            let conn = core.conn()?;
            let refusals = store::count_refusal(&conn, &row.id)?;
            drop(conn);
            finish_counted(core, row, refusals, envelope)
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

/// A counted refusal: `dead` at the ceiling, and unanswered below it.
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

/// Puts the working copy back to what the server holds, after a refusal
/// (`queue-and-verdicts.md` 12).
///
/// A read rather than a wait for catch-up, because a write the server
/// refused changed nothing and so produced no event: without this the copy
/// would hold the edit the server declined, forever, and every later read
/// of that row would answer it.
///
/// **Best effort, and it says so by returning nothing.** The verdict is
/// already recorded when this runs, so a read that fails leaves the row
/// refused and the copy briefly wrong rather than un-refusing the write and
/// discarding every verdict the pass had reached. The next drain does not
/// retry it — a refusal is terminal — so a failure here is corrected by the
/// next catch-up that touches the row, or by a caller reading it.
fn reconcile(core: &Core, row: &QueuedWrite) {
    let _ = reconcile_inner(core, row);
}

fn reconcile_inner(core: &Core, row: &QueuedWrite) -> Result<()> {
    let http = core.http_ref()?;
    // An edge write names the edge, and its endpoints in `item_id` and
    // `target_id`. Reading `item_id` as the subject would re-read the source
    // *item* and leave the local edge exactly as the refused write left it:
    // a create's edge still there, an update's edit still applied, a
    // delete's edge still gone. A refusal produces no event, so catch-up
    // never corrects any of it.
    if matches!(
        row.kind,
        WriteKind::CreateEdge | WriteKind::UpdateEdge | WriteKind::DeleteEdge
    ) {
        let Some(source) = row.item_id.as_deref() else {
            return Ok(());
        };
        let Some(edge_id) = row.edge_id.as_deref() else {
            return Ok(());
        };
        // The edges the server holds for this source, read by type so the
        // page is the one the edge belongs to.
        let held = {
            let conn = core.conn()?;
            store::edge_by_id(&conn, edge_id)?
        };
        // A refused `delete_edge` is the case this whole branch exists for,
        // and it is the one where the copy cannot answer: the delete emptied
        // it at queue time, so there is no row to read a type from and the
        // read below would be skipped entirely — leaving the edge gone
        // locally, present on the server, and no event coming to say so.
        let edge_type = match held.as_ref() {
            Some(edge) => Some(edge.edge_type.clone()),
            None => {
                let conn = core.conn()?;
                let payload = store::payload_of(&conn, &row.id)?;
                serde_json::from_str::<serde_json::Value>(&payload)
                    .ok()
                    .and_then(|body| {
                        body.get("edge_type")
                            .and_then(|found| found.as_str().map(str::to_string))
                    })
            }
        };
        // **Every page, not the first.** Below the page limit the two are the
        // same; above it, "not on page one" was being read as "the server
        // holds no such edge", and the arm below then deleted a live edge
        // from the copy with no event coming to put it back.
        let mut found = None;
        if let Some(edge_type) = &edge_type {
            let mut cursor: Option<String> = None;
            loop {
                let page = http.item_edges_page(source, edge_type, cursor.as_deref())?;
                found = page.data.into_iter().find(|edge| edge.id == edge_id);
                if found.is_some() {
                    break;
                }
                match page.next_cursor {
                    None => break,
                    // A cursor that does not move is a server saying there is
                    // more and handing back the same place to look, which
                    // would spin this drain forever.
                    Some(next) if Some(&next) != cursor.as_ref() => cursor = Some(next),
                    Some(_) => {
                        return Err(CoreError::Invalid(format!(
                            "the server kept answering with the same cursor while reporting more \
                             edges for {source}, so whether it still holds {edge_id} cannot be answered"
                        )));
                    }
                }
            }
        }
        let conn = core.conn()?;
        match found {
            // Nothing is laid back over it: every later write to an edge
            // waits on the earlier ones, so a refused edge write refuses
            // them too (`queue-and-verdicts.md` 16) and none is left waiting.
            Some(edge) => {
                store::upsert_edge(&conn, &edge)?;
            }
            // The server holds no such edge, which for a refused create is
            // the honest answer and for a refused update means it went
            // elsewhere.
            None => {
                store::delete_edge(&conn, edge_id)?;
            }
        }
        return Ok(());
    }

    let Some(id) = row.item_id.as_deref() else {
        return Ok(());
    };
    match http.item(id)? {
        Some(held) => {
            let mut conn = core.conn()?;
            let catalog = Catalog::load(&conn)?;
            let indexing = catalog.indexing(&held.item.r#type);
            let tx = conn.transaction()?;
            store::upsert_item(&tx, &held.item, Some(&held.metadata.tags), &indexing)?;
            store::lay_waiting_writes_over(&tx, &held.item.id, &indexing)?;
            tx.commit()?;
        }
        None => {
            let conn = core.conn()?;
            store::forget_item(&conn, id)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
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

    /// The version comes from an answer about the row the edit addresses and
    /// no other. The witness is the same edit rebased once the answer names
    /// its row, so the first `None` is the id check and not a rebase that
    /// never fires.
    #[test]
    fn only_an_answer_about_the_row_itself_rebases_an_edit_of_it() {
        let conn = store::open_in_memory().unwrap();
        for (created, edited, field, subject, edge) in [
            (
                WriteKind::CreateItem,
                WriteKind::UpdateItem,
                "item",
                "mine",
                None,
            ),
            (
                WriteKind::CreateEdge,
                WriteKind::UpdateEdge,
                "edge",
                "link",
                Some("link"),
            ),
        ] {
            let create = store::enqueue(&conn, &write(created, "mine", edge, None, &[])).unwrap();
            let depends_on = [create.id.clone()];
            let edit =
                store::enqueue(&conn, &write(edited, "mine", edge, Some(0), &depends_on)).unwrap();
            let answer =
                |id: &str| serde_json::json!({ field: { "id": id, "version": 5 } }).to_string();
            let answered = |id: &str| {
                store::record_verdict(
                    &conn,
                    &create.id,
                    &store::Answered {
                        verdict: Verdict::Accepted,
                        reason: None,
                        answer: Some(&answer(id)),
                        conflicted_copy_id: None,
                    },
                )
                .unwrap();
                store::queued_write(&conn, &edit.id).unwrap().unwrap()
            };
            assert_eq!(
                own_create_version(&conn, &answered("theirs")).unwrap(),
                None,
                "an answer about another {field} rebased an edit of this one"
            );
            assert_eq!(
                own_create_version(&conn, &answered(subject)).unwrap(),
                Some(5)
            );

            // Rebased, the write reports what it was sent on in both places.
            store::rebase(&conn, &edit.id, 5).unwrap();
            let rebased = store::queued_write(&conn, &edit.id).unwrap().unwrap();
            assert_eq!(rebased.base_version, Some(5));
            let payload: serde_json::Value =
                serde_json::from_str(&store::payload_of(&conn, &edit.id).unwrap()).unwrap();
            assert_eq!(payload["version"], 5);

            // And only a write based on the placeholder: one based on a
            // version the server issued waits on the same create and is not
            // moved.
            let issued =
                store::enqueue(&conn, &write(edited, "mine", edge, Some(3), &depends_on)).unwrap();
            assert_eq!(own_create_version(&conn, &issued).unwrap(), None);
        }
    }
}
