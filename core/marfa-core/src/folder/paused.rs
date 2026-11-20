//! A person's pause of one directory's sync, kept in the directory's own
//! store, so it survives a restart of the watch and of the machine.

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

    /// Whether the sync of the directory at `root` is paused, read without
    /// claiming the directory, so it answers beside a process that holds it.
    /// `false` where the directory cannot be read.
    pub fn paused_at(root: impl AsRef<std::path::Path>) -> bool {
        Folder::reading(root.as_ref())
            .and_then(|folder| folder.is_paused())
            .unwrap_or(false)
    }

    /// Pauses the directory's sync. Answers whether it was running: pausing a
    /// directory that is paused changes nothing. The directory and what the
    /// store keeps of its files are left as they are.
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

    /// Lets the directory's sync go on. Answers whether it was paused. The
    /// next sync sends what changed in the directory and pulls what changed on
    /// the server, as a watch that starts again does.
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

    /// Tells the server the directory is paused, or no longer is, with one
    /// attempt that a failure does not turn into the command's.
    fn report_pause(&self) {
        self.health_observe(false, true, None, None, false);
        self.health_send();
    }

    /// Each command that reads the server's side or writes either side starts here.
    pub(super) fn refuse_while_paused(&self) -> Result<()> {
        if self.is_paused()? {
            return Err(CoreError::Invalid(
                "this directory's sync is paused, so nothing is sent or written until `folders resume` lets it go on"
                    .into(),
            ));
        }
        Ok(())
    }
}
