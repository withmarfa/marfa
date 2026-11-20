//! Where a write goes: its door, whether it is ready to send, and the upload that carries a file's bytes.

use std::collections::{HashMap, HashSet};
use std::fs::File;

use crate::error::CoreError;
use crate::http::{Answer, Call, CallBody, Http, Method, Outgoing};
use crate::model::{BlockedReason, QueuedWrite, Verdict, WriteKind};
use crate::store;
use crate::wire::WireErrorEnvelope;
use crate::{Core, Result};

/// Only some doors answer with an item: tags and extensions answer
/// the sidecar they changed, a delete answers `{"ok": true}`, an edge the
/// edge, an upload the hash, and a row write each operation's outcome.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) enum Shape {
    Item,
    Edge,
    Plain,
    Blob,
    Rows,
}

pub(super) enum Door<'a> {
    Json(Outgoing<'a>, Shape),
    Upload { hash: &'a str, mime_type: String },
}

/// An `Outgoing` that owns its text, for a request sent from another thread.
pub(super) struct Owned {
    method: Method,
    segments: Vec<String>,
    params: Vec<(String, String)>,
    body: String,
    idempotency_key: String,
}

impl Owned {
    pub(super) fn of(outgoing: &Outgoing<'_>) -> Owned {
        Owned {
            method: outgoing.method,
            segments: outgoing.segments.clone(),
            params: outgoing.params.clone(),
            body: outgoing.body.to_string(),
            idempotency_key: outgoing.idempotency_key.to_string(),
        }
    }

    /// Names `version`, so the server refuses the write `version_conflict`
    /// where its subject has moved on: in the body of a create, and in the
    /// query of a tag or lifecycle door.
    pub(super) fn at_version(mut self, kind: WriteKind, version: Option<i64>) -> Result<Owned> {
        let Some(version) = version else {
            return Ok(self);
        };
        if kind == WriteKind::CreateItem {
            let mut body: serde_json::Value = serde_json::from_str(&self.body)?;
            if let Some(body) = body.as_object_mut() {
                body.entry("version").or_insert(version.into());
            }
            self.body = body.to_string();
        } else {
            self.params.push(("version".into(), version.to_string()));
        }
        Ok(self)
    }

    pub(super) fn outgoing(&self) -> Outgoing<'_> {
        Outgoing {
            method: self.method,
            segments: self.segments.clone(),
            params: self.params.clone(),
            body: &self.body,
            idempotency_key: &self.idempotency_key,
        }
    }
}

pub(super) enum Sendable<'a> {
    Json(Outgoing<'a>, Shape),
    Upload { bytes: File, mime_type: String },
}

pub(super) enum Readiness {
    Ready,
    Held,
    RefusedWith(String),
}

/// Whether the write waits on something the copy has yet to learn: an edge
/// a create was shown with, whose id the copy made and no edge the server
/// holds carries (`device/edge-write-waits-projected`), or table rows set
/// aside to compare (`device/restored-rows-held`).
pub(super) fn held_back(conn: &rusqlite::Connection, row: &QueuedWrite) -> Result<bool> {
    Ok(super::create_edges::waits(conn, row)? || crate::restored_rows::holds_back(conn, row)?)
}

pub(super) fn readiness(
    row: &QueuedWrite,
    rows: &HashMap<&str, &QueuedWrite>,
    verdicts: &HashMap<String, Option<Verdict>>,
    waiting: &HashSet<String>,
    landing: &HashMap<String, String>,
    held_back: bool,
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
    // Rows a restore lost go back before the row writes behind them
    // (`device/restored-rows-first`).
    if row.kind.rows()
        && row.follows.as_deref().is_some_and(|ahead| {
            verdicts.get(ahead) == Some(&Some(Verdict::Blocked))
                && rows.get(ahead).is_some_and(|ahead| {
                    ahead.blocked_reason() == Some(BlockedReason::ServerRestored)
                })
        })
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
    if held_back {
        return Readiness::Held;
    }
    if row.kind == WriteKind::DeleteItem && row.base_version.is_none_or(|version| version <= 0) {
        return Readiness::RefusedWith("the delete has no confirmed server version to remove; read the item before deleting it".into());
    }
    Readiness::Ready
}

pub(super) fn address<'a>(row: &'a QueuedWrite, payload: &'a str) -> Result<Door<'a>> {
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
    let table = || -> Result<&str> {
        row.table.as_deref().ok_or_else(|| {
            CoreError::Store(format!(
                "the queued {} names no table, so there is nowhere to send it",
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
        WriteKind::ReplaceTags => to(
            Method::Put,
            vec!["items".into(), item_id()?.into(), "tags".into()],
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
        WriteKind::WriteRows => to(
            Method::Post,
            vec![
                "items".into(),
                item_id()?.into(),
                "tables".into(),
                table()?.into(),
                "rows".into(),
            ],
            Shape::Rows,
        ),
        WriteKind::UndoRows => {
            let batch = row
                .body
                .get("batch")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| {
                    CoreError::Store(format!("the queued undo {} names no batch", row.id))
                })?;
            Ok(Door::Json(
                Outgoing {
                    method: Method::Post,
                    segments: vec![
                        "items".into(),
                        item_id()?.into(),
                        "tables".into(),
                        table()?.into(),
                        "batches".into(),
                        batch.into(),
                        "undo".into(),
                    ],
                    params: Vec::new(),
                    body: "{}",
                    idempotency_key: &row.idempotency_key,
                },
                Shape::Rows,
            ))
        }
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
pub(super) fn send_uploads_as(core: &Core, http: &Http) -> Result<()> {
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
pub(crate) fn ends_the_drain(error: &CoreError) -> bool {
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
pub(super) fn upload(
    http: &Http,
    bytes: File,
    mime_type: &str,
) -> std::result::Result<Answer, CoreError> {
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
        request_id: reply.request_id,
    };
    if answer.instance_changed() {
        return Err(answer.instance_changed_error());
    }
    Ok(answer)
}
