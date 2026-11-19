//! The disk store: one file per blob under `<folder>/<hex 0..4>/<hex>`, and a `tmp`
//! folder that holds bytes until they are whole.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, PoisonError};

use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::hash::Hash;
use crate::failure::Failure;
use crate::server_lock::{self, Untaken};

pub const MARKER: &str = ".marfa-store";
const TMP: &str = "tmp";
const LOCK: &str = ".server-lock";

#[derive(Debug)]
pub struct Disk {
    id: String,
    root: PathBuf,
    /// Keeps a second server from emptying `tmp`, until `let_go` or the process ends.
    lock: Mutex<Option<File>>,
    /// Why the folder is not locked, where its file system would not lock it.
    unlocked: Option<String>,
    returning: Returning,
}

/// A blob folder the start did not find, whose lock is taken before the first write to it.
#[derive(Debug, Default)]
struct Returning {
    awaited: AtomicBool,
    refused: AtomicBool,
    /// Kept apart from `Disk::lock`, which the runtime waits on, since taking a lock does I/O.
    taking: Mutex<()>,
}

/// Which folder a disk store is, for what the server says of it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Place {
    Blobs,
    BackupFiles,
}

impl Place {
    fn named(self, root: &Path) -> String {
        match self {
            Place::Blobs => format!("The blob folder {}", root.display()),
            Place::BackupFiles => {
                format!("The backup folder's files area {}", root.display())
            }
        }
    }
}

fn refused(place: Place, root: &Path, what: &str, error: io::Error) -> Failure {
    Failure::start(format!("{} {what}: {error}", place.named(root)))
}

enum Taken {
    Locked(File),
    /// Only the backup folder, which the server can start without, is left unlocked.
    Unlocked(String),
}

/// The folder's lock, or why its file system takes none; anything else refuses the start.
fn lock_or_why(root: &Path, place: Place) -> Result<Result<File, String>, Failure> {
    let named = place.named(root);
    match server_lock::take(&root.join(LOCK)) {
        Ok(file) => Ok(Ok(file)),
        Err(Untaken::Held) => Err(Failure::start(match place {
            Place::Blobs => format!(
                "{named} is open in another Marfa server. Stop that server, or give this one a \
                 blob folder of its own."
            ),
            Place::BackupFiles => format!(
                "{named} is open in another Marfa server, which runs a copy of this instance. \
                 Stop that server, or give this one a backup folder of its own."
            ),
        })),
        Err(Untaken::Unsupported(error)) => {
            Ok(Err(format!("its file system takes no locks ({error})")))
        }
        // The lock file of a server running as another account is refused here too.
        Err(Untaken::Refused(why)) => Err(Failure::start(format!(
            "{named} could not be locked: its lock file {why}"
        ))),
    }
}

fn unlockable(place: Place, root: &Path, why: &str) -> Failure {
    Failure::start(format!("{} could not be locked: {why}", place.named(root)))
}

fn take_lock(root: &Path, place: Place) -> Result<Taken, Failure> {
    match (lock_or_why(root, place)?, place) {
        (Ok(file), _) => Ok(Taken::Locked(file)),
        (Err(why), Place::Blobs) => Err(unlockable(place, root, &why)),
        (Err(why), Place::BackupFiles) => {
            tracing::warn!(
                folder = %root.display(),
                reason = %why,
                "The backup folder's files area is not locked, so another server could use it too"
            );
            Ok(Taken::Unlocked(why))
        }
    }
}

/// Takes the blob folder's lock, which the server does not start without.
pub fn lock_blobs(root: &Path) -> Result<File, Failure> {
    lock_or_why(root, Place::Blobs)?.map_err(|why| unlockable(Place::Blobs, root, &why))
}

/// What a folder holds before the server takes it as its disk store.
#[derive(Debug, PartialEq, Eq)]
pub enum Found {
    Marked,
    Unmarked,
    Missing,
}

impl Disk {
    /// Looks at the folder without changing it.
    pub fn probe(root: &Path, place: Place) -> Result<Found, Failure> {
        if !root.is_dir() {
            return Ok(Found::Missing);
        }
        match read_marker(root, place)? {
            Some(_) => Ok(Found::Marked),
            None => Ok(Found::Unmarked),
        }
    }

