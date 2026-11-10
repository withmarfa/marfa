//! `Idempotency-Key`: the claim commits before the write and completes with it.

mod expiry;

use std::sync::{Arc, Mutex, PoisonError};

use rusqlite::{OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::App;
use super::access::{Caller, Level, Permission};
use super::catalog::Snapshot;
use super::connectors::{ReadOnly, read_only};
use super::refusal::{Code, Refusal, Result};
use super::unit::Unit;
use super::{edges, items};
use crate::app::clock::Stamp;
use crate::db::Write;

pub use expiry::{UNREAD, expire};

pub const MAX_KEY_CHARACTERS: usize = 255;
const LEASE_MS: i64 = 60_000;
const MAX_KEPT_BYTES: usize = 1_048_576;
const CONTENT_TYPE: &str = "application/json";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "need", rename_all = "snake_case")]
pub enum Need {
    Reach,
    Purge,
    ItemRef {
        id: String,
    },
    Item {
        id: String,
        type_id: String,
        write: bool,
    },
    Type {
        name: String,
        write: bool,
    },
    Extension {
        namespace: String,
        write: bool,
    },
    Source {
        name: String,
        disclosed: bool,
    },
    Edge {
        name: String,
        write: bool,
    },
    CascadeTarget {
        name: String,
    },
    EdgeSource {
        id: String,
        type_id: String,
    },
    BlockingEnd {
        id: String,
        type_id: String,
    },
}

impl Need {
    /// Asked in this order, so that a repeat that may no longer read an item
    /// hears only that, before anything that would name its source.
    fn rank(&self) -> u8 {
        match self {
            Need::Reach | Need::Purge => 0,
            Need::ItemRef { .. } | Need::EdgeSource { .. } => 1,
            Need::Item { .. } | Need::BlockingEnd { .. } => 2,
            Need::Type { .. } => 3,
            Need::Extension { .. } => 4,
            Need::Edge { .. } | Need::CascadeTarget { .. } => 5,
            Need::Source { .. } => 6,
        }
    }
}

/// Outlives a rolled-back attempt, so its needs are known when the refusal is kept.
#[derive(Clone, Debug)]
pub struct Claim {
    credential: String,
    key: String,
    created_at: String,
    needs: Arc<Mutex<Vec<Need>>>,
}

impl Claim {
    pub fn note(&self, need: Need) {
        let mut needs = self.needs.lock().unwrap_or_else(PoisonError::into_inner);
        if !needs.contains(&need) {
            needs.push(need);
        }
    }

    pub fn attempt(&self) -> String {
        format!("{}\0{}", self.credential, self.key)
    }

    fn requirements(&self) -> Result<String> {
        let needs = self.needs.lock().unwrap_or_else(PoisonError::into_inner);
        serde_json::to_string(&*needs)
            .map_err(|_| Refusal::internal("a request's requirements did not print"))
    }
}

#[derive(Debug)]
pub struct Kept {
    pub status: u16,
    pub content_type: String,
    pub body: Vec<u8>,
}

#[derive(Debug)]
pub enum Entry {
    Fresh(Claim),
    Replay(Kept),
}

/// The credential is not part of it: the record is already its own.
pub fn fingerprint(
    contract: u32,
    method: &str,
    path: &str,
    query: &str,
    json: bool,
    body: &[u8],
) -> String {
    let mut digest = Sha256::new();
    let head = format!(
        "{contract}\n{method}\n{path}\n{query}\n{}\n",
        if json { "json" } else { "other" }
    );
    digest.update(head.as_bytes());
    digest.update(body);
    hex::encode(digest.finalize())
}

struct Held {
    fingerprint: String,
    state: String,
    created_at: String,
    status: Option<u16>,
    content_type: Option<String>,
    body: Option<Vec<u8>>,
    requirements: String,
}

fn held(tx: &Transaction<'_>, credential: &str, key: &str) -> Result<Option<Held>> {
    Ok(tx
        .query_row(
            "SELECT fingerprint, state, created_at, response_status, response_content_type, \
             response_body, requirements FROM idempotency_records \
             WHERE credential = ?1 AND idempotency_key = ?2",
            [credential, key],
            |row| {
                Ok(Held {
                    fingerprint: row.get(0)?,
                    state: row.get(1)?,
                    created_at: row.get(2)?,
                    status: row.get(3)?,
                    content_type: row.get(4)?,
                    body: row.get(5)?,
                    requirements: row.get(6)?,
                })
            },
        )
        .optional()?)
}

