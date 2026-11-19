//! A lock a running server holds on a file of its own; the kernel lets it go when the process ends.

use std::fs::{File, OpenOptions, Permissions, TryLockError};
use std::io::{self, ErrorKind};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::Path;

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

fn me() -> u32 {
    // SAFETY: `geteuid` takes nothing and cannot fail.
    unsafe { libc::geteuid() }
}

fn unsupported(error: &io::Error) -> bool {
    matches!(
        error.raw_os_error(),
        Some(code) if code == libc::ENOTSUP || code == libc::EOPNOTSUPP || code == libc::ENOLCK
    )
}

/// A FIFO planted at the path would block the open, and a link would lock a file elsewhere.
fn open(path: &Path) -> Result<File, Untaken> {
    let flags = libc::O_NOFOLLOW | libc::O_NONBLOCK;
    let made = OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .mode(PRIVATE_FILE)
        .custom_flags(flags)
        .open(path);
    match made {
        Ok(file) => {
            file.set_permissions(Permissions::from_mode(PRIVATE_FILE))
                .map_err(|error| Untaken::Refused(format!("could not be made private: {error}")))?;
            Ok(file)
        }
        Err(error) if error.kind() == ErrorKind::AlreadyExists => OpenOptions::new()
            .read(true)
            .write(true)
            .custom_flags(flags)
            .open(path)
            .map_err(|error| Untaken::Refused(format!("could not be opened: {error}"))),
        Err(error) => Err(Untaken::Refused(format!("could not be opened: {error}"))),
    }
}

/// Takes the lock at `path`, a file of the server's account alone that no other name reaches.
pub fn take(path: &Path) -> Result<File, Untaken> {
    take_as(path, me())
}

/// A mount option or a restore can open the server's own file to its group, which a start mends.
fn take_as(path: &Path, me: u32) -> Result<File, Untaken> {
    let file = open(path)?;
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
    if held.mode() & 0o777 != PRIVATE_FILE {
        file.set_permissions(Permissions::from_mode(PRIVATE_FILE))
            .map_err(|error| Untaken::Refused(format!("could not be made private: {error}")))?;
    }
    match marfa_acl::grants_by_acl(path) {
        Ok(false) => {}
        Ok(true) => {
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
    let named = std::fs::symlink_metadata(path).map_err(unread)?;
    if (named.dev(), named.ino()) != (held.dev(), held.ino()) {
        return Err(Untaken::Refused("changed while it was opened".into()));
    }
    match try_lock(&file) {
        Ok(()) => Ok(file),
        Err(TryLockError::WouldBlock) => Err(Untaken::Held),
        Err(TryLockError::Error(error)) if unsupported(&error) => Err(Untaken::Unsupported(error)),
        Err(TryLockError::Error(error)) => {
            Err(Untaken::Refused(format!("could not be taken: {error}")))
        }
    }
}

#[cfg(test)]
thread_local! {
    static NO_LOCKS: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Runs `run` as if every file system took no locks, on this thread.
#[cfg(test)]
pub fn without_locks<T>(run: impl FnOnce() -> T) -> T {
    NO_LOCKS.set(true);
    let ran = run();
    NO_LOCKS.set(false);
    ran
}

fn try_lock(file: &File) -> Result<(), TryLockError> {
    #[cfg(test)]
    if NO_LOCKS.get() {
        return Err(TryLockError::Error(io::Error::from_raw_os_error(
            libc::ENOTSUP,
        )));
    }
    file.try_lock()
}

#[cfg(test)]
mod tests {
    use super::*;

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
