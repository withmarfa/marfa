//! A folder one running server alone writes in. The folder's own descriptor is locked first,
//! before anything in it is made or changed, and every write goes through that descriptor, so
//! a folder renamed or replaced at its path takes no write meant for the one that was locked.
//! The lock file inside keeps out an older server, and is the only lock another machine sees on
//! a network share.

use std::fs::{File, OpenOptions, TryLockError};
use std::io;
use std::os::unix::fs::OpenOptionsExt as _;
use std::path::Path;
use std::sync::{Mutex, PoisonError};

use rustix::fs::AtFlags;

use crate::server_lock::{self, Untaken};

pub const LOCK: &str = ".server-lock";

/// Opens the folder at `path` as the descriptor its lock and writes go through. A FIFO planted
/// there would block the open.
pub fn open_dir(path: &Path) -> io::Result<File> {
    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NONBLOCK)
        .open(path)
}

/// Why a folder's locks may not reach every server that could open it, where they may not.
pub fn shared(dir: &File) -> Option<String> {
    let found = rustix::fs::fstatfs(dir).ok()?;
    shared_by(&found)
}

#[cfg(target_os = "macos")]
fn shared_by(found: &rustix::fs::StatFs) -> Option<String> {
    #[cfg(test)]
    if let Some(named) = SHARED.with_borrow(Clone::clone) {
        return Some(named);
    }
    if found.f_flags & libc::MNT_LOCAL as u32 != 0 {
        return None;
    }
    let name: Vec<u8> = found
        .f_fstypename
        .iter()
        .take_while(|byte| **byte != 0)
        .map(|byte| *byte as u8)
        .collect();
    Some(String::from_utf8_lossy(&name).into_owned())
}

#[cfg(not(target_os = "macos"))]
fn shared_by(found: &rustix::fs::StatFs) -> Option<String> {
    #[cfg(test)]
    if let Some(named) = SHARED.with_borrow(Clone::clone) {
        return Some(named);
    }
    // f_type is i32, u32 or i64 by target; every magic number fits in 32 bits.
    #[allow(clippy::unnecessary_cast, reason = "f_type is u32 on some targets")]
    let kind = found.f_type as u32;
    if local_on_linux(kind) {
        return None;
    }
    Some(linux_named(kind))
}

/// The name of a Linux file system of the type `kind`, as the server reports it.
#[cfg(any(test, not(target_os = "macos")))]
fn linux_named(kind: u32) -> String {
    match kind {
        0x6969 => "nfs".into(),
        0xFE53_4D42 => "smb2".into(),
        0xFF53_4D42 => "cifs".into(),
        0x6573_5546 => "fuse".into(),
        _ => format!("type {kind:#x}"),
    }
}

/// Whether a Linux file system of the type `kind` is local to the kernel that mounts it.
#[cfg(any(test, not(target_os = "macos")))]
fn local_on_linux(kind: u32) -> bool {
    // ext2, ext3 and ext4; XFS; Btrfs; tmpfs; ZFS; overlayfs, a container's own; F2FS; bcachefs.
    const LOCAL: [u32; 8] = [
        0xEF53,
        0x5846_5342,
        0x9123_683E,
        0x0102_1994,
        0x2FC1_2FC1,
        0x794C_7630,
        0xF2F5_2010,
        0xCA45_1A4E,
    ];
    LOCAL.contains(&kind)
}

#[cfg(test)]
thread_local! {
    static SHARED: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) };
}

/// Runs `run` as if every folder were on a network file system, on this thread.
#[cfg(test)]
pub fn on_a_network_share<T>(run: impl FnOnce() -> T) -> T {
    SHARED.set(Some("nfs".into()));
    let ran = run();
    SHARED.set(None);
    ran
}

/// A folder whose own descriptor is locked, before its lock file is taken.
#[derive(Debug)]
pub struct DirLocked {
    dir: File,
    shared: Option<String>,
    /// Whether the folder's descriptor holds the lock; on a network share it may take none.
    locked: bool,
}

/// Locks the folder `dir`. Nothing in it is read or changed; a refusal hands `dir` back.
pub fn lock_dir(dir: File) -> Result<DirLocked, (Untaken, File)> {
    let shared = shared(&dir);
    let untaken = match server_lock::try_lock(&dir) {
        Ok(()) => {
            return Ok(DirLocked {
                dir,
                shared,
                locked: true,
            });
        }
        Err(TryLockError::WouldBlock) => Untaken::Held,
        Err(TryLockError::Error(error)) if server_lock::unsupported(&error) => {
            Untaken::Unsupported(error)
        }
        // The lock file alone keeps other servers out of a share.
        Err(TryLockError::Error(_)) if shared.is_some() => {
            return Ok(DirLocked {
                dir,
                shared,
                locked: false,
            });
        }
        Err(TryLockError::Error(error)) => {
            Untaken::Refused(format!("could not be locked: {error}"))
        }
    };
    Err((untaken, dir))
}

impl DirLocked {
    pub fn dir(&self) -> &File {
        &self.dir
    }

