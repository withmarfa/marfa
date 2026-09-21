//! Sending what the queue holds, and recording what came back.
//!
//! One pass per call. A drain attempts each sendable row once and returns;
//! "retries without limit" (`queue-and-verdicts.md` 17) is across drains, not
//! inside one. A drain that spun on a row until the network came back would
//! be a call with no bound on it, and the two behaviors are indistinguishable
//! to a caller who runs the drain again.

use std::collections::HashMap;

use serde::Serialize;

use crate::catalog::Catalog;
use crate::error::CoreError;
use crate::http::{Answer, Http, Method, Outgoing};
use crate::model::QueuedWrite;
use crate::store;
use crate::wire::{WireEdgeAnswer, WireWriteAnswer};
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
    pub kind: String,
    pub item_id: Option<String>,
    /// One of the six, or absent where the write was sent and not answered —
    /// which is the absence of a verdict rather than a seventh
    /// (`queue-and-verdicts.md` 6).
    pub verdict: Option<String>,
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
    /// This write stops, under one of the five reasons (21, 22, 23).
    Block(&'static str),
    /// Every write stops and the drain ends (20).
    BlockQueue(&'static str),
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
        (401, _) => Classified::BlockQueue("credential_refused"),
        // The key has been answered for a different body, so it is the key
        // that is spent rather than the write (21).
        (422, "idempotency_key_reused") => Classified::Block("key_spent"),
        // The snapshot the write names is gone, and settling means rebasing
        // on the version the server holds — a new write, not this one (22).
        (409, "ancestor_unavailable") => Classified::Block("ancestor_unavailable"),
        // A server that did not resolve a write that asked it to. A device
        // cannot resolve it itself (`device.md` 21) and re-sending is the
        // same request (23).
        (409, "version_conflict") => Classified::Block("conflict_unresolved"),
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
}

/// Which shape a kind's door answers with.
///
/// A kind is matched by name, so the compiler cannot make this exhaustive
/// over `store::WRITE_KINDS` and a default arm is unavoidable. A kind added
/// to the set and not named here answers `None`, which the drain reads as a
/// door this build does not know — and a write the server took would come
/// back as a failure with nothing saying so. What keeps that from happening
/// quietly is a test rather than the compiler:
/// `the_shape_of_every_write_kind_is_decided` below.
fn shape_of(kind: &str) -> Option<Shape> {
    Some(match kind {
        "create_item" | "update_item" | "restore_item" | "transition_item" => Shape::Item,
        "create_edge" | "update_edge" => Shape::Edge,
        "delete_item" | "delete_edge" | "replace_metadata" | "merge_metadata" | "add_tag"
        | "remove_tag" | "write_extension" | "delete_extension" => Shape::Plain,
        _ => return None,
    })
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
    verdicts: &HashMap<String, Option<String>>,
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
        match verdict.as_deref() {
            Some("accepted") | Some("merged") | Some("conflicted") => {}
            Some(terminal @ ("refused" | "dead")) => {
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

/// Where a queued write goes and what it carries.
///
/// Every kind in `store::WRITE_KINDS` either addresses here or names itself
/// in the refusal. No kind falls through to a default: a write sent to the
/// wrong door is a write the server takes and the device reads as something
/// else.
fn address<'a>(row: &'a QueuedWrite, payload: &'a str) -> Result<Outgoing<'a>> {
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
    let item = |segments: Vec<String>, method: Method| -> Result<Outgoing<'a>> {
        Ok(Outgoing {
            method,
            segments,
            params: Vec::new(),
            body: payload,
            idempotency_key: &row.idempotency_key,
        })
    };
    match row.kind.as_str() {
        "create_item" => Ok(Outgoing {
            method: Method::Post,
            segments: vec!["items".into()],
            params: Vec::new(),
            body: payload,
            idempotency_key: &row.idempotency_key,
        }),
        "update_item" => Ok(Outgoing {
            method: Method::Patch,
            segments: vec!["items".into(), item_id()?.into()],
            // On every update this device sends (`queue-and-verdicts.md` 5).
            // The device resolves nothing itself; this asks the server to
            // resolve inside its own transaction rather than refusing and
            // leaving two writes where one is atomic.
            params: vec![("conflict".into(), "auto".into())],
            body: payload,
            idempotency_key: &row.idempotency_key,
        }),
        "delete_item" => item(vec!["items".into(), item_id()?.into()], Method::Delete),
        "restore_item" => item(
            vec!["items".into(), item_id()?.into(), "restore".into()],
            Method::Post,
        ),
        "transition_item" => item(
            vec!["items".into(), item_id()?.into(), "transition".into()],
            Method::Post,
        ),
        "create_edge" => item(vec!["edges".into()], Method::Post),
        "update_edge" => item(vec!["edges".into(), edge_id()?.into()], Method::Patch),
        "delete_edge" => item(vec!["edges".into(), edge_id()?.into()], Method::Delete),
        "replace_metadata" => item(
            vec!["items".into(), item_id()?.into(), "metadata".into()],
            Method::Put,
        ),
        "merge_metadata" => item(
            vec!["items".into(), item_id()?.into(), "metadata".into()],
            Method::Patch,
        ),
        "add_tag" => item(
            vec!["items".into(), item_id()?.into(), "tags".into()],
            Method::Post,
        ),
        "remove_tag" => item(
            vec![
                "items".into(),
                item_id()?.into(),
                "tags".into(),
                tag()?.into(),
            ],
            Method::Delete,
        ),
        "write_extension" => item(
            vec![
                "items".into(),
                item_id()?.into(),
                "extensions".into(),
                namespace()?.into(),
            ],
            Method::Put,
        ),
        "delete_extension" => item(
            vec![
                "items".into(),
                item_id()?.into(),
                "extensions".into(),
                namespace()?.into(),
            ],
            Method::Delete,
        ),
        // `upload_blob` alone. It is a kind the queue holds
        // (`queue-and-verdicts.md` 32) and its door arrives with blob work,
        // which is outside this milestone: a device may hold the write and
        // cannot yet send it.
        other => Err(CoreError::Invalid(format!(
            "this build has no door for a queued {other}; it is a kind the queue holds and the drain cannot yet send"
        ))),
    }
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
    let mut answers: HashMap<String, Option<String>> = all
        .iter()
        .map(|row| (row.id.clone(), row.verdict.clone()))
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
                        verdict: "blocked",
                        reason: Some("awaiting_dependency"),
                        answer: None,
                        conflicted_copy_id: None,
                    },
                )?;
                answers.insert(row.id.clone(), Some("blocked".into()));
                report.held += 1;
                continue;
            }
            Readiness::RefusedWith(reason) => {
                let conn = core.conn()?;
                store::record_verdict(
                    &conn,
                    &row.id,
                    &store::Answered {
                        verdict: "refused",
                        reason: Some(&reason),
                        answer: None,
                        conflicted_copy_id: None,
                    },
                )?;
                drop(conn);
                answers.insert(row.id.clone(), Some("refused".into()));
                // Reconciled like any other refusal: the server never took
                // the write, so the copy must not go on holding it.
                reconcile(core, row);
                report.verdicts.push(verdict_of(
                    row,
                    &Settled::plain(Some("refused"), Some(reason), row.refusals),
                ));
                continue;
            }
            Readiness::Ready => {}
        }

        let payload = {
            let conn = core.conn()?;
            store::payload_of(&conn, &row.id)?
        };
        let outgoing = address(row, &payload)?;
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
        let answer = http.send(&outgoing);
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

        let settled = settle(core, row, &answer, classify(&answer))?;
        answers.insert(row.id.clone(), settled.verdict.clone());
        let stop = settled.stops_the_drain;
        report.verdicts.push(verdict_of(row, &settled));
        if stop {
            let conn = core.conn()?;
            let parked = store::block_unanswered(&conn, "credential_refused")?;
            report.stopped = Some(format!(
                "the server refused the credential, so every queued write is blocked and the drain stopped; {parked} row(s) parked"
            ));
            break;
        }
    }

    Ok(report)
}

