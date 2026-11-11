//! Backups: an archive without files, put as one object under `<prefix>/backups/<instance id>/`.

mod names;

use std::collections::HashSet;
use std::sync::Arc;
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
use super::blobs::Hash;
use super::blobs::s3::S3;
use super::clock::Stamp;
use super::faults::{HOLD_BACKUP_PUT, HOLD_BACKUP_READ};
use super::housekeeping::{self, Report, Run};
use super::refusal::{Code, Refusal, Result};
use crate::db::Write;
use crate::settings::registry::BACKUP_INTERVAL_SECONDS;

pub use names::{doomed, instance_of, missing_past_retention, name_of, parse};

/// The folder under the object store's prefix that holds a folder of backups per instance.
pub const FOLDER: &str = "backups";
const LIST_DEADLINE: Duration = Duration::from_secs(30);
const REPLICATION: &str = "blob-replicate";

/// One backup at a time, whether the schedule or the owner asked for it.
#[derive(Debug, Default)]
pub struct Backups {
    running: Mutex<()>,
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
             last_error, last_failed_at FROM backup_state WHERE id = 1",
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
            })
        })
        .optional()?;
    Ok(found.unwrap_or_default())
}

fn record_put(
    tx: &Transaction<'_>,
    store: &str,
    changes: i64,
    name: &str,
    at: Stamp,
) -> Result<()> {
    tx.prepare_cached("UPDATE backups SET confirmed = 1 WHERE store_id = ?1 AND name = ?2")?
        .execute(params![store, name])?;
    tx.execute(
        "INSERT INTO backup_state (id, backed_up, backed_up_version, last_backup, last_backup_at) \
         VALUES (1, ?1, ?4, ?2, ?3) ON CONFLICT (id) DO UPDATE SET \
         backed_up = max(coalesce(backed_up, ?1), ?1), backed_up_version = ?4, \
         last_backup = ?2, last_backup_at = ?3, \
         failures = 0, last_error = NULL, last_failed_at = NULL",
        params![changes, name, at, archive::VERSION as i64],
    )?;
    Ok(())
}

