//! Which file is which, across a rename.
//!
//! **Fail-closed** (`folders.md` 8). A file is the same file when its device,
//! inode and birth time all match; a zero birth time yields no identity, and
//! an identity two files share yields none. No identity means a new item,
//! never a guess — because a guess that is wrong writes one file's contents
//! over another item, and nothing anywhere reports it.

use std::collections::HashMap;
use std::fs::Metadata;
use std::path::Path;

use crate::error::CoreError;

/// The rule that decides whether two paths are one file, and the only way
/// to make one.
///
/// A module of its own with private fields, so nothing outside it can build
/// an `Identity` without going through `from_parts`. **That is structural
/// rather than tested, deliberately**: the zero case cannot be reached
/// through a real file on a filesystem that keeps birth times, so a test
/// that the door consults the rule would be comparing two paths that must
/// agree. Making the rule the only constructor means there is no door to
/// bypass it from.
mod rule {
    /// What makes a file the same file.
    ///
    /// The three together and nothing else. An inode alone is reused by the
    /// filesystem the moment a file is deleted, so a new file can be handed
    /// the inode of one the folder still remembers — and the birth time is
    /// what tells those two apart.
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
        ///
        /// The **only** way to make an `Identity`, which is what makes the
        /// refusal below unavoidable rather than merely usual.
        pub fn from_parts(device: u64, inode: u64, born_at: u128) -> Option<Identity> {
            // Zero yields no identity. A filesystem that does not keep a
            // birth time reports one for every file, and two files that both
            // report zero would match each other on device and inode alone —
            // which is the inode reuse this exists to catch.
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
    let born_at = metadata
        .created()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_nanos();
    Identity::from_parts(device_of(metadata), inode_of(metadata), born_at)
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

/// The identity of every file in a set, with the shared ones withheld.
///
/// **An identity two files share yields none**, for both of them. Two files
/// claiming one identity is the filesystem telling the folder something it
/// cannot act on, and picking either would bind the wrong file to the item.
pub fn resolve(paths: &[std::path::PathBuf]) -> HashMap<std::path::PathBuf, Identity> {
    let mut seen: HashMap<Identity, Vec<std::path::PathBuf>> = HashMap::new();
    for path in paths {
        let Ok(metadata) = std::fs::symlink_metadata(path) else {
            continue;
        };
        // A symlink is not the file it points at, and following one would
        // give two paths the same identity on purpose.
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

/// The natural key a folder gives a file.
///
/// The path inside the folder, and nothing about the machine
/// (`folders.md` 10). The same file in the same place on two machines is one
/// item, whatever credential each machine holds, so anything here that
/// differed per machine would make every file two items.
pub fn natural_key(folder: &Path, path: &Path) -> Result<String, CoreError> {
    let relative = path.strip_prefix(folder).map_err(|_| {
        CoreError::Invalid(format!(
            "{} is not inside {}, so it has no place in this folder",
            path.display(),
            folder.display()
        ))
    })?;
    // Separators normalised, so the same file is one key on either kind of
    // machine rather than two.
    Ok(relative
        .components()
        .map(|part| part.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The zero case, reached where it can be reached.
    ///
    /// Not through a file: this filesystem keeps a birth time for
    /// everything, so no fixture driving the binary can produce one. The
    /// filesystems the rule exists for — some Linux ones, some network
    /// mounts — report zero, and a device built there would follow a rename
    /// onto the wrong file. What keeps the door honest is not a test but the
    /// module above: `from_parts` is the only constructor, so there is
    /// nowhere the rule can be bypassed from.
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
    fn the_natural_key_is_the_path_and_nothing_about_the_machine() {
        let root = Path::new("/somewhere/notes");
        assert_eq!(
            natural_key(root, &root.join("deep").join("note.md")).unwrap(),
            "deep/note.md",
            "the natural key carries something other than the path inside the \
             folder, so the same file on two machines is two items and neither \
             can say why"
        );
        assert!(
            natural_key(root, Path::new("/elsewhere/note.md")).is_err(),
            "a file outside the folder was given a key inside it"
        );
    }
}
