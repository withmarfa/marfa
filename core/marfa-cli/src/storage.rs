//! Where a folder's directory sits. A directory in iCloud Drive or in a
//! cloud provider's synced location has a second program syncing the same
//! files, and one on a network file system may never hear of a change made
//! from another computer. Either way the CLI warns once per folder per run
//! and goes on.

use std::collections::HashSet;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

static WARNED: Mutex<Option<HashSet<PathBuf>>> = Mutex::new(None);

/// Warns on standard error, once per run for this folder, if its directory
/// sits in cloud-synced or network storage. Never fails: a directory that
/// cannot be examined is not warned of.
pub fn warn(dir: &Path) {
    warn_with(
        dir,
        &homes(),
        &network_file_system,
        &WARNED,
        &mut std::io::stderr(),
    );
}

fn warn_with(
    dir: &Path,
    homes: &[PathBuf],
    network: &dyn Fn(&Path) -> Option<String>,
    warned: &Mutex<Option<HashSet<PathBuf>>>,
    out: &mut dyn Write,
) {
    let Ok(dir) = std::fs::canonicalize(dir) else {
        return;
    };
    let mut warned = warned
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if warned.get_or_insert_default().contains(&dir) {
        return;
    }
    let Some(text) = notice(&dir, homes, network) else {
        return;
    };
    warned.get_or_insert_default().insert(dir);
    let _ = writeln!(out, "{text}");
}

/// The warning for a canonical `dir`, or nothing for a directory anywhere
/// else. A synced location by path comes first: a provider's folder can also
/// be a network volume, and one warning names the cause that is more useful.
fn notice(
    dir: &Path,
    homes: &[PathBuf],
    network: &dyn Fn(&Path) -> Option<String>,
) -> Option<String> {
    let shown = dir.display();
    if homes
        .iter()
        .any(|home| under(dir, home, "Library/Mobile Documents"))
    {
        return Some(format!(
            "marfa: warning: {shown} is in iCloud Drive, which syncs its files itself, so a second program syncs the same files as Marfa and the two can overwrite each other's changes or leave conflicting copies; Marfa goes on"
        ));
    }
    if homes
        .iter()
        .any(|home| under(dir, home, "Library/CloudStorage"))
    {
        return Some(format!(
            "marfa: warning: {shown} is in a location a cloud service syncs itself, so a second program syncs the same files as Marfa and the two can overwrite each other's changes or leave conflicting copies; Marfa goes on"
        ));
    }
    let kind = network(dir)?;
    Some(format!(
        "marfa: warning: {shown} is on a network file system ({kind}), where a change made from another computer may not be noticed, so a watch can miss it until a later full scan; Marfa goes on"
    ))
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
    homes.extend(crate::auth::user_home().ok());
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from)
        && home.is_absolute()
        && !homes.contains(&home)
    {
        homes.push(home);
    }
    homes
}

/// The name of the network file system `dir` is on, where it is on one.
#[cfg(unix)]
fn network_file_system(dir: &Path) -> Option<String> {
    let found = file_system_of(dir)?;
    #[cfg(target_os = "macos")]
    return network_by_name(&found).map(str::to_string);
    #[cfg(target_os = "linux")]
    return network_by_magic(found).map(str::to_string);
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = found;
        None
    }
}

#[cfg(not(unix))]
fn network_file_system(_: &Path) -> Option<String> {
    None
}

/// What `statfs` says of the file system holding `dir`: its type name on
/// macOS, its magic number on Linux.
#[cfg(all(unix, target_os = "macos"))]
fn file_system_of(dir: &Path) -> Option<String> {
    let found = statfs(dir)?;
    let name: Vec<u8> = found
        .f_fstypename
        .iter()
        .take_while(|byte| **byte != 0)
        .map(|byte| *byte as u8)
        .collect();
    String::from_utf8(name).ok()
}

#[cfg(all(unix, target_os = "linux"))]
fn file_system_of(dir: &Path) -> Option<u32> {
    // The field is a signed or unsigned word of varying width; the magic
    // numbers all fit the low 32 bits.
    statfs(dir).map(|found| found.f_type as u32)
}

#[cfg(all(unix, not(any(target_os = "macos", target_os = "linux"))))]
fn file_system_of(dir: &Path) -> Option<()> {
    statfs(dir).map(|_| ())
}