    /// Reads the store's id from its marker, writing one for a folder that has none, and
    /// empties `tmp`, holding the folder's lock first unless `held` is it. It blocks, so it runs
    /// before the server takes requests.
    pub fn open(root: &Path, place: Place, held: Option<File>) -> Result<Disk, Failure> {
        fs::create_dir_all(root)
            .map_err(|error| refused(place, root, "could not be made", error))?;
        let (lock, unlocked) = match held {
            Some(file) => (Some(file), None),
            None => match take_lock(root, place)? {
                Taken::Locked(file) => (Some(file), None),
                Taken::Unlocked(why) => (None, Some(why)),
            },
        };
        let id = match read_marker(root, place)? {
            Some(id) => id,
            None => fresh_marker(root, place)?,
        };
        let disk = Disk {
            id,
            root: root.to_path_buf(),
            lock: Mutex::new(lock),
            unlocked,
            returning: Returning::default(),
        };
        let tmp = disk.tmp();
        match fs::remove_dir_all(&tmp) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(refused(
                    place,
                    root,
                    "has a tmp folder that did not empty",
                    error,
                ));
            }
        }
        fs::create_dir_all(&tmp)
            .map_err(|error| refused(place, root, "has no tmp folder", error))?;
        Ok(disk)
    }

    /// A store the server recorded at `root` whose folder is not there now; nothing is touched.
    pub fn unmounted(id: String, root: PathBuf) -> Disk {
        Disk {
            id,
            root,
            lock: Mutex::default(),
            unlocked: None,
            returning: Returning::default(),
        }
    }

    /// The blob folder's store, at a `root` the start did not find, locked before any write.
    pub fn awaiting_blob_folder(id: String, root: PathBuf) -> Disk {
        let disk = Disk::unmounted(id, root);
        disk.returning.awaited.store(true, Ordering::Release);
        disk
    }

    /// The id the marker in the backup folder's files area `root` holds, where it holds one. It
    /// blocks.
    pub fn marked(root: &Path) -> Result<Option<String>, Failure> {
        read_marker(root, Place::BackupFiles)
    }

    /// Takes the backup folder's files area `root`, which must exist and hold no other store's
    /// marker, as the store `id`, locked as one opened at the start is. It blocks.
    pub fn claim(root: &Path, id: &str) -> io::Result<Disk> {
        let (lock, unlocked) = match take_lock(root, Place::BackupFiles) {
            Ok(Taken::Locked(file)) => (Some(file), None),
            Ok(Taken::Unlocked(why)) => (None, Some(why)),
            Err(failure) => return Err(io::Error::other(failure.message)),
        };
        match read_marker(root, Place::BackupFiles) {
            Ok(None) => {}
            Ok(Some(found)) if found == id => {}
            Ok(Some(found)) => {
                return Err(io::Error::new(
                    io::ErrorKind::AlreadyExists,
                    format!("it holds the marker of another store, {found}"),
                ));
            }
            Err(failure) => return Err(io::Error::other(failure.message)),
        }
        let mut file = File::create(root.join(MARKER))?;
        file.write_all(id.as_bytes())?;
        file.sync_all()?;
        drop(file);
        File::open(root)?.sync_all()?;
        let disk = Disk {
            id: id.to_string(),
            root: root.to_path_buf(),
            lock: Mutex::new(lock),
            unlocked,
            returning: Returning::default(),
        };
        fs::create_dir_all(disk.tmp())?;
        Ok(disk)
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    /// Lets another server open the folder, once this one writes nothing more in it.
    pub fn let_go(&self) {
        self.returning.awaited.store(false, Ordering::Release);
        self.lock
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Why the folder is not locked against another server, where it could not be.
    pub fn unlocked(&self) -> Option<&str> {
        self.unlocked.as_deref()
    }

    fn tmp(&self) -> PathBuf {
        self.root.join(TMP)
    }

    fn path_of(&self, hash: &Hash) -> PathBuf {
        let hex = hash.hex();
        self.root.join(&hex[0..4]).join(hex)
    }

    /// The folder is there and still holds this store's marker. A folder that went away, a
    /// drive that did not mount and an empty mount point all fail this.
    pub fn reachable(&self) -> bool {
        fs::read_to_string(self.root.join(MARKER)).is_ok_and(|text| text.trim() == self.id)
    }

    fn unreachable() -> io::Error {
        io::Error::other("the disk store's folder or marker is missing")
    }

    /// Whether a returned blob folder cannot be locked now; takes the lock if it can. It blocks.
    pub fn returned_unlockable(&self) -> bool {
        self.returning.awaited.load(Ordering::Acquire)
            && self.reachable()
            && self.writable().is_err()
    }

    /// Checks the folder is there and, if it returned after the start, locks it. It blocks.
    fn writable(&self) -> io::Result<()> {
        if !self.reachable() {
            return Err(Disk::unreachable());
        }
        let returning = &self.returning;
        if !returning.awaited.load(Ordering::Acquire) {
            return Ok(());
        }
        let _one_at_a_time = returning
            .taking
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if !returning.awaited.load(Ordering::Acquire) {
            return Ok(());
        }
        let file = match lock_blobs(&self.root) {
            Ok(file) => file,
            Err(failure) => {
                if !returning.refused.swap(true, Ordering::AcqRel) {
                    tracing::warn!(reason = %failure.message, "The blob folder could not be locked");
                }
                return Err(io::Error::other("the blob folder could not be locked"));
            }
        };
        if !self.reachable() {
            return Err(Disk::unreachable());
        }
        let mut lock = self.lock.lock().unwrap_or_else(PoisonError::into_inner);
        // `let_go` may have run since the look above, and the file then closes here.
        if returning.awaited.swap(false, Ordering::AcqRel) {
            *lock = Some(file);
        }
        returning.refused.store(false, Ordering::Release);
        Ok(())
    }

    /// Makes `tmp` where a disk that came back, or a tool that copied it, left it out. Only
    /// the folder marked as this store gets it, and its own folder is never made.
    fn staging(&self) -> io::Result<PathBuf> {
        self.writable()?;
        let tmp = self.tmp();
        match fs::create_dir(&tmp) {
            Ok(()) => File::open(&self.root)?.sync_all()?,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists && tmp.is_dir() => {}
            Err(error) => return Err(error),
        }
        Ok(tmp)
    }

    /// A file of its own for an upload that is arriving.
    pub fn stage(&self) -> io::Result<Staged> {
        let path = self.staging()?.join(Uuid::now_v7().to_string());
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)?;
        Ok(Staged {
            path,
            file: Some(file),
            hasher: Sha256::new(),
            size: 0,
            published: false,
        })
    }

    /// A file of the server's own in `tmp`, which a start empties. It blocks.
    pub fn scratch(&self) -> io::Result<Scratch> {
        let path = self.staging()?.join(Uuid::now_v7().to_string());
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(&path)?;
        Ok(Scratch { path, file })
    }

    /// Moves a sealed file into place over whatever stands there, which may be a damaged
    /// copy's bytes, and syncs it and every folder whose entries changed, the root included.
    pub fn publish(&self, staged: &mut Staged, hash: &Hash) -> io::Result<()> {
        self.writable()?;
        let target = self.path_of(hash);
        let Some(folder) = target.parent() else {
            return Err(io::Error::other("a blob path has no folder"));
        };
        let Some(parent) = folder.parent() else {
            return Err(io::Error::other("a blob path has no folder"));
        };
        fs::create_dir_all(folder)?;
        fs::rename(&staged.path, &target)?;
        staged.published = true;
        File::open(&target)?.sync_all()?;
        for synced in [folder, parent, self.root.as_path()] {
            File::open(synced)?.sync_all()?;
        }
        Ok(())
    }

    pub fn open_blob(&self, hash: &Hash) -> io::Result<File> {
        if !self.reachable() {
            return Err(Disk::unreachable());
        }
        File::open(self.path_of(hash))
    }

    /// The size of the file a blob would be in, or `None` where there is none.
    pub fn size_of(&self, hash: &Hash) -> io::Result<Option<u64>> {
        if !self.reachable() {
            return Err(Disk::unreachable());
        }
        match fs::metadata(self.path_of(hash)) {
            Ok(meta) => Ok(Some(meta.len())),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error),
        }
    }

    /// Reads a blob's file through and answers its size and what it hashes to, with its first
    /// byte changed when `changed` says so.
    pub fn rehash(&self, hash: &Hash, changed: bool) -> io::Result<Option<(u64, Hash)>> {
        self.rehash_opened(hash, changed, |path| File::open(path))
    }

    fn rehash_opened(
        &self,
        hash: &Hash,
        changed: bool,
        open: impl FnOnce(&Path) -> io::Result<File>,
    ) -> io::Result<Option<(u64, Hash)>> {
        if !self.reachable() {
            return Err(Disk::unreachable());
        }
        let mut file = match open(&self.path_of(hash)) {
            Ok(file) => file,
            // A drive that went away after the first look shows every file as missing.
            Err(error) if error.kind() == io::ErrorKind::NotFound && !self.reachable() => {
                return Err(Disk::unreachable());
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        let (mut hasher, mut size, mut buffer) = (Sha256::new(), 0u64, vec![0; 256 * 1024]);
        loop {
            let count = file.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            if changed && size == 0 {
                buffer[0] ^= 0xff;
            }
            hasher.update(&buffer[..count]);
            size += count as u64;
        }
        Ok(Some((size, Hash::from_digest(&hasher.finalize()))))
    }

    /// Removes each file in `tmp` staged before `before`, which only a process that ended left.
    /// It blocks.
    pub fn clear_tmp_before(&self, before: std::time::SystemTime) -> io::Result<usize> {
        self.writable()?;
        let entries = match fs::read_dir(self.tmp()) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(0),
            Err(error) => return Err(error),
        };
        let mut cleared = 0;
        for entry in entries {
            let entry = entry?;
            let staged_at = Uuid::parse_str(&entry.file_name().to_string_lossy())
                .ok()
                .and_then(|id| id.get_timestamp())
                .map(|stamp| {
                    let (seconds, nanos) = stamp.to_unix();
                    std::time::UNIX_EPOCH + std::time::Duration::new(seconds, nanos)
                });
            if staged_at.is_none_or(|at| at < before) {
                match fs::remove_file(entry.path()) {
                    Ok(()) => cleared += 1,
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error),
                }
            }
        }
        if cleared > 0 {
            File::open(self.tmp())?.sync_all()?;
        }
        Ok(cleared)
    }

    /// The name and size of each file in `tmp`. It blocks.
    pub fn spool(&self) -> io::Result<Vec<(String, u64)>> {
        let entries = match fs::read_dir(self.tmp()) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error),
        };
        let mut files = Vec::new();
        for entry in entries {
            let entry = entry?;
            match entry.metadata() {
                Ok(meta) => {
                    files.push((entry.file_name().to_string_lossy().into_owned(), meta.len()))
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
        }
        files.sort();
        Ok(files)
    }

    /// Removes a blob's file. One that is not there is already gone.
    pub fn delete(&self, hash: &Hash) -> io::Result<()> {
        self.writable()?;
        let target = self.path_of(hash);
        match fs::remove_file(&target) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error),
        }
        match target.parent() {
            Some(folder) => File::open(folder)?.sync_all(),
            None => Ok(()),
        }
    }
}