fn elapsed_ms(from: &str, to: &str) -> Result<i64> {
    Ok(Stamp::read(to)?.ms() - Stamp::read(from)?.ms())
}

pub async fn enter(app: &App, caller: &Caller, key: &str, fingerprint: String) -> Result<Entry> {
    let credential = caller.credential_handle();
    let clock = app.clock.clone();
    let (who, named) = (credential.clone(), key.to_string());
    let taken = app
        .db
        .write(Write::own(), move |tx| {
            let at = clock.stamp();
            let Some(record) = held(tx, &who, &named)? else {
                tx.execute(
                    "INSERT INTO idempotency_records (credential, idempotency_key, fingerprint, \
                     state, created_at) VALUES (?1, ?2, ?3, 'in_flight', ?4)",
                    params![who, named, fingerprint, at],
                )?;
                return Ok(Err(at));
            };
            if record.fingerprint != fingerprint {
                return Err(Refusal::new(
                    Code::IdempotencyKeyReused,
                    format!(
                        "Idempotency-Key \"{named}\" was already used for a different request, \
                         or under another contract version"
                    ),
                ));
            }
            if record.state == "complete" {
                return Ok(Ok(record));
            }
            if elapsed_ms(&record.created_at, &at)? < LEASE_MS {
                return Err(Refusal::new(
                    Code::IdempotencyKeyInFlight,
                    format!(
                        "A request carrying Idempotency-Key \"{named}\" is still being processed"
                    ),
                ));
            }
            tx.execute(
                "UPDATE idempotency_records SET created_at = ?3 \
                 WHERE credential = ?1 AND idempotency_key = ?2 AND created_at = ?4",
                params![who, named, at, record.created_at],
            )?;
            Ok(Err(at))
        })
        .await?;
    match taken {
        Err(created_at) => Ok(Entry::Fresh(Claim {
            credential,
            key: key.to_string(),
            created_at,
            needs: Arc::default(),
        })),
        Ok(record) => replay(app, caller, key, record).await.map(Entry::Replay),
    }
}

async fn replay(app: &App, caller: &Caller, key: &str, record: Held) -> Result<Kept> {
    let needs: Vec<Need> = serde_json::from_str(&record.requirements)
        .map_err(|_| Refusal::internal("a kept answer's requirements do not read"))?;
    let status = record
        .status
        .ok_or_else(|| Refusal::internal("a kept answer has no status"))?;
    let key = key.to_string();
    let caller = caller.clone();
    let clock = app.clock.clone();
    let marked = app.read_only_handle();
    app.db
        .read(move |tx| {
            let at = clock.stamp();
            let caller = caller.current(tx, &at)?;
            authorize(tx, &caller, needs)?;
            let Some(body) = record.body else {
                return Err(Refusal::new(
                    Code::IdempotencyResultNotRetained,
                    format!(
                        "The response to Idempotency-Key \"{key}\" was too large to retain, so \
                         it cannot be replayed. The original request was not repeated."
                    ),
                )
                .with_detail("original_status", status));
            };
            Ok(Kept {
                status,
                content_type: record
                    .content_type
                    .unwrap_or_else(|| CONTENT_TYPE.to_string()),
                body: with_current_read_only(
                    &read_only::current(&marked, tx, &at, Snapshot::Committed)?,
                    status,
                    body,
                )?,
            })
        })
        .await
}

fn may_not_read() -> Refusal {
    Refusal::new(Code::ItemNotFound, "Item not found")
}

fn edge_gone() -> Refusal {
    Refusal::new(Code::EdgeNotFound, "Edge not found")
}

