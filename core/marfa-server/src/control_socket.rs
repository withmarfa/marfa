//! The private control socket's path: who holds it, and what is left there.

use std::fs::{File, OpenOptions, TryLockError};
use std::io::ErrorKind;
use std::os::unix::fs::{DirBuilderExt, FileTypeExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};

use crate::failure::Failure;

const PRIVATE_FOLDER: u32 = 0o700;
const PRIVATE_FILE: u32 = 0o600;

/// The right to serve at a path. A lock file beside the socket settles who
/// may look at what is there, and stays locked until the process has gone, so
/// a start cannot take the path from a server that is still closing.
pub struct Claim {
    path: PathBuf,
    lock: File,
}

fn in_use(path: &Path) -> Failure {
    Failure::start(format!(
        "Control socket path is already in use: {}",
        path.display()
    ))
}

fn prepare_folder(path: &Path) -> Result<(), Failure> {
    let Some(folder) = path.parent().filter(|p| !p.as_os_str().is_empty()) else {
        return Ok(());
    };
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(PRIVATE_FOLDER)
        .create(folder)
        .map_err(|error| {
            Failure::start(format!(
                "{} could not be created: {error}",
                folder.display()
            ))
        })
}

fn take_lock(path: &Path) -> Result<File, Failure> {
    let mut name = path.as_os_str().to_owned();
    name.push(".lock");
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .mode(PRIVATE_FILE)
        .open(PathBuf::from(name))
        .map_err(|error| {
            Failure::start(format!(
                "The lock beside {} could not be opened: {error}",
                path.display()
            ))
        })?;
    match lock.try_lock() {
        Ok(()) => Ok(lock),
        Err(TryLockError::WouldBlock) => Err(in_use(path)),
        Err(TryLockError::Error(error)) => Err(Failure::start(format!(
            "The lock beside {} could not be taken: {error}",
            path.display()
        ))),
    }
}

fn clear_stale(path: &Path) -> Result<(), Failure> {
    let unreadable = |error: std::io::Error| {
        Failure::start(format!("{} could not be read: {error}", path.display()))
    };
    let found = match std::fs::symlink_metadata(path) {
        Ok(found) => found,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(unreadable(error)),
    };
    if !found.file_type().is_socket() {
        return Err(Failure::start(format!(
            "Control socket already exists: {}",
            path.display()
        )));
    }
    match UnixStream::connect(path) {
        Ok(_) => Err(in_use(path)),
        Err(error) if error.kind() == ErrorKind::ConnectionRefused => {
            std::fs::remove_file(path).map_err(unreadable)
        }
        Err(error) => Err(unreadable(error)),
    }
}

impl Claim {
    /// Takes the path, replacing a socket no process is listening on and
    /// leaving alone anything else.
    pub fn take(path: &Path) -> Result<Claim, Failure> {
        prepare_folder(path)?;
        let lock = take_lock(path)?;
        clear_stale(path)?;
        Ok(Claim {
            path: path.to_path_buf(),
            lock,
        })
    }

    /// Binds the socket, readable by the server's own user alone.
    pub fn bind(&self) -> Result<UnixListener, Failure> {
        let refused = |error: std::io::Error| {
            Failure::start(format!(
                "The control socket {} could not be bound: {error}",
                self.path.display()
            ))
        };
        let listener = UnixListener::bind(&self.path).map_err(refused)?;
        std::fs::set_permissions(&self.path, std::fs::Permissions::from_mode(PRIVATE_FILE))
            .map_err(refused)?;
        listener.set_nonblocking(true).map_err(refused)?;
        Ok(listener)
    }

    /// Removes the socket and keeps the lock until the process exits.
    pub fn release(self) {
        if let Err(error) = std::fs::remove_file(&self.path) {
            tracing::warn!(error = %error, "The control socket was not removed");
        }
        std::mem::forget(self.lock);
    }
}
