//! The writer lock is an exclusive transaction on a database file of its own
//! beside the store. The kernel drops it when the process ends, however it
//! ends, so there is no stale lock to reap and no recycled pid to check. It is
//! not the store itself because both handles read the store in WAL mode.

use std::path::Path;
use std::sync::Mutex;

use rusqlite::Connection;

use crate::error::CoreError;

/// The lock's file in a folder's state directory, beside the store.
pub(crate) const DIRECTORY_LOCK: &str = "core.sqlite.writer-lock";

/// How often a lock file is opened to get a connection that can write.
#[cfg(unix)]
const OPENS: usize = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Handle {
    Writer,
    Reader,
}

pub struct WriterLock {
    /// Dropping it releases the lock. Behind a `Mutex` because a `Connection`
    /// is not `Sync` and the bindings hand a `Core` across threads.
    _claim: Mutex<Option<Connection>>,
    handle: Handle,
    /// Another lock held for as long as this one.
    _with: Option<Box<WriterLock>>,
}

impl WriterLock {
    /// An in-memory store (`None`) is always the writer.
    pub fn claim(store: Option<&Path>) -> Result<WriterLock, CoreError> {
        let Some(store) = store else {
            return Ok(WriterLock {
                _claim: Mutex::new(None),
                handle: Handle::Writer,
                _with: None,
            });
        };
        let path = lock_path(store);
        crate::owner_only(&path)?;
        let claim = Connection::open(&path)?;
        Self::claim_connection(claim)
    }

    #[cfg(unix)]
    pub(crate) fn claim_directory(
        vfs: &crate::directory_vfs::DirectoryVfs,
    ) -> Result<Self, CoreError> {
        Self::claim_named(vfs, DIRECTORY_LOCK, true)
    }

    /// The lock in the file `name` of the directory `vfs` reaches. Without
    /// `create`, a file that is not there is an error.
    ///
    /// SQLite opens a file it cannot open for writing read-only without
    /// saying so, and a read-only connection takes `BEGIN EXCLUSIVE` as a read
    /// transaction that holds only a shared lock. macOS refuses a create that
    /// races another create of the same name with `ENOENT`, which makes SQLite
    /// fall back to that, so a claim that is not checked can report the writer
    /// role while holding nothing. The file exists by then, so a second open
    /// is a write open.
    #[cfg(unix)]
    pub(crate) fn claim_named(
        vfs: &crate::directory_vfs::DirectoryVfs,
        name: &str,
        create: bool,
    ) -> Result<Self, CoreError> {
        let mut flags =
            rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX;
        if create {
            flags |= rusqlite::OpenFlags::SQLITE_OPEN_CREATE;
        }
        for _ in 0..OPENS {
            let claim = vfs.open(name, flags)?;
            if !claim.is_readonly("main")? {
                return Self::claim_connection(claim);
            }
        }
        Err(CoreError::Store(format!(
            "{name} cannot be opened for writing, so it cannot be locked"
        )))
    }

