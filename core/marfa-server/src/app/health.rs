//! Four components, each probed on its own; the overall answer is the worst of them.

use std::path::Path;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use serde_json::{Map, Value, json};
use tokio::sync::watch;

use super::App;
use super::blobs::MARKER;
use super::faults::{FAIL_HEALTH_WRITE, HOLD_DISK_PROBE, REFUSE_BLOB_STORE, Volume};
use super::refusal::{Code, Refusal};
use super::stored;
use crate::db::{Write, volume};

pub(super) const PROBE_KEY: &str = "health_probe";
const PROBE_WAIT: Duration = Duration::from_secs(2);
const WRITE_REUSE: Duration = Duration::from_secs(10);
const DISK_DOWN_BELOW: u64 = 1024 * 1024;
const DISK_DEGRADED_FLOOR: u64 = 64 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Status {
    Ok,
    Degraded,
    Down,
}

impl Status {
    fn word(self) -> &'static str {
        match self {
            Status::Ok => "ok",
            Status::Degraded => "degraded",
            Status::Down => "down",
        }
    }
}

#[derive(Clone, Debug)]
struct Component {
    status: Status,
    latency_ms: Option<u64>,
    error: Option<String>,
}

impl Component {
    fn ok(latency_ms: Option<u64>) -> Component {
        Component {
            status: Status::Ok,
            latency_ms,
            error: None,
        }
    }

    fn not_ok(status: Status, error: impl Into<String>) -> Component {
        Component {
            status,
            latency_ms: None,
            error: Some(error.into()),
        }
    }

    fn silent(what: &str) -> Component {
        let wait = PROBE_WAIT.as_millis();
        Component::not_ok(Status::Degraded, format!("no {what} within {wait}ms"))
    }

    fn to_json(&self, with_error: bool) -> Value {
        let mut out = Map::new();
        out.insert("status".into(), self.status.word().into());
        if let Some(latency) = self.latency_ms {
            out.insert("latency_ms".into(), latency.into());
        }
        if let (true, Some(error)) = (with_error, &self.error) {
            out.insert("error".into(), error.as_str().into());
        }
        Value::Object(out)
    }
}

fn because(refusal: &Refusal) -> String {
    match refusal.database_code() {
        Some(code) => format!("Database operation failed ({code})"),
        None => format!("the database refused: {}", refusal.code.wire()),
    }
}

/// What `GET /health` found.
pub struct Report {
    database: Component,
    database_write: Component,
    disk: Component,
    blob_storage: Component,
    backups: Value,
}

/// Fields of the `backups` object given only to a caller who may read the reasons.
const BACKUP_DETAIL: [&str; 5] = [
    "last_backup",
    "last_backup_at",
    "failures",
    "last_error",
    "last_failed_at",
];

impl Report {
    pub fn overall(&self) -> Status {
        [
            &self.database,
            &self.database_write,
            &self.disk,
            &self.blob_storage,
        ]
        .iter()
        .map(|component| component.status)
        .chain((self.backups["status"] == "failing").then_some(Status::Degraded))
        .max()
        .unwrap_or(Status::Ok)
    }

    /// Each component that is not ok, with its status word and the reason it gave.
    pub fn failing(&self) -> Vec<(&'static str, &'static str, String)> {
        [
            ("database", &self.database),
            ("database_write", &self.database_write),
            ("disk", &self.disk),
            ("blob_storage", &self.blob_storage),
        ]
        .into_iter()
        .filter(|(_, component)| component.status != Status::Ok)
        .map(|(name, component)| {
            let reason = component.error.clone().unwrap_or_default();
            (name, component.status.word(), reason)
        })
        .collect()
    }

    pub fn to_json(&self, with_errors: bool) -> Value {
        let mut backups = self.backups.clone();
        if !with_errors && let Some(fields) = backups.as_object_mut() {
            fields.retain(|key, _| !BACKUP_DETAIL.contains(&key.as_str()));
        }
        json!({
            "status": self.overall().word(),
            "components": {
                "database": self.database.to_json(with_errors),
                "database_write": self.database_write.to_json(with_errors),
                "disk": self.disk.to_json(with_errors),
                "blob_storage": self.blob_storage.to_json(with_errors),
            },
            "backups": backups,
            "unrecognized_stored_values": { "rows": 0, "scanned": false },
        })
    }
}

#[derive(Default)]
enum Attempt {
    #[default]
    None,
    Running(watch::Receiver<Option<Component>>),
    Finished(Instant, Component),
}

/// The write probe's last attempt, which answers for the calls around it.
#[derive(Default)]
pub struct Health {
    attempt: Mutex<Attempt>,
}

impl Health {
    fn set(&self, attempt: Attempt) {
        *self.attempt.lock().unwrap_or_else(PoisonError::into_inner) = attempt;
    }
}

