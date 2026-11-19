//! The writer lock is an exclusive transaction on a database file of its own
//! beside the store. The kernel drops it when the process ends, however it
//! ends, so there is no stale lock to reap and no recycled pid to check. It is
//! not the store itself because both handles read the store in WAL mode.

use std::path::Path;
use std::sync::Mutex;

use rusqlite::Connection;

use crate::error::CoreError;
use crate::file_cache::Place;

/// The lock's file in a folder's state directory, beside the store.
pub(crate) const DIRECTORY_LOCK: &str = "core.sqlite.writer-lock";

/// How often a lock file is opened to get a connection that can write.
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
        let path = lock_path(&linked(store)?);
        crate::owner_only(&path)?;
        Self::claim_opened(
            &path.display().to_string(),
            Some(Place::Named(&path)),
            || Ok(Connection::open(&path)?),
            || std::fs::symlink_metadata(&path).map(drop),
        )
    }

    #[cfg(unix)]
    pub(crate) fn claim_directory(
        vfs: &crate::directory_vfs::DirectoryVfs,
    ) -> Result<Self, CoreError> {
        Self::claim_named(vfs, DIRECTORY_LOCK, true)
    }

    /// The lock in the file `name` of the directory `vfs` reaches. Without
    /// `create`, a file that is not there is an error.
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
        Self::claim_opened(
            name,
            Some(Place::Held(vfs.directory())),
            || vfs.open(name, flags),
            || vfs.stat(name),
        )
    }

    /// The lock on the file `open` opens, named `file` in an error, with
    /// `stat` looking the name up without opening it. Every lock
    /// is claimed here, so none can be the writer on a connection that cannot
    /// write, or on a file its name no longer reaches.
    ///
    /// SQLite opens a file read-only without saying so when it cannot open it
    /// for writing, and `BEGIN EXCLUSIVE` on that connection succeeds with
    /// only a shared lock. That also happens to a file whose creation raced
    /// another's on macOS (one open fails with `ENOENT`), so a read-only
    /// connection is opened again before the claim is refused.
    ///
    /// A holder may remove the lock's name between this open and the claim,
    /// and a later opener then makes and locks a new file under it, so a
    /// claim on a file that is no longer the one its name reaches is let go
    /// and the name opened again.
    fn claim_opened(
        file: &str,
        place: Option<Place<'_>>,
        mut open: impl FnMut() -> Result<Connection, CoreError>,
        stat: impl Fn() -> std::io::Result<()>,
    ) -> Result<Self, CoreError> {
        let mut replaced = false;
        for _ in 0..OPENS {
            let claim = open()?;
            if claim.is_readonly("main")? {
                continue;
            }
            match Self::claim_connection(claim, place, &stat)? {
                Some(lock) => return Ok(lock),
                None => replaced = true,
            }
        }
        Err(CoreError::Store(if replaced {
            format!(
                "{file} was removed or replaced each time it was locked, so it cannot be locked: try again"
            )
        } else {
            format!(
                "{file} cannot be opened for writing, so it cannot be locked: check that it is writable"
            )
        }))
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

    /// `None` where the name the claim opened no longer reaches its file.
    fn claim_connection(
        claim: Connection,
        place: Option<Place<'_>>,
        stat: &dyn Fn() -> std::io::Result<()>,
    ) -> Result<Option<Self>, CoreError> {
        // Zero: waiting would make a second opener hang instead of being told
        // it may only read.
        claim.busy_timeout(std::time::Duration::from_millis(0))?;
        match claim.execute_batch("BEGIN EXCLUSIVE") {
            Ok(()) if name_moved(&claim, stat)? => Ok(None),
            Ok(()) => Ok(Some(WriterLock {
                _claim: Mutex::new(Some(claim)),
                handle: Handle::Writer,
                _with: None,
            })),
            Err(error) if is_busy(&error) => Ok(Some(WriterLock::reader())),
            // SQLite reads the name's mode to make the journal, so a name
            // that is gone fails the claim instead. A failure the name's
            // absence does not explain is the claim's own.
            Err(error) => match name_moved(&claim, stat) {
                Ok(true) => Ok(None),
                Ok(false) | Err(_) => Err(crate::store::on_volume(error, place)),
            },
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
pub(crate) fn lock_path(store: &Path) -> std::path::PathBuf {
    let mut name = store.as_os_str().to_owned();
    name.push(".writer-lock");
    std::path::PathBuf::from(name)
}

/// The file a symbolic link at `store`'s own name leads to, followed as
/// SQLite follows it, so the store opened through a link has the lock of the
/// file it reaches. A link in a folder above already reaches one lock.
fn linked(store: &Path) -> Result<std::path::PathBuf, CoreError> {
    let unreadable = |path: &Path, error: std::io::Error| {
        CoreError::Store(format!("{} cannot be read: {error}", path.display()))
    };
    let mut path = store.to_path_buf();
    for _ in 0..LINKS {
        match std::fs::symlink_metadata(&path) {
            Ok(meta) if meta.file_type().is_symlink() => {
                let target = std::fs::read_link(&path).map_err(|error| unreadable(&path, error))?;
                path = match path.parent() {
                    Some(dir) => dir.join(target),
                    None => target,
                };
            }
            Ok(_) => return Ok(path),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(path),
            Err(error) => return Err(unreadable(&path, error)),
        }
    }
    Err(CoreError::Store(format!(
        "{} leads through more than {LINKS} symbolic links",
        store.display()
    )))
}

/// SQLite's own limit on the links it follows to a store.
const LINKS: usize = 100;

/// Whether the name `claim` opened is established as gone or as reaching
/// another file. SQLite reports a name as moved when its own `stat` fails for
/// any reason, so a report counts only once `stat` finds the name missing, or
/// finds it and the report still stands. Any other `stat` failure is returned.
fn name_moved(
    claim: &Connection,
    stat: &dyn Fn() -> std::io::Result<()>,
) -> Result<bool, CoreError> {
    match stat() {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(true),
        Err(error) => Err(CoreError::Store(format!(
            "the writer lock's file could not be checked against its name: {error}"
        ))),
        Ok(()) => moved(claim),
    }
}

/// Whether the name `claim` opened is gone or reaches another file, by its
/// device and inode. Asked of SQLite, because opening the file again to
/// compare and closing it would drop this process's locks on it.
#[cfg(unix)]
fn moved(claim: &Connection) -> Result<bool, CoreError> {
    let mut moved: std::ffi::c_int = 0;
    // SAFETY: `claim.handle()` is live for the borrow, and SQLite writes one
    // `int` through the pointer for `SQLITE_FCNTL_HAS_MOVED`.
    let rc = unsafe {
        rusqlite::ffi::sqlite3_file_control(
            claim.handle(),
            c"main".as_ptr(),
            rusqlite::ffi::SQLITE_FCNTL_HAS_MOVED,
            std::ptr::from_mut(&mut moved).cast(),
        )
    };
    if rc != rusqlite::ffi::SQLITE_OK {
        return Err(CoreError::Store(format!(
            "the writer lock's file could not be checked against its name (SQLite code {rc})"
        )));
    }
    Ok(moved != 0)
}

/// Windows refuses to remove a file SQLite holds open, so its name cannot
/// move while it is locked.
#[cfg(not(unix))]
fn moved(_claim: &Connection) -> Result<bool, CoreError> {
    Ok(false)
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
    fn a_store_lock_that_cannot_be_written_is_refused_every_time() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let store = dir.path().join("core.sqlite");
        let lock = dir.path().join("core.sqlite.writer-lock");
        drop(WriterLock::claim(Some(&store)).unwrap());
        let mode = |mode| {
            std::fs::set_permissions(&lock, std::fs::Permissions::from_mode(mode)).unwrap();
        };
        mode(0o400);
        for attempt in ["first", "second"] {
            let claim = WriterLock::claim(Some(&store));
            assert!(
                matches!(&claim, Err(CoreError::Store(message)) if message.contains("core.sqlite.writer-lock")),
                "{attempt} claim: {:?}",
                claim.map(|lock| lock.handle())
            );
        }
        // The witness: with the file writable again, the same call claims it.
        mode(0o600);
        let claim = WriterLock::claim(Some(&store)).unwrap();
        assert_eq!(claim.handle(), Handle::Writer);
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

    /// Claims the lock at `store` as the claimer whose first open is followed,
    /// before it locks, by `between` with the lock's path.
    #[cfg(unix)]
    fn claim_after(store: &Path, mut between: impl FnMut(&Path)) -> Result<WriterLock, CoreError> {
        let path = lock_path(store);
        let mut opens = 0;
        WriterLock::claim_opened(
            "lock",
            None,
            || {
                opens += 1;
                let opened = Connection::open(&path)?;
                if opens == 1 {
                    between(&path);
                }
                Ok(opened)
            },
            || std::fs::symlink_metadata(&path).map(drop),
        )
    }

    #[cfg(unix)]
    #[test]
    fn a_claim_whose_lock_file_is_replaced_and_held_before_it_locks_is_a_reader() {
        let dir = tempfile::tempdir().unwrap();
        let store = dir.path().join("core.sqlite");
        let mut other = None;
        let claim = claim_after(&store, |path| {
            std::fs::remove_file(path).unwrap();
            other = Some(WriterLock::claim(Some(&store)).unwrap());
        })
        .unwrap();
        let other = other.unwrap();
        assert_eq!(other.handle(), Handle::Writer);
        assert_eq!(
            claim.handle(),
            Handle::Reader,
            "a claim on an unlinked lock file was a second writer"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_claim_whose_lock_file_is_removed_before_it_locks_holds_the_new_one() {
        let dir = tempfile::tempdir().unwrap();
        let store = dir.path().join("core.sqlite");
        let claim = claim_after(&store, |path| std::fs::remove_file(path).unwrap()).unwrap();
        assert_eq!(claim.handle(), Handle::Writer);
        // The witness that it holds the file its name reaches: a later opener
        // finds it held.
        let later = WriterLock::claim(Some(&store)).unwrap();
        assert_eq!(
            later.handle(),
            Handle::Reader,
            "the claim held a lock file its name no longer reaches"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_claim_whose_lock_file_is_replaced_every_time_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let store = dir.path().join("core.sqlite");
        let path = lock_path(&store);
        let claim = WriterLock::claim_opened(
            "lock",
            None,
            || {
                let opened = Connection::open(&path)?;
                std::fs::remove_file(&path).unwrap();
                Ok(opened)
            },
            || std::fs::symlink_metadata(&path).map(drop),
        );
        assert!(
            matches!(&claim, Err(CoreError::Store(message)) if message.contains("removed or replaced")),
            "{:?}",
            claim.map(|lock| lock.handle())
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_named_claim_whose_file_goes_before_it_locks_is_refused_without_create() {
        let (temp, state) = state();
        let vfs = crate::directory_vfs::DirectoryVfs::new(state.file()).unwrap();
        let name = DIRECTORY_LOCK;
        drop(WriterLock::claim_named(&vfs, name, true).unwrap());
        let flags =
            rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX;
        let mut opens = 0;
        let claim = WriterLock::claim_opened(
            name,
            None,
            || {
                opens += 1;
                let opened = vfs.open(name, flags)?;
                if opens == 1 {
                    std::fs::remove_file(temp.path().join(name)).unwrap();
                }
                Ok(opened)
            },
            || vfs.stat(name),
        );
        assert!(
            claim.is_err(),
            "a claim on a removed lock file was the {:?}",
            claim.map(|lock| lock.handle())
        );
        assert!(!temp.path().join(name).exists());
    }

    /// A connection whose every statement SQLite refuses with a code that is
    /// not a busy one.
    #[cfg(unix)]
    fn refusing(path: &Path) -> Result<Connection, CoreError> {
        unsafe extern "C" fn deny(
            _: *mut std::ffi::c_void,
            _: std::ffi::c_int,
            _: *const std::ffi::c_char,
            _: *const std::ffi::c_char,
            _: *const std::ffi::c_char,
            _: *const std::ffi::c_char,
        ) -> std::ffi::c_int {
            rusqlite::ffi::SQLITE_DENY
        }
        let connection = Connection::open(path)?;
        // SAFETY: the handle is live, and `deny` matches the authorizer callback.
        unsafe {
            rusqlite::ffi::sqlite3_set_authorizer(
                connection.handle(),
                Some(deny),
                std::ptr::null_mut(),
            );
        }
        Ok(connection)
    }

    #[cfg(all(unix, debug_assertions))]
    #[test]
    fn a_claim_that_cannot_make_its_journal_on_a_full_volume_is_storage_full() {
        let dir = tempfile::tempdir().unwrap();
        let store = dir.path().join("core.sqlite");
        let path = lock_path(&store);
        std::os::unix::fs::symlink(
            dir.path().join("nowhere/journal"),
            crate::store::suffixed(&path, "-journal"),
        )
        .unwrap();
        // The witness: the claim fails with room on the volume, and is a
        // store failure, since nothing says the volume is the cause.
        let claim = WriterLock::claim(Some(&store));
        assert!(
            matches!(claim, Err(CoreError::Store(_))),
            "{:?}",
            claim.map(|lock| lock.handle())
        );
        let _full = crate::fault::fail_on_this_thread("volume-full");
        let claim = WriterLock::claim(Some(&store));
        assert!(
            matches!(claim, Err(CoreError::StorageFull(_))),
            "{:?}",
            claim.map(|lock| lock.handle())
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_failed_claim_on_a_name_that_is_still_there_is_returned_not_retried() {
        let dir = tempfile::tempdir().unwrap();
        let path = lock_path(&dir.path().join("core.sqlite"));
        let mut opens = 0;
        let claim = WriterLock::claim_opened(
            "lock",
            None,
            || {
                opens += 1;
                refusing(&path)
            },
            || std::fs::symlink_metadata(&path).map(drop),
        );
        assert!(
            matches!(&claim, Err(CoreError::Store(message)) if message.contains("not authorized")),
            "{:?}",
            claim.map(|lock| lock.handle())
        );
        assert_eq!(opens, 1, "the failure was retried");
        // The witness: the name goes, and the same failure is then retried.
        std::fs::remove_file(&path).unwrap();
        let mut opens = 0;
        let claim = WriterLock::claim_opened(
            "lock",
            None,
            || {
                opens += 1;
                let connection = refusing(&path)?;
                std::fs::remove_file(&path).unwrap();
                Ok(connection)
            },
            || std::fs::symlink_metadata(&path).map(drop),
        );
        assert!(claim.is_err());
        assert_eq!(opens, OPENS, "a failure on a removed name was not retried");
    }

    #[cfg(unix)]
    #[test]
    fn a_failed_claim_whose_name_cannot_be_looked_up_is_returned_not_retried() {
        let dir = tempfile::tempdir().unwrap();
        let path = lock_path(&dir.path().join("core.sqlite"));
        let mut opens = 0;
        let claim = WriterLock::claim_opened(
            "lock",
            None,
            || {
                opens += 1;
                let connection = refusing(&path)?;
                std::fs::remove_file(&path).unwrap();
                Ok(connection)
            },
            || Err(std::io::Error::from_raw_os_error(libc::EIO)),
        );
        assert!(
            matches!(&claim, Err(CoreError::Store(message)) if message.contains("not authorized")),
            "{:?}",
            claim.map(|lock| lock.handle())
        );
        assert_eq!(opens, 1, "a lookup failure was taken for a removed name");
    }

    #[cfg(unix)]
    #[test]
    fn a_claim_whose_name_cannot_be_looked_up_after_it_locks_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let path = lock_path(&dir.path().join("core.sqlite"));
        let claim = WriterLock::claim_opened(
            "lock",
            None,
            || Ok(Connection::open(&path)?),
            || Err(std::io::Error::from_raw_os_error(libc::EIO)),
        );
        assert!(
            matches!(&claim, Err(CoreError::Store(message)) if message.contains("could not be checked")),
            "{:?}",
            claim.map(|lock| lock.handle())
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

    #[cfg(unix)]
    #[test]
    fn a_store_reached_through_a_symbolic_link_has_one_writer() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let store = dir.path().join("core.sqlite");
        let alias = dir.path().join("alias.sqlite");
        let chained = dir.path().join("chained.sqlite");
        symlink(&store, &alias).unwrap();
        symlink("alias.sqlite", &chained).unwrap();
        // Before the store is made, as after.
        for _ in 0..2 {
            let through = WriterLock::claim(Some(&chained)).unwrap();
            assert_eq!(through.handle(), Handle::Writer);
            for name in [&store, &alias] {
                let other = WriterLock::claim(Some(name)).unwrap();
                assert_eq!(other.handle(), Handle::Reader, "{}", name.display());
            }
            drop(through);
            let first = WriterLock::claim(Some(&store)).unwrap();
            assert_eq!(first.handle(), Handle::Writer);
            let linked = WriterLock::claim(Some(&alias)).unwrap();
            assert_eq!(linked.handle(), Handle::Reader);
            drop((first, linked));
            std::fs::write(&store, b"").unwrap();
        }
    }

    #[cfg(unix)]
    #[test]
    fn writer_probe() {
        let Ok(store) = std::env::var("MARFA_TEST_LOCK_PROBE") else {
            return;
        };
        let lock = WriterLock::claim(Some(Path::new(&store))).unwrap();
        println!("handle {:?}", lock.handle());
    }

    #[cfg(unix)]
    #[test]
    fn another_process_opening_a_store_through_a_symbolic_link_is_a_reader() {
        let dir = tempfile::tempdir().unwrap();
        let store = dir.path().join("core.sqlite");
        let alias = dir.path().join("alias.sqlite");
        std::os::unix::fs::symlink(&store, &alias).unwrap();
        let probe = |path: &Path| {
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "lock::tests::writer_probe", "--nocapture"])
                .env("MARFA_TEST_LOCK_PROBE", path)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            String::from_utf8_lossy(&output.stdout).into_owned()
        };
        // The witness: with no writer here, the other process takes the role.
        assert!(probe(&alias).contains("handle Writer"));
        let _writer = WriterLock::claim(Some(&store)).unwrap();
        for path in [&store, &alias] {
            let seen = probe(path);
            assert!(seen.contains("handle Reader"), "{}: {seen}", path.display());
        }
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
