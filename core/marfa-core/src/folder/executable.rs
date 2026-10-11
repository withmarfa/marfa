use crate::directory::Directory;
#[cfg(unix)]
use crate::directory::{Mode, OFlags};
use std::fs::File;
use std::fs::Metadata;

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
pub(super) fn kept(dir: &Directory) -> bool {
    use std::os::unix::fs::PermissionsExt;
    let probe = std::path::Path::new(".permission-probe");
    let Ok(file) = dir.open_file(
        probe,
        OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL,
        Mode::from_raw_mode(0o600),
    ) else {
        return false;
    };
    let keeps = {
        file.set_permissions(std::fs::Permissions::from_mode(0o644))
            .and_then(|()| file.metadata())
            .is_ok_and(|metadata| !of(&metadata))
            && file
                .set_permissions(std::fs::Permissions::from_mode(0o755))
                .and_then(|()| file.metadata())
                .is_ok_and(|metadata| of(&metadata))
    };
    let _ = dir.unlink(probe);
    keeps
}

#[cfg(not(unix))]
pub(super) fn kept(_dir: &Directory) -> bool {
    false
}

#[cfg(unix)]
pub fn set(file: &File, executable: bool) -> std::io::Result<()> {
    if crate::fault::named("permission-change-fails").is_some() {
        return Err(std::io::Error::other("permission change refused"));
    }
    use std::os::unix::fs::PermissionsExt;
    let metadata = file.metadata()?;
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
        file.set_permissions(permissions)?;
    }
    Ok(())
}

#[cfg(not(unix))]
pub fn set(_file: &File, _executable: bool) -> std::io::Result<()> {
    Ok(())
}

#[cfg(target_os = "macos")]
pub const QUARANTINE: &str = "com.apple.quarantine";

/// Marks a file as one that arrived from elsewhere, as a browser marks a
/// download. Flags `0081` are a download's as browsers write them; the empty
/// last field names no download event.
#[cfg(target_os = "macos")]
pub fn quarantine(file: &File) -> std::io::Result<()> {
    if crate::fault::named("quarantine-fails").is_some() {
        return Err(std::io::Error::other("quarantine marking refused"));
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |since| since.as_secs());
    use xattr::FileExt;
    file.set_xattr(QUARANTINE, format!("0081;{now:08x};Marfa;").as_bytes())
}

#[cfg(not(target_os = "macos"))]
pub fn quarantine(_file: &File) -> std::io::Result<()> {
    Ok(())
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
        quarantine(&File::open(&path).unwrap()).unwrap();
        let value = xattr::get(&path, QUARANTINE).unwrap().unwrap();
        assert!(String::from_utf8(value).unwrap().starts_with("0081;"));
    }

    fn mode_after(start: u32, executable: bool) -> u32 {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("file");
        std::fs::write(&path, b"bytes").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(start)).unwrap();
        set(&File::open(&path).unwrap(), executable).unwrap();
        std::fs::metadata(&path).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn a_volume_that_keeps_permissions_is_told_so() {
        let dir = tempfile::tempdir().unwrap();
        assert!(kept(
            &Directory::open(&dir.path().canonicalize().unwrap()).unwrap()
        ));
        assert!(!dir.path().join(".permission-probe").exists());
    }

    #[test]
    fn execute_follows_each_read_bit_and_goes_from_all_three() {
        assert_eq!(mode_after(0o644, true), 0o755);
        assert_eq!(mode_after(0o600, true), 0o700);
        assert_eq!(mode_after(0o755, false), 0o644);
    }
    #[test]
    fn a_probe_name_that_already_exists_is_not_removed() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        std::fs::write(root.join(".permission-probe"), b"belongs to the person").unwrap();
        assert!(!kept(&Directory::open(&root).unwrap()));
        assert_eq!(
            std::fs::read(root.join(".permission-probe")).unwrap(),
            b"belongs to the person"
        );
    }
}
