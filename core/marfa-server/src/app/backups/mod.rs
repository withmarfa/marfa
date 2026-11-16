//! Backups: an archive without files, put in parts. Each part is one line file of the archive,
//! named by its hash under `backup-parts/<instance id>/`, and the backup is a manifest under
//! `backups/<instance id>/` naming its parts, in the object store under its prefix or in the
//! backup folder. A part the last backup stored is not stored again.

mod found;
mod names;
pub(crate) mod parts;
mod stock;

use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use bytes::Bytes;
use futures_util::StreamExt;
use futures_util::stream;
use rusqlite::{OptionalExtension, Transaction, params};
use serde_json::{Value, json};
use tokio::sync::Mutex;

use super::App;
use super::access::{Caller, Permission};
use super::archive::tar::{BLOCK, END, header, padding};
use super::archive::{self, MANIFEST, Out, Parted};
use super::blobs::folder::{self as backup_folder, Adoptable, Area, Folder};
use super::blobs::restore::{Named, Readable};
use super::blobs::s3::S3;
use super::blobs::store::{ByteStream, Store};
use super::blobs::upkeep::{Replicated, object_store_said, replicate_one};
use super::blobs::{Blob, Hash, folder_shortfall};
use super::clock::Stamp;
use super::faults::{HOLD_BACKUP_PUT, HOLD_BACKUP_READ, HOLD_DISK_PROBE};
use super::housekeeping::{self, Report, Run};
use super::refusal::{Code, Refusal, Result};
use crate::db::Write;
use crate::settings::registry::BACKUP_INTERVAL_SECONDS;

pub use found::survey_folder;
pub use names::{Listing, doomed, instance_of, name_of, parse};
use parts::{Checked, Manifest, Part};
use stock::Stock;

/// The folder under the object store's prefix that holds a folder of backups per instance.
pub const FOLDER: &str = backup_folder::BACKUPS;
/// The folder under the object store's prefix that holds a folder of parts per instance.
pub const PARTS: &str = backup_folder::PARTS;
const LIST_DEADLINE: Duration = Duration::from_secs(30);
/// How many manifests a listing reads at once to size the backups it lists.
const MANIFEST_READS: usize = 8;
const REPLICATION: &str = "blob-replicate";

/// One backup at a time, whether the schedule or the owner asked for it.
#[derive(Debug, Default)]
pub struct Backups {
    running: Mutex<()>,
    /// Set while a restore holds `running` to read a backup.
    restoring: AtomicBool,
    /// Set while a look at the backup folder is in flight, which a mount that hangs holds.
    looking: Arc<AtomicBool>,
    /// Manifests this process began to write and saw fail, which may still land: a write that
    /// timed out can finish after its answer. No part is deleted while one is neither found nor
    /// forgotten.
    unsettled: std::sync::Mutex<BTreeSet<String>>,
}

impl Backups {
    fn unsettled(&self) -> std::sync::MutexGuard<'_, BTreeSet<String>> {
        self.unsettled
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// Clears `Backups::restoring` however the restore's read ends.
struct Restoring<'a>(&'a AtomicBool);

