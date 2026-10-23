//! How much of the volume the file cache may take, and keeping it out of
//! backups.
//!
//! A person's files are fetched when opened and kept in a folder beside the
//! store (`device/blob-kept-beside`). The budget bounds that folder; a trim
//! (`blob::Cache::trim`) enforces it.

use std::fs::File;
use std::io;
use std::path::Path;

use serde::Serialize;

const GIB: u64 = 1024 * 1024 * 1024;

/// What the default budget is never below, and what stands where the volume
/// cannot be read.
pub const DEFAULT_FLOOR: u64 = 2 * GIB;

/// The setting in the store's `meta` table; absent for the default.
pub(crate) const META_BUDGET: &str = "file_budget";
const KEEP_ALL: &str = "keep_all";

/// How the cache's budget is chosen.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FileBudget {
    /// The share of the volume the contract states (`device/budget-default`).
    Default,
    /// This many bytes.
    Bytes(u64),
    /// No budget: every file fetched stays.
    KeepAll,
}

impl FileBudget {
    pub(crate) fn stored(text: Option<&str>) -> FileBudget {
        match text {
            None => FileBudget::Default,
            Some(KEEP_ALL) => FileBudget::KeepAll,
            Some(digits) => digits
                .parse()
                .map_or(FileBudget::Default, FileBudget::Bytes),
        }
    }

    pub(crate) fn to_stored(self) -> Option<String> {
        match self {
            FileBudget::Default => None,
            FileBudget::Bytes(bytes) => Some(bytes.to_string()),
            FileBudget::KeepAll => Some(KEEP_ALL.into()),
        }
    }
}

/// The cache as the state report gives it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct FileCache {
    /// What was chosen.
    pub setting: FileBudget,
    /// The budget in force, in bytes; `None` while every file fetched is
    /// kept.
    pub budget: Option<u64>,
    /// The bytes of the files kept now.
    pub held: u64,
    /// Whether the default budget is the floor because the volume holding
    /// the cache could not be read.
    pub volume_unreadable: bool,
}

/// The figures of the volume that holds the cache.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Volume {
    pub(crate) size: u64,
    pub(crate) free: u64,
}

/// The budget in force, and what it was worked out from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct InForce {
    /// `None` while every file fetched is kept.
    pub(crate) bytes: Option<u64>,
    /// Whether the default rule fell back to its floor because the volume
    /// could not be read.
    pub(crate) volume_unreadable: bool,
}

/// What the default rule gives, with `held` bytes in the cache now.
///
/// The share is a tenth of the volume, never under the floor. A trim that
/// reaches it must also leave a twentieth of the volume free, which the
/// bytes already held count towards, since a trim hands them back.
pub(crate) fn default_budget(volume: Volume, held: u64) -> u64 {
    let share = (volume.size / 10).max(DEFAULT_FLOOR);
    let room = held
        .saturating_add(volume.free)
        .saturating_sub(volume.size / 20);
    share.min(room)
}

pub(crate) fn in_force(setting: FileBudget, volume: Option<Volume>, held: u64) -> InForce {
    match setting {
        FileBudget::KeepAll => InForce {
            bytes: None,
            volume_unreadable: false,
        },
        FileBudget::Bytes(bytes) => InForce {
            bytes: Some(bytes),
            volume_unreadable: false,
        },
        FileBudget::Default => match volume {
            Some(volume) => InForce {
                bytes: Some(default_budget(volume, held)),
                volume_unreadable: false,
            },
            None => InForce {
                bytes: Some(DEFAULT_FLOOR),
                volume_unreadable: true,
            },
        },
    }
}

/// The volume holding `directory`, or the nearest of its parents that
/// exists, since the cache's own folder is made by the first fetch.
///
/// A debug build reads `MARFA_TEST_FAULT` first: `volume=<size>:<free>` in
/// bytes stands for the volume, and `volume-unreadable` for a volume that
/// cannot be read, since no fixture can choose its runner's disk.
pub(crate) fn read_volume(directory: &Path) -> Option<Volume> {
    if crate::fault::named("volume-unreadable").is_some() {
        return None;
    }
    if let Some(figures) = crate::fault::named("volume") {
        let (size, free) = figures.split_once(':')?;
        return Some(Volume {
            size: size.parse().ok()?,
            free: free.parse().ok()?,
        });
    }
    statvfs(directory)
}

#[cfg(unix)]
fn statvfs(directory: &Path) -> Option<Volume> {
    directory.ancestors().find_map(|ancestor| {
        let ancestor = if ancestor.as_os_str().is_empty() {
            Path::new(".")
        } else {
            ancestor
        };
        let figures = rustix::fs::statvfs(ancestor).ok()?;
        let unit = figures.f_frsize;
        Some(Volume {
            size: figures.f_blocks.saturating_mul(unit),
            free: figures.f_bavail.saturating_mul(unit),
        })
    })
}

#[cfg(not(unix))]
fn statvfs(_directory: &Path) -> Option<Volume> {
    None
}

/// The extended attribute `NSURL`'s `isExcludedFromBackup` writes, which
/// Time Machine and the device backup read. Its value is not part of the
/// documented interface, so these are the bytes the Foundation of each
/// platform wrote for the resource value, read back with `xattr`.
#[cfg(any(target_os = "macos", target_os = "ios"))]
const EXCLUDE_ATTRIBUTE: &std::ffi::CStr = c"com.apple.metadata:com_apple_backup_excludeItem";

