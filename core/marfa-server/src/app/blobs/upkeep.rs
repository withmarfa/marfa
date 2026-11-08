//! The jobs that keep every attached store whole: `blob-replicate` makes the copies a store
//! lacks, `blob-integrity` checks the copies and finishes queued deletions, and
//! `blob-orphans` reports and purges what nothing references.

use std::collections::{BTreeSet, HashSet};
use std::io;
use std::sync::Arc;

use serde_json::json;

use super::store::{self, Failed, Store};
use super::{App, Hash, room, rows};
use crate::app::access::Caller;
use crate::app::faults::{FAIL_BLOB_READ, HOLD_BLOB_PURGE, HOLD_BLOB_READ, Lie};
use crate::app::housekeeping::{Report, Run};
use crate::app::refusal::Result;
use crate::db::Write;
use crate::settings::registry::{
    BLOB_CLEANUP_GRACE_MS, BLOB_CLEANUP_INTERVAL_MS, BLOB_INTEGRITY_BATCH,
    BLOB_INTEGRITY_BATCH_BYTES, BLOB_REPLICATE_BATCH, BLOB_REPLICATE_BATCH_BYTES,
    DISK_RESERVE_BYTES,
};

/// The most leftover deletions of purged blobs one sweep retries.
const LEFTOVERS: u64 = 500;

pub fn sweeps(app: &App) -> bool {
    app.settings.live().get(BLOB_CLEANUP_INTERVAL_MS) > 0
}

impl App {
    /// Finishes queued deletions of the blob's bytes in `store` under the blob's lock, unless a
    /// store is still carrying out a write or a deletion of them.
    async fn retry_deletion(&self, store: &Store, hash: &Hash) -> std::result::Result<(), Failed> {
        if self.blobs.gate.unfinished(hash) {
            return Err(Failed::Late);
        }
        let _held = self.blobs.gate.lock(hash).await;
        if self.blobs.gate.unfinished(hash) {
            return Err(Failed::Late);
        }
        self.finish_deletion(store, hash).await
    }

    /// Retries queued deletions, the fewest tried first, and asks nothing more of a store
    /// that leaves one unfinished.
    async fn retry_deletions(
        &self,
        run: &Run,
        limit: u64,
        unregistered_only: bool,
        unreachable: &mut BTreeSet<String>,
    ) -> Result<()> {
        let queued = self
            .db
            .read(move |tx| rows::pending_deletions(tx, limit, unregistered_only))
            .await?;
        for (hash, store_id) in queued {
            if !run.go_on().await {
                break;
            }
            if unreachable.contains(&store_id) || self.blobs.gate.unfinished(&hash) {
                continue;
            }
            let Some(store) = self.blobs.store(&store_id) else {
                continue;
            };
            match self.retry_deletion(&store, &hash).await {
                Ok(()) => {}
                Err(Failed::Late) => {
                    unreachable.insert(store_id);
                }
                Err(Failed::Io(error)) => {
                    tracing::warn!(%error, store = store.kind(), "A queued blob deletion failed");
                }
            }
        }
        Ok(())
    }
}

enum Copy {
    Made { from: String },
    Skipped,
    TargetSilent,
}

/// Places one blob in `target`, read from the first other store that holds it and answers.
async fn copy_to(
    app: &App,
    target: &Store,
    holders: &[String],
    blob: &super::Blob,
    unreachable: &mut BTreeSet<String>,
) -> Copy {
    let blobs = &app.blobs;
    for source in blobs.attached() {
        let id = source.id().to_string();
        if id == target.id() || unreachable.contains(&id) || !holders.contains(&id) {
            continue;
        }
        let bytes = match blobs
            .open_bytes(&source, &blob.hash, 0, blob.size_bytes)
            .await
        {
            Ok(bytes) => bytes,
            Err(Failed::Late) => {
                unreachable.insert(id);
                continue;
            }
            Err(Failed::Io(error)) => {
                tracing::warn!(%error, store = source.kind(), "A store did not open a blob to copy");
                continue;
            }
        };
        let bytes = store::idle_limited(bytes, blobs.check());
        let (hash, size, mime_type) = (blob.hash.clone(), blob.size_bytes, blob.mime_type.clone());
        let written = match target {
            Store::Disk(disk) => {
                let reserve = app.settings.live().get(DISK_RESERVE_BYTES);
                if let Err(refused) = room(&app.faults, disk.root(), reserve, size) {
                    tracing::warn!(error = %refused, "The disk has no room for a blob's copy");
                    return Copy::Skipped;
                }
                let (disk, faults) = (disk.clone(), app.faults.clone());
                blobs
                    .writing(&blob.hash, size, async move {
                        let name = hash.clone();
                        store::place_on_disk(disk, hash, size, bytes).await?;
                        faults.heal(name.as_str(), true);
                        Ok(())
                    })
                    .await
            }
            Store::S3(s3) => {
                let s3 = s3.clone();
                let limit = store::stall_limit(store::write_deadline(blobs.check(), size));
                blobs
                    .writing(&blob.hash, size, async move {
                        store::within(limit, s3.write(&hash, &mime_type, size, bytes)).await
                    })
                    .await
            }
        };
        return match written {
            Ok(()) => Copy::Made { from: id },
            Err(Failed::Late) => Copy::TargetSilent,
            Err(Failed::Io(error)) => {
                tracing::warn!(%error, store = target.kind(), "A blob's copy was not written");
                if error.kind() == io::ErrorKind::InvalidData {
                    continue;
                }
                Copy::Skipped
            }
        };
    }
    Copy::Skipped
}

