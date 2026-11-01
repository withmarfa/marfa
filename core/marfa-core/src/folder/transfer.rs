use crate::directory::Directory;
use crate::directory::{Mode, OFlags};
use std::fs::{File, Metadata};
use std::io::{self, Read, Seek, Write};
#[cfg(test)]
use std::path::Path;
use std::path::PathBuf;

use super::{identity, state};

#[derive(Clone)]
pub(super) struct Entry {
    pub directory: Directory,
    pub name: PathBuf,
    pub label: PathBuf,
}

pub(super) struct Source {
    entry: Entry,
    file: File,
    metadata: Metadata,
    hash: String,
    #[cfg(target_os = "macos")]
    attributes: Vec<(std::ffi::OsString, Vec<u8>)>,
}

impl Source {
    pub(super) fn open_at(entry: &Entry, bound: &state::Bound) -> io::Result<Self> {
        let file = entry
            .directory
            .open_file(&entry.name, OFlags::RDONLY, Mode::empty())?;
        let metadata = file.metadata()?;
        if !metadata.is_file() || metadata.is_symlink() {
            return Err(changed());
        }
        if let Some(expected) = &bound.identity
            && identity::of(&metadata).map(|found| found.key()).as_ref() != Some(expected)
        {
            return Err(changed());
        }
        if !same_file(&metadata, &file.metadata()?) {
            return Err(changed());
        }
        #[cfg(target_os = "macos")]
        let attributes = attributes(&file)?;
        let source = Self {
            #[cfg(target_os = "macos")]
            attributes,
            entry: entry.clone(),
            file,
            metadata,
            hash: bound.content_hash.clone(),
        };
        source.check()?;
        Ok(source)
    }

    pub(super) fn protected(&self, error: &io::Error) -> bool {
        error.kind() == io::ErrorKind::PermissionDenied
            && self
                .entry
                .directory
                .entry_metadata(&self.entry.name)
                .is_ok_and(|metadata| {
                    metadata.is_file()
                        && same_file(&self.metadata, &metadata)
                        && protected(&metadata)
                })
    }

    pub(super) fn fill(&self, target: &mut File) -> io::Result<()> {
        if self.fault("copy-failure") {
            target.write_all(b"partial copy")?;
            return Err(io::Error::other("copy refused by fixture"));
        }
        let mut source = self.file.try_clone()?;
        source.rewind()?;
        std::io::copy(&mut source, target)?;
        if self.fault("attribute-failure") {
            return Err(io::Error::other(
                "attribute preservation refused by fixture",
            ));
        }
        target.set_permissions(self.metadata.permissions())?;
        #[cfg(target_os = "macos")]
        {
            use xattr::FileExt;
            for (name, value) in &self.attributes {
                target.set_xattr(name, value)?;
                if target.get_xattr(name)?.as_ref() != Some(value) {
                    return Err(io::Error::other(
                        "a source attribute could not be preserved",
                    ));
                }
            }
        }
        target.rewind()?;
        let mut copied = Vec::new();
        target.read_to_end(&mut copied)?;
        if state::hash(&copied) != self.hash {
            return Err(changed());
        }
        self.check()
    }

    fn fault(&self, name: &str) -> bool {
        crate::fault::named(name).is_some_and(|name| {
            self.entry
                .label
                .file_name()
                .is_some_and(|file| file.to_string_lossy() == name)
        })
    }

    pub(super) fn check(&self) -> io::Result<()> {
        let metadata = self.entry.directory.entry_metadata(&self.entry.name)?;
        if !metadata.is_file() || metadata.is_symlink() || !same_file(&self.metadata, &metadata) {
            return Err(changed());
        }
        let mut source =
            self.entry
                .directory
                .open_file(&self.entry.name, OFlags::RDONLY, Mode::empty())?;
        if !same_file(&self.metadata, &source.metadata()?) {
            return Err(changed());
        }
        let mut found = Vec::new();
        source.read_to_end(&mut found)?;
        if state::hash(&found) != self.hash
            || !same_permissions(&self.metadata, &source.metadata()?)
        {
            return Err(changed());
        }
        #[cfg(target_os = "macos")]
        if attributes(&source)? != self.attributes {
            return Err(changed());
        }
        Ok(())
    }
}

fn changed() -> io::Error {
    io::Error::other("the source changed while it was being taken in")
}

#[cfg(unix)]
fn same_file(first: &Metadata, next: &Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    first.dev() == next.dev()
        && first.ino() == next.ino()
        && first.created().ok() == next.created().ok()
}

#[cfg(not(unix))]
fn same_file(first: &Metadata, next: &Metadata) -> bool {
    identity::of(first).is_some_and(|found| Some(found) == identity::of(next))
}