    /// Takes the lock file inside the locked folder.
    pub fn with_file(self) -> Result<Held, Untaken> {
        let file = server_lock::take_in(&self.dir, LOCK, server_lock::me()).map_err(|untaken| {
            match untaken {
                Untaken::Refused(why) => Untaken::Refused(format!("its lock file {why}")),
                other => other,
            }
        })?;
        Ok(Held {
            dir: self.dir,
            lock: Some(Locked {
                file: Mutex::new(file),
                shared: self.shared,
                locked: self.locked,
            }),
            unlocked: None,
            note: Mutex::new(None),
        })
    }
}

/// A folder a server writes in, through the descriptor it opened, holding its locks unless the
/// file system takes none.
#[derive(Debug)]
pub struct Held {
    dir: File,
    lock: Option<Locked>,
    /// Why the folder is not locked, where its file system would not lock it.
    unlocked: Option<String>,
    /// What the server mended in the folder's locking since it took it.
    note: Mutex<Option<String>>,
}

#[derive(Debug)]
struct Locked {
    file: Mutex<File>,
    shared: Option<String>,
    locked: bool,
}

/// Whether a held folder is still the one at its path, holding its lock file.
#[derive(Debug, PartialEq, Eq)]
pub enum Standing {
    Kept,
    /// The path names another folder, or none; `gone` where the held one was removed or its
    /// disk went away, so that a folder returned to the path may be taken again.
    Moved {
        gone: bool,
    },
    /// The lock file was removed or replaced where the server cannot make it again alone.
    Lost(String),
}

fn same(found: &rustix::fs::Stat, other: &rustix::fs::Stat) -> bool {
    (found.st_dev, found.st_ino) == (other.st_dev, other.st_ino)
}

/// Whether the folder `dir` was removed, or its disk went away. Linux shows a removed folder
/// with no links; macOS keeps its link count while it is open, and only refuses a new entry in
/// it. The entry tried is `tmp`, which a disk store keeps in its folder anyway.
fn removed(dir: &File, own: &rustix::fs::Stat) -> bool {
    if own.st_nlink == 0 {
        return true;
    }
    use rustix::io::Errno;
    matches!(
        rustix::fs::mkdirat(dir, "tmp", rustix::fs::Mode::from_raw_mode(0o777)),
        Err(Errno::NOENT | Errno::IO | Errno::NXIO | Errno::NODEV | Errno::STALE)
    )
}

impl Held {
    /// A folder on a file system that takes no locks, written through `dir` all the same.
    pub fn unlocked(dir: File, why: String) -> Held {
        Held {
            dir,
            lock: None,
            unlocked: Some(why),
            note: Mutex::new(None),
        }
    }

    pub fn dir(&self) -> &File {
        &self.dir
    }

    pub fn unlocked_why(&self) -> Option<&str> {
        self.unlocked.as_deref()
    }

    /// Why the folder's locks may not keep out a server on another machine.
    pub fn shared(&self) -> Option<&str> {
        self.lock.as_ref().and_then(|lock| lock.shared.as_deref())
    }

