//! Which file is which across a rename, for a file that cannot carry a
//! `marfa_id` (`folders.md` 14).
//!
//! Fail-closed: a file is the same file when its device, inode and birth time
//! all match. A zero birth time yields no identity, an identity two files
//! share yields none, and no identity means a new item, never a guess.

use std::collections::HashMap;
use std::fs::Metadata;
use std::path::Path;

use crate::error::CoreError;

/// Private fields, so `from_parts` is the only way to make an `Identity` and
/// the zero rule cannot be bypassed.
mod rule {
    /// What makes a file the same file. The birth time is what tells a reused
    /// inode from the file that had it.
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
    pub struct Identity {
        device: u64,
        inode: u64,
        /// Nanoseconds since the epoch. Zero is not a birth time; it is the
        /// filesystem saying it does not keep one.
        born_at: u128,
    }

    impl Identity {
        /// The rule itself, apart from the filesystem that feeds it.
        pub fn from_parts(device: u64, inode: u64, born_at: u128) -> Option<Identity> {
            // A filesystem that keeps no birth time reports zero for every
            // file, which would match a reused inode.
            if born_at == 0 {
                return None;
            }
            Some(Identity {
                device,
                inode,
                born_at,
            })
        }

        /// The identity as the mapping stores it.
        pub fn key(&self) -> String {
            format!("{}:{}:{}", self.device, self.inode, self.born_at)
        }
    }
}

pub use rule::Identity;

/// The identity of a file, or nothing if this filesystem cannot give one.
pub fn of(metadata: &Metadata) -> Option<Identity> {
    Identity::from_parts(device_of(metadata), inode_of(metadata), born(metadata)?)
}

/// A file's birth time in nanoseconds since the epoch, where the filesystem
/// keeps one.
pub fn born(metadata: &Metadata) -> Option<u128> {
    Some(
        metadata
            .created()
            .ok()?
            .duration_since(std::time::UNIX_EPOCH)
            .ok()?
            .as_nanos(),
    )
    .filter(|nanos| *nanos > 0)
}

#[cfg(unix)]
fn device_of(metadata: &Metadata) -> u64 {
    use std::os::unix::fs::MetadataExt;
    metadata.dev()
}

#[cfg(unix)]
fn inode_of(metadata: &Metadata) -> u64 {
    use std::os::unix::fs::MetadataExt;
    metadata.ino()
}

#[cfg(not(unix))]
fn device_of(_metadata: &Metadata) -> u64 {
    0
}

#[cfg(not(unix))]
fn inode_of(_metadata: &Metadata) -> u64 {
    0
}

/// The identity of every file in a set, with an identity two files share
/// withheld from both.
pub fn resolve(paths: &[std::path::PathBuf]) -> HashMap<std::path::PathBuf, Identity> {
    let mut seen: HashMap<Identity, Vec<std::path::PathBuf>> = HashMap::new();
    for path in paths {
        let Ok(metadata) = std::fs::symlink_metadata(path) else {
            continue;
        };
        // A symlink is not the file it points at.
        if metadata.is_symlink() || !metadata.is_file() {
            continue;
        }
        if let Some(identity) = of(&metadata) {
            seen.entry(identity).or_default().push(path.clone());
        }
    }
    let mut resolved = HashMap::new();
    for (identity, paths) in seen {
        if paths.len() == 1 {
            resolved.insert(paths[0].clone(), identity);
        }
    }
    resolved
}

/// A file's path inside the folder, with `/` between its components on any
/// machine.
pub fn relative(folder: &Path, path: &Path) -> Result<String, CoreError> {
    let relative = path.strip_prefix(folder).map_err(|_| {
        CoreError::Invalid(format!(
            "{} is not inside {}, so it has no place in this folder",
            path.display(),
            folder.display()
        ))
    })?;
    Ok(relative
        .components()
        .map(|part| part.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The zero case, which no file on a filesystem keeping birth times can
    /// reach.
    #[test]
    fn a_zero_birth_time_yields_no_identity() {
        assert!(
            Identity::from_parts(1, 2, 0).is_none(),
            "a filesystem that keeps no birth time reports zero for every \
             file, and an identity built from one matches any other file that \
             was handed the same reused inode: a rename would be followed \
             onto the wrong file and one note written over another"
        );
        // The control: the same device and inode with a birth time do yield
        // one, so the refusal above is the zero and not the rule refusing
        // everything.
        assert!(Identity::from_parts(1, 2, 1).is_some());
        assert_ne!(
            Identity::from_parts(1, 2, 1),
            Identity::from_parts(1, 2, 2),
            "two files sharing a device and an inode were called the same \
             file, so the birth time is not being compared and inode reuse \
             goes unnoticed"
        );
    }

    #[test]
    fn an_identity_two_files_share_is_withheld_from_both() {
        let dir = tempfile::tempdir().unwrap();
        let one = dir.path().join("one");
        let two = dir.path().join("two");
        std::fs::write(&one, b"contents").unwrap();
        // A hard link: one inode, one device, one birth time, two paths.
        std::fs::hard_link(&one, &two).unwrap();
        let resolved = resolve(&[one.clone(), two.clone()]);
        assert!(
            resolved.is_empty(),
            "an identity two paths share was handed to one of them, and the \
             folder cannot know which is the file it remembers: a rename \
             would bind the wrong one and write its contents over the item"
        );

        // The control: alone, each has an identity. Without it the assertion
        // above is satisfied by a resolver that answers nothing at all.
        assert_eq!(resolve(&[one]).len(), 1);
    }

    #[test]
    fn a_symlink_is_not_the_file_it_points_at() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real");
        let link = dir.path().join("link");
        std::fs::write(&real, b"contents").unwrap();
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let resolved = resolve(&[real.clone(), link]);
        assert_eq!(
            resolved.len(),
            1,
            "a symlink was given the identity of the file it points at, so \
             two paths claim one item on purpose and the folder pushes the \
             same note twice"
        );
        assert!(resolved.contains_key(&real));
    }

    #[test]
    fn the_relative_path_is_the_path_inside_the_folder() {
        let root = Path::new("/somewhere/notes");
        assert_eq!(
            relative(root, &root.join("deep").join("note.md")).unwrap(),
            "deep/note.md"
        );
        assert!(
            relative(root, Path::new("/elsewhere/note.md")).is_err(),
            "a file outside the folder was given a path inside it"
        );
    }
}