fn authorize(tx: &Transaction<'_>, caller: &Caller, mut needs: Vec<Need>) -> Result<()> {
    needs.sort_by_key(Need::rank);
    for need in needs {
        match need {
            Need::Reach => caller.require_reach()?,
            Need::Purge => caller.require(Permission::ItemsPurge)?,
            Need::ItemRef { id } => {
                let readable =
                    items::type_of(tx, &id)?.is_some_and(|type_id| caller.may_read_type(&type_id));
                if !readable {
                    return Err(may_not_read());
                }
            }
            Need::Item { id, type_id, write } => {
                let current = items::type_of(tx, &id)?;
                let types = std::iter::once(&type_id).chain(current.iter());
                if !types.clone().all(|held| caller.may_read_type(held)) {
                    return Err(may_not_read());
                }
                if write {
                    for held in types {
                        caller.require_type(held, Level::Write)?;
                    }
                }
            }
            Need::EdgeSource { id, type_id } => {
                let current = edges::source_type(tx, &id)?;
                let types = std::iter::once(&type_id).chain(current.iter());
                if !types.clone().all(|held| caller.may_read_type(held)) {
                    return Err(edge_gone());
                }
                for held in types {
                    caller.require_type(held, Level::Write)?;
                }
            }
            Need::BlockingEnd { id, type_id } => {
                let current = items::type_of(tx, &id)?;
                let types = std::iter::once(&type_id).chain(current.iter());
                if !types.clone().all(|held| caller.may_read_type(held)) {
                    return Err(edge_gone());
                }
            }
            Need::Type { name, write } => {
                let level = if write { Level::Write } else { Level::Read };
                caller.require_type(&name, level)?;
            }
            Need::Extension { namespace, write } => {
                let level = if write { Level::Write } else { Level::Read };
                caller.require_extension(&namespace, level)?;
            }
            Need::Edge { name, write: true } => caller.require_edge(&name, Level::Write)?,
            Need::Edge { name, write: false } => {
                if caller.require_edge(&name, Level::Read).is_err() {
                    return Err(edge_gone());
                }
            }
            Need::CascadeTarget { name } => caller.require_cascade_target(&name)?,
            Need::Source { name, disclosed } => {
                if caller.may_grant(&name) {
                    continue;
                }
                let refusal = if disclosed {
                    Refusal::new(
                        Code::Forbidden,
                        format!("This credential may not write under the source \"{name}\"."),
                    )
                    .with_detail("source", name)
                } else {
                    Refusal::new(
                        Code::Forbidden,
                        "This credential may not write under the required source.",
                    )
                };
                return Err(refusal);
            }
        }
    }
    Ok(())
}

/// A kept answer's `read_only` is the one thing judged at replay.
fn with_current_read_only(read_only: &ReadOnly, status: u16, body: Vec<u8>) -> Result<Vec<u8>> {
    if !(200..300).contains(&status) {
        return Ok(body);
    }
    let Ok(Value::Object(answer)) = serde_json::from_slice::<Value>(&body) else {
        return Ok(body);
    };
    let Some(item) = answer.get("item") else {
        return Ok(body);
    };
    let text = |name: &str| item.get(name).and_then(Value::as_str).unwrap_or_default();
    let now = read_only.of(text("source"), text("type"))?;
    Ok(read_only_set(body, now))
}

/// Sets the first `read_only`, which is the item's: its own fields come before
/// its properties, and a quote cannot stand bare inside a JSON string.
fn read_only_set(body: Vec<u8>, now: bool) -> Vec<u8> {
    let (from, to): (&[u8], &[u8]) = if now {
        (b"\"read_only\":false", b"\"read_only\":true")
    } else {
        (b"\"read_only\":true", b"\"read_only\":false")
    };
    let first_any = body
        .windows(b"\"read_only\":".len())
        .position(|window| window == b"\"read_only\":");
    match first_any {
        Some(at) if body[at..].starts_with(from) => {
            let mut changed = Vec::with_capacity(body.len() + 1);
            changed.extend_from_slice(&body[..at]);
            changed.extend_from_slice(to);
            changed.extend_from_slice(&body[at + from.len()..]);
            changed
        }
        _ => body,
    }
}

fn disclosures(tx: &Transaction<'_>, claim: &Claim, body: &[u8]) -> Result<()> {
    if let Ok(answer) = serde_json::from_slice::<Value>(body) {
        visit(tx, claim, &answer)?;
    }
    Ok(())
}

fn visit(tx: &Transaction<'_>, claim: &Claim, value: &Value) -> Result<()> {
    let row = match value {
        Value::Array(entries) => {
            for entry in entries {
                visit(tx, claim, entry)?;
            }
            return Ok(());
        }
        Value::Object(row) => row,
        _ => return Ok(()),
    };
    if let (Some(id), Some(type_id), true) = (
        row.get("id").and_then(Value::as_str),
        row.get("type").and_then(Value::as_str),
        row.contains_key("properties"),
    ) {
        claim.note(Need::Item {
            id: id.to_string(),
            type_id: type_id.to_string(),
            write: false,
        });
    }
    if let (Some(name), true, true) = (
        row.get("edge_type").and_then(Value::as_str),
        row.contains_key("source_id"),
        row.contains_key("target_id"),
    ) {
        claim.note(Need::Edge {
            name: name.to_string(),
            write: false,
        });
    }
    for (field, child) in row {
        match (field.as_str(), child) {
            ("properties", _) => continue,
            ("source", Value::String(source)) => disclose_source(claim, source),
            ("extensions", Value::Object(held)) => {
                for namespace in held.keys() {
                    claim.note(Need::Extension {
                        namespace: namespace.clone(),
                        write: false,
                    });
                }
                continue;
            }
            ("trashed_with", Value::String(with)) => {
                let marked = row.get("id").and_then(Value::as_str).unwrap_or_default();
                claim.note(match items::mark_type(tx, marked)? {
                    Some(type_id) => Need::Item {
                        id: with.clone(),
                        type_id,
                        write: false,
                    },
                    None => Need::ItemRef { id: with.clone() },
                });
            }
            ("item_id" | "existing_id", Value::String(id)) => {
                claim.note(match items::type_of(tx, id)? {
                    Some(type_id) => Need::Item {
                        id: id.clone(),
                        type_id,
                        write: false,
                    },
                    None => Need::ItemRef { id: id.clone() },
                });
            }
            _ => {}
        }
        visit(tx, claim, child)?;
    }
    Ok(())
}

