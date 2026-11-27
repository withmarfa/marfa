//! A person's pause of one directory's sync, kept in its own store.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use super::Folder;
use crate::error::CoreError;
use crate::{Result, store};

/// How often a paused directory's pause is read again.
const PAUSE_LOOK: Duration = Duration::from_secs(1);

/// How often the stop is looked at between reads of the pause.
const POLL: Duration = Duration::from_millis(100);

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
        match Folder::reading(root.as_ref()) {
            Ok(folder) => folder.is_paused().unwrap_or(false),
            Err(error) => super::every::paused_unopened(root.as_ref(), &error),
        }
    }

    /// Waits, holding no folder, until the directory at `root` is no longer
    /// paused or is gone, and answers `true`; answers `false` where `stop` is
    /// set first. The command line's watch and a watch an app runs through a
    /// binding share it, so each waits out a pause the same way.
    pub fn wait_resumed(root: &Path, stop: &AtomicBool) -> bool {
        resumed(root, stop, PAUSE_LOOK)
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
    pub(super) fn refuse_unsyncable(&self) -> Result<()> {
        self.refuse_outside()?;
        if self.is_paused()? {
            return Err(CoreError::SyncPaused);
        }
        Ok(())
    }

    /// Refuses while the store holds a record that names a place outside
    /// the folder, which no pass may act on.
    pub(super) fn refuse_outside(&self) -> Result<()> {
        refuse_outside(&*self.core.conn()?, &self.root)
    }
}

/// Refuses while the store of the folder at `root` holds a record that
/// names a place outside it.
pub(super) fn refuse_outside(conn: &rusqlite::Connection, root: &Path) -> Result<()> {
    let records = super::state::outside_records(conn)?;
    if records.is_empty() {
        return Ok(());
    }
    let full = |place: &str| root.join(place).display().to_string();
    let named: Vec<String> = records
        .iter()
        .map(|record| {
            let mut said = full(&record.path);
            if let Some(also) = &record.also {
                said = format!("{said} or {}", full(also));
            }
            if !record.from.is_empty() {
                said = format!("{said} (from {})", full(&record.from));
            }
            said
        })
        .collect();
    Err(CoreError::Store(format!(
        "Marfa will not sync this folder: its store holds records from an earlier release that name files outside it, which Marfa must not change. Each file is still where it was: {}. Move back anything you need, then run `marfa folders remove {}` and add the folder again.",
        named.join("; "),
        root.display()
    )))
}

fn resumed(root: &Path, stop: &AtomicBool, look: Duration) -> bool {
    let mut looked = Instant::now();
    loop {
        if stop.load(Ordering::SeqCst) {
            return false;
        }
        if looked.elapsed() >= look {
            looked = Instant::now();
            if !Folder::is_at(root) || !Folder::paused_at(root) {
                return true;
            }
        }
        std::thread::sleep(POLL.min(look));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::folder::{STATE_DIR, settings_file};

    const QUICK: Duration = Duration::from_millis(20);

    fn bound_dir() -> tempfile::TempDir {
        let dir = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let state = dir.path().join(STATE_DIR);
        std::fs::create_dir_all(&state).unwrap();
        let core = crate::Core::open(state.join("core.sqlite"), None).unwrap();
        settings_file::bind(&core, "01a00000-0000-7000-8000-000000000001").unwrap();
        dir
    }

    #[test]
    fn a_wait_for_a_pause_ends_only_when_the_directory_resumes_or_goes_or_the_watch_stops() {
        let dir = bound_dir();
        let root = dir.path().to_path_buf();
        assert!(Folder::open(&root, None).unwrap().pause_sync().unwrap());

        // Still paused: the wait goes on until the stop, and says it was stopped.
        let stop = AtomicBool::new(false);
        std::thread::scope(|scope| {
            let waiting = scope.spawn(|| resumed(&root, &stop, QUICK));
            std::thread::sleep(10 * QUICK);
            assert!(
                !waiting.is_finished(),
                "ended while the directory was paused"
            );
            stop.store(true, Ordering::SeqCst);
            assert!(!waiting.join().unwrap(), "a stop is not a resume");
        });

        // Resumed under the wait, which holds no folder, so the resume is not refused.
        let stop = AtomicBool::new(false);
        std::thread::scope(|scope| {
            let waiting = scope.spawn(|| resumed(&root, &stop, QUICK));
            std::thread::sleep(10 * QUICK);
            assert!(!waiting.is_finished());
            assert!(Folder::open(&root, None).unwrap().resume_sync().unwrap());
            assert!(waiting.join().unwrap());
        });

        // A directory that goes while it is paused ends the wait too.
        assert!(Folder::open(&root, None).unwrap().pause_sync().unwrap());
        std::fs::remove_dir_all(root.join(STATE_DIR)).unwrap();
        assert!(resumed(&root, &AtomicBool::new(false), QUICK));
    }
}
