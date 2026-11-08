//! The disk store: one file per blob under `<folder>/<hex 0..2>/<hex 2..4>/<hex>`,
//! and a `tmp` folder that holds an upload until it is whole.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
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

impl Disk {
    /// Reads the store's id from its marker, writing one for a folder that has none, and
    /// empties `tmp`. It blocks, so it runs before the server takes requests.
    pub fn open(root: &Path) -> Result<Disk, Failure> {
        fs::create_dir_all(root).map_err(|error| refused(root, "could not be made", error))?;
        let marker = root.join(MARKER);
        let id = match fs::read_to_string(&marker) {
            Ok(text) if !text.trim().is_empty() => Uuid::parse_str(text.trim())
                .map(|id| id.to_string())
                .map_err(|_| {
                    Failure::start(format!(
                        "The marker {} does not hold a store id.",
                        marker.display()
                    ))
                })?,
            Ok(_) => fresh_marker(root, &marker)?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => fresh_marker(root, &marker)?,
            Err(error) => return Err(refused(root, "has an unreadable marker", error)),
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
        self.root.join(&hex[0..2]).join(&hex[2..4]).join(hex)
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

    /// Moves a sealed file into place and syncs the folders. A final file that already
    /// stands is the same bytes, and the staged one is discarded.
    pub fn publish(&self, staged: &mut Staged, hash: &Hash) -> io::Result<()> {
        let target = self.path_of(hash);
        let Some(folder) = target.parent() else {
            return Err(io::Error::other("a blob path has no folder"));
        };
        fs::create_dir_all(folder)?;
        if !target.exists() {
            fs::rename(&staged.path, &target)?;
            staged.published = true;
            File::open(folder)?.sync_all()?;
            if let Some(parent) = folder.parent() {
                File::open(parent)?.sync_all()?;
            }
        }
        Ok(())
    }

    pub fn open_blob(&self, hash: &Hash) -> io::Result<File> {
        File::open(self.path_of(hash))
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

    /// Syncs the file and names it by what it holds. It blocks.
    pub fn seal(&mut self) -> io::Result<Hash> {
        let Some(file) = self.file.take() else {
            return Err(io::Error::other("a staged file was closed"));
        };
        file.sync_all()?;
        Ok(Hash::from_digest(&self.hasher.clone().finalize()))
    }
}

impl Drop for Staged {
    fn drop(&mut self) {
        if !self.published {
            let _ = fs::remove_file(&self.path);
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
        assert!(root.join(&hex[0..2]).join(&hex[2..4]).join(hex).is_file());
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
