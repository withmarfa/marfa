//! A file's executable permission, kept as `executable` on its file item
//! (`folders.md` 50).

use std::fs::Metadata;
use std::path::Path;

use serde_json::Value;

use crate::model::Item;

pub const FIELD: &str = "executable";

/// Whether the file's owner may run it.
#[cfg(unix)]
pub fn of(metadata: &Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    metadata.permissions().mode() & 0o100 != 0
}

#[cfg(not(unix))]
pub fn of(_metadata: &Metadata) -> bool {
    false
}

/// Whether the item says its file may be run.
pub fn held(item: &Item) -> bool {
    item.properties
        .get(FIELD)
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

/// Gives the file the permission, adding execute where each read bit is set,
/// as `chmod +x` does, or taking all three away.
#[cfg(unix)]
pub fn set(path: &Path, executable: bool) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let metadata = std::fs::symlink_metadata(path)?;
    if !metadata.is_file() {
        return Ok(());
    }
    let mut permissions = metadata.permissions();
    let mode = permissions.mode();
    let wanted = if executable {
        mode | ((mode & 0o444) >> 2)
    } else {
        mode & !0o111
    };
    if wanted != mode {
        permissions.set_mode(wanted);
        std::fs::set_permissions(path, permissions)?;
    }
    Ok(())
}

#[cfg(not(unix))]
pub fn set(_path: &Path, _executable: bool) -> std::io::Result<()> {
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn mode_after(start: u32, executable: bool) -> u32 {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("file");
        std::fs::write(&path, b"bytes").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(start)).unwrap();
        set(&path, executable).unwrap();
        std::fs::metadata(&path).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn execute_follows_each_read_bit_and_goes_from_all_three() {
        assert_eq!(mode_after(0o644, true), 0o755);
        assert_eq!(mode_after(0o600, true), 0o700);
        assert_eq!(mode_after(0o755, false), 0o644);
    }
}