#[cfg(target_os = "macos")]
const EXCLUDE_VALUE: &[u8] = &[
    0x62, 0x70, 0x6c, 0x69, 0x73, 0x74, 0x30, 0x30, 0x5f, 0x10, 0x11, b'c', b'o', b'm', b'.', b'a',
    b'p', b'p', b'l', b'e', b'.', b'b', b'a', b'c', b'k', b'u', b'p', b'd', 0x08, 0, 0, 0, 0, 0, 0,
    1, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x1c,
];

#[cfg(target_os = "ios")]
const EXCLUDE_VALUE: &[u8] = b"com.apple.MobileBackup";

/// Marks the directory `folder` is open on as excluded from backups, where
/// it is not marked already. Does nothing off Apple platforms, where no
/// backup reads the mark.
#[cfg(any(target_os = "macos", target_os = "ios"))]
pub(crate) fn exclude_from_backup(folder: &File) -> io::Result<()> {
    use std::os::fd::AsRawFd;
    let fd = folder.as_raw_fd();
    let held = unsafe {
        libc::fgetxattr(
            fd,
            EXCLUDE_ATTRIBUTE.as_ptr(),
            std::ptr::null_mut(),
            0,
            0,
            0,
        )
    };
    if held >= 0 {
        return Ok(());
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() != Some(libc::ENOATTR) {
        return Err(error);
    }
    let set = unsafe {
        libc::fsetxattr(
            fd,
            EXCLUDE_ATTRIBUTE.as_ptr(),
            EXCLUDE_VALUE.as_ptr().cast(),
            EXCLUDE_VALUE.len(),
            0,
            0,
        )
    };
    if set == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
pub(crate) fn exclude_from_backup(_folder: &File) -> io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const TB: u64 = 1_000_000_000_000;

    #[test]
    fn the_default_is_a_tenth_of_the_volume_when_the_volume_has_room() {
        let volume = Volume {
            size: TB,
            free: TB / 2,
        };
        assert_eq!(default_budget(volume, 0), TB / 10);
    }

    #[test]
    fn the_default_is_never_below_the_floor_on_a_small_volume() {
        let volume = Volume {
            size: 10_000_000_000,
            free: 8_000_000_000,
        };
        assert_eq!(default_budget(volume, 0), DEFAULT_FLOOR);
    }

    #[test]
    fn the_default_leaves_a_twentieth_of_the_volume_free_counting_what_is_held() {
        let volume = Volume {
            size: TB,
            free: TB / 20 + 7,
        };
        assert_eq!(default_budget(volume, 0), 7);
        assert_eq!(default_budget(volume, 5), 12);
    }

    #[test]
    fn the_default_is_never_below_zero() {
        let volume = Volume { size: TB, free: 1 };
        assert_eq!(default_budget(volume, 0), 0);
    }

    #[test]
    fn a_volume_that_cannot_be_read_gives_the_floor() {
        let forced = in_force(FileBudget::Default, None, 123);
        assert_eq!(forced.bytes, Some(DEFAULT_FLOOR));
        assert!(forced.volume_unreadable);
    }

    #[test]
    fn a_set_budget_ignores_the_volume() {
        let volume = Volume { size: TB, free: 0 };
        assert_eq!(
            in_force(FileBudget::Bytes(9), Some(volume), 0).bytes,
            Some(9)
        );
        assert_eq!(in_force(FileBudget::KeepAll, Some(volume), 0).bytes, None);
    }

    #[test]
    fn a_setting_is_stored_and_read_back() {
        for setting in [
            FileBudget::Default,
            FileBudget::Bytes(0),
            FileBudget::Bytes(u64::MAX),
            FileBudget::KeepAll,
        ] {
            assert_eq!(FileBudget::stored(setting.to_stored().as_deref()), setting);
        }
    }

    #[cfg(unix)]
    #[test]
    fn the_volume_of_a_folder_not_made_yet_is_its_parents() {
        let dir = tempfile::tempdir().unwrap();
        let volume = read_volume(&dir.path().join("not-yet.blobs")).expect("a volume");
        assert!(volume.size > 0 && volume.free <= volume.size);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_folder_is_excluded_from_time_machine_and_again_once_found_unmarked() {
        // The system excludes its own temporary folders, so the witness has to
        // sit under the home folder.
        let home = std::env::var_os("HOME").expect("HOME");
        let area = tempfile::Builder::new()
            .prefix(".marfa-backup-test-")
            .tempdir_in(home)
            .unwrap();
        let included = area.path().join("included");
        let folder = area.path().join("excluded");
        std::fs::create_dir(&included).unwrap();
        std::fs::create_dir(&folder).unwrap();
        let excluded = |path: &Path| {
            let said = std::process::Command::new("tmutil")
                .arg("isexcluded")
                .arg(path)
                .output()
                .unwrap();
            let said = String::from_utf8_lossy(&said.stdout).into_owned();
            assert!(
                said.contains("[Included]") || said.contains("[Excluded]"),
                "{said}"
            );
            said.contains("[Excluded]")
        };
        assert!(
            !excluded(&included),
            "the witness folder was excluded before anything marked it"
        );
        assert!(!excluded(&folder));
        let open = File::open(&folder).unwrap();
        exclude_from_backup(&open).unwrap();
        assert!(
            excluded(&folder),
            "tmutil does not see the folder as excluded"
        );
        assert!(!excluded(&included));

        let status = std::process::Command::new("xattr")
            .args(["-d", "com.apple.metadata:com_apple_backup_excludeItem"])
            .arg(&folder)
            .status()
            .unwrap();
        assert!(status.success());
        assert!(!excluded(&folder));
        exclude_from_backup(&open).unwrap();
        assert!(
            excluded(&folder),
            "a folder found unmarked was not marked again"
        );
    }
}
