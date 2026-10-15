//! Where a folder's directory sits. A directory in iCloud Drive or in a
//! cloud provider's synced location has a second program syncing the same
//! files, and one on a network file system may never hear of a change made
//! from another computer. The core says which; what to do about it is the
//! caller's.

use std::path::{Path, PathBuf};

/// Why a folder's directory is not a plain local one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StorageCause {
    /// iCloud Drive syncs the files: the directory is below
    /// `Library/Mobile Documents`, or macOS reports it as ubiquitous, as it
    /// does for `Desktop` and `Documents` with iCloud's "Desktop & Documents"
    /// on.
    ICloudDrive,
    /// A cloud service's File Provider syncs the files: the directory is
    /// below `Library/CloudStorage`.
    CloudService,
    /// The directory is on a network file system, named as the operating
    /// system names it (`smbfs`, `nfs`, `afpfs`, `webdav` on macOS; `nfs`,
    /// `cifs`, `smb2` on Linux).
    NetworkFileSystem(String),
}

/// The cause for `dir`, or `None` for a directory anywhere else, and for one
/// that cannot be examined. Reads the file system, so it can wait on a mount
/// that does not answer.
pub fn storage_cause(dir: &Path) -> Option<StorageCause> {
    let dir = std::fs::canonicalize(dir).ok()?;
    cause_of(&dir, &homes(), &ubiquitous, &network_file_system)
}

/// The cause for the canonical `dir`, given the homes to look below and what
/// the system says of the directory. Synced locations by path come first: a
/// provider's folder can also be a network volume, and one cause is named.
fn cause_of(
    dir: &Path,
    homes: &[PathBuf],
    ubiquitous: &dyn Fn(&Path) -> bool,
    network: &dyn Fn(&Path) -> Option<String>,
) -> Option<StorageCause> {
    if homes
        .iter()
        .any(|home| under(dir, home, "Library/Mobile Documents"))
    {
        return Some(StorageCause::ICloudDrive);
    }
    if homes
        .iter()
        .any(|home| under(dir, home, "Library/CloudStorage"))
    {
        return Some(StorageCause::CloudService);
    }
    if ubiquitous(dir) {
        return Some(StorageCause::ICloudDrive);
    }
    network(dir).map(StorageCause::NetworkFileSystem)
}

/// Whether the canonical `dir` is `below` or inside it, where `below` is
/// named from `home`. Both are resolved first, so a link to either still
/// finds the other.
fn under(dir: &Path, home: &Path, below: &str) -> bool {
    let resolved = |path: PathBuf| std::fs::canonicalize(&path).unwrap_or(path);
    let location = resolved(resolved(home.to_path_buf()).join(below));
    dir.starts_with(location)
}

/// The home directory the operating system records for the user, and the one
/// `HOME` names. Files in iCloud Drive are in the recorded home whatever
/// `HOME` says, as the credential locks are; `HOME` is what a person's
/// shell, a profile or a test sets as home, so either counts.
fn homes() -> Vec<PathBuf> {
    let mut homes = Vec::new();
    #[cfg(unix)]
    homes.extend(user_home().ok());
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from)
        && home.is_absolute()
        && !homes.contains(&home)
    {
        homes.push(home);
    }
    homes
}

