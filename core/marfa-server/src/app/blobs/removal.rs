//! Removing one store's copy of a blob: what a preview shows, the removal, and the copy's state
//! after it.

use std::collections::HashSet;
use std::sync::Arc;

use futures_util::future::join_all;
use serde_json::json;

use super::rows::{self, Held};
use super::store::{Answer, Store};
use super::{Hash, below, copy_not_found, keep_held, not_found, owned, own_others, unavailable};
use crate::app::App;
use crate::app::access::{Caller, Permission};
use crate::app::fingerprint::Fingerprint;
use crate::app::mcp::guard::{Guard, Halt};
use crate::app::refusal::Result;
use crate::app::stored;
use crate::settings::registry::BLOB_MIN_COPIES;

pub const DROPPED: &str = "blob.copy_dropped";

/// What became of the bytes of a copy that was removed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Bytes {
    /// The server wrote them and has deleted them.
    Deleted,
    /// The server wrote them, and their deletion waits for a later run.
    Queued,
    /// The server did not write them, so they stay in the store.
    Kept,
}

/// What a removal did.
#[derive(Debug, PartialEq, Eq)]
pub enum Dropped {
    Removed(Bytes),
    Halted(Halt),
}

/// A copy as a preview of a removal shows it.
#[derive(Clone, Debug)]
pub struct Shown {
    pub store_id: String,
    pub kind: String,
    pub written: bool,
    pub recorded_at: String,
    pub verified_at: Option<String>,
}

/// What removing a copy would do, as read now.
#[derive(Debug)]
pub struct Removal {
    pub size_bytes: u64,
    pub copy: Shown,
    pub others: Vec<Shown>,
    pub min_copies: u64,
    pub digest: String,
}

/// A copy's state after a removal, as read now.
#[derive(Debug)]
pub struct Now {
    /// The store records a copy of the blob again.
    pub recorded: bool,
    /// A deletion of the removed copy's bytes waits.
    pub waiting: bool,
    pub attached: bool,
}

/// The copy a removal names, as what it removes: the object and whether the server wrote it.
pub fn digest(hash: &Hash, copy: &Held) -> String {
    let mut fingerprint = Fingerprint::new("file copy");
    fingerprint
        .text(hash.as_str())
        .text(&copy.store_id)
        .text(&copy.object)
        .flag(copy.written);
    fingerprint.finish()
}

/// The target a removal's confirmation is signed for: the blob and the store.
pub fn target(hash: &Hash, store_id: &str) -> String {
    crate::app::mcp::confirm::ids_digest(&[format!("copy {} {store_id}", hash.as_str())])
}

fn shown(held: &Held, copies: &[rows::CopyRecord]) -> Option<Shown> {
    let record = copies.iter().find(|copy| copy.store_id == held.store_id)?;
    Some(Shown {
        store_id: held.store_id.clone(),
        kind: record.kind.clone(),
        written: held.written,
        recorded_at: record.recorded_at.clone(),
        verified_at: record.verified_at.clone(),
    })
}

impl App {
    /// What removing `store_id`'s copy of `hash` would do, refused as the removal would be.
    pub async fn copy_removal(
        &self,
        caller: &Caller,
        hash: &Hash,
        store_id: &str,
    ) -> Result<Removal> {
        caller.require(Permission::BlobsManage)?;
        if self.blobs.gate.unfinished(hash) {
            return Err(unavailable());
        }
        let (caller, hash, store_id) = (caller.clone(), hash.clone(), store_id.to_string());
        let (seeds, at) = (self.settings.seeds(), self.clock.stamp());
        self.db
            .read(move |tx| {
                caller.current(tx, &at)?.require(Permission::BlobsManage)?;
                let Some(found) = rows::find(tx, &hash)? else {
                    return Err(not_found());
                };
                let holders = rows::holders(tx, &hash)?;
                let copies = rows::copies(tx, &hash)?;
                let held = holders
                    .iter()
                    .find(|held| held.store_id == store_id)
                    .ok_or_else(copy_not_found)?;
                keep_held(tx, &hash, &store_id)?;
                let min_copies = stored::deciding(tx, &seeds, BLOB_MIN_COPIES)?;
                let kept = own_others(&holders, &store_id);
                if (kept as u64) < min_copies {
                    return Err(below(kept + 1, min_copies));
                }
                Ok(Removal {
                    size_bytes: found.size_bytes,
                    copy: shown(held, &copies).ok_or_else(copy_not_found)?,
                    others: holders
                        .iter()
                        .filter(|other| other.store_id != store_id)
                        .filter_map(|other| shown(other, &copies))
                        .collect(),
                    min_copies,
                    digest: digest(&hash, held),
                })
            })
            .await
    }

    /// Judges a removal's confirmation against the copy as it stands, before any store is asked.
    pub async fn peek_removal(
        &self,
        guard: &Guard,
        hash: &Hash,
        store_id: &str,
    ) -> Result<Option<Halt>> {
        let (guard, hash, store_id) = (guard.clone(), hash.clone(), store_id.to_string());
        let now = self.clock.instant();
        self.db
            .read(move |tx| {
                let holders = rows::holders(tx, &hash)?;
                let copy = holders.iter().find(|held| held.store_id == store_id);
                let digest = copy.map(|copy| digest(&hash, copy));
                guard.peek_at(tx, now, digest.as_deref())
            })
            .await
    }