fn disclose_source(claim: &Claim, source: &str) {
    let mut needs = claim.needs.lock().unwrap_or_else(PoisonError::into_inner);
    for need in needs.iter_mut() {
        if let Need::Source { name, disclosed } = need
            && name == source
        {
            *disclosed = true;
        }
    }
}

fn record(
    tx: &Transaction<'_>,
    claim: &Claim,
    at: &str,
    status: u16,
    body: &[u8],
) -> Result<usize> {
    disclosures(tx, claim, body)?;
    let kept = (body.len() <= MAX_KEPT_BYTES).then_some(body);
    Ok(tx.execute(
        "UPDATE idempotency_records SET state = 'complete', completed_at = ?4, \
         response_status = ?5, response_content_type = ?6, response_body = ?7, requirements = ?8 \
         WHERE credential = ?1 AND idempotency_key = ?2 AND created_at = ?3 \
         AND state = 'in_flight'",
        params![
            claim.credential,
            claim.key,
            claim.created_at,
            at,
            status,
            CONTENT_TYPE,
            kept,
            claim.requirements()?
        ],
    )?)
}

/// A claim taken over after its lease ran out refuses the write, so it cannot land twice.
pub fn complete(unit: &Unit<'_, '_>, claim: &Claim, status: u16, body: &[u8]) -> Result<()> {
    if record(unit.tx(), claim, &unit.at, status, body)? == 0 {
        return Err(Refusal::new(
            Code::IdempotencyKeyInFlight,
            format!(
                "A request carrying Idempotency-Key \"{}\" is still being processed",
                claim.key
            ),
        ));
    }
    Ok(())
}

/// Keeps the refusal unless the same request may be taken later: one that concerns the
/// credential or the server, or a file whose bytes its writer has yet to upload.
pub async fn settle(app: &App, claim: Claim, code: Code, body: Vec<u8>) {
    let clock = app.clock.clone();
    let status = code.status();
    let keeps = !(status >= 500 || status == 401 || status == 403 || code == Code::BlobNotFound);
    let settled = app
        .db
        .write(Write::own(), move |tx| {
            if keeps {
                record(tx, &claim, &clock.stamp(), status, &body)?;
            } else {
                release_in(tx, &claim)?;
            }
            Ok(())
        })
        .await;
    if let Err(refusal) = settled {
        tracing::warn!(%refusal, "a refused request's claim was left to its lease");
    }
}

pub async fn release(app: &App, claim: Claim) {
    let released = app
        .db
        .write(Write::own(), move |tx| release_in(tx, &claim))
        .await;
    if let Err(refusal) = released {
        tracing::warn!(%refusal, "an abandoned claim was left to its lease");
    }
}

/// Matches only a claim still in flight, so releasing is safe when a commit's outcome is unknown.
fn release_in(tx: &Transaction<'_>, claim: &Claim) -> Result<()> {
    tx.execute(
        "DELETE FROM idempotency_records WHERE credential = ?1 AND idempotency_key = ?2 \
         AND created_at = ?3 AND state = 'in_flight'",
        params![claim.credential, claim.key, claim.created_at],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sets_the_items_own_read_only_and_leaves_a_propertys() {
        let body = br#"{"item":{"id":"a","read_only":false,"properties":{"read_only":false}}}"#;
        let changed = read_only_set(body.to_vec(), true);
        assert_eq!(
            changed,
            br#"{"item":{"id":"a","read_only":true,"properties":{"read_only":false}}}"#
        );
        assert_eq!(read_only_set(changed.clone(), true), changed);
    }
}
