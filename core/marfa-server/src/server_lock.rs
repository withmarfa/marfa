//! A lock a running server holds on a file of its own; the kernel lets it go when the process ends.

use std::fs::{File, OpenOptions, TryLockError};
use std::io;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::Path;

use rustix::fs::{AtFlags, Mode, OFlags};

const PRIVATE_FILE: u32 = 0o600;

#[derive(Debug)]
pub enum Untaken {
    /// Another process holds it.
    Held,
    /// The file system takes no locks.
    Unsupported(io::Error),
    /// What is wrong with the lock file, worded to follow its path.
    Refused(String),
}

pub(crate) fn me() -> u32 {
    // SAFETY: `geteuid` takes nothing and cannot fail.
    unsafe { libc::geteuid() }
}

pub(crate) fn unsupported(error: &io::Error) -> bool {
    matches!(
        error.raw_os_error(),
        Some(code) if code == libc::ENOTSUP || code == libc::EOPNOTSUPP || code == libc::ENOLCK
    )
}

/// A FIFO planted at the name would block the open, and a link would lock a file elsewhere.
fn open_in(dir: &File, name: &str) -> Result<File, Untaken> {
    let flags = OFlags::RDWR | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC;
    let opened = |error: rustix::io::Errno| {
        Untaken::Refused(format!("could not be opened: {}", io::Error::from(error)))
    };
    match rustix::fs::openat(
        dir,
        name,
        flags | OFlags::CREATE | OFlags::EXCL,
        Mode::from_raw_mode(PRIVATE_FILE as _),
    ) {
        Ok(made) => Ok(File::from(made)),
        Err(rustix::io::Errno::EXIST) => rustix::fs::openat(dir, name, flags, Mode::empty())
            .map(File::from)
            .map_err(opened),
        Err(error) => Err(opened(error)),
    }
}

/// Takes the lock at `path`, a file of the server's account alone that no other name reaches.
pub fn take(path: &Path) -> Result<File, Untaken> {
    let (dir, name) = parent_of(path)?;
    take_in(&dir, &name, me())
}

fn parent_of(path: &Path) -> Result<(File, String), Untaken> {
    let unnamed = || Untaken::Refused("does not end in a file name".into());
    let name = path.file_name().ok_or_else(unnamed)?;
    let name = name.to_str().ok_or_else(unnamed)?.to_string();
    let parent = match path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent,
        _ => Path::new("."),
    };
    let dir = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NONBLOCK)
        .open(parent)
        .map_err(|error| Untaken::Refused(format!("is in a folder that could not be opened: {error}")))?;
    Ok((dir, name))
}

/// Takes the lock file `name` in the folder `dir`. Nothing is changed, past making a missing
/// file, until the lock is known to be free: a mount option or a restore can open the server's
/// own file to its group, which is mended only once the lock is taken.
pub(crate) fn take_in(dir: &File, name: &str, me: u32) -> Result<File, Untaken> {
    let file = open_in(dir, name)?;
    let unread = |error: io::Error| Untaken::Refused(format!("could not be read: {error}"));
    let held = file.metadata().map_err(unread)?;
    if held.is_file() && held.nlink() == 1 && held.uid() != me {
        return Err(Untaken::Refused(
            "belongs to another account; a network share that maps every owner to one account does this"
                .into(),
        ));
    }
    if !held.is_file() || held.nlink() != 1 {
        return Err(Untaken::Refused(
            "must be a file the server's account owns, with one link".into(),
        ));
    }
    match marfa_acl::reach(&file, me) {
        Ok(reach) if !reach.itself => {}
        Ok(_) => {
            return Err(Untaken::Refused(
                "has an access control list that grants access".into(),
            ));
        }
        Err(error) => {
            return Err(Untaken::Refused(format!(
                "has an access control list that could not be read: {error}"
            )));
        }
    }
    let named = rustix::fs::statat(dir, name, AtFlags::SYMLINK_NOFOLLOW)
        .map_err(|error| unread(error.into()))?;
    if (named.st_dev as u64, named.st_ino as u64) != (held.dev(), held.ino()) {
        return Err(Untaken::Refused("changed while it was opened".into()));
    }
    match try_lock(&file) {
        Ok(()) => {}
        Err(TryLockError::WouldBlock) => return Err(Untaken::Held),
        Err(TryLockError::Error(error)) if unsupported(&error) => {
            return Err(Untaken::Unsupported(error));
        }
        Err(TryLockError::Error(error)) => {
            return Err(Untaken::Refused(format!("could not be taken: {error}")));
        }
    }
    if held.mode() & 0o777 != PRIVATE_FILE {
        rustix::fs::fchmod(&file, Mode::from_raw_mode(PRIVATE_FILE as _)).map_err(|error| {
            Untaken::Refused(format!("could not be made private: {}", io::Error::from(error)))
        })?;
    }
    Ok(file)
}

