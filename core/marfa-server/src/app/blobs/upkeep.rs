//! Jobs that keep every attached store whole: replicate, integrity and orphans.

use std::collections::{BTreeSet, HashSet};
use std::io;
use std::sync::Arc;

use serde_json::json;

use super::rows::Held;
use super::s3::S3;
use super::store::{self, Answer, Failed, Store};
use super::{App, Hash, room_on, rows};
use crate::app::access::Caller;
use crate::app::clock::Stamp;
use crate::app::faults::{FAIL_BLOB_READ, HOLD_BLOB_PURGE, HOLD_BLOB_READ, Lie, Volume};
use crate::app::housekeeping::{Report, Run};
use crate::app::refusal::Result;
use crate::app::stored;
use crate::db::Write;
use crate::settings::registry::{
    BLOB_CLEANUP_ENABLED, BLOB_CLEANUP_GRACE_SECONDS, DISK_RESERVE_BYTES,
};

/// The most leftover deletions of purged blobs one sweep retries.
const LEFTOVERS: u64 = 500;

pub fn sweeps(app: &App) -> bool {
    app.settings.live().get(BLOB_CLEANUP_ENABLED)
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
        let mut tried = HashSet::new();
        for (hash, store_id) in queued {
            if !run.go_on().await {
                break;
            }
            if unreachable.contains(&store_id) || self.blobs.gate.unfinished(&hash) {
                continue;
            }
            if !tried.insert((hash.clone(), store_id.clone())) {
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
    Made {
        from: String,
        object: String,
    },
    /// Why no copy was made, where a store said.
    Skipped(Option<String>),
    /// Every store that records a copy answered, and none gave bytes that hash to the blob.
    Unreadable,
    TargetSilent,
}

/// Places one blob in `target` from the first holder that answers, `target`'s held copy included.
/// An object store's copy goes to a new object, queued for deletion until it is recorded.
async fn copy_to(
    app: &App,
    target: &Store,
    holders: &[Held],
    blob: &super::Blob,
    unreachable: &mut BTreeSet<String>,
) -> Result<Copy> {
    let blobs = &app.blobs;
    let mut unanswered: Option<String> = None;
    for source in blobs.attached() {
        let id = source.id().to_string();
        let Some(held) = holders.iter().find(|held| held.store_id == id) else {
            continue;
        };
        if unreachable.contains(&id) {
            unanswered.get_or_insert_with(|| "a store that holds it did not answer".to_string());
            continue;
        }
        let bytes = match blobs
            .open_bytes(&source, &blob.hash, &held.object, 0, blob.size_bytes)
            .await
        {
            Ok(bytes) => bytes,
            Err(Failed::Late) => {
                unreachable.insert(id);
                unanswered
                    .get_or_insert_with(|| "a store that holds it did not answer".to_string());
                continue;
            }
            Err(Failed::Io(error)) => {
                tracing::warn!(%error, store = source.kind(), "A store did not open a blob to copy");
                // A failed read says nothing of the bytes the store holds.
                if error.kind() != io::ErrorKind::NotFound {
                    unanswered.get_or_insert_with(|| error.to_string());
                }
                continue;
            }
        };
        let mut bytes = store::idle_limited(bytes, blobs.check());
        let (hash, size, mime_type) = (blob.hash.clone(), blob.size_bytes, blob.mime_type.clone());
        let (written, object) = match target {
            Store::Disk(disk) | Store::Folder(disk) => {
                let reserve = app.settings.live().get(DISK_RESERVE_BYTES);
                let volume = match target {
                    Store::Folder(_) => Volume::Backups,
                    _ => Volume::Blobs,
                };
                if let Err(refused) = room_on(&app.faults, volume, disk.root(), reserve, size) {
                    tracing::warn!(error = %refused, store = target.kind(), "A store has no room for a blob's copy");
                    return Ok(Copy::Skipped(Some(refused.message.to_string())));
                }
                if matches!(target, Store::Folder(_)) {
                    bytes = super::folder::filling(bytes, app.faults.clone());
                }
                let healed = matches!(target, Store::Disk(_));
                let (disk, faults) = (disk.clone(), app.faults.clone());
                let written = blobs
                    .writing(&blob.hash, size, async move {
                        let name = hash.clone();
                        store::place_on_disk(disk, hash, size, bytes).await?;
                        if healed {
                            faults.heal(name.as_str(), true);
                        }
                        Ok(())
                    })
                    .await;
                (written, String::new())
            }
            Store::S3(s3) => {
                let object = S3::new_key(&hash);
                let (queued, at, to) = (hash.clone(), app.clock.stamp(), s3.id().to_string());
                let named = object.clone();
                app.db
                    .write(Write::own(), move |tx| {
                        rows::queue_deletion(tx, &queued, &to, &named, &at)
                    })
                    .await?;
                let (s3, named) = (s3.clone(), object.clone());
                let limit = store::stall_limit(store::write_deadline(blobs.check(), size));
                let written = blobs
                    .writing(&blob.hash, size, async move {
                        s3.write(&named, &hash, &mime_type, size, bytes, limit)
                            .await
                    })
                    .await;
                (written, object)
            }
        };
        return Ok(match written {
            Ok(()) => Copy::Made { from: id, object },
            Err(Failed::Late) => Copy::TargetSilent,
            Err(Failed::Io(error)) => {
                tracing::warn!(%error, store = target.kind(), "A blob's copy was not written");
                if error.kind() == io::ErrorKind::InvalidData {
                    continue;
                }
                Copy::Skipped(Some(error.to_string()))
            }
        });
    }
    Ok(match unanswered {
        Some(why) => Copy::Skipped(Some(why)),
        None => Copy::Unreadable,
    })
}

/// Confirmation needs both the object's writer and the bucket's marker.
async fn written_by_target(app: &App, target: &Store, blob: &super::Blob, object: &str) -> bool {
    if matches!(target, Store::Disk(_) | Store::Folder(_)) {
        return true;
    }
    match app.blobs.answer_of(target, &blob.hash, object).await {
        Ok(Answer::Holds(size)) if size == blob.size_bytes => app.blobs.is_itself(target).await,
        answer => {
            tracing::warn!(
                ?answer,
                "The object store did not answer for the copy it took"
            );
            false
        }
    }
}

/// What one blob's replication to one store came to.
pub enum Replicated {
    Copied,
    /// The store already held a written copy, or the blob is busy with other work.
    Passed,
    /// No copy was made, for the reason given where a store said.
    Failed(Option<String>),
    /// No store could give bytes that hash to the blob.
    Unreadable,
}

/// Copies one blob to `target` under its lock, recording the copy, unless `target` holds one.
pub async fn replicate_one(
    app: &App,
    target: &Store,
    blob: &super::Blob,
    unreachable: &mut BTreeSet<String>,
) -> Result<Replicated> {
    let hash = blob.hash.clone();
    let target_id = target.id().to_string();
    if unreachable.contains(&target_id) || app.blobs.gate.unfinished(&hash) {
        return Ok(Replicated::Passed);
    }
    let _held = app.blobs.gate.lock(&hash).await;
    if app.blobs.gate.unfinished(&hash) {
        return Ok(Replicated::Passed);
    }
    let looked = hash.clone();
    let holders = app.db.read(move |tx| rows::holders(tx, &looked)).await?;
    if holders
        .iter()
        .any(|held| held.store_id == target_id && held.written)
    {
        return Ok(Replicated::Passed);
    }
    let cleared = match app.finish_deletion(target, &hash).await {
        Ok(()) => true,
        Err(Failed::Late) => {
            unreachable.insert(target_id.clone());
            false
        }
        Err(Failed::Io(error)) => {
            tracing::warn!(%error, "A queued deletion in a store to copy to failed");
            false
        }
    };
    let mut made = if cleared {
        copy_to(app, target, &holders, blob, unreachable).await?
    } else {
        Copy::Skipped(Some(
            "an earlier copy there is still being deleted".to_string(),
        ))
    };
    if let Copy::Made { object, .. } = &made
        && !written_by_target(app, target, blob, object).await
    {
        made = Copy::TargetSilent;
    }
    let (from, object) = match made {
        Copy::Made { from, object } => (from, object),
        Copy::Skipped(_) | Copy::Unreadable | Copy::TargetSilent => {
            let failed = match made {
                Copy::Skipped(why) => Replicated::Failed(why),
                Copy::Unreadable => Replicated::Unreadable,
                _ => {
                    unreachable.insert(target_id.clone());
                    Replicated::Failed(Some("the store did not answer in time".to_string()))
                }
            };
            let (hash, to) = (hash.clone(), target_id.clone());
            app.db
                .write(Write::own(), move |tx| rows::copy_failed(tx, &hash, &to))
                .await?;
            return Ok(failed);
        }
    };
    let (recorded_hash, to) = (hash.clone(), target_id.clone());
    let recorded = app
        .write(&Caller::Server, "blob.copy_replicated", move |unit| {
            let blob = recorded_hash;
            let recorded = rows::record_copy(unit.tx(), &blob, &to, &object, true, &unit.at)?;
            if recorded == rows::Recorded::Copy {
                unit.audit(
                    "blob",
                    blob.as_str(),
                    Some(json!({ "from": from, "store_id": to })),
                )?;
                return Ok(true);
            }
            rows::queue_deletion(unit.tx(), &blob, &to, &object, &unit.at)?;
            Ok(false)
        })
        .await?;
    if !recorded {
        if let Err(failure) = app.finish_deletion(target, &hash).await {
            tracing::warn!(?failure, "A copy not recorded waits for a later run");
        }
        return Ok(Replicated::Failed(Some(
            "the copy was not recorded".to_string(),
        )));
    }
    Ok(Replicated::Copied)
}

/// Failed copies yield to less-tried copies so one failure cannot monopolize the batch.
pub async fn replicate(app: Arc<App>, run: Run) -> Result<Report> {
    let tuning = &app.settings.start.tuning;
    let (batch, batch_bytes) = (
        tuning.blob_replicate_batch,
        tuning.blob_replicate_batch_bytes,
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
        let Some(target) = app.blobs.store(&pair.store_id) else {
            continue;
        };
        if let Replicated::Copied =
            replicate_one(&app, &target, &pair.blob, &mut unreachable).await?
        {
            copied += 1;
            bytes = bytes.saturating_add(size);
        }
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
    /// Struck only once the store answers with its own marker after.
    Missing,
    Silent,
    /// Present at the blob's size without the store's id: kept, and the store asked no more.
    Unnamed,
}

/// Only a store that answers can show a copy missing or altered.
async fn check(app: &App, store: &Store, copy: &rows::ToCheck) -> Checked {
    let blobs = &app.blobs;
    match store {
        Store::Disk(disk) | Store::Folder(disk) => {
            let lied = matches!(store, Store::Disk(_));
            let (faults, disk, hash) = (app.faults.clone(), disk.clone(), copy.hash.clone());
            let read = async move {
                faults.hold(HOLD_BLOB_READ, None).await;
                if faults.fail(FAIL_BLOB_READ, None) {
                    return Err(io::Error::other("the store failed the read"));
                }
                let lie = if lied {
                    faults.lie(hash.as_str())
                } else {
                    None
                };
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
        Store::S3(_) => match blobs.answer_of(store, &copy.hash, &copy.object).await {
            Ok(Answer::Holds(size)) if size == copy.size => Checked::Intact,
            Ok(Answer::Foreign(size)) if size == copy.size => {
                tracing::warn!("The object store answered for a copy without naming itself");
                Checked::Unnamed
            }
            Ok(Answer::Holds(_) | Answer::Foreign(_)) => Checked::Damaged,
            Ok(Answer::Missing) => Checked::Missing,
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
    let tuning = &app.settings.start.tuning;
    let (batch, batch_bytes) = (
        tuning.blob_integrity_batch,
        tuning.blob_integrity_batch_bytes,
    );
    let mut unreachable = BTreeSet::new();
    app.retry_deletions(&run, batch, false, &mut unreachable)
        .await?;
    let (mut verified, mut struck, mut bytes, mut checked) = (0u64, 0u64, 0u64, 0u64);
    let mut seen = HashSet::new();
    let mut marked = HashSet::new();
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
            // A strike on a missing copy needs the marker both before and after the answer.
            if matches!(store, Store::S3(_) | Store::Folder(_))
                && !marked.contains(&copy.store_id)
                && !app.blobs.is_itself(&store).await
            {
                unreachable.insert(copy.store_id.clone());
                break;
            }
            marked.insert(copy.store_id.clone());
            if app.blobs.gate.unfinished(&copy.hash) {
                continue;
            }
            let _held = app.blobs.gate.lock(&copy.hash).await;
            if app.blobs.gate.unfinished(&copy.hash) {
                continue;
            }
            let mut checked_now = check(&app, &store, &copy).await;
            if matches!(checked_now, Checked::Missing) && !app.blobs.is_itself(&store).await {
                checked_now = Checked::Silent;
            }
            match checked_now {
                Checked::Silent => {
                    unreachable.insert(copy.store_id.clone());
                    break;
                }
                Checked::Unnamed => {
                    unreachable.insert(copy.store_id.clone());
                }
                Checked::Intact => {
                    let (hash, id, object) = (
                        copy.hash.clone(),
                        copy.store_id.clone(),
                        copy.object.clone(),
                    );
                    let at = app.clock.stamp();
                    let stamped = app
                        .db
                        .write(Write::own(), move |tx| {
                            rows::verified(tx, &hash, &id, &object, &at)
                        })
                        .await?;
                    if stamped {
                        verified += 1;
                    }
                }
                Checked::Damaged | Checked::Missing => {
                    let (hash, id, kind) = (copy.hash.clone(), copy.store_id.clone(), store.kind());
                    let object = copy.object.clone();
                    let removed = app
                        .write(&Caller::Server, "blob.copy_struck", move |unit| {
                            let removed =
                                rows::remove_copy(unit.tx(), &hash, &id, &object, &unit.at)?;
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

/// Read from `tx`, since the live settings lag a committed change. Unless `surveyed`, a file
/// with a copy where backups go stays.
fn purgeable(tx: &rusqlite::Transaction<'_>, app: &App, surveyed: bool) -> Result<Vec<Hash>> {
    let mut found = past_grace(tx, app)?;
    if let Some(store) = app.blobs.backup_store_id()
        && !found.is_empty()
    {
        let held = crate::app::backups::held(tx, &store, &found)?;
        found.retain(|hash| !held.contains(hash));
        if !surveyed {
            let stored: HashSet<String> = rows::held_in(
                tx,
                &store,
                found.iter().map(|hash| hash.as_str().to_string()),
            )?
            .into_iter()
            .collect();
            found.retain(|hash| !stored.contains(hash.as_str()));
        }
    }
    Ok(found)
}

fn grace_cutoff(tx: &rusqlite::Transaction<'_>, app: &App) -> Result<Option<String>> {
    let seeds = app.settings.seeds();
    if !stored::deciding(tx, &seeds, BLOB_CLEANUP_ENABLED)? {
        return Ok(None);
    }
    let grace = stored::deciding(tx, &seeds, BLOB_CLEANUP_GRACE_SECONDS)?;
    Ok(app
        .clock
        .instant()
        .earlier_by(i64::try_from(grace.saturating_mul(1_000)).unwrap_or(i64::MAX))
        .map(Stamp::text))
}

fn past_grace(tx: &rusqlite::Transaction<'_>, app: &App) -> Result<Vec<Hash>> {
    match grace_cutoff(tx, app)? {
        Some(cutoff) => rows::purge_candidates(tx, &cutoff),
        None => Ok(Vec::new()),
    }
}

/// Purges only what an earlier run reported at least the grace ago and nothing names now.
pub async fn orphans(app: Arc<App>, run: Run) -> Result<Report> {
    let mut unreachable = BTreeSet::new();
    app.retry_deletions(&run, LEFTOVERS, true, &mut unreachable)
        .await?;
    let looked = app.clone();
    let due = app
        .db
        .read(move |tx| Ok(!past_grace(tx, &looked)?.is_empty()))
        .await?;
    let surveyed = if due {
        match crate::app::backups::survey_folder(&app).await {
            Ok(()) => true,
            Err(error) => {
                tracing::warn!(%error, "Files the object store holds wait for a survey of the backups");
                false
            }
        }
    } else {
        false
    };
    let (live, at, job) = (app.clone(), app.clock.stamp(), run.job);
    let (candidates, kept) = app
        .db
        .write(Write::own(), move |tx| {
            // Chosen before this run reports, so only an earlier run's report is purged.
            let candidates = purgeable(tx, &live, surveyed)?;
            let kept = match grace_cutoff(tx, &live)? {
                Some(_) => rows::UNREAD_ORPHANS.report(tx, job, [])?,
                None => 0,
            };
            rows::report_orphans(tx, &at)?;
            Ok((candidates, kept))
        })
        .await?;
    run.kept_unread(kept);
    let mut purged = 0u64;
    if !candidates.is_empty() && run.go_on().await {
        // The writer's index recheck protects references committed after this scan.
        let hexes: HashSet<String> = candidates
            .iter()
            .map(|hash| hash.hex().to_string())
            .collect();
        let named = app.db.read(move |tx| rows::named(tx, &hexes)).await?;
        app.faults.hold(HOLD_BLOB_PURGE, None).await;
        let live = app.clone();
        let gone = app
            .write(&Caller::Server, "blob.purge", move |unit| {
                let tx = unit.tx();
                let still: HashSet<Hash> = purgeable(tx, &live, surveyed)?.into_iter().collect();
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
                    rows::purge(tx, &hash, &unit.at)?;
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