#[cfg(unix)]
fn statfs(dir: &Path) -> Option<libc::statfs> {
    use std::os::unix::ffi::OsStrExt;
    let path = std::ffi::CString::new(dir.as_os_str().as_bytes()).ok()?;
    let mut found = std::mem::MaybeUninit::<libc::statfs>::uninit();
    // `path` is a valid C string for the call, and `found` is read only if
    // the call reports success, which is when it has filled it.
    let status = unsafe { libc::statfs(path.as_ptr(), found.as_mut_ptr()) };
    (status == 0).then(|| unsafe { found.assume_init() })
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
        dir
    }

    fn said(dir: &Path, homes: &[PathBuf], network: &dyn Fn(&Path) -> Option<String>) -> String {
        let (warned, mut out) = (Mutex::new(None), Vec::new());
        warn_with(dir, homes, network, &warned, &mut out);
        String::from_utf8(out).unwrap()
    }

    fn local(_: &Path) -> Option<String> {
        None
    }

    #[test]
    fn icloud_drive_and_a_providers_synced_location_each_name_their_cause() {
        let temp = tempdir();
        let home = temp.path().to_path_buf();
        let icloud = made(&home, "Library/Mobile Documents/com~apple~CloudDocs/notes");
        let provider = made(&home, "Library/CloudStorage/Dropbox/notes");
        let elsewhere = made(&home, "Documents/notes");
        let homes = [home.clone()];

        let text = said(&icloud, &homes, &local);
        assert!(text.starts_with("marfa: warning: "), "{text}");
        assert!(text.contains("iCloud Drive"), "{text}");
        assert!(text.contains(icloud.to_str().unwrap()), "{text}");
        assert_eq!(text.lines().count(), 1, "{text}");

        let text = said(&provider, &homes, &local);
        assert!(text.contains("cloud service"), "{text}");
        assert!(!text.contains("iCloud Drive"), "{text}");

        // The witness: the same home and the same checks say nothing of a
        // directory elsewhere in it.
        assert_eq!(said(&elsewhere, &homes, &local), "");
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
            assert_eq!(said(&made(&home, below), &homes, &local), "", "{below}");
        }
        // The witness: the exact name beside the first of them is one.
        let exact = made(&home, "Library/Mobile Documents/notes");
        assert_ne!(said(&exact, &homes, &local), "");
    }

    #[test]
    fn a_link_to_a_synced_location_is_followed_to_where_the_files_are() {
        let temp = tempdir();
        let home = temp.path().to_path_buf();
        let target = made(&home, "Library/CloudStorage/Dropbox");
        let link = home.join("Dropbox");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert_ne!(said(&link, std::slice::from_ref(&home), &local), "");
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
        assert_ne!(said(&one, &homes, &local), "");
        assert_ne!(said(&other, &homes, &local), "");
        // The witness: with only the first home, the second's is not found.
        assert_eq!(said(&other, &homes[..1], &local), "");
    }

    #[test]
    fn a_network_file_system_names_its_type_and_what_can_go_wrong() {
        let temp = tempdir();
        let dir = made(temp.path(), "notes");
        let text = said(&dir, &[], &|_: &Path| Some("nfs".to_string()));
        assert!(text.starts_with("marfa: warning: "), "{text}");
        assert!(text.contains("network file system (nfs)"), "{text}");
        assert!(text.contains("not be noticed"), "{text}");
        assert_eq!(said(&dir, &[], &local), "");
    }

    #[test]
    fn a_folder_is_warned_of_once_per_run_however_often_it_is_asked_about() {
        let temp = tempdir();
        let home = temp.path().to_path_buf();
        let first = made(&home, "Library/Mobile Documents/one");
        let second = made(&home, "Library/Mobile Documents/two");
        let (warned, mut out) = (Mutex::new(None), Vec::new());
        let homes = [home.clone()];
        for dir in [&first, &first, &second, &first, &second] {
            warn_with(dir, &homes, &local, &warned, &mut out);
        }
        let text = String::from_utf8(out).unwrap();
        assert_eq!(text.lines().count(), 2, "{text}");
        assert!(text.contains("one") && text.contains("two"), "{text}");
    }

    #[test]
    fn a_directory_that_cannot_be_examined_is_not_warned_of() {
        let temp = tempdir();
        let gone = temp.path().join("Library/Mobile Documents/gone");
        assert_eq!(said(&gone, &[temp.path().to_path_buf()], &local), "");
    }

    #[test]
    fn the_file_system_of_an_ordinary_directory_is_read_and_is_not_a_network_one() {
        let temp = tempdir();
        // The witness: the call reads a file system at all.
        assert!(file_system_of(temp.path()).is_some());
        assert!(file_system_of(&temp.path().join("gone")).is_none());
        assert_eq!(network_file_system(temp.path()), None);
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