fn read_marker(root: &Path, place: Place) -> Result<Option<String>, Failure> {
    let marker = root.join(MARKER);
    match fs::read_to_string(&marker) {
        Ok(text) if !text.trim().is_empty() => Uuid::parse_str(text.trim())
            .map(|id| Some(id.to_string()))
            .map_err(|_| {
                Failure::start(format!(
                    "The marker {} does not hold a store id.",
                    marker.display()
                ))
            }),
        Ok(_) => Ok(None),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(refused(place, root, "has an unreadable marker", error)),
    }
}

fn fresh_marker(root: &Path, place: Place) -> Result<String, Failure> {
    let id = Uuid::now_v7().to_string();
    let got_none = |error| refused(place, root, "got no marker", error);
    let mut file = File::create(root.join(MARKER)).map_err(got_none)?;
    file.write_all(id.as_bytes())
        .and_then(|()| file.sync_all())
        .map_err(got_none)?;
    Ok(id)
}

/// Goes when this does, unless it was moved into place.
#[derive(Debug)]
pub struct Staged {
    path: PathBuf,
    file: Option<File>,
    hasher: Sha256,
    size: u64,
    published: bool,
}

impl Staged {
    pub fn size(&self) -> u64 {
        self.size
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Writes and hashes `bytes`. It blocks.
    pub fn append(&mut self, bytes: &[u8]) -> io::Result<()> {
        let Some(file) = self.file.as_mut() else {
            return Err(io::Error::other("a staged file was closed"));
        };
        file.write_all(bytes)?;
        self.hasher.update(bytes);
        self.size += bytes.len() as u64;
        Ok(())
    }

    /// Opens the file for reading. It blocks.
    pub fn reopen(&self) -> io::Result<File> {
        File::open(&self.path)
    }

    /// Syncs the file and names it by what it holds. It blocks.
    pub fn seal(&mut self) -> io::Result<Hash> {
        let Some(file) = self.file.take() else {
            return Err(io::Error::other("a staged file was closed"));
        };
        file.sync_all()?;
        Ok(Hash::from_digest(&self.hasher.clone().finalize()))
    }
}

impl Staged {
    /// Blocking: async code runs it on a blocking task.
    pub fn discard(mut self) {
        self.remove();
    }