impl<'a> Restoring<'a> {
    fn begin(flag: &'a AtomicBool) -> Restoring<'a> {
        flag.store(true, Ordering::Release);
        Restoring(flag)
    }
}

impl Drop for Restoring<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

/// A part as the destination lists it.
#[derive(Clone, Debug)]
pub(super) struct Stored {
    size: u64,
    /// The ETag an object store lists it with, or the stamp a backup folder gives it.
    tag: Option<String>,
}

/// What the database records of backups.
#[derive(Debug, Default)]
struct State {
    changes: i64,
    backed_up: Option<i64>,
    /// The archive version of the last backup put.
    backed_up_version: Option<i64>,
    last_backup: Option<String>,
    last_backup_at: Option<String>,
    failures: i64,
    last_error: Option<String>,
    last_failed_at: Option<String>,
    /// Whether the last failure was the destination not answering.
    last_error_in_store: bool,
}

/// The change count a backup taken in this snapshot holds.
pub fn changes(tx: &Transaction<'_>) -> Result<i64> {
    Ok(tx
        .prepare_cached("SELECT changes FROM backup_state WHERE id = 1")?
        .query_row([], |row| row.get(0))
        .optional()?
        .unwrap_or(0))
}

fn state(tx: &Transaction<'_>) -> Result<State> {
    let found = tx
        .prepare_cached(
            "SELECT changes, backed_up, backed_up_version, last_backup, last_backup_at, failures, \
             last_error, last_failed_at, last_error_in_store FROM backup_state WHERE id = 1",
        )?
        .query_row([], |row| {
            Ok(State {
                changes: row.get(0)?,
                backed_up: row.get(1)?,
                backed_up_version: row.get(2)?,
                last_backup: row.get(3)?,
                last_backup_at: row.get(4)?,
                failures: row.get(5)?,
                last_error: row.get(6)?,
                last_failed_at: row.get(7)?,
                last_error_in_store: row.get(8)?,
            })
        })
        .optional()?;
    Ok(found.unwrap_or_default())
}

/// Records the backup put; one put without files it names counts as a failed run, with `without`.
fn record_put(
    tx: &Transaction<'_>,
    store: &str,
    changes: i64,
    name: &str,
    at: Stamp,
    without: Option<&str>,
) -> Result<()> {
    tx.prepare_cached("UPDATE backups SET confirmed = 1 WHERE store_id = ?1 AND name = ?2")?
        .execute(params![store, name])?;
    tx.execute(
        "INSERT INTO backup_state (id, backed_up, backed_up_version, last_backup, last_backup_at) \
         VALUES (1, ?1, ?4, ?2, ?3) ON CONFLICT (id) DO UPDATE SET \
         backed_up = max(coalesce(backed_up, ?1), ?1), backed_up_version = ?4, \
         last_backup = ?2, last_backup_at = ?3",
        params![changes, name, at, archive::VERSION as i64],
    )?;
    match without {
        Some(message) => record_failure(tx, message, at, false),
        None => {
            tx.execute(
                "UPDATE backup_state SET failures = 0, last_error = NULL, last_failed_at = NULL, \
                 last_error_in_store = 0 WHERE id = 1",
                [],
            )?;
            Ok(())
        }
    }
}

/// Records a failed run; `in_store` is whether the destination did not answer.
fn record_failure(tx: &Transaction<'_>, error: &str, at: Stamp, in_store: bool) -> Result<()> {
    tx.execute(
        "INSERT INTO backup_state (id, failures, last_error, last_failed_at, last_error_in_store) \
         VALUES (1, 1, ?1, ?2, ?3) ON CONFLICT (id) DO UPDATE SET \
         failures = failures + 1, last_error = ?1, last_failed_at = ?2, last_error_in_store = ?3",
        params![error, at, in_store],
    )?;
    Ok(())
}

/// Files the backup names with no recorded copy in its store; `None` if it is not recorded.
fn files_waiting(tx: &Transaction<'_>, store: &str, name: &str) -> Result<Option<u64>> {
    let seq: Option<i64> = tx
        .prepare_cached("SELECT seq FROM backups WHERE store_id = ?1 AND name = ?2")?
        .query_row(params![store, name], |row| row.get(0))
        .optional()?;
    let Some(seq) = seq else {
        return Ok(None);
    };
    let waiting: i64 = tx
        .prepare_cached(
            "SELECT count(*) FROM backup_files f WHERE f.store_id = ?1 AND f.first_seq <= ?2 \
             AND (f.last_seq IS NULL OR f.last_seq >= ?2) AND NOT EXISTS (SELECT 1 FROM \
             blob_copies c WHERE c.hash = f.hash AND c.store_id = ?1)",
        )?
        .query_row(params![store, seq], |row| row.get(0))?;
    Ok(Some(waiting.max(0) as u64))
}

/// The files the newest backup of `store` named; only one backup run at a time changes them.
fn open_files(tx: &Transaction<'_>, store: &str) -> Result<HashSet<String>> {
    Ok(tx
        .prepare_cached("SELECT hash FROM backup_files WHERE store_id = ?1 AND last_seq IS NULL")?
        .query_map([store], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?)
}

/// Records the backup `name` about to be put in `store`, refusing a name already recorded.
fn begin(tx: &Transaction<'_>, store: &str, name: &str) -> Result<i64> {
    let taken = tx
        .prepare_cached("SELECT 1 FROM backups WHERE store_id = ?1 AND name = ?2")?
        .exists(params![store, name])?;
    if taken || found::recorded(tx, store, name)? {
        return Err(Refusal::new(
            Code::Conflict,
            format!(
                "A backup named {name} is already recorded where backups go; the next run \
                 takes another name."
            ),
        ));
    }
    tx.prepare_cached("INSERT INTO backups (store_id, name) VALUES (?1, ?2)")?
        .execute(params![store, name])?;
    Ok(tx.last_insert_rowid())
}

/// Holds `hashes` from backup `seq` on, refusing one purged or dropped from `store` since its read.
fn open(
    tx: &Transaction<'_>,
    store: &str,
    seq: i64,
    hashes: &[String],
    in_store: &HashSet<String>,
) -> Result<()> {
    for hash in hashes {
        if !super::blobs::registered(tx, hash)? {
            return Err(Refusal::new(
                Code::Conflict,
                format!(
                    "The file {hash} the backup names was purged while the backup was read; \
                     the next run takes it again."
                ),
            ));
        }
        if in_store.contains(hash) && super::blobs::held_in(tx, store, [hash.clone()])?.is_empty() {
            return Err(Refusal::new(
                Code::Conflict,
                format!(
                    "The copy of the file {hash} where backups go was dropped while the backup \
                     was read; the next run takes the file again."
                ),
            ));
        }
    }
    let mut opening = tx.prepare_cached(
        "INSERT INTO backup_files (store_id, hash, first_seq) VALUES (?1, ?2, ?3) \
         ON CONFLICT (store_id, hash) DO UPDATE SET last_seq = NULL",
    )?;
    for hash in hashes {
        opening.execute(params![store, hash, seq])?;
    }
    Ok(())
}

/// Ends the run of each file the newest backup before `seq` named and backup `seq` does not.
fn close(tx: &Transaction<'_>, store: &str, seq: i64, hashes: &[String]) -> Result<()> {
    let mut closing = tx.prepare_cached(
        "UPDATE backup_files SET last_seq = ?3 \
         WHERE store_id = ?1 AND hash = ?2 AND last_seq IS NULL",
    )?;
    for hash in hashes {
        closing.execute(params![store, hash, seq - 1])?;
    }
    Ok(())
}

/// Of the files a backup names, those to open, and of those open now, those to close.
fn plan(open_now: &HashSet<String>, files: Vec<String>) -> (Vec<String>, Vec<String>) {
    let named: HashSet<String> = files.into_iter().collect();
    let closing = open_now.difference(&named).cloned().collect();
    let opening = named
        .into_iter()
        .filter(|hash| !open_now.contains(hash))
        .collect();
    (opening, closing)
}

/// How many files one write of a hold looks up and opens.
const HOLD_PAGE: usize = 5_000;

/// Records backup `name` and holds its files a page per write; a file open now is held already.
async fn hold(
    app: &Arc<App>,
    store: &str,
    name: &str,
    files: Vec<String>,
    in_store: Vec<String>,
) -> Result<()> {
    let looked = store.to_string();
    let (mut opening, closing) = app
        .db
        .read(move |tx| Ok(plan(&open_files(tx, &looked)?, files)))
        .await?;
    let (held, recorded) = (store.to_string(), name.to_string());
    let seq = app
        .db
        .write(Write::own(), move |tx| begin(tx, &held, &recorded))
        .await?;
    // Closing first leaves an interrupted attempt open on only the files it names.
    for page in closing.chunks(HOLD_PAGE) {
        let (held, page) = (store.to_string(), page.to_vec());
        app.db
            .write(Write::own(), move |tx| close(tx, &held, seq, &page))
            .await?;
    }
    let in_store: Arc<HashSet<String>> = Arc::new(in_store.into_iter().collect());
    while !opening.is_empty() {
        let page = opening.split_off(opening.len().saturating_sub(HOLD_PAGE));
        let (held, in_store) = (store.to_string(), in_store.clone());
        app.db
            .write(Write::own(), move |tx| {
                open(tx, &held, seq, &page, &in_store)
            })
            .await?;
    }
    Ok(())
}

/// How many listings in a row must omit a backup thinning would delete before it is gone.
const OMISSIONS: i64 = 3;

/// A backup as the database records it.
struct Recorded {
    seq: i64,
    name: String,
    confirmed: bool,
    omissions: i64,
}

/// When the newest backup of `store` was taken, the instant its thinning judged by, unless `now`
/// is earlier: no thinning yet to come forgets less than one judging by the instant answered.
fn last_thinned(tx: &Transaction<'_>, store: &str, now: Stamp) -> Result<Option<Stamp>> {
    let newest: Option<String> = tx
        .prepare_cached("SELECT name FROM backups WHERE store_id = ?1 ORDER BY seq DESC LIMIT 1")?
        .query_row([store], |row| row.get(0))
        .optional()?;
    Ok(newest
        .as_deref()
        .and_then(parse)
        .map(|taken| taken.min(now)))
}

/// Forgets an omitted backup only where thinning at `at` deletes it, and none without `at`.
fn reconcile(
    tx: &Transaction<'_>,
    store: &str,
    listed: &HashSet<String>,
    deleted: &HashSet<String>,
    at: Option<Stamp>,
) -> Result<()> {
    let recorded: Vec<Recorded> = tx
        .prepare_cached("SELECT seq, name, confirmed, omissions FROM backups WHERE store_id = ?1")?
        .query_map([store], |row| {
            Ok(Recorded {
                seq: row.get(0)?,
                name: row.get(1)?,
                confirmed: row.get(2)?,
                omissions: row.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    let newest = recorded.iter().map(|backup| backup.seq).max();
    let mut shown =
        tx.prepare_cached("UPDATE backups SET confirmed = 1, omissions = 0 WHERE seq = ?1")?;
    let mut omitted = tx.prepare_cached("UPDATE backups SET omissions = ?2 WHERE seq = ?1")?;
    let mut forget = tx.prepare_cached("DELETE FROM backups WHERE seq = ?1")?;
    let remaining = Listing::of(listed.iter().filter(|name| !deleted.contains(*name)));
    for backup in recorded {
        let seq = backup.seq;
        if deleted.contains(&backup.name) {
            forget.execute([seq])?;
        } else if listed.contains(&backup.name) {
            if !backup.confirmed || backup.omissions > 0 {
                shown.execute([seq])?;
            }
        } else if Some(seq) != newest {
            if parse(&backup.name).is_none() {
                tracing::error!(
                    backup = %backup.name,
                    "A recorded backup's name does not read, so the files it names stay held"
                );
                continue;
            }
            let omissions = backup.omissions.saturating_add(1);
            if omissions >= OMISSIONS && at.is_some_and(|at| remaining.would_thin(&backup.name, at))
            {
                forget.execute([seq])?;
            } else {
                omitted.execute(params![seq, omissions])?;
            }
        }
    }
    drop_uncovered(tx, store)
}

/// Forgets the backups recorded in `store` and their holds; answers how many backups.
fn forget_backups(tx: &Transaction<'_>, store: &str) -> Result<usize> {
    let put = tx
        .prepare_cached("DELETE FROM backups WHERE store_id = ?1")?
        .execute([store])?;
    tx.prepare_cached("DELETE FROM backup_files WHERE store_id = ?1")?
        .execute([store])?;
    tx.execute(
        "UPDATE backup_state SET backed_up = NULL, backed_up_version = NULL, last_backup = NULL, \
         last_backup_at = NULL WHERE id = 1",
        [],
    )?;
    stock::forget_store(tx, store)?;
    Ok(put + found::forget_store(tx, store)?)
}

/// Deletes each hold of `store` no recorded backup covers; an open one needs only the newest.
fn drop_uncovered(tx: &Transaction<'_>, store: &str) -> Result<()> {
    tx.prepare_cached(
        "DELETE FROM backup_files WHERE store_id = ?1 AND CASE WHEN last_seq IS NULL \
         THEN first_seq > (SELECT coalesce(max(seq), 0) FROM backups WHERE store_id = ?1) \
         ELSE NOT EXISTS (SELECT 1 FROM backups b WHERE b.store_id = ?1 \
         AND b.seq BETWEEN backup_files.first_seq AND backup_files.last_seq) END",
    )?
    .execute([store])?;
    Ok(())
}

fn folder_not_there(folder: &Folder) -> String {
    format!(
        "The backup folder {} is not there, or does not hold this instance's files. Mount the \
         disk it is on, then try again. If that disk was replaced, run `marfa backups folder \
         adopt` to start afresh on the one there now.",
        folder.root().display()
    )
}

/// A file the destination holds, as one read of it answers.
struct Got {
    size: u64,
    /// The ETag or stamp of the bytes this read answers.
    tag: Option<String>,
    bytes: ByteStream,
}

/// Where backups go: the object store or the backup folder.
#[derive(Clone)]
pub(crate) enum Destination {
    Bucket(Arc<S3>),
    Folder(Arc<Folder>),
}

impl Destination {
    fn of(app: &App) -> Option<Destination> {
        match (app.blobs.s3(), app.blobs.folder()) {
            (Some(bucket), _) => Some(Destination::Bucket(bucket)),
            (None, Some(folder)) => Some(Destination::Folder(folder)),
            (None, None) => None,
        }
    }

    /// The id of the store the backups' files are held in.
    fn id(&self) -> String {
        match self {
            Destination::Bucket(bucket) => bucket.id().to_string(),
            Destination::Folder(folder) => folder.files().id().to_string(),
        }
    }

    fn kind(&self) -> &'static str {
        match self {
            Destination::Bucket(_) => "bucket",
            Destination::Folder(_) => "folder",
        }
    }

    /// The refusal for a store that did not take part, naming no address; the log has the error.
    fn unreachable(&self, what: &str, error: &std::io::Error) -> Refusal {
        tracing::warn!(%error, kind = self.kind(), "The destination did not take part in a backup");
        let why = match self {
            Destination::Bucket(_) => object_store_said(error).to_string(),
            Destination::Folder(_) => error.to_string(),
        };
        self.failed_while(what, &why)
    }

    /// The same refusal for a reason already worded for the owner.
    fn failed_while(&self, what: &str, why: &str) -> Refusal {
        let message = match self {
            Destination::Bucket(_) => format!("The object store failed while {what}: {why}."),
            Destination::Folder(folder) if folder.reachable() => format!(
                "The backup folder {} failed while {what}: {why}",
                folder.root().display()
            ),
            Destination::Folder(folder) => folder_not_there(folder),
        };
        Refusal::new(Code::BlobStoreUnavailable, message)
    }

    fn not_found(&self, instance: &str, name: &str) -> Refusal {
        let place = match self {
            Destination::Bucket(_) => "The object store",
            Destination::Folder(_) => "The backup folder",
        };
        Refusal::new(
            Code::BackupNotFound,
            format!("{place} holds no backup named {name} from instance {instance}."),
        )
    }

    /// The files directly in `instance`'s folder of `area`, by name, with each one's size and the
    /// ETag an object store or the stamp a backup folder lists it with.
    async fn listed(
        &self,
        area: Area,
        instance: &str,
    ) -> std::io::Result<Vec<(String, u64, Option<String>)>> {
        match self {
            Destination::Bucket(bucket) => {
                let own = format!("{}/{instance}", area.name());
                super::blobs::store::within(LIST_DEADLINE, bucket.list_in(&own)).await
            }
            Destination::Folder(folder) => {
                let (folder, instance) = (folder.clone(), instance.to_string());
                let listed = blocking(move || folder.list_in(area, &instance)).await?;
                Ok(listed
                    .into_iter()
                    .map(|(name, size, stamp)| (name, size, Some(stamp)))
                    .collect())
            }
        }
    }

    /// The files directly in `instance`'s folder of `area`, by name and size.
    async fn list_in(&self, area: Area, instance: &str) -> std::io::Result<Vec<(String, u64)>> {
        Ok(self
            .listed(area, instance)
            .await?
            .into_iter()
            .map(|(name, size, _)| (name, size))
            .collect())
    }

    /// The parts in `instance`'s folder of parts, by hash.
    async fn parts_in(&self, instance: &str) -> std::io::Result<HashMap<String, Stored>> {
        Ok(self
            .listed(Area::Parts, instance)
            .await?
            .into_iter()
            .filter_map(|(name, size, tag)| {
                Some((parts::parse(&name)?.to_string(), Stored { size, tag }))
            })
            .collect())
    }

    /// Every backup in an instance's folder, as its folder and name, and its size.
    async fn list_all(&self) -> std::io::Result<Vec<(Vec<String>, u64)>> {
        match self {
            Destination::Bucket(bucket) => {
                super::blobs::store::within(LIST_DEADLINE, bucket.list_under(FOLDER)).await
            }
            Destination::Folder(folder) => {
                let folder = folder.clone();
                blocking(move || folder.list_all()).await
            }
        }
    }

    /// The file `name` in `instance`'s folder of `area`, with its size and the tag of the bytes
    /// it answers.
    async fn get(
        &self,
        area: Area,
        instance: &str,
        name: &str,
        idle: Duration,
    ) -> std::io::Result<Option<Got>> {
        let found = match self {
            Destination::Bucket(bucket) => {
                let key = key_of(area, instance, name);
                super::blobs::store::within(
                    super::blobs::store::CHECK_DEADLINE,
                    bucket.get_whole(&key),
                )
                .await?
            }
            Destination::Folder(folder) => {
                let (folder, instance, name) =
                    (folder.clone(), instance.to_string(), name.to_string());
                blocking(move || folder.open_in(area, &instance, &name))
                    .await?
                    .map(|(size, stamp, file)| {
                        let bytes = super::blobs::store::file_stream(file, 0, size);
                        (size, Some(stamp), bytes)
                    })
            }
        };
        Ok(found.map(|(size, tag, bytes)| Got {
            size,
            tag,
            bytes: super::blobs::store::idle_limited(bytes, idle),
        }))
    }

    /// The manifest of backup `name` of `instance`, with its size, or why it does not read.
    async fn manifest(
        &self,
        instance: &str,
        name: &str,
        idle: Duration,
    ) -> std::io::Result<Option<(u64, std::result::Result<Manifest, String>)>> {
        let Some(Got {
            size, mut bytes, ..
        }) = self.get(Area::Backups, instance, name, idle).await?
        else {
            return Ok(None);
        };
        if size > archive::LINE_CAP as u64 {
            let why = format!("it is larger than {} bytes", archive::LINE_CAP);
            return Ok(Some((size, Err(why))));
        }
        let mut held = Vec::with_capacity(size as usize);
        while let Some(chunk) = bytes.next().await {
            held.extend_from_slice(&chunk?);
            if held.len() as u64 > size {
                return Ok(Some((size, Err("it grew while it was read".into()))));
            }
        }
        Ok(Some((size, Manifest::read(&held))))
    }

    /// Stores `bytes` as `name` in this instance's folder of `area`, whole or not at all, in place
    /// of what is there. Answers the size and the tag the destination gave it.
    async fn put(
        &self,
        app: &App,
        area: Area,
        name: &str,
        size: u64,
        bytes: ByteStream,
    ) -> std::io::Result<(u64, Option<String>)> {
        let limit = super::blobs::store::write_deadline(app.blobs.check(), size);
        match self {
            Destination::Bucket(bucket) => {
                let key = key_of(area, &app.instance_id, name);
                let kind = match area {
                    Area::Backups => "application/json",
                    Area::Parts => "application/gzip",
                };
                bucket.put_whole(&key, kind, bytes, limit).await
            }
            Destination::Folder(folder) => {
                let written = super::blobs::store::within(
                    limit,
                    backup_folder::write(
                        folder.clone(),
                        area,
                        name.to_string(),
                        bytes,
                        app.faults.clone(),
                    ),
                )
                .await?;
                let (size, stamp) = written.place().await?;
                Ok((size, Some(stamp)))
            }
        }
    }

    /// Deletes `name` from this instance's folder of `area`.
    async fn delete(&self, area: Area, own: &str, name: &str) -> std::io::Result<()> {
        match self {
            Destination::Bucket(bucket) => {
                let key = key_of(area, own, name);
                super::blobs::store::within(LIST_DEADLINE, bucket.delete_whole(&key)).await
            }
            Destination::Folder(folder) => {
                let (folder, name) = (folder.clone(), name.to_string());
                blocking(move || folder.delete(area, &name)).await
            }
        }
    }
}

/// Runs blocking work on a folder within the time a listing is given.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> std::io::Result<T> + Send + 'static,
) -> std::io::Result<T> {
    super::blobs::store::within(LIST_DEADLINE, async move {
        tokio::task::spawn_blocking(work)
            .await
            .map_err(std::io::Error::other)?
    })
    .await
}

/// Settles earlier attempts by the store's listing, refusing to go on while it does not answer.
async fn settle_attempts(app: &Arc<App>, destination: &Destination) -> Result<()> {
    let store = destination.id().to_string();
    let looked = store.clone();
    let pending = app
        .db
        .read(move |tx| {
            Ok(tx
                .prepare_cached("SELECT 1 FROM backups WHERE store_id = ?1 AND confirmed = 0")?
                .exists([&looked])?)
        })
        .await?;
    if !pending {
        return Ok(());
    }
    let listed: HashSet<String> = destination
        .list_in(Area::Backups, &app.instance_id)
        .await
        .map_err(|error| destination.unreachable("checking the last backup", &error))?
        .into_iter()
        .map(|(name, _)| name)
        .collect();
    let now = app.clock.instant();
    app.db
        .write(Write::own(), move |tx| {
            let at = last_thinned(tx, &store, now)?;
            reconcile(tx, &store, &listed, &HashSet::new(), at)
        })
        .await
}

/// Of `hashes`, those a backup of `store` that this instance keeps or found may name.
pub fn held(tx: &Transaction<'_>, store: &str, hashes: &[Hash]) -> Result<HashSet<Hash>> {
    let mut statement = tx.prepare_cached(
        "SELECT 1 FROM backup_files f JOIN backups b ON b.store_id = f.store_id \
         AND b.seq >= f.first_seq AND (f.last_seq IS NULL OR b.seq <= f.last_seq) \
         WHERE f.store_id = ?1 AND f.hash = ?2",
    )?;
    let mut held = HashSet::new();
    for hash in hashes {
        if statement.exists(params![store, hash.as_str()])?
            || found::names(tx, store, hash.as_str())?
        {
            held.insert(hash.clone());
        }
    }
    Ok(held)
}

fn no_backup_destination() -> Refusal {
    Refusal::new(
        Code::NoBackupDestination,
        "This instance keeps no backups, because it has nowhere to put them. Set \
         MARFA_BACKUP_PATH to a folder, or S3_BUCKET to an object store, to keep them.",
    )
}

fn running(restoring: bool) -> Refusal {
    let message = match restoring {
        true => "A restore is reading a backup; try again once it ends.",
        false => "A backup is running; try again once it ends.",
    };
    Refusal::new(Code::HousekeepingJobRunning, message)
}

/// Whether the schedule runs backups here: a destination is set and the interval is not 0.
pub fn scheduled(app: &App) -> bool {
    Destination::of(app).is_some() && app.settings.live().get(BACKUP_INTERVAL_SECONDS) > 0
}

fn key_of(area: Area, instance: &str, name: &str) -> String {
    format!("{}/{instance}/{name}", area.name())
}

fn listed(instance: &str, name: &str, created_at: Stamp, size: u64) -> Value {
    json!({
        "name": name,
        "instance_id": instance,
        "created_at": created_at,
        "size_bytes": size,
    })
}

/// What a backup run did.
enum Outcome {
    Put {
        instance: String,
        name: String,
        taken: Stamp,
        size: u64,
        /// The bytes of the parts it stored, which the destination did not already hold.
        sent: u64,
        removed: usize,
        unremoved: usize,
        /// The parts no backup named any more that it deleted.
        parts_removed: usize,
        /// The files the backup names that no store could give.
        lost: Vec<String>,
        /// How many files it names that the destination did not yet hold once it was put.
        waiting: u64,
    },
    Unchanged,
    /// Another backup, or a restore when `restoring`, holds the lock.
    Running {
        restoring: bool,
    },
}

impl Outcome {
    /// A housekeeping report holds only numbers, flags and text.
    fn report(&self) -> Value {
        match self {
            Outcome::Put {
                name,
                size,
                sent,
                removed,
                unremoved,
                parts_removed,
                lost,
                waiting,
                ..
            } => json!({
                "outcome": "put",
                "backup": name,
                "size_bytes": size,
                "sent_bytes": sent,
                "parts_removed": parts_removed,
                "removed": removed,
                "unremoved": unremoved,
                "blobs_lost": lost.len(),
                "blobs_waiting": waiting,
            }),
            other => other.to_json(),
        }
    }

    fn to_json(&self) -> Value {
        match self {
            Outcome::Put {
                instance,
                name,
                taken,
                size,
                sent,
                removed,
                unremoved,
                lost,
                waiting,
                ..
            } => json!({
                "outcome": "put",
                "backup": listed(instance, name, *taken, *size),
                "sent_bytes": sent,
                "removed": removed,
                "unremoved": unremoved,
                "blobs_lost": lost,
                "blobs_waiting": waiting,
            }),
            Outcome::Unchanged => json!({ "outcome": "unchanged" }),
            Outcome::Running { .. } => json!({ "outcome": "running" }),
        }
    }
}

/// The `backup` housekeeping job.
pub async fn job(app: Arc<App>, _run: Run) -> Result<Report> {
    let outcome = back_up(&app, false).await?;
    Ok(Report::done(outcome.report()))
}

/// Past one part, so a multipart upload has begun before `backup:put` holds.
const HELD_AFTER: u64 = 16 * 1024 * 1024;

/// Holds a backup at `backup:put` once: as soon as more than `HELD_AFTER` bytes of its parts are
/// in hand, else with every byte of the last part it stores in hand, before the destination takes
/// that part whole, else before its manifest is written.
#[derive(Clone)]
struct Held {
    faults: Arc<super::faults::Faults>,
    sent: Arc<AtomicU64>,
    held: Arc<AtomicBool>,
}

impl Held {
    fn new(app: &App) -> Held {
        Held {
            faults: app.faults.clone(),
            sent: Arc::default(),
            held: Arc::default(),
        }
    }

    fn watch(&self, bytes: ByteStream, last: bool) -> ByteStream {
        stream::unfold((bytes, self.clone()), move |(mut bytes, held)| async move {
            let chunk = bytes.next().await;
            let due = match &chunk {
                Some(Ok(chunk)) => {
                    let len = chunk.len() as u64;
                    held.sent.fetch_add(len, Ordering::AcqRel) + len > HELD_AFTER
                }
                Some(Err(_)) => false,
                None => last,
            };
            if due {
                held.once().await;
            }
            chunk.map(|chunk| (chunk, (bytes, held)))
        })
        .boxed()
    }

    async fn once(&self) {
        if !self.held.swap(true, Ordering::AcqRel) {
            self.faults.hold(HOLD_BACKUP_PUT, None).await;
        }
    }
}

impl App {
    fn destination(&self) -> Result<Destination> {
        Destination::of(self).ok_or_else(no_backup_destination)
    }

    /// The backups where this instance keeps them, of every instance that put them there, newest
    /// first.
    pub async fn list_backups(&self, caller: &Caller) -> Result<Vec<Value>> {
        caller.require(Permission::BackupsManage)?;
        let destination = self.destination()?;
        let found = destination
            .list_all()
            .await
            .map_err(|error| destination.unreachable("listing the backups", &error))?;
        let mut backups: Vec<(Stamp, String, String, u64)> = found
            .into_iter()
            .filter_map(|(parts, size)| match parts.as_slice() {
                [instance, name] if instance_of(instance) => {
                    Some((parse(name)?, instance.clone(), name.clone(), size))
                }
                _ => None,
            })
            .collect();
        backups.sort_by(|a, b| b.cmp(a));
        let (destination, idle) = (&destination, self.blob_read_idle());
        Ok(stream::iter(backups)
            .map(|(created_at, instance, name, size)| async move {
                let size = match destination.manifest(&instance, &name, idle).await {
                    Ok(Some((length, Ok(manifest)))) => manifest.size(length),
                    _ => size,
                };
                listed(&instance, &name, created_at, size)
            })
            .buffered(MANIFEST_READS)
            .collect()
            .await)
    }

    /// Puts a backup now, whether or not anything has changed since the last.
    pub async fn run_backup(self: &Arc<App>, caller: &Caller) -> Result<Value> {
        caller.require(Permission::BackupsManage)?;
        let app = self.clone();
        let outcome = tokio::spawn(async move { back_up(&app, true).await })
            .await
            .map_err(|_| Refusal::internal("a backup's task ended early"))??;
        match outcome {
            Outcome::Running { restoring } => Err(running(restoring)),
            outcome => Ok(outcome.to_json()),
        }
    }

    /// Restores the named backup of `instance`, read by the server itself from where it keeps
    /// backups. From the backup folder, every file the backup names is read from the folder too.
    /// Without `whole`, a file it needs that is held nowhere is left out instead of refusing.
    pub async fn restore_backup(
        self: &Arc<App>,
        caller: &Caller,
        started_at: String,
        instance: &str,
        name: &str,
        whole: bool,
    ) -> Result<Value> {
        caller.require_local()?;
        let destination = self.destination()?;
        if !instance_of(instance) || parse(name).is_none() {
            return Err(destination.not_found(instance, name));
        }
        // No backup prunes parts while they are read.
        let reading = self.backups.running.lock().await;
        let restoring = Restoring::begin(&self.backups.restoring);
        let mut received = self.receive_backup(&destination, instance, name).await?;
        drop(restoring);
        drop(reading);
        if let Destination::Folder(folder) = &destination {
            let reading = self
                .files_to_read(folder, instance, &received, whole)
                .await?;
            let needed = received.manifest.held_files();
            let wanted: Vec<String> = reading
                .iter()
                .map(|named| named.hash.as_str().to_string())
                .filter(|hash| needed.contains(hash))
                .collect();
            let copies = self.copies_in_folder(folder, instance, reading).await?;
            let read: HashSet<&str> = copies
                .iter()
                .map(|(sealed, _)| sealed.hash.as_str())
                .collect();
            let unread: Vec<String> = wanted
                .into_iter()
                .filter(|hash| !read.contains(hash.as_str()))
                .collect();
            if whole && !unread.is_empty() {
                return Err(archive::restore::files_missing(unread));
            }
            received.carried.extend(copies);
        }
        let mut answer = self
            .restore(caller, started_at, received, whole)
            .await
            .map_err(|refused| match destination {
                Destination::Bucket(_) => lacking_in_bucket(refused),
                Destination::Folder(_) => refused,
            })?;
        answer["backup"] = json!({ "name": name, "instance_id": instance });
        Ok(answer)
    }

    /// Reads backup `name` of `instance` as one archive: its manifest, then each part it names,
    /// each checked against the hash and size the manifest gives. A part missing or altered
    /// refuses the restore before it writes anything.
    async fn receive_backup(
        &self,
        destination: &Destination,
        instance: &str,
        name: &str,
    ) -> Result<archive::restore::intake::Received> {
        let idle = self.blob_read_idle();
        let read = destination
            .manifest(instance, name, idle)
            .await
            .map_err(|error| destination.unreachable("reading the backup", &error))?;
        let manifest = match read {
            None => return Err(destination.not_found(instance, name)),
            Some((_, Err(why))) => {
                return Err(Refusal::validation(format!(
                    "Nothing was restored: the manifest of the backup {name} from instance \
                     {instance} does not read, because {why}."
                )));
            }
            Some((_, Ok(manifest))) => manifest,
        };
        let stored = destination
            .parts_in(instance)
            .await
            .map_err(|error| destination.unreachable("listing the backup's parts", &error))?;
        let own = instance == self.instance_id;
        let absent = absent_parts(&manifest.parts, &stored);
        if !absent.is_empty() {
            if own {
                for part in &manifest.parts {
                    if stored
                        .get(&part.sha256)
                        .is_some_and(|stored| stored.size != part.size_bytes)
                    {
                        let tag = stored
                            .get(&part.sha256)
                            .and_then(|stored| stored.tag.clone());
                        stock::found_damaged(self, destination, &part.sha256, tag).await;
                    }
                }
            }
            return Err(parts_missing(name, absent));
        }
        let head = serde_json::to_vec(&manifest.archive)
            .map_err(|_| Refusal::internal("a backup's archive manifest did not print"))?;
        let entry = |size: u64| BLOCK as u64 + size + padding(size) as u64;
        let mut total = entry(head.len() as u64) + END.len() as u64;
        for run in runs(&manifest.parts) {
            total += entry(run.iter().map(|part| part.size_bytes).sum());
        }
        let mut assembly = Assembly {
            receiving: Some(self.begin_restore(Some(total)).await?),
            refused: None,
        };
        let result = async {
            assembly.header(MANIFEST, head.len() as u64).await?;
            let length = head.len() as u64;
            assembly.push(Bytes::from(head)).await;
            assembly.pad(length).await;
            for run in runs(&manifest.parts) {
                let size = run.iter().map(|part| part.size_bytes).sum();
                assembly.header(&run[0].entry, size).await?;
                for part in run {
                    let named = parts::name_of(&part.sha256);
                    let got = destination
                        .get(Area::Parts, instance, &named, idle)
                        .await
                        .map_err(|error| {
                            destination.unreachable("reading a part of the backup", &error)
                        })?;
                    let Some(Got { tag, mut bytes, .. }) = got else {
                        return Err(parts_missing(name, vec![named]));
                    };
                    let mut checked = Checked::default();
                    let mut over = false;
                    while let Some(chunk) = bytes.next().await {
                        let chunk = chunk.map_err(|error| {
                            destination.unreachable("reading a part of the backup", &error)
                        })?;
                        checked.update(&chunk);
                        if checked.size() > part.size_bytes {
                            over = true;
                            break;
                        }
                        assembly.push(chunk).await;
                    }
                    if over || !checked.matches(part) {
                        if own {
                            stock::found_damaged(self, destination, &part.sha256, tag).await;
                        }
                        return Err(parts_missing(name, vec![named]));
                    }
                    if let Some(refused) = assembly.refused.take() {
                        return Err(refused);
                    }
                }
                assembly.pad(size).await;
            }
            assembly.push(Bytes::from_static(&END)).await;
            Ok(())
        }
        .await;
        match result {
            Ok(()) => assembly.finish().await,
            Err(refused) => {
                assembly.abandon().await;
                Err(refused)
            }
        }
    }

    /// The files a folder restore reads; with `whole`, refuses before any read where the folder
    /// lacks one it needs.
    async fn files_to_read(
        &self,
        folder: &Arc<Folder>,
        instance: &str,
        received: &archive::restore::intake::Received,
        whole: bool,
    ) -> Result<Vec<Named>> {
        let needed = received.manifest.held_files();
        let (mut reading, mut lacking) = (Vec::new(), Vec::new());
        for named in received.absent() {
            match self.readable(&named.hash).await? {
                Readable::Whole => continue,
                Readable::Silent => {
                    return Err(Refusal::new(
                        Code::BlobStoreUnavailable,
                        format!(
                            "A store did not answer whether it holds the file {}; try again.",
                            named.hash.as_str()
                        ),
                    ));
                }
                Readable::Nowhere => {}
            }
            let (looked, instance, hash) =
                (folder.clone(), instance.to_string(), named.hash.clone());
            let size = blocking(move || looked.copy_size(&instance, &hash))
                .await
                .map_err(|error| {
                    Destination::Folder(folder.clone()).unreachable("looking for the files", &error)
                })?;
            match (size, named.size_bytes) {
                (Some(found), Some(size)) if found != size => {}
                (Some(_), _) => {
                    reading.push(named);
                    continue;
                }
                (None, _) => {}
            }
            if needed.contains(named.hash.as_str()) {
                lacking.push(named.hash.as_str().to_string());
            }
        }
        if whole && !lacking.is_empty() {
            return Err(archive::restore::files_missing(lacking));
        }
        Ok(reading)
    }

    /// Takes an unmarked backup folder as a new store, forgetting the old one's copies and backups.
    pub async fn adopt_backup_folder(self: &Arc<App>, caller: &Caller) -> Result<Value> {
        caller.require(Permission::BackupsManage)?;
        let destination = self.destination()?;
        let Destination::Folder(folder) = &destination else {
            return Err(Refusal::new(
                Code::Conflict,
                "This instance backs up to an object store, so it has no backup folder to adopt.",
            ));
        };
        let Ok(_running) = self.backups.running.try_lock() else {
            return Err(running(self.backups.restoring.load(Ordering::Acquire)));
        };
        let looked = folder.clone();
        let found = blocking(move || looked.adoptable())
            .await
            .map_err(|error| destination.unreachable("looking at the folder to adopt", &error))?;
        let root = folder.root().display().to_string();
        let old = folder.files();
        match found {
            Adoptable::Unmarked => {}
            Adoptable::Held => {
                return Err(Refusal::new(
                    Code::Conflict,
                    format!(
                        "The backup folder {root} holds this instance's files, so there is \
                         nothing to adopt."
                    ),
                ));
            }
            Adoptable::Missing => {
                return Err(Refusal::new(
                    Code::BlobStoreUnavailable,
                    format!(
                        "The backup folder {root} is not there, so nothing was adopted. Mount \
                         the disk it is on, then try again."
                    ),
                ));
            }
            Adoptable::Foreign(id) => {
                return Err(Refusal::new(
                    Code::Conflict,
                    format!(
                        "The files folder {} holds the marker of another store, {id}, so it was \
                         left as it is. Remove that marker to adopt the folder afresh.",
                        old.root().display()
                    ),
                ));
            }
        }
        let (old_id, id) = (old.id().to_string(), uuid::Uuid::now_v7().to_string());
        let (locator, at) = (old.root().display().to_string(), self.clock.stamp());
        let (forgotten, new_id) = (old_id.clone(), id.clone());
        let standing = caller.clone();
        let (copies, backups) = self
            .db
            .write(Write::own(), move |tx| {
                standing
                    .current(tx, &at)?
                    .require(Permission::BackupsManage)?;
                let backups = forget_backups(tx, &forgotten)?;
                let copies = super::blobs::Blobs::replace_folder_store(
                    tx, &forgotten, &new_id, &locator, &at,
                )?;
                housekeeping::bring_forward(tx, REPLICATION, &at)?;
                Ok((copies, backups))
            })
            .await?;
        let (claimed, new_id) = (folder.clone(), id.clone());
        blocking(move || claimed.claim(&new_id))
            .await
            .map_err(|error| {
                Refusal::new(
                    Code::BlobStoreUnavailable,
                    format!(
                        "The backup folder {root} could not take the new store's marker: {error}. \
                         The old store's {} and {} were forgotten. Make the folder writable, \
                         then run `marfa backups folder adopt` again.",
                        counted(backups, "backup", "backups"),
                        counted(copies, "file copy", "file copies"),
                    ),
                )
            })?;
        tracing::info!(store = %id, replaced = %old_id, backups, copies, "The backup folder was adopted");
        Ok(json!({
            "store_id": id,
            "replaced_store_id": old_id,
            "backups_forgotten": backups,
            "copies_forgotten": copies,
        }))
    }

    /// Whether the folder's disk is there, or `None` when a look at it has not answered.
    async fn folder_there(&self, folder: &Arc<Folder>) -> Option<bool> {
        let looking = self.backups.looking.clone();
        if looking.swap(true, Ordering::AcqRel) {
            return None;
        }
        let (folder, faults) = (folder.clone(), self.faults.clone());
        let answered = super::health::bounded(move || {
            faults.hold_blocking(HOLD_DISK_PROBE);
            let there = folder.reachable();
            looking.store(false, Ordering::Release);
            there
        })
        .await;
        if answered.is_none() {
            tracing::warn!("The backup folder did not answer for health in time");
        }
        answered
    }

    /// What `/health` says of backups: whether they run, how the last went, and the store's state.
    pub async fn backup_health(&self) -> BackupHealth {
        let mut health = serde_json::Map::new();
        let destination = Destination::of(self);
        if let Some(destination) = &destination {
            health.insert("destination".into(), destination.kind().into());
        }
        let look = async {
            match &destination {
                Some(Destination::Folder(folder)) => Some(self.folder_there(folder).await),
                _ => None,
            }
        };
        let store = destination.as_ref().map(Destination::id);
        let read = tokio::time::timeout(
            Duration::from_secs(2),
            self.db.read(move |tx| {
                let state = state(tx)?;
                let files_waiting = match (&store, &state.last_backup) {
                    (Some(store), Some(name)) => files_waiting(tx, store, name)?,
                    _ => None,
                };
                let damaged = match &store {
                    Some(store) => Some(stock::damaged(tx, store)?),
                    None => None,
                };
                Ok((
                    state,
                    housekeeping::last_run(tx, REPLICATION)?,
                    files_waiting,
                    damaged,
                ))
            }),
        );
        let (read, looked) = tokio::join!(read, look);
        let (state, replication, files_waiting, damaged) = match read {
            Ok(Ok((state, replication, files_waiting, damaged))) => {
                (Some(state), replication, files_waiting, damaged)
            }
            Ok(Err(error)) => {
                tracing::warn!(%error, "The backup state did not read for health");
                (None, None, None, None)
            }
            Err(_) => {
                tracing::warn!("The backup state did not read for health in time");
                (None, None, None, None)
            }
        };
        let waiting = replication
            .as_ref()
            .and_then(|run| run.result.as_ref())
            .and_then(|result| result["remaining"].as_u64())
            .unwrap_or(0);
        let trouble = destination.as_ref().and_then(|destination| {
            let refused = replication
                .as_ref()
                .filter(|run| run.failure.is_some())
                .and_then(|run| run.result.as_ref())
                .and_then(|result| refused_by(result, &destination.id()));
            store_trouble(destination, looked, refused)
        });
        let fault = trouble.as_ref().map(|(fault, _)| *fault);
        let store_error = trouble.map(|(_, error)| error);
        let run_in_store = state
            .as_ref()
            .is_some_and(|state| state.failures > 0 && state.last_error_in_store);
        let turned_off = self.settings.live().get(BACKUP_INTERVAL_SECONDS) == 0;
        let failing = state.as_ref().is_none_or(|state| state.failures > 0);
        let incomplete = files_waiting.is_some_and(|waiting| waiting > 0);
        let damage = damaged.is_some_and(|damaged| damaged > 0);
        if destination.is_some() && turned_off {
            health.insert("reason".into(), "turned_off".into());
        }
        let status = match (&destination, turned_off, failing, &store_error) {
            (None, ..) => {
                health.insert("reason".into(), "no_backup_destination".into());
                "off"
            }
            (Some(_), _, _, Some(_)) => "failing",
            (Some(_), ..) if damage => "failing",
            (Some(_), _, true, None) => "failing",
            (Some(_), true, false, None) => "off",
            (Some(_), false, false, None) if incomplete => "incomplete",
            (Some(_), false, false, None) => "ok",
        };
        health.insert("status".into(), status.into());
        if let Some(state) = state {
            health.insert("last_backup".into(), state.last_backup.into());
            health.insert("last_backup_at".into(), state.last_backup_at.into());
            health.insert("failures".into(), state.failures.into());
            health.insert("last_error".into(), state.last_error.into());
            health.insert("last_failed_at".into(), state.last_failed_at.into());
        }
        if destination.is_some() {
            health.insert("copies_waiting".into(), waiting.into());
            health.insert("last_backup_files_waiting".into(), files_waiting.into());
            health.insert("store_error".into(), store_error.into());
            health.insert("damaged_parts".into(), damaged.into());
        }
        BackupHealth {
            report: Value::Object(health),
            fault,
            run_in_store,
        }
    }
}

/// Words a restore the object store lacks files for as the bucket's, not the folder's.
fn lacking_in_bucket(mut refused: Refusal) -> Refusal {
    const SHOWN: usize = 10;
    if refused.code != Code::BackupFilesMissing {
        return refused;
    }
    let lacking: Vec<String> = refused
        .details
        .as_ref()
        .and_then(|details| details["missing_blobs"].as_array().cloned())
        .unwrap_or_default()
        .iter()
        .filter_map(|hash| hash.as_str().map(str::to_string))
        .collect();
    let mut shown = lacking[..lacking.len().min(SHOWN)].join(", ");
    if lacking.len() > SHOWN {
        shown.push_str(&format!(" and {} more", lacking.len() - SHOWN));
    }
    refused.message = format!(
        "Nothing was restored: the backup names {} that neither this instance nor the object \
         store holds whole: {shown}. Restore an earlier backup, or restore this one with \
         `marfa backups restore --allow-missing-files` to leave them out.",
        counted(lacking.len(), "file", "files")
    )
    .into();
    refused
}

/// Refuses a restore of backup `name` for the parts in `missing`, missing or altered where
/// backups go.
fn parts_missing(name: &str, missing: Vec<String>) -> Refusal {
    const SHOWN: usize = 10;
    let mut shown = missing[..missing.len().min(SHOWN)].join(", ");
    if missing.len() > SHOWN {
        shown.push_str(&format!(" and {} more", missing.len() - SHOWN));
    }
    let count = counted(missing.len(), "part", "parts");
    Refusal::new(
        Code::BackupPartsMissing,
        format!(
            "Nothing was restored: the backup {name} names {count} that {} missing where \
             backups go, or that no longer {} what the backup recorded: {shown}. Restore \
             another backup.",
            if missing.len() == 1 { "is" } else { "are" },
            if missing.len() == 1 { "holds" } else { "hold" },
        ),
    )
    .with_detail("missing_parts", missing)
}

/// The parts of each entry in turn.
fn runs(parts: &[Part]) -> Vec<&[Part]> {
    parts.chunk_by(|a, b| a.entry == b.entry).collect()
}

/// The archive a backup's parts make, handed to a restore's reader as it is read. Once the reader
/// refuses, the rest of a part is read only to check it.
struct Assembly {
    receiving: Option<archive::restore::Receiving>,
    refused: Option<Refusal>,
}

impl Assembly {
    async fn push(&mut self, bytes: Bytes) {
        if self.refused.is_some() {
            return;
        }
        if let Some(receiving) = self.receiving.as_mut()
            && let Err(refused) = receiving.push(bytes).await
        {
            self.receiving = None;
            self.refused = Some(refused);
        }
    }

    async fn header(&mut self, entry: &str, size: u64) -> Result<()> {
        let block = header(entry, size, 0)
            .ok_or_else(|| Refusal::internal("a backup's entry name does not fit a header"))?;
        self.push(Bytes::copy_from_slice(&block)).await;
        Ok(())
    }

    async fn pad(&mut self, size: u64) {
        let fill = padding(size);
        if fill > 0 {
            self.push(Bytes::from(vec![0u8; fill])).await;
        }
    }

    async fn abandon(mut self) {
        if let Some(receiving) = self.receiving.take() {
            receiving.abandon().await;
        }
    }

    async fn finish(mut self) -> Result<archive::restore::intake::Received> {
        if let Some(refused) = self.refused.take() {
            return Err(refused);
        }
        match self.receiving.take() {
            Some(receiving) => receiving.finish().await,
            None => Err(Refusal::internal("a restore's reader ended early")),
        }
    }
}

/// How the destination fails to take the copies that wait for it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StoreFault {
    /// The disk of the backup folder is not there.
    FolderGone,
    /// A look at the backup folder did not answer in time.
    FolderSilent,
    /// The last run of `blob-replicate` copied nothing because the destination refused.
    Refused,
}

/// The `backups` part of the health report, and what the attention list reads besides it.
pub struct BackupHealth {
    pub report: Value,
    pub fault: Option<StoreFault>,
    /// The last backup run failed because the destination did not answer.
    pub run_in_store: bool,
}

/// What the last run of `blob-replicate` said of the store `destination`, when it refused it.
fn refused_by(result: &Value, destination: &str) -> Option<String> {
    result["refused"][destination].as_str().map(str::to_string)
}

/// Why the destination takes no copies, from a look at the folder (`None` when the destination
/// is not a folder, and `Some(None)` when the look did not answer) or from what replication
/// found. A failure copying to another store is not the destination's.
fn store_trouble(
    destination: &Destination,
    look: Option<Option<bool>>,
    refused: Option<String>,
) -> Option<(StoreFault, String)> {
    if let Destination::Folder(folder) = destination {
        match look {
            Some(Some(false)) => return Some((StoreFault::FolderGone, folder_not_there(folder))),
            Some(None) => {
                let error = format!(
                    "The backup folder {} did not answer in time.",
                    folder.root().display()
                );
                return Some((StoreFault::FolderSilent, error));
            }
            _ => {}
        }
    }
    refused.map(|error| (StoreFault::Refused, error))
}

fn counted(count: usize, one: &str, many: &str) -> String {
    match count {
        1 => format!("1 {one}"),
        count => format!("{count} {many}"),
    }
}

/// Runs one backup: skipped when nothing has changed since one written at this archive version, unless `forced`.
async fn back_up(app: &Arc<App>, forced: bool) -> Result<Outcome> {
    let destination = app.destination()?;
    let Ok(_running) = app.backups.running.try_lock() else {
        let restoring = app.backups.restoring.load(Ordering::Acquire);
        return Ok(Outcome::Running { restoring });
    };
    // A backup records itself as the server's work, which queues behind a restore.
    if forced && let Some(refusal) = app.db.writes_held() {
        return Err(refusal);
    }
    let held = app.db.read(state).await?;
    let current = held.backed_up == Some(held.changes)
        && held.backed_up_version == Some(archive::VERSION as i64);
    if !forced && held.failures == 0 && current {
        return Ok(Outcome::Unchanged);
    }
    bring_replication_forward(app).await;
    match put(app, &destination).await {
        Ok(Put {
            at,
            name,
            size,
            sent,
            changes,
            lost,
            manifest,
            mut stock,
        }) => {
            let store = destination.id();
            let (recorded, without) = (name.clone(), lost_message(&name, &lost));
            let waiting = app
                .db
                .write(Write::own(), move |tx| {
                    record_put(tx, &store, changes, &recorded, at, without.as_deref())?;
                    files_waiting(tx, &store, &recorded)
                })
                .await?
                .unwrap_or(0);
            let (removed, unremoved) = thin(app, &destination, at).await;
            let parts_removed = prune(app, &destination, &manifest, &mut stock).await;
            stock.rehash_due(app, &destination).await;
            Ok(Outcome::Put {
                instance: app.instance_id.clone(),
                name,
                taken: at,
                size,
                sent,
                removed,
                unremoved,
                parts_removed,
                lost,
                waiting,
            })
        }
        Err(refused) => {
            let (message, at) = (refused.message.to_string(), app.clock.instant());
            let in_store = refused.code == Code::BlobStoreUnavailable;
            if let Err(error) = app
                .db
                .write(Write::own(), move |tx| {
                    record_failure(tx, &message, at, in_store)
                })
                .await
            {
                tracing::error!(%error, "A failed backup was not recorded");
            }
            Err(refused)
        }
    }
}

/// What the failure record says of a backup put without the files in `lost`.
fn lost_message(name: &str, lost: &[String]) -> Option<String> {
    const SHOWN: usize = 10;
    if lost.is_empty() {
        return None;
    }
    let mut shown = lost[..lost.len().min(SHOWN)].join(", ");
    if lost.len() > SHOWN {
        shown.push_str(&format!(" and {} more", lost.len() - SHOWN));
    }
    let count = counted(lost.len(), "file", "files");
    Some(format!(
        "The backup {name} was put without {count} that no store could give when it was taken: \
         {shown}. A restore of it goes ahead without them. Upload their bytes again to back them \
         up."
    ))
}

/// Brings replication forward, so the copies a backup leaves to the store are made soon.
async fn bring_replication_forward(app: &Arc<App>) {
    let at = app.clock.stamp();
    let brought = app
        .db
        .write(Write::own(), move |tx| {
            housekeeping::bring_forward(tx, REPLICATION, &at)
        })
        .await;
    if let Err(error) = brought {
        tracing::warn!(%error, "A backup did not bring replication forward");
    }
}

/// Stores each part the destination does not hold, checks every part the backup names is there
/// whole, and only then writes its manifest, so a listed backup names only parts that are there.
/// In the backup folder the parts are stored only once every file the backup names has a copy
/// there or is known to be lost.
async fn put(app: &Arc<App>, destination: &Destination) -> Result<Put> {
    settle_attempts(app, destination).await?;
    if let Destination::Folder(folder) = destination {
        let cleared = folder.clone();
        blocking(move || cleared.clear_leftovers())
            .await
            .map_err(|error| {
                destination.unreachable("clearing what an earlier backup left", &error)
            })?;
    }
    let mut stock = Stock::load(app, destination).await?;
    let reuse = reusable(app, destination, &mut stock).await;
    let began = std::time::Instant::now();
    let mut taken = app.backup_archive(&destination.id(), reuse).await?;
    app.faults.hold(HOLD_BACKUP_READ, None).await;
    let read_ms = began.elapsed().as_millis() as u64;
    let (at, changes) = (taken.created_at, taken.changes);
    let name = name_of(at);
    let (files, in_store) = (
        std::mem::take(&mut taken.files),
        std::mem::take(&mut taken.in_store),
    );
    let held: HashSet<&String> = in_store.iter().collect();
    let uncopied: Vec<String> = files
        .iter()
        .filter(|hash| !held.contains(hash))
        .cloned()
        .collect();
    hold(app, &destination.id(), &name, files, in_store).await?;
    let copied = uncopied.len();
    let mut shared = None;
    let lost = match destination {
        Destination::Bucket(_) => readable_nowhere(app, uncopied).await?,
        Destination::Folder(folder) => {
            copy_files(app, destination, folder, uncopied, &mut shared).await?
        }
    };
    let Parted { archive, parts } = taken.parts(app, &lost).await?;
    let pause = Held::new(app);
    let mut storing = HashSet::new();
    let mut first = HashSet::new();
    let mut incoming = 0u64;
    for (at, Out { part, bytes }) in parts.iter().enumerate() {
        if let Some(sealed) = bytes
            && !stock.whole(app, destination, part).await?
            && first.insert(&part.sha256)
        {
            storing.insert(at);
            incoming = incoming.saturating_add(sealed.size);
        }
    }
    let manifest = Manifest::new(archive, parts.iter().map(|out| out.part.clone()).collect());
    let written = manifest.to_bytes()?;
    if let Destination::Folder(folder) = destination
        && let Some(why) = folder_shortfall(
            app,
            folder.root(),
            &mut shared,
            incoming.saturating_add(written.len() as u64),
        )
        .await
    {
        return Err(destination.failed_while("writing the backup", &why));
    }
    let last = storing.iter().max().copied();
    let mut sent = 0u64;
    for (at, Out { part, bytes }) in parts.into_iter().enumerate() {
        if let Some(sealed) = bytes
            && storing.contains(&at)
        {
            let opened =
                tokio::task::spawn_blocking(move || sealed.open().map(|file| (sealed, file)))
                    .await
                    .map_err(|_| Refusal::internal("a backup's part did not open"))?;
            let (sealed, file) = opened.map_err(|error| {
                Refusal::internal(&format!("a backup's part did not open: {error}"))
            })?;
            let bytes = pause.watch(
                parts::checked(
                    super::blobs::store::file_stream(file, 0, sealed.size),
                    &part,
                ),
                last == Some(at),
            );
            let (_, tag) = destination
                .put(
                    app,
                    Area::Parts,
                    &parts::name_of(&part.sha256),
                    sealed.size,
                    bytes,
                )
                .await
                .map_err(|error| {
                    if parts::Changed::is(&error) {
                        Refusal::internal(
                            "a part of the backup changed on the server's disk before it was stored",
                        )
                    } else {
                        destination.unreachable("storing a part of the backup", &error)
                    }
                })?;
            stock.stored(app, &part, tag).await?;
            sent += part.size_bytes;
        }
    }
    pause.once().await;
    stock
        .relist(app, destination, "checking the backup's parts")
        .await?;
    let mut absent = Vec::new();
    for part in &manifest.parts {
        if !stock.whole(app, destination, part).await? {
            absent.push(parts::name_of(&part.sha256));
        }
    }
    absent.sort();
    absent.dedup();
    if !absent.is_empty() {
        let why = format!(
            "{} the backup names {} not there whole once stored: {}",
            counted(absent.len(), "part", "parts"),
            if absent.len() == 1 { "is" } else { "are" },
            absent.join(", ")
        );
        return Err(destination.failed_while("checking the backup's parts", &why));
    }
    let length = written.len() as u64;
    let body = stream::once(async move { Ok(Bytes::from(written)) }).boxed();
    destination
        .put(app, Area::Backups, &name, length, body)
        .await
        .map_err(|error| {
            app.backups.unsettled().insert(name.clone());
            destination.unreachable("writing the backup's manifest", &error)
        })?;
    let size = manifest.size(length);
    tracing::info!(
        backup = %name,
        destination = destination.kind(),
        size,
        sent,
        copied,
        lost = lost.len(),
        hashed = stock.hashed(),
        read_ms,
        put_ms = began.elapsed().as_millis() as u64 - read_ms,
        "A backup was put"
    );
    Ok(Put {
        at,
        name,
        size,
        sent,
        changes,
        lost,
        manifest,
        stock,
    })
}

/// The parts `named` names that `present` does not hold at the size named.
fn absent_parts(named: &[Part], present: &HashMap<String, Stored>) -> Vec<String> {
    let mut absent: Vec<String> = named
        .iter()
        .filter(|part| present.get(&part.sha256).map(|stored| stored.size) != Some(part.size_bytes))
        .map(|part| parts::name_of(&part.sha256))
        .collect();
    absent.sort();
    absent.dedup();
    absent
}

/// The parts of rows the last backup put names that the destination holds whole, by their mark. A
/// part is taken again only where its tables' mark is unchanged, so a failure here costs only
/// reading the rows again.
async fn reusable(
    app: &Arc<App>,
    destination: &Destination,
    stock: &mut Stock,
) -> HashMap<String, Part> {
    let last = match app.db.read(|tx| Ok(state(tx)?.last_backup)).await {
        Ok(Some(last)) => last,
        Ok(None) => return HashMap::new(),
        Err(error) => {
            tracing::warn!(error = %error.message, "The last backup was not looked up, so every row is read");
            return HashMap::new();
        }
    };
    let read = destination
        .manifest(&app.instance_id, &last, app.blob_read_idle())
        .await;
    let manifest = match read {
        Ok(Some((_, Ok(manifest)))) => manifest,
        Ok(Some((_, Err(why)))) => {
            tracing::warn!(backup = %last, %why, "The last backup's manifest does not read, so every row is read");
            return HashMap::new();
        }
        Ok(None) => return HashMap::new(),
        Err(error) => {
            tracing::warn!(%error, "The last backup's manifest was not read, so every row is read");
            return HashMap::new();
        }
    };
    let mut reuse = HashMap::new();
    for part in manifest.parts {
        let Some(mark) = part.mark.clone().filter(|_| part.entry == archive::ROWS) else {
            continue;
        };
        match stock.whole(app, destination, &part).await {
            Ok(true) => {
                reuse.insert(mark, part);
            }
            Ok(false) => {}
            Err(error) => {
                tracing::warn!(error = %error.message, "A part of the last backup was not checked, so every row is read");
                return HashMap::new();
            }
        }
    }
    reuse
}

/// Deletes each part in this instance's folder of parts that no backup names. It reads first the
/// manifest of every backup the folder lists, the database records or the server found, and
/// deletes nothing if one does not read, a store does not answer, or a manifest whose write failed
/// may still land. A found backup the folder no longer lists keeps its parts until the server
/// forgets it. Once every manifest reads, it checks each part a backup names as `Stock::whole`
/// does, so a part changed since it was stored or hashed shows in health. Folder parts whose hash
/// is due are hashed by `Stock::rehash_due` whether or not this reads every manifest, but for a
/// part this finds no backup names. Answers how many parts it deleted.
async fn prune(
    app: &Arc<App>,
    destination: &Destination,
    put: &Manifest,
    stock: &mut Stock,
) -> usize {
    let own = app.instance_id.clone();
    let listed = match destination.list_in(Area::Backups, &own).await {
        Ok(listed) => listed,
        Err(error) => {
            tracing::warn!(%error, "The backups were not listed, so no part was deleted");
            return 0;
        }
    };
    let looked = destination.id().to_string();
    let read = app
        .db
        .read(move |tx| {
            let recorded: HashSet<String> = tx
                .prepare_cached("SELECT name FROM backups WHERE store_id = ?1")?
                .query_map([&looked], |row| row.get(0))?
                .collect::<rusqlite::Result<_>>()?;
            Ok((recorded, found::parts_held(tx, &looked)?))
        })
        .await;
    let (recorded, found) = match read {
        Ok(read) => read,
        Err(error) => {
            tracing::warn!(error = %error.message, "The recorded backups were not read, so no part was deleted");
            return 0;
        }
    };
    let unsettled: BTreeSet<String> = {
        let mut unsettled = app.backups.unsettled();
        unsettled.retain(|name| recorded.contains(name));
        unsettled.clone()
    };
    let names: BTreeSet<String> = listed
        .into_iter()
        .map(|(name, _)| name)
        .chain(recorded)
        .chain(found.keys().cloned())
        .filter(|name| parse(name).is_some())
        .collect();
    let mut named: HashMap<String, Part> = put
        .parts
        .iter()
        .map(|part| (part.sha256.clone(), part.clone()))
        .collect();
    for name in names {
        match destination
            .manifest(&own, &name, app.blob_read_idle())
            .await
        {
            Ok(Some((_, Ok(manifest)))) => {
                for part in manifest.parts {
                    named.entry(part.sha256.clone()).or_insert(part);
                }
                app.backups.unsettled().remove(&name);
            }
            Ok(None) if unsettled.contains(&name) => {
                tracing::warn!(backup = %name, "A backup whose manifest failed to write may still land, so no part was deleted");
                return 0;
            }
            Ok(None) => {}
            Ok(Some((_, Err(why)))) => {
                tracing::warn!(backup = %name, %why, "A backup's manifest does not read, so no part was deleted");
                return 0;
            }
            Err(error) => {
                tracing::warn!(%error, backup = %name, "A backup's manifest was not read, so no part was deleted");
                return 0;
            }
        }
    }
    for part in named.values() {
        if let Err(error) = stock.whole(app, destination, part).await {
            tracing::warn!(error = %error.message, "A part a backup names was not checked");
            if error.code == Code::BlobStoreUnavailable {
                break;
            }
        }
    }
    let kept: HashSet<String> = named
        .into_keys()
        .chain(found.into_values().flatten())
        .collect();
    let mut deleted = 0;
    let unnamed: Vec<String> = stock
        .listed()
        .keys()
        .filter(|sha256| !kept.contains(*sha256))
        .cloned()
        .collect();
    for sha256 in unnamed {
        stock.unnamed(&sha256);
        match destination
            .delete(Area::Parts, &own, &parts::name_of(&sha256))
            .await
        {
            Ok(()) => {
                stock.deleted(&sha256);
                deleted += 1;
            }
            Err(error) => {
                tracing::warn!(%error, "A part no backup names was not deleted");
            }
        }
    }
    if let Err(error) = stock.forget_others(app, kept).await {
        tracing::warn!(error = %error.message, "What the server recorded of deleted parts was not forgotten");
    }
    deleted
}

/// What a backup put; `lost` names the files no store could give.
struct Put {
    at: Stamp,
    name: String,
    size: u64,
    /// The bytes of the parts it stored, which the destination did not already hold.
    sent: u64,
    changes: i64,
    lost: Vec<String>,
    manifest: Manifest,
    /// What the destination holds of the parts, as the backup left it.
    stock: Stock,
}

fn purged_while_taken(hash: &str) -> Refusal {
    Refusal::new(
        Code::Conflict,
        format!(
            "The file {hash} the backup names was purged while the backup was taken; the next \
             run takes it again."
        ),
    )
}

/// Of `hashes`, those no attached store answers that it holds whole. A file purged since the
/// archive was read refuses the run, so the next one takes it again.
async fn readable_nowhere(app: &Arc<App>, hashes: Vec<String>) -> Result<Vec<String>> {
    let mut lost = Vec::new();
    for hash in hashes {
        let Ok(parsed) = Hash::parse(&hash) else {
            continue;
        };
        let looked = hash.clone();
        if !app
            .db
            .read(move |tx| super::blobs::registered(tx, &looked))
            .await?
        {
            return Err(purged_while_taken(&hash));
        }
        if app.readable(&parsed).await? == Readable::Nowhere {
            lost.push(hash);
        }
    }
    Ok(lost)
}

/// Copies each file to the backup folder that has no copy recorded there, and answers those no
/// store could give. Any other file that is not copied fails the backup.
async fn copy_files(
    app: &Arc<App>,
    destination: &Destination,
    folder: &Arc<Folder>,
    hashes: Vec<String>,
    shared: &mut Option<bool>,
) -> Result<Vec<String>> {
    let target = Store::Folder(folder.files());
    let mut unreachable = std::collections::BTreeSet::new();
    let mut lost = Vec::new();
    for hash in hashes {
        let looked = hash.clone();
        let blob: Option<Blob> = app
            .db
            .read(move |tx| match Hash::parse(&looked) {
                Ok(parsed) => super::blobs::blob_record(tx, &parsed),
                Err(_) => Ok(None),
            })
            .await?;
        let Some(blob) = blob else {
            return Err(purged_while_taken(&hash));
        };
        let failed = match replicate_one(app, &target, &blob, &mut unreachable, shared).await? {
            Replicated::Copied | Replicated::Passed => None,
            Replicated::Unreadable => {
                lost.push(hash);
                continue;
            }
            Replicated::Failed(why) => Some(why.unwrap_or_else(|| "no copy was made".to_string())),
        };
        let (store, looked) = (target.id().to_string(), hash.clone());
        let held = app
            .db
            .read(move |tx| Ok(!super::blobs::held_in(tx, &store, [looked])?.is_empty()))
            .await?;
        if !held {
            let why = failed.unwrap_or_else(|| "another task holds it".to_string());
            return Err(destination.failed_while(&format!("copying the file {hash}"), &why));
        }
    }
    Ok(lost)
}

/// Only names it listed in its own folder, could read as a backup and recorded putting are
/// deleted.
async fn thin(app: &Arc<App>, destination: &Destination, taken: Stamp) -> (usize, usize) {
    let listed = match destination.list_in(Area::Backups, &app.instance_id).await {
        Ok(listed) => listed,
        Err(error) => {
            tracing::warn!(%error, "The backups were not listed for thinning");
            return (0, 0);
        }
    };
    let names: Vec<String> = listed.into_iter().map(|(name, _)| name).collect();
    if let Err(error) = found::survey(app, destination, &names, Some(taken)).await {
        tracing::warn!(%error, "The backups this instance did not record were not read");
    }
    let looked = destination.id().to_string();
    let put: HashSet<String> = match app
        .db
        .read(move |tx| {
            Ok(tx
                .prepare_cached("SELECT name FROM backups WHERE store_id = ?1")?
                .query_map([&looked], |row| row.get(0))?
                .collect::<rusqlite::Result<_>>()?)
        })
        .await
    {
        Ok(put) => put,
        Err(error) => {
            tracing::warn!(%error, "The recorded backups were not read for thinning");
            return (0, 0);
        }
    };
    let mut deleted = HashSet::new();
    let (mut removed, mut unremoved) = (0, 0);
    for name in doomed(&names, taken)
        .into_iter()
        .filter(|name| put.contains(name))
    {
        match destination
            .delete(Area::Backups, &app.instance_id, &name)
            .await
        {
            Ok(()) => {
                deleted.insert(name);
                removed += 1;
            }
            Err(error) => {
                tracing::warn!(%error, backup = %name, "An old backup was not deleted");
                unremoved += 1;
            }
        }
    }
    let store = destination.id().to_string();
    let listed: HashSet<String> = names.into_iter().collect();
    if let Err(error) = app
        .db
        .write(Write::own(), move |tx| {
            reconcile(tx, &store, &listed, &deleted, Some(taken))
        })
        .await
    {
        tracing::warn!(%error, "The files of deleted backups are held until the next backup");
    }
    (removed, unremoved)
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    use super::*;
    use crate::db::migrate::MIGRATIONS;

    const BUCKET: &str = "bucket";
    const HOUR_MS: i64 = 3_600_000;
    const DAY_MS: i64 = 24 * HOUR_MS;

    fn database() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(MIGRATIONS[0].sql).unwrap();
        conn
    }

    fn hash(letter: char) -> Hash {
        Hash::parse(&format!("sha256:{}", letter.to_string().repeat(64))).unwrap()
    }

    fn numbered(index: usize) -> Hash {
        Hash::parse(&format!("sha256:{index:064x}")).unwrap()
    }

    /// `hours` after the first backup.
    fn at(hours: i64) -> Stamp {
        Stamp::read("2026-11-01T00:00:00.000Z")
            .unwrap()
            .plus_ms(hours * HOUR_MS)
            .unwrap()
    }

    fn named(hours: i64) -> String {
        name_of(at(hours))
    }

    /// Registers each blob with a copy in `BUCKET`.
    fn registered(tx: &Transaction<'_>, hashes: &[&Hash]) {
        tx.execute(
            "INSERT OR IGNORE INTO stores (id, kind, locator, attached_at) \
             VALUES (?1, 's3', 'bucket', '2026-11-01T00:00:00.000Z')",
            [BUCKET],
        )
        .unwrap();
        for hash in hashes {
            tx.execute(
                "INSERT INTO blobs (hash, mime_type, size_bytes, recorded_at) \
                 VALUES (?1, 'text/plain', 1, '2026-11-01T00:00:00.000Z')",
                [hash.as_str()],
            )
            .unwrap();
            tx.execute(
                "INSERT INTO blob_copies (hash, store_id, object, written, recorded_at) \
                 VALUES (?1, ?2, ?1, 1, '2026-11-01T00:00:00.000Z')",
                params![hash.as_str(), BUCKET],
            )
            .unwrap();
        }
    }

    fn drop_copy(tx: &Transaction<'_>, hash: &Hash) {
        tx.execute(
            "DELETE FROM blob_copies WHERE hash = ?1 AND store_id = ?2",
            params![hash.as_str(), BUCKET],
        )
        .unwrap();
    }

    fn files(hashes: &[&Hash]) -> Vec<String> {
        hashes
            .iter()
            .map(|hash| hash.as_str().to_string())
            .collect()
    }

    /// What `hold` writes against the snapshot `in_store`, stopping before the opens if told.
    fn attempt(
        tx: &Transaction<'_>,
        store: &str,
        name: &str,
        named: &[String],
        in_store: &[String],
        interrupted: bool,
    ) -> Result<()> {
        let (opening, closing) = plan(&open_files(tx, store)?, named.to_vec());
        let seq = begin(tx, store, name)?;
        close(tx, store, seq, &closing)?;
        if interrupted {
            return Ok(());
        }
        open(
            tx,
            store,
            seq,
            &opening,
            &in_store.iter().cloned().collect(),
        )
    }

    /// What `hold` writes, the copies of the snapshot being those in `BUCKET` now.
    fn hold(tx: &Transaction<'_>, store: &str, name: &str, named: &[String]) -> Result<()> {
        let in_store = super::super::blobs::held_in(tx, store, named.iter().cloned())?;
        attempt(tx, store, name, named, &in_store, false)
    }

    fn names(listed: &[&str]) -> HashSet<String> {
        listed.iter().map(|name| name.to_string()).collect()
    }

    /// One backup at the start of each day in `days` after the first backup.
    fn daily(days: std::ops::RangeInclusive<i64>) -> Vec<String> {
        days.map(|day| named(day * 24)).collect()
    }

    fn refs(names: &[String]) -> Vec<&str> {
        names.iter().map(String::as_str).collect()
    }

    fn settled(tx: &Transaction<'_>, listed: &[&str], deleted: &[&str], now: Stamp) {
        reconcile(tx, BUCKET, &names(listed), &names(deleted), Some(now)).unwrap();
    }

    #[test]
    fn a_backup_listings_omit_after_the_clock_is_put_back_keeps_its_holds_while_thinning_keeps_it()
    {
        let mut conn = database();
        let tx = conn.transaction().unwrap();
        let a = hash('a');
        registered(&tx, &[&a]);
        let mut listed = daily(1..=32);
        for name in &listed {
            hold(&tx, BUCKET, name, &[]).unwrap();
        }
        // The clock is put back before those 32 days; a new backup holds a file.
        let fresh = named(0);
        hold(&tx, BUCKET, &fresh, &files(&[&a])).unwrap();
        record_put(&tx, BUCKET, 0, &fresh, at(0), None).unwrap();
        let next = named(1);
        hold(&tx, BUCKET, &next, &[]).unwrap();
        listed.push(next);
        let mut complete = listed.clone();
        complete.push(fresh.clone());
        assert!(!doomed(&complete, at(1)).contains(&fresh));
        assert_eq!(held_of(&tx, &[&a]), ['a']);
        for hour in 1..=3 {
            settled(&tx, &refs(&listed), &[], at(hour));
        }
        assert_eq!(
            held_of(&tx, &[&a]),
            ['a'],
            "listings omitting it released a backup thinning keeps"
        );
    }

    fn held_of(tx: &Transaction<'_>, hashes: &[&Hash]) -> Vec<char> {
        held_in(tx, BUCKET, hashes)
    }

    fn held_in(tx: &Transaction<'_>, store: &str, hashes: &[&Hash]) -> Vec<char> {
        let asked: Vec<Hash> = hashes.iter().map(|hash| (*hash).clone()).collect();
        let held = held(tx, store, &asked).unwrap();
        let mut letters: Vec<char> = held
            .iter()
            .map(|hash| hash.hex().chars().next().unwrap())
            .collect();
        letters.sort();
        letters
    }

    fn count(tx: &Transaction<'_>, sql: &str) -> i64 {
        tx.query_row(sql, [], |row| row.get(0)).unwrap()
    }

    #[test]
    fn a_file_is_held_while_a_kept_backup_named_it_and_let_go_once_thinning_deletes_it() {
        let mut conn = database();
        let tx = conn.transaction().unwrap();
        let (a, b, c) = (hash('a'), hash('b'), hash('c'));
        registered(&tx, &[&a, &b, &c]);
        let (first, second, third) = (named(0), named(1), named(2));

        hold(&tx, BUCKET, &first, &files(&[&a, &b])).unwrap();
        hold(&tx, BUCKET, &second, &files(&[&b])).unwrap();
        settled(&tx, &[&first, &second], &[], at(2));
        assert_eq!(held_of(&tx, &[&a, &b, &c]), ['a', 'b']);

        hold(&tx, BUCKET, &third, &files(&[&b])).unwrap();
        settled(&tx, &[&first, &second, &third], &[&first], at(3));
        assert_eq!(held_of(&tx, &[&a, &b, &c]), ['b']);
        assert_eq!(count(&tx, "SELECT COUNT(*) FROM backup_files"), 1);
    }

    #[test]
    fn a_file_named_again_after_a_gap_is_held_by_the_backup_before_the_gap() {
        let mut conn = database();
        let tx = conn.transaction().unwrap();
        let a = hash('a');
        registered(&tx, &[&a]);
        let backups: Vec<String> = (0..4).map(named).collect();

        hold(&tx, BUCKET, &backups[0], &files(&[&a])).unwrap();
        hold(&tx, BUCKET, &backups[1], &[]).unwrap();
        hold(&tx, BUCKET, &backups[2], &files(&[&a])).unwrap();
        hold(&tx, BUCKET, &backups[3], &[]).unwrap();
        settled(
            &tx,
            &[&backups[0], &backups[3]],
            &[&backups[1], &backups[2]],
            at(4),
        );
        assert_eq!(held_of(&tx, &[&a]), ['a']);
        settled(&tx, &[&backups[3]], &[&backups[0]], at(4));
        assert!(held_of(&tx, &[&a]).is_empty());
    }

    #[test]
    fn a_name_a_kept_backup_has_is_not_taken_again_and_its_holds_stay() {
        let mut conn = database();
        let tx = conn.transaction().unwrap();
        let a = hash('a');
        registered(&tx, &[&a]);

        hold(&tx, BUCKET, &named(0), &files(&[&a])).unwrap();
        hold(&tx, BUCKET, &named(1), &[]).unwrap();
        let refused = hold(&tx, BUCKET, &named(0), &[]).unwrap_err();
        assert_eq!(refused.code, Code::Conflict);
        assert_eq!(held_of(&tx, &[&a]), ['a']);
    }

    #[test]
    fn an_attempt_listings_omit_keeps_its_holds_until_one_names_it() {
        let mut conn = database();
        let tx = conn.transaction().unwrap();
        let a = hash('a');
        registered(&tx, &[&a]);
        let (late, next) = (named(0), named(1));

        hold(&tx, BUCKET, &late, &files(&[&a])).unwrap();
        settled(&tx, &[], &[], at(1));
        hold(&tx, BUCKET, &next, &[]).unwrap();
        record_put(&tx, BUCKET, 0, &next, at(1), None).unwrap();
        settled(&tx, &[&next], &[], at(1));
        assert_eq!(held_of(&tx, &[&a]), ['a']);

        settled(&tx, &[&late, &next], &[], at(2));
        assert_eq!(
            count(&tx, "SELECT COUNT(*) FROM backups WHERE confirmed = 0"),
            0
        );
        assert_eq!(held_of(&tx, &[&a]), ['a']);
    }

    #[test]
    fn a_kept_backup_one_listing_omits_keeps_its_holds_until_it_is_deleted() {
        let mut conn = database();
        let tx = conn.transaction().unwrap();
        let a = hash('a');
        registered(&tx, &[&a]);
        let (first, second) = (named(0), named(1));

        hold(&tx, BUCKET, &first, &files(&[&a])).unwrap();
        record_put(&tx, BUCKET, 0, &first, at(0), None).unwrap();
        hold(&tx, BUCKET, &second, &[]).unwrap();
        settled(&tx, &[&second], &[], at(1));
        assert_eq!(held_of(&tx, &[&a]), ['a']);

        settled(&tx, &[&second], &[&first], at(1));
        assert!(held_of(&tx, &[&a]).is_empty());
    }

    #[test]
    fn a_backup_waits_for_each_file_it_names_that_its_store_holds_no_copy_of() {
        let mut conn = database();
        let tx = conn.transaction().unwrap();
        let (a, b, c) = (hash('a'), hash('b'), hash('c'));
        registered(&tx, &[&a, &b, &c]);
        drop_copy(&tx, &c);
        hold(&tx, BUCKET, &named(0), &files(&[&a, &c])).unwrap();
        hold(&tx, BUCKET, &named(1), &files(&[&a, &b])).unwrap();
        assert_eq!(files_waiting(&tx, BUCKET, &named(0)).unwrap(), Some(1));
        assert_eq!(files_waiting(&tx, BUCKET, &named(1)).unwrap(), Some(0));

        drop_copy(&tx, &b);
        assert_eq!(files_waiting(&tx, BUCKET, &named(1)).unwrap(), Some(1));
        tx.execute(
            "INSERT INTO blob_copies (hash, store_id, object, written, recorded_at) \
             VALUES (?1, ?2, 'found', 0, '2026-11-01T00:00:00.000Z')",
            params![b.as_str(), BUCKET],
        )
        .unwrap();
        assert_eq!(files_waiting(&tx, BUCKET, &named(1)).unwrap(), Some(0));
        assert_eq!(files_waiting(&tx, "elsewhere", &named(1)).unwrap(), None);
    }

    #[test]
    fn a_kept_backup_one_listing_omits_after_a_failed_attempt_keeps_its_files_past_retention() {
        let mut conn = database();
        let tx = conn.transaction().unwrap();
        let a = hash('a');
        registered(&tx, &[&a]);
        let (kept, failed) = (named(0), named(1));

        hold(&tx, BUCKET, &kept, &files(&[&a])).unwrap();
        record_put(&tx, BUCKET, 0, &kept, at(0), None).unwrap();
        hold(&tx, BUCKET, &failed, &[]).unwrap();
        settled(&tx, &refs(&daily(1..=40)), &[], at(40 * 24));

        assert_eq!(held_of(&tx, &[&a]), ['a']);
        assert_eq!(count(&tx, "SELECT COUNT(*) FROM backups"), 2);
    }

    #[test]
    fn a_backup_is_forgotten_once_three_listings_omit_it_and_thinning_over_them_would_delete_it() {
        let mut conn = database();
        let tx = conn.transaction().unwrap();
        let a = hash('a');
        registered(&tx, &[&a]);
        let (lost, next) = (named(0), named(1));

        hold(&tx, BUCKET, &lost, &files(&[&a])).unwrap();
        settled(&tx, &[], &[], at(0).plus_ms(400 * DAY_MS).unwrap());
        assert_eq!(held_of(&tx, &[&a]), ['a']);

        hold(&tx, BUCKET, &next, &[]).unwrap();
        let (month, more) = (daily(1..=30), daily(1..=32));
        let mut ahead = month.clone();
        ahead.push(named(400 * 24));
        settled(&tx, &[], &[], at(1));
        settled(&tx, &refs(&month), &[], at(2));
        settled(&tx, &refs(&ahead), &[], at(3));
        assert_eq!(held_of(&tx, &[&a]), ['a']);
        settled(&tx, &refs(&ahead), &[], at(31 * 24));
        assert_eq!(held_of(&tx, &[&a]), ['a']);
        settled(&tx, &refs(&more), &[], at(32 * 24));
        assert!(held_of(&tx, &[&a]).is_empty());
        assert_eq!(count(&tx, "SELECT COUNT(*) FROM backups"), 1);
        assert_eq!(count(&tx, "SELECT COUNT(*) FROM backup_files"), 0);
    }

    #[test]
    fn a_listing_that_shows_a_backup_again_restarts_the_count_of_listings_that_omit_it() {
        let mut conn = database();
        let tx = conn.transaction().unwrap();
        let (a, lost) = (hash('a'), named(0));
        registered(&tx, &[&a]);
        let later = daily(1..=40);
        let mut showing = later.clone();
        showing.push(lost.clone());
        let after = |hours: i64| at(41 * 24 + hours);

        hold(&tx, BUCKET, &lost, &files(&[&a])).unwrap();
        hold(&tx, BUCKET, &named(1), &[]).unwrap();
        settled(&tx, &refs(&later), &[], after(1));
        settled(&tx, &refs(&later), &[], after(2));
        settled(&tx, &refs(&showing), &[], after(3));
        settled(&tx, &refs(&later), &[], after(4));
        settled(&tx, &refs(&later), &[], after(5));
        assert_eq!(held_of(&tx, &[&a]), ['a']);
        settled(&tx, &refs(&later), &[], after(6));
        assert!(held_of(&tx, &[&a]).is_empty());
    }

    #[test]
    fn a_recorded_name_that_does_not_read_keeps_its_holds() {
        let mut conn = database();
        let tx = conn.transaction().unwrap();
        let a = hash('a');
        registered(&tx, &[&a]);

        hold(&tx, BUCKET, "stray.tar", &files(&[&a])).unwrap();
        hold(&tx, BUCKET, &named(0), &[]).unwrap();
        let later = daily(1..=40);
        for hours in 1..=3 {
            settled(&tx, &refs(&later), &[], at(hours));
        }
        assert_eq!(held_of(&tx, &[&a]), ['a']);
    }

    #[test]
    fn outside_thinning_omitted_backups_are_judged_by_the_newest_backup_or_an_earlier_clock() {
        let mut conn = database();
        let tx = conn.transaction().unwrap();
        assert_eq!(last_thinned(&tx, BUCKET, at(9)).unwrap(), None);
        hold(&tx, BUCKET, &named(7), &[]).unwrap();
        hold(&tx, BUCKET, &named(5), &[]).unwrap();
        assert_eq!(last_thinned(&tx, BUCKET, at(9)).unwrap(), Some(at(5)));
        assert_eq!(last_thinned(&tx, BUCKET, at(3)).unwrap(), Some(at(3)));
        hold(&tx, BUCKET, "stray.tar", &[]).unwrap();
        assert_eq!(last_thinned(&tx, BUCKET, at(9)).unwrap(), None);
    }

    #[test]
    fn interrupted_attempts_hold_rows_bounded_by_retention_and_clear_them_once_forgotten() {
        let mut conn = database();
        let tx = conn.transaction().unwrap();
        let hashes: Vec<Hash> = (0..1_000).map(numbered).collect();
        registered(&tx, &hashes.iter().collect::<Vec<_>>());

        let mut listed: Vec<String> = Vec::new();
        for (hour, hash) in hashes.iter().enumerate() {
            let hour = hour as i64;
            let gone = doomed(&listed, at(hour));
            listed.retain(|name| !gone.contains(name));
            settled(&tx, &refs(&listed), &refs(&gone), at(hour));
            let file = files(&[hash]);
            let interrupted = hour % 2 == 1;
            attempt(&tx, BUCKET, &named(hour), &file, &file, interrupted).unwrap();
            if !interrupted {
                listed.push(named(hour));
            }
        }
        let recorded = count(&tx, "SELECT COUNT(*) FROM backups");
        let open = count(
            &tx,
            "SELECT COUNT(*) FROM backup_files WHERE last_seq IS NULL",
        );
        let interrupted_kept = recorded - listed.len() as i64;
        // Those of the last day, and the newest of each of 31 days, which thinning keeps.
        assert!(
            (12..=13 + 31).contains(&interrupted_kept),
            "{interrupted_kept}"
        );
        assert_eq!(open, 0, "{open}");
        assert!(
            held(&tx, BUCKET, &hashes[998..])
                .unwrap()
                .contains(&hashes[998])
        );
        assert!(held(&tx, BUCKET, &hashes[1..100]).unwrap().is_empty());

        let last = named(2_000 + 32 * 24);
        hold(&tx, BUCKET, &last, &[]).unwrap();
        let later: Vec<String> = (0..=32).map(|day| named(2_000 + day * 24)).collect();
        settled(&tx, &[], &[], at(1_000));
        for hours in 1..=2 {
            settled(&tx, &refs(&later), &[], at(2_000 + 32 * 24 + hours));
        }
        assert_eq!(count(&tx, "SELECT COUNT(*) FROM backups"), 1);
        assert_eq!(count(&tx, "SELECT COUNT(*) FROM backup_files"), 0);
    }

    #[test]
    fn a_backup_never_put_holds_nothing_and_another_bucket_keeps_its_holds_after_a_thinning() {
        let mut conn = database();
        let tx = conn.transaction().unwrap();
        let (a, b) = (hash('a'), hash('b'));
        registered(&tx, &[&a, &b]);
        let (earlier, first, second) = (named(0), named(1), named(2));

        hold(&tx, "earlier bucket", &earlier, &files(&[&a])).unwrap();
        hold(&tx, BUCKET, &first, &files(&[&a])).unwrap();
        hold(&tx, BUCKET, &second, &files(&[&b])).unwrap();
        assert_eq!(held_of(&tx, &[&a, &b]), ['a', 'b']);

        settled(&tx, &[&second], &[&first], at(3));
        assert_eq!(held_of(&tx, &[&a, &b]), ['b']);
        assert_eq!(held_in(&tx, "earlier bucket", &[&a, &b]), ['a']);
        let recorded: Vec<String> = tx
            .prepare("SELECT store_id || '/' || name FROM backups ORDER BY seq")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .map(|row| row.unwrap())
            .collect();
        assert_eq!(
            recorded,
            [
                format!("earlier bucket/{earlier}"),
                format!("bucket/{second}")
            ]
        );
        assert_eq!(count(&tx, "SELECT COUNT(*) FROM backup_files"), 2);
    }

    #[test]
    fn a_file_held_in_one_bucket_stays_held_across_another_buckets_thinning() {
        let mut conn = database();
        let tx = conn.transaction().unwrap();
        let x = hash('a');
        registered(&tx, &[&x]);
        let (a1, b1, a2) = (named(0), named(1), named(2));

        hold(&tx, "bucket A", &a1, &files(&[&x])).unwrap();
        reconcile(&tx, "bucket A", &names(&[&a1]), &names(&[]), Some(at(0))).unwrap();
        hold(&tx, "bucket B", &b1, &[]).unwrap();
        reconcile(&tx, "bucket B", &names(&[&b1]), &names(&[]), Some(at(1))).unwrap();
        hold(&tx, "bucket A", &a2, &[]).unwrap();
        reconcile(
            &tx,
            "bucket A",
            &names(&[&a1, &a2]),
            &names(&[]),
            Some(at(2)),
        )
        .unwrap();

        assert_eq!(held_in(&tx, "bucket A", &[&x]), ['a']);
    }

    #[test]
    fn a_found_backup_holds_its_files_until_listings_omit_it_and_thinning_over_them_would_delete_it()
     {
        let mut conn = database();
        let tx = conn.transaction().unwrap();
        let (a, b) = (hash('a'), hash('b'));
        registered(&tx, &[&a, &b]);
        let found = named(5);
        tx.execute(
            "INSERT INTO found_backups (store_id, name, files_read) VALUES (?1, ?2, 1)",
            params![BUCKET, found],
        )
        .unwrap();
        tx.execute(
            "INSERT INTO found_backup_files (seq, hash) SELECT seq, ?1 FROM found_backups",
            [a.as_str()],
        )
        .unwrap();
        assert_eq!(held_of(&tx, &[&a, &b]), ['a']);
        assert_eq!(begin(&tx, BUCKET, &found).unwrap_err().code, Code::Conflict);

        let mut ahead = daily(1..=30);
        ahead.push(named(400 * 24));
        for now in [at(6), at(7), at(8)] {
            found::settle(&tx, BUCKET, &names(&refs(&ahead)), Some(now)).unwrap();
        }
        assert_eq!(held_of(&tx, &[&a, &b]), ['a']);
        found::settle(&tx, BUCKET, &names(&refs(&daily(1..=32))), Some(at(9))).unwrap();
        assert_eq!(held_of(&tx, &[&a, &b]), ['a']);
        found::settle(
            &tx,
            BUCKET,
            &names(&refs(&daily(1..=32))),
            Some(at(33 * 24)),
        )
        .unwrap();
        assert!(held_of(&tx, &[&a, &b]).is_empty());
        assert_eq!(count(&tx, "SELECT COUNT(*) FROM found_backup_files"), 0);
    }

    #[test]
    fn a_backup_is_refused_when_a_file_its_snapshot_held_was_purged_before_the_hold() {
        let mut conn = database();
        let tx = conn.transaction().unwrap();
        let (a, b) = (hash('a'), hash('b'));
        registered(&tx, &[&a]);

        hold(&tx, BUCKET, &named(0), &files(&[&a])).unwrap();
        tx.execute("DELETE FROM blobs WHERE hash = ?1", [a.as_str()])
            .unwrap();
        // Held since the first backup, so a second one naming it is not refused.
        hold(&tx, BUCKET, &named(1), &files(&[&a])).unwrap();

        let refused = hold(&tx, BUCKET, &named(2), &files(&[&a, &b])).unwrap_err();
        assert_eq!(refused.code, Code::Conflict);
        assert!(refused.message.contains(b.as_str()), "{}", refused.message);
    }

    #[test]
    fn a_backup_is_refused_when_a_copy_its_snapshot_found_in_the_bucket_was_dropped_before_the_hold()
     {
        let mut conn = database();
        let tx = conn.transaction().unwrap();
        let (a, b) = (hash('a'), hash('b'));
        registered(&tx, &[&a, &b]);
        let snapshot = files(&[&a, &b]);

        drop_copy(&tx, &b);
        let refused = attempt(&tx, BUCKET, &named(0), &snapshot, &snapshot, false).unwrap_err();
        assert_eq!(refused.code, Code::Conflict);
        assert!(refused.message.contains(b.as_str()), "{}", refused.message);

        attempt(&tx, BUCKET, &named(1), &snapshot, &files(&[&a]), false).unwrap();
        assert_eq!(held_of(&tx, &[&a, &b]), ['a', 'b']);
    }

    #[tokio::test]
    async fn the_object_store_path_refuses_a_file_purged_since_its_read_and_counts_one_held_nowhere_as_lost()
     {
        let dir = tempfile::TempDir::new().unwrap();
        let (database, blobs, socket) = (
            dir.path().join("marfa.db"),
            dir.path().join("blobs"),
            dir.path().join("s.sock"),
        );
        let pairs = [
            ("MARFA_DATABASE_PATH", database.to_str().unwrap()),
            ("MARFA_BLOB_PATH", blobs.to_str().unwrap()),
            ("MARFA_CONTROL_SOCKET", socket.to_str().unwrap()),
        ];
        let settings =
            crate::settings::Settings::read(crate::settings::Environment::from_pairs(&pairs))
                .unwrap();
        let app = App::start(settings).await.unwrap();
        let (held_nowhere, purged) = (hash('a'), hash('b'));
        let recorded = held_nowhere.as_str().to_string();
        app.db
            .write(Write::own(), move |tx| {
                tx.execute(
                    "INSERT INTO blobs (hash, mime_type, size_bytes, recorded_at) \
                     VALUES (?1, 'text/plain', 1, '2026-01-01T00:00:00.000Z')",
                    [&recorded],
                )?;
                Ok(())
            })
            .await
            .unwrap();

        let lost = readable_nowhere(&app, vec![held_nowhere.as_str().to_string()])
            .await
            .unwrap();
        assert_eq!(lost, [held_nowhere.as_str()]);

        let refused = readable_nowhere(
            &app,
            vec![
                held_nowhere.as_str().to_string(),
                purged.as_str().to_string(),
            ],
        )
        .await
        .unwrap_err();
        assert_eq!(refused.code, Code::Conflict);
        assert!(
            refused.message.contains(purged.as_str()),
            "{}",
            refused.message
        );
    }

    #[cfg(feature = "test-hooks")]
    #[tokio::test]
    async fn thinning_judges_a_found_backup_the_listing_omits_by_the_backup_just_put_not_the_clock()
    {
        let (dir, folder) = (
            tempfile::TempDir::new().unwrap(),
            tempfile::TempDir::new().unwrap(),
        );
        let (database, blobs, socket) = (
            dir.path().join("marfa.db"),
            dir.path().join("blobs"),
            dir.path().join("s.sock"),
        );
        let pairs = [
            ("MARFA_DATABASE_PATH", database.to_str().unwrap()),
            ("MARFA_BLOB_PATH", blobs.to_str().unwrap()),
            ("MARFA_CONTROL_SOCKET", socket.to_str().unwrap()),
            ("MARFA_BACKUP_PATH", folder.path().to_str().unwrap()),
            ("MARFA_BACKUP_INTERVAL_SECONDS", "31536000"),
        ];
        let settings =
            crate::settings::Settings::read(crate::settings::Environment::from_pairs(&pairs))
                .unwrap();
        let app = App::start(settings).await.unwrap();
        app.clock.pause(true);
        let put = |app: Arc<App>| async move {
            match back_up(&app, true).await.unwrap() {
                Outcome::Put { name, taken, .. } => (name, taken),
                _ => panic!("no backup was put"),
            }
        };
        let (missing, _) = put(app.clone()).await;
        app.clock.advance(1).unwrap();
        put(app.clone()).await;
        let destination = app.destination().unwrap();
        let (store, found) = (destination.id(), missing.clone());
        app.db
            .write(Write::own(), move |tx| {
                tx.execute(
                    "INSERT INTO found_backups (store_id, name, files_read, omissions) \
                     VALUES (?1, ?2, 1, 2)",
                    params![store, found],
                )?;
                tx.execute("DELETE FROM backups WHERE name = ?1", [&found])?;
                Ok(())
            })
            .await
            .unwrap();
        destination
            .delete(Area::Backups, &app.instance_id, &missing)
            .await
            .unwrap();

        app.clock.advance(23 * HOUR_MS as u64 - 1).unwrap();
        let (_, taken) = put(app.clone()).await;
        app.clock.advance(2 * HOUR_MS as u64).unwrap();
        thin(&app, &destination, taken).await;
        let omissions = || {
            let (store, found) = (destination.id(), missing.clone());
            app.db.read(move |tx| {
                Ok(tx
                    .prepare_cached(
                        "SELECT omissions FROM found_backups WHERE store_id = ?1 AND name = ?2",
                    )?
                    .query_row(params![store, found], |row| row.get(0))
                    .optional()?)
            })
        };
        assert_eq!(
            omissions().await.unwrap(),
            Some(4),
            "{missing} at {taken:?}"
        );

        app.clock.advance(10 * HOUR_MS as u64).unwrap();
        found::survey_folder(&app).await.unwrap();
        assert_eq!(
            omissions().await.unwrap(),
            Some(5),
            "{missing} at {taken:?}"
        );

        put(app.clone()).await;
        assert_eq!(omissions().await.unwrap(), None);
    }

    #[test]
    fn a_refusal_by_another_store_is_not_the_destinations() {
        let result = json!({
            "copied": 0,
            "remaining": 2,
            "refused": { "blob-folder": "The blob folder did not take a copy: no room." },
        });
        assert_eq!(refused_by(&result, "bucket"), None);
        assert_eq!(
            refused_by(&result, "blob-folder").as_deref(),
            Some("The blob folder did not take a copy: no room.")
        );
        assert_eq!(refused_by(&json!({ "copied": 1 }), "bucket"), None);
    }
}
