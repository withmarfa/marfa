//! When a key was last used. The answer to a request never waits on it, and
//! nothing about it decides whether a key authenticates.

use std::collections::HashSet;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use rusqlite::{Transaction, params};

use super::Key;
use crate::app::App;
use crate::app::refusal::Result;
use crate::db::Write;

pub(crate) const COALESCE_MS: i64 = 3_600_000;
const RETRY_AFTER: Duration = Duration::from_secs(1);
const MAX_PENDING: usize = 128;

/// The keys with a write on its way. A full set drops a use, and the key's
/// next use asks again.
#[derive(Debug, Default)]
pub struct Usage {
    pending: Mutex<HashSet<String>>,
}

impl Usage {
    fn begin(&self, id: &str) -> bool {
        let mut pending = self.pending.lock().unwrap_or_else(PoisonError::into_inner);
        pending.len() < MAX_PENDING && pending.insert(id.to_string())
    }

    fn end(&self, id: &str) {
        self.pending
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(id);
    }
}

/// Queues the time of this use if the row's is older than the coalescing
/// window.
pub fn note(app: &Arc<App>, key: &Key) {
    let due = key
        .last_used_at
        .as_ref()
        .is_none_or(|last| *last <= app.clock.stamp_ago(COALESCE_MS));
    if !due {
        return;
    }
    let row = key.id.clone();
    let at = app.clock.stamp();
    queue(app, &key.id, move |tx| {
        tx.execute(
            "UPDATE api_keys SET last_used_at = ?2 WHERE id = ?1 AND revoked_at IS NULL",
            params![row, at],
        )?;
        Ok(())
    });
}

/// Runs `record` beside the answer, unless `id` has a write on its way.
pub(crate) fn queue<F>(app: &Arc<App>, id: &str, record: F)
where
    F: FnOnce(&Transaction<'_>) -> Result<()> + Send + 'static,
{
    if !app.usage.begin(id) {
        return;
    }
    let app = app.clone();
    let id = id.to_string();
    tokio::spawn(async move {
        let written = app.db.write(Write::own(), record).await;
        if written.is_err() {
            tokio::time::sleep(RETRY_AFTER).await;
        }
        app.usage.end(&id);
    });
}
