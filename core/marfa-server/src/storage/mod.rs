//! The database: one writer connection and a few readers, in WAL mode. Each
//! call runs on tokio's blocking pool, so a slow statement never holds an
//! async worker.

pub mod catalog;
pub mod instance;
pub mod items;
pub mod keys;
pub mod owner;

use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rusqlite::Connection;

use crate::error::{ApiError, ApiResult};
use crate::settings::Settings;

pub struct Db {
    writer: Mutex<Connection>,
    readers: Vec<Mutex<Connection>>,
    next: AtomicUsize,
}

impl Db {
    pub fn open(settings: &Settings) -> Result<Db, String> {
        let path = &settings.sqlite_path;
        if let Some(parent) = path.parent()
            && !parent.as_os_str().is_empty()
        {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("cannot create {}: {error}", parent.display()))?;
        }
        let fail = |error: rusqlite::Error| format!("cannot open {}: {error}", path.display());
        let writer = connect(path, settings).map_err(fail)?;
        writer
            .pragma_update(None, "journal_mode", "WAL")
            .map_err(fail)?;
        crate::schema::apply(&writer).map_err(fail)?;
        let readers = (0..settings.sqlite_readers.max(1))
            .map(|_| connect(path, settings).map(Mutex::new))
            .collect::<Result<_, _>>()
            .map_err(fail)?;
        Ok(Db {
            writer: Mutex::new(writer),
            readers,
            next: AtomicUsize::new(0),
        })
    }

    /// Runs `work` on a reader. A reader sees only committed writes.
    pub async fn read<T, F>(self: &Arc<Self>, work: F) -> ApiResult<T>
    where
        T: Send + 'static,
        F: FnOnce(&Connection) -> ApiResult<T> + Send + 'static,
    {
        let db = self.clone();
        tokio::task::spawn_blocking(move || {
            let start = db.next.fetch_add(1, Ordering::Relaxed);
            let count = db.readers.len();
            let held =
                (0..count).find_map(|offset| db.readers[(start + offset) % count].try_lock().ok());
            let conn = match held {
                Some(conn) => conn,
                None => db.readers[start % count]
                    .lock()
                    .map_err(|_| ApiError::internal("a reader's lock was poisoned"))?,
            };
            work(&conn)
        })
        .await
        .map_err(ApiError::internal)?
    }

    /// Runs `work` on the one writer; `work` opens its own transaction.
    pub async fn write<T, F>(self: &Arc<Self>, work: F) -> ApiResult<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut Connection) -> ApiResult<T> + Send + 'static,
    {
        let db = self.clone();
        tokio::task::spawn_blocking(move || {
            let mut conn = db
                .writer
                .lock()
                .map_err(|_| ApiError::internal("the writer's lock was poisoned"))?;
            work(&mut conn)
        })
        .await
        .map_err(ApiError::internal)?
    }

    /// The writer, for work at start before any request is served.
    pub fn writer_now<T>(&self, work: impl FnOnce(&mut Connection) -> T) -> T {
        let mut conn = self
            .writer
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        work(&mut conn)
    }

    /// Folds the write-ahead log back into the database, so a stopped
    /// server leaves one file.
    pub fn close(&self) {
        self.writer_now(|conn| {
            let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)");
        });
    }
}

fn connect(path: &Path, settings: &Settings) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    conn.busy_timeout(Duration::from_millis(settings.busy_budget_ms))?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    if let Some(synchronous) = &settings.sqlite_synchronous {
        conn.pragma_update(None, "synchronous", synchronous)?;
    }
    if let Some(pages) = settings.sqlite_cache_size {
        conn.pragma_update(None, "cache_size", pages)?;
    }
    if let Some(bytes) = settings.sqlite_mmap_size {
        conn.pragma_update(None, "mmap_size", bytes)?;
    }
    Ok(conn)
}
