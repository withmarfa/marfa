//! A few read connections. A read runs on the blocking pool, inside one read
//! transaction, so it sees one snapshot and never holds an async worker.

use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use rusqlite::{Connection, Transaction};
use tokio::sync::Semaphore;

use crate::app::refusal::{Refusal, Result};

const CLOSE_WAIT: Duration = Duration::from_secs(1);

type Idle = Arc<Mutex<Vec<Connection>>>;

pub struct Pool {
    permits: Arc<Semaphore>,
    idle: Idle,
    size: u32,
}

struct Lease {
    conn: Option<Connection>,
    idle: Idle,
}

impl Lease {
    fn take(idle: Idle) -> Result<Lease> {
        let conn = idle
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .pop()
            .ok_or_else(|| Refusal::internal("a read permit found no connection"))?;
        Ok(Lease {
            conn: Some(conn),
            idle,
        })
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        if let Some(conn) = self.conn.take() {
            self.idle
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push(conn);
        }
    }
}

impl Pool {
    pub fn new(connections: Vec<Connection>) -> Pool {
        let size = connections.len();
        Pool {
            permits: Arc::new(Semaphore::new(size)),
            idle: Arc::new(Mutex::new(connections)),
            size: size as u32,
        }
    }

    pub async fn read<T, F>(&self, job: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&Transaction<'_>) -> Result<T> + Send + 'static,
    {
        let closed = |_| Refusal::internal("the read pool has closed");
        let permit = self.permits.clone().acquire_owned().await.map_err(closed)?;
        let idle = self.idle.clone();
        let read = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            let mut lease = Lease::take(idle)?;
            let conn = lease
                .conn
                .as_mut()
                .ok_or_else(|| Refusal::internal("a lease held no connection"))?;
            job(&conn.transaction()?)
        });
        read.await
            .unwrap_or_else(|_| Err(Refusal::internal("a read job panicked")))
    }

    /// As `read`, on a thread of its own that asks the system to run it behind other work.
    pub async fn read_background<T, F>(&self, job: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&Transaction<'_>) -> Result<T> + Send + 'static,
    {
        let closed = |_| Refusal::internal("the read pool has closed");
        let permit = self.permits.clone().acquire_owned().await.map_err(closed)?;
        let idle = self.idle.clone();
        let (answer, answered) = tokio::sync::oneshot::channel();
        std::thread::Builder::new()
            .name("marfa-background-read".into())
            .spawn(move || {
                lower_priority();
                let _permit = permit;
                let read = (|| {
                    let mut lease = Lease::take(idle)?;
                    let conn = lease
                        .conn
                        .as_mut()
                        .ok_or_else(|| Refusal::internal("a lease held no connection"))?;
                    job(&conn.transaction()?)
                })();
                let _ = answer.send(read);
            })
            .map_err(|error| Refusal::internal(&format!("a background read did not start: {error}")))?;
        answered
            .await
            .unwrap_or_else(|_| Err(Refusal::internal("a background read panicked")))
    }

    pub async fn close(&self) {
        let all = self.permits.acquire_many(self.size);
        let _ = tokio::time::timeout(CLOSE_WAIT, all).await;
        self.permits.close();
        self.idle
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clear();
    }
}

/// Best effort: a thread that cannot lower itself runs at the usual priority.
fn lower_priority() {
    #[cfg(target_os = "linux")]
    // SAFETY: `setpriority` reads only its arguments; a thread id names this thread alone.
    unsafe {
        let thread = libc::syscall(libc::SYS_gettid) as libc::id_t;
        libc::setpriority(libc::PRIO_PROCESS, thread, 10);
    }
    #[cfg(target_os = "macos")]
    // SAFETY: as above; `PRIO_DARWIN_THREAD` with 0 names the calling thread.
    unsafe {
        libc::setpriority(libc::PRIO_DARWIN_THREAD, 0, libc::PRIO_DARWIN_BG);
    }
}
