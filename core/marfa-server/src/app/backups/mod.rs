//! Backups: an archive of every row and the instance lines, with no file, put as one object
//! under `<prefix>/backups/<instance id>/` in the object store, which already keeps a copy of
//! each file.

mod names;

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

/// How many of the archive's bytes the put takes before `backup:put` holds it, unless the
/// archive ends first: past one part, so a multipart upload has begun.
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

/// Writes the archive and puts it whole, answering when it was taken, its name, size and change
/// count.
async fn put(app: &Arc<App>, bucket: &Arc<S3>) -> Result<(Stamp, String, u64, i64)> {
    let began = std::time::Instant::now();
    let backup = app.backup_archive(bucket.id(), app.blobs.check()).await?;
    let read_ms = began.elapsed().as_millis() as u64;
    let (taken, changes, limit) = (backup.created_at, backup.changes, backup.limit);
    let name = name_of(taken);
    let key = key_of(&app.instance_id, &name);
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

/// Deletes this instance's backups the plan leaves out, judged from when the backup just put
/// was taken. Only names it listed in its own folder and could read as a backup are deleted.
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
    let (mut removed, mut unremoved) = (0, 0);
    for name in doomed(&names, taken) {
        let key = key_of(&app.instance_id, &name);
        match super::blobs::store::within(LIST_DEADLINE, bucket.delete(&key)).await {
            Ok(()) => removed += 1,
            Err(error) => {
                tracing::warn!(%error, backup = %name, "An old backup was not deleted");
                unremoved += 1;
            }
        }
    }
    (removed, unremoved)
}
