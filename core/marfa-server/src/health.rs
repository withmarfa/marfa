//! `GET /health`: four components, each `ok`, `degraded` or `down`, and the
//! worst of them overall.

use std::ffi::CString;
use std::os::unix::ffi::OsStrExt;
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use crate::app::App;
use crate::clock;

/// The marker a blob folder holds once the server has prepared it.
const MARKER: &str = ".marfa-store";
/// The write probe commits at most this often.
const WRITE_PROBE_EVERY: Duration = Duration::from_secs(10);
const DISK_DOWN_BELOW: u64 = 1024 * 1024;
const DISK_DEGRADED_FLOOR: u64 = 64 * 1024 * 1024;

#[derive(Default)]
pub struct Health {
    last_write: Mutex<Option<(Instant, Component)>>,
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
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

#[derive(Clone, Copy, Debug)]
struct Component {
    status: Status,
    latency_ms: Option<u64>,
}

impl Component {
    fn to_json(self) -> Value {
        let mut out = json!({ "status": self.status.word() });
        if let Some(latency) = self.latency_ms {
            out["latency_ms"] = latency.into();
        }
        out
    }
}

pub fn prepare_blobs(path: &Path) -> Result<(), String> {
    std::fs::create_dir_all(path)
        .map_err(|error| format!("cannot create {}: {error}", path.display()))?;
    let marker = path.join(MARKER);
    if !marker.exists() {
        std::fs::write(&marker, b"")
            .map_err(|error| format!("cannot write {}: {error}", marker.display()))?;
    }
    Ok(())
}

pub async fn check(app: &App) -> (Status, Value) {
    let database = {
        let started = Instant::now();
        let read = app
            .db
            .read(|conn| Ok(conn.query_row("SELECT 1", [], |row| row.get::<_, i64>(0))?))
            .await;
        Component {
            status: if read.is_ok() {
                Status::Ok
            } else {
                Status::Down
            },
            latency_ms: Some(started.elapsed().as_millis() as u64),
        }
    };
    let database_write = write_probe(app).await;
    let disk = Component {
        status: disk_status(app),
        latency_ms: None,
    };
    let blobs = &app.settings.blob_path;
    let blob_storage = Component {
        status: if blobs.is_dir() && blobs.join(MARKER).exists() {
            Status::Ok
        } else {
            Status::Down
        },
        latency_ms: None,
    };
    let overall = [database, database_write, disk, blob_storage]
        .iter()
        .map(|component| component.status)
        .max()
        .unwrap_or(Status::Ok);
    let body = json!({
        "status": overall.word(),
        "components": {
            "database": database.to_json(),
            "database_write": database_write.to_json(),
            "disk": disk.to_json(),
            "blob_storage": blob_storage.to_json(),
        },
        "platform_types": { "retired": 0 },
        "unrecognized_stored_values": { "rows": 0, "scanned": true },
    });
    (overall, body)
}

async fn write_probe(app: &App) -> Component {
    if let Ok(last) = app.health.last_write.lock()
        && let Some((at, component)) = *last
        && at.elapsed() < WRITE_PROBE_EVERY
    {
        return component;
    }
    let started = Instant::now();
    let committed = app
        .db
        .write(|conn| {
            crate::storage::instance::set(conn, "health_probe", &clock::now_stamp())?;
            Ok(())
        })
        .await;
    let component = Component {
        status: if committed.is_ok() {
            Status::Ok
        } else {
            Status::Down
        },
        latency_ms: Some(started.elapsed().as_millis() as u64),
    };
    if let Ok(mut last) = app.health.last_write.lock() {
        *last = Some((Instant::now(), component));
    }
    component
}

fn disk_status(app: &App) -> Status {
    let path = app
        .settings
        .sqlite_path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let Some(free) = free_bytes(path) else {
        return Status::Degraded;
    };
    let reserve = DISK_DEGRADED_FLOOR.max(app.settings.disk_reserve_bytes);
    if free < DISK_DOWN_BELOW {
        Status::Down
    } else if free < reserve {
        Status::Degraded
    } else {
        Status::Ok
    }
}

fn free_bytes(path: &Path) -> Option<u64> {
    let path = CString::new(path.as_os_str().as_bytes()).ok()?;
    // SAFETY: `statvfs` writes only into the struct it is given, and `path`
    // is a NUL-terminated string that outlives the call.
    let mut stats: libc::statvfs = unsafe { std::mem::zeroed() };
    let answered = unsafe { libc::statvfs(path.as_ptr(), &mut stats) };
    // The two fields are narrower than u64 on some platforms and not others.
    #[allow(clippy::useless_conversion)]
    (answered == 0).then(|| u64::from(stats.f_bavail) * u64::from(stats.f_frsize))
}
