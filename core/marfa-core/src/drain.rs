//! Sending what the queue holds, and recording what came back.
//!
//! One pass per call. A drain attempts each sendable row once and returns;
//! "retries without limit" (`queue-and-verdicts.md` 17) is across drains, not
//! inside one. A drain that spun on a row until the network came back would
//! be a call with no bound on it, and the two behaviors are indistinguishable
//! to a caller who runs the drain again.

use std::collections::{HashMap, HashSet};
use std::fs::File;

use serde::Serialize;

use crate::catalog::Catalog;
use crate::error::CoreError;
use crate::http::{Answer, Call, CallBody, Http, Method, Outgoing};
use crate::model::{BlockedReason, QueuedWrite, Subject, Verdict, WriteKind};
use crate::store;
use crate::wire::{WireEdgeAnswer, WireErrorEnvelope, WireItem, WireWriteAnswer};
use crate::{Core, Result};

/// What a drain did.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DrainReport {
    /// Rows the drain put on the wire.
    pub sent: usize,
    /// Rows it did not send because a write they depend on, or the write
    /// ahead of them to the same row or edge, has no answer yet
    /// (`queue-and-verdicts.md` 4, 42).
    pub held: usize,
    /// One entry per row the drain sent (`queue-and-verdicts.md` 6), and
    /// one per row it settled without sending because of another's answer:
    /// a write refused with the create it waited on, a create blocked with
    /// another naming the same unclaimed source.
    pub verdicts: Vec<DrainVerdict>,
    /// Why the drain stopped before the queue was empty, when it did. A
    /// refused credential parks every row and stops the pass (20). The one
    /// other way a pass ends early is an answer on another contract, and that
    /// ends it as a refusal rather than as a report (`device.md` 42).
    pub stopped: Option<String>,
    /// The sources this credential's key does not claim, once each, where a
    /// create naming one was refused this pass (`queue-and-verdicts.md` 40):
    /// `credential_refused` alone reads as a key that no longer works.
    pub unclaimed_sources: Vec<String>,
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
/// variants are the classification of `queue-and-verdicts.md` 17 to 23, and
/// the three a create's answer can mean besides, two refusals (39, 40) and
/// one acknowledgment (41), and nothing else.
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
    /// A create whose natural key resolved the row `id`, refused because the
    /// row was there: refused with `code`, and the copy moves onto the row
    /// (`queue-and-verdicts.md` 39).
    Landed { id: String, code: String },
    /// A create naming a source the credential's key does not claim: this
    /// create and every one naming the source stop, and nothing else does
    /// (`queue-and-verdicts.md` 40).
    Unclaimed { source: String },
    /// A create whose natural key resolved a row somebody trashed, which the
    /// server acknowledged and did not write: refused `trashed`
    /// (`queue-and-verdicts.md` 41).
    Trashed,
}

/// Reads a create's answer again, knowing it was a create: two refusals and
/// one acknowledgment mean something about the row or the credential rather
/// than the write, and none of the three can be told from the status and code
/// alone.
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
        // Acknowledged and not written: the natural key resolved a row the
        // person trashed. A keyed create names no id of its own, so an
        // acknowledgment is never this device's own earlier create answered
        // again; taking it as `accepted` would bind the file to the bin and
        // drop what it holds with nothing saying so.
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
        // Only a create that named a key: one carrying the id it minted
        // resolves no row by anything but that id. And only where the
        // envelope names a row other than the one minted, which is the row
        // the key resolved.
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
        // The claim refusal names the source and nothing else. The source
        // allow-list's refusal is the same status and code, names the list
        // and the type beside it, and is about the type rather than the
        // credential, so no claim granted afterwards clears it (`types.md`
        // 18).
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

