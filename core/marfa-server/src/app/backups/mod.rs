//! Backups: an archive without files, put as one object under `<prefix>/backups/<instance id>/`
//! in the object store, or as one file under `backups/<instance id>/` in the backup folder.

mod found;
mod names;

use std::collections::HashSet;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use bytes::Bytes;
use futures_util::StreamExt;
use futures_util::stream::{self, BoxStream};
use rusqlite::{OptionalExtension, Transaction, params};
use serde_json::{Value, json};
use tokio::sync::Mutex;

use super::App;
use super::access::Caller;
use super::archive::{self, Backup};
use super::blobs::folder::{self as backup_folder, Adoptable, Folder};
use super::blobs::restore::{Named, Readable};
use super::blobs::s3::S3;
use super::blobs::store::{ByteStream, Store};
use super::blobs::upkeep::{Replicated, object_store_said, replicate_one};
use super::blobs::{Blob, Hash};
use super::clock::Stamp;
use super::faults::{HOLD_BACKUP_PUT, HOLD_BACKUP_READ, HOLD_DISK_PROBE};
use super::housekeeping::{self, Report, Run};
use super::refusal::{Code, Refusal, Result};
use crate::db::Write;
use crate::settings::registry::BACKUP_INTERVAL_SECONDS;

pub use found::survey_folder;
pub use names::{Listed, doomed, instance_of, name_of, parse};

/// The folder under the object store's prefix that holds a folder of backups per instance.
pub const FOLDER: &str = "backups";
const LIST_DEADLINE: Duration = Duration::from_secs(30);
const REPLICATION: &str = "blob-replicate";