#[cfg(target_os = "macos")]
fn protected(metadata: &Metadata) -> bool {
    use std::os::macos::fs::MetadataExt;
    // UF_IMMUTABLE and SF_IMMUTABLE identify protection without changing it.
    metadata.st_flags() & (0x0000_0002 | 0x0002_0000) != 0
}

#[cfg(not(target_os = "macos"))]
fn protected(_metadata: &Metadata) -> bool {
    false
}

#[cfg(target_os = "macos")]
fn attributes(source: &File) -> io::Result<Vec<(std::ffi::OsString, Vec<u8>)>> {
    use xattr::FileExt;
    let mut found = Vec::new();
    for name in source.list_xattr()? {
        let value = source.get_xattr(&name)?.ok_or_else(changed)?;
        found.push((name, value));
    }
    found.sort_by(|first, next| first.0.cmp(&next.0));
    Ok(found)
}

#[cfg(unix)]
fn same_permissions(first: &Metadata, next: &Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    first.permissions().mode() == next.permissions().mode()
}

#[cfg(not(unix))]
fn same_permissions(first: &Metadata, next: &Metadata) -> bool {
    first.permissions().readonly() == next.permissions().readonly()
}

#[cfg(test)]
impl Source {
    fn open(path: &Path, bound: &state::Bound) -> io::Result<Self> {
        Self::open_at(
            &Entry {
                directory: Directory::open(&path.parent().unwrap().canonicalize()?)?,
                name: path.file_name().unwrap().into(),
                label: path.to_path_buf(),
            },
            bound,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::folder::landing;

    fn bound(path: &Path) -> state::Bound {
        let metadata = std::fs::symlink_metadata(path).unwrap();
        let hash = state::hash(&std::fs::read(path).unwrap());
        state::Bound {
            path: "source.bin".into(),
            item_id: "item".into(),
            identity: identity::of(&metadata).map(|found| found.key()),
            content_hash: hash.clone(),
            written_hash: Some(hash),
            presentation: None,
            blob: None,
            links: Vec::new(),
            embeds: Vec::new(),
            lines: Vec::new(),
            edit_line: None,
            held: None,
            own: None,
            writes: Default::default(),
        }
    }

    #[test]
    fn refuses_changed_source_bytes_before_publication() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("source.bin");
        let target = dir.path().join("target.bin");
        std::fs::write(&path, b"original").unwrap();
        let source = Source::open(&path, &bound(&path)).unwrap();
        std::fs::write(&path, b"edited").unwrap();
        assert!(landing::land(&target, |file, _| source.fill(file), |_| true).is_err());
        assert!(!target.exists());
        assert_eq!(std::fs::read(&path).unwrap(), b"edited");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn refuses_an_identical_file_replacing_the_source() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("source.bin");
        let next = dir.path().join("next.bin");
        std::fs::write(&path, b"identical").unwrap();
        let before = bound(&path);
        let source = Source::open(&path, &before).unwrap();
        std::fs::write(&next, b"identical").unwrap();
        std::fs::rename(&next, &path).unwrap();
        assert!(source.check().is_err());
        assert!(Source::open(&path, &before).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"identical");
    }

    #[test]
    fn permission_denial_without_immutable_protection_does_not_permit_copying() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("source.bin");
        std::fs::write(&path, b"original").unwrap();
        let source = Source::open(&path, &bound(&path)).unwrap();
        assert!(!source.protected(&io::ErrorKind::PermissionDenied.into()));
        assert!(!source.protected(&io::ErrorKind::AlreadyExists.into()));
        assert!(!source.protected(&io::ErrorKind::Unsupported.into()));
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_source_permission_change_after_copying() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("source.bin");
        let target = dir.path().join("target.bin");
        std::fs::write(&path, b"original").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o750)).unwrap();
        let source = Source::open(&path, &bound(&path)).unwrap();
        let outcome = landing::land(
            &target,
            |file, _| {
                source.fill(file)?;
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o640))
            },
            |found| found.is_none() && source.check().is_ok(),
        );
        assert!(outcome.is_err());
        assert!(!target.exists());
        assert_eq!(std::fs::read(&path).unwrap(), b"original");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn refuses_a_source_attribute_change_after_copying() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("source.bin");
        let target = dir.path().join("target.bin");
        std::fs::write(&path, b"original").unwrap();
        xattr::set(&path, "com.apple.quarantine", b"0081;fixture;Marfa;").unwrap();
        let source = Source::open(&path, &bound(&path)).unwrap();
        let outcome = landing::land(
            &target,
            |file, _| {
                source.fill(file)?;
                xattr::set(&path, "com.apple.quarantine", b"0081;changed;Marfa;")
            },
            |found| found.is_none() && source.check().is_ok(),
        );
        assert!(outcome.is_err());
        assert!(!target.exists());
        assert_eq!(std::fs::read(&path).unwrap(), b"original");
    }
}
