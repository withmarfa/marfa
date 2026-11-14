//! A lock file a running server holds beside what it alone may change. The kernel lets it go
//! when the process ends, however it ends.

use std::fs::{File, OpenOptions, TryLockError};
use std::io;
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;

pub enum Untaken {
    /// Another process holds it.
    Held,
    Failed(io::Error),
}

/// Takes the lock at `path`, making the file private where it is new.
pub fn take(path: &Path) -> Result<File, Untaken> {
    // A FIFO planted there would block the open, and a link would lock a file elsewhere.
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(Untaken::Failed)?;
    if !file.metadata().map_err(Untaken::Failed)?.is_file() {
        return Err(Untaken::Failed(io::Error::other("it is not a file")));
    }
    match file.try_lock() {
        Ok(()) => Ok(file),
        Err(TryLockError::WouldBlock) => Err(Untaken::Held),
        Err(TryLockError::Error(error)) => Err(Untaken::Failed(error)),
    }
}
