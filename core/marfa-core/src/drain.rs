//! One pass per call: each sendable row is attempted once, and the pass ends
//! at the first failure of the environment. Going on would ask a server that
//! cannot answer once for every row, a connection timeout each.

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::sync::atomic::AtomicBool;

use serde::Serialize;

use crate::catalog::Catalog;
use crate::error::CoreError;
use crate::http::{Answer, Call, CallBody, Http, INSTANCE_CHANGED, Method, Outgoing};
use crate::model::{BlockedReason, LastFailure, QueuedWrite, Refusal, Subject, Verdict, WriteKind};
use crate::telemetry;
use crate::wire::{WireEdge, WireEdgeAnswer, WireErrorEnvelope, WireItem, WireWriteAnswer};
use crate::{Core, Result};
use crate::{read_view, store};

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

impl DrainReport {
    /// Whether the pass sent what it could and has no wait, outage or
    /// credential stop to tell.
    fn has_nothing_left(&self) -> bool {
        self.unavailable.is_none()
            && self.stopped.is_none()
            && self.retry_after_seconds.is_none()
            && self.undelivered == 0
            && self.unmade == 0
    }

    /// Takes in a later pass of the same drain, so the two read as one: what
    /// was sent adds up, and what still waits is what the later pass left.
    pub(crate) fn absorb(&mut self, later: DrainReport) {
        self.answered += later.answered;
        self.unsent += later.unsent;
        self.unmade += later.unmade;
        self.held = later.held;
        self.undelivered = later.undelivered;
        self.unavailable = later.unavailable;
        self.verdicts.extend(later.verdicts);
        self.stopped = later.stopped;
        for source in later.unclaimed_sources {
            if !self.unclaimed_sources.contains(&source) {
                self.unclaimed_sources.push(source);
            }
        }
        self.retry_after_seconds = self.retry_after_seconds.max(later.retry_after_seconds);
    }
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
    /// The write ran, and the server kept no answer to repeat.
    Delivered,
}

/// The drains in a row in which a write meets an environmental failure
/// before the drain asks whether it fails alone.
const ENVIRONMENTAL_STREAK: i64 = 3;

/// How long a streak has run, from its first failure, before the drain asks
/// whether the write fails alone: a gateway that restarts or flaps for a few
/// minutes is over before it counts.
const STREAK_FLOOR_MILLIS: i64 = 5 * 60 * 1000;

/// Why a write is sent at this point of the pass.
#[derive(Clone, Copy, PartialEq)]
enum Role {
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
enum Phase {
    /// Waiting for a write to test it.
    Testing,
    /// A write has landed, so the suspect is sent once more.
    Resending,
}

/// A write that has met an environmental failure in three drains in a row, the
/// first five minutes ago, and so is asked about: whether the server answers a
/// write that does not depend on it, and then takes this one.
struct Suspect {
    id: String,
    key: String,
    /// Where the write stands in the queue the pass read.
    at: usize,
    unavailable: String,
    /// Where the write's entry stands in the report's verdicts.
    verdict_at: usize,
    phase: Phase,
}

/// What a pass has decided so far, which says which writes are ready.
struct Standing<'a> {
    rows: &'a HashMap<&'a str, &'a QueuedWrite>,
    answers: &'a HashMap<String, Option<Verdict>>,
    waiting: &'a HashSet<String>,
    landing: &'a HashMap<String, String>,
}

