//! How the instance is: four components, each probed on its own, and the
//! worst of them overall.

use std::path::Path;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use serde_json::{Map, Value, json};
use tokio::sync::watch;

use super::App;
use super::blobs::MARKER;
use super::faults::Volume;
use super::refusal::{Code, Refusal};
use super::stored;
use crate::db::{Write, volume};

const PROBE_KEY: &str = "health_probe";
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
    let why = refusal.database_code().unwrap_or(refusal.code.wire());
    format!("the database refused: {why}")
}

/// What `GET /health` found.
pub struct Report {
    database: Component,
    database_write: Component,
    disk: Component,
    blob_storage: Component,
}

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
        .max()
        .unwrap_or(Status::Ok)
    }

    pub fn to_json(&self, with_errors: bool) -> Value {
        json!({
            "status": self.overall().word(),
            "components": {
                "database": self.database.to_json(with_errors),
                "database_write": self.database_write.to_json(with_errors),
                "disk": self.disk.to_json(with_errors),
                "blob_storage": self.blob_storage.to_json(with_errors),
            },
            "platform_types": { "retired": 0 },
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
    let written = app
        .db
        .write(Write::own(), move |tx| stored::put(tx, PROBE_KEY, &stamp))
        .await;
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

fn disk(app: &App) -> Component {
    let start = &app.settings.start;
    let free =
        |volume: Volume, path: &Path| app.faults.free(volume).or_else(|| volume::free_bytes(path));
    let database = free(Volume::Database, &start.database.folder());
    let blobs = free(Volume::Blobs, &start.blob_path);
    let (Some(database), Some(blobs)) = (database, blobs) else {
        return Component::not_ok(Status::Degraded, "free space unknown");
    };
    let least = database.min(blobs);
    let reserve = app
        .settings
        .live()
        .get(crate::settings::registry::DISK_RESERVE_BYTES);
    if least < DISK_DOWN_BELOW {
        Component::not_ok(Status::Down, format!("{least} bytes free"))
    } else if least < DISK_DEGRADED_FLOOR.max(reserve) {
        Component::not_ok(Status::Degraded, format!("{least} bytes free"))
    } else {
        Component::ok(None)
    }
}

fn blob_storage(app: &App) -> Component {
    let folder = &app.settings.start.blob_path;
    if folder.is_dir() && folder.join(MARKER).is_file() {
        Component::ok(None)
    } else {
        Component::not_ok(Status::Down, "the blob folder or its marker is missing")
    }
}

pub async fn check(app: &Arc<App>) -> Report {
    let (database, database_write) = tokio::join!(database(app), database_write(app));
    Report {
        database,
        database_write,
        disk: disk(app),
        blob_storage: blob_storage(app),
    }
}