fn verdict_of(row: &QueuedWrite, settled: &Settled) -> DrainVerdict {
    DrainVerdict {
        id: row.id.clone(),
        kind: row.kind.clone(),
        item_id: row.item_id.clone(),
        verdict: settled.verdict.clone(),
        reason: settled.reason.clone(),
        conflicted_copy_id: settled.conflicted_copy_id.clone(),
        refusals: settled.refusals,
        replayed: settled.replayed,
        merged_fields: settled.merged_fields.clone(),
    }
}

struct Settled {
    verdict: Option<String>,
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
    fn plain(verdict: Option<&str>, reason: Option<String>, refusals: i64) -> Settled {
        Settled {
            verdict: verdict.map(str::to_string),
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
            let Some(shape) = shape_of(&row.kind) else {
                // A kind whose door this build does not know. Counted rather
                // than accepted: the device cannot say what the server took.
                let conn = core.conn()?;
                let refusals = store::count_refusal(&conn, &row.id)?;
                drop(conn);
                return finish_counted(core, row, refusals, envelope);
            };
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
                            None => ("accepted", None, Vec::new()),
                            Some(resolution) => match &resolution.conflicted_copy_id {
                                None => ("merged", None, resolution.fields.clone()),
                                Some(sibling) => (
                                    "conflicted",
                                    Some(sibling.clone()),
                                    resolution.fields.clone(),
                                ),
                            },
                        };
                    let mut conn = core.conn()?;
                    let catalog = Catalog::load(&conn)?;
                    let title_field = catalog.title_field(&parsed.item.r#type);
                    let tags = parsed
                        .metadata
                        .as_ref()
                        .map(|metadata| metadata.tags.clone());
                    let tx = conn.transaction()?;
                    // The row the server returned, whole, including the
                    // version and the fields it stamps (9, 10, 11). The
                    // local row was minted at version 0 and this replaces it.
                    store::upsert_item(&tx, &parsed.item, tags.as_deref(), title_field)?;
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
                    tx.commit()?;
                    Ok(Settled {
                        verdict: Some(verdict.into()),
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
                            verdict: "accepted",
                            reason: None,
                            answer: envelope.as_deref(),
                            conflicted_copy_id: None,
                        },
                    )?;
                    tx.commit()?;
                    Ok(Settled {
                        replayed: replayed_header,
                        ..Settled::plain(Some("accepted"), None, row.refusals)
                    })
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
                            verdict: "accepted",
                            reason: None,
                            answer: envelope.as_deref(),
                            conflicted_copy_id: None,
                        },
                    )?;
                    Ok(Settled {
                        replayed: replayed_header,
                        ..Settled::plain(Some("accepted"), None, row.refusals)
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
                        verdict: "refused",
                        // The server's code verbatim (12). Not translated: a
                        // device reports what it was told.
                        reason: Some(&code),
                        answer: envelope.as_deref(),
                        conflicted_copy_id: None,
                    },
                )?;
            }
            reconcile(core, row);
            Ok(Settled::plain(Some("refused"), Some(code), row.refusals))
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
                    verdict: "blocked",
                    reason: Some(reason),
                    answer: envelope.as_deref(),
                    conflicted_copy_id: None,
                },
            )?;
            Ok(Settled {
                stops_the_drain: matches!(class, Classified::BlockQueue(_)),
                ..Settled::plain(Some("blocked"), Some(reason.into()), row.refusals)
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
            verdict: "dead",
            reason: None,
            answer: envelope.as_deref(),
            conflicted_copy_id: None,
        },
    )?;
    Ok(Settled::plain(Some("dead"), None, refusals))
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
        row.kind.as_str(),
        "create_edge" | "update_edge" | "delete_edge"
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
                if !page.has_more {
                    break;
                }
                match page.cursor {
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
                    // `has_more` with no cursor to follow it: the server is
                    // saying there is more and not saying where. Stopping
                    // here would read as "no such edge" and delete a live
                    // one, so the read fails instead.
                    None => {
                        return Err(CoreError::Invalid(format!(
                            "the server reported more edges for {source} but gave no cursor to \
                             read them, so whether it still holds {edge_id} cannot be answered"
                        )));
                    }
                }
            }
        }
        let conn = core.conn()?;
        match found {
            Some(edge) => store::upsert_edge(&conn, &edge)?,
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
            let title_field = catalog.title_field(&held.item.r#type);
            let tx = conn.transaction()?;
            store::upsert_item(&tx, &held.item, Some(&held.metadata.tags), title_field)?;
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

    /// The kinds in `store::WRITE_KINDS` with no door yet. `address` refuses
    /// one before a body can be read, so the drain never asks `shape_of`
    /// about it — and the test below needs that written down to tell a kind
    /// nobody has built a door for from one somebody forgot.
    const NO_DOOR_YET: &[&str] = &["upload_blob"];

    /// Every kind the queue accepts either has a shape or is declared as
    /// having no door.
    ///
    /// The compiler cannot say this: `shape_of` matches a name, so it needs
    /// a default arm, and a kind added to `WRITE_KINDS` and not named there
    /// falls into it in silence. What that costs is a door whose success the
    /// device cannot read: the server does the work, the drain counts a
    /// refusal, and the write dies on the fifth pass with nothing said.
    #[test]
    fn the_shape_of_every_write_kind_is_decided() {
        let undecided: Vec<&str> = crate::store::WRITE_KINDS
            .iter()
            .copied()
            .filter(|kind| shape_of(kind).is_none() && !NO_DOOR_YET.contains(kind))
            .collect();
        assert!(
            undecided.is_empty(),
            "{undecided:?} can be queued and the drain cannot read what the \
             server answers them with, so a write the server took comes back \
             as a refusal and the fifth one kills it"
        );
        let unreachable: Vec<&str> = NO_DOOR_YET
            .iter()
            .copied()
            .filter(|kind| !crate::store::WRITE_KINDS.contains(kind))
            .collect();
        assert!(
            unreachable.is_empty(),
            "{unreachable:?} is excused from having a shape and is not a kind \
             anything can queue, so the excuse is about nothing"
        );
    }
}