/// The home directory the operating system records for the effective user.
#[cfg(unix)]
pub fn user_home() -> std::io::Result<PathBuf> {
    use std::ffi::CStr;
    use std::io::{Error, ErrorKind};
    use std::os::unix::ffi::OsStrExt;
    let unrecorded = |what: &str| Error::new(ErrorKind::NotFound, what.to_string());
    let mut size = 1024;
    loop {
        let mut buffer = vec![0u8; size];
        let mut entry = std::mem::MaybeUninit::<libc::passwd>::uninit();
        let mut result = std::ptr::null_mut();
        // The entry and buffer remain live until pw_dir has been copied.
        let status = unsafe {
            libc::getpwuid_r(
                libc::geteuid(),
                entry.as_mut_ptr(),
                buffer.as_mut_ptr().cast(),
                buffer.len(),
                &mut result,
            )
        };
        if status == libc::ERANGE {
            size = size
                .checked_mul(2)
                .ok_or_else(|| unrecorded("the operating-system user record is too large"))?;
            continue;
        }
        if status != 0 {
            return Err(Error::from_raw_os_error(status));
        }
        if result.is_null() {
            return Err(unrecorded(
                "the operating-system user has no home directory",
            ));
        }
        // A successful lookup populated the entry; pw_dir lives in buffer.
        let entry = unsafe { entry.assume_init() };
        if entry.pw_dir.is_null() {
            return Err(unrecorded(
                "the operating-system user has no home directory",
            ));
        }
        let home = PathBuf::from(std::ffi::OsStr::from_bytes(unsafe {
            CStr::from_ptr(entry.pw_dir).to_bytes()
        }));
        if !home.is_absolute() {
            return Err(Error::new(
                ErrorKind::InvalidData,
                "the operating-system user's home directory is not absolute",
            ));
        }
        return Ok(home);
    }
}

/// Whether macOS reports `dir` as an item iCloud Drive syncs
/// (`kCFURLIsUbiquitousItemKey`). That is how `Desktop` and `Documents` are
/// told, being real directories outside `Library/Mobile Documents`. The
/// question is answered locally, with no prompt.
#[cfg(target_os = "macos")]
fn ubiquitous(dir: &Path) -> bool {
    use core_foundation::array::CFArray;
    use core_foundation::base::{CFType, TCFType};
    use core_foundation::boolean::CFBoolean;
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::string::CFString;
    use core_foundation::url::{
        CFURL, CFURLCopyResourcePropertiesForKeys, kCFURLIsUbiquitousItemKey,
    };
    let Some(url) = CFURL::from_path(dir, true) else {
        return false;
    };
    // The key is a constant of CoreFoundation, held by it for the process.
    let key = unsafe { CFString::wrap_under_get_rule(kCFURLIsUbiquitousItemKey) };
    let keys = CFArray::from_CFTypes(std::slice::from_ref(&key));
    // Copies a dictionary of the properties asked for, or null on failure.
    let found = unsafe {
        CFURLCopyResourcePropertiesForKeys(
            url.as_concrete_TypeRef(),
            keys.as_concrete_TypeRef(),
            std::ptr::null_mut(),
        )
    };
    if found.is_null() {
        return false;
    }
    let properties: CFDictionary<CFString, CFType> =
        unsafe { CFDictionary::wrap_under_create_rule(found) };
    properties
        .find(&key)
        .and_then(|value| value.downcast::<CFBoolean>())
        .is_some_and(bool::from)
}

#[cfg(not(target_os = "macos"))]
fn ubiquitous(_: &Path) -> bool {
    false
}

/// The name of the network file system `dir` is on, where it is on one.
#[cfg(target_os = "macos")]
fn network_file_system(dir: &Path) -> Option<String> {
    let found = rustix::fs::statfs(dir).ok()?;
    let name: Vec<u8> = found
        .f_fstypename
        .iter()
        .take_while(|byte| **byte != 0)
        .map(|byte| *byte as u8)
        .collect();
    network_by_name(std::str::from_utf8(&name).ok()?).map(str::to_string)
}

/// The name of the network file system `dir` is on, where it is on one.
#[cfg(target_os = "linux")]
fn network_file_system(dir: &Path) -> Option<String> {
    let found = rustix::fs::statfs(dir).ok()?;
    // The field is a signed or unsigned word of varying width; the magic
    // numbers all fit the low 32 bits.
    network_by_magic(found.f_type as u32).map(str::to_string)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn network_file_system(_: &Path) -> Option<String> {
    None
}

/// `statfs` names a file system on macOS by the name its driver registered.
#[cfg(target_os = "macos")]
fn network_by_name(name: &str) -> Option<&'static str> {
    ["smbfs", "nfs", "afpfs", "webdav"]
        .into_iter()
        .find(|network| *network == name)
}