    fn remove(&mut self) {
        if !self.published {
            self.published = true;
            unspool(&self.path);
        }
    }
}

/// Removes a staged file; one already placed or removed is not there. It blocks.
pub fn unspool(path: &Path) {
    let _ = fs::remove_file(path);
}

impl Drop for Staged {
    /// The way out for an upload that was cancelled while it held the file, wherever it was
    /// dropped: on the runtime the removal goes to a blocking task.
    fn drop(&mut self) {
        if self.published {
            return;
        }
        let path = std::mem::take(&mut self.path);
        match tokio::runtime::Handle::try_current() {
            Ok(runtime) => {
                runtime.spawn_blocking(move || unspool(&path));
            }
            Err(_) => unspool(&path),
        }
    }
}

/// A file in `tmp` the server writes and reads back. It goes when this does.
#[derive(Debug)]
pub struct Scratch {
    path: PathBuf,
    file: File,
}

impl Scratch {
    #[cfg(test)]
    pub fn at(path: PathBuf) -> io::Result<Scratch> {
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(&path)?;
        Ok(Scratch { path, file })
    }

    pub fn file(&mut self) -> &mut File {
        &mut self.file
    }

    pub fn reopen(&self) -> io::Result<File> {
        File::open(&self.path)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let path = std::mem::take(&mut self.path);
        match tokio::runtime::Handle::try_current() {
            Ok(runtime) => {
                runtime.spawn_blocking(move || unspool(&path));
            }
            Err(_) => unspool(&path),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server_lock::without_locks;
    use tempfile::TempDir;

    #[test]
    fn a_fresh_folder_gets_a_marker_that_a_second_start_reads_back() {
        let dir = TempDir::new().unwrap();
        let first = Disk::open(&dir.path().join("blobs"), Place::Blobs, None).unwrap();
        let id = first.id().to_string();
        drop(first);
        let second = Disk::open(&dir.path().join("blobs"), Place::Blobs, None).unwrap();
        assert_eq!(second.id(), id);
        assert!(Uuid::parse_str(&id).is_ok());
    }

    #[test]
    fn a_folder_another_server_has_open_is_refused_and_keeps_its_tmp() {
        let dir = TempDir::new().unwrap();
        let root = dir.path().join("blobs");
        let first = Disk::open(&root, Place::Blobs, None).unwrap();
        let half = root.join(TMP).join("half");
        fs::write(&half, b"half an upload").unwrap();
        let through = dir.path().join("through");
        std::os::unix::fs::symlink(dir.path(), &through).unwrap();
        for named in [root.clone(), through.join("blobs")] {
            let refused = Disk::open(&named, Place::Blobs, None).unwrap_err();
            assert_eq!(refused.status, 1);
            assert!(
                refused.message.contains("is open in another Marfa server"),
                "{}",
                refused.message
            );
            assert_eq!(fs::read(&half).unwrap(), b"half an upload");
        }
        drop(first);
        Disk::open(&root, Place::Blobs, None).unwrap();
        assert!(!half.exists());
    }

    #[test]
    fn a_backup_files_area_another_server_has_open_is_refused_in_its_own_words() {
        let dir = TempDir::new().unwrap();
        let area = dir.path().join("files").join("instance");
        let _first = Disk::open(&area, Place::BackupFiles, None).unwrap();
        let refused = Disk::open(&area, Place::BackupFiles, None).unwrap_err();
        assert!(
            refused
                .message
                .starts_with("The backup folder's files area")
                && refused.message.contains("is open in another Marfa server"),
            "{}",
            refused.message
        );
        fs::create_dir_all(dir.path().join("adopted")).unwrap();
        let id = Uuid::now_v7().to_string();
        let _adopted = Disk::claim(&dir.path().join("adopted"), &id).unwrap();
        let again = Disk::claim(&dir.path().join("adopted"), &id).unwrap_err();
        assert!(
            again
                .to_string()
                .contains("is open in another Marfa server"),
            "{again}"
        );
    }

    /// A folder holding an upload in progress in `tmp`.
    fn half_written(root: &Path) -> PathBuf {
        let half = root.join(TMP).join("half");
        fs::create_dir_all(root.join(TMP)).unwrap();
        fs::write(&half, b"left").unwrap();
        half
    }

    #[test]
    fn a_backup_files_area_on_a_file_system_without_locks_opens_unlocked_and_says_why() {
        let dir = TempDir::new().unwrap();
        let area = dir.path().join("area");
        let half = half_written(&area);
        let disk = without_locks(|| Disk::open(&area, Place::BackupFiles, None)).unwrap();
        assert!(
            disk.unlocked()
                .is_some_and(|why| why.contains("takes no locks")),
            "{:?}",
            disk.unlocked()
        );
        assert!(!half.exists());

        let adopted = dir.path().join("adopted");
        fs::create_dir_all(&adopted).unwrap();
        let id = Uuid::now_v7().to_string();
        let claimed = without_locks(|| Disk::claim(&adopted, &id)).unwrap();
        assert!(claimed.unlocked().is_some());

        let blobs = dir.path().join("blobs");
        let half = half_written(&blobs);
        let refused = without_locks(|| Disk::open(&blobs, Place::Blobs, None)).unwrap_err();
        assert!(
            refused.message.contains("could not be locked"),
            "{}",
            refused.message
        );
        assert!(half.exists());
        let refused = without_locks(|| lock_blobs(&blobs)).unwrap_err();
        assert!(
            refused.message.contains("takes no locks"),
            "{}",
            refused.message
        );
    }

    #[test]
    fn a_backup_files_area_whose_lock_file_is_refused_refuses_the_start_and_keeps_its_tmp() {
        let dir = TempDir::new().unwrap();
        let area = dir.path().join("area");
        // The witness: the area opens, locked, while its lock file is one the server can take.
        drop(Disk::open(&area, Place::BackupFiles, None).unwrap());
        let half = half_written(&area);
        // What the lock file of a server running as another account fails too.
        fs::remove_file(area.join(LOCK)).unwrap();
        fs::create_dir(area.join(LOCK)).unwrap();
        let refused = Disk::open(&area, Place::BackupFiles, None).unwrap_err();
        assert!(
            refused
                .message
                .starts_with("The backup folder's files area")
                && refused.message.contains("its lock file"),
            "{}",
            refused.message
        );
        assert!(half.exists());
        let id = Uuid::now_v7().to_string();
        let refused = Disk::claim(&area, &id).unwrap_err();
        assert!(refused.to_string().contains("its lock file"), "{refused}");
        assert!(half.exists());
    }

    #[test]
    fn a_start_empties_tmp_and_keeps_the_blobs() {
        let dir = TempDir::new().unwrap();
        let root = dir.path().join("blobs");
        let disk = Disk::open(&root, Place::Blobs, None).unwrap();
        let mut staged = disk.stage().unwrap();
        staged.append(b"kept").unwrap();
        let hash = staged.seal().unwrap();
        disk.publish(&mut staged, &hash).unwrap();
        fs::write(root.join(TMP).join("half"), b"half an upload").unwrap();
        let kept = disk.path_of(&hash);
        drop(disk);
        Disk::open(&root, Place::Blobs, None).unwrap();
        assert!(fs::read_dir(root.join(TMP)).unwrap().next().is_none());
        assert_eq!(fs::read(&kept).unwrap(), b"kept");
        let hex = hash.hex();
        assert!(root.join(&hex[0..4]).join(hex).is_file());
    }

    #[test]
    fn staging_makes_a_missing_tmp_inside_the_marked_folder_and_never_the_folder() {
        let dir = TempDir::new().unwrap();
        let root = dir.path().join("blobs");
        let disk = Disk::open(&root, Place::Blobs, None).unwrap();
        fs::remove_dir(disk.tmp()).unwrap();
        let staged = disk.stage().unwrap();
        assert!(staged.path().is_file());
        fs::remove_dir_all(disk.tmp()).unwrap();
        assert!(disk.scratch().is_ok());
        fs::remove_dir_all(&root).unwrap();
        assert!(disk.stage().is_err());
        assert!(disk.scratch().is_err());
        assert!(!root.exists());
        fs::create_dir(&root).unwrap();
        assert!(disk.stage().is_err());
        assert!(!root.join(TMP).exists());
    }

    #[test]
    fn a_marker_that_is_not_an_id_stops_the_start() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join(MARKER), b"not an id").unwrap();
        assert!(Disk::open(dir.path(), Place::Blobs, None).is_err());
    }