/// Gives every attached store a copy of every blob, within the run's bounds: the copies that
/// failed in the fewest runs first, then the oldest blob first, so a blob that cannot be copied
/// never holds back the others.
pub async fn replicate(app: Arc<App>, run: Run) -> Result<Report> {
    let live = app.settings.live();
    let (batch, batch_bytes) = (
        live.get(BLOB_REPLICATE_BATCH),
        live.get(BLOB_REPLICATE_BATCH_BYTES),
    );
    if app.blobs.attached().len() < 2 {
        return Ok(Report {
            result: json!({ "copied": 0, "bytes": 0, "remaining": 0 }),
            again: false,
        });
    }
    let missing = app.db.read(move |tx| rows::missing(tx, batch)).await?;
    let mut unreachable = BTreeSet::new();
    let (mut copied, mut bytes) = (0u64, 0u64);
    for pair in missing {
        if !run.go_on().await {
            break;
        }
        let size = pair.blob.size_bytes;
        if copied > 0 && bytes.saturating_add(size) > batch_bytes {
            break;
        }
        let hash = pair.blob.hash.clone();
        let Some(target) = app.blobs.store(&pair.store_id) else {
            continue;
        };
        if unreachable.contains(&pair.store_id) || app.blobs.gate.unfinished(&hash) {
            continue;
        }
        let _held = app.blobs.gate.lock(&hash).await;
        if app.blobs.gate.unfinished(&hash) {
            continue;
        }
        let blob = hash.clone();
        let holders = app.db.read(move |tx| rows::holders(tx, &blob)).await?;
        if holders.contains(&pair.store_id) {
            continue;
        }
        let cleared = match app.finish_deletion(&target, &hash).await {
            Ok(()) => true,
            Err(Failed::Late) => {
                unreachable.insert(pair.store_id.clone());
                false
            }
            Err(Failed::Io(error)) => {
                tracing::warn!(%error, "A queued deletion in a store to copy to failed");
                false
            }
        };
        let made = if cleared {
            copy_to(&app, &target, &holders, &pair.blob, &mut unreachable).await
        } else {
            Copy::Skipped
        };
        let from = match made {
            Copy::Made { from } => from,
            Copy::Skipped | Copy::TargetSilent => {
                if matches!(made, Copy::TargetSilent) {
                    unreachable.insert(pair.store_id.clone());
                }
                let (blob, to) = (hash.clone(), pair.store_id.clone());
                app.db
                    .write(Write::own(), move |tx| rows::copy_failed(tx, &blob, &to))
                    .await?;
                continue;
            }
        };
        let (blob, to) = (hash.clone(), pair.store_id.clone());
        let recorded = app
            .write(&Caller::Server, "blob.copy_replicated", move |unit| {
                if rows::record_copy(unit.tx(), &blob, &to, &unit.at)? {
                    unit.audit(
                        "blob",
                        blob.as_str(),
                        Some(json!({ "from": from, "store_id": to })),
                    )?;
                    return Ok(true);
                }
                rows::queue_deletion(unit.tx(), &blob, &to, &unit.at)?;
                Ok(false)
            })
            .await?;
        if !recorded {
            if let Err(failure) = app.finish_deletion(&target, &hash).await {
                tracing::warn!(?failure, "The copy of a purged blob waits for a later run");
            }
            continue;
        }
        copied += 1;
        bytes = bytes.saturating_add(size);
    }
    let remaining = app.db.read(rows::missing_count).await?;
    Ok(Report {
        result: json!({ "copied": copied, "bytes": bytes, "remaining": remaining }),
        again: copied > 0 && remaining > 0,
    })
}

