//! What the instance holds and what its process costs, counted in one read snapshot per request.

use std::path::{Path, PathBuf};

use rusqlite::{Transaction, params};
use serde_json::{Map, Value, json};
use tokio::sync::Semaphore;

use super::App;
use super::clock::Stamp;
use super::faults::HOLD_METRICS;
use super::instance::VERSION;
use super::refusal::{Refusal, Result};

pub struct Counts {
    by_state: Map<String, Value>,
    items: i64,
    blobs: i64,
    blob_bytes: i64,
    platform_types: i64,
    user_types: i64,
    keys: i64,
    webhooks: i64,
    versions: i64,
    events: i64,
    audit: i64,
}

fn one(tx: &Transaction<'_>, sql: &str) -> Result<i64> {
    Ok(tx.query_row(sql, [], |row| row.get(0))?)
}

fn count(tx: &Transaction<'_>, now: Stamp) -> Result<Counts> {
    let mut by_state = Map::new();
    let mut items = 0;
    let mut grouped = tx.prepare("SELECT state, count(*) FROM items GROUP BY state")?;
    for row in grouped.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
    })? {
        let (state, total) = row?;
        items += total;
        by_state.insert(state, total.into());
    }
    let (blobs, blob_bytes) = tx.query_row(
        "SELECT count(*), coalesce(sum(size_bytes), 0) FROM blobs",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    let types = |origin: &str| {
        tx.query_row(
            "SELECT count(*) FROM types WHERE origin = ?1",
            [origin],
            |row| row.get(0),
        )
    };
    Ok(Counts {
        by_state,
        items,
        blobs,
        blob_bytes,
        platform_types: types("platform")?,
        user_types: types("user")?,
        keys: tx.query_row(
            "SELECT count(*) FROM api_keys \
             WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?1)",
            params![now],
            |row| row.get(0),
        )?,
        webhooks: one(tx, "SELECT count(*) FROM webhooks")?,
        versions: one(tx, "SELECT count(*) FROM item_versions")?,
        events: one(tx, "SELECT count(*) FROM event_log")?,
        audit: one(tx, "SELECT count(*) FROM audit_log")?,
    })
}

fn file_size(path: &Path) -> Value {
    match std::fs::metadata(path) {
        Ok(found) => found.len().into(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => 0.into(),
        Err(_) => Value::Null,
    }
}

fn file_sizes(database: Option<&Path>) -> (Value, Value) {
    match database {
        Some(path) => {
            let mut log = path.as_os_str().to_owned();
            log.push("-wal");
            (file_size(path), file_size(&PathBuf::from(log)))
        }
        None => (Value::Null, Value::Null),
    }
}

fn storage(counts: &Counts, (database, wal): (Value, Value)) -> Value {
    json!({
        "database_bytes": database,
        "wal_bytes": wal,
        "rows": {
            "items": counts.items,
            "versions": counts.versions,
            "event_log": counts.events,
            "audit_log": counts.audit,
        },
    })
}

fn seconds(time: libc::timeval) -> f64 {
    time.tv_sec as f64 + time.tv_usec as f64 / 1e6
}

fn usage() -> Option<libc::rusage> {
    let mut found = std::mem::MaybeUninit::<libc::rusage>::zeroed();
    // SAFETY: the buffer is a whole `rusage`, which the call fills when it answers 0.
    let answered = unsafe { libc::getrusage(libc::RUSAGE_SELF, found.as_mut_ptr()) };
    // SAFETY: filled by the call above, and any bits are valid integers.
    (answered == 0).then(|| unsafe { found.assume_init() })
}

#[cfg(target_os = "macos")]
fn resident_bytes() -> Option<u64> {
    let mut info = std::mem::MaybeUninit::<libc::proc_taskinfo>::zeroed();
    let size = i32::try_from(size_of::<libc::proc_taskinfo>()).ok()?;
    let pid = i32::try_from(std::process::id()).ok()?;
    // SAFETY: the buffer is the size of the flavor asked for.
    let written = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTASKINFO,
            0,
            info.as_mut_ptr().cast(),
            size,
        )
    };
    // SAFETY: the kernel filled the whole buffer, and any bits are valid integers.
    (written == size).then(|| unsafe { info.assume_init() }.pti_resident_size)
}

#[cfg(not(target_os = "macos"))]
fn resident_bytes() -> Option<u64> {
    let statm = std::fs::read_to_string("/proc/self/statm").ok()?;
    let pages: u64 = statm.split_whitespace().nth(1)?.parse().ok()?;
    // SAFETY: a plain query with no pointers.
    let page = u64::try_from(unsafe { libc::sysconf(libc::_SC_PAGESIZE) }).ok()?;
    Some(pages * page)
}

fn process(resident: Option<u64>) -> Value {
    let used = usage();
    // The peak is bytes on macOS and kilobytes elsewhere.
    let peak_unit: i64 = if cfg!(target_os = "macos") { 1 } else { 1024 };
    json!({
        "release": VERSION,
        "memory_rss_bytes": resident,
        "memory_rss_peak_bytes": used.map(|used| used.ru_maxrss * peak_unit),
        "cpu_user_seconds": used.map(|used| seconds(used.ru_utime)),
        "cpu_system_seconds": used.map(|used| seconds(used.ru_stime)),
    })
}

/// One count at a time, so a burst of requests waits for one read connection, not all of them.
pub struct Permit(Semaphore);

impl Default for Permit {
    fn default() -> Permit {
        Permit(Semaphore::const_new(1))
    }
}

pub async fn read(app: &App) -> Result<Value> {
    let _one = app
        .metrics
        .0
        .acquire()
        .await
        .map_err(|_| Refusal::internal("the metrics permit has closed"))?;
    let now = app.clock.instant();
    let database = app.settings.start.database.file();
    let faults = app.faults.clone();
    let (counts, files, resident) = app
        .db
        .read(move |tx| {
            faults.hold_blocking(HOLD_METRICS);
            let counts = count(tx, now)?;
            Ok((counts, file_sizes(database.as_deref()), resident_bytes()))
        })
        .await?;
    Ok(json!({
        "items": { "total": counts.items, "by_state": counts.by_state },
        "blobs": { "count": counts.blobs, "total_bytes": counts.blob_bytes },
        "types": { "core": counts.platform_types, "registered": counts.user_types },
        "keys": { "total": counts.keys },
        "webhooks": { "total": counts.webhooks },
        "uptime_seconds": app.started.elapsed().as_secs(),
        "process": process(resident),
        "storage": storage(&counts, files),
    }))
}