/// Reads an answer, or the lack of one, into its class.
fn classify(answer: &std::result::Result<Answer, CoreError>) -> Classified {
    let answer = match answer {
        Ok(answer) => answer,
        // A dropped connection, a refused connection, a read that timed out:
        // statements about the environment rather than about the write (17).
        Err(CoreError::Network(_)) => return Classified::Environmental,
        // An answer on another contract never reaches here: the pass ends on
        // it before anything classifies it (`device.md` 42).
        //
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
    /// A write it depends on has not been answered (`queue-and-verdicts.md`
    /// 4), or the write ahead of it to the same row or edge is still waiting
    /// for an answer in this pass (42). A held row holds the writes behind
    /// it in turn, whatever holds it: a write behind one held on a create
    /// waits on that create too, or on the held row itself where that is an
    /// edge's create, and the one other thing a write waits on, the upload
    /// of a file's bytes, is blocked only with the whole queue, on a refused
    /// credential that a person clears (20), since its door reads no
    /// idempotency key and answers no version, and it refuses what waits on
    /// it once refused or dead (16).
    Held,
    /// A write it depends on was refused, so this one is too, and the reason
    /// names the write that was refused (16).
    RefusedWith(String),
}

/// Whether `row` can go out, given the verdicts as this pass has them and the
/// rows still waiting in it: sent and not answered, or held.
fn readiness(
    row: &QueuedWrite,
    rows: &HashMap<&str, &QueuedWrite>,
    verdicts: &HashMap<String, Option<Verdict>>,
    waiting: &HashSet<String>,
) -> Readiness {
    // Ordering first: while the write ahead is waiting this one is held,
    // whatever it depends on, so a write the drain would refuse does not
    // step out of line and let the writes behind it past the one ahead.
    // Any answer to the write ahead releases it, a refusal included.
    if row
        .follows
        .as_deref()
        .is_some_and(|ahead| waiting.contains(ahead))
    {
        return Readiness::Held;
    }
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
///
/// The stream is spent by a send, so one refused `401` and renewed is sent
/// again here, from the start of the file.
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
        unclaimed_sources: Vec::new(),
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
    // The rows this pass sent and had no answer to, or held: a write to the
    // same row or edge behind one of them waits for the next pass
    // (`queue-and-verdicts.md` 42). Sent beside it, an edit would go on the
    // version both were queued against, and a body sent under its key cannot
    // be moved afterwards (3); a delete would put the row in the bin before
    // the edits ahead of it reached it.
    let mut waiting: HashSet<String> = HashSet::new();

    for row in &all {
        if answers.get(&row.id).and_then(Option::as_ref).is_some() {
            continue;
        }
        // Read again: an answer earlier in this pass can have moved the row
        // onto the one a create landed on (`queue-and-verdicts.md` 38).
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
                move_edits_back(&conn, row)?;
                drop(conn);
                answers.insert(row.id.clone(), Some(Verdict::Refused));
                // Reconciled like any other refusal: the server never took
                // the write, so the copy must not go on holding it.
                reconcile(core, row)?;
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
                    // report says why. A write waiting on it is held, since
                    // it has no answer, and so is what follows that write.
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
        // An answer on another contract was not read, so there is nothing to
        // settle: the write stays sent and unanswered, and the pass ends,
        // since every later answer comes from the same server.
        let answer = match answer {
            Err(error @ CoreError::ContractMismatch { .. }) => return Err(error),
            answer => answer,
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

        let class = refine(row, &payload, &answer, classify(&answer));
        let settled = settle(core, row, &answer, class, shape)?;
        if let Some(wait) = settled.retry_after_seconds {
            report.retry_after_seconds = Some(
                report
                    .retry_after_seconds
                    .map_or(wait, |held| held.max(wait)),
            );
        }
        answers.insert(row.id.clone(), settled.verdict);
        if settled.verdict.is_none() {
            waiting.insert(row.id.clone());
        }
        // An edit that did not land as it was made: the edits of the same
        // row made against it go back onto its base (42). A refused
        // credential is not about the edit and clears on its own.
        if matches!(
            settled.verdict,
            Some(Verdict::Refused | Verdict::Blocked | Verdict::Dead)
        ) && !settled.stops_the_drain
        {
            let conn = core.conn()?;
            move_edits_back(&conn, row)?;
        }
        // Writes this answer settled besides its own, which the pass would
        // otherwise reach later and send.
        for (other, verdict, reason) in &settled.also {
            answers.insert(other.id.clone(), Some(*verdict));
            report.verdicts.push(verdict_of(
                other,
                &Settled::plain(Some(*verdict), Some(reason.clone()), other.refusals),
            ));
        }
        if let Some(source) = &settled.unclaimed
            && !report.unclaimed_sources.contains(source)
        {
            report.unclaimed_sources.push(source.clone());
        }
        let stop = settled.stops_the_drain;
        // Read again for the report: a create's answer can have moved the
        // copy onto the row the server named (`queue-and-verdicts.md` 38),
        // and a report naming the id minted here would name nothing.
        let settled_row = {
            let conn = core.conn()?;
            store::queued_write(&conn, &row.id)?
        };
        report
            .verdicts
            .push(verdict_of(settled_row.as_ref().unwrap_or(row), &settled));
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

/// What the server answered a create or an edit with: the version, and for
/// an item the row at it, which is what an edit behind it is checked against.
struct AnsweredAt<'a> {
    version: i64,
    item: Option<&'a WireItem>,
}

/// Moves the edits waiting behind a write the server took onto the version
/// it answered `subject` with: the row or edge the answer names, which for a
/// create landing on a row the server held is that row, and the copy has
/// moved the edits onto it already (`queue-and-verdicts.md` 38).
///
/// Behind a create, the edits based on 0, the placeholder the copy of an
/// unanswered create holds and the server never mints (36). Behind an edit
/// answered `accepted` or `merged`, the edits based on the version the server
/// applied it to, the one before its answer (42): the row it answered with is
/// then exactly what those edits were made against, the version they read
/// with this edit laid over it (35). Behind a `conflicted` edit, nothing: the
/// row kept the server's value where this edit collided, so it does not hold
/// what the edits behind it were made against.
///
/// An edit the server applied past its own base, or a create carrying a
/// version and answered more than one past it, was merged over another
/// device's write, silently where nothing collided. Behind an edit, any edit
/// based on an earlier version goes on the answer where the answer holds
/// what that edit was made against for every property it carries (`holds`):
/// an edit changes only what it carries, so there it changes what the person
/// changed and leaves the other write standing. That is also how the third
/// edit of a chain behind such an answer reaches the second's answer, which
/// holds what the third read. Otherwise it goes as it stands, and behind a
/// create on the version the create was based on, which this device read
/// (36). A create the server acknowledged as a repeat of one
/// it had already taken answers the row or edge as it stands now, whoever has
/// written it since; the edits behind it go on 1, the version that create
/// made. A create carrying a natural key is sent with no id (38), so the one
/// acknowledgment it meets is of a row in the bin, which is refused before it
/// reaches here (41).
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
                // An edge is never merged, so an answer to its edit is that
                // edit applied to the version it named, and the next edit
                // of it made against that goes on the answer. An item's is
                // checked against what the edit was made against.
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

/// Moves the edits of the same row or edge behind `row`, an edit that did not
/// land as it was made (refused, blocked by the server, dead), back onto the
/// version it was based on where they were made against it
/// (`queue-and-verdicts.md` 42).
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

/// Where the edit `id` behind `row` goes when `row` did not land as it was
/// made, or landed on content that edit never read: onto the version `row`
/// was based on, where `id` was made later, against the copy with `row` laid
/// over it (35), and carries a property `row` carries. Its value for such a
/// property came from `row` and not from the server, so on its own base the
/// server would take it as newer than whatever the row holds, which this
/// device never read. On `row`'s base the server merges or conflicts on it
/// instead. An edit that carries none of `row`'s properties read the server
/// for everything it carries, and stays where it is.
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

/// Whether the row an answer names holds, for every property the edit `id`
/// changed, the value the copy held when that edit was made
/// (`queue-and-verdicts.md` 42). A property the edit carries at the value it
/// read is no change of its own, and it is dropped from the edit when the
/// edit is moved, so it is not checked. An edge is never merged, so none
/// holds; neither does an edit whose reading was never recorded. A natural
/// key an edit carries is not checked: the server resolves a key both writes
/// changed to the later writer (`versions.md` 13), so on its own base the
/// edit's key lands over another's all the same.
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

/// Whether a conflicted edit collided only with what it was made against:
/// for every property the row kept its own value for, that value is the one
/// the copy held when the edit was made, which was this device's own earlier
/// write laid over the copy (`queue-and-verdicts.md` 35, 42). The copy the
/// server set aside then holds the newest of this device's writes, and the
/// row an older one.
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

/// A property name as one step of a JSON pointer.
fn pointer_token(key: &str) -> String {
    key.replace('~', "~0").replace('/', "~1")
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
    /// Other writes this answer settled, with the verdict and reason each
    /// was given.
    also: Vec<(QueuedWrite, Verdict, String)>,
    /// The source a refused claim named (`queue-and-verdicts.md` 40).
    unclaimed: Option<String>,
    /// A wait the server asked for while settling, besides the one on the
    /// answer itself: the read a landed create makes (39).
    retry_after_seconds: Option<u64>,
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
            also: Vec::new(),
            unclaimed: None,
            retry_after_seconds: None,
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
                    // Not over a newer row: an answer replayed from the
                    // server's record can arrive after a catch-up brought a
                    // later version, and adopting it would take the copy
                    // back to what it held before, under edits made since.
                    // An update that moved the row out of the slice, by a
                    // retype or a move of tier, lets it go as a catch-up
                    // would on the same row (`device.md` 14): held, it would
                    // sit in the copy as the only row of its kind until a
                    // catch-up happened to replay the change. Only a move
                    // does: an edit to a row held outside the slice, an
                    // attachment of a row in it, keeps it. Nor does the
                    // answer to a write queued behind a move put back a row
                    // the move's own answer let go.
                    let newer = store::holds_newer(
                        &tx,
                        Subject::Item,
                        &parsed.item.id,
                        parsed.item.version,
                    )?;
                    let moved_out = !newer
                        && row.kind != WriteKind::CreateItem
                        && !store::slice_holds(&tx, &catalog, &parsed.item)?
                        && (!store::item_held(&tx, &parsed.item.id)?
                            || row.kind == WriteKind::UpdateItem
                                && moves(&store::payload_of(&tx, &row.id)?));
                    if moved_out {
                        store::evict_item(&tx, &parsed.item.id, &store::whole_edge_types(&tx)?)?;
                    } else if !newer {
                        store::upsert_item(&tx, &parsed.item, tags.as_deref(), &indexing)?;
                    }
                    // A create carrying a natural key went without the id
                    // minted here, so its answer names the server's row:
                    // one the key already resolved, or one it made.
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
                    // A folder's save set aside in a copy against this
                    // device's own earlier save: the file holds the newest,
                    // which the row does not, so the pull leaves the file and
                    // the next scan sends it as an edit of the row as it now
                    // stands (`folders.md` 39).
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
                    // Adopted for its version: the local edge was minted at
                    // 0 and the next update to it has to name the one the
                    // server gave it. Not over a newer edge, for the reason
                    // an item's answer is not.
                    if !store::holds_newer(
                        &tx,
                        Subject::Edge,
                        &parsed.edge.id,
                        parsed.edge.version,
                    )? {
                        store::upsert_edge(&tx, &parsed.edge)?;
                    }
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
            reconcile(core, row)?;
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
        Classified::Landed { id, code } => land(core, row, answer, shape, &id, code),
        Classified::Trashed => {
            // Refused rather than accepted, and the row the create was
            // queued as goes: nothing was written (`queue-and-verdicts.md`
            // 41).
            {
                let conn = core.conn()?;
                store::record_verdict(
                    &conn,
                    &row.id,
                    &store::Answered {
                        verdict: Verdict::Refused,
                        reason: Some("trashed"),
                        answer: envelope.as_deref(),
                        conflicted_copy_id: None,
                    },
                )?;
                if let Some(local) = row.item_id.as_deref() {
                    store::forget_item(&conn, local)?;
                }
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
            // The rest of the creates naming it, which would each be asked
            // the same question and given the same answer.
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

/// A create refused because its natural key resolved `id`, which the server
/// holds: the create is refused with the server's code, and the copy moves
/// onto that row (`queue-and-verdicts.md` 39).
///
/// The row is read before anything is written where the copy does not hold
/// it, because the copy cannot move onto a row it cannot hold, and where the
/// version the copy holds is one the server no longer holds, because that is
/// as good as never read. Where the copy holds it at a version the server
/// still holds, it keeps it as it read it, and the file's next edit is based
/// on that version wherever the copy has caught up to since, so the server
/// merges it rather than taking it as newer.
fn land(
    core: &Core,
    row: &QueuedWrite,
    answer: &std::result::Result<Answer, CoreError>,
    shape: Shape,
    id: &str,
    code: String,
) -> Result<Settled> {
    let envelope = answer.as_ref().ok().map(|answer| answer.body.clone());
    // The version of that row the create was based on, where the server
    // still holds it: a `version_conflict` says it does, and names a
    // collision since. An `ancestor_unavailable` says it does not, whether
    // the create read nothing or read a version since thinned, and a version
    // the server no longer holds is as good as never read.
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
        match core.http_ref()?.item(id) {
            Ok(Some(found)) => Some(found),
            // The read failed for a reason that clears on its own. The
            // server keeps its answer to this create under the create's key,
            // so the next drain is answered the same way and reads again,
            // and nothing is counted (17).
            Err(CoreError::Network(_) | CoreError::Server { .. }) => {
                return Ok(Settled::plain(None, None, row.refusals));
            }
            Err(CoreError::RateLimited {
                retry_after_seconds,
                ..
            }) => {
                return Ok(Settled {
                    retry_after_seconds,
                    ..Settled::plain(None, None, row.refusals)
                });
            }
            // Every queued write carries the same credential (20).
            Err(CoreError::Unauthorized { .. }) => {
                return settle(
                    core,
                    row,
                    answer,
                    Classified::BlockQueue(BlockedReason::CredentialRefused),
                    shape,
                );
            }
            // Gone, or out of this credential's reach, since the refusal:
            // there is nothing to move onto, so the create stops as any other
            // write refused this way does (22, 23). A key that could never
            // read the row is refused before any envelope names it.
            Ok(None) | Err(CoreError::NotFound { .. } | CoreError::Forbidden { .. }) => {
                let reason = if code == "version_conflict" {
                    BlockedReason::ConflictUnresolved
                } else {
                    BlockedReason::AncestorUnavailable
                };
                return settle(core, row, answer, Classified::Block(reason), shape);
            }
            // An answer the device cannot read: it retries and is counted
            // (19).
            Err(_) => return settle(core, row, answer, Classified::Counted, shape),
        }
    };
    let mut conn = core.conn()?;
    let catalog = Catalog::load(&conn)?;
    let tx = conn.transaction()?;
    if let Some(found) = &read {
        let indexing = catalog.indexing(&found.item.r#type);
        store::upsert_item(&tx, &found.item, Some(&found.metadata.tags), &indexing)?;
    }
    let refused = store::land_on_held_row(&tx, row, id)?;
    store::record_verdict(
        &tx,
        &row.id,
        &store::Answered {
            verdict: Verdict::Refused,
            // The server's code verbatim (12).
            reason: Some(&code),
            answer: envelope.as_deref(),
            conflicted_copy_id: None,
        },
    )?;
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
/// **Best effort, with one exception.** The verdict is already recorded
/// when this runs, so a read that fails leaves the row refused and the copy
/// briefly wrong rather than un-refusing the write and discarding every
/// verdict the pass had reached. The next drain does not retry it — a
/// refusal is terminal — so a failure here is corrected by the next
/// catch-up that touches the row, or by a caller reading it.
///
/// The exception is a read answered on another contract, which ends the
/// pass as any answer on another contract does (`device.md` 42): the
/// writes after it would go to the same server.
fn reconcile(core: &Core, row: &QueuedWrite) -> Result<()> {
    match reconcile_inner(core, row) {
        Err(error @ CoreError::ContractMismatch { .. }) => Err(error),
        _ => Ok(()),
    }
}

/// Whether an update's body moves the row, to another type or tier.
fn moves(payload: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(payload).is_ok_and(|body| {
        body.get("retype") == Some(&serde_json::Value::Bool(true)) || body.get("tier").is_some()
    })
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
            // A later write to the edge is ordered behind this one and not
            // refused with it (`queue-and-verdicts.md` 42), so what is still
            // waiting is laid back over the edge the server holds (35).
            Some(edge) => {
                store::upsert_edge(&conn, &edge)?;
                store::lay_waiting_edge_writes_over(&conn, edge_id)?;
                store::let_go_of_untaken_edge(&conn, edge_id)?;
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
    // A refused create's id is the server's only if the read finds it, so
    // its pin goes even where the read fails.
    let read = http.item(id);
    if row.kind == WriteKind::CreateItem && !matches!(read, Ok(Some(_))) {
        store::unpin(&*core.conn()?, id)?;
    }
    match read? {
        Some(held) => {
            let mut conn = core.conn()?;
            let catalog = Catalog::load(&conn)?;
            let indexing = catalog.indexing(&held.item.r#type);
            let tx = conn.transaction()?;
            // The server's row outside the slice is not put back where a
            // move answered ahead of this write let it go, and goes where
            // this refused write was itself a move another device's made
            // moot. A row held outside the slice for another reason, an
            // attachment of a row in it, stays.
            let let_go = !store::slice_holds(&tx, &catalog, &held.item)?
                && (!store::item_held(&tx, &held.item.id)?
                    || row.kind == WriteKind::UpdateItem
                        && moves(&store::payload_of(&tx, &row.id)?));
            if let_go {
                store::evict_item(&tx, &held.item.id, &store::whole_edge_types(&tx)?)?;
                tx.commit()?;
                return Ok(());
            }
            store::upsert_item(&tx, &held.item, Some(&held.metadata.tags), &indexing)?;
            store::lay_waiting_writes_over(&tx, &held.item.id, &|laid| catalog.indexing(laid))?;
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

    /// A row is held while the write ahead of it waits in this pass, or while
    /// a write it depends on has no answer; any answer to the write ahead
    /// releases it, and an answer to what it depends on does where it landed.
    #[test]
    fn a_row_is_held_until_the_write_ahead_and_what_it_depends_on_answer() {
        let conn = store::open_in_memory().unwrap();
        let create = store::enqueue(
            &conn,
            &write(WriteKind::CreateItem, "mine", None, None, &[]),
        )
        .unwrap();
        let depends_on = [create.id.clone()];
        let edit = store::enqueue(
            &conn,
            &write(WriteKind::UpdateItem, "mine", None, Some(0), &depends_on),
        )
        .unwrap();
        let all = [create.clone(), edit.clone()];
        let rows: HashMap<&str, &QueuedWrite> =
            all.iter().map(|row| (row.id.as_str(), row)).collect();
        let held = |verdict: Option<Verdict>, waiting: &[&str]| {
            let answers: HashMap<String, Option<Verdict>> =
                [(create.id.clone(), verdict)].into_iter().collect();
            let waiting: HashSet<String> = waiting.iter().map(|id| id.to_string()).collect();
            match readiness(&edit, &rows, &answers, &waiting) {
                Readiness::Held => Some(true),
                Readiness::Ready => None,
                Readiness::RefusedWith(_) => Some(false),
            }
        };
        assert_eq!(held(None, &[&create.id]), Some(true));
        assert_eq!(held(Some(Verdict::Blocked), &[]), Some(true));
        assert_eq!(held(Some(Verdict::Accepted), &[]), None);
        assert_eq!(held(Some(Verdict::Refused), &[]), Some(false));
        // The edit follows the create too: any answer to it releases.
        assert_eq!(edit.follows.as_deref(), Some(create.id.as_str()));
    }

    /// The version a queued write will go out on, as the queue reports it
    /// and as its body names it; `None` in the body until it is moved, since
    /// these bodies are written without one.
    fn based_on(conn: &rusqlite::Connection, id: &str) -> (Option<i64>, Option<i64>) {
        let row = store::queued_write(conn, id).unwrap().unwrap();
        let body: serde_json::Value =
            serde_json::from_str(&store::payload_of(conn, id).unwrap()).unwrap();
        (row.base_version, body["version"].as_i64())
    }

    /// The two subjects an edit can have: a row, named by the item, and an
    /// edge, named by the edge.
    const SUBJECTS: [(WriteKind, WriteKind, &str, Option<&str>); 2] = [
        (WriteKind::CreateItem, WriteKind::UpdateItem, "mine", None),
        (
            WriteKind::CreateEdge,
            WriteKind::UpdateEdge,
            "link",
            Some("link"),
        ),
    ];

    /// The edits behind a create move where its answer is about the row they
    /// address and no other. The witness is the same edit moved once the
    /// answer names its row, so the first check is the subject and not a
    /// rebase that never fires.
    #[test]
    fn only_an_answer_about_the_row_itself_rebases_an_edit_of_it() {
        let conn = store::open_in_memory().unwrap();
        for (created, edited, subject, edge) in SUBJECTS {
            let create = store::enqueue(&conn, &write(created, "mine", edge, None, &[])).unwrap();
            let depends_on = [create.id.clone()];
            let edit =
                store::enqueue(&conn, &write(edited, "mine", edge, Some(0), &depends_on)).unwrap();
            // Based on a version the server issued, and waiting on the same
            // create: not moved, because it is not based on the placeholder.
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

    /// Edits of one row queued one after another are all based on what the
    /// copy held, and each moves onto the answer to the one ahead of it as
    /// that answer arrives: the placeholder onto the create's, then each
    /// edit's onto the one after, merged answers included.
    #[test]
    fn a_chain_of_edits_moves_one_answer_at_a_time() {
        let conn = store::open_in_memory().unwrap();
        for (created, edited, subject, edge) in SUBJECTS {
            let create = store::enqueue(&conn, &write(created, "mine", edge, None, &[])).unwrap();
            let depends_on = [create.id.clone()];
            let edits: Vec<QueuedWrite> = (0..3)
                .map(|_| {
                    let edit =
                        store::enqueue(&conn, &write(edited, "mine", edge, Some(0), &depends_on))
                            .unwrap();
                    // An item's edit moves where the answer holds what it
                    // read; these carry no property, so every answer does.
                    if edited == WriteKind::UpdateItem {
                        store::record_read(&conn, &edit.id, &json!({ "properties": {} })).unwrap();
                    }
                    edit
                })
                .collect();
            let bases = |conn: &rusqlite::Connection| -> Vec<(Option<i64>, Option<i64>)> {
                edits.iter().map(|edit| based_on(conn, &edit.id)).collect()
            };
            let row = store::testing::note("mine", "title", "body", "2026-01-01T00:00:00Z");
            let answered = |version| AnsweredAt {
                version,
                item: (edited == WriteKind::UpdateItem).then_some(&row),
            };

            move_edits_behind(
                &conn,
                &create,
                Verdict::Accepted,
                false,
                subject,
                &answered(1),
            )
            .unwrap();
            assert_eq!(bases(&conn), vec![(Some(1), Some(1)); 3]);

            store::mark_sent(&conn, &edits[0].id).unwrap();
            move_edits_behind(
                &conn,
                &edits[0],
                Verdict::Accepted,
                false,
                subject,
                &answered(2),
            )
            .unwrap();
            assert_eq!(
                bases(&conn),
                vec![(Some(1), Some(1)), (Some(2), Some(2)), (Some(2), Some(2))],
                "the edits behind the first did not move onto its answer"
            );

            store::mark_sent(&conn, &edits[1].id).unwrap();
            let second = if edited == WriteKind::UpdateItem {
                Verdict::Merged
            } else {
                Verdict::Accepted
            };
            move_edits_behind(&conn, &edits[1], second, false, subject, &answered(3)).unwrap();
            assert_eq!(
                bases(&conn),
                vec![(Some(1), Some(1)), (Some(2), Some(2)), (Some(3), Some(3))],
                "the third edit did not move onto the second's answer"
            );
        }
    }

    /// Behind a conflicted edit nothing moves onto its answer: the row kept
    /// the server's value where the edit collided. The witness is the same
    /// edit moved behind the same answer taken as accepted.
    #[test]
    fn nothing_moves_behind_a_conflicted_edit() {
        let conn = store::open_in_memory().unwrap();
        let queue = || {
            store::enqueue(
                &conn,
                &write(WriteKind::UpdateItem, "mine", None, Some(3), &[]),
            )
            .unwrap()
        };
        let first = queue();
        let second = queue();
        store::record_read(&conn, &second.id, &json!({ "properties": {} })).unwrap();
        let answered = store::testing::note("mine", "title", "body", "2026-01-01T00:00:00Z");
        let answer = AnsweredAt {
            version: 4,
            item: Some(&answered),
        };
        move_edits_behind(&conn, &first, Verdict::Conflicted, false, "mine", &answer).unwrap();
        assert_eq!(
            based_on(&conn, &second.id),
            (Some(3), None),
            "an edit behind a conflicted one was moved onto the version it came back with"
        );
        move_edits_behind(&conn, &first, Verdict::Accepted, false, "mine", &answer).unwrap();
        assert_eq!(based_on(&conn, &second.id), (Some(4), Some(4)));
    }

    /// The answer to an edit, at a version, with no row to check an edit
    /// behind it against.
    fn at(version: i64) -> AnsweredAt<'static> {
        AnsweredAt {
            version,
            item: None,
        }
    }

    /// An item's edit moves onto an answer only where it is based on an
    /// earlier version than the answer and the answer holds what it read; an
    /// edit whose reading was never recorded, or one made on a later version,
    /// stays. The witness is the edit that moves.
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

    /// Behind an edit merged over another device's write, an edit based on
    /// what it was based on moves onto the answer where the answer holds,
    /// for every property it carries, what the copy held when it was made,
    /// and stays where the other write touched one of them. The witness for
    /// each stay is the move.
    #[test]
    fn an_edit_behind_a_merge_moves_where_the_answer_holds_what_it_was_made_against() {
        let row = |body: &str| {
            let mut item = store::testing::note("mine", "title", body, "2026-01-01T00:00:00Z");
            item.version = 5;
            item
        };
        for (read, answered, moves) in [
            (
                json!({ "properties": { "body": "first" } }),
                row("first"),
                true,
            ),
            (
                json!({ "properties": { "body": "first" } }),
                row("elsewhere"),
                false,
            ),
            (
                json!({ "properties": { "body": "first", "notes": null } }),
                row("first"),
                true,
            ),
        ] {
            let conn = store::open_in_memory().unwrap();
            let first = store::enqueue(
                &conn,
                &write(WriteKind::UpdateItem, "mine", None, Some(3), &[]),
            )
            .unwrap();
            let second = store::enqueue(
                &conn,
                &write(WriteKind::UpdateItem, "mine", None, Some(3), &[]),
            )
            .unwrap();
            store::record_read(&conn, &second.id, &read).unwrap();
            let answer = AnsweredAt {
                version: 5,
                item: Some(&answered),
            };
            move_edits_behind(&conn, &first, Verdict::Accepted, false, "mine", &answer).unwrap();
            let expected = if moves {
                (Some(5), Some(5))
            } else {
                (Some(3), None)
            };
            assert_eq!(
                based_on(&conn, &second.id),
                expected,
                "an edit made against {read} behind an answer holding {:?}",
                answered.properties
            );
        }
    }

    /// What an edit is checked against: every property it changed from what
    /// it read, each of them, and a property the answer lacks is one it does
    /// not hold where the edit read a value for it. A property carried at the
    /// value read is no change and is not checked. Each case is witnessed by
    /// the one beside it that differs in the answer alone.
    #[test]
    fn an_edit_holds_where_the_answer_keeps_every_property_it_changed_as_read() {
        let answered = |properties: serde_json::Value| {
            let mut item = store::testing::note("mine", "title", "body", "2026-01-01T00:00:00Z");
            item.properties = properties.as_object().unwrap().clone();
            item.version = 5;
            item
        };
        for (read, sent, row, expected) in [
            // The title is carried at the value read, so another's title
            // does not stop the move.
            (
                json!({ "body": "first", "title": "held" }),
                json!({ "body": "second", "title": "held" }),
                json!({ "body": "first", "title": "elsewhere" }),
                true,
            ),
            // Changed, it does, and it is the later of the two it carries.
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
            // A property read with a value and gone from the answer.
            (
                json!({ "notes": "kept" }),
                json!({ "notes": "mine" }),
                json!({ "body": "first" }),
                false,
            ),
            // One read as absent, and still absent.
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

    /// Behind an edit that did not land as made, a later edit made on a later
    /// version goes back onto its base where it carries a property of that
    /// edit's, and stays where it carries none or was made on the same base.
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

    /// A move drops every property the edit carries at the value it read, so
    /// the edit asserts only what it changed; the witness is the property it
    /// changed, which stays.
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

    /// A whole edit cannot drop what it carries unchanged, since that would
    /// clear it: it moves as the answer with its own changes laid over.
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

    /// A create conditional on the version the copy read moves the edits
    /// behind it onto its answer where the server applied it to that version
    /// or made the row, or where the answer is at or below that version, and
    /// onto that version where it applied it more than one past it, over
    /// another device's write. The witnesses are the answers that move them
    /// onto the answer.
    #[test]
    fn a_create_applied_over_another_write_leaves_what_follows_on_its_own_base() {
        for (answered, sent_on) in [(4, 4), (1, 1), (2, 2), (6, 3)] {
            let conn = store::open_in_memory().unwrap();
            let (create, edit) = create_and_edit(&conn, Some(3));
            move_edits_behind(
                &conn,
                &create,
                Verdict::Accepted,
                false,
                "mine",
                &at(answered),
            )
            .unwrap();
            assert_eq!(
                based_on(&conn, &edit.id),
                (Some(sent_on), Some(sent_on)),
                "a create based on 3 and answered at {answered}"
            );
        }
        // Where the answer holds what the edit was made against, it goes on
        // the answer after all.
        let conn = store::open_in_memory().unwrap();
        let (create, edit) = create_and_edit(&conn, Some(3));
        store::record_read(
            &conn,
            &edit.id,
            &json!({ "properties": { "body": "created" } }),
        )
        .unwrap();
        let mut answered = store::testing::note("mine", "title", "created", "2026-01-01T00:00:00Z");
        answered.version = 6;
        let answer = AnsweredAt {
            version: 6,
            item: Some(&answered),
        };
        move_edits_behind(&conn, &create, Verdict::Accepted, false, "mine", &answer).unwrap();
        assert_eq!(based_on(&conn, &edit.id), (Some(6), Some(6)));
    }

    /// A create the server acknowledged as a repeat answers the row or edge
    /// as it stands, so the edits behind it go on 1, the version that create
    /// made, whatever the answer names and whatever version the create
    /// carried. The witness is the same answer not acknowledged, which moves
    /// them onto it.
    #[test]
    fn a_repeated_create_sends_what_follows_on_the_version_it_made() {
        for (created, subject, edge, base, acknowledged, sent_on) in [
            (WriteKind::CreateItem, "mine", None, None, false, 6),
            (WriteKind::CreateItem, "mine", None, None, true, 1),
            (WriteKind::CreateItem, "mine", None, Some(3), true, 1),
            (WriteKind::CreateEdge, "link", Some("link"), None, false, 6),
            (WriteKind::CreateEdge, "link", Some("link"), None, true, 1),
        ] {
            let conn = store::open_in_memory().unwrap();
            let create = store::enqueue(&conn, &write(created, "mine", edge, base, &[])).unwrap();
            let edit = store::enqueue(
                &conn,
                &write(
                    created.edit().unwrap(),
                    "mine",
                    edge,
                    Some(0),
                    std::slice::from_ref(&create.id),
                ),
            )
            .unwrap();
            move_edits_behind(
                &conn,
                &create,
                Verdict::Accepted,
                acknowledged,
                subject,
                &at(6),
            )
            .unwrap();
            assert_eq!(
                based_on(&conn, &edit.id),
                (Some(sent_on), Some(sent_on)),
                "a {created} based on {base:?} answered at 6, acknowledged {acknowledged}"
            );
        }
    }

    /// An item's create based on `base`, and an edit of it behind it based
    /// on the placeholder.
    fn create_and_edit(
        conn: &rusqlite::Connection,
        base: Option<i64>,
    ) -> (QueuedWrite, QueuedWrite) {
        let create =
            store::enqueue(conn, &write(WriteKind::CreateItem, "mine", None, base, &[])).unwrap();
        let edit = store::enqueue(
            conn,
            &write(
                WriteKind::UpdateItem,
                "mine",
                None,
                Some(0),
                std::slice::from_ref(&create.id),
            ),
        )
        .unwrap();
        (create, edit)
    }

    /// Only the unsent edits of the same row queued after the answered one
    /// and still waiting. Each absence is witnessed by the waiting edits the
    /// same call names.
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

    /// An upload's bytes are a stream its first send spends, so the one sent
    /// again under a renewed bearer is read from the start of the file.
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