/// The magic numbers Linux reports for NFS, CIFS and SMB2 or SMB3 mounts
/// (`NFS_SUPER_MAGIC`, `CIFS_SUPER_MAGIC` and `SMB2_SUPER_MAGIC` in the
/// kernel's `linux/magic.h`).
#[cfg(target_os = "linux")]
fn network_by_magic(magic: u32) -> Option<&'static str> {
    match magic {
        0x6969 => Some("nfs"),
        0xFF53_4D42 => Some("cifs"),
        0xFE53_4D42 => Some("smb2"),
        _ => None,
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn tempdir() -> tempfile::TempDir {
        tempfile::tempdir_in(std::fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap()
    }

    fn made(home: &Path, below: &str) -> PathBuf {
        let dir = home.join(below);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::canonicalize(dir).unwrap()
    }

    fn neither(_: &Path) -> bool {
        false
    }

    fn local(_: &Path) -> Option<String> {
        None
    }

    fn found(dir: &Path, homes: &[PathBuf]) -> Option<StorageCause> {
        cause_of(dir, homes, &neither, &local)
    }

    #[test]
    fn icloud_drive_and_a_providers_synced_location_each_have_their_cause() {
        let temp = tempdir();
        let home = temp.path().to_path_buf();
        let icloud = made(&home, "Library/Mobile Documents/com~apple~CloudDocs/notes");
        let provider = made(&home, "Library/CloudStorage/Dropbox/notes");
        let elsewhere = made(&home, "Documents/notes");
        let homes = [home];
        assert_eq!(found(&icloud, &homes), Some(StorageCause::ICloudDrive));
        assert_eq!(found(&provider, &homes), Some(StorageCause::CloudService));
        // The witness: the same home and the same checks find nothing for a
        // directory elsewhere in it.
        assert_eq!(found(&elsewhere, &homes), None);
    }

    #[test]
    fn a_name_that_only_begins_like_a_synced_location_is_not_one() {
        let temp = tempdir();
        let home = temp.path().to_path_buf();
        let homes = [home.clone()];
        for below in [
            "Library/Mobile Documents2/notes",
            "Library/CloudStorageOld/notes",
            "Library/Mobile",
            "Mobile Documents/notes",
            "notes/Library/CloudStorage/notes",
        ] {
            assert_eq!(found(&made(&home, below), &homes), None, "{below}");
        }
        let exact = made(&home, "Library/Mobile Documents/notes");
        assert_eq!(found(&exact, &homes), Some(StorageCause::ICloudDrive));
    }

    #[test]
    fn a_link_to_a_synced_location_is_followed_to_where_the_files_are() {
        let temp = tempdir();
        let home = temp.path().to_path_buf();
        let target = made(&home, "Library/CloudStorage/Dropbox");
        let link = home.join("Dropbox");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        // `storage_cause` resolves the directory first.
        let resolved = std::fs::canonicalize(&link).unwrap();
        assert_eq!(found(&resolved, &[home]), Some(StorageCause::CloudService));
    }

    #[test]
    fn either_home_the_process_has_counts() {
        let (recorded, environment) = (tempdir(), tempdir());
        let one = made(recorded.path(), "Library/CloudStorage/Box/notes");
        let other = made(environment.path(), "Library/Mobile Documents/notes");
        let homes = [
            recorded.path().to_path_buf(),
            environment.path().to_path_buf(),
        ];
        assert_eq!(found(&one, &homes), Some(StorageCause::CloudService));
        assert_eq!(found(&other, &homes), Some(StorageCause::ICloudDrive));
        // The witness: with only the first home, the second's is not found.
        assert_eq!(found(&other, &homes[..1]), None);
    }

    #[test]
    fn a_directory_macos_reports_as_ubiquitous_is_in_icloud_drive_wherever_it_sits() {
        let temp = tempdir();
        let home = temp.path().to_path_buf();
        let documents = made(&home, "Documents/notes");
        let downloads = made(&home, "Downloads/notes");
        let homes = [home];
        let reported = |dir: &Path| dir.starts_with(documents.parent().unwrap());
        assert_eq!(
            cause_of(&documents, &homes, &reported, &local),
            Some(StorageCause::ICloudDrive)
        );
        // The witness: the same answer, asked of a directory it is false for.
        assert_eq!(cause_of(&downloads, &homes, &reported, &local), None);
    }

    #[test]
    fn a_path_cause_is_settled_without_asking_the_system() {
        let temp = tempdir();
        let home = temp.path().to_path_buf();
        let provider = made(&home, "Library/CloudStorage/Box/notes");
        let asked = std::cell::Cell::new(0);
        let counting = |_: &Path| {
            asked.set(asked.get() + 1);
            true
        };
        let cause = cause_of(&provider, std::slice::from_ref(&home), &counting, &local);
        assert_eq!(cause, Some(StorageCause::CloudService));
        assert_eq!(asked.get(), 0);
        let plain = made(&home, "Documents/notes");
        cause_of(&plain, &[home], &counting, &local);
        assert_eq!(
            asked.get(),
            1,
            "the system was not asked about a plain path"
        );
    }

    #[test]
    fn a_network_file_system_is_named_after_the_synced_locations() {
        let temp = tempdir();
        let dir = made(temp.path(), "notes");
        let nfs = |_: &Path| Some("nfs".to_string());
        assert_eq!(
            cause_of(&dir, &[], &neither, &nfs),
            Some(StorageCause::NetworkFileSystem("nfs".into()))
        );
        assert_eq!(cause_of(&dir, &[], &neither, &local), None);
        // A synced location that is also on a network volume names one cause.
        let provider = made(temp.path(), "Library/CloudStorage/Box/notes");
        assert_eq!(
            cause_of(&provider, &[temp.path().to_path_buf()], &neither, &nfs),
            Some(StorageCause::CloudService)
        );
    }

    #[test]
    fn a_directory_that_cannot_be_examined_has_no_cause() {
        let temp = tempdir();
        assert_eq!(storage_cause(&temp.path().join("gone")), None);
    }

    #[test]
    fn the_file_system_of_an_ordinary_directory_is_read_and_is_not_a_network_one() {
        let temp = tempdir();
        // The witness: the call reads a file system at all.
        assert!(rustix::fs::statfs(temp.path()).is_ok());
        assert_eq!(network_file_system(temp.path()), None);
        assert_eq!(storage_cause(temp.path()), None);
        assert!(!ubiquitous(temp.path()));
    }

    #[test]
    fn the_recorded_home_is_an_absolute_directory() {
        assert!(user_home().unwrap().is_absolute());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_names_four_network_file_systems() {
        for name in ["smbfs", "nfs", "afpfs", "webdav"] {
            assert_eq!(network_by_name(name), Some(name), "{name}");
        }
        for name in [
            "apfs", "hfs", "msdos", "exfat", "ntfs", "nfsd", "autofs", "",
        ] {
            assert_eq!(network_by_name(name), None, "{name}");
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_names_nfs_cifs_and_smb2_by_their_magic_numbers() {
        assert_eq!(network_by_magic(0x6969), Some("nfs"));
        assert_eq!(network_by_magic(0xFF53_4D42), Some("cifs"));
        assert_eq!(network_by_magic(0xFE53_4D42), Some("smb2"));
        for magic in [0xEF53, 0x0102_1994, 0x9123_683E, 0x517B, 0x6969_0000, 0] {
            assert_eq!(network_by_magic(magic), None, "{magic:#x}");
        }
    }
}