    /// Whether the store records a copy of `hash` now, and whether a deletion of one waits.
    pub async fn copy_now(&self, hash: &Hash, store_id: &str) -> Result<Now> {
        let (hash, store_id) = (hash.clone(), store_id.to_string());
        self.db
            .read(move |tx| {
                let recorded = rows::holders(tx, &hash)?
                    .iter()
                    .any(|held| held.store_id == store_id);
                let waiting = rows::deletion(tx, &hash, &store_id)?
                    .iter()
                    .any(|(_, recorded)| !recorded);
                let attached = rows::stores(tx)?
                    .iter()
                    .any(|store| store.id == store_id && store.detached_at.is_none());
                Ok(Now {
                    recorded,
                    waiting,
                    attached,
                })
            })
            .await
    }

    /// Queues deletion with the copy's removal before deleting its bytes. With a guard, the
    /// removing write holds the copy to the one its preview showed and spends the confirmation.
    pub async fn drop_copy(
        self: &Arc<App>,
        caller: &Caller,
        hash: &Hash,
        store_id: &str,
        guard: Option<Guard>,
    ) -> Result<Dropped> {
        let (app, caller, hash) = (self.clone(), caller.clone(), hash.clone());
        let store_id = store_id.to_string();
        owned(async move { app.dropping(&caller, &hash, &store_id, guard).await }).await
    }

    async fn dropping(
        &self,
        caller: &Caller,
        hash: &Hash,
        store_id: &str,
        guard: Option<Guard>,
    ) -> Result<Dropped> {
        let blob = hash.clone();
        let (found, holders) = self
            .db
            .read(move |tx| Ok((rows::find(tx, &blob)?, rows::holders(tx, &blob)?)))
            .await?;
        let Some(found) = found else {
            return Err(not_found());
        };
        if self.blobs.gate.unfinished(hash) {
            return Err(unavailable());
        }
        let store = self
            .blobs
            .store(store_id)
            .filter(|_| holders.iter().any(|held| held.store_id == store_id))
            .ok_or_else(copy_not_found)?;
        if matches!(store, Store::S3(_) | Store::Folder(_)) {
            crate::app::backups::survey_folder(self).await?;
        }
        let (blob, kept_in) = (hash.clone(), store_id.to_string());
        self.db
            .read(move |tx| keep_held(tx, &blob, &kept_in))
            .await?;
        let seeds = self.settings.seeds();
        let min_copies = self
            .db
            .read(move |tx| stored::deciding(tx, &seeds, BLOB_MIN_COPIES))
            .await?;
        let kept = own_others(&holders, store_id);
        if (kept as u64) < min_copies {
            return Err(below(kept + 1, min_copies));
        }
        let _held = self.lock_to_write(hash).await?;
        if self.blobs.gate.unfinished(hash) {
            return Err(unavailable());
        }
        let blob = hash.clone();
        let holders = self.db.read(move |tx| rows::holders(tx, &blob)).await?;
        if !holders.iter().any(|held| held.store_id == store_id) {
            return Err(copy_not_found());
        }
        let others: Vec<(Store, &Held)> = holders
            .iter()
            .filter(|held| held.store_id != store_id && held.written)
            .filter_map(|held| Some((self.blobs.store(&held.store_id)?, held)))
            .collect();
        let answers = join_all(
            others
                .iter()
                .map(|(other, held)| self.blobs.answer_of(other, &found.hash, &held.object)),
        )
        .await;
        let mut proved = HashSet::new();
        for ((other, held), answer) in others.iter().zip(&answers) {
            if matches!(answer, Ok(Answer::Holds(size)) if *size == found.size_bytes)
                && self.blobs.is_itself(other).await
            {
                proved.insert((held.store_id.clone(), held.object.clone()));
            }
        }
        if (proved.len() as u64) < min_copies {
            return Err(below(proved.len() + 1, min_copies));
        }
        let (blob, dropped) = (hash.clone(), store_id.to_string());
        let seeds = self.settings.seeds();
        let removed = self
            .write(caller, DROPPED, move |unit| {
                unit.caller.require(Permission::BlobsManage)?;
                let holders = rows::holders(unit.tx(), &blob)?;
                let copy = holders.iter().find(|held| held.store_id == dropped);
                if let Some(guard) = &guard {
                    let digest = copy.map(|copy| digest(&blob, copy));
                    if let Some(halt) = guard.check(unit, digest.as_deref())? {
                        return Ok(Err(halt));
                    }
                }
                let copy = copy.ok_or_else(copy_not_found)?;
                keep_held(unit.tx(), &blob, &dropped)?;
                let min_copies = stored::deciding(unit.tx(), &seeds, BLOB_MIN_COPIES)?;
                let kept = own_others(&holders, &dropped);
                if (kept as u64) < min_copies {
                    return Err(below(kept + 1, min_copies));
                }
                // A store detached, or a copy rewritten, since its proof no longer counts.
                let still = holders
                    .iter()
                    .filter(|held| held.store_id != dropped && held.written)
                    .filter(|held| proved.contains(&(held.store_id.clone(), held.object.clone())))
                    .count();
                if (still as u64) < min_copies {
                    return Err(below(still + 1, min_copies));
                }
                rows::remove_copy(unit.tx(), &blob, &dropped, &copy.object, &unit.at)?;
                unit.audit("blob", blob.as_str(), Some(json!({ "store_id": dropped })))?;
                if let Some(guard) = &guard {
                    guard.spend(unit, i64::from(copy.written))?;
                }
                Ok(Ok(copy.written))
            })
            .await?;
        let written = match removed {
            Ok(written) => written,
            Err(halt) => return Ok(Dropped::Halted(halt)),
        };
        if !written {
            return Ok(Dropped::Removed(Bytes::Kept));
        }
        Ok(Dropped::Removed(
            match self.finish_deletion(&store, hash).await {
                Ok(()) => Bytes::Deleted,
                Err(failure) => {
                    tracing::warn!(?failure, "A dropped copy's bytes wait for a later run");
                    Bytes::Queued
                }
            },
        ))
    }
}
