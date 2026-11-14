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
    let file = open(path)?;
    let unread = |error: io::Error| Untaken::Refused(format!("could not be read: {error}"));
    let held = file.metadata().map_err(unread)?;
    if !held.is_file()
        || held.uid() != me()
        || held.mode() & 0o777 != PRIVATE_FILE
        || held.nlink() != 1
    {
        return Err(Untaken::Refused(
            "must be a file of the server's account alone, with mode 0600 and one link".into(),
        ));
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
    match file.try_lock() {
        Ok(()) => Ok(file),
        Err(TryLockError::WouldBlock) => Err(Untaken::Held),
        Err(TryLockError::Error(error)) if unsupported(&error) => Err(Untaken::Unsupported(error)),
        Err(TryLockError::Error(error)) => {
            Err(Untaken::Refused(format!("could not be taken: {error}")))
        }
    }
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
    fn a_lock_file_open_to_others_is_refused_not_repaired() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".server-lock");
        drop(take(&path).unwrap());
        std::fs::set_permissions(&path, Permissions::from_mode(0o644)).unwrap();
        assert!(matches!(take(&path), Err(Untaken::Refused(_))));
        assert_eq!(
            std::fs::metadata(&path).unwrap().mode() & 0o777,
            0o644,
            "the mode was changed"
        );
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
    fn a_file_system_without_locks_is_told_apart() {
        for code in [libc::ENOTSUP, libc::EOPNOTSUPP, libc::ENOLCK] {
            assert!(unsupported(&io::Error::from_raw_os_error(code)), "{code}");
        }
        assert!(!unsupported(&io::Error::from_raw_os_error(libc::EACCES)));
    }
}