    #[test]
    fn a_staged_file_goes_with_its_upload_unless_it_was_placed() {
        let dir = TempDir::new().unwrap();
        let disk = Disk::open(dir.path(), Place::Blobs, None).unwrap();
        let mut dropped = disk.stage().unwrap();
        dropped.append(b"half").unwrap();
        drop(dropped);
        assert!(fs::read_dir(disk.tmp()).unwrap().next().is_none());
    }

    #[tokio::test]
    async fn a_staged_file_dropped_on_the_runtime_is_removed_off_it() {
        let dir = TempDir::new().unwrap();
        let disk = Disk::open(dir.path(), Place::Blobs, None).unwrap();
        let mut dropped = disk.stage().unwrap();
        dropped.append(b"half").unwrap();
        drop(dropped);
        for _ in 0..100 {
            if fs::read_dir(disk.tmp()).unwrap().next().is_none() {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        panic!("the staged file was not removed");
    }

    #[test]
    fn a_probe_changes_nothing_and_a_folder_without_its_marker_is_unreachable() {
        let dir = TempDir::new().unwrap();
        let root = dir.path().join("blobs");
        assert_eq!(Disk::probe(&root, Place::Blobs).unwrap(), Found::Missing);
        assert!(!root.exists());
        fs::create_dir(&root).unwrap();
        assert_eq!(Disk::probe(&root, Place::Blobs).unwrap(), Found::Unmarked);
        let disk = Disk::open(&root, Place::Blobs, None).unwrap();
        assert_eq!(Disk::probe(&root, Place::Blobs).unwrap(), Found::Marked);
        assert!(disk.reachable());
        fs::remove_file(root.join(MARKER)).unwrap();
        assert!(!disk.reachable());
        let hash = Hash::from_digest(&Sha256::digest(b"x"));
        assert!(disk.size_of(&hash).is_err());
        assert!(disk.delete(&hash).is_err());
    }

    /// The id of a marked blob folder no running store holds.
    fn left_marked(root: &Path) -> String {
        Disk::open(root, Place::Blobs, None)
            .unwrap()
            .id()
            .to_string()
    }

    fn open_refused(root: &Path) -> bool {
        Disk::open(root, Place::Blobs, None)
            .is_err_and(|refused| refused.message.contains("is open in another Marfa server"))
    }

    #[test]
    fn a_returned_blob_folder_is_locked_by_the_first_write_and_not_by_a_read() {
        let dir = TempDir::new().unwrap();
        let root = dir.path().join("blobs");
        let id = left_marked(&root);
        let disk = Disk::awaiting_blob_folder(id, root.clone());
        assert!(disk.reachable());
        assert!(
            disk.size_of(&Hash::from_digest(&Sha256::digest(b"x")))
                .is_ok()
        );
        assert!(!open_refused(&root), "the witness: a read took no lock");
        let staged = disk.stage().unwrap();
        assert!(open_refused(&root));
        assert!(staged.path().is_file());
    }

    #[test]
    fn a_returned_blob_folder_another_server_holds_is_read_and_not_written_until_it_ends() {
        let dir = TempDir::new().unwrap();
        let root = dir.path().join("blobs");
        let id = left_marked(&root);
        let disk = Disk::awaiting_blob_folder(id, root.clone());
        let other = Disk::open(&root, Place::Blobs, None).unwrap();
        let hash = Hash::from_digest(&Sha256::digest(b"x"));
        assert!(disk.reachable());
        assert!(disk.size_of(&hash).is_ok());
        assert!(disk.returned_unlockable());
        assert!(disk.stage().is_err());
        assert!(disk.scratch().is_err());
        assert!(disk.delete(&hash).is_err());
        assert!(disk.clear_tmp_before(std::time::SystemTime::now()).is_err());
        drop(other);
        assert!(!disk.returned_unlockable());
        assert!(open_refused(&root), "the look took the lock");
        assert!(disk.stage().is_ok());
    }

    #[test]
    fn only_a_folder_with_the_marker_gets_a_lock_file_when_it_is_awaited() {
        let dir = TempDir::new().unwrap();
        let root = dir.path().join("blobs");
        fs::create_dir(&root).unwrap();
        let id = Uuid::now_v7().to_string();
        let disk = Disk::awaiting_blob_folder(id.clone(), root.clone());
        assert!(disk.stage().is_err());
        assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
        // The witness: the same write makes the lock file once the marker is there.
        fs::write(root.join(MARKER), &id).unwrap();
        assert!(disk.stage().is_ok());
        assert!(root.join(LOCK).is_file());
    }

    #[test]
    fn a_store_let_go_takes_no_lock_when_its_folder_returns() {
        let dir = TempDir::new().unwrap();
        let root = dir.path().join("blobs");
        let id = left_marked(&root);
        let disk = Disk::awaiting_blob_folder(id, root.clone());
        disk.let_go();
        assert!(disk.stage().is_ok());
        assert!(!open_refused(&root));
    }

    #[test]
    fn a_returned_blob_folder_on_a_file_system_without_locks_is_not_written() {
        let dir = TempDir::new().unwrap();
        let root = dir.path().join("blobs");
        let id = left_marked(&root);
        let disk = Disk::awaiting_blob_folder(id, root);
        assert!(without_locks(|| disk.stage()).is_err());
        assert!(without_locks(|| disk.returned_unlockable()));
    }

    #[test]
    fn a_rehash_finds_an_altered_file_and_a_missing_one() {
        let dir = TempDir::new().unwrap();
        let disk = Disk::open(dir.path(), Place::Blobs, None).unwrap();
        let mut staged = disk.stage().unwrap();
        staged.append(b"kept bytes").unwrap();
        let hash = staged.seal().unwrap();
        disk.publish(&mut staged, &hash).unwrap();
        assert_eq!(disk.rehash(&hash, false).unwrap(), Some((10, hash.clone())));
        let changed = Hash::from_digest(&Sha256::digest(b"\x94ept bytes"));
        assert_eq!(disk.rehash(&hash, true).unwrap(), Some((10, changed)));
        fs::write(disk.path_of(&hash), b"kept bytez").unwrap();
        assert_ne!(disk.rehash(&hash, false).unwrap().unwrap().1, hash);
        disk.delete(&hash).unwrap();
        disk.delete(&hash).unwrap();
        assert_eq!(disk.rehash(&hash, false).unwrap(), None);
    }

    #[test]
    fn a_file_missing_because_the_folder_went_away_is_unreachable_not_missing() {
        let dir = TempDir::new().unwrap();
        let disk = Disk::open(dir.path(), Place::Blobs, None).unwrap();
        let hash = Hash::from_digest(&Sha256::digest(b"never kept"));
        assert_eq!(disk.rehash(&hash, false).unwrap(), None);
        let unmounted = disk.rehash_opened(&hash, false, |path| {
            fs::remove_file(dir.path().join(MARKER))?;
            File::open(path)
        });
        assert!(unmounted.is_err(), "{unmounted:?}");
    }

    #[test]
    fn only_files_staged_before_the_cut_are_cleared_from_tmp() {
        let dir = TempDir::new().unwrap();
        let disk = Disk::open(dir.path(), Place::Blobs, None).unwrap();
        fs::write(disk.tmp().join("not an id"), b"stray").unwrap();
        let early = disk.stage().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        let cut = std::time::SystemTime::now();
        std::thread::sleep(std::time::Duration::from_millis(5));
        let late = disk.stage().unwrap();
        assert_eq!(disk.clear_tmp_before(cut).unwrap(), 2);
        assert!(!early.path().exists());
        assert!(late.path().exists());
        fs::remove_file(dir.path().join(MARKER)).unwrap();
        assert!(disk.clear_tmp_before(cut).is_err());
    }

    #[test]
    fn a_second_publish_of_the_same_bytes_discards_its_staged_file() {
        let dir = TempDir::new().unwrap();
        let disk = Disk::open(dir.path(), Place::Blobs, None).unwrap();
        let mut hashes = Vec::new();
        for _ in 0..2 {
            let mut staged = disk.stage().unwrap();
            staged.append(b"same bytes").unwrap();
            let hash = staged.seal().unwrap();
            disk.publish(&mut staged, &hash).unwrap();
            hashes.push(hash);
        }
        assert_eq!(hashes[0], hashes[1]);
        assert!(fs::read_dir(disk.tmp()).unwrap().next().is_none());
        assert_eq!(fs::read(disk.path_of(&hashes[0])).unwrap(), b"same bytes");
    }
}
