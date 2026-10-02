use std::collections::HashMap;
use std::fs::Metadata;
use std::path::Path;

use crate::error::CoreError;

/// Private fields, so `from_parts` is the only way to make an `Identity` and
/// the zero rule cannot be bypassed.
mod rule {
    /// The birth time is what tells a reused inode from the file that had it.
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
    pub struct Identity {
        device: u64,
        inode: u64,
        /// Nanoseconds since the epoch. Zero is not a birth time; it is the
        /// filesystem saying it does not keep one.
        born_at: u128,
    }

    impl Identity {
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

        pub fn key(&self) -> String {
            format!("{}:{}:{}", self.device, self.inode, self.born_at)
        }
    }
}

pub use rule::Identity;

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

    #[test]
    fn a_zero_birth_time_yields_no_identity() {
        assert!(
            Identity::from_parts(1, 2, 0).is_none(),
            "a filesystem that keeps no birth time reports zero for every \
             file, and an identity built from one matches any other file that \
             was handed the same reused inode: a rename would be followed \
             onto the wrong file and one note written over another"
        );
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
        std::fs::hard_link(&one, &two).unwrap();
        let resolved = resolve(&[one.clone(), two.clone()]);
        assert!(
            resolved.is_empty(),
            "an identity two paths share was handed to one of them, and the \
             folder cannot know which is the file it remembers: a rename \
             would bind the wrong one and write its contents over the item"
        );

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
}
