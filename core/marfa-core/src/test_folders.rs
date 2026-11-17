//! What the unit tests make that a plain `TempDir` does not remove.

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// A path held at a mode a test chose. Dropping it gives the owner access
/// back, so the folder that holds it is removed even when the test fails
/// while it is locked. Declare it after the `TempDir`, so it drops first.
#[cfg(unix)]
pub(crate) struct Locked(PathBuf);

#[cfg(unix)]
pub(crate) fn locked(path: impl AsRef<Path>, mode: u32) -> Locked {
    let path = path.as_ref().to_path_buf();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode)).unwrap();
    Locked(path)
}

#[cfg(unix)]
impl Drop for Locked {
    fn drop(&mut self) {
        let owner = if self.0.is_dir() { 0o700 } else { 0o600 };
        let _ = std::fs::set_permissions(&self.0, std::fs::Permissions::from_mode(owner));
    }
}

static PROCESS_FOLDER: OnceLock<PathBuf> = OnceLock::new();

/// A folder that lasts as long as the test process and is removed when it
/// exits.
pub(crate) fn process_folder() -> PathBuf {
    PROCESS_FOLDER
        .get_or_init(|| {
            let folder = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap())
                .expect("a temporary directory for the tests")
                .keep();
            // SAFETY: `remove` takes no arguments and touches only the
            // folder made here.
            #[cfg(unix)]
            unsafe {
                libc::atexit(remove)
            };
            folder
        })
        .clone()
}

#[cfg(unix)]
extern "C" fn remove() {
    if let Some(folder) = PROCESS_FOLDER.get() {
        let _ = std::fs::remove_dir_all(folder);
    }
}