enum Checked {
    Intact,
    Damaged,
    Silent,
}

/// Reads a disk copy through, or asks the object store its size. Only a store that answers
/// can show a copy missing or altered.
async fn check(app: &App, store: &Store, copy: &rows::ToCheck) -> Checked {
    let blobs = &app.blobs;
    match store {
        Store::Disk(disk) => {
            let (faults, disk, hash) = (app.faults.clone(), disk.clone(), copy.hash.clone());
            let read = async move {
                faults.hold(HOLD_BLOB_READ, None).await;
                if faults.fail(FAIL_BLOB_READ, None) {
                    return Err(io::Error::other("the store failed the read"));
                }
                let lie = faults.lie(hash.as_str());
                match lie {
                    Some(Lie::Lost) => return Ok(None),
                    Some(Lie::Unreadable) => return Err(store::unreadable()),
                    Some(Lie::Damaged) | None => {}
                }
                let changed = lie == Some(Lie::Damaged);
                tokio::task::spawn_blocking(move || disk.rehash(&hash, changed))
                    .await
                    .map_err(io::Error::other)?
            };
            let deadline = store::write_deadline(blobs.check(), copy.size);
            match tokio::time::timeout(deadline, read).await {
                Ok(Ok(Some((size, hash)))) if size == copy.size && hash == copy.hash => {
                    Checked::Intact
                }
                Ok(Ok(_)) => Checked::Damaged,
                Ok(Err(error)) => {
                    tracing::warn!(%error, "The disk store did not read a copy");
                    Checked::Silent
                }
                Err(_) => Checked::Silent,
            }
        }
        Store::S3(_) => match blobs.size_of(store, &copy.hash).await {
            Ok(Some(size)) if size == copy.size => Checked::Intact,
            Ok(_) => Checked::Damaged,
            Err(failure) => {
                tracing::warn!(?failure, "The object store did not answer for a copy");
                Checked::Silent
            }
        },
    }
}

/// Finishes queued deletions, then checks the copies never checked and the least recently
/// checked, striking each one found missing or altered.
pub async fn integrity(app: Arc<App>, run: Run) -> Result<Report> {
    let live = app.settings.live();
    let (batch, batch_bytes) = (
        live.get(BLOB_INTEGRITY_BATCH),
        live.get(BLOB_INTEGRITY_BATCH_BYTES),
    );
    let mut unreachable = BTreeSet::new();
    app.retry_deletions(&run, batch, false, &mut unreachable)
        .await?;
    let (mut verified, mut struck, mut bytes, mut checked) = (0u64, 0u64, 0u64, 0u64);
    let mut seen = HashSet::new();
    let mut itself = HashSet::new();
    'run: loop {
        let left_out: Vec<String> = unreachable.iter().cloned().collect();
        let limit = batch.saturating_add(seen.len() as u64);
        let copies = app
            .db
            .read(move |tx| rows::to_check(tx, &left_out, limit))
            .await?;
        let before = unreachable.len();
        let mut any = false;
        for copy in copies {
            if !seen.insert((copy.hash.clone(), copy.store_id.clone())) {
                continue;
            }
            any = true;
            if checked >= batch || !run.go_on().await {
                break 'run;
            }
            if checked > 0 && bytes.saturating_add(copy.size) > batch_bytes {
                break 'run;
            }
            let Some(store) = app.blobs.store(&copy.store_id) else {
                continue;
            };
            if app.blobs.gate.unfinished(&copy.hash) {
                continue;
            }
            let _held = app.blobs.gate.lock(&copy.hash).await;
            if app.blobs.gate.unfinished(&copy.hash) {
                continue;
            }
            let mut checked_now = check(&app, &store, &copy).await;
            if matches!(checked_now, Checked::Damaged)
                && !app.blobs.is_itself(&store, &mut itself).await
            {
                checked_now = Checked::Silent;
            }
            match checked_now {
                Checked::Silent => {
                    unreachable.insert(copy.store_id.clone());
                    break;
                }
                Checked::Intact => {
                    let (hash, id) = (copy.hash.clone(), copy.store_id.clone());
                    let at = app.clock.stamp();
                    app.db
                        .write(Write::own(), move |tx| rows::verified(tx, &hash, &id, &at))
                        .await?;
                    verified += 1;
                }
                Checked::Damaged => {
                    let (hash, id, kind) = (copy.hash.clone(), copy.store_id.clone(), store.kind());
                    let removed = app
                        .write(&Caller::Server, "blob.copy_struck", move |unit| {
                            let removed = rows::remove_copy(unit.tx(), &hash, &id, &unit.at)?;
                            if removed {
                                unit.audit(
                                    "blob",
                                    hash.as_str(),
                                    Some(json!({ "store_id": id, "kind": kind })),
                                )?;
                            }
                            Ok(removed)
                        })
                        .await?;
                    if removed {
                        struck += 1;
                    }
                    if let Err(failure) = app.finish_deletion(&store, &copy.hash).await {
                        tracing::warn!(?failure, "A struck copy's bytes wait for a later run");
                        if matches!(failure, Failed::Late) {
                            unreachable.insert(copy.store_id.clone());
                        }
                    }
                }
            }
            checked += 1;
            bytes = bytes.saturating_add(copy.size);
            if unreachable.len() > before {
                break;
            }
        }
        if unreachable.len() == before || !any {
            break;
        }
    }
    Ok(Report::done(json!({
        "verified": verified,
        "struck": struck,
        "bytes": bytes,
        "unreachable": unreachable.len(),
    })))
}

