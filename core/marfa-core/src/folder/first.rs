use serde::{Deserialize, Serialize};

use super::Folder;
use crate::error::CoreError;
use crate::model::{HydrateReport, Verdict, WriteKind};
use crate::{Result, store};

/// Present from the add until the person confirms, holding the last plan.
const META_FIRST_SYNC: &str = "folder_first_sync";

/// What a folder's first sync will do, read from the folder as it stands.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct FirstSync {
    /// Files it will write into the directory.
    pub write: usize,
    /// Files in the directory it will send, as new items or as the edits of
    /// the items they name.
    pub send: usize,
    /// Files already where an item's file would go. Each stays as it is, and
    /// the item's file is not written there.
    pub kept: usize,
}

impl FirstSync {
    fn nothing(&self) -> bool {
        *self == FirstSync::default()
    }
}

/// What a sync of a folder came to.
#[derive(Debug, Clone)]
pub enum Synced {
    /// The sync ran.
    Done(Box<super::SyncReport>),
    /// The folder's first sync waits to be confirmed, so nothing was written
    /// or sent.
    Waiting(FirstSync),
}

/// What reading a folder for its first sync found.
#[derive(Debug, Clone, Default)]
pub struct Planned {
    pub hydrated: Option<HydrateReport>,
    /// `None` where the plan holds nothing to ask about, which confirms it.
    pub plan: Option<FirstSync>,
}

impl Folder {
    /// Whether the folder's first sync waits to be confirmed. A folder that
    /// waits writes nothing and sends nothing.
    pub fn awaiting_confirmation(&self) -> Result<bool> {
        Ok(store::meta_get(&*self.core.conn()?, META_FIRST_SYNC)?.is_some())
    }

    /// The plan the last read of the folder made, while its first sync waits.
    pub fn first_sync_plan(&self) -> Result<Option<FirstSync>> {
        Ok(store::meta_get(&*self.core.conn()?, META_FIRST_SYNC)?
            .and_then(|json| serde_json::from_str(&json).ok())
            .flatten())
    }

    /// Where the first sync waits, the folder is a copy that does not yet
    /// answer for its directory, so every step that writes or sends refuses.
    pub(super) fn refuse_while_waiting(&self) -> Result<()> {
        if self.awaiting_confirmation()? {
            return Err(CoreError::FirstSyncWaiting);
        }
        Ok(())
    }

    pub(super) fn wait_for_confirmation(&self) -> Result<()> {
        store::meta_set(
            &*self.core.conn()?,
            META_FIRST_SYNC,
            &serde_json::to_string(&None::<FirstSync>)?,
        )
    }

    /// Lets the first sync go. Answers whether it waited.
    pub fn confirm_first_sync(&self) -> Result<bool> {
        let conn = self.core.conn()?;
        let waited = store::meta_get(&conn, META_FIRST_SYNC)?.is_some();
        store::meta_delete(&conn, META_FIRST_SYNC)?;
        Ok(waited)
    }

    /// Reads the folder for what its first sync will do: hydrates a copy that
    /// does not answer for its slice, scans, and counts the files a pull would
    /// write. It writes nothing into the directory and sends nothing, and a
    /// plan that holds nothing to ask about confirms itself.
    pub fn plan_first_sync(&self) -> Result<Planned> {
        self.refuse_if_gone()?;
        let hydrated = self.resume()?;
        self.scan()?;
        // From the queue, not the scan's counts, which a second look at the
        // same files would find nothing new in.
        let send = self
            .core
            .queue()?
            .iter()
            .filter(|write| matches!(write.verdict, None | Some(Verdict::Blocked)))
            .filter(|write| matches!(write.kind, WriteKind::CreateItem | WriteKind::UpdateItem))
            .count();
        let mut plan = FirstSync {
            send,
            ..FirstSync::default()
        };
        let mut pulled = super::PullPlan::default();
        self.pull_as(Some(&mut pulled))?;
        plan.write = pulled.write;
        plan.kept = pulled.kept;
        if plan.nothing() {
            self.confirm_first_sync()?;
            return Ok(Planned {
                hydrated,
                plan: None,
            });
        }
        store::meta_set(
            &*self.core.conn()?,
            META_FIRST_SYNC,
            &serde_json::to_string(&Some(plan))?,
        )?;
        Ok(Planned {
            hydrated,
            plan: Some(plan),
        })
    }
}
