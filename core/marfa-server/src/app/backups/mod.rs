//! Backups: an archive without files, put as one object under `<prefix>/backups/<instance id>/`.
//! The files a backup names are held from purging until thinning deletes it.

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
use super::archive::Backup;
use super::blobs::Hash;
use super::blobs::s3::S3;
use super::clock::Stamp;
use super::faults::HOLD_BACKUP_PUT;
use super::housekeeping::{self, Report, Run};
use super::refusal::{Code, Refusal, Result};
use crate::db::Write;
use crate::settings::registry::BACKUP_INTERVAL_MS;

pub use names::{doomed, instance_of, name_of, parse};

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
            "SELECT changes, backed_up, last_backup, last_backup_at, failures, last_error, \
             last_failed_at FROM backup_state WHERE id = 1",
        )?
        .query_row([], |row| {
            Ok(State {
                changes: row.get(0)?,
                backed_up: row.get(1)?,
                last_backup: row.get(2)?,
                last_backup_at: row.get(3)?,
                failures: row.get(4)?,
                last_error: row.get(5)?,
                last_failed_at: row.get(6)?,
            })
        })
        .optional()?;
    Ok(found.unwrap_or_default())
}

fn record_put(tx: &Transaction<'_>, changes: i64, name: &str, at: Stamp) -> Result<()> {
    tx.execute(
        "INSERT INTO backup_state (id, backed_up, last_backup, last_backup_at) \
         VALUES (1, ?1, ?2, ?3) ON CONFLICT (id) DO UPDATE SET \
         backed_up = max(coalesce(backed_up, ?1), ?1), last_backup = ?2, last_backup_at = ?3, \
         failures = 0, last_error = NULL, last_failed_at = NULL",
        params![changes, name, at],
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

/// Records the backup `name` about to be put in `store`, answering its place in the order.
fn begin(tx: &Transaction<'_>, store: &str, name: &str) -> Result<i64> {
    tx.prepare_cached("DELETE FROM backups WHERE store_id = ?1 AND name = ?2")?
        .execute(params![store, name])?;
    tx.prepare_cached("INSERT INTO backups (store_id, name) VALUES (?1, ?2)")?
        .execute(params![store, name])?;
    Ok(tx.last_insert_rowid())
}

/// Holds `hashes` from backup `seq` on, refusing when one is already gone from the registry.
fn open(tx: &Transaction<'_>, store: &str, seq: i64, hashes: &[String]) -> Result<()> {
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

/// Records the backup `name` about to be put and holds each file it names, a page per write.
async fn hold(app: &Arc<App>, store: &str, name: &str, files: Vec<String>) -> Result<()> {
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
    while !opening.is_empty() {
        let page = opening.split_off(opening.len().saturating_sub(HOLD_PAGE));
        let held = store.to_string();
        app.db
            .write(Write::own(), move |tx| open(tx, &held, seq, &page))
            .await?;
    }
    for page in closing.chunks(HOLD_PAGE) {
        let (held, page) = (store.to_string(), page.to_vec());
        app.db
            .write(Write::own(), move |tx| close(tx, &held, seq, &page))
            .await?;
    }
    Ok(())
}

/// Forgets the backups of `store` not in `kept`, and each of its holds no backup left covers.
/// Another bucket's backups and holds wait for that bucket's own thinning.
fn release(tx: &Transaction<'_>, store: &str, kept: &HashSet<String>) -> Result<()> {
    let recorded: Vec<(i64, String)> = tx
        .prepare_cached("SELECT seq, name FROM backups WHERE store_id = ?1")?
        .query_map([store], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let mut forget = tx.prepare_cached("DELETE FROM backups WHERE seq = ?1")?;
    for (seq, name) in recorded {
        if !kept.contains(&name) {
            forget.execute([seq])?;
        }
    }
    tx.prepare_cached(
        "DELETE FROM backup_files WHERE store_id = ?1 AND last_seq IS NOT NULL \
         AND NOT EXISTS (SELECT 1 FROM backups b WHERE b.store_id = backup_files.store_id \
         AND b.seq >= backup_files.first_seq \
         AND (backup_files.last_seq IS NULL OR b.seq <= backup_files.last_seq))",
    )?
    .execute([store])?;
    Ok(())
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
    app.blobs.s3().is_some() && app.settings.live().get(BACKUP_INTERVAL_MS) > 0
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
        } else if self.settings.live().get(BACKUP_INTERVAL_MS) == 0 {
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

/// Runs one backup: skipped when nothing a backup holds has changed, unless `forced`.
async fn back_up(app: &Arc<App>, forced: bool) -> Result<Outcome> {
    let bucket = app.bucket()?;
    let Ok(_running) = app.backups.running.try_lock() else {
        return Ok(Outcome::Running);
    };
    let held = app.db.read(state).await?;
    if !forced && held.failures == 0 && held.backed_up == Some(held.changes) {
        return Ok(Outcome::Unchanged);
    }
    wake_replication(app).await;
    match put(app, &bucket).await {
        Ok((taken, name, size, changes)) => {
            let recorded = name.clone();
            app.db
                .write(Write::own(), move |tx| {
                    record_put(tx, changes, &recorded, taken)
                })
                .await?;
            let (removed, unremoved) = thin(app, &bucket, taken, &name).await;
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
    let began = std::time::Instant::now();
    let mut backup = app.backup_archive(bucket.id(), app.blobs.check()).await?;
    let read_ms = began.elapsed().as_millis() as u64;
    let (taken, changes, limit) = (backup.created_at, backup.changes, backup.limit);
    let name = name_of(taken);
    let key = key_of(&app.instance_id, &name);
    hold(app, bucket.id(), &name, std::mem::take(&mut backup.files)).await?;
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

/// Deletes the backups the plan leaves out, then releases the files of every backup not kept.
/// Only names it listed in its own folder and could read as a backup are deleted.
async fn thin(app: &Arc<App>, bucket: &Arc<S3>, taken: Stamp, put: &str) -> (usize, usize) {
    let own = format!("{FOLDER}/{}", app.instance_id);
    let listed = match super::blobs::store::within(LIST_DEADLINE, bucket.list_in(&own)).await {
        Ok(listed) => listed,
        Err(error) => {
            tracing::warn!(%error, "The backups were not listed for thinning");
            return (0, 0);
        }
    };
    let names: Vec<String> = listed.into_iter().map(|(name, _)| name).collect();
    let mut kept: HashSet<String> = names.iter().cloned().collect();
    kept.insert(put.to_string());
    let (mut removed, mut unremoved) = (0, 0);
    for name in doomed(&names, taken) {
        let key = key_of(&app.instance_id, &name);
        match super::blobs::store::within(LIST_DEADLINE, bucket.delete(&key)).await {
            Ok(()) => {
                kept.remove(&name);
                removed += 1;
            }
            Err(error) => {
                tracing::warn!(%error, backup = %name, "An old backup was not deleted");
                unremoved += 1;
            }
        }
    }
    let store = bucket.id().to_string();
    if let Err(error) = app
        .db
        .write(Write::own(), move |tx| release(tx, &store, &kept))
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

    fn hash(letter: char) -> Hash {
        Hash::parse(&format!("sha256:{}", letter.to_string().repeat(64))).unwrap()
    }

    fn registered(tx: &Transaction<'_>, hashes: &[&Hash]) {
        for hash in hashes {
            tx.execute(
                "INSERT INTO blobs (hash, mime_type, size_bytes, recorded_at) \
                 VALUES (?1, 'text/plain', 1, '2026-11-09T00:00:00.000Z')",
                [hash.as_str()],
            )
            .unwrap();
        }
    }

    /// What `hold` writes, in one transaction.
    fn hold(tx: &Transaction<'_>, store: &str, name: &str, files: &[String]) -> Result<()> {
        let (opening, closing) = plan(&open_files(tx, store)?, files.to_vec());
        let seq = begin(tx, store, name)?;
        open(tx, store, seq, &opening)?;
        close(tx, store, seq, &closing)
    }

    fn files(hashes: &[&Hash]) -> Vec<String> {
        hashes
            .iter()
            .map(|hash| hash.as_str().to_string())
            .collect()
    }

    fn kept(names: &[&str]) -> HashSet<String> {
        names.iter().map(|name| name.to_string()).collect()
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

    #[test]
    fn a_file_is_held_while_a_kept_backup_named_it_and_let_go_once_none_does() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(MIGRATIONS[0].sql).unwrap();
        let tx = conn.transaction().unwrap();
        let (a, b, c) = (hash('a'), hash('b'), hash('c'));
        registered(&tx, &[&a, &b, &c]);

        hold(&tx, BUCKET, "1.tar", &files(&[&a, &b])).unwrap();
        hold(&tx, BUCKET, "2.tar", &files(&[&b])).unwrap();
        release(&tx, BUCKET, &kept(&["1.tar", "2.tar"])).unwrap();
        assert_eq!(held_of(&tx, &[&a, &b, &c]), ['a', 'b']);

        hold(&tx, BUCKET, "3.tar", &files(&[&b])).unwrap();
        release(&tx, BUCKET, &kept(&["2.tar", "3.tar"])).unwrap();
        assert_eq!(held_of(&tx, &[&a, &b, &c]), ['b']);
        let rows: i64 = tx
            .query_row("SELECT COUNT(*) FROM backup_files", [], |row| row.get(0))
            .unwrap();
        assert_eq!(rows, 1);
    }

    #[test]
    fn a_file_named_again_after_a_gap_is_held_by_the_backup_before_the_gap() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(MIGRATIONS[0].sql).unwrap();
        let tx = conn.transaction().unwrap();
        let a = hash('a');
        registered(&tx, &[&a]);

        hold(&tx, BUCKET, "1.tar", &files(&[&a])).unwrap();
        hold(&tx, BUCKET, "2.tar", &[]).unwrap();
        hold(&tx, BUCKET, "3.tar", &files(&[&a])).unwrap();
        hold(&tx, BUCKET, "4.tar", &[]).unwrap();
        release(&tx, BUCKET, &kept(&["1.tar", "4.tar"])).unwrap();
        assert_eq!(held_of(&tx, &[&a]), ['a']);
        release(&tx, BUCKET, &kept(&["4.tar"])).unwrap();
        assert!(held_of(&tx, &[&a]).is_empty());
    }

    #[test]
    fn a_backup_never_put_holds_nothing_and_another_bucket_keeps_its_holds_after_a_thinning() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(MIGRATIONS[0].sql).unwrap();
        let tx = conn.transaction().unwrap();
        let (a, b) = (hash('a'), hash('b'));
        registered(&tx, &[&a, &b]);

        hold(&tx, "earlier bucket", "0.tar", &files(&[&a])).unwrap();
        hold(&tx, BUCKET, "1.tar", &files(&[&a])).unwrap();
        hold(&tx, BUCKET, "2.tar", &files(&[&b])).unwrap();
        assert_eq!(held_of(&tx, &[&a, &b]), ['a', 'b']);

        release(&tx, BUCKET, &kept(&["2.tar"])).unwrap();
        assert_eq!(held_of(&tx, &[&a, &b]), ['b']);
        assert_eq!(held_in(&tx, "earlier bucket", &[&a, &b]), ['a']);
        let names: Vec<String> = tx
            .prepare("SELECT store_id || '/' || name FROM backups ORDER BY seq")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .map(|row| row.unwrap())
            .collect();
        assert_eq!(names, ["earlier bucket/0.tar", "bucket/2.tar"]);
        let rows: i64 = tx
            .query_row("SELECT COUNT(*) FROM backup_files", [], |row| row.get(0))
            .unwrap();
        assert_eq!(rows, 2);
    }

    #[test]
    fn a_file_held_in_one_bucket_stays_held_across_another_buckets_thinning() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(MIGRATIONS[0].sql).unwrap();
        let tx = conn.transaction().unwrap();
        let x = hash('a');
        registered(&tx, &[&x]);

        hold(&tx, "bucket A", "a1.tar", &files(&[&x])).unwrap();
        release(&tx, "bucket A", &kept(&["a1.tar"])).unwrap();
        hold(&tx, "bucket B", "b1.tar", &[]).unwrap();
        release(&tx, "bucket B", &kept(&["b1.tar"])).unwrap();
        hold(&tx, "bucket A", "a2.tar", &[]).unwrap();
        release(&tx, "bucket A", &kept(&["a1.tar", "a2.tar"])).unwrap();

        assert_eq!(held_in(&tx, "bucket A", &[&x]), ['a']);
    }

    #[test]
    fn a_backup_is_refused_when_a_file_its_snapshot_held_was_purged_before_the_hold() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(MIGRATIONS[0].sql).unwrap();
        let tx = conn.transaction().unwrap();
        let (a, b) = (hash('a'), hash('b'));
        registered(&tx, &[&a]);

        hold(&tx, BUCKET, "1.tar", &files(&[&a])).unwrap();
        tx.execute("DELETE FROM blobs WHERE hash = ?1", [a.as_str()])
            .unwrap();
        // Held since the first backup, so a second one naming it is not refused.
        hold(&tx, BUCKET, "2.tar", &files(&[&a])).unwrap();

        let refused = hold(&tx, BUCKET, "3.tar", &files(&[&a, &b])).unwrap_err();
        assert_eq!(refused.code, Code::Conflict);
        assert!(refused.message.contains(b.as_str()), "{}", refused.message);
    }
}