/// Finishes the deletions a purge left, reports every blob nothing references, and purges
/// each one an earlier run reported at least the grace ago that nothing names at the moment
/// it is purged.
pub async fn orphans(app: Arc<App>, run: Run) -> Result<Report> {
    let mut unreachable = BTreeSet::new();
    app.retry_deletions(&run, LEFTOVERS, true, &mut unreachable)
        .await?;
    let grace = i64::try_from(app.settings.live().get(BLOB_CLEANUP_GRACE_MS)).unwrap_or(i64::MAX);
    let cutoff = app.clock.stamp_ago(grace);
    let at = app.clock.stamp();
    let chosen = cutoff.clone();
    let candidates = app
        .db
        .write(Write::own(), move |tx| {
            // Chosen before this run reports, so only an earlier run's report is purged.
            let candidates = rows::purge_candidates(tx, &chosen)?;
            rows::report_orphans(tx, &at)?;
            Ok(candidates)
        })
        .await?;
    let mut purged = 0u64;
    if !candidates.is_empty() && run.go_on().await {
        // The scan of every stored row runs outside the writer. A write after it that names a
        // candidate adds its reference in its own transaction, which takes the candidate off
        // the report, so the check below inside the writer still sees it.
        let hexes: HashSet<String> = candidates
            .iter()
            .map(|hash| hash.hex().to_string())
            .collect();
        let named = app.db.read(move |tx| rows::named(tx, &hexes)).await?;
        app.faults.hold(HOLD_BLOB_PURGE, None).await;
        let stores: Vec<String> = app
            .blobs
            .attached()
            .iter()
            .map(|store| store.id().to_string())
            .collect();
        let gone = app
            .write(&Caller::Server, "blob.purge", move |unit| {
                let tx = unit.tx();
                let still: HashSet<Hash> =
                    rows::purge_candidates(tx, &cutoff)?.into_iter().collect();
                let chosen: Vec<Hash> = candidates
                    .into_iter()
                    .filter(|hash| still.contains(hash))
                    .collect();
                let mut gone = Vec::new();
                for hash in chosen {
                    if named.contains(hash.hex()) {
                        rows::unreport(tx, &hash)?;
                        continue;
                    }
                    rows::purge(tx, &hash, &stores, &unit.at)?;
                    unit.audit("blob", hash.as_str(), Some(json!({})))?;
                    gone.push(hash);
                }
                Ok(gone)
            })
            .await;
        let gone = match gone {
            Ok(gone) => gone,
            Err(refused) => {
                tracing::error!(error = %refused, "An orphan purge did not commit; it is tried again");
                Vec::new()
            }
        };
        for hash in gone {
            let mut whole = true;
            for store in app.blobs.attached() {
                if let Err(failure) = app.retry_deletion(&store, &hash).await {
                    tracing::warn!(?failure, "A purged blob's bytes wait for a later run");
                    whole = false;
                }
            }
            if whole {
                purged += 1;
            }
        }
    }
    let reported = app.db.read(rows::report_size).await?;
    Ok(Report::done(
        json!({ "reported": reported, "purged": purged }),
    ))
}
