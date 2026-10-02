use std::fs::Metadata;
use std::path::Path;

use serde_json::Value;

use crate::model::Item;

pub const FIELD: &str = "executable";

#[cfg(unix)]
pub fn of(metadata: &Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    metadata.permissions().mode() & 0o100 != 0
}

#[cfg(not(unix))]
pub fn of(_metadata: &Metadata) -> bool {
    false
}

pub fn held(item: &Item) -> bool {
    item.properties
        .get(FIELD)
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

/// A volume that keeps no permissions, such as exFAT, shows every file as
/// one its owner may run.
#[cfg(unix)]
pub fn kept(dir: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    let probe = dir.join(".permission-probe");
    let keeps = std::fs::write(&probe, b"")
        .and_then(|()| std::fs::set_permissions(&probe, std::fs::Permissions::from_mode(0o644)))
        .and_then(|()| std::fs::symlink_metadata(&probe))
        .is_ok_and(|metadata| !of(&metadata))
        && std::fs::set_permissions(&probe, std::fs::Permissions::from_mode(0o755))
            .and_then(|()| std::fs::symlink_metadata(&probe))
            .is_ok_and(|metadata| of(&metadata));
    let _ = std::fs::remove_file(&probe);
    keeps
}

#[cfg(not(unix))]
pub fn kept(_dir: &Path) -> bool {
    false
}

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

#[cfg(target_os = "macos")]
pub const QUARANTINE: &str = "com.apple.quarantine";

/// Marks a file as one that arrived from elsewhere, as a browser marks a
/// download. Flags `0081` are a download's as browsers write them; the empty
/// last field names no download event.
#[cfg(target_os = "macos")]
pub fn quarantine(path: &Path) -> std::io::Result<()> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |since| since.as_secs());
    xattr::set(
        path,
        QUARANTINE,
        format!("0081;{now:08x};Marfa;").as_bytes(),
    )
}

#[cfg(not(target_os = "macos"))]
pub fn quarantine(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

/// Answers `true` where the mark is there, or where nothing keeps one.
#[cfg(target_os = "macos")]
pub fn quarantined(path: &Path) -> bool {
    xattr::get(path, QUARANTINE).is_ok_and(|found| found.is_some())
}

#[cfg(not(target_os = "macos"))]
pub fn quarantined(_path: &Path) -> bool {
    true
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[cfg(target_os = "macos")]
    #[test]
    fn a_quarantined_file_carries_the_attribute_gatekeeper_reads() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("tool.command");
        std::fs::write(&path, b"#!/bin/sh\n").unwrap();
        assert!(xattr::get(&path, QUARANTINE).unwrap().is_none());
        quarantine(&path).unwrap();
        let value = xattr::get(&path, QUARANTINE).unwrap().unwrap();
        assert!(String::from_utf8(value).unwrap().starts_with("0081;"));
    }

    fn mode_after(start: u32, executable: bool) -> u32 {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("file");
        std::fs::write(&path, b"bytes").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(start)).unwrap();
        set(&path, executable).unwrap();
        std::fs::metadata(&path).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn a_volume_that_keeps_permissions_is_told_so() {
        let dir = tempfile::tempdir().unwrap();
        assert!(kept(dir.path()));
        assert!(!dir.path().join(".permission-probe").exists());
    }

    #[test]
    fn execute_follows_each_read_bit_and_goes_from_all_three() {
        assert_eq!(mode_after(0o644, true), 0o755);
        assert_eq!(mode_after(0o600, true), 0o700);
        assert_eq!(mode_after(0o755, false), 0o644);
    }
}