fn record_failure(tx: &Transaction<'_>, error: &str, at: Stamp) -> Result<()> {
    tx.execute(
        "INSERT INTO backup_state (id, failures, last_error, last_failed_at) \
         VALUES (1, 1, ?1, ?2) ON CONFLICT (id) DO UPDATE SET \
         failures = failures + 1, last_error = ?1, last_failed_at = ?2",
        params![error, at],
    )?;
    Ok(())
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
    if taken {
        return Err(Refusal::new(
            Code::Conflict,
            format!(
                "The object store already keeps a backup named {name}; the next run takes \
                 another name."
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
    in_bucket: &HashSet<String>,
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
        if in_bucket.contains(hash) && super::blobs::held_in(tx, store, [hash.clone()])?.is_empty()
        {
            return Err(Refusal::new(
                Code::Conflict,
                format!(
                    "The object store's copy of the file {hash} the backup names was dropped \
                     while the backup was read; the next run takes the file again."
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
    in_bucket: Vec<String>,
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
    let in_bucket: Arc<HashSet<String>> = Arc::new(in_bucket.into_iter().collect());
    while !opening.is_empty() {
        let page = opening.split_off(opening.len().saturating_sub(HOLD_PAGE));
        let (held, in_bucket) = (store.to_string(), in_bucket.clone());
        app.db
            .write(Write::own(), move |tx| {
                open(tx, &held, seq, &page, &in_bucket)
            })
            .await?;
    }
    Ok(())
}

/// How many listings must omit a backup, the first and last over retention apart, before it is gone.
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
    for backup in recorded {
        let seq = backup.seq;
        if deleted.contains(&backup.name) {
            forget.execute([seq])?;
        } else if listed.contains(&backup.name) {
            if !backup.confirmed || backup.missing_since.is_some() || backup.omissions > 0 {
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
            if omissions >= OMISSIONS && missing_past_retention(since, now) {
                forget.execute([seq])?;
            } else {
                omitted.execute(params![seq, now, omissions])?;
            }
        }
    }
    drop_uncovered(tx, store)
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

/// Settles earlier attempts by the store's listing, refusing to go on while it does not answer.
async fn settle_attempts(app: &Arc<App>, bucket: &Arc<S3>) -> Result<()> {
    let store = bucket.id().to_string();
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
    let own = format!("{FOLDER}/{}", app.instance_id);
    let listed: HashSet<String> = super::blobs::store::within(LIST_DEADLINE, bucket.list_in(&own))
        .await
        .map_err(|error| unreachable("checking the last backup", &error))?
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

/// Of `hashes`, those a backup of `store` that this instance keeps may name.
pub fn held(tx: &Transaction<'_>, store: &str, hashes: &[Hash]) -> Result<HashSet<Hash>> {
    let mut statement = tx.prepare_cached(
        "SELECT 1 FROM backup_files f JOIN backups b ON b.store_id = f.store_id \
         AND b.seq >= f.first_seq AND (f.last_seq IS NULL OR b.seq <= f.last_seq) \
         WHERE f.store_id = ?1 AND f.hash = ?2",
    )?;
    let mut held = HashSet::new();
    for hash in hashes {
        if statement.exists(params![store, hash.as_str()])? {
            held.insert(hash.clone());
        }
    }
    Ok(held)
}

fn no_bucket() -> Refusal {
    Refusal::new(
        Code::NoBucket,
        "This instance has no object store, so it keeps no backups. Set S3_BUCKET to keep them.",
    )
}

fn running() -> Refusal {
    Refusal::new(
        Code::HousekeepingJobRunning,
        "A backup is running; try again once it ends.",
    )
}

fn unreachable(what: &str, error: &std::io::Error) -> Refusal {
    tracing::warn!(%error, "The object store did not take part in a backup");
    Refusal::new(
        Code::BlobStoreUnavailable,
        format!("The object store did not answer while {what}: {error}"),
    )
}

fn not_found(instance: &str, name: &str) -> Refusal {
    Refusal::new(
        Code::BackupNotFound,
        format!("The object store holds no backup named {name} from instance {instance}."),
    )
}

/// Whether the schedule runs backups here: an object store is set and the interval is not 0.
pub fn scheduled(app: &App) -> bool {
    app.blobs.s3().is_some() && app.settings.live().get(BACKUP_INTERVAL_SECONDS) > 0
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
    },
    Unchanged,
    Running,
}

impl Outcome {
    fn to_json(&self) -> Value {
        match self {
            Outcome::Put {
                instance,
                name,
                taken,
                size,
                removed,
                unremoved,
            } => json!({
                "outcome": "put",
                "backup": listed(instance, name, *taken, *size),
                "removed": removed,
                "unremoved": unremoved,
            }),
            Outcome::Unchanged => json!({ "outcome": "unchanged" }),
            Outcome::Running => json!({ "outcome": "running" }),
        }
    }
}

/// The `backup` housekeeping job.
pub async fn job(app: Arc<App>, _run: Run) -> Result<Report> {
    let outcome = back_up(&app, false).await?;
    Ok(Report::done(outcome.to_json()))
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
    fn bucket(&self) -> Result<Arc<S3>> {
        self.blobs.s3().ok_or_else(no_bucket)
    }

    /// The backups the object store holds, of every instance that put them there, newest first.
    pub async fn list_backups(&self, caller: &Caller) -> Result<Vec<Value>> {
        caller.require_local()?;
        let bucket = self.bucket()?;
        let found = super::blobs::store::within(LIST_DEADLINE, bucket.list_under(FOLDER))
            .await
            .map_err(|error| unreachable("listing the backups", &error))?;
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

    /// Restores the named backup of `instance`, read from the object store by the server itself.
    pub async fn restore_backup(
        self: &Arc<App>,
        caller: &Caller,
        started_at: String,
        instance: &str,
        name: &str,
    ) -> Result<Value> {
        caller.require_local()?;
        let bucket = self.bucket()?;
        if !instance_of(instance) || parse(name).is_none() {
            return Err(not_found(instance, name));
        }
        let key = key_of(instance, name);
        let found = super::blobs::store::within(
            super::blobs::store::CHECK_DEADLINE,
            bucket.get_whole(&key),
        )
        .await
        .map_err(|error| unreachable("reading the backup", &error))?;
        let Some((size, bytes)) = found else {
            return Err(not_found(instance, name));
        };
        let mut bytes = super::blobs::store::idle_limited(bytes, self.blob_read_idle());
        let mut receiving = self.begin_restore(Some(size)).await?;
        while let Some(chunk) = bytes.next().await {
            match chunk {
                Ok(chunk) => receiving.push(chunk).await?,
                Err(error) => {
                    receiving.abandon().await;
                    return Err(unreachable("reading the backup", &error));
                }
            }
        }
        let received = receiving.finish().await?;
        let mut answer = self.restore(caller, started_at, received).await?;
        answer["backup"] = json!({ "name": name, "instance_id": instance });
        Ok(answer)
    }

    /// What `/health` says of backups: whether they run, and how the last one went.
    pub async fn backup_health(&self) -> Value {
        let mut health = serde_json::Map::new();
        let status = if self.blobs.s3().is_none() {
            health.insert("reason".into(), "no_bucket".into());
            "off"
        } else if self.settings.live().get(BACKUP_INTERVAL_SECONDS) == 0 {
            health.insert("reason".into(), "turned_off".into());
            "off"
        } else {
            "on"
        };
        let read = tokio::time::timeout(Duration::from_secs(2), self.db.read(state)).await;
        let state = match read {
            Ok(Ok(state)) => Some(state),
            Ok(Err(error)) => {
                tracing::warn!(%error, "The backup state did not read for health");
                None
            }
            Err(_) => {
                tracing::warn!("The backup state did not read for health in time");
                None
            }
        };
        let failing = state.as_ref().is_none_or(|state| state.failures > 0);
        health.insert(
            "status".into(),
            match (status, failing) {
                ("on", true) => "failing",
                ("on", false) => "ok",
                _ => "off",
            }
            .into(),
        );
        if let Some(state) = state {
            health.insert("last_backup".into(), state.last_backup.into());
            health.insert("last_backup_at".into(), state.last_backup_at.into());
            health.insert("failures".into(), state.failures.into());
            health.insert("last_error".into(), state.last_error.into());
            health.insert("last_failed_at".into(), state.last_failed_at.into());
        }
        Value::Object(health)
    }
}

/// Runs one backup: skipped when nothing has changed since one written at this archive version, unless `forced`.
async fn back_up(app: &Arc<App>, forced: bool) -> Result<Outcome> {
    let bucket = app.bucket()?;
    let Ok(_running) = app.backups.running.try_lock() else {
        return Ok(Outcome::Running);
    };
    let held = app.db.read(state).await?;
    let current = held.backed_up == Some(held.changes)
        && held.backed_up_version == Some(archive::VERSION as i64);
    if !forced && held.failures == 0 && current {
        return Ok(Outcome::Unchanged);
    }
    wake_replication(app).await;
    match put(app, &bucket).await {
        Ok((taken, name, size, changes)) => {
            let (store, recorded) = (bucket.id().to_string(), name.clone());
            app.db
                .write(Write::own(), move |tx| {
                    record_put(tx, &store, changes, &recorded, taken)
                })
                .await?;
            let (removed, unremoved) = thin(app, &bucket, taken).await;
            Ok(Outcome::Put {
                instance: app.instance_id.clone(),
                name,
                taken,
                size,
                removed,
                unremoved,
            })
        }
        Err(refused) => {
            let (message, at) = (refused.message.to_string(), app.clock.instant());
            if let Err(error) = app
                .db
                .write(Write::own(), move |tx| record_failure(tx, &message, at))
                .await
            {
                tracing::error!(%error, "A failed backup was not recorded");
            }
            Err(refused)
        }
    }
}

/// Brings replication forward, so the copies a backup leaves to the store are made soon.
async fn wake_replication(app: &Arc<App>) {
    let at = app.clock.stamp();
    let woken = app
        .db
        .write(Write::own(), move |tx| {
            housekeeping::bring_forward(tx, REPLICATION, &at)
        })
        .await;
    match woken {
        Ok(()) => housekeeping::wake(app),
        Err(error) => tracing::warn!(%error, "A backup did not wake replication"),
    }
}

/// Writes the archive and puts it whole.
async fn put(app: &Arc<App>, bucket: &Arc<S3>) -> Result<(Stamp, String, u64, i64)> {
    settle_attempts(app, bucket).await?;
    let began = std::time::Instant::now();
    let mut backup = app.backup_archive(bucket.id(), app.blobs.check()).await?;
    app.faults.hold(HOLD_BACKUP_READ, None).await;
    let read_ms = began.elapsed().as_millis() as u64;
    let (taken, changes, limit) = (backup.created_at, backup.changes, backup.limit);
    let name = name_of(taken);
    let key = key_of(&app.instance_id, &name);
    let (files, in_bucket) = (
        std::mem::take(&mut backup.files),
        std::mem::take(&mut backup.in_bucket),
    );
    hold(app, bucket.id(), &name, files, in_bucket).await?;
    let bytes = put_stream(app, backup);
    let size = bucket
        .put_whole(&key, "application/x-tar", bytes, limit)
        .await
        .map_err(|error| unreachable("taking the backup", &error))?;
    tracing::info!(
        backup = %name,
        size,
        read_ms,
        put_ms = began.elapsed().as_millis() as u64 - read_ms,
        "A backup was put in the object store"
    );
    Ok((taken, name, size, changes))
}

/// Only names it listed in its own folder and could read as a backup are deleted.
async fn thin(app: &Arc<App>, bucket: &Arc<S3>, taken: Stamp) -> (usize, usize) {
    let own = format!("{FOLDER}/{}", app.instance_id);
    let listed = match super::blobs::store::within(LIST_DEADLINE, bucket.list_in(&own)).await {
        Ok(listed) => listed,
        Err(error) => {
            tracing::warn!(%error, "The backups were not listed for thinning");
            return (0, 0);
        }
    };
    let names: Vec<String> = listed.into_iter().map(|(name, _)| name).collect();
    let mut deleted = HashSet::new();
    let (mut removed, mut unremoved) = (0, 0);
    for name in doomed(&names, taken) {
        let key = key_of(&app.instance_id, &name);
        match super::blobs::store::within(LIST_DEADLINE, bucket.delete(&key)).await {
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
    let store = bucket.id().to_string();
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
                "INSERT INTO blob_copies (hash, store_id, object, recorded_at) \
                 VALUES (?1, ?2, ?1, '2026-11-01T00:00:00.000Z')",
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

    /// What `hold` writes against the snapshot `in_bucket`, stopping before the opens if told.
    fn attempt(
        tx: &Transaction<'_>,
        store: &str,
        name: &str,
        named: &[String],
        in_bucket: &[String],
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
            &in_bucket.iter().cloned().collect(),
        )
    }

    /// What `hold` writes, the copies of the snapshot being those in `BUCKET` now.
    fn hold(tx: &Transaction<'_>, store: &str, name: &str, named: &[String]) -> Result<()> {
        let in_bucket = super::super::blobs::held_in(tx, store, named.iter().cloned())?;
        attempt(tx, store, name, named, &in_bucket, false)
    }

    fn names(listed: &[&str]) -> HashSet<String> {
        listed.iter().map(|name| name.to_string()).collect()
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
        record_put(&tx, BUCKET, 0, &next, at(1)).unwrap();
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
        record_put(&tx, BUCKET, 0, &first, at(0)).unwrap();
        hold(&tx, BUCKET, &second, &[]).unwrap();
        settled(&tx, &[&second], &[], at(1));
        assert_eq!(held_of(&tx, &[&a]), ['a']);

        settled(&tx, &[&second], &[&first], at(1));
        assert!(held_of(&tx, &[&a]).is_empty());
    }

    #[test]
    fn a_kept_backup_one_listing_omits_after_a_failed_attempt_keeps_its_files_past_retention() {
        let mut conn = database();
        let tx = conn.transaction().unwrap();
        let a = hash('a');
        registered(&tx, &[&a]);
        let (kept, failed) = (named(0), named(1));

        hold(&tx, BUCKET, &kept, &files(&[&a])).unwrap();
        record_put(&tx, BUCKET, 0, &kept, at(0)).unwrap();
        hold(&tx, BUCKET, &failed, &[]).unwrap();
        settled(&tx, &[], &[], at(0).plus_ms(40 * DAY_MS).unwrap());

        assert_eq!(held_of(&tx, &[&a]), ['a']);
        assert_eq!(count(&tx, "SELECT COUNT(*) FROM backups"), 2);
    }

    #[test]
    fn a_backup_is_forgotten_once_three_listings_over_more_than_retention_omit_it() {
        let mut conn = database();
        let tx = conn.transaction().unwrap();
        let a = hash('a');
        registered(&tx, &[&a]);
        let (lost, next) = (named(0), named(1));

        hold(&tx, BUCKET, &lost, &files(&[&a])).unwrap();
        settled(&tx, &[], &[], at(0).plus_ms(400 * DAY_MS).unwrap());
        assert_eq!(held_of(&tx, &[&a]), ['a']);

        hold(&tx, BUCKET, &next, &[]).unwrap();
        let since = at(1);
        let retained = since.plus_ms(31 * DAY_MS).unwrap();
        settled(&tx, &[], &[], since);
        settled(&tx, &[], &[], retained);
        settled(&tx, &[], &[], retained);
        assert_eq!(held_of(&tx, &[&a]), ['a']);
        settled(&tx, &[], &[], retained.plus_ms(1).unwrap());
        assert!(held_of(&tx, &[&a]).is_empty());
        assert_eq!(count(&tx, "SELECT COUNT(*) FROM backups"), 1);
        assert_eq!(count(&tx, "SELECT COUNT(*) FROM backup_files"), 0);
    }

    #[test]
    fn two_listings_omitting_a_backup_over_more_than_retention_are_not_enough() {
        let mut conn = database();
        let tx = conn.transaction().unwrap();
        let a = hash('a');
        registered(&tx, &[&a]);

        hold(&tx, BUCKET, &named(0), &files(&[&a])).unwrap();
        hold(&tx, BUCKET, &named(1), &[]).unwrap();
        settled(&tx, &[], &[], at(1));
        settled(&tx, &[], &[], at(1).plus_ms(400 * DAY_MS).unwrap());
        assert_eq!(held_of(&tx, &[&a]), ['a']);
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
        let again = at(1).plus_ms(32 * DAY_MS).unwrap();
        settled(&tx, &[], &[], again);
        settled(&tx, &[], &[], again.plus_ms(DAY_MS).unwrap());
        assert_eq!(held_of(&tx, &[&a]), ['a']);

        settled(&tx, &[], &[], again.plus_ms(31 * DAY_MS + 1).unwrap());
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
        settled(&tx, &[], &[], at(0).plus_ms(400 * DAY_MS).unwrap());
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
        settled(&tx, &[], &[], at(0).plus_ms(400 * DAY_MS).unwrap());
        assert_eq!(held_of(&tx, &[&a]), ['a']);
    }

    #[test]
    fn interrupted_attempts_hold_rows_bounded_by_retention_and_clear_them_once_forgotten() {
        let mut conn = database();
        let tx = conn.transaction().unwrap();
        let hashes: Vec<Hash> = (0..1_000).map(numbered).collect();
        registered(&tx, &hashes.iter().collect::<Vec<_>>());

        for (hour, hash) in hashes.iter().enumerate() {
            let hour = hour as i64;
            settled(&tx, &[], &[], at(hour));
            let file = files(&[hash]);
            attempt(&tx, BUCKET, &named(hour), &file, &file, hour % 2 == 1).unwrap();
        }
        let recorded = count(&tx, "SELECT COUNT(*) FROM backups");
        let rows = count(&tx, "SELECT COUNT(*) FROM backup_files");
        let open = count(
            &tx,
            "SELECT COUNT(*) FROM backup_files WHERE last_seq IS NULL",
        );
        let kept = 31 * 24 + 3;
        assert_eq!(recorded, kept, "{recorded}");
        assert_eq!(rows, (kept - 1) / 2, "{rows}");
        assert_eq!(open, 0, "{open}");
        assert!(
            held(&tx, BUCKET, &hashes[998..])
                .unwrap()
                .contains(&hashes[998])
        );
        let forgotten = 1_000 - kept as usize;
        assert!(held(&tx, BUCKET, &hashes[..forgotten]).unwrap().is_empty());
        assert!(
            held(&tx, BUCKET, &hashes[forgotten..=forgotten + 1])
                .unwrap()
                .contains(&hashes[forgotten + 1])
        );

        let last = named(2_000);
        hold(&tx, BUCKET, &last, &[]).unwrap();
        for hours in [2_000, 2_001, 2_000 + 31 * 24 + 1] {
            settled(&tx, &[&last], &[], at(hours));
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
}