    /// Whether an exclusive holder keeps a named lock. Shared read probes
    /// coexist, so simultaneous observers cannot pass for exclusive holders.
    /// Never creates a missing lock file.
    #[cfg(unix)]
    pub(crate) fn held_named(
        vfs: &crate::directory_vfs::DirectoryVfs,
        name: &str,
    ) -> Result<bool, CoreError> {
        let probe = vfs.open(
            name,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        probe.busy_timeout(std::time::Duration::ZERO)?;
        match probe.query_row("SELECT count(*) FROM sqlite_schema", [], |row| {
            row.get::<_, i64>(0)
        }) {
            Ok(_) => Ok(false),
            Err(error) if is_busy(&error) => Ok(true),
            Err(error) => Err(error.into()),
        }
    }

    fn claim_connection(claim: Connection) -> Result<Self, CoreError> {
        // Zero: waiting would make a second opener hang instead of being told
        // it may only read.
        claim.busy_timeout(std::time::Duration::from_millis(0))?;
        match claim.execute_batch("BEGIN EXCLUSIVE") {
            Ok(()) => Ok(WriterLock {
                _claim: Mutex::new(Some(claim)),
                handle: Handle::Writer,
                _with: None,
            }),
            Err(error) if is_busy(&error) => Ok(WriterLock {
                _claim: Mutex::new(None),
                handle: Handle::Reader,
                _with: None,
            }),
            Err(error) => Err(error.into()),
        }
    }

    /// Never touches the lock file, so it cannot keep the writer role from
    /// anyone.
    pub fn reader() -> WriterLock {
        WriterLock {
            _claim: Mutex::new(None),
            handle: Handle::Reader,
            _with: None,
        }
    }

    /// This lock, holding `other` until it is dropped.
    pub(crate) fn holding(mut self, other: WriterLock) -> WriterLock {
        self._with = Some(Box::new(other));
        self
    }

    pub fn handle(&self) -> Handle {
        self.handle
    }

    pub fn refuse_unless_writer(&self) -> Result<(), CoreError> {
        match self.handle {
            Handle::Writer => Ok(()),
            Handle::Reader => Err(CoreError::ReadingHandle),
        }
    }
}

/// Appended, not put in place of the extension: `notes.sqlite` and `notes.db`
/// in one folder are two stores, and one lock would make the second a reader.
fn lock_path(store: &Path) -> std::path::PathBuf {
    let mut name = store.as_os_str().to_owned();
    name.push(".writer-lock");
    std::path::PathBuf::from(name)
}

fn is_busy(error: &rusqlite::Error) -> bool {
    matches!(
        error.sqlite_error_code(),
        Some(rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_named_probe_never_creates_a_missing_file() {
        let temp = tempfile::tempdir().unwrap();
        let state =
            crate::directory::Directory::open(&temp.path().canonicalize().unwrap()).unwrap();
        let vfs = crate::directory_vfs::DirectoryVfs::new(state.file()).unwrap();
        let name = "request-lock";
        assert!(WriterLock::held_named(&vfs, name).is_err());
        assert!(!temp.path().join(name).exists());
        let held = WriterLock::claim_named(&vfs, name, true).unwrap();
        assert!(WriterLock::held_named(&vfs, name).unwrap());
        drop(held);
        assert!(!WriterLock::held_named(&vfs, name).unwrap());
    }

    #[cfg(unix)]
    fn state() -> (tempfile::TempDir, crate::directory::Directory) {
        let temp = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let state = crate::directory::Directory::open(temp.path()).unwrap();
        (temp, state)
    }

    #[cfg(unix)]
    #[test]
    fn a_lock_file_that_cannot_be_written_is_refused_not_claimed() {
        use std::os::unix::fs::PermissionsExt;
        let (temp, state) = state();
        let vfs = crate::directory_vfs::DirectoryVfs::new(state.file()).unwrap();
        let name = "request-lock";
        drop(WriterLock::claim_named(&vfs, name, true).unwrap());
        let mode = |mode| {
            std::fs::set_permissions(
                temp.path().join(name),
                std::fs::Permissions::from_mode(mode),
            )
            .unwrap();
        };
        mode(0o400);
        for create in [true, false] {
            let claim = WriterLock::claim_named(&vfs, name, create);
            assert!(
                matches!(&claim, Err(CoreError::Store(message)) if message.contains(name)),
                "create {create}: {:?}",
                claim.map(|lock| lock.handle())
            );
        }
        // The witness: with the file writable again, the same call claims it
        // and an exclusive holder is seen.
        mode(0o600);
        let claim = WriterLock::claim_named(&vfs, name, true).unwrap();
        assert_eq!(claim.handle(), Handle::Writer);
        assert!(WriterLock::held_named(&vfs, name).unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn of_two_claims_creating_a_lock_file_at_once_the_writer_holds_it() {
        let witnessed = std::sync::atomic::AtomicUsize::new(0);
        for _ in 0..200 {
            let (_temp, state) = state();
            let vfs = crate::directory_vfs::DirectoryVfs::new(state.file()).unwrap();
            let start = std::sync::Barrier::new(2);
            let claims: Vec<WriterLock> = std::thread::scope(|scope| {
                let asking: Vec<_> = (0..2)
                    .map(|_| {
                        scope.spawn(|| {
                            start.wait();
                            WriterLock::claim_named(&vfs, "request-lock", true).unwrap()
                        })
                    })
                    .collect();
                asking.into_iter().map(|a| a.join().unwrap()).collect()
            });
            let writers = claims
                .iter()
                .filter(|claim| claim.handle() == Handle::Writer)
                .count();
            assert!(writers <= 1, "two claims were the writer");
            // Both may be refused when each sees the other mid-claim; a
            // writer, though, must hold the lock a probe finds.
            if writers == 1 {
                witnessed.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                assert!(
                    WriterLock::held_named(&vfs, "request-lock").unwrap(),
                    "a claim reported the writer role without holding the lock"
                );
            }
        }
        assert!(
            witnessed.load(std::sync::atomic::Ordering::SeqCst) > 0,
            "no round had a writer, so nothing was checked"
        );
    }

    #[test]
    fn a_named_probe_preserves_non_lock_errors() {
        let temp = tempfile::tempdir().unwrap();
        let state =
            crate::directory::Directory::open(&temp.path().canonicalize().unwrap()).unwrap();
        let vfs = crate::directory_vfs::DirectoryVfs::new(state.file()).unwrap();
        let name = "request-lock";
        std::fs::write(temp.path().join(name), b"not a SQLite database").unwrap();
        assert!(WriterLock::held_named(&vfs, name).is_err());
    }

    #[test]
    fn a_second_opener_gets_a_reading_handle() {
        let dir = tempfile::tempdir().unwrap();
        let store = dir.path().join("core.sqlite");

        let first = WriterLock::claim(Some(&store)).unwrap();
        assert_eq!(first.handle(), Handle::Writer);
        assert!(first.refuse_unless_writer().is_ok());

        let second = WriterLock::claim(Some(&store)).unwrap();
        assert_eq!(second.handle(), Handle::Reader);
        assert_eq!(second.refuse_unless_writer(), Err(CoreError::ReadingHandle));

        drop(first);
        drop(second);
        let third = WriterLock::claim(Some(&store)).unwrap();
        assert_eq!(third.handle(), Handle::Writer);
    }

    #[test]
    fn two_stores_sharing_a_stem_each_have_a_writer() {
        let dir = tempfile::tempdir().unwrap();
        let first = WriterLock::claim(Some(&dir.path().join("notes.sqlite"))).unwrap();
        let second = WriterLock::claim(Some(&dir.path().join("notes.db"))).unwrap();
        assert_eq!(
            (first.handle(), second.handle()),
            (Handle::Writer, Handle::Writer),
            "a store was made a reader by another store's lock"
        );
    }
}