async fn database(app: &App) -> Component {
    if app.db.damaged() {
        return Component::not_ok(Status::Down, "the database file is damaged");
    }
    let started = Instant::now();
    let read = app.db.read(|tx| {
        tx.query_row(
            "SELECT count(*) FROM (SELECT 1 FROM api_keys LIMIT 1)",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(Refusal::from)
    });
    match tokio::time::timeout(PROBE_WAIT, read).await {
        Ok(Ok(_)) => Component::ok(Some(started.elapsed().as_millis() as u64)),
        Ok(Err(refusal)) => Component::not_ok(Status::Down, because(&refusal)),
        Err(_) => Component::silent("read answered"),
    }
}

async fn attempt_write(app: Arc<App>, result: watch::Sender<Option<Component>>) {
    let started = Instant::now();
    let stamp = app.clock.stamp();
    let written = if app.faults.fail(FAIL_HEALTH_WRITE, None) {
        Err(crate::db::io_refusal())
    } else {
        app.db
            .write(Write::own(), move |tx| stored::put(tx, PROBE_KEY, &stamp))
            .await
    };
    let component = match written {
        Ok(()) => Component::ok(Some(started.elapsed().as_millis() as u64)),
        Err(refusal) if refusal.code == Code::WriteContention => {
            Component::not_ok(Status::Degraded, because(&refusal))
        }
        Err(refusal) => Component::not_ok(Status::Down, because(&refusal)),
    };
    app.health
        .set(Attempt::Finished(Instant::now(), component.clone()));
    result.send_replace(Some(component));
}

async fn database_write(app: &Arc<App>) -> Component {
    let mut running = {
        let mut attempt = app
            .health
            .attempt
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        match &*attempt {
            Attempt::Finished(at, component) if at.elapsed() < WRITE_REUSE => {
                return component.clone();
            }
            Attempt::Running(running) => running.clone(),
            _ => {
                let (result, running) = watch::channel(None);
                *attempt = Attempt::Running(running.clone());
                tokio::spawn(attempt_write(app.clone(), result));
                running
            }
        }
    };
    let answered = running.wait_for(Option::is_some);
    match tokio::time::timeout(PROBE_WAIT, answered).await {
        Ok(Ok(component)) => component
            .clone()
            .unwrap_or_else(|| Component::not_ok(Status::Down, "the write probe gave no answer")),
        Ok(Err(_)) => Component::not_ok(Status::Down, "the write probe gave no answer"),
        Err(_) => Component::silent("write committed"),
    }
}

/// Runs filesystem work off the async runtime, so a mount that hangs holds a
/// blocking thread and not a worker, and gives up on it after the probe's wait.
async fn bounded<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> Option<T> {
    tokio::time::timeout(PROBE_WAIT, tokio::task::spawn_blocking(work))
        .await
        .ok()?
        .ok()
}

async fn disk(app: &Arc<App>) -> Component {
    let app = app.clone();
    let measured = bounded(move || {
        app.faults.hold_blocking(HOLD_DISK_PROBE);
        let start = &app.settings.start;
        let free = |volume: Volume, path: &Path| match app.faults.free(volume) {
            Some(set) => set,
            None => volume::free_bytes(path),
        };
        let database = free(Volume::Database, &start.database.folder());
        let blobs = free(Volume::Blobs, &start.blob_path);
        let reserve = app
            .settings
            .live()
            .get(crate::settings::registry::DISK_RESERVE_BYTES);
        (database, blobs, reserve)
    })
    .await;
    let Some((database, blobs, reserve)) = measured else {
        return Component::silent("free space read");
    };
    let (Some(database), Some(blobs)) = (database, blobs) else {
        return Component::not_ok(Status::Degraded, "free space unknown");
    };
    let least = database.min(blobs);
    if least < DISK_DOWN_BELOW {
        Component::not_ok(Status::Down, format!("{least} bytes free"))
    } else if least < DISK_DEGRADED_FLOOR.max(reserve) {
        Component::not_ok(Status::Degraded, format!("{least} bytes free"))
    } else {
        Component::ok(None)
    }
}

async fn blob_storage(app: &Arc<App>) -> Component {
    let app = app.clone();
    let present = bounded(move || {
        app.faults.hold_blocking(HOLD_DISK_PROBE);
        let folder = &app.settings.start.blob_path;
        !app.faults.refusing(REFUSE_BLOB_STORE) && folder.is_dir() && folder.join(MARKER).is_file()
    })
    .await;
    match present {
        Some(true) => Component::ok(None),
        Some(false) => Component::not_ok(Status::Down, "the blob folder or its marker is missing"),
        None => Component::silent("blob folder answer"),
    }
}

pub async fn check(app: &Arc<App>) -> Report {
    let (database, database_write, disk, blob_storage, backups) = tokio::join!(
        database(app),
        database_write(app),
        disk(app),
        blob_storage(app),
        app.backup_health()
    );
    Report {
        database,
        database_write,
        disk,
        blob_storage,
        backups,
    }
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;

    use super::*;

    #[tokio::test]
    async fn a_filesystem_call_that_hangs_is_given_up_on_and_leaves_the_runtime_running() {
        let (release, held) = mpsc::channel::<()>();
        let ticker = tokio::spawn(async {
            let started = Instant::now();
            tokio::time::sleep(Duration::from_millis(100)).await;
            started.elapsed()
        });
        let started = Instant::now();
        let answered = bounded(move || {
            let _ = held.recv_timeout(Duration::from_secs(30));
        })
        .await;
        assert!(answered.is_none());
        assert!(started.elapsed() < PROBE_WAIT + Duration::from_secs(1));
        assert!(ticker.await.unwrap() < Duration::from_secs(1));
        drop(release);
    }

    #[tokio::test]
    async fn a_filesystem_call_that_answers_is_returned() {
        assert_eq!(bounded(|| 7).await, Some(7));
    }
}
