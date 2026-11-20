//! A person's pause of one directory's sync, kept in its own store.

use super::Folder;
use crate::error::CoreError;
use crate::{Result, store};

/// Present while the directory's sync is paused, holding when it was.
pub(super) const META_PAUSED: &str = "folder_paused";

/// Whether the store of a directory is one whose sync is paused.
pub(crate) fn paused(conn: &rusqlite::Connection) -> Result<bool> {
    Ok(store::meta_get(conn, META_PAUSED)?.is_some())
}

impl Folder {
    /// Whether the directory's sync is paused.
    pub fn is_paused(&self) -> Result<bool> {
        paused(&*self.core.conn()?)
    }

    /// Whether the directory at `root` is paused, read without claiming it.
    pub fn paused_at(root: impl AsRef<std::path::Path>) -> bool {
        Folder::reading(root.as_ref())
            .and_then(|folder| folder.is_paused())
            .unwrap_or(false)
    }

    /// Pauses the directory's sync; `false` where it was paused already.
    pub fn pause_sync(&self) -> Result<bool> {
        let conn = self.core.conn()?;
        if paused(&conn)? {
            return Ok(false);
        }
        store::meta_set(&conn, META_PAUSED, &store::now_iso())?;
        drop(conn);
        self.report_pause();
        Ok(true)
    }

    /// Lets the directory's sync go on; `false` where it was not paused.
    pub fn resume_sync(&self) -> Result<bool> {
        let conn = self.core.conn()?;
        if !paused(&conn)? {
            return Ok(false);
        }
        store::meta_delete(&conn, META_PAUSED)?;
        drop(conn);
        self.report_pause();
        Ok(true)
    }

    /// Tells the server once; a failure is not the command's.
    fn report_pause(&self) {
        self.health_observe(false, true, None, None, false);
        self.health_send();
    }

    /// Refuses a command that reads the server's side or writes either side.
    pub(super) fn refuse_while_paused(&self) -> Result<()> {
        if self.is_paused()? {
            return Err(CoreError::SyncPaused);
        }
        Ok(())
    }
}
