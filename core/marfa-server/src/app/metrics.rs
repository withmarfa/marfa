//! What the instance holds and what its process costs, counted in one read snapshot per request.

use std::path::{Path, PathBuf};

use rusqlite::Transaction;
use rusqlite::functions::{Aggregate, Context, FunctionFlags};
use serde::Serialize;
use serde_json::{Map, Value, json};
use tokio::sync::Semaphore;

use crate::db::volume;

use super::App;
use super::clock::Stamp;
use super::faults::{Faults, HOLD_METRICS, Volume};
use super::instance::VERSION;
use super::keys;
use super::refusal::{Refusal, Result};

struct Counts {
    by_state: Map<String, Value>,
    items: i64,
    blobs: Value,
    platform_types: i64,
    registered_types: i64,
    plugin_types: i64,
    keys: i64,
    webhooks: i64,
    versions: i64,
    events: i64,
    audit: i64,
}

#[derive(Default, Serialize)]
struct BlobTally {
    count: i64,
    total_bytes: i64,
}

impl BlobTally {
    fn add(&mut self, bytes: i64) -> rusqlite::Result<()> {
        self.total_bytes = self.total_bytes.checked_add(bytes).ok_or_else(|| {
            rusqlite::Error::UserFunctionError(
                std::io::Error::other("total blob size is too large to count").into(),
            )
        })?;
        self.count += 1;
        Ok(())
    }
}

#[derive(Default, Serialize)]
struct BlobKinds {
    image: BlobTally,
    pdf: BlobTally,
    audio_video: BlobTally,
    other: BlobTally,
}

#[derive(Default, Serialize)]
struct BlobCounts {
    #[serde(flatten)]
    total: BlobTally,
    by_kind: BlobKinds,
}

enum BlobKind {
    Image,
    Pdf,
    AudioVideo,
    Other,
}

fn blob_kind(mime_type: &str) -> BlobKind {
    let essence = mime_type
        .split_once(';')
        .map_or(mime_type, |(essence, _)| essence)
        .trim();
    if essence.eq_ignore_ascii_case("application/pdf") {
        return BlobKind::Pdf;
    }
    let Some((kind, subtype)) = essence.split_once('/') else {
        return BlobKind::Other;
    };
    let kind = if kind.eq_ignore_ascii_case("image") {
        BlobKind::Image
    } else if kind.eq_ignore_ascii_case("audio") || kind.eq_ignore_ascii_case("video") {
        BlobKind::AudioVideo
    } else {
        return BlobKind::Other;
    };
    if subtype.is_empty()
        || subtype == "*"
        || !subtype
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&byte))
    {
        return BlobKind::Other;
    }
    kind
}

// Accumulate the four groups directly to avoid sorting the blob table.
struct CountBlobs;

impl Aggregate<BlobCounts, String> for CountBlobs {
    fn init(&self, _: &mut Context<'_>) -> rusqlite::Result<BlobCounts> {
        Ok(BlobCounts::default())
    }

    fn step(&self, row: &mut Context<'_>, counts: &mut BlobCounts) -> rusqlite::Result<()> {
        let bytes = row.get::<i64>(1)?;
        counts.total.add(bytes)?;
        let group = match row.get_raw(0).as_str().map_or(BlobKind::Other, blob_kind) {
            BlobKind::Image => &mut counts.by_kind.image,
            BlobKind::Pdf => &mut counts.by_kind.pdf,
            BlobKind::AudioVideo => &mut counts.by_kind.audio_video,
            BlobKind::Other => &mut counts.by_kind.other,
        };
        group.add(bytes)
    }

    fn finalize(
        &self,
        _: &mut Context<'_>,
        counts: Option<BlobCounts>,
    ) -> rusqlite::Result<String> {
        serde_json::to_string(&counts.unwrap_or_default())
            .map_err(|error| rusqlite::Error::UserFunctionError(error.into()))
    }
}

fn count_blobs(tx: &Transaction<'_>) -> Result<Value> {
    tx.create_aggregate_function(
        "marfa_blob_counts",
        2,
        FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DIRECTONLY,
        CountBlobs,
    )?;
    let counted: String = tx.query_row(
        "SELECT marfa_blob_counts(mime_type, size_bytes) FROM blobs",
        [],
        |row| row.get(0),
    )?;
    serde_json::from_str(&counted).map_err(|_| Refusal::internal("blob counts could not be read"))
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
        blobs: count_blobs(tx)?,
        platform_types: types("platform")?,
        registered_types: types("registered")?,
        plugin_types: types("plugin")?,
        keys: keys::live_count(tx, &now.text())?,
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

fn storage(counts: &Counts, database: Option<&Path>, blob_path: &Path, faults: &Faults) -> Value {
    let (database, wal) = file_sizes(database);
    let free = faults
        .free(Volume::Blobs)
        .unwrap_or_else(|| volume::free_bytes(blob_path));
    let size = faults
        .size(Volume::Blobs)
        .unwrap_or_else(|| volume::size_bytes(blob_path));
    json!({
        "database_bytes": database,
        "wal_bytes": wal,
        "blob_volume_free_bytes": free,
        "blob_volume_size_bytes": size,
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
pub(crate) fn resident_bytes() -> Option<u64> {
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
pub(crate) fn resident_bytes() -> Option<u64> {
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
        "version": VERSION,
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
    let blob_path = app.settings.start.blob_path.clone();
    let faults = app.faults.clone();
    let (counts, storage, resident) = app
        .db
        .read(move |tx| {
            faults.hold_blocking(HOLD_METRICS);
            let counts = count(tx, now)?;
            let storage = storage(&counts, database.as_deref(), &blob_path, &faults);
            Ok((counts, storage, resident_bytes()))
        })
        .await?;
    Ok(json!({
        "items": { "total": counts.items, "by_state": counts.by_state },
        "blobs": counts.blobs,
        "types": {
            "core": counts.platform_types,
            "registered": counts.registered_types,
            "plugin": counts.plugin_types,
        },
        "keys": { "total": counts.keys },
        "webhooks": { "total": counts.webhooks },
        "uptime_seconds": app.started.elapsed().as_secs(),
        "process": process(resident),
        "storage": storage,
    }))
}