/// The write that tests a suspect: of the writes from `from` on that are ready
/// and depend on no write ahead of them that has not been sent, the one sent
/// least recently, by the number of its send. A write never sent counts as the
/// least recent, and a tie goes to the earlier in the queue. Its streak does
/// not decide, so the test moves through the queue and a stuck write cannot
/// hold it for good.
fn next_test(
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
        if matches!(
            readiness(
                candidate,
                standing.rows,
                standing.answers,
                &ahead,
                standing.landing,
            ),
            Readiness::Ready
        ) {
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
fn leave_waiting(stuck: &Suspect, report: &mut DrainReport) {
    report.undelivered += 1;
    if report.unavailable.is_none() {
        report.unavailable = Some(stuck.unavailable.clone());
    }
}

/// Puts the write's entry in the report: in place of the one it already has,
/// where it has one, and last otherwise.
fn put_verdict(report: &mut DrainReport, replacing: Option<usize>, entry: DrainVerdict) {
    match replacing.and_then(|at| report.verdicts.get_mut(at)) {
        Some(slot) => *slot = entry,
        None => report.verdicts.push(entry),
    }
}

/// Whether the server asked the caller to slow down, which says nothing of
/// the write that met it.
fn rate_limited(answer: &std::result::Result<Answer, CoreError>) -> bool {
    match answer {
        Ok(answer) => answer.status == 429,
        Err(error) => matches!(
            error,
            CoreError::RateLimited { .. } | CoreError::Unnamed { status: 429, .. }
        ),
    }
}

/// Whether the failure came before the write was answered, from the credential
/// renewal or the device's own disk, and so says nothing of the write.
fn not_the_writes(answer: &std::result::Result<Answer, CoreError>) -> bool {
    matches!(
        answer,
        Err(CoreError::RenewalFailed(_) | CoreError::StorageFull(_) | CoreError::Io(_))
    )
}

/// What a write met that was no answer to it: the server's status where it
/// answered, a rate limit's and a gateway's included.
fn failure_of(answer: &std::result::Result<Answer, CoreError>) -> LastFailure {
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
fn set_aside(
    core: &Core,
    stuck: &Suspect,
    failure: &LastFailure,
    report: &mut DrainReport,
    answers: &mut HashMap<String, Option<Verdict>>,
) -> Result<()> {
    let mut conn = core.conn()?;
    let tx = conn.transaction()?;
    // Released, withdrawn or answered while the test was out: not the same
    // attempt any more, and the verdict would be about another write.
    let Some(row) = store::queued_write(&tx, &stuck.id)?
        .filter(|row| row.verdict.is_none() && row.idempotency_key == stuck.key)
    else {
        return Ok(());
    };
    store::note_last_failure(&tx, &row.id, failure)?;
    store::record_verdict(
        &tx,
        &row.id,
        &store::Answered {
            verdict: Verdict::Blocked,
            reason: Some(BlockedReason::FailingAlone.as_str()),
            answer: None,
            conflicted_copy_id: None,
        },
    )?;
    // The later edit read this edit's optimistic fields, which will not reach
    // the server until a person releases it.
    move_edits_back(&tx, &row)?;
    let set_aside = store::queued_write(&tx, &row.id)?.unwrap_or(row);
    tx.commit()?;
    answers.insert(set_aside.id.clone(), Some(Verdict::Blocked));
    report.answered += 1;
    if let Some(entry) = report.verdicts.get_mut(stuck.verdict_at) {
        *entry = verdict_of(
            &set_aside,
            &Settled::plain(
                Some(Verdict::Blocked),
                Some(BlockedReason::FailingAlone.as_str().into()),
                set_aside.refusals,
            ),
            None,
        );
    }
    Ok(())
}

/// Reads a create's answer again: a key that landed on a held row, an
/// unclaimed source, a trashed row and a lost answer to a create naming no
/// id cannot be told from the status and code alone.
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
        // A create naming no id lands on whatever row its key resolves, so
        // no read by id finds the row it wrote.
        Classified::Delivered if !sent.get("id").is_some_and(serde_json::Value::is_string) => {
            Classified::Contract
        }
        _ => class,
    }
}

fn classify(answer: &std::result::Result<Answer, CoreError>) -> Classified {
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
        (422, "idempotency_result_not_retained") if first_succeeded(answer) => {
            Classified::Delivered
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
    serde_json::from_str::<serde_json::Value>(&answer.body)
        .ok()
        .and_then(|body| body.pointer("/error/details/original_status")?.as_u64())
        .is_some_and(|status| (200..300).contains(&status))
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

/// An `Outgoing` that owns its text, for a request sent from another thread.
struct Owned {
    method: Method,
    segments: Vec<String>,
    params: Vec<(String, String)>,
    body: String,
    idempotency_key: String,
}

impl Owned {
    fn of(outgoing: &Outgoing<'_>) -> Owned {
        Owned {
            method: outgoing.method,
            segments: outgoing.segments.clone(),
            params: outgoing.params.clone(),
            body: outgoing.body.to_string(),
            idempotency_key: outgoing.idempotency_key.to_string(),
        }
    }

    fn outgoing(&self) -> Outgoing<'_> {
        Outgoing {
            method: self.method,
            segments: self.segments.clone(),
            params: self.params.clone(),
            body: &self.body,
            idempotency_key: &self.idempotency_key,
        }
    }
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
    landing: &HashMap<String, String>,
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
        // Refused onto a row no read can find yet: whether what waits on it
        // goes to that row or is refused is not known until a read finds it.
        if landing.contains_key(dependency) {
            return Readiness::Held;
        }
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
    if row.kind == WriteKind::DeleteItem && row.base_version.is_none_or(|version| version <= 0) {
        return Readiness::RefusedWith("the delete has no confirmed server version to remove; read the item before deleting it".into());
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
        WriteKind::DeleteItem => Ok(Door::Json(
            Outgoing {
                method: Method::Delete,
                segments: vec!["items".into(), item_id()?.into()],
                params: vec![(
                    "version".into(),
                    row.base_version
                        .ok_or_else(|| {
                            CoreError::Invalid("a delete carries no read version".into())
                        })?
                        .to_string(),
                )],
                body: "{}",
                idempotency_key: &row.idempotency_key,
            },
            Shape::Plain,
        )),
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

/// The server credits an upload to the credential that sent it, and refuses
/// a file write whose bytes the writing credential neither sent nor may read
/// (`blobs/proof-file-refused`). So each taken upload sent with another
/// credential than the copy's current one is sent again, ahead of a write
/// this pass sends that waits on it, where the copy still holds its bytes.
fn send_uploads_as(core: &Core, http: &Http) -> Result<()> {
    let mut conn = core.conn()?;
    core.write_down_renewals(&conn)?;
    let credential = store::credential_digest(&http.authorization());
    let cache = core.cache().ok();
    let tx = conn.transaction()?;
    for (id, hash) in store::uploads_to_send_again(&tx, &credential)? {
        if cache.is_some_and(|cache| cache.held(&hash).is_ok_and(|held| held.is_some())) {
            store::send_upload_again(&tx, &id)?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// Whether a failed request ends the drain, as an error, rather than leaving
/// its write for the next pass.
fn ends_the_drain(error: &CoreError) -> bool {
    match error {
        CoreError::RenewalFailed(_) => !error.is_environmental(),
        CoreError::Redirected { .. }
        | CoreError::ContractMismatch { .. }
        | CoreError::SignedOut { .. }
        | CoreError::NoKeychain(_)
        | CoreError::StorageFull(_)
        | CoreError::CopyExpired { .. }
        | CoreError::StreamIncomplete { .. } => true,
        _ => false,
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
    let answer = Answer {
        status: reply.status,
        code,
        body,
        retry_after_seconds: reply.retry_after_seconds,
        replayed: false,
        contract_named: reply.contract.is_some(),
    };
    if answer.instance_changed() {
        return Err(CoreError::CopyExpired {
            reason: INSTANCE_CHANGED.into(),
        });
    }
    Ok(answer)
}

/// Whether a drain now has work: a write with no verdict, one blocked for a
/// reason a drain clears itself, a read-back owed, a body whose names wait,
/// or a body's answers still to apply. A dead write, or one blocked until
/// something outside the queue changes, is no reason to drain.
pub(crate) fn would_send(core: &Core) -> Result<bool> {
    let conn = core.conn()?;
    let sendable = store::waiting_writes(&conn)?
        .iter()
        .any(|row| match row.verdict {
            None => true,
            Some(Verdict::Blocked) => {
                row.blocked_reason() == Some(BlockedReason::CredentialRefused)
                    || row.reason.as_deref() == Some(crate::model::AWAITING_DEPENDENCY)
            }
            Some(_) => false,
        });
    Ok(sendable
        || !store::owed_read_backs(&conn)?.is_empty()
        || crate::body::rule::waiting(&conn)?
        || crate::body::rule::has_answer_work(&conn)?)
}

pub fn drain(core: &Core, stop: &AtomicBool) -> Result<DrainReport> {
    let op = telemetry::operation!("drain", answered, held, undelivered, unsent, unmade);
    let result = drain_checked(core, stop);
    // A renewal whose callback found the connection held waits in memory;
    // written down here, it outlives a process that exits after the pass.
    // Lost, it costs the next drain one upload sent again.
    if let Ok(conn) = core.conn() {
        let _ = core.write_down_renewals(&conn);
    }
    if let Ok(report) = &result {
        core.owe_drain(report.undelivered > 0 || report.unavailable.is_some());
    }
    telemetry::ended!(op, result.as_ref(), |report| {
        outcome = if report.stopped.is_some() {
            "credential_refused"
        } else if report.unavailable.is_some() {
            "unavailable"
        } else {
            "ok"
        },
        answered = report.answered,
        held = report.held,
        undelivered = report.undelivered,
        unsent = report.unsent,
        unmade = report.unmade,
    });
    result
}

fn drain_checked(core: &Core, stop: &AtomicBool) -> Result<DrainReport> {
    // The handle before the server, so a second opener with no server is
    // told the real reason it may not write.
    core.lock.refuse_unless_writer()?;
    // Whatever opened the store, a folder's queue holds only what its scan
    // read until the person agrees.
    if crate::folder::waiting(&*core.conn()?)? {
        return Err(crate::error::CoreError::FirstSyncWaiting);
    }
    // Each answer is read back under the copy's read view, so a copy without
    // one would send a write and then fail to settle it, on every pass.
    crate::catch_up::refuse_unless_current(&mut *core.conn()?)?;
    let result = drain_inner(core, stop);
    // An answer that came in is settled before a stop raised during its
    // request is honored, including for the last write in the queue.
    crate::catch_up::unless_stopped(result, stop)
}

fn drain_inner(core: &Core, stop: &AtomicBool) -> Result<DrainReport> {
    crate::catch_up::refuse_if_stopped(stop)?;
    // Queued writes and their natural-key lookups name the copy's instance
    // so a replacement refuses them even after the pass confirmed the origin.
    // Credential renewal uses the exempt authentication endpoints.
    let (http, generation) = crate::catch_up::naming_instance(core, core.http()?)?;
    let mut pass = ViewChange::default();
    let result = match send_queue(core, &http, generation, stop, &mut pass) {
        // From a request that settled nothing, a lookup among them: a write
        // the refusal answered expired the copy as it settled.
        Err(CoreError::CopyExpired { reason }) if reason == INSTANCE_CHANGED => {
            let mut conn = core.conn()?;
            let tx = conn.transaction()?;
            if read_view::generation(&tx)? == generation {
                crate::catch_up::expire_for_another_instance(&tx, generation)?;
            }
            tx.commit()?;
            Err(CoreError::CopyExpired { reason })
        }
        result => result,
    };
    // However the pass ended, a copy whose read view moved under it is
    // expired once, here. The pass's own error, if any, is the one told. So is
    // a report that has something to say a caller must act on (a wait, an
    // unavailable server, a credential stopped, a write left undelivered), and
    // the next call is refused `copy_expired`.
    let expiry = pass.expire(core);
    let report = result?;
    match expiry? {
        Some(expired) if report.has_nothing_left() => Err(expired),
        _ => Ok(report),
    }
}

fn send_queue(
    core: &Core,
    http: &Http,
    generation: u64,
    stop: &AtomicBool,
    pass: &mut ViewChange,
) -> Result<DrainReport> {
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
    let waiting = store::waiting_writes(&*core.conn()?)?;
    let owed = !store::owed_read_backs(&*core.conn()?)?.is_empty();
    let names_wait = crate::body::rule::waiting(&*core.conn()?)?;
    let body_answers = crate::body::rule::has_answer_work(&*core.conn()?)?;
    if waiting.is_empty() && !owed && !names_wait && !body_answers {
        // This pass has no work. Return before later reads could observe a
        // concurrent edit and apply its deferred work without admission.
        return Ok(report);
    }
    {
        // A relocation must be admitted before this pass changes local queue
        // verdicts or resolves body dependencies. Same-origin transport has
        // no relocation gate, and an empty pass still makes no request.
        match crate::catch_up::ask_unless_stopped(stop, http, Http::confirm_origin) {
            Ok(()) => {}
            Err(error) if error.is_environmental() => {
                telemetry::degraded!(&error);
                report.unavailable = Some(format!(
                    "the server could not say which instance it is, so nothing was sent: {error}"
                ));
                report.undelivered = waiting.len();
                waited(&mut report, error.retry_after().map(|wait| wait.as_secs()));
                return Ok(report);
            }
            Err(error) => return Err(error),
        }
    }
    {
        let conn = core.conn()?;
        // Left blocked, a self-clearing row would skip a dependency that has
        // since been answered.
        store::unblock_self_clearing(&conn)?;
    }
    send_uploads_as(core, http)?;
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
            Ok(()) => {
                confirmed = true;
                Ok(true)
            }
            Err(error) if error.is_environmental() => {
                telemetry::degraded!(&error);
                report.unavailable = Some(format!(
                    "the server could not say which instance it is, so nothing was sent: {error}"
                ));
                waited(report, error.retry_after().map(|wait| wait.as_secs()));
                Ok(false)
            }
            Err(error) => Err(error),
        }
    };
    // A server that cannot be read cannot be written to either, so nothing
    // is sent.
    let unconfirmed = owed && !confirm(&mut report)?;
    if !unconfirmed && let Some(why) = read_owed_backs(core, stop, pass)? {
        report.unavailable = Some(why.reason);
        waited(&mut report, why.retry_after_seconds);
    }

    // Before the queue is read, so an edge a name now resolves to goes out in
    // this pass, after the writes it waits on.
    crate::body::rule::after_answers(&mut *core.conn()?)?;
    if report.unavailable.is_none() && !unconfirmed && crate::body::rule::waiting(&*core.conn()?)? {
        // A server that cannot be asked about names is no failure of the
        // pass: they wait for the next, and a write sent later confirms the
        // instance again.
        let (unavailable, retry_after) = (report.unavailable.clone(), report.retry_after_seconds);
        if confirm(&mut report)? {
            core.settle_bodies(stop)?;
        } else {
            report.unavailable = unavailable;
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

    loop {
        crate::catch_up::refuse_if_stopped(stop)?;
        // The pass ended before the suspect was sent again.
        if report.unavailable.is_some()
            && let Some(stuck) = suspect.take()
        {
            leave_waiting(&stuck, &mut report);
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
                            leave_waiting(&stuck, &mut report);
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

        let ready = match readiness(row, &rows, &answers, &waiting, &landing) {
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
                    leave_waiting(stuck, &mut report);
                }
                continue;
            }
            Readiness::Held => {
                // Decided on the verdicts read when the pass began, which a
                // withdraw or a discard since may have answered: their
                // refusal stands.
                let mut conn = core.conn()?;
                let tx = conn.transaction()?;
                let now = store::queued_write(&tx, &row.id)?;
                match now.as_ref().map(|now| now.verdict) {
                    None => continue,
                    Some(None | Some(Verdict::Blocked)) => {}
                    Some(answered) => {
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
            Readiness::RefusedWith(_) | Readiness::Ready if !confirm(&mut report)? => {
                waiting.insert(row.id.clone());
                report.undelivered += 1;
                continue;
            }
            Readiness::RefusedWith(reason) => {
                {
                    let mut conn = core.conn()?;
                    let tx = conn.transaction()?;
                    store::record_verdict(
                        &tx,
                        &row.id,
                        &store::Answered {
                            verdict: Verdict::Refused,
                            reason: Some(&reason),
                            answer: None,
                            conflicted_copy_id: None,
                        },
                    )?;
                    if let Some(owed) = store::owed_of(&tx, row)? {
                        store::owe_read_back(&tx, &owed)?;
                        store::meta_set(&tx, &receipt_key(&row.id), "refused")?;
                    }
                    tx.commit()?;
                }
                answers.insert(row.id.clone(), Some(Verdict::Refused));
                let unread = reconcile(core, row, pass)?;
                report.unsent += 1;
                put_verdict(
                    &mut report,
                    replacing,
                    verdict_of(
                        row,
                        &Settled::plain(Some(Verdict::Refused), Some(reason), row.refusals),
                        None,
                    ),
                );
                if let Some(unread) = unread {
                    report.unavailable = Some(unread.reason);
                    waited(&mut report, unread.retry_after_seconds);
                }
                continue;
            }
            Readiness::Ready => {}
        }

        let payload = match payload_to_send(core, http, row, &all, &mut lookups)? {
            Ok(payload) => payload,
            Err(CoreError::Unauthorized { .. }) => {
                let conn = core.conn()?;
                let parked = store::block_unanswered(&conn, BlockedReason::CredentialRefused)?;
                report.stopped = Some(format!(
                    "the server refused the credential, so every queued write is blocked and the drain stopped; {parked} row(s) parked"
                ));
                break;
            }
            Err(error) => {
                telemetry::degraded!(&error);
                report.unavailable = Some(format!(
                    "the server could not say whether a row holds the natural key the create {} carries, so nothing more was sent: {}",
                    row.id,
                    unavailable_by(&error).unwrap_or_else(|| error.to_string())
                ));
                waited(&mut report, error.retry_after().map(|wait| wait.as_secs()));
                waiting.insert(row.id.clone());
                report.undelivered += 1;
                continue;
            }
        };
        // Read again where the body was decided, so the answer is taken as
        // the answer to the body sent.
        let decided;
        let row = if serde_json::from_str::<serde_json::Value>(&payload)? == row.body {
            row
        } else {
            decided = store::queued_write(&*core.conn()?, &row.id)?
                .ok_or_else(|| CoreError::Store(format!("the queued write {} is gone", row.id)))?;
            &decided
        };
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
                            &mut report,
                            replacing,
                            verdict_of(
                                row,
                                &Settled::plain(Some(Verdict::Refused), Some(reason), row.refusals),
                                None,
                            ),
                        );
                        continue;
                    }
                    // A locked file or a process out of handles is not the
                    // write's fault: unanswered and uncounted.
                    Err(error) => {
                        report.undelivered += 1;
                        put_verdict(
                            &mut report,
                            replacing,
                            verdict_of(
                                row,
                                &Settled::plain(
                                    None,
                                    Some(format!(
                                        "the bytes of {hash} could not be opened: {error}"
                                    )),
                                    row.refusals,
                                ),
                                None,
                            ),
                        );
                        continue;
                    }
                }
            }
        };
        // The connection is not held across the send, or `queue`, read while
        // a drain runs, would wait on the network.
        crate::catch_up::refuse_if_stopped(stop)?;
        {
            // Before the send: one whose answer never arrives has still
            // reached the server, and treating it as unsent would write twice.
            let conn = core.conn()?;
            store::mark_sent(&conn, &row.id)?;
            if row.kind == WriteKind::UploadBlob {
                store::record_upload_sent_as(
                    &conn,
                    &row.id,
                    &store::credential_digest(&http.authorization()),
                )?;
            }
        }
        let (answer, shape) = {
            let write = telemetry::operation!("write", kind, status);
            telemetry::record!(write, kind = row.kind.as_str());
            // Left behind at a stop where sending it again cannot write twice,
            // so a server that never answers, as one taking an upload can,
            // does not hold the drain: the row stays sent under its key, and
            // the next drain sends it again.
            let sent = match sendable {
                Sendable::Json(outgoing, shape) => {
                    let owned = Owned::of(&outgoing);
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
            // Ahead of the classification, which would refuse the write for
            // good. The copy is built again from the instance now at the
            // origin, which has seen no attempt of this write, so it is judged
            // there afresh.
            Err(CoreError::CopyExpired { reason }) if reason == INSTANCE_CHANGED => {
                let mut conn = core.conn()?;
                let tx = conn.transaction()?;
                store::mark_unsent(&tx, &row.id)?;
                let error = crate::catch_up::expire_for_another_instance(&tx, generation)?;
                tx.commit()?;
                return Err(error);
            }
            Err(error) if ends_the_drain(&error) || error == CoreError::Canceled => {
                return Err(error);
            }
            answer => answer,
        };
        if let Ok(answer) = &answer {
            waited(&mut report, answer.retry_after_seconds);
        }
        let class = refine(row, &payload, &answer, classify(&answer));
        let environmental = class == Classified::Environmental;
        let taken = match store_fault(row) {
            Some(error) => Err(error),
            None => settle(core, row, &answer, class, shape, pass),
        };
        let settled = match taken {
            Ok(settled) => settled,
            Err(
                error @ (CoreError::Redirected { .. }
                | CoreError::ContractMismatch { .. }
                | CoreError::RenewalFailed(_)
                | CoreError::SignedOut { .. }
                | CoreError::NoKeychain(_)
                | CoreError::StorageFull(_)
                | CoreError::CopyExpired { .. }
                | CoreError::StreamIncomplete { .. }),
            ) => return Err(error),
            // The server answered and the copy could not take the answer: a
            // further attempt may clear it, nothing clears it on its own.
            Err(error) => {
                if store::queued_write(&*core.conn()?, &row.id)?
                    .is_some_and(|current| current.verdict.is_some())
                {
                    return Err(error);
                }
                let refusals = store::count_refusal(&*core.conn()?, &row.id)?;
                let mut settled = finish_counted(
                    core,
                    row,
                    refusals,
                    answer.as_ref().ok().map(|answer| answer.body.clone()),
                )?;
                // A dead write carries no reason, in the queue or here.
                if settled.verdict.is_none() {
                    settled.reason = Some(format!("the copy could not take the answer: {error}"));
                }
                settled
            }
        };
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
        waited(&mut report, settled.retry_after_seconds);
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
            &mut report,
            replacing,
            verdict_of(answered, &settled, answered.answer.as_deref()),
        );
        // The write has met the failure in three drains in a row, the first
        // five minutes ago: it waits for a write to test it.
        let mut carry_on = counted;
        if counted {
            suspect = Some(Suspect {
                id: row.id.clone(),
                key: row.idempotency_key.clone(),
                at: cursor - 1,
                unavailable: settled.unavailable.clone().unwrap_or_default(),
                verdict_at: report.verdicts.len() - 1,
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
            set_aside(core, stuck, failure, &mut report, &mut answers)?;
            carry_on = true;
        }
        if stop {
            let conn = core.conn()?;
            let parked = store::block_unanswered(&conn, BlockedReason::CredentialRefused)?;
            report.stopped = Some(format!(
                "the server refused the credential, so every queued write is blocked and the drain stopped; {parked} row(s) parked"
            ));
            break;
        }
        if settled.unavailable.is_some() && !carry_on {
            if settled.verdict.is_none() {
                report.undelivered += 1;
            }
            report.unavailable = settled.unavailable;
        }
    }

    crate::body::rule::after_answers(&mut *core.conn()?)?;
    Ok(report)
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
        | CoreError::Store(_) => Failed::Fatal(error),
        CoreError::RenewalFailed(_) if !error.is_environmental() => Failed::Fatal(error),
        CoreError::Unauthorized { .. } => Failed::Unanswered(error),
        CoreError::Server { status, .. } if retried(status) => Failed::Unanswered(error),
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
    row: &QueuedWrite,
    all: &[QueuedWrite],
    lookups: &mut Lookups,
) -> Result<std::result::Result<String, CoreError>> {
    let payload = store::payload_of(&*core.conn()?, &row.id)?;
    if row.kind != WriteKind::CreateItem {
        return Ok(Ok(payload));
    }
    let tier = {
        let conn = core.conn()?;
        match store::chosen_tier(&conn, &row.id)? {
            Some(tier) if store::unsent(&conn, &row.id)? => tier,
            _ => return Ok(Ok(payload)),
        }
    };
    let mut body: serde_json::Value = serde_json::from_str(&payload)?;
    let text = |key: &str| {
        body.get(key)
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
    };
    let (Some(r#type), Some(source_id)) = (text("type"), text("source_id")) else {
        return Ok(Ok(payload));
    };
    if text("source").is_none()
        && let Err(error) = own_source(core, http, lookups)?
    {
        return Ok(Err(error));
    }
    let known = match lookups.source(&body) {
        // The lookup's schema refuses an empty value.
        Some(source) if !source.is_empty() && !source_id.is_empty() => {
            let key = (r#type, source, source_id);
            if !lookups.keys.contains_key(&key) {
                let asked = keys_to_ask(core, all, &key, lookups)?;
                if let Err(error) = ask(http, &key.0, &key.1, &asked, &mut lookups.keys)? {
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

/// The credential's own source, which the server stamps a write naming none
/// with (`items/source-own`), as `GET /keys/current` answers it, kept for the
/// credential it was learned for. `None` where that door will not say.
fn own_source(
    core: &Core,
    http: &Http,
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
    let learned = match http.current_key() {
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
        if let Err(error) = ask_batch(http, r#type, source, &asked[start..end], keys)? {
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
    r#type: &str,
    source: &str,
    batch: &[String],
    keys: &mut HashMap<(String, String, String), Known>,
) -> Result<std::result::Result<(), CoreError>> {
    let known = match http.keys_held(r#type, source, batch) {
        Ok(held) => Some(held),
        Err(error) => match failed(error) {
            Failed::Fatal(error) => return Err(error),
            Failed::Unanswered(error) => return Ok(Err(error)),
            Failed::Refused(true) if batch.len() > 1 => {
                let (first, second) = batch.split_at(batch.len() / 2);
                if let Err(error) = ask_batch(http, r#type, source, first, keys)? {
                    return Ok(Err(error));
                }
                return ask_batch(http, r#type, source, second, keys);
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
fn store_fault(row: &QueuedWrite) -> Option<CoreError> {
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
fn waited(report: &mut DrainReport, wait: Option<u64>) {
    if let Some(wait) = wait.map(|wait| wait.min(crate::error::RETRY_AFTER_MOST.as_secs())) {
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
            status if retried(status) => Some(format!(
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

/// A status the same request may be answered past: `408` is a proxy's
/// about the network, `425` asks for the same request again, and a `5xx`
/// is the server's own trouble.
fn retried(status: u16) -> bool {
    matches!(status, 408 | 425 | 500..=599)
}

fn unavailable_by(error: &CoreError) -> Option<String> {
    match error {
        CoreError::RenewalFailed(cause) => unavailable_by(cause),
        CoreError::Io(_) | CoreError::StorageFull(_) => Some(error.to_string()),
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

fn move_deletes_behind(
    conn: &rusqlite::Connection,
    row: &QueuedWrite,
    answered: &WireItem,
    acknowledged: bool,
) -> Result<()> {
    for (id, base) in store::unsent_writes_behind(conn, row, &answered.id, WriteKind::DeleteItem)? {
        if base.is_none_or(|base| base >= answered.version) {
            continue;
        }
        // A new row's first receipt confirms only this device's create.
        // Later receipts must still hold everything the delete read.
        let own_create = row.kind == WriteKind::CreateItem
            && !acknowledged
            && answered.version == 1
            && base == Some(0);
        let unchanged = if let Some(read) = store::read_of(conn, &id)? {
            if own_create {
                let mut read: serde_json::Value = serde_json::from_str(&read)?;
                // These fields are fixed by the create, never by an edit behind it.
                // Keep the later local edits in the rest of the delete's read.
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
            store::rebase(conn, &id, answered.version)?;
        }
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

fn receipt_key(id: &str) -> String {
    format!("receipt_pending/{id}")
}

fn same_attempt(conn: &rusqlite::Connection, row: &QueuedWrite) -> Result<()> {
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
        });
    }
    Ok(())
}

fn settle_success(
    core: &Core,
    row: &QueuedWrite,
    answer: &Answer,
    shape: Shape,
    pass: &mut ViewChange,
    answered_now: bool,
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
    let owed = {
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
        if store::meta_get(&tx, &receipt_key(&row.id))?.is_none() {
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
        tx.commit()?;
        owed
    };
    let Some(owed) = owed else {
        return Ok(settled);
    };
    let read = match read_owed(
        core,
        &owed,
        Bin::Held,
        pass,
        answered_now && moves_source(row),
    ) {
        Ok(read) => read,
        Err(error) if error.is_environmental() => {
            telemetry::degraded!(&error);
            settled.unavailable = unavailable_by(&error).or_else(|| Some(error.to_string()));
            settled.retry_after_seconds = error.retry_after().map(|wait| wait.as_secs());
            return Ok(settled);
        }
        Err(error) => return Err(error),
    };
    let mut conn = core.conn()?;
    let tx = conn.transaction()?;
    same_attempt(&tx, row)?;
    check_read_back(&tx, &read)?;
    restore_settled_overlay(&tx, row, &read)?;
    if let Some(parsed) = &item {
        if row.kind == WriteKind::CreateItem
            && let Some(local) = row.item_id.as_deref()
        {
            store::adopt_answered_id(&tx, local, &parsed.item.id)?;
            store::refollow(&tx, &parsed.item.id, &row.id)?;
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
            },
        )?;
        if matches!(verdict, Verdict::Accepted | Verdict::Merged) {
            move_deletes_behind(&tx, row, &parsed.item, parsed.acknowledged)?;
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
            },
        )?;
    }
    // The receipt can rename a pin, but the fresh response was checked against
    // the exact pre-adoption pin set while this transaction held the writer.
    apply_read_back_unchecked(&tx, &read)?;
    // Everything the receipt settles is settled; an unread answer leaves only
    // the read owed, for the pass after the copy is built again.
    if !matches!(read, ReadBack::Unread) {
        store::settle_read_back(&tx, owed.subject, &owed.id)?;
    }
    store::meta_delete(&tx, &receipt_key(&row.id))?;
    tx.commit()?;
    Ok(settled)
}

fn settle(
    core: &Core,
    row: &QueuedWrite,
    answer: &std::result::Result<Answer, CoreError>,
    class: Classified,
    shape: Shape,
    pass: &mut ViewChange,
) -> Result<Settled> {
    let envelope = answer.as_ref().ok().map(|answer| answer.body.clone());
    match class {
        Classified::Success => settle_success(
            core,
            row,
            answer.as_ref().expect("a success has a response"),
            shape,
            pass,
            true,
        ),
        Classified::Environmental => Ok(Settled {
            retry_after_seconds: answer
                .as_ref()
                .err()
                .and_then(CoreError::retry_after)
                .map(|wait| wait.as_secs()),
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
                if let Some(owed) = store::owed_of(&tx, row)? {
                    store::owe_read_back(&tx, &owed)?;
                    store::meta_set(&tx, &receipt_key(&row.id), "refused")?;
                }
                tx.commit()?;
            }
            let unread = reconcile(core, row, pass)?;
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
        Classified::Landed { id, code } => land(core, row, answer, shape, &id, code, pass),
        Classified::Delivered => settle_delivered(core, row, shape, pass),
        Classified::Trashed => {
            let mut response = answer.clone();
            if let Ok(answer) = &mut response {
                answer.code = "trashed".into();
            }
            settle(core, row, &response, Classified::Contract, shape, pass)
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
    row: &QueuedWrite,
    shape: Shape,
    pass: &mut ViewChange,
) -> Result<Settled> {
    let subject = match shape {
        Shape::Item => row.item_id.as_deref().map(|id| ("items", id)),
        Shape::Edge => row.edge_id.as_deref().map(|id| ("edges", id)),
        Shape::Plain | Shape::Blob => None,
    };
    let read = match subject {
        None => None,
        // The server would refuse the read; sent again, the write is
        // answered the same way once the copy is built again.
        Some(_) if pass.changed() => return Ok(Settled::plain(None, None, row.refusals)),
        Some((collection, id)) => {
            let context = read_view::Context::capture(&*core.conn()?)?;
            match context.http(core.http()?).read_whole(&[collection, id]) {
                Ok(found) => found,
                Err(CoreError::Forbidden { .. }) => None,
                Err(error) if names_no_row(&error) => None,
                Err(error) if error.is_environmental() => {
                    telemetry::degraded!(&error);
                    return Ok(Settled {
                        retry_after_seconds: error.retry_after().map(|wait| wait.as_secs()),
                        unavailable: unavailable_by(&error).or_else(|| Some(error.to_string())),
                        ..Settled::plain(None, None, row.refusals)
                    });
                }
                Err(error) => return Err(context.failed(core, error)?),
            }
        }
    };
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
    };
    settle_success(core, row, &answer, shape, pass, true)
}

/// A natural-key receipt settles independently of the current read authority.
/// Its identity reconciliation waits until a fresh conditional read can land.
fn land(
    core: &Core,
    row: &QueuedWrite,
    answer: &std::result::Result<Answer, CoreError>,
    _shape: Shape,
    id: &str,
    code: String,
    pass: &mut ViewChange,
) -> Result<Settled> {
    let envelope = answer.as_ref().ok().map(|answer| answer.body.clone());
    let owed = store::Owed {
        subject: Subject::Item,
        id: id.into(),
        source_id: None,
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
    let read = match read_owed(core, &owed, Bin::NotFound, pass, false) {
        Ok(read @ ReadBack::Item { held: Some(_), .. }) => read,
        // The receipt stays owed and the writes behind the create stay held,
        // but nothing else waits on a row the server may never hold again.
        Ok(_) => return Ok(settled),
        Err(error) if error.is_environmental() => {
            telemetry::degraded!(&error);
            settled.unavailable = unavailable_by(&error).or_else(|| Some(error.to_string()));
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
    let refused = store::land_on_held_row(&tx, row, id)?;
    apply_read_back_unchecked(&tx, &read)?;
    let catalog = Catalog::load(&tx)?;
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

fn finish_counted(
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

/// A read rather than a wait for catch-up: a refused write produces no
/// event. The verdict and debt survive a failed read; the refused overlay
/// is removed only after a fresh response passes the local context guard.
/// A contract mismatch, redirect, failed renewal or full store ends the pass.
/// Other unavailable reads return their reason and end the pass too.
fn reconcile(core: &Core, row: &QueuedWrite, pass: &mut ViewChange) -> Result<Option<Unreadable>> {
    let Some(owed) = store::owed_of(&*core.conn()?, row)? else {
        return Ok(None);
    };
    match read_owed(core, &owed, Bin::Held, pass, false).and_then(|read| {
        let mut conn = core.conn()?;
        let tx = conn.transaction()?;
        check_read_back(&tx, &read)?;
        same_attempt(&tx, row)?;
        restore_settled_overlay(&tx, row, &read)?;
        move_edits_back(&tx, row)?;
        if matches!(read, ReadBack::Unread) {
            // The queue's side is done, so the receipt goes: only the read
            // stays owed, and a pass that came back to the receipt would
            // rebase the writes behind it a second time.
            store::meta_delete(&tx, &receipt_key(&row.id))?;
            tx.commit()?;
            return Ok(());
        }
        apply_read_back_unchecked(&tx, &read)?;
        store::settle_read_back(&tx, owed.subject, &owed.id)?;
        store::meta_delete(&tx, &receipt_key(&row.id))?;
        tx.commit()?;
        Ok(())
    }) {
        Err(
            error @ (CoreError::Redirected { .. }
            | CoreError::ContractMismatch { .. }
            | CoreError::RenewalFailed(_)
            | CoreError::StorageFull(_)
            | CoreError::CopyExpired { .. }
            | CoreError::StreamIncomplete { .. }),
        ) => Err(error),
        Err(error) => {
            let unread = unreadable(&error);
            if unread.is_some() {
                telemetry::degraded!(&error);
            }
            Ok(unread)
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
fn read_owed_backs(
    core: &Core,
    stop: &AtomicBool,
    pass: &mut ViewChange,
) -> Result<Option<Unreadable>> {
    let pending = {
        let conn = core.conn()?;
        store::queued_writes(&conn)?
            .into_iter()
            .filter_map(|row| match store::meta_get(&conn, &receipt_key(&row.id)) {
                Ok(Some(shape)) => Some(Ok((row, shape))),
                Ok(None) => None,
                Err(error) => Some(Err(error)),
            })
            .collect::<Result<Vec<_>>>()?
    };
    // `land` reads these, and takes no row in the bin
    // (`queue-and-verdicts/landed-target-unreadable`).
    let landing: HashSet<String> = pending
        .iter()
        .filter_map(|(_, shape)| shape.strip_prefix("land:").map(str::to_owned))
        .collect();
    for (row, shape) in pending {
        crate::catch_up::refuse_if_stopped(stop)?;
        if shape == "refused" {
            if let Some(unread) = reconcile(core, &row, pass)? {
                return Ok(Some(unread));
            }
            continue;
        }
        let answer = Answer {
            status: 200,
            code: String::new(),
            body: row.answer.clone().unwrap_or_default(),
            retry_after_seconds: None,
            replayed: true,
            contract_named: true,
        };
        let settled = if let Some(id) = shape.strip_prefix("land:") {
            land(
                core,
                &row,
                &Ok(answer),
                Shape::Plain,
                id,
                row.reason.clone().unwrap_or_default(),
                pass,
            )?
        } else {
            let shape = match shape.as_str() {
                "item" => Shape::Item,
                "edge" => Shape::Edge,
                _ => Shape::Plain,
            };
            settle_success(core, &row, &answer, shape, pass, false)?
        };
        if let Some(reason) = settled.unavailable {
            return Ok(Some(Unreadable {
                reason,
                retry_after_seconds: settled.retry_after_seconds,
            }));
        }
    }
    let owed = store::owed_read_backs(&*core.conn()?)?;
    for entry in owed {
        crate::catch_up::refuse_if_stopped(stop)?;
        if entry.subject == Subject::Item && landing.contains(&entry.id) {
            continue;
        }
        match read_owed(core, &entry, Bin::Held, pass, false)
            .and_then(|read| apply_owed(core, &entry, &read))
        {
            Err(
                error @ (CoreError::Redirected { .. }
                | CoreError::ContractMismatch { .. }
                | CoreError::RenewalFailed(_)
                | CoreError::SignedOut { .. }
                | CoreError::NoKeychain(_)
                | CoreError::StorageFull(_)
                | CoreError::CopyExpired { .. }
                | CoreError::StreamIncomplete { .. }),
            ) => return Err(error),
            Err(error) => {
                if let Some(unread) = unreadable(&error) {
                    telemetry::degraded!(&error);
                    return Ok(Some(unread));
                }
            }
            Ok(()) => {}
        }
    }
    Ok(None)
}

fn apply_owed(core: &Core, owed: &store::Owed, read: &ReadBack) -> Result<()> {
    if matches!(read, ReadBack::Unread) {
        return Ok(());
    }
    let mut conn = core.conn()?;
    let tx = conn.transaction()?;
    apply_read_back(&tx, read)?;
    store::settle_read_back(&tx, owed.subject, &owed.id)?;
    tx.commit()?;
    Ok(())
}

pub(crate) enum ReadBack {
    Nothing,
    /// Not asked for: the pass had seen the copy's read view change, so the
    /// server would refuse the read. The read stays owed.
    Unread,
    Item {
        context: read_view::Context,
        id: String,
        held: Option<Box<crate::wire::WireItemWithMetadata>>,
        /// The copy's stamp before the read, so a row the read did not find
        /// is forgotten only where nothing has written it since.
        before: Option<store::Stamp>,
    },
    Edge {
        context: read_view::Context,
        id: String,
        held: Option<Box<WireEdge>>,
        before: Option<store::Stamp>,
    },
}

/// Changes nothing; `apply_read_back` writes what it read.
pub(crate) fn read_back(core: &Core, row: &QueuedWrite) -> Result<ReadBack> {
    let owed = store::owed_of(&*core.conn()?, row)?;
    match owed {
        Some(owed) => read_owed(core, &owed, Bin::Held, &mut ViewChange::default(), false),
        None => Ok(ReadBack::Nothing),
    }
}

/// Whether an item read-back takes a row the server holds in the bin as
/// held, or as no row.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Bin {
    Held,
    NotFound,
}

/// What a pass has learned of the copy's read view from the answers it read.
#[derive(Default)]
struct ViewChange {
    /// The copy as it stood when the server first said its read view had
    /// changed under a source move, and the reason it gave.
    seen: Option<(read_view::Context, String)>,
}

impl ViewChange {
    fn changed(&self) -> bool {
        self.seen.is_some()
    }

    /// Expires the copy the server said had changed, once, however many
    /// answers came after it. Answers the expiry to tell.
    fn expire(self, core: &Core) -> Result<Option<CoreError>> {
        self.seen
            .map(|(context, reason)| context.expire(core, &reason))
            .transpose()
    }
}

/// Whether a write moves an edge's source, which the server answers by
/// changing the read view (`read-views/view-moves-edge-source`). Only a move
/// answered in the pass at hand is known to have changed it; a receipt a
/// pass finds from an earlier one is not.
fn moves_source(row: &QueuedWrite) -> bool {
    row.kind == WriteKind::UpdateEdge && row.body.get("source_id").is_some()
}

/// Reads the row an answer or a refusal owes the copy. Where the read meets a
/// changed read view and `source_move` says the write was a move of an edge's
/// source, the pass notes it and goes on, and every read after it is left
/// unmade, since the server would refuse each the same way
/// (`queue-and-verdicts/edge-source-move-carries-on`); any other change ends
/// the pass here, with the copy expired.
fn read_owed(
    core: &Core,
    owed: &store::Owed,
    bin: Bin,
    pass: &mut ViewChange,
    source_move: bool,
) -> Result<ReadBack> {
    if pass.changed() {
        return Ok(ReadBack::Unread);
    }
    let (context, before) = {
        let conn = core.conn()?;
        (
            read_view::Context::capture(&conn)?,
            store::stamp(&conn, owed.subject, &owed.id)?,
        )
    };
    match read_held(core, owed, bin, &context, before) {
        Err(CoreError::CopyExpired { reason }) if source_move && reason == "read_view_changed" => {
            pass.seen = Some((context, reason));
            Ok(ReadBack::Unread)
        }
        Err(error) => Err(context.failed(core, error)?),
        Ok(read) => Ok(read),
    }
}

fn read_held(
    core: &Core,
    owed: &store::Owed,
    bin: Bin,
    context: &read_view::Context,
    before: Option<store::Stamp>,
) -> Result<ReadBack> {
    let http = context.http(core.http()?);
    if owed.subject == Subject::Edge {
        let held = match http.edge(&owed.id) {
            Ok(found) => found,
            Err(CoreError::Forbidden { .. }) => None,
            Err(error) if names_no_row(&error) => None,
            Err(error) => return Err(error),
        };
        return Ok(ReadBack::Edge {
            context: context.clone(),
            id: owed.id.clone(),
            held: held.map(Box::new),
            before,
        });
    }
    let held = match http.item(&owed.id) {
        Ok(Some(found)) => Some(found),
        // A read by id answers a row in the bin `404` as it answers a row
        // that is gone (`items/get-missing`), and the slice may hold such a
        // row. A landing takes no row in the bin
        // (`queue-and-verdicts/landed-target-unreadable`).
        Ok(None) if bin == Bin::Held => match http.trashed_item(&owed.id) {
            Ok(found) => found,
            Err(CoreError::Forbidden { .. }) => None,
            Err(error) => return Err(error),
        },
        Ok(None) | Err(CoreError::Forbidden { .. }) => None,
        Err(error) if names_no_row(&error) => None,
        Err(error) => return Err(error),
    };
    Ok(ReadBack::Item {
        context: context.clone(),
        id: owed.id.clone(),
        held: held.map(Box::new),
        before,
    })
}

/// The server refuses a read by an id it could never have given a row, which
/// says the row is not there as plainly as a `404`.
fn names_no_row(error: &CoreError) -> bool {
    matches!(error, CoreError::Validation { code, .. } if code == "invalid_id")
}

pub(crate) fn check_read_back(conn: &rusqlite::Connection, read: &ReadBack) -> Result<()> {
    match read {
        ReadBack::Nothing | ReadBack::Unread => Ok(()),
        ReadBack::Item { context, .. } | ReadBack::Edge { context, .. } => context.check(conn),
    }
}

pub(crate) fn withdraw_read_backs(
    conn: &rusqlite::Connection,
    row: &QueuedWrite,
    held: &[QueuedWrite],
    reads: &[ReadBack],
) -> Result<()> {
    for read in reads {
        check_read_back(conn, read)?;
    }
    store::withdraw(conn, row, held)?;
    for read in reads {
        apply_read_back_unchecked(conn, read)?;
    }
    Ok(())
}

pub(crate) fn apply_read_back(conn: &rusqlite::Connection, read: &ReadBack) -> Result<()> {
    check_read_back(conn, read)?;
    apply_read_back_unchecked(conn, read)
}

fn restore_settled_overlay(
    conn: &rusqlite::Connection,
    row: &QueuedWrite,
    read: &ReadBack,
) -> Result<()> {
    if !matches!(row.kind, WriteKind::CreateItem | WriteKind::CreateEdge)
        && matches!(
            read,
            ReadBack::Item { held: Some(_), .. } | ReadBack::Edge { held: Some(_), .. }
        )
    {
        store::put_back(conn, row)?;
    }
    Ok(())
}

fn apply_read_back_unchecked(conn: &rusqlite::Connection, read: &ReadBack) -> Result<()> {
    match read {
        ReadBack::Nothing | ReadBack::Unread => {}
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
            ..
        } => {
            let now = store::stamp(conn, Subject::Edge, id)?;
            if now.is_none() || now == *before {
                store::forget_edge(conn, id)?;
            }
        }
        ReadBack::Item {
            held: Some(held), ..
        } => {
            let item = &held.item;
            let listed = held.listed.ok_or_else(read_view::invalid)?;
            read_view::set_listed(conn, &item.id, listed)?;
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
            let let_go =
                !store::slice_holds(conn, &catalog, item)? && !store::item_waits(conn, &item.id)?;
            if let_go {
                store::evict_item(conn, &item.id, &store::whole_edge_types(conn)?)?;
                return Ok(());
            }
            store::put_server_item(conn, item, Some(&held.metadata.tags), &catalog)?;
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
    fn a_first_answer_not_retained_settles_by_the_status_it_carried() {
        let not_retained = |details: serde_json::Value| {
            Ok(Answer {
                status: 422,
                code: "idempotency_result_not_retained".into(),
                body: json!({
                    "error": {
                        "code": "idempotency_result_not_retained",
                        "message": "too large to keep",
                        "details": details,
                    }
                })
                .to_string(),
                retry_after_seconds: None,
                replayed: false,
                contract_named: true,
            })
        };
        let succeeded = not_retained(json!({ "original_status": 201 }));
        assert_eq!(classify(&succeeded), Classified::Delivered);
        for details in [
            json!({ "original_status": 404 }),
            json!({ "original_status": "200" }),
            json!({}),
        ] {
            assert_eq!(
                classify(&not_retained(details.clone())),
                Classified::Contract,
                "{details}"
            );
        }

        let conn = store::open_in_memory().unwrap();
        for (payload, expected) in [
            (
                json!({ "id": "mine", "type": "core.note" }),
                Classified::Delivered,
            ),
            (
                json!({ "type": "core.note", "source": "app", "source_id": "k" }),
                Classified::Contract,
            ),
        ] {
            let body = payload.to_string();
            let create = store::enqueue(
                &conn,
                &store::NewWrite {
                    payload: &body,
                    ..write(WriteKind::CreateItem, "mine", None, None, &[])
                },
            )
            .unwrap();
            assert_eq!(
                refine(&create, &body, &succeeded, classify(&succeeded)),
                expected,
                "{payload}"
            );
        }
    }

    #[test]
    fn failed_verdicts_restore_unsent_followers_base_without_reading_or_rewriting_sent_work() {
        for kind in [WriteKind::UpdateItem, WriteKind::UpdateEdge] {
            for code in [
                "ancestor_unavailable",
                "version_conflict",
                "idempotency_key_reused",
                "unauthorized",
                "dead",
            ] {
                let dir = tempfile::tempdir().unwrap();
                // No server and no read view: this is a correction of what a
                // queued edit read, not adoption of a server baseline.
                let core = Core::open(dir.path().join("copy.sqlite"), None).unwrap();
                let (ahead, follows, apart, sent, sent_before, key) = {
                    let conn = core.conn().unwrap();
                    let queue = |base, properties: serde_json::Value| {
                        let body = json!({"version": base, "properties": properties}).to_string();
                        store::enqueue(
                            &conn,
                            &store::NewWrite {
                                payload: &body,
                                ..write(
                                    kind,
                                    "mine",
                                    (kind == WriteKind::UpdateEdge).then_some("edge"),
                                    Some(base),
                                    &[],
                                )
                            },
                        )
                        .unwrap()
                    };
                    let ahead = queue(1, json!({"body": "first"}));
                    let follows = queue(2, json!({"body": "second", "title": "held"}));
                    let apart = queue(2, json!({"title": "other"}));
                    let sent = queue(2, json!({"body": "already sent"}));
                    store::record_read(
                        &conn,
                        &follows.id,
                        &json!({"properties": {"body": "first", "title": "held"}}),
                    )
                    .unwrap();
                    store::mark_sent(&conn, &ahead.id).unwrap();
                    store::mark_sent(&conn, &sent.id).unwrap();
                    if code == "dead" {
                        for _ in 1..store::CEILING {
                            store::count_refusal(&conn, &ahead.id).unwrap();
                        }
                    }
                    let sent_before = store::queued_write(&conn, &sent.id).unwrap().unwrap();
                    let key = follows.idempotency_key.clone();
                    (ahead, follows, apart, sent, sent_before, key)
                };
                let answer = if code == "dead" {
                    Err(CoreError::Decoding("unreadable receipt".into()))
                } else {
                    Ok(Answer {
                        status: match code {
                            "unauthorized" => 401,
                            "idempotency_key_reused" => 422,
                            _ => 409,
                        },
                        code: code.into(),
                        body: "{}".into(),
                        retry_after_seconds: None,
                        replayed: false,
                        contract_named: true,
                    })
                };
                settle(
                    &core,
                    &ahead,
                    &answer,
                    classify(&answer),
                    Shape::Item,
                    &mut ViewChange::default(),
                )
                .unwrap();
                let conn = core.conn().unwrap();
                let expected = if code == "unauthorized" { 2 } else { 1 };
                assert_eq!(
                    based_on(&conn, &follows.id),
                    (Some(expected), Some(expected)),
                    "{kind:?} {code}"
                );
                assert_eq!(based_on(&conn, &apart.id), (Some(2), Some(2)));
                assert_eq!(
                    store::queued_write(&conn, &sent.id).unwrap().unwrap(),
                    sent_before
                );
                let current = store::queued_write(&conn, &follows.id).unwrap().unwrap();
                assert_eq!(current.idempotency_key, key);
                let properties = if code == "unauthorized" {
                    json!({"body": "second", "title": "held"})
                } else {
                    json!({"body": "second"})
                };
                assert_eq!(current.body["properties"], properties);
                assert_eq!(
                    store::payload_of(&conn, &ahead.id).unwrap(),
                    ahead.body.to_string()
                );
                assert!(store::owed_read_backs(&conn).unwrap().is_empty());
            }
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
                        .then_some(crate::model::AWAITING_DEPENDENCY),
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
            store::meta_set(&conn, read_view::FENCE, &"a".repeat(64)).unwrap();
            store::meta_set(&conn, store::META_INSTANCE_ID, crate::scripted::INSTANCE).unwrap();
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

    /// The server's bin as `GET /items?state=trashed` answers it under the
    /// copy's read view: each row trashed, at `version`, stamped after the
    /// copy's own.
    fn in_the_bin(rows: &[(&str, i64)]) -> crate::scripted::Answer {
        let data: Vec<serde_json::Value> = rows
            .iter()
            .map(|(id, version)| {
                let mut row: serde_json::Value = serde_json::from_str(
                    &crate::scripted::item_payload("item.deleted", id, "core.note", *version),
                )
                .unwrap();
                row.as_object_mut().unwrap().remove("event_type");
                row["item"]["state"] = "trashed".into();
                row["item"]["updated_at"] = "2026-03-01T00:00:00Z".into();
                row["listed"] = true.into();
                row
            })
            .collect();
        crate::scripted::certified(crate::scripted::json(
            200,
            &json!({ "data": data, "next_cursor": null }).to_string(),
        ))
    }

    fn held_in_the_bin(core: &Core, id: &str, version: i64) {
        let held = store::items_by_ids(&core.conn().unwrap(), &[id.to_string()])
            .unwrap()
            .pop()
            .unwrap_or_else(|| panic!("the copy let go of {id}, which the bin holds"));
        assert_eq!(held.state, crate::model::ItemState::Trashed);
        assert_eq!(held.version, version);
        assert_eq!(
            held.updated_at, "2026-03-01T00:00:00Z",
            "the copy holds the row the bin answered"
        );
    }

    #[test]
    fn a_drain_stopped_before_it_sends_leaves_every_write_queued_and_unsent() {
        use std::sync::atomic::AtomicBool;
        let server = crate::scripted::Scripted::start();
        server.on(
            "/items/a",
            vec![
                crate::scripted::json(200, r#"{"ok":true}"#),
                crate::scripted::certified(crate::scripted::refusal(404, "item_not_found")),
            ],
        );
        server.on("/items", vec![in_the_bin(&[("a", 1)])]);
        let (_dir, core) = deleting(&server, &["a"]);
        let before = core.queue().unwrap();
        assert_eq!(
            core.drain_until(&AtomicBool::new(true)).unwrap_err(),
            CoreError::Canceled
        );
        assert!(server.seen("/items/a").is_empty());
        assert_eq!(core.queue().unwrap(), before);
        // The witness: not stopped, the same drain reaches the server.
        core.drain_until(&AtomicBool::new(false)).unwrap();
        assert!(!server.seen("/items/a").is_empty());
        held_in_the_bin(&core, "a", 1);
    }

    #[test]
    fn redirected_writes_and_read_backs_leave_the_queue_uncounted() {
        for read_back in [false, true] {
            let server = crate::scripted::Scripted::start();
            let redirect = crate::scripted::Answer::Json {
                status: 307,
                body: "{}".into(),
                headers: vec![("Location".into(), "/next".into())],
            };
            let mut answers = Vec::new();
            if read_back {
                answers.push(crate::scripted::refusal(400, "invalid"));
            }
            answers.push(redirect);
            server.on("/items/a", answers);
            let (_dir, core) = deleting(&server, &["a", "b"]);
            let before = core.queue().unwrap();
            for _ in 0..6 {
                assert_eq!(
                    core.drain().unwrap_err(),
                    CoreError::Redirected {
                        origin: server.url(),
                        status: 307,
                        location: Some("/next".into()),
                    }
                );
                let after = core.queue().unwrap();
                for (old, new) in before.iter().zip(&after) {
                    assert_eq!(old.idempotency_key, new.idempotency_key);
                    assert_eq!(old.body, new.body);
                    assert_eq!(new.refusals, 0);
                }
                assert_eq!(after[0].verdict, read_back.then_some(Verdict::Refused));
                assert_eq!(after[1].verdict, None);
            }
            assert!(server.seen("/next").is_empty());
            assert!(server.seen("/items/b").is_empty());
        }
    }

    #[test]
    fn accepted_receipt_owes_a_fresh_read_even_without_a_generation_change() {
        let server = crate::scripted::Scripted::start();
        server.on(
            "/items/a",
            vec![
                crate::scripted::json(200, r#"{"ok":true}"#),
                crate::scripted::refusal(503, "unavailable"),
            ],
        );
        let (_dir, core) = deleting(&server, &["a"]);
        let original = core.queue().unwrap().remove(0);
        let report = core.drain().unwrap();
        assert_eq!(
            server.seen("/items/a").len(),
            2,
            "a receipt cannot certify the baseline"
        );
        assert!(report.unavailable.is_some());
        let requests = server.seen("/items/a");
        assert!(
            requests[0].read_view.is_none(),
            "writes do not carry read preconditions"
        );
        assert_eq!(
            requests[1].read_view.as_deref(),
            Some(crate::scripted::FENCE)
        );
        let settled = store::queued_write(&core.conn().unwrap(), &original.id)
            .unwrap()
            .unwrap();
        assert_eq!(settled.verdict, Some(Verdict::Accepted));
        assert_eq!(settled.refusals, 0);
        assert_eq!(settled.idempotency_key, original.idempotency_key);
        assert_eq!(settled.body, original.body);
        assert_eq!(
            store::owed_read_backs(&core.conn().unwrap()).unwrap().len(),
            1
        );
        assert_eq!(store::forget_answered(&core.conn().unwrap()).unwrap(), 0);
        server.on(
            "/items/a",
            vec![crate::scripted::certified(crate::scripted::refusal(
                404,
                "item_not_found",
            ))],
        );
        server.on("/items", vec![in_the_bin(&[("a", 1)])]);
        core.drain().unwrap();
        assert_eq!(
            server.seen("/items/a").len(),
            3,
            "retry reads without resending the settled write"
        );
        held_in_the_bin(&core, "a", 1);
        assert!(
            store::owed_read_backs(&core.conn().unwrap())
                .unwrap()
                .is_empty()
        );
        assert_eq!(store::forget_answered(&core.conn().unwrap()).unwrap(), 1);
    }

    #[test]
    fn uncertified_read_after_success_keeps_original_receipt_and_expires() {
        let server = crate::scripted::Scripted::start();
        server.on(
            "/items/a",
            vec![
                crate::scripted::json(200, r#"{"ok":true}"#),
                crate::scripted::refusal(404, "item_not_found"),
            ],
        );
        let (_dir, core) = deleting(&server, &["a"]);
        let original = core.queue().unwrap().remove(0);
        assert_eq!(core.drain().unwrap_err(), read_view::invalid());
        let conn = core.conn().unwrap();
        let settled = store::queued_write(&conn, &original.id).unwrap().unwrap();
        assert_eq!(settled.verdict, Some(Verdict::Accepted));
        assert_eq!(settled.refusals, 0);
        assert_eq!(settled.idempotency_key, original.idempotency_key);
        assert_eq!(settled.body, original.body);
        assert!(
            store::meta_get(&conn, store::META_EVENT_CURSOR)
                .unwrap()
                .is_none()
        );
        assert_eq!(store::owed_read_backs(&conn).unwrap().len(), 1);
        assert!(
            store::meta_get(&conn, &receipt_key(&original.id))
                .unwrap()
                .is_some()
        );
    }

    #[test]
    fn late_read_back_cannot_install_or_delete_or_settle_new_copy_debt() {
        // The server holds the row, holds it in the bin, or holds it nowhere.
        for (present, binned) in [(true, false), (false, true), (false, false)] {
            let server = crate::scripted::Scripted::start();
            let (_dir, core) = deleting(&server, &["a"]);
            let row = core.queue().unwrap().remove(0);
            let answer = if present {
                let mut body: serde_json::Value = serde_json::from_str(
                    &crate::scripted::item_payload("item.updated", "a", "core.note", 1),
                )
                .unwrap();
                body["listed"] = serde_json::Value::Bool(true);
                crate::scripted::json(200, &body.to_string())
            } else {
                crate::scripted::refusal(404, "item_not_found")
            };
            server.on("/items/a", vec![crate::scripted::certified(answer)]);
            server.on(
                "/items",
                vec![if binned {
                    in_the_bin(&[("a", 1)])
                } else {
                    crate::scripted::certified(crate::scripted::json(
                        200,
                        r#"{"data":[],"next_cursor":null}"#,
                    ))
                }],
            );
            let owed = store::owed_of(&core.conn().unwrap(), &row)
                .unwrap()
                .unwrap();
            let read =
                read_owed(&core, &owed, Bin::Held, &mut ViewChange::default(), false).unwrap();
            {
                let conn = core.conn().unwrap();
                read_view::advance_generation(&conn).unwrap();
                let newer = store::testing::note("a", "rebuilt", "", "2026-02-01T00:00:00Z");
                store::upsert_item(&conn, &newer, None, &Default::default()).unwrap();
                store::owe_read_back(&conn, &owed).unwrap();
            }
            assert!(matches!(
                apply_owed(&core, &owed, &read),
                Err(CoreError::StreamIncomplete { .. })
            ));
            let conn = core.conn().unwrap();
            assert_eq!(
                store::item_by_id(&conn, "a").unwrap().unwrap().properties["title"],
                "rebuilt"
            );
            assert_eq!(store::owed_read_backs(&conn).unwrap().len(), 1);
        }
    }

    #[test]
    fn an_accepted_delete_keeps_the_row_the_bin_holds_trashed_and_pinned() {
        let server = crate::scripted::Scripted::start();
        server.on(
            "/items/a",
            vec![
                crate::scripted::json(200, r#"{"ok":true}"#),
                crate::scripted::certified(crate::scripted::refusal(404, "item_not_found")),
            ],
        );
        server.on("/items", vec![in_the_bin(&[("a", 4)])]);
        let (_dir, core) = deleting(&server, &["a"]);
        store::pin(&core.conn().unwrap(), "a").unwrap();
        // The slice no longer takes the row, so only the pin holds it.
        store::meta_set(
            &core.conn().unwrap(),
            store::META_SLICE_TYPES,
            "[\"core.task\"]",
        )
        .unwrap();
        let report = core.drain().unwrap();
        assert_eq!(report.verdicts[0].verdict, Some(Verdict::Accepted));
        let asked = server.seen("/items");
        assert_eq!(asked.len(), 1, "the read by id answered gone, so the bin");
        assert!(asked[0].query.contains("state=trashed"));
        assert_eq!(asked[0].read_view.as_deref(), Some(crate::scripted::FENCE));
        held_in_the_bin(&core, "a", 4);
        let conn = core.conn().unwrap();
        assert!(store::pinned(&conn, "a").unwrap());
        assert!(store::owed_read_backs(&conn).unwrap().is_empty());
    }

    #[test]
    fn a_refused_write_keeps_the_row_the_bin_holds() {
        let server = crate::scripted::Scripted::start();
        server.on(
            "/items/a",
            vec![
                crate::scripted::refusal(404, "item_not_found"),
                crate::scripted::certified(crate::scripted::refusal(404, "item_not_found")),
            ],
        );
        server.on("/items", vec![in_the_bin(&[("a", 2)])]);
        let (_dir, core) = deleting(&server, &["a"]);
        let report = core.drain().unwrap();
        assert_eq!(report.verdicts[0].verdict, Some(Verdict::Refused));
        assert_eq!(server.seen("/items").len(), 1, "the bin was asked");
        held_in_the_bin(&core, "a", 2);
        assert!(
            store::owed_read_backs(&core.conn().unwrap())
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn a_row_neither_the_read_by_id_nor_the_bin_holds_is_forgotten() {
        let bin_answers = [
            crate::scripted::certified(crate::scripted::json(
                200,
                r#"{"data":[],"next_cursor":null}"#,
            )),
            crate::scripted::certified(crate::scripted::refusal(403, "forbidden")),
        ];
        for bin in bin_answers {
            let server = crate::scripted::Scripted::start();
            server.on(
                "/items/a",
                vec![
                    crate::scripted::json(200, r#"{"ok":true}"#),
                    crate::scripted::certified(crate::scripted::refusal(404, "item_not_found")),
                ],
            );
            server.on("/items", vec![bin]);
            let (_dir, core) = deleting(&server, &["a"]);
            store::pin(&core.conn().unwrap(), "a").unwrap();
            // The witness: the copy holds the row until the drain.
            assert!(store::item_held(&core.conn().unwrap(), "a").unwrap());
            core.drain().unwrap();
            assert_eq!(server.seen("/items").len(), 1, "the bin was asked");
            let conn = core.conn().unwrap();
            assert!(!store::item_held(&conn, "a").unwrap());
            assert!(!store::pinned(&conn, "a").unwrap());
            assert!(store::owed_read_backs(&conn).unwrap().is_empty());
        }
    }

    #[test]
    fn a_bin_read_that_fails_keeps_the_row_and_the_read_owed() {
        let server = crate::scripted::Scripted::start();
        server.on(
            "/items/a",
            vec![
                crate::scripted::json(200, r#"{"ok":true}"#),
                crate::scripted::certified(crate::scripted::refusal(404, "item_not_found")),
            ],
        );
        server.on(
            "/items",
            vec![crate::scripted::refusal(503, "server_unavailable")],
        );
        let (_dir, core) = deleting(&server, &["a"]);
        let report = core.drain().unwrap();
        assert!(report.unavailable.is_some(), "{report:?}");
        assert_eq!(report.verdicts[0].verdict, Some(Verdict::Accepted));
        assert_eq!(server.seen("/items").len(), 1);
        {
            let conn = core.conn().unwrap();
            assert!(store::item_held(&conn, "a").unwrap());
            assert_eq!(store::owed_read_backs(&conn).unwrap().len(), 1);
        }
        // The next drain reads again, sending nothing, and keeps the row.
        server.on("/items", vec![in_the_bin(&[("a", 1)])]);
        core.drain().unwrap();
        assert_eq!(server.seen("/items/a").len(), 3);
        held_in_the_bin(&core, "a", 1);
        assert!(
            store::owed_read_backs(&core.conn().unwrap())
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn adoption_remaps_unsent_held_edges_without_rewriting_sent_attempts() {
        let conn = store::testing::conn();
        for verdict in [None, Some(Verdict::Blocked), Some(Verdict::Dead)] {
            for sent in [false, true] {
                let id = format!("edge-{:?}-{sent}", verdict);
                let mut queued = write(WriteKind::CreateEdge, "local", Some(&id), Some(3), &[]);
                queued.target_id = Some("local");
                queued.payload = r#"{"source_id":"local","target_id":"local","edge_type":"references","properties":{"note":"unsent content"}}"#;
                let row = store::enqueue(&conn, &queued).unwrap();
                if let Some(verdict) = verdict {
                    store::record_verdict(
                        &conn,
                        &row.id,
                        &store::Answered {
                            verdict,
                            reason: (verdict == Verdict::Blocked)
                                .then_some(crate::model::AWAITING_DEPENDENCY),
                            answer: None,
                            conflicted_copy_id: None,
                        },
                    )
                    .unwrap();
                }
                if sent {
                    store::mark_sent(&conn, &row.id).unwrap();
                }
            }
        }
        let before = store::queued_writes(&conn).unwrap();
        store::adopt_answered_id(&conn, "local", "server").unwrap();
        for original in before {
            let row = store::queued_write(&conn, &original.id).unwrap().unwrap();
            let sent = original.edge_id.as_ref().unwrap().ends_with("true");
            let expected = if sent { "local" } else { "server" };
            assert_eq!(row.item_id.as_deref(), Some(expected));
            assert_eq!(row.target_id.as_deref(), Some(expected));
            assert_eq!(row.body["source_id"], expected);
            assert_eq!(row.body["target_id"], expected);
            assert_eq!(row.body["properties"], original.body["properties"]);
            assert_eq!(row.idempotency_key, original.idempotency_key);
            assert_eq!(row.base_version, original.base_version);
            assert_eq!(row.verdict, original.verdict);
            if sent {
                assert_eq!(row, original);
            }
        }
    }

    /// A copy holding the notes `p1` and `p2`, and for each name in `edges` a
    /// note `c-<name>` and the edge `<name>` from `p1` to it.
    fn holding_edges(
        server: &crate::scripted::Scripted,
        edges: &[&str],
    ) -> (tempfile::TempDir, Core) {
        let (dir, core) = deleting(server, &[]);
        {
            let conn = core.conn().unwrap();
            let held = ["p1", "p2"]
                .into_iter()
                .map(str::to_string)
                .chain(edges.iter().map(|name| format!("c-{name}")));
            for id in held {
                let item = store::testing::note(&id, &id, "", "2026-01-01T00:00:00Z");
                store::upsert_item(&conn, &item, None, &Default::default()).unwrap();
            }
            for name in edges {
                store::put_server_edge(
                    &conn,
                    &store::testing::wire_edge(name, "p1", &format!("c-{name}"), "parent-of"),
                )
                .unwrap();
            }
        }
        (dir, core)
    }

    fn edge_answered(id: &str, source: &str, version: i64) -> crate::scripted::Answer {
        crate::scripted::json(
            200,
            &json!({
                "edge": {
                    "id": id,
                    "source_id": source,
                    "target_id": format!("c-{id}"),
                    "edge_type": "parent-of",
                    "properties": {},
                    "version": version,
                    "created_at": "2026-01-01T00:00:00Z",
                    "updated_at": "2026-02-01T00:00:00Z",
                },
                "acknowledged": false,
            })
            .to_string(),
        )
    }

    fn moved_to_p2(core: &Core, edge: &str) -> QueuedWrite {
        core.update_edge(
            edge,
            &crate::model::EdgeEdit {
                base_version: Some(1),
                source_id: Some("p2".into()),
                ..Default::default()
            },
        )
        .unwrap()
        .unwrap()
    }

    fn rank_edit(core: &Core, edge: &str) -> QueuedWrite {
        core.update_edge(
            edge,
            &crate::model::EdgeEdit {
                base_version: Some(1),
                properties: json!({ "rank": 1 }).as_object().unwrap().clone(),
                ..Default::default()
            },
        )
        .unwrap()
        .unwrap()
    }

    fn view_changed() -> CoreError {
        CoreError::CopyExpired {
            reason: "read_view_changed".into(),
        }
    }

    #[test]
    fn a_run_of_source_moves_is_sent_whole_and_expires_the_copy_once_at_its_end() {
        let server = crate::scripted::Scripted::start();
        let names = ["e1", "e2", "e3"];
        let (_dir, core) = holding_edges(&server, &names);
        let queued: Vec<QueuedWrite> = names.iter().map(|name| moved_to_p2(&core, name)).collect();
        for name in names {
            // The move, then the read of the edge under a view the move changed.
            server.on(
                &format!("/edges/{name}"),
                vec![
                    edge_answered(name, "p2", 2),
                    crate::scripted::refusal(409, "read_view_changed"),
                ],
            );
        }
        assert_eq!(core.drain().unwrap_err(), view_changed());
        let conn = core.conn().unwrap();
        for row in &queued {
            let settled = store::queued_write(&conn, &row.id).unwrap().unwrap();
            assert_eq!(settled.verdict, Some(Verdict::Accepted), "{}", row.id);
        }
        let reads = |name: &str| {
            server
                .seen(&format!("/edges/{name}"))
                .iter()
                .filter(|seen| seen.read_view.is_some())
                .count()
        };
        // The witness: the move that changed the view was read back under it.
        assert_eq!(reads("e1"), 1);
        for name in ["e2", "e3"] {
            assert_eq!(
                server.seen(&format!("/edges/{name}")).len(),
                1,
                "{name} was not sent once"
            );
            assert_eq!(
                reads(name),
                0,
                "{name} was read under a view known to have changed"
            );
        }
        assert!(read_view::expired(&conn).unwrap());
        assert_eq!(
            store::owed_read_backs(&conn).unwrap().len(),
            3,
            "the reads stay owed for the hydration that follows"
        );
    }

    #[test]
    fn a_view_change_met_anywhere_but_in_a_source_move_ends_the_drain_at_once() {
        let server = crate::scripted::Scripted::start();
        let (_dir, core) = holding_edges(&server, &["e1", "e2"]);
        let (first, second) = (rank_edit(&core, "e1"), rank_edit(&core, "e2"));
        server.on(
            "/edges/e1",
            vec![
                edge_answered("e1", "p1", 2),
                crate::scripted::refusal(409, "read_view_changed"),
            ],
        );
        server.on("/edges/e2", vec![edge_answered("e2", "p1", 2)]);
        assert_eq!(core.drain().unwrap_err(), view_changed());
        let conn = core.conn().unwrap();
        let verdict = |id: &str| store::queued_write(&conn, id).unwrap().unwrap().verdict;
        assert_eq!(verdict(&first.id), Some(Verdict::Accepted));
        assert_eq!(verdict(&second.id), None);
        assert!(
            server.seen("/edges/e2").is_empty(),
            "a write behind was sent after the view changed under a write that moved no source"
        );
        assert!(read_view::expired(&conn).unwrap());
    }

    fn instance_changed() -> CoreError {
        CoreError::CopyExpired {
            reason: INSTANCE_CHANGED.into(),
        }
    }

    #[test]
    fn another_instance_refusing_a_write_ends_the_drain_with_the_queue_kept_and_unsent() {
        // The witness: the same status under another code is about the write,
        // which the drain counts and goes on past.
        for (code, counted) in [
            ("idempotency_key_in_flight", true),
            (INSTANCE_CHANGED, false),
        ] {
            let server = crate::scripted::Scripted::start();
            let (_dir, core) = holding_edges(&server, &["e1", "e2"]);
            let (first, second) = (rank_edit(&core, "e1"), rank_edit(&core, "e2"));
            server.on("/edges/e1", vec![crate::scripted::refusal(409, code)]);
            server.on(
                "/edges/e2",
                vec![
                    edge_answered("e2", "p1", 2),
                    crate::scripted::certified(edge_answered("e2", "p1", 2)),
                ],
            );
            let drained = core.drain();
            let conn = core.conn().unwrap();
            let row = |id: &str| store::queued_write(&conn, id).unwrap().unwrap();
            assert_eq!(
                server.seen("/edges/e1")[0].instance.as_deref(),
                Some(crate::scripted::INSTANCE),
                "the write did not name the copy's instance"
            );
            if counted {
                assert!(drained.is_ok(), "{drained:?}");
                assert_eq!(row(&first.id).refusals, 1);
                assert_eq!(server.seen("/edges/e2").len(), 2, "sent and read back");
                assert!(!read_view::expired(&conn).unwrap());
                continue;
            }
            assert_eq!(drained.unwrap_err(), instance_changed());
            let kept = row(&first.id);
            assert_eq!(
                kept.verdict, None,
                "the refusal was recorded as the write's verdict"
            );
            assert_eq!(kept.refusals, 0);
            assert_eq!(kept.idempotency_key, first.idempotency_key);
            assert!(
                store::unsent(&conn, &first.id).unwrap(),
                "the write stays marked sent though the refusal proves it was not applied"
            );
            assert_eq!(row(&second.id).verdict, None);
            assert!(
                server.seen("/edges/e2").is_empty(),
                "a write was sent after another instance refused one"
            );
            assert!(read_view::expired(&conn).unwrap());
        }
    }

    #[test]
    fn another_instance_refusing_a_write_an_earlier_attempt_sent_marks_it_unsent() {
        let server = crate::scripted::Scripted::start();
        let (_dir, core) = holding_edges(&server, &["e1"]);
        let first = rank_edit(&core, "e1");
        store::mark_sent(&core.conn().unwrap(), &first.id).unwrap();
        server.on(
            "/edges/e1",
            vec![crate::scripted::refusal(409, INSTANCE_CHANGED)],
        );
        assert_eq!(core.drain().unwrap_err(), instance_changed());
        let conn = core.conn().unwrap();
        // The copy is built again from the instance now at the address,
        // which never saw an earlier attempt, so the write is judged afresh.
        assert!(
            store::unsent(&conn, &first.id).unwrap(),
            "the write stays marked sent to an instance the copy no longer follows"
        );
        assert_eq!(
            store::queued_write(&conn, &first.id)
                .unwrap()
                .unwrap()
                .verdict,
            None
        );
    }

    #[test]
    fn another_instance_after_an_accepted_source_move_ends_the_drain_at_once() {
        let server = crate::scripted::Scripted::start();
        let (_dir, core) = holding_edges(&server, &["e1", "e2", "e3"]);
        let moved = moved_to_p2(&core, "e1");
        let (refused, behind) = (rank_edit(&core, "e2"), rank_edit(&core, "e3"));
        server.on(
            "/edges/e1",
            vec![
                edge_answered("e1", "p2", 2),
                crate::scripted::refusal(409, "read_view_changed"),
            ],
        );
        server.on(
            "/edges/e2",
            vec![crate::scripted::refusal(409, INSTANCE_CHANGED)],
        );
        server.on("/edges/e3", vec![edge_answered("e3", "p1", 2)]);
        assert_eq!(core.drain().unwrap_err(), instance_changed());
        let conn = core.conn().unwrap();
        let verdict = |id: &str| store::queued_write(&conn, id).unwrap().unwrap().verdict;
        assert_eq!(verdict(&moved.id), Some(Verdict::Accepted));
        assert_eq!(verdict(&refused.id), None);
        assert!(store::unsent(&conn, &refused.id).unwrap());
        assert_eq!(verdict(&behind.id), None);
        assert!(
            server.seen("/edges/e3").is_empty(),
            "a write was sent after another instance refused one, though a source move had deferred the expiry"
        );
        assert!(read_view::expired(&conn).unwrap());
    }

    #[test]
    fn the_reads_a_run_of_source_moves_left_owed_are_made_by_the_drain_after_the_copy_is_built_again()
     {
        let server = crate::scripted::Scripted::start();
        let names = ["e1", "e2"];
        let (_dir, core) = holding_edges(&server, &names);
        for name in names {
            moved_to_p2(&core, name);
            server.on(
                &format!("/edges/{name}"),
                vec![
                    edge_answered(name, "p2", 2),
                    crate::scripted::refusal(409, "read_view_changed"),
                ],
            );
        }
        assert_eq!(core.drain().unwrap_err(), view_changed());
        // A hydration, as far as the drain can tell.
        {
            let conn = core.conn().unwrap();
            read_view::advance_generation(&conn).unwrap();
            store::meta_set(&conn, store::META_EVENT_CURSOR, "20").unwrap();
            store::meta_set(&conn, read_view::FENCE, &"a".repeat(64)).unwrap();
        }
        for name in names {
            server.on(
                &format!("/edges/{name}"),
                vec![crate::scripted::certified(edge_answered(name, "p2", 2))],
            );
        }
        let report = core.drain().unwrap();
        assert_eq!(
            report.answered, 0,
            "a write already answered was sent again"
        );
        let conn = core.conn().unwrap();
        assert!(store::owed_read_backs(&conn).unwrap().is_empty());
        for name in names {
            assert_eq!(
                store::edge_by_id(&conn, name).unwrap().unwrap().source_id,
                "p2"
            );
        }
    }

    #[test]
    fn an_edit_behind_a_source_move_goes_on_the_version_the_move_made() {
        let server = crate::scripted::Scripted::start();
        let (_dir, core) = holding_edges(&server, &["e1"]);
        let moved = moved_to_p2(&core, "e1");
        let edited = rank_edit(&core, "e1");
        server.on(
            "/edges/e1",
            vec![
                edge_answered("e1", "p2", 2),
                crate::scripted::refusal(409, "read_view_changed"),
                edge_answered("e1", "p2", 3),
            ],
        );
        assert_eq!(core.drain().unwrap_err(), view_changed());
        let conn = core.conn().unwrap();
        for row in [&moved, &edited] {
            let settled = store::queued_write(&conn, &row.id).unwrap().unwrap();
            assert_eq!(settled.verdict, Some(Verdict::Accepted), "{}", row.id);
        }
        let sent: Vec<serde_json::Value> = server
            .seen("/edges/e1")
            .iter()
            .filter(|seen| seen.read_view.is_none())
            .map(|seen| serde_json::from_slice(&seen.body).unwrap())
            .collect();
        assert_eq!(sent.len(), 2);
        assert_eq!(sent[0]["source_id"], "p2");
        assert_eq!(
            sent[1]["version"], 2,
            "the edit went on the version it was based on"
        );
    }

    #[test]
    fn a_write_refused_behind_a_source_move_is_judged_as_it_would_have_been() {
        let server = crate::scripted::Scripted::start();
        let names = ["e1", "e2", "e3"];
        let (_dir, core) = holding_edges(&server, &names);
        let queued: Vec<QueuedWrite> = names.iter().map(|name| moved_to_p2(&core, name)).collect();
        server.on(
            "/edges/e1",
            vec![
                edge_answered("e1", "p2", 2),
                crate::scripted::refusal(409, "read_view_changed"),
            ],
        );
        server.on(
            "/edges/e2",
            vec![crate::scripted::refusal(404, "item_not_found")],
        );
        server.on("/edges/e3", vec![edge_answered("e3", "p2", 2)]);
        assert_eq!(core.drain().unwrap_err(), view_changed());
        let conn = core.conn().unwrap();
        let verdicts: Vec<Option<Verdict>> = queued
            .iter()
            .map(|row| {
                store::queued_write(&conn, &row.id)
                    .unwrap()
                    .unwrap()
                    .verdict
            })
            .collect();
        assert_eq!(
            verdicts,
            vec![
                Some(Verdict::Accepted),
                Some(Verdict::Refused),
                Some(Verdict::Accepted)
            ]
        );
    }

    /// The copy as a hydration leaves it, as far as the drain can tell.
    fn hydrated_again(core: &Core) {
        let conn = core.conn().unwrap();
        read_view::advance_generation(&conn).unwrap();
        store::meta_set(&conn, store::META_EVENT_CURSOR, "20").unwrap();
        store::meta_set(&conn, read_view::FENCE, &"a".repeat(64)).unwrap();
    }

    #[test]
    fn a_refusal_left_to_its_read_behind_a_source_move_does_not_rebase_the_writes_behind_it_again()
    {
        let server = crate::scripted::Scripted::start();
        let (_dir, core) = holding_edges(&server, &["e1", "e2"]);
        moved_to_p2(&core, "e1");
        let refused = rank_edit(&core, "e2");
        server.on(
            "/edges/e1",
            vec![
                edge_answered("e1", "p2", 2),
                crate::scripted::refusal(409, "read_view_changed"),
                crate::scripted::certified(edge_answered("e1", "p2", 2)),
            ],
        );
        server.on(
            "/edges/e2",
            vec![
                crate::scripted::refusal(404, "item_not_found"),
                crate::scripted::certified(edge_answered("e2", "p1", 1)),
            ],
        );
        assert_eq!(core.drain().unwrap_err(), view_changed());
        {
            let conn = core.conn().unwrap();
            let settled = store::queued_write(&conn, &refused.id).unwrap().unwrap();
            assert_eq!(settled.verdict, Some(Verdict::Refused));
            assert!(
                store::meta_get(&conn, &receipt_key(&refused.id))
                    .unwrap()
                    .is_none(),
                "the refusal's queue work is done, yet its receipt stands to do it again"
            );
            assert!(
                store::owed_read_backs(&conn)
                    .unwrap()
                    .iter()
                    .any(|owed| owed.id == "e2"),
                "the refusal's read is no longer owed"
            );
        }
        hydrated_again(&core);
        // A later edit of the same property, moved onto version 2 since.
        let later = {
            let conn = core.conn().unwrap();
            store::enqueue(
                &conn,
                &store::NewWrite {
                    kind: WriteKind::UpdateEdge,
                    item_id: Some("p1"),
                    target_id: Some("c-e2"),
                    edge_id: Some("e2"),
                    namespace: None,
                    tag: None,
                    blob: None,
                    base_version: Some(2),
                    payload: r#"{"properties":{"rank":2},"version":2}"#,
                    depends_on: &[],
                },
            )
            .unwrap()
        };
        read_owed_backs(&core, &AtomicBool::new(false), &mut ViewChange::default()).unwrap();
        let conn = core.conn().unwrap();
        assert_eq!(
            store::queued_write(&conn, &later.id)
                .unwrap()
                .unwrap()
                .base_version,
            Some(2),
            "recovering the refusal rebased a later edit a second time, back onto version 1"
        );
    }

    #[test]
    fn a_wait_the_server_asks_for_after_a_source_move_is_reported_with_the_expiry() {
        let server = crate::scripted::Scripted::start();
        let (_dir, core) = holding_edges(&server, &["e1", "e2"]);
        let moves = [moved_to_p2(&core, "e1"), moved_to_p2(&core, "e2")];
        server.on(
            "/edges/e1",
            vec![
                edge_answered("e1", "p2", 2),
                crate::scripted::refusal(409, "read_view_changed"),
            ],
        );
        server.on(
            "/edges/e2",
            vec![crate::scripted::Answer::Json {
                status: 429,
                body: r#"{"error":{"code":"rate_limited","message":"slow down"}}"#.into(),
                headers: vec![("Retry-After".into(), "120".into())],
            }],
        );
        let report = core.drain().unwrap();
        assert_eq!(report.retry_after_seconds, Some(120));
        assert!(report.unavailable.is_some());
        let conn = core.conn().unwrap();
        assert!(
            read_view::expired(&conn).unwrap(),
            "the copy was left current"
        );
        let verdicts: Vec<_> = moves
            .iter()
            .map(|row| {
                store::queued_write(&conn, &row.id)
                    .unwrap()
                    .unwrap()
                    .verdict
            })
            .collect();
        assert_eq!(verdicts, vec![Some(Verdict::Accepted), None]);
        drop(conn);
        assert!(matches!(
            core.drain().unwrap_err(),
            CoreError::CopyExpired { .. }
        ));
    }

    #[test]
    fn a_read_owed_from_an_earlier_pass_ends_the_drain_at_once_where_the_view_has_changed() {
        let server = crate::scripted::Scripted::start();
        let (_dir, core) = holding_edges(&server, &["e1", "e2"]);
        moved_to_p2(&core, "e1");
        let behind = moved_to_p2(&core, "e2");
        server.on(
            "/edges/e1",
            vec![
                edge_answered("e1", "p2", 2),
                crate::scripted::json(503, r#"{"error":{"code":"unavailable","message":"busy"}}"#),
                crate::scripted::refusal(409, "read_view_changed"),
            ],
        );
        server.on("/edges/e2", vec![edge_answered("e2", "p2", 2)]);
        let first = core.drain().unwrap();
        assert!(first.unavailable.is_some(), "the witness: the read failed");
        assert!(server.seen("/edges/e2").is_empty());
        assert_eq!(core.drain().unwrap_err(), view_changed());
        assert!(
            server.seen("/edges/e2").is_empty(),
            "a write was sent after an earlier pass's read met a changed view"
        );
        let conn = core.conn().unwrap();
        assert_eq!(
            store::queued_write(&conn, &behind.id)
                .unwrap()
                .unwrap()
                .verdict,
            None
        );
        assert!(read_view::expired(&conn).unwrap());
    }

    #[test]
    fn moves_the_server_refuses_leave_the_copy_current() {
        let server = crate::scripted::Scripted::start();
        let names = ["e1", "e2"];
        let (_dir, core) = holding_edges(&server, &names);
        let moves: Vec<_> = names.iter().map(|name| moved_to_p2(&core, name)).collect();
        for name in names {
            server.on(
                &format!("/edges/{name}"),
                vec![
                    crate::scripted::refusal(404, "item_not_found"),
                    crate::scripted::certified(crate::scripted::refusal(404, "edge_not_found")),
                ],
            );
        }
        let report = core.drain().unwrap();
        assert_eq!(report.answered, 2);
        let conn = core.conn().unwrap();
        for row in &moves {
            assert_eq!(
                store::queued_write(&conn, &row.id)
                    .unwrap()
                    .unwrap()
                    .verdict,
                Some(Verdict::Refused)
            );
        }
        assert!(
            !read_view::expired(&conn).unwrap(),
            "a refused move expired the copy"
        );
    }

    #[test]
    fn an_edge_read_back_uses_direct_certified_absence() {
        let server = crate::scripted::Scripted::start();
        let (_dir, core) = deleting(&server, &[]);
        let owed = store::Owed {
            subject: Subject::Edge,
            id: "edge".into(),
            source_id: Some("source".into()),
            edge_type: Some("references".into()),
            moved: false,
        };
        store::owe_read_back(&core.conn().unwrap(), &owed).unwrap();
        server.on(
            "/edges/edge",
            vec![crate::scripted::certified(crate::scripted::refusal(
                404,
                "edge_not_found",
            ))],
        );
        let read = read_owed(&core, &owed, Bin::Held, &mut ViewChange::default(), false).unwrap();
        apply_owed(&core, &owed, &read).unwrap();
        assert_eq!(server.seen("/edges/edge").len(), 1);
        assert!(server.seen("/items/source/edges").is_empty());
        assert!(
            store::owed_read_backs(&core.conn().unwrap())
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn natural_key_landing_admits_source_excluded_row_under_its_moved_pin() {
        let server = crate::scripted::Scripted::start();
        let (_dir, core) = deleting(&server, &[]);
        let create = {
            let conn = core.conn().unwrap();
            store::upsert_item(
                &conn,
                &store::testing::note("local", "mine", "", "2026-01-01T00:00:00Z"),
                None,
                &Default::default(),
            )
            .unwrap();
            store::pin(&conn, "local").unwrap();
            store::enqueue(
                &conn,
                &write(WriteKind::CreateItem, "local", None, None, &[]),
            )
            .unwrap()
        };
        let mut body: serde_json::Value = serde_json::from_str(&crate::scripted::item_payload(
            "item.updated",
            "server",
            "core.note",
            1,
        ))
        .unwrap();
        body["listed"] = false.into();
        server.on(
            "/items/server",
            vec![crate::scripted::certified(crate::scripted::json(
                200,
                &body.to_string(),
            ))],
        );
        let answer = Ok(Answer {
            status: 409,
            code: "version_conflict".into(),
            body: "{}".into(),
            retry_after_seconds: None,
            replayed: false,
            contract_named: true,
        });
        let settled = land(
            &core,
            &create,
            &answer,
            Shape::Item,
            "server",
            "version_conflict".into(),
            &mut ViewChange::default(),
        )
        .unwrap();
        assert_eq!(settled.verdict, Some(Verdict::Refused));
        let conn = core.conn().unwrap();
        assert_eq!(
            store::queued_write(&conn, &create.id)
                .unwrap()
                .unwrap()
                .item_id
                .as_deref(),
            Some("server")
        );
        assert!(store::pinned(&conn, "server").unwrap());
        assert!(store::item_held(&conn, "server").unwrap());
        assert!(!store::item_held(&conn, "local").unwrap());
    }

    #[test]
    fn natural_key_receipt_keeps_dependent_work_until_certified_landing() {
        let server = crate::scripted::Scripted::start();
        let (_dir, core) = deleting(&server, &[]);
        let (create, dependant) = {
            let conn = core.conn().unwrap();
            let local = store::testing::note("local", "draft", "", "2026-01-01T00:00:00Z");
            store::upsert_item(&conn, &local, None, &Default::default()).unwrap();
            store::pin(&conn, "local").unwrap();
            let create = store::enqueue(
                &conn,
                &write(WriteKind::CreateItem, "local", None, None, &[]),
            )
            .unwrap();
            let mut tag = write(
                WriteKind::AddTag,
                "local",
                None,
                None,
                std::slice::from_ref(&create.id),
            );
            tag.tag = Some("kept");
            let dependant = store::enqueue(&conn, &tag).unwrap();
            (create, dependant)
        };
        server.on(
            "/items/server",
            vec![crate::scripted::certified(crate::scripted::refusal(
                404,
                "item_not_found",
            ))],
        );
        let answer = Ok(Answer {
            status: 409,
            code: "version_conflict".into(),
            body: "{}".into(),
            retry_after_seconds: None,
            replayed: false,
            contract_named: true,
        });
        let settled = land(
            &core,
            &create,
            &answer,
            Shape::Item,
            "server",
            "version_conflict".into(),
            &mut ViewChange::default(),
        )
        .unwrap();
        assert_eq!(settled.verdict, Some(Verdict::Refused));
        // An absent target leaves the receipt owed without ending the pass.
        assert!(settled.unavailable.is_none());
        {
            let conn = core.conn().unwrap();
            assert!(
                store::pending_landings(&conn)
                    .unwrap()
                    .contains_key(&create.id)
            );
            assert_eq!(
                store::queued_write(&conn, &dependant.id).unwrap().unwrap(),
                dependant
            );
            assert!(store::item_held(&conn, "local").unwrap());
            read_view::advance_generation(&conn).unwrap();
        }
        let mut body: serde_json::Value = serde_json::from_str(&crate::scripted::item_payload(
            "item.updated",
            "server",
            "core.note",
            1,
        ))
        .unwrap();
        body["listed"] = serde_json::Value::Bool(true);
        server.on(
            "/items/server",
            vec![crate::scripted::certified(crate::scripted::json(
                200,
                &body.to_string(),
            ))],
        );
        assert!(
            read_owed_backs(&core, &AtomicBool::new(false), &mut ViewChange::default())
                .unwrap()
                .is_none()
        );
        let conn = core.conn().unwrap();
        let moved = store::queued_write(&conn, &dependant.id).unwrap().unwrap();
        assert_eq!(moved.item_id.as_deref(), Some("server"));
        assert_eq!(moved.body, dependant.body);
        assert_eq!(moved.idempotency_key, dependant.idempotency_key);
        assert!(moved.depends_on.is_empty());
        assert!(
            store::meta_get(&conn, &receipt_key(&create.id))
                .unwrap()
                .is_none()
        );
    }

    /// A create refused onto `server`, which no read finds, with an edit and
    /// a tag of its row waiting on it and an edit waiting on that edit.
    fn unfound_landing(
        server: &crate::scripted::Scripted,
        pinned: bool,
    ) -> (tempfile::TempDir, Core, QueuedWrite, Vec<QueuedWrite>) {
        let (dir, core) = deleting(server, &[]);
        let (create, waiting) = {
            let conn = core.conn().unwrap();
            let local = store::testing::note("local", "draft", "", "2026-01-01T00:00:00Z");
            store::upsert_item(&conn, &local, None, &Default::default()).unwrap();
            if pinned {
                store::pin(&conn, "local").unwrap();
            }
            let create = store::enqueue(
                &conn,
                &write(WriteKind::CreateItem, "local", None, None, &[]),
            )
            .unwrap();
            store::mark_sent(&conn, &create.id).unwrap();
            let mut tag = write(
                WriteKind::AddTag,
                "local",
                None,
                None,
                std::slice::from_ref(&create.id),
            );
            tag.tag = Some("kept");
            let tag = store::enqueue(&conn, &tag).unwrap();
            let mut edit = write(
                WriteKind::UpdateItem,
                "local",
                None,
                Some(0),
                std::slice::from_ref(&create.id),
            );
            edit.payload = r#"{"properties":{"title":"mine"}}"#;
            let edit = store::enqueue(&conn, &edit).unwrap();
            let mut later = write(
                WriteKind::UpdateItem,
                "local",
                None,
                Some(0),
                std::slice::from_ref(&edit.id),
            );
            later.payload = r#"{"properties":{"title":"later"}}"#;
            let later = store::enqueue(&conn, &later).unwrap();
            (create, vec![tag, edit, later])
        };
        server.on(
            "/items/server",
            vec![crate::scripted::certified(crate::scripted::refusal(
                404,
                "item_not_found",
            ))],
        );
        let answer = Ok(Answer {
            status: 409,
            code: "version_conflict".into(),
            body: "{}".into(),
            retry_after_seconds: None,
            replayed: false,
            contract_named: true,
        });
        land(
            &core,
            &create,
            &answer,
            Shape::Item,
            "server",
            "version_conflict".into(),
            &mut ViewChange::default(),
        )
        .unwrap();
        assert!(
            store::pending_landings(&core.conn().unwrap())
                .unwrap()
                .contains_key(&create.id)
        );
        (dir, core, create, waiting)
    }

    #[test]
    fn a_discarded_create_no_read_can_land_refuses_unsent_what_waits_on_it() {
        let server = crate::scripted::Scripted::start();
        let (_dir, core, create, waiting) = unfound_landing(&server, false);
        assert!(core.discard(&create.id).unwrap());
        {
            let conn = core.conn().unwrap();
            assert!(store::queued_write(&conn, &create.id).unwrap().is_none());
            for before in &waiting {
                let after = store::queued_write(&conn, &before.id).unwrap().unwrap();
                assert_eq!(after.verdict, Some(Verdict::Refused));
                assert_eq!(
                    after.reason.as_deref(),
                    Some("the create_item it waits for was discarded")
                );
                assert_eq!(after.body, before.body);
                assert_eq!(after.idempotency_key, before.idempotency_key);
            }
            assert!(!store::item_held(&conn, "local").unwrap());
            assert!(store::pending_landings(&conn).unwrap().is_empty());
            assert!(
                store::meta_get(&conn, &receipt_key(&create.id))
                    .unwrap()
                    .is_none()
            );
            assert!(
                store::owed_read_backs(&conn).unwrap().is_empty(),
                "the copy still owes a read of the row only the discarded create named"
            );
        }
        for each in &waiting {
            assert!(!core.release(&each.id).unwrap());
        }
        let reads = server.seen("/items/server").len();
        assert!(reads > 0);
        assert!(
            read_owed_backs(&core, &AtomicBool::new(false), &mut ViewChange::default())
                .unwrap()
                .is_none()
        );
        assert_eq!(
            server.seen("/items/server").len(),
            reads,
            "a drain after the discard read the row the discarded create's key names"
        );
        for each in waiting.iter().rev() {
            assert!(core.discard(&each.id).unwrap());
        }
        assert!(core.queue().unwrap().is_empty());
    }

    #[test]
    fn a_drain_keeps_a_refusal_a_withdraw_recorded_while_it_ran() {
        use crate::scripted::{Answer, certified, json, refusal};
        use std::sync::Arc;
        use std::sync::atomic::Ordering;
        use std::time::Duration;
        let server = crate::scripted::Scripted::start();
        let (_dir, core) = deleting(&server, &[]);
        let create = {
            let conn = core.conn().unwrap();
            for id in ["local", "u"] {
                let item = store::testing::note(id, id, "", "2026-01-01T00:00:00Z");
                store::upsert_item(&conn, &item, None, &Default::default()).unwrap();
            }
            let create = store::enqueue(
                &conn,
                &write(WriteKind::CreateItem, "local", None, None, &[]),
            )
            .unwrap();
            store::mark_sent(&conn, &create.id).unwrap();
            store::record_verdict(
                &conn,
                &create.id,
                &store::Answered {
                    verdict: Verdict::Blocked,
                    reason: Some(BlockedReason::AncestorUnavailable.as_str()),
                    answer: None,
                    conflicted_copy_id: None,
                },
            )
            .unwrap();
            create
        };
        // Sent while the withdraw runs, between the drain's read of the queue
        // and its coming to the write held for the create.
        core.delete_item("u").unwrap();
        let dependant = {
            let conn = core.conn().unwrap();
            let mut edit = write(
                WriteKind::UpdateItem,
                "local",
                None,
                Some(0),
                std::slice::from_ref(&create.id),
            );
            edit.payload = r#"{"properties":{"title":"mine"}}"#;
            store::enqueue(&conn, &edit).unwrap()
        };
        let ready = Arc::new(AtomicBool::new(false));
        server.on(
            "/items/u",
            vec![
                Answer::WaitFor {
                    ready: ready.clone(),
                    answer: Box::new(json(200, r#"{"ok":true}"#)),
                },
                certified(refusal(404, "item_not_found")),
            ],
        );
        server.on(
            "/items/local",
            vec![
                certified(refusal(404, "item_not_found")),
                certified(refusal(404, "item_not_found")),
            ],
        );
        // The bin holds `u`, which this device trashed, and not `local`,
        // which the server never held.
        server.on("/items", vec![in_the_bin(&[("u", 1)])]);
        std::thread::scope(|scope| {
            let drained = scope.spawn(|| core.drain());
            server.wait_for("/items/u", 1, Duration::from_secs(5));
            assert!(core.withdraw(&create.id).unwrap());
            ready.store(true, Ordering::Relaxed);
            drained.join().unwrap().unwrap();
        });
        held_in_the_bin(&core, "u", 1);
        let after = store::queued_write(&core.conn().unwrap(), &dependant.id)
            .unwrap()
            .unwrap();
        assert_eq!(
            (after.verdict, after.reason.as_deref()),
            (
                Some(Verdict::Refused),
                Some("the create_item it waits for was withdrawn")
            ),
            "the drain held the write behind a create the queue no longer holds, over its refusal"
        );
    }

    #[test]
    fn a_discard_of_a_create_no_read_can_land_waits_for_a_running_drain() {
        use std::time::Duration;
        let server = crate::scripted::Scripted::start();
        let (_dir, core, create, _) = unfound_landing(&server, false);
        let running = core.one_drain();
        let (sent, received) = std::sync::mpsc::channel();
        std::thread::scope(|scope| {
            scope.spawn(|| sent.send(core.discard(&create.id)).unwrap());
            assert!(
                received.recv_timeout(Duration::from_millis(250)).is_err(),
                "the discard refused writes a running drain had read as waiting"
            );
            assert!(
                store::queued_write(&core.conn().unwrap(), &create.id)
                    .unwrap()
                    .is_some()
            );
            drop(running);
            assert_eq!(
                received.recv_timeout(Duration::from_secs(5)).unwrap(),
                Ok(true)
            );
        });
    }

    #[test]
    fn a_discarded_landing_keeps_a_read_another_write_owes_for_its_row() {
        let server = crate::scripted::Scripted::start();
        let (_dir, core, create, _) = unfound_landing(&server, false);
        {
            let conn = core.conn().unwrap();
            let theirs = store::testing::note("server", "theirs", "", "2026-01-01T00:00:00Z");
            store::upsert_item(&conn, &theirs, None, &Default::default()).unwrap();
        }
        assert!(core.discard(&create.id).unwrap());
        let conn = core.conn().unwrap();
        assert_eq!(
            store::owed_read_backs(&conn)
                .unwrap()
                .into_iter()
                .map(|owed| owed.id)
                .collect::<Vec<_>>(),
            vec!["server".to_string()],
            "a discard dropped a read of a row the copy holds"
        );
    }

    #[test]
    fn a_discarded_landing_reads_its_pinned_row_before_the_pin_goes() {
        let server = crate::scripted::Scripted::start();
        let (_dir, core, create, _) = unfound_landing(&server, true);
        assert!(core.discard(&create.id).unwrap());
        let conn = core.conn().unwrap();
        assert!(!store::item_held(&conn, "local").unwrap());
        assert!(store::pinned(&conn, "local").unwrap());
        assert_eq!(
            store::owed_read_backs(&conn)
                .unwrap()
                .into_iter()
                .map(|owed| owed.id)
                .collect::<Vec<_>>(),
            vec!["local".to_string()],
            "no read will say whether the server holds the pinned row"
        );
    }

    #[test]
    fn natural_key_landing_on_a_row_in_the_bin_keeps_waiting() {
        let server = crate::scripted::Scripted::start();
        let (_dir, core) = deleting(&server, &[]);
        let (create, dependant) = {
            let conn = core.conn().unwrap();
            let local = store::testing::note("local", "draft", "", "2026-01-01T00:00:00Z");
            store::upsert_item(&conn, &local, None, &Default::default()).unwrap();
            let create = store::enqueue(
                &conn,
                &write(WriteKind::CreateItem, "local", None, None, &[]),
            )
            .unwrap();
            let mut tag = write(
                WriteKind::AddTag,
                "local",
                None,
                None,
                std::slice::from_ref(&create.id),
            );
            tag.tag = Some("kept");
            let dependant = store::enqueue(&conn, &tag).unwrap();
            (create, dependant)
        };
        server.on(
            "/items/server",
            vec![crate::scripted::certified(crate::scripted::refusal(
                404,
                "item_not_found",
            ))],
        );
        server.on("/items", vec![in_the_bin(&[("server", 3)])]);
        let answer = Ok(Answer {
            status: 409,
            code: "version_conflict".into(),
            body: "{}".into(),
            retry_after_seconds: None,
            replayed: false,
            contract_named: true,
        });
        let settled = land(
            &core,
            &create,
            &answer,
            Shape::Item,
            "server",
            "version_conflict".into(),
            &mut ViewChange::default(),
        )
        .unwrap();
        assert_eq!(settled.verdict, Some(Verdict::Refused));
        assert!(settled.unavailable.is_none());
        let conn = core.conn().unwrap();
        assert!(
            store::pending_landings(&conn)
                .unwrap()
                .contains_key(&create.id)
        );
        assert_eq!(
            store::queued_write(&conn, &dependant.id).unwrap().unwrap(),
            dependant
        );
        assert!(store::item_held(&conn, "local").unwrap());
        assert!(
            !store::item_held(&conn, "server").unwrap(),
            "a row in the bin is not the row a natural key landed on"
        );
        drop(conn);

        // A later drain reads the target again for the landing alone.
        assert!(
            read_owed_backs(&core, &AtomicBool::new(false), &mut ViewChange::default())
                .unwrap()
                .is_none()
        );
        assert_eq!(server.seen("/items/server").len(), 2);
        assert!(
            server.seen("/items").is_empty(),
            "a waiting landing's target was looked for in the bin"
        );
        let conn = core.conn().unwrap();
        assert!(
            store::pending_landings(&conn)
                .unwrap()
                .contains_key(&create.id)
        );
        assert!(!store::item_held(&conn, "server").unwrap());
        assert_eq!(
            store::owed_read_backs(&conn)
                .unwrap()
                .iter()
                .map(|owed| owed.id.as_str())
                .collect::<Vec<_>>(),
            ["server"]
        );
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
                vec![
                    crate::scripted::Answer::Slow {
                        after: std::time::Duration::from_millis(150),
                        answer: Box::new(crate::scripted::json(200, r#"{"ok":true}"#)),
                    },
                    crate::scripted::certified(crate::scripted::refusal(404, "item_not_found")),
                ],
            );
        }
        server.on("/items", vec![in_the_bin(&[("a", 1), ("b", 1), ("c", 1)])]);
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
            [2, 2, 2],
            "each write needs one original receipt and one fresh read"
        );
        assert_eq!(
            answered.iter().sum::<usize>(),
            3,
            "the drains counted writes another drain had answered: {answered:?}"
        );
        for id in rows {
            held_in_the_bin(&core, id, 1);
        }
    }

    #[test]
    fn a_pass_ends_at_the_first_write_the_server_cannot_take() {
        for (cannot, says) in [
            (crate::scripted::refusal(503, "unavailable"), "503"),
            (crate::scripted::refusal(429, "rate_limited"), "429"),
            (crate::scripted::Answer::Stall, "network"),
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
            if says == "network" {
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
    fn local_renewal_failure_preserves_queued_intent_without_counting() {
        for error in [
            CoreError::SignedOut {
                origin: "https://marfa.example".into(),
            },
            CoreError::NoKeychain("locked".into()),
            CoreError::Invalid("unsafe credential lock".into()),
            CoreError::Decoding("malformed token".into()),
            CoreError::Redirected {
                origin: "https://marfa.example".into(),
                status: 302,
                location: Some("/elsewhere".into()),
            },
            CoreError::Server {
                status: 400,
                code: "invalid_scope".into(),
                message: "refused scope".into(),
                details: None,
            },
            CoreError::Server {
                status: 400,
                code: "invalid_scope".into(),
                message: "refused scope".into(),
                details: Some(Box::new(
                    serde_json::json!({ "required_scope": "items.read" }),
                )),
            },
        ] {
            let server = crate::scripted::Scripted::start();
            let (_dir, core) = deleting(&server, &["first", "later"]);
            server.on(
                "/items/first",
                vec![crate::scripted::refusal(401, "unauthorized")],
            );
            let expected = error.clone();
            core.renew_credential_with(Box::new(move |_| Err(error.clone())));
            let before = core.queue().unwrap();
            let payloads: Vec<_> = before
                .iter()
                .map(|row| store::payload_of(&core.conn().unwrap(), &row.id).unwrap())
                .collect();
            assert_eq!(
                core.drain().unwrap_err(),
                CoreError::RenewalFailed(Box::new(expected))
            );
            let after = core.queue().unwrap();
            assert_eq!(before, after);
            for (row, payload) in after.iter().zip(payloads) {
                assert_eq!(
                    store::payload_of(&core.conn().unwrap(), &row.id).unwrap(),
                    payload
                );
                assert_eq!(row.refusals, 0);
                assert_eq!(row.verdict, None);
            }
            assert!(server.seen("/items/later").is_empty());
        }
    }

    #[test]
    fn renewal_after_an_answer_preserves_progress_and_current_intent() {
        for environmental in [false, true] {
            let server = crate::scripted::Scripted::start();
            let (_dir, core) = deleting(&server, &["prior", "current", "later"]);
            server.on(
                "/items/prior",
                vec![
                    crate::scripted::json(200, r#"{"ok":true}"#),
                    crate::scripted::certified(crate::scripted::refusal(404, "item_not_found")),
                ],
            );
            server.on("/items", vec![in_the_bin(&[("prior", 1)])]);
            server.on(
                "/items/current",
                vec![crate::scripted::refusal(401, "unauthorized")],
            );
            let error = if environmental {
                CoreError::StorageFull("fixture disk full".into())
            } else {
                CoreError::SignedOut {
                    origin: server.url(),
                }
            };
            let expected = error.clone();
            core.renew_credential_with(Box::new(move |_| Err(error.clone())));
            let before = core.queue().unwrap();
            let payloads: Vec<_> = before
                .iter()
                .map(|row| store::payload_of(&core.conn().unwrap(), &row.id).unwrap())
                .collect();
            if environmental {
                let report = core.drain().unwrap();
                assert_eq!((report.answered, report.undelivered), (1, 2));
                assert!(report.unavailable.is_some());
                assert!(report.stopped.is_none());
                assert_eq!(report.verdicts[0].verdict, Some(Verdict::Accepted));
            } else {
                assert_eq!(
                    core.drain().unwrap_err(),
                    CoreError::RenewalFailed(Box::new(expected))
                );
            }
            let after = core.queue().unwrap();
            assert_eq!(after[0].verdict, Some(Verdict::Accepted));
            assert!(after[0].answered_at.is_some());
            held_in_the_bin(&core, "prior", 1);
            assert_eq!(after[1..], before[1..]);
            for (row, payload) in after.iter().zip(payloads).skip(1) {
                assert_eq!(
                    store::payload_of(&core.conn().unwrap(), &row.id).unwrap(),
                    payload
                );
                assert_eq!(row.refusals, 0);
                assert!(row.verdict.is_none());
            }
            assert_eq!(server.seen("/items/current").len(), 1);
            assert!(server.seen("/items/later").is_empty());
        }
    }

    #[test]
    fn rate_limited_renewal_reports_its_wait_without_counting_the_write() {
        for (requested, expected) in [
            (Some(120), Some(120)),
            (Some(86_400), Some(300)),
            (None, None),
        ] {
            let server = crate::scripted::Scripted::start();
            let (_dir, core) = deleting(&server, &["current", "later"]);
            server.on(
                "/items/current",
                vec![crate::scripted::refusal(401, "unauthorized")],
            );
            core.renew_credential_with(Box::new(move |_| {
                Err(CoreError::RateLimited {
                    code: "rate_limited".into(),
                    message: "wait before renewing".into(),
                    retry_after_seconds: requested,
                })
            }));
            let before = core.queue().unwrap();
            let payload = store::payload_of(&core.conn().unwrap(), &before[0].id).unwrap();
            let report = core.drain().unwrap();
            assert_eq!(report.retry_after_seconds, expected);
            assert_eq!((report.answered, report.undelivered), (0, 2));
            assert!(report.unavailable.is_some());
            assert!(report.stopped.is_none());
            assert_eq!(core.queue().unwrap(), before);
            assert_eq!(
                store::payload_of(&core.conn().unwrap(), &before[0].id).unwrap(),
                payload
            );
            assert!(
                report
                    .verdicts
                    .iter()
                    .all(|row| row.verdict.is_none() && row.refusals == 0)
            );
            assert!(server.seen("/items/later").is_empty());
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
    #[test]
    fn stop_during_instance_confirmation_sends_nothing() {
        use crate::scripted::*;
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::time::Duration;
        let server = Scripted::start();
        server.on(
            "/",
            vec![Answer::Slow {
                after: Duration::from_millis(400),
                answer: Box::new(root(INSTANCE)),
            }],
        );
        server.on(
            "/items/a",
            vec![
                json(200, r#"{"ok":true}"#),
                certified(refusal(404, "item_not_found")),
            ],
        );
        let (_dir, core) = deleting(&server, &["a"]);
        let stop = AtomicBool::new(false);
        std::thread::scope(|scope| {
            let call = scope.spawn(|| core.drain_until(&stop));
            server.wait_for("/", 1, Duration::from_secs(5));
            assert!(server.seen("/items/a").is_empty());
            stop.store(true, Ordering::Relaxed);
            let result = call.join().unwrap();
            assert!(
                server.seen("/items/a").is_empty(),
                "sent after stop: {:?}; result: {result:?}",
                server.seen("/items/a")
            );
            assert_eq!(result.unwrap_err(), CoreError::Canceled);
        });
    }

    #[test]
    fn stopped_drain_does_not_wait_for_another_drain() {
        use std::sync::atomic::AtomicBool;
        use std::time::Duration;
        let core = Core::open_in_memory(None).unwrap();
        let held = core.one_drain();
        let stop = AtomicBool::new(true);
        let (sent, received) = std::sync::mpsc::channel();
        let immediate = std::thread::scope(|scope| {
            scope.spawn(|| sent.send(core.drain_until(&stop)).unwrap());
            let immediate = received.recv_timeout(Duration::from_millis(250));
            drop(held);
            immediate
        });
        assert!(
            immediate.is_ok(),
            "already-stopped call waited for other drain: {immediate:?}"
        );
        assert_eq!(immediate.unwrap().unwrap_err(), CoreError::Canceled);
    }

    fn report(answered: usize, held: usize) -> DrainReport {
        DrainReport {
            answered,
            held,
            undelivered: 0,
            unsent: 0,
            unmade: 0,
            unavailable: None,
            verdicts: Vec::new(),
            stopped: None,
            unclaimed_sources: Vec::new(),
            retry_after_seconds: None,
        }
    }

    #[test]
    fn a_later_pass_adds_what_it_sent_and_leaves_what_it_left() {
        let mut first = report(3, 1);
        first.unclaimed_sources = vec!["a".into()];
        first.retry_after_seconds = Some(5);
        let mut later = report(2, 0);
        later.unclaimed_sources = vec!["a".into(), "b".into()];
        later.unavailable = Some("the server did not answer".into());
        later.undelivered = 4;
        first.absorb(later);
        assert_eq!(first.answered, 5);
        assert_eq!(first.held, 0, "what waits is what the later pass left");
        assert_eq!(first.undelivered, 4);
        assert_eq!(
            first.unavailable.as_deref(),
            Some("the server did not answer")
        );
        assert_eq!(first.unclaimed_sources, ["a", "b"]);
        assert_eq!(first.retry_after_seconds, Some(5));
    }
}
