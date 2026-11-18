//! The items a trash or a purge this core has out at the server holds
//! against new writes.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use rusqlite::Connection;
use rusqlite::functions::FunctionFlags;

use crate::error::CoreError;

/// Held for every item, by a trash whose preview cut what it takes.
pub(crate) const EVERY_ITEM: &str = "*";

/// The code a write is refused with while a trash or a purge of its item is out.
pub(crate) const ITEM_BEING_REMOVED: &str = "item_being_removed";

/// How a store helper reads the holds: through the connection it writes
/// with, so under that connection's lock.
const HELD_BY: &str = "marfa_removing";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Removing {
    Trash,
    Purge,
}

impl Removing {
    fn as_str(self) -> &'static str {
        match self {
            Removing::Trash => "trash",
            Removing::Purge => "purge",
        }
    }
}

/// In memory, not in the store: a hold ends with its request however that
/// ends, and none outlives the process. Taken only under the connection's
/// lock, which every write to the queue also holds.
#[derive(Default)]
pub(crate) struct Removals(Mutex<HashMap<String, Removing>>);

impl Removals {
    fn held(&self) -> MutexGuard<'_, HashMap<String, Removing>> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn holder(&self, id: &str) -> Option<Removing> {
        let held = self.held();
        held.get(id).or_else(|| held.get(EVERY_ITEM)).copied()
    }

    /// Lets `conn` read these holds, for `refuse_removing`.
    pub(crate) fn serve(self: &Arc<Self>, conn: &Connection) -> Result<(), CoreError> {
        let removals = Arc::clone(self);
        conn.create_scalar_function(HELD_BY, 1, FunctionFlags::SQLITE_UTF8, move |context| {
            let id: String = context.get(0)?;
            Ok(removals.holder(&id).map(Removing::as_str))
        })?;
        Ok(())
    }

    /// Holds `ids` until what it answers is dropped, refused where a removal
    /// already out holds one of them.
    pub(crate) fn hold(
        self: &Arc<Self>,
        ids: Vec<String>,
        by: Removing,
    ) -> Result<HeldRemoving, CoreError> {
        let mut held = self.held();
        let clash = ids.iter().find_map(|id| {
            if id == EVERY_ITEM {
                held.iter().next().map(|(by_id, by)| (by_id.clone(), *by))
            } else {
                held.get(id)
                    .or_else(|| held.get(EVERY_ITEM))
                    .map(|by| (id.clone(), *by))
            }
        });
        if let Some((id, by)) = clash {
            return Err(being_removed(&id, by));
        }
        for id in &ids {
            held.insert(id.clone(), by);
        }
        Ok(HeldRemoving {
            removals: Arc::clone(self),
            ids,
        })
    }

    /// Refuses a write sent at once rather than queued to `item`, or to a
    /// new item where `item` is `None`.
    pub(crate) fn refuse(&self, item: Option<&str>) -> Result<(), CoreError> {
        let id = item.unwrap_or(EVERY_ITEM);
        match self.holder(id) {
            Some(by) => Err(being_removed(id, by)),
            None => Ok(()),
        }
    }
}

pub(crate) struct HeldRemoving {
    removals: Arc<Removals>,
    ids: Vec<String>,
}

impl Drop for HeldRemoving {
    fn drop(&mut self) {
        let mut held = self.removals.held();
        for id in &self.ids {
            held.remove(id);
        }
    }
}

fn being_removed(id: &str, by: Removing) -> CoreError {
    let what = if id == EVERY_ITEM { "an item" } else { id };
    let how = match by {
        Removing::Purge => "purged",
        Removing::Trash => "moved to the bin",
    };
    CoreError::Validation {
        server: None,
        code: ITEM_BEING_REMOVED.into(),
        message: format!(
            "{what} is being {how} on the server; try again once that has been answered"
        ),
        details: (id != EVERY_ITEM).then(|| Box::new(serde_json::json!({ "id": id }))),
    }
}

/// Refuses a write to an item a trash or a purge has out at the server: the
/// write would reach a row in the bin or gone.
pub(crate) fn refuse_removing(conn: &Connection, item: &str) -> Result<(), CoreError> {
    let by: Option<String> = conn
        .prepare_cached(&format!("SELECT {HELD_BY}(?1)"))?
        .query_row([item], |row| row.get(0))?;
    match by.as_deref() {
        Some("purge") => Err(being_removed(item, Removing::Purge)),
        Some(_) => Err(being_removed(item, Removing::Trash)),
        None => Ok(()),
    }
}