/// One backup at a time, whether the schedule or the owner asked for it.
#[derive(Debug, Default)]
pub struct Backups {
    running: Mutex<()>,
    /// Set while a look at the backup folder is in flight, which a mount that hangs holds.
    looking: Arc<AtomicBool>,
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

/// How many files the backup `name` in `store` names that the store holds no copy of, or `None`
/// when it is not recorded there.
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

/// How many listings must omit a backup, once it is past retention, before it is gone.
const OMISSIONS: i64 = 3;

/// A backup as the database records it.
struct Recorded {
    seq: i64,
    name: String,
    confirmed: bool,
    missing_since: Option<String>,
    omissions: i64,
}

/// Confirms listed backups; forgets one thinning deleted, or one listings have long omitted.
fn reconcile(
    tx: &Transaction<'_>,
    store: &str,
    listed: &HashSet<String>,
    deleted: &HashSet<String>,
    now: Stamp,
) -> Result<()> {
    let recorded: Vec<Recorded> = tx
        .prepare_cached(
            "SELECT seq, name, confirmed, missing_since, omissions FROM backups \
             WHERE store_id = ?1",
        )?
        .query_map([store], |row| {
            Ok(Recorded {
                seq: row.get(0)?,
                name: row.get(1)?,
                confirmed: row.get(2)?,
                missing_since: row.get(3)?,
                omissions: row.get(4)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    let newest = recorded.iter().map(|backup| backup.seq).max();
    let mut shown = tx.prepare_cached(
        "UPDATE backups SET confirmed = 1, missing_since = NULL, omissions = 0 WHERE seq = ?1",
    )?;
    let mut omitted = tx.prepare_cached(
        "UPDATE backups SET missing_since = coalesce(missing_since, ?2), omissions = ?3 \
         WHERE seq = ?1",
    )?;
    let mut forget = tx.prepare_cached("DELETE FROM backups WHERE seq = ?1")?;
    let remaining = Listed::of(listed.iter().filter(|name| !deleted.contains(*name)));
    for backup in recorded {
        let seq = backup.seq;
        if deleted.contains(&backup.name) {
            forget.execute([seq])?;
        } else if listed.contains(&backup.name) {
            if !backup.confirmed || backup.missing_since.is_some() || backup.omissions > 0 {
                shown.execute([seq])?;
            }
        } else if Some(seq) != newest {
            let Some(taken) = parse(&backup.name) else {
                tracing::error!(
                    backup = %backup.name,
                    "A recorded backup's name does not read, so the files it names stay held"
                );
                continue;
            };
            let omissions = backup.omissions.saturating_add(1);
            let since = match backup.missing_since.as_deref().map(Stamp::parsed) {
                None => now,
                Some(Some(since)) => since,
                Some(None) => {
                    tracing::error!(
                        backup = %backup.name,
                        "When listings began to omit a recorded backup does not read, so the \
                         files it names stay held"
                    );
                    continue;
                }
            };
            if omissions >= OMISSIONS && remaining.past_retention(since.max(taken)) {
                forget.execute([seq])?;
            } else {
                omitted.execute(params![seq, now, omissions])?;
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

    /// The backups directly in `instance`'s folder, by name and size.
    async fn list_in(&self, instance: &str) -> std::io::Result<Vec<(String, u64)>> {
        match self {
            Destination::Bucket(bucket) => {
                let own = format!("{FOLDER}/{instance}");
                super::blobs::store::within(LIST_DEADLINE, bucket.list_in(&own)).await
            }
            Destination::Folder(folder) => {
                let (folder, instance) = (folder.clone(), instance.to_string());
                blocking(move || folder.list_in(&instance)).await
            }
        }
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

    /// The backup `name` of `instance`, with its size.
    async fn get(
        &self,
        instance: &str,
        name: &str,
        idle: Duration,
    ) -> std::io::Result<Option<(u64, ByteStream)>> {
        let found = match self {
            Destination::Bucket(bucket) => {
                let key = key_of(instance, name);
                super::blobs::store::within(
                    super::blobs::store::CHECK_DEADLINE,
                    bucket.get_whole(&key),
                )
                .await?
            }
            Destination::Folder(folder) => {
                let (folder, instance, name) =
                    (folder.clone(), instance.to_string(), name.to_string());
                blocking(move || folder.open_backup(&instance, &name))
                    .await?
                    .map(|(size, file)| (size, super::blobs::store::file_stream(file, 0, size)))
            }
        };
        Ok(found.map(|(size, bytes)| (size, super::blobs::store::idle_limited(bytes, idle))))
    }

    /// Deletes this instance's backup `name`.
    async fn delete(&self, instance: &str, name: &str) -> std::io::Result<()> {
        match self {
            Destination::Bucket(bucket) => {
                let key = key_of(instance, name);
                super::blobs::store::within(LIST_DEADLINE, bucket.delete_whole(&key)).await
            }
            Destination::Folder(folder) => {
                let (folder, name) = (folder.clone(), name.to_string());
                blocking(move || folder.delete(&name)).await
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
        .list_in(&app.instance_id)
        .await
        .map_err(|error| destination.unreachable("checking the last backup", &error))?
        .into_iter()
        .map(|(name, _)| name)
        .collect();
    let now = app.clock.instant();
    app.db
        .write(Write::own(), move |tx| {
            reconcile(tx, &store, &listed, &HashSet::new(), now)
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

fn running() -> Refusal {
    Refusal::new(
        Code::HousekeepingJobRunning,
        "A backup is running; try again once it ends.",
    )
}

/// Whether the schedule runs backups here: a destination is set and the interval is not 0.
pub fn scheduled(app: &App) -> bool {
    Destination::of(app).is_some() && app.settings.live().get(BACKUP_INTERVAL_SECONDS) > 0
}

fn key_of(instance: &str, name: &str) -> String {
    format!("{FOLDER}/{instance}/{name}")
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
        removed: usize,
        unremoved: usize,
        /// The files the backup names that no store could give.
        lost: Vec<String>,
        /// How many files it names that the destination did not yet hold once it was put.
        waiting: u64,
    },
    Unchanged,
    Running,
}

impl Outcome {
    /// A housekeeping report holds only numbers, flags and text.
    fn report(&self) -> Value {
        match self {
            Outcome::Put {
                name,
                size,
                removed,
                unremoved,
                lost,
                waiting,
                ..
            } => json!({
                "outcome": "put",
                "backup": name,
                "size_bytes": size,
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
                removed,
                unremoved,
                lost,
                waiting,
            } => json!({
                "outcome": "put",
                "backup": listed(instance, name, *taken, *size),
                "removed": removed,
                "unremoved": unremoved,
                "blobs_lost": lost,
                "blobs_waiting": waiting,
            }),
            Outcome::Unchanged => json!({ "outcome": "unchanged" }),
            Outcome::Running => json!({ "outcome": "running" }),
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

struct Sending {
    body: super::archive::Body,
    faults: Arc<super::faults::Faults>,
    sent: u64,
    held: bool,
}

/// The archive's bytes as a stream, held at `backup:put` once the put has some in hand.
fn put_stream(app: &Arc<App>, backup: Backup) -> BoxStream<'static, std::io::Result<Bytes>> {
    let sending = Sending {
        body: backup.body,
        faults: app.faults.clone(),
        sent: 0,
        held: false,
    };
    stream::unfold(sending, |mut sending| async move {
        let chunk = std::future::poll_fn(|context| sending.body.poll_chunk(context)).await;
        if let Some(Ok(bytes)) = &chunk {
            sending.sent += bytes.len() as u64;
        }
        let due = match &chunk {
            None => true,
            Some(Ok(_)) => sending.sent > HELD_AFTER,
            Some(Err(_)) => false,
        };
        if due && !sending.held {
            sending.held = true;
            sending.faults.hold(HOLD_BACKUP_PUT, None).await;
        }
        chunk.map(|chunk| (chunk, sending))
    })
    .boxed()
}

impl App {
    fn destination(&self) -> Result<Destination> {
        Destination::of(self).ok_or_else(no_backup_destination)
    }

    /// The backups where this instance keeps them, of every instance that put them there, newest
    /// first.
    pub async fn list_backups(&self, caller: &Caller) -> Result<Vec<Value>> {
        caller.require_local()?;
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
        Ok(backups
            .into_iter()
            .map(|(created_at, instance, name, size)| listed(&instance, &name, created_at, size))
            .collect())
    }

    /// Puts a backup now, whether or not anything has changed since the last.
    pub async fn run_backup(self: &Arc<App>, caller: &Caller) -> Result<Value> {
        caller.require_local()?;
        let app = self.clone();
        let outcome = tokio::spawn(async move { back_up(&app, true).await })
            .await
            .map_err(|_| Refusal::internal("a backup's task ended early"))??;
        match outcome {
            Outcome::Running => Err(running()),
            outcome => Ok(outcome.to_json()),
        }
    }

    /// Restores the named backup of `instance`, read by the server itself from where it keeps
    /// backups. From the backup folder, every file the backup names is read from the folder too.
    pub async fn restore_backup(
        self: &Arc<App>,
        caller: &Caller,
        started_at: String,
        instance: &str,
        name: &str,
    ) -> Result<Value> {
        caller.require_local()?;
        let destination = self.destination()?;
        if !instance_of(instance) || parse(name).is_none() {
            return Err(destination.not_found(instance, name));
        }
        let found = destination
            .get(instance, name, self.blob_read_idle())
            .await
            .map_err(|error| destination.unreachable("reading the backup", &error))?;
        let Some((size, mut bytes)) = found else {
            return Err(destination.not_found(instance, name));
        };
        let mut receiving = self.begin_restore(Some(size)).await?;
        while let Some(chunk) = bytes.next().await {
            match chunk {
                Ok(chunk) => receiving.push(chunk).await?,
                Err(error) => {
                    receiving.abandon().await;
                    return Err(destination.unreachable("reading the backup", &error));
                }
            }
        }
        let mut received = receiving.finish().await?;
        let carries_files = match &destination {
            Destination::Bucket(_) => true,
            Destination::Folder(folder) => {
                let reading = self.files_to_read(folder, instance, &received).await?;
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
                if !unread.is_empty() {
                    return Err(archive::restore::files_missing(unread));
                }
                received.carried.extend(copies);
                true
            }
        };
        let mut answer = self
            .restore(caller, started_at, received, carries_files)
            .await
            .map_err(|refused| match destination {
                Destination::Bucket(_) => lacking_in_bucket(refused),
                Destination::Folder(_) => refused,
            })?;
        answer["backup"] = json!({ "name": name, "instance_id": instance });
        Ok(answer)
    }

    /// The files a folder restore reads; refuses before any read where the folder lacks one it needs.
    async fn files_to_read(
        &self,
        folder: &Arc<Folder>,
        instance: &str,
        received: &archive::restore::intake::Received,
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
        if !lacking.is_empty() {
            return Err(archive::restore::files_missing(lacking));
        }
        Ok(reading)
    }

    /// Takes an unmarked backup folder as a new store, forgetting the old one's copies and backups.
    pub async fn adopt_backup_folder(self: &Arc<App>, caller: &Caller) -> Result<Value> {
        caller.require_local()?;
        let destination = self.destination()?;
        let Destination::Folder(folder) = &destination else {
            return Err(Refusal::new(
                Code::Conflict,
                "This instance backs up to an object store, so it has no backup folder to adopt.",
            ));
        };
        let Ok(_running) = self.backups.running.try_lock() else {
            return Err(running());
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
        let (copies, backups) = self
            .db
            .write(Write::own(), move |tx| {
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
                Ok((
                    state,
                    housekeeping::last_run(tx, REPLICATION)?,
                    files_waiting,
                ))
            }),
        );
        let (read, looked) = tokio::join!(read, look);
        let (state, replication, files_waiting) = match read {
            Ok(Ok((state, replication, files_waiting))) => {
                (Some(state), replication, files_waiting)
            }
            Ok(Err(error)) => {
                tracing::warn!(%error, "The backup state did not read for health");
                (None, None, None)
            }
            Err(_) => {
                tracing::warn!("The backup state did not read for health in time");
                (None, None, None)
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
        let status = match (&destination, turned_off, failing, &store_error) {
            (None, ..) => {
                health.insert("reason".into(), "no_backup_destination".into());
                "off"
            }
            (Some(_), _, _, Some(_)) => "failing",
            (Some(_), true, ..) => {
                health.insert("reason".into(), "turned_off".into());
                "off"
            }
            (Some(_), false, true, None) => "failing",
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
         store holds whole: {shown}. They were still waiting for their copy when the backup was \
         taken. Restore an earlier backup, or download this backup's object from the object \
         store and restore it with `marfa restore` to leave them out.",
        counted(lacking.len(), "file", "files")
    )
    .into();
    refused
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
        return Ok(Outcome::Running);
    };
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
            changes,
            lost,
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
            Ok(Outcome::Put {
                instance: app.instance_id.clone(),
                name,
                taken: at,
                size,
                removed,
                unremoved,
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

/// Writes the archive and puts it whole. In the backup folder it is written only once every file
/// it names has a copy there or is known to be lost.
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
    let began = std::time::Instant::now();
    let mut taken = app.backup_archive(&destination.id()).await?;
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
    let lost = match destination {
        Destination::Bucket(_) => readable_nowhere(app, uncopied).await?,
        Destination::Folder(folder) => copy_files(app, destination, folder, uncopied).await?,
    };
    let backup = taken.send(app, &lost, app.blobs.check())?;
    let limit = backup.limit;
    let bytes = put_stream(app, backup);
    let size = match destination {
        Destination::Bucket(bucket) => {
            let key = key_of(&app.instance_id, &name);
            bucket
                .put_whole(&key, "application/x-tar", bytes, limit)
                .await
                .map_err(|error| destination.unreachable("taking the backup", &error))?
        }
        Destination::Folder(folder) => {
            let written = super::blobs::store::within(
                limit,
                backup_folder::write(folder.clone(), name.clone(), bytes, app.faults.clone()),
            )
            .await
            .map_err(|error| destination.unreachable("writing the backup", &error))?;
            written
                .place()
                .await
                .map_err(|error| destination.unreachable("naming the backup", &error))?
        }
    };
    tracing::info!(
        backup = %name,
        destination = destination.kind(),
        size,
        copied,
        lost = lost.len(),
        read_ms,
        put_ms = began.elapsed().as_millis() as u64 - read_ms,
        "A backup was put"
    );
    Ok(Put {
        at,
        name,
        size,
        changes,
        lost,
    })
}

/// What a backup put; `lost` names the files no store could give.
struct Put {
    at: Stamp,
    name: String,
    size: u64,
    changes: i64,
    lost: Vec<String>,
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
        let failed = match replicate_one(app, &target, &blob, &mut unreachable).await? {
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
    let listed = match destination.list_in(&app.instance_id).await {
        Ok(listed) => listed,
        Err(error) => {
            tracing::warn!(%error, "The backups were not listed for thinning");
            return (0, 0);
        }
    };
    let names: Vec<String> = listed.into_iter().map(|(name, _)| name).collect();
    if let Err(error) = found::survey(app, destination, &names).await {
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
        match destination.delete(&app.instance_id, &name).await {
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
            reconcile(tx, &store, &listed, &deleted, taken)
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
        reconcile(tx, BUCKET, &names(listed), &names(deleted), now).unwrap();
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
    fn a_backup_is_forgotten_once_three_listings_omit_it_and_list_32_later_days() {
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
        settled(&tx, &refs(&more), &[], at(1));
        assert!(held_of(&tx, &[&a]).is_empty());
        assert_eq!(count(&tx, "SELECT COUNT(*) FROM backups"), 1);
        assert_eq!(count(&tx, "SELECT COUNT(*) FROM backup_files"), 0);
    }

    #[test]
    fn two_listings_omitting_a_backup_past_retention_are_not_enough() {
        let mut conn = database();
        let tx = conn.transaction().unwrap();
        let a = hash('a');
        registered(&tx, &[&a]);
        let later = daily(1..=40);

        hold(&tx, BUCKET, &named(0), &files(&[&a])).unwrap();
        hold(&tx, BUCKET, &named(1), &[]).unwrap();
        settled(&tx, &refs(&later), &[], at(1));
        settled(&tx, &refs(&later), &[], at(2));
        assert_eq!(held_of(&tx, &[&a]), ['a']);
        settled(&tx, &refs(&later), &[], at(3));
        assert!(held_of(&tx, &[&a]).is_empty());
    }

    #[test]
    fn a_listing_that_shows_a_backup_again_restarts_its_absence() {
        let mut conn = database();
        let tx = conn.transaction().unwrap();
        let a = hash('a');
        registered(&tx, &[&a]);
        let (lost, next) = (named(0), named(1));

        hold(&tx, BUCKET, &lost, &files(&[&a])).unwrap();
        hold(&tx, BUCKET, &next, &[]).unwrap();
        settled(&tx, &[], &[], at(1));
        settled(&tx, &[], &[], at(2));
        settled(&tx, &[&lost], &[], at(3));
        let (again, month) = (at(32 * 24), daily(1..=33));
        for day in 0..3 {
            settled(
                &tx,
                &refs(&month),
                &[],
                again.plus_ms(day * DAY_MS).unwrap(),
            );
        }
        assert_eq!(held_of(&tx, &[&a]), ['a']);

        settled(&tx, &refs(&daily(1..=65)), &[], again);
        assert!(held_of(&tx, &[&a]).is_empty());
    }

    #[test]
    fn a_missing_time_that_does_not_read_keeps_its_holds() {
        let mut conn = database();
        let tx = conn.transaction().unwrap();
        let a = hash('a');
        registered(&tx, &[&a]);
        let lost = named(0);

        hold(&tx, BUCKET, &lost, &files(&[&a])).unwrap();
        hold(&tx, BUCKET, &named(1), &[]).unwrap();
        tx.execute(
            "UPDATE backups SET missing_since = '0', omissions = 9 WHERE name = ?1",
            [&lost],
        )
        .unwrap();
        settled(&tx, &refs(&daily(1..=40)), &[], at(2));
        assert_eq!(held_of(&tx, &[&a]), ['a']);
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
        assert!(
            (30 * 12..=34 * 12).contains(&interrupted_kept),
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
        reconcile(&tx, "bucket A", &names(&[&a1]), &names(&[]), at(0)).unwrap();
        hold(&tx, "bucket B", &b1, &[]).unwrap();
        reconcile(&tx, "bucket B", &names(&[&b1]), &names(&[]), at(1)).unwrap();
        hold(&tx, "bucket A", &a2, &[]).unwrap();
        reconcile(&tx, "bucket A", &names(&[&a1, &a2]), &names(&[]), at(2)).unwrap();

        assert_eq!(held_in(&tx, "bucket A", &[&x]), ['a']);
    }

    #[test]
    fn a_found_backup_holds_its_files_and_its_name_until_listings_long_omit_it() {
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
            found::settle(&tx, BUCKET, &names(&refs(&ahead)), now).unwrap();
        }
        assert_eq!(held_of(&tx, &[&a, &b]), ['a']);
        found::settle(&tx, BUCKET, &names(&refs(&daily(1..=32))), at(9)).unwrap();
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