#[cfg(test)]
thread_local! {
    static NO_LOCKS: std::cell::Cell<Option<i32>> = const { std::cell::Cell::new(None) };
}

/// Runs `run` as if every file system took no locks, on this thread.
#[cfg(test)]
pub fn without_locks<T>(run: impl FnOnce() -> T) -> T {
    without_locks_answering(libc::ENOTSUP, run)
}

/// Runs `run` as if every lock on this thread failed with the error `code`.
#[cfg(test)]
pub fn without_locks_answering<T>(code: i32, run: impl FnOnce() -> T) -> T {
    NO_LOCKS.set(Some(code));
    let ran = run();
    NO_LOCKS.set(None);
    ran
}

/// Locks `file`, a lock file or a folder, for this open file description alone.
pub(crate) fn try_lock(file: &File) -> Result<(), TryLockError> {
    #[cfg(test)]
    if let Some(code) = NO_LOCKS.get() {
        return Err(TryLockError::Error(io::Error::from_raw_os_error(code)));
    }
    file.try_lock()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::Permissions;
    use std::os::unix::fs::PermissionsExt as _;

    fn take_as(path: &Path, me: u32) -> Result<File, Untaken> {
        let (dir, name) = parent_of(path)?;
        take_in(&dir, &name, me)
    }

    #[test]
    fn a_lock_file_with_a_second_link_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".server-lock");
        drop(take(&path).unwrap());
        std::fs::hard_link(&path, dir.path().join("other")).unwrap();
        match take(&path) {
            Err(Untaken::Refused(why)) => assert!(why.contains("one link"), "{why}"),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_lock_file_of_the_servers_own_that_lost_its_mode_is_made_private_and_taken() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".server-lock");
        drop(take(&path).unwrap());
        for lost in [0o660, 0o644, 0o664] {
            std::fs::set_permissions(&path, Permissions::from_mode(lost)).unwrap();
            drop(take(&path).unwrap());
            assert_eq!(
                std::fs::metadata(&path).unwrap().mode() & 0o777,
                PRIVATE_FILE
            );
        }
    }

    #[test]
    fn a_lock_file_open_to_others_is_refused_and_left_as_it_was_unless_it_is_the_servers_alone() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".server-lock");
        drop(take(&path).unwrap());
        let mode = || std::fs::metadata(&path).unwrap().mode() & 0o777;
        std::fs::set_permissions(&path, Permissions::from_mode(0o644)).unwrap();
        assert!(matches!(take_as(&path, me() + 1), Err(Untaken::Refused(_))));
        assert_eq!(
            mode(),
            0o644,
            "the mode of another account's file was changed"
        );

        let other = dir.path().join("other");
        std::fs::hard_link(&path, &other).unwrap();
        assert!(matches!(take(&path), Err(Untaken::Refused(_))));
        assert_eq!(
            mode(),
            0o644,
            "the mode of a file with a second link was changed"
        );

        // The witness: with the second link gone, the same file is made private.
        std::fs::remove_file(&other).unwrap();
        drop(take(&path).unwrap());
        assert_eq!(mode(), PRIVATE_FILE);
    }

    #[test]
    fn a_lock_another_holder_has_is_held_and_one_let_go_is_taken() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".server-lock");
        let first = take(&path).unwrap();
        assert!(matches!(take(&path), Err(Untaken::Held)));
        drop(first);
        take(&path).unwrap();
    }

    #[test]
    fn a_lock_another_holder_has_is_refused_without_its_mode_changing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".server-lock");
        let _first = take(&path).unwrap();
        std::fs::set_permissions(&path, Permissions::from_mode(0o660)).unwrap();
        assert!(matches!(take(&path), Err(Untaken::Held)));
        assert_eq!(std::fs::metadata(&path).unwrap().mode() & 0o777, 0o660);
    }

    #[test]
    fn a_lock_on_a_file_system_without_locks_is_unsupported() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".server-lock");
        assert!(matches!(
            without_locks(|| take(&path)),
            Err(Untaken::Unsupported(_))
        ));
    }

    #[test]
    fn a_file_system_without_locks_is_told_apart() {
        for code in [libc::ENOTSUP, libc::EOPNOTSUPP, libc::ENOLCK] {
            assert!(unsupported(&io::Error::from_raw_os_error(code)), "{code}");
        }
        assert!(!unsupported(&io::Error::from_raw_os_error(libc::EACCES)));
    }
}
