//! The disk store: one file per blob under `<folder>/<hex 0..4>/<hex>`, and a `tmp`
//! folder that holds bytes until they are whole.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::hash::Hash;
use crate::failure::Failure;

pub const MARKER: &str = ".marfa-store";
const TMP: &str = "tmp";

#[derive(Debug)]
pub struct Disk {
    id: String,
    root: PathBuf,
}

fn refused(root: &Path, what: &str, error: io::Error) -> Failure {
    Failure::start(format!(
        "The blob folder {} {what}: {error}",
        root.display()
    ))
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
    pub fn probe(root: &Path) -> Result<Found, Failure> {
        if !root.is_dir() {
            return Ok(Found::Missing);
        }
        match read_marker(root)? {
            Some(_) => Ok(Found::Marked),
            None => Ok(Found::Unmarked),
        }
    }

    /// Reads the store's id from its marker, writing one for a folder that has none, and
    /// empties `tmp`. It blocks, so it runs before the server takes requests.
    pub fn open(root: &Path) -> Result<Disk, Failure> {
        fs::create_dir_all(root).map_err(|error| refused(root, "could not be made", error))?;
        let id = match read_marker(root)? {
            Some(id) => id,
            None => fresh_marker(root, &root.join(MARKER))?,
        };
        let disk = Disk {
            id,
            root: root.to_path_buf(),
        };
        let tmp = disk.tmp();
        match fs::remove_dir_all(&tmp) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(refused(root, "has a tmp folder that did not empty", error)),
        }
        fs::create_dir_all(&tmp).map_err(|error| refused(root, "has no tmp folder", error))?;
        Ok(disk)
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn root(&self) -> &Path {
        &self.root
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

    /// A file of its own for an upload that is arriving.
    pub fn stage(&self) -> io::Result<Staged> {
        let path = self.tmp().join(Uuid::now_v7().to_string());
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
        let path = self.tmp().join(Uuid::now_v7().to_string());
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
        if !self.reachable() {
            return Err(Disk::unreachable());
        }
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
        if !self.reachable() {
            return Err(Disk::unreachable());
        }
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

fn read_marker(root: &Path) -> Result<Option<String>, Failure> {
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
        Err(error) => Err(refused(root, "has an unreadable marker", error)),
    }
}

fn fresh_marker(root: &Path, marker: &Path) -> Result<String, Failure> {
    let id = Uuid::now_v7().to_string();
    let mut file = File::create(marker).map_err(|error| refused(root, "got no marker", error))?;
    file.write_all(id.as_bytes())
        .and_then(|()| file.sync_all())
        .map_err(|error| refused(root, "got no marker", error))?;
    Ok(id)
}

/// A file in `tmp` taking an upload's bytes. It goes when this does, unless it was moved
/// into place.
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
    /// Removes the file unless it was placed. It blocks, so a caller on the async runtime
    /// runs it on a blocking task.
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
    use tempfile::TempDir;

    #[test]
    fn a_fresh_folder_gets_a_marker_that_a_second_start_reads_back() {
        let dir = TempDir::new().unwrap();
        let first = Disk::open(&dir.path().join("blobs")).unwrap();
        let second = Disk::open(&dir.path().join("blobs")).unwrap();
        assert_eq!(first.id(), second.id());
        assert!(Uuid::parse_str(first.id()).is_ok());
    }

    #[test]
    fn a_start_empties_tmp_and_keeps_the_blobs() {
        let dir = TempDir::new().unwrap();
        let root = dir.path().join("blobs");
        let disk = Disk::open(&root).unwrap();
        let mut staged = disk.stage().unwrap();
        staged.append(b"kept").unwrap();
        let hash = staged.seal().unwrap();
        disk.publish(&mut staged, &hash).unwrap();
        fs::write(root.join(TMP).join("half"), b"half an upload").unwrap();
        Disk::open(&root).unwrap();
        assert!(fs::read_dir(root.join(TMP)).unwrap().next().is_none());
        assert_eq!(fs::read(disk.path_of(&hash)).unwrap(), b"kept");
        let hex = hash.hex();
        assert!(root.join(&hex[0..4]).join(hex).is_file());
    }

    #[test]
    fn a_marker_that_is_not_an_id_stops_the_start() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join(MARKER), b"not an id").unwrap();
        assert!(Disk::open(dir.path()).is_err());
    }

    #[test]
    fn a_staged_file_goes_with_its_upload_unless_it_was_placed() {
        let dir = TempDir::new().unwrap();
        let disk = Disk::open(dir.path()).unwrap();
        let mut dropped = disk.stage().unwrap();
        dropped.append(b"half").unwrap();
        drop(dropped);
        assert!(fs::read_dir(disk.tmp()).unwrap().next().is_none());
    }

    #[tokio::test]
    async fn a_staged_file_dropped_on_the_runtime_is_removed_off_it() {
        let dir = TempDir::new().unwrap();
        let disk = Disk::open(dir.path()).unwrap();
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
        assert_eq!(Disk::probe(&root).unwrap(), Found::Missing);
        assert!(!root.exists());
        fs::create_dir(&root).unwrap();
        assert_eq!(Disk::probe(&root).unwrap(), Found::Unmarked);
        let disk = Disk::open(&root).unwrap();
        assert_eq!(Disk::probe(&root).unwrap(), Found::Marked);
        assert!(disk.reachable());
        fs::remove_file(root.join(MARKER)).unwrap();
        assert!(!disk.reachable());
        let hash = Hash::from_digest(&Sha256::digest(b"x"));
        assert!(disk.size_of(&hash).is_err());
        assert!(disk.delete(&hash).is_err());
    }

    #[test]
    fn a_rehash_finds_an_altered_file_and_a_missing_one() {
        let dir = TempDir::new().unwrap();
        let disk = Disk::open(dir.path()).unwrap();
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
        let disk = Disk::open(dir.path()).unwrap();
        let hash = Hash::from_digest(&Sha256::digest(b"never kept"));
        assert_eq!(disk.rehash(&hash, false).unwrap(), None);
        let unmounted = disk.rehash_opened(&hash, false, |path| {
            fs::remove_file(dir.path().join(MARKER))?;
            File::open(path)
        });
        assert!(unmounted.is_err(), "{unmounted:?}");
    }

    #[test]
    fn a_second_publish_of_the_same_bytes_discards_its_staged_file() {
        let dir = TempDir::new().unwrap();
        let disk = Disk::open(dir.path()).unwrap();
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