    pub fn note(&self) -> Option<String> {
        self.note
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// Whether the folder at `path` is this one, and holds the lock file this server holds.
    /// Only looks: opening the lock file again would drop its lock where locks are emulated by
    /// record locks. A lock file removed or replaced on a local file system is made again
    /// under the folder's lock. It blocks.
    pub fn check(&self, path: &Path) -> Standing {
        let Ok(own) = rustix::fs::fstat(&self.dir) else {
            return Standing::Moved { gone: true };
        };
        match rustix::fs::stat(path) {
            Ok(named) if same(&named, &own) => {}
            _ => {
                return Standing::Moved {
                    gone: removed(&self.dir, &own),
                };
            }
        }
        let Some(lock) = &self.lock else {
            return Standing::Kept;
        };
        let mut file = lock.file.lock().unwrap_or_else(PoisonError::into_inner);
        let held = rustix::fs::fstat(&*file);
        let named = rustix::fs::statat(&self.dir, LOCK, AtFlags::SYMLINK_NOFOLLOW);
        if let (Ok(held), Ok(named)) = (&held, &named)
            && same(held, named)
        {
            return Standing::Kept;
        }
        if let Some(share) = &lock.shared {
            return Standing::Lost(format!(
                "its lock file was removed or replaced, and it is on a file system ({share}) \
                 whose locks may not reach every server that could open it"
            ));
        }
        if !lock.locked {
            return Standing::Lost("its lock file was removed or replaced".into());
        }
        let mended = match server_lock::take_in(&self.dir, LOCK, server_lock::me()) {
            Ok(taken) => {
                *file = taken;
                "its lock file was removed or replaced, and the server made it again".to_string()
            }
            Err(Untaken::Held) => {
                return Standing::Lost(
                    "another Marfa server holds the lock file that replaced its own".into(),
                );
            }
            Err(Untaken::Unsupported(error)) => {
                format!("its lock file was replaced by one that could not be locked: {error}")
            }
            Err(Untaken::Refused(why)) => format!("its lock file was replaced, and {why}"),
        };
        let mut note = self.note.lock().unwrap_or_else(PoisonError::into_inner);
        if note.as_deref() != Some(mended.as_str()) {
            tracing::warn!(folder = %path.display(), reason = %mended, "A folder's lock file changed under the server");
            *note = Some(mended);
        }
        Standing::Kept
    }

    /// Whether `dir` is the same folder as this one.
    pub fn is(&self, dir: &File) -> bool {
        match (rustix::fs::fstat(&self.dir), rustix::fs::fstat(dir)) {
            (Ok(own), Ok(other)) => (own.st_dev, own.st_ino) == (other.st_dev, other.st_ino),
            _ => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server_lock::without_locks_answering;

    #[test]
    fn a_folder_another_holder_locked_is_held_even_within_one_process() {
        let dir = tempfile::tempdir().unwrap();
        let first = lock_dir(open_dir(dir.path()).unwrap()).unwrap();
        assert!(matches!(
            lock_dir(open_dir(dir.path()).unwrap()),
            Err((Untaken::Held, _))
        ));
        // A descriptor of the same open folder shares its lock, and closing it keeps the lock.
        drop(first.dir().try_clone().unwrap());
        assert!(matches!(
            lock_dir(open_dir(dir.path()).unwrap()),
            Err((Untaken::Held, _))
        ));
        drop(first);
        lock_dir(open_dir(dir.path()).unwrap()).unwrap();
    }

    #[test]
    fn a_folder_whose_lock_answers_that_locks_are_not_supported_is_never_taken() {
        let dir = tempfile::tempdir().unwrap();
        for code in [libc::ENOTSUP, libc::EOPNOTSUPP, libc::ENOLCK] {
            let answer = without_locks_answering(code, || lock_dir(open_dir(dir.path()).unwrap()));
            assert!(
                matches!(answer, Err((Untaken::Unsupported(_), _))),
                "{code}"
            );
        }
    }

    #[test]
    fn a_lock_file_removed_on_a_local_file_system_is_made_again_and_lost_on_a_share() {
        let dir = tempfile::tempdir().unwrap();
        let held = lock_dir(open_dir(dir.path()).unwrap())
            .unwrap()
            .with_file()
            .unwrap();
        assert_eq!(held.check(dir.path()), Standing::Kept);
        std::fs::remove_file(dir.path().join(LOCK)).unwrap();
        assert_eq!(held.check(dir.path()), Standing::Kept);
        assert!(dir.path().join(LOCK).is_file());
        assert!(
            held.note()
                .is_some_and(|note| note.contains("made it again"))
        );

        let other = tempfile::tempdir().unwrap();
        let shared = on_a_network_share(|| {
            lock_dir(open_dir(other.path()).unwrap())
                .unwrap()
                .with_file()
                .unwrap()
        });
        assert!(shared.shared().is_some());
        assert_eq!(shared.check(other.path()), Standing::Kept);
        std::fs::remove_file(other.path().join(LOCK)).unwrap();
        assert!(matches!(shared.check(other.path()), Standing::Lost(_)));
        assert!(!other.path().join(LOCK).exists());
    }

    #[test]
    fn a_container_overlay_and_other_local_linux_file_systems_are_local_and_shares_are_not() {
        for local in [0xEF53, 0x5846_5342, 0x794C_7630, 0xF2F5_2010, 0xCA45_1A4E] {
            assert!(local_on_linux(local), "{local:#x}");
        }
        // NFS, SMB2, CIFS, and FUSE, which Docker Desktop's and virtiofs shares use.
        for shared in [0x6969, 0xFE53_4D42, 0xFF53_4D42, 0x6573_5546] {
            assert!(!local_on_linux(shared), "{shared:#x}");
        }
    }

    #[test]
    fn a_linux_network_file_system_is_named_and_an_unknown_one_keeps_its_number() {
        for (kind, name) in [
            (0x6969, "nfs"),
            (0xFE53_4D42, "smb2"),
            (0xFF53_4D42, "cifs"),
            (0x6573_5546, "fuse"),
        ] {
            assert_eq!(linux_named(kind), name, "{kind:#x}");
        }
        assert_eq!(linux_named(0x1234_5678), "type 0x12345678");
    }

    #[test]
    fn a_folder_renamed_is_moved_and_one_removed_is_gone() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("area");
        std::fs::create_dir(&path).unwrap();
        let held = lock_dir(open_dir(&path).unwrap())
            .unwrap()
            .with_file()
            .unwrap();
        std::fs::rename(&path, dir.path().join("moved")).unwrap();
        assert_eq!(held.check(&path), Standing::Moved { gone: false });
        std::fs::create_dir(&path).unwrap();
        assert_eq!(held.check(&path), Standing::Moved { gone: false });
        std::fs::remove_dir_all(dir.path().join("moved")).unwrap();
        assert_eq!(held.check(&path), Standing::Moved { gone: true });
    }
}
