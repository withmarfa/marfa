use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::STATE_DIR;
use crate::Result;
use crate::error::CoreError;

/// Names the registry's file in place of this machine's own, so two
/// registries on one machine can stand in for two machines.
pub const REGISTRY_ENV: &str = "MARFA_FOLDER_REGISTRY";

const FILE_NAME: &str = "folders.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Registered {
    pub dir: PathBuf,
    /// The `system.folder` it follows.
    pub folder: String,
    /// The folder's own store, so a folder listing itself under a new
    /// directory takes the place of its old entry.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub store: Option<String>,
}

#[derive(Default, Serialize, Deserialize)]
struct Listing {
    folders: Vec<Registered>,
}

#[derive(Debug, Clone)]
pub struct Registry {
    path: PathBuf,
}

/// Whether a registry that cannot be read is written afresh or left as it is.
#[derive(Clone, Copy, PartialEq)]
enum Unreadable {
    Refuse,
    Replace,
}

impl Registry {
    pub fn at(path: impl Into<PathBuf>) -> Registry {
        Registry { path: path.into() }
    }

    /// `None` with no home to keep one in: its folders then stand alone.
    pub fn located() -> Option<Registry> {
        if let Some(named) = std::env::var_os(REGISTRY_ENV).filter(|named| !named.is_empty()) {
            return Some(Registry::at(named));
        }
        let home = PathBuf::from(std::env::var_os("HOME").filter(|home| !home.is_empty())?);
        let base = if cfg!(target_os = "macos") {
            home.join("Library")
                .join("Application Support")
                .join("Marfa")
        } else {
            match std::env::var_os("XDG_DATA_HOME").filter(|data| !data.is_empty()) {
                Some(data) => PathBuf::from(data).join("marfa"),
                None => home.join(".local").join("share").join("marfa"),
            }
        };
        Some(Registry::at(base.join(FILE_NAME)))
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// A folder that is gone is dropped from the file.
    pub fn folders(&self) -> Result<Vec<Registered>> {
        self.change(Unreadable::Refuse, |_| false)
            .map(|(listed, _)| listed)
    }

    /// Lists a folder again where the registry lost it or the directory
    /// moved. A registry that cannot be read is left as it is.
    pub fn register(&self, dir: &Path, folder: &str, store: Option<&str>) -> Result<()> {
        self.list(dir, folder, store, Unreadable::Refuse)
    }

    /// Lists a folder being added, refusing one nested with another; an
    /// unreadable registry is written afresh.
    pub fn add(&self, dir: &Path, folder: &str, store: Option<&str>) -> Result<()> {
        let dir = resolved(dir);
        if let Ok(listed) = self.folders()
            && let Some(other) = listed.iter().find(|entry| {
                entry.dir != dir && (dir.starts_with(&entry.dir) || entry.dir.starts_with(&dir))
            })
        {
            return Err(CoreError::Invalid(format!(
                "{} and the folder {} would hold one another's files; a folder cannot sit inside another",
                dir.display(),
                other.dir.display()
            )));
        }
        self.list(&dir, folder, store, Unreadable::Replace)
    }

    fn list(
        &self,
        dir: &Path,
        folder: &str,
        store: Option<&str>,
        unreadable: Unreadable,
    ) -> Result<()> {
        let entry = Registered {
            dir: resolved(dir),
            folder: folder.to_string(),
            store: store.map(str::to_string),
        };
        self.change(unreadable, |listed| {
            if listed.contains(&entry) {
                return false;
            }
            listed.retain(|other| {
                other.dir != entry.dir && (entry.store.is_none() || other.store != entry.store)
            });
            listed.push(entry.clone());
            true
        })
        .map(|_| ())
    }

    /// Answers whether the folder was listed.
    pub fn unregister(&self, dir: &Path) -> Result<bool> {
        let dir = resolved(dir);
        self.change(Unreadable::Refuse, |listed| {
            let before = listed.len();
            listed.retain(|entry| entry.dir != dir);
            listed.len() != before
        })
        .map(|(_, changed)| changed)
    }

    /// Reads the list under the registry's lock, tidies it, applies `edit`,
    /// and writes it back where anything changed.
    fn change(
        &self,
        unreadable: Unreadable,
        edit: impl FnOnce(&mut Vec<Registered>) -> bool,
    ) -> Result<(Vec<Registered>, bool)> {
        let parent = self
            .path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        std::fs::create_dir_all(parent)
            .map_err(|error| self.failed("make the directory of", &error))?;
        // Two folders registering at once would each write back a list
        // missing the other's entry.
        let lock = File::create(self.path.with_extension("lock"))
            .map_err(|error| self.failed("lock", &error))?;
        lock.lock().map_err(|error| self.failed("lock", &error))?;
        let (mut listing, replaced) = match std::fs::read(&self.path) {
            Ok(bytes) => match serde_json::from_slice::<Listing>(&bytes) {
                Ok(listing) => (listing, false),
                Err(_) if unreadable == Unreadable::Replace => (Listing::default(), true),
                Err(error) => {
                    return Err(CoreError::Store(format!(
                        "the folder registry {} cannot be read ({error}); `folders add` writes it afresh",
                        self.path.display()
                    )));
                }
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                (Listing::default(), false)
            }
            Err(error) => return Err(self.failed("read", &error)),
        };
        let mut tidied: Vec<Registered> = Vec::new();
        for mut entry in std::mem::take(&mut listing.folders) {
            if gone(&entry) {
                continue;
            }
            entry.dir = resolved(&entry.dir);
            tidied.retain(|kept| {
                kept.dir != entry.dir && (entry.store.is_none() || kept.store != entry.store)
            });
            tidied.push(entry);
        }
        let changed =
            replaced || serde_json::to_vec(&tidied)? != serde_json::to_vec(&listing.folders)?;
        listing.folders = tidied;
        let edited = edit(&mut listing.folders);
        if changed || edited {
            self.write(&listing)?;
        }
        Ok((listing.folders, edited))
    }

    /// Written beside and renamed over, synced first so a crash leaves the
    /// old list or the new one.
    fn write(&self, listing: &Listing) -> Result<()> {
        let beside = self.path.with_extension("json.writing");
        let bytes = serde_json::to_vec_pretty(listing)?;
        File::create(&beside)
            .and_then(|mut file| {
                file.write_all(&bytes)?;
                file.sync_all()
            })
            .and_then(|()| std::fs::rename(&beside, &self.path))
            .map_err(|error| self.failed("write", &error))
    }

    fn failed(&self, doing: &str, error: &std::io::Error) -> CoreError {
        CoreError::Store(format!(
            "cannot {doing} the folder registry {}: {error}",
            self.path.display()
        ))
    }
}

/// A directory as the registry names it: resolved as far as it exists, so
/// two spellings of one directory are one folder, missing or not.
pub fn resolved(dir: &Path) -> PathBuf {
    for base in dir.ancestors() {
        if let Ok(found) = std::fs::canonicalize(base) {
            return match dir.strip_prefix(base) {
                Ok(rest) if !rest.as_os_str().is_empty() => found.join(rest),
                _ => found,
            };
        }
    }
    dir.to_path_buf()
}

/// Whether a listed folder is gone: its directory reads, and holds no
/// folder. One missing or unreadable is kept, since it cannot be told from
/// one renamed, unmounted or shut for now.
pub(super) fn gone(entry: &Registered) -> bool {
    matches!(
        std::fs::metadata(entry.dir.join(STATE_DIR).join("core.sqlite")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound
    ) && std::fs::read_dir(&entry.dir).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder_at(root: &Path, name: &str) -> PathBuf {
        let dir = root.join(name);
        std::fs::create_dir_all(dir.join(STATE_DIR)).unwrap();
        std::fs::write(dir.join(STATE_DIR).join("core.sqlite"), b"").unwrap();
        dir
    }

    #[test]
    fn a_registry_that_cannot_be_read_is_left_by_a_listing_and_written_afresh_by_an_add() {
        let root = tempfile::tempdir().unwrap();
        let registry = Registry::at(root.path().join(FILE_NAME));
        let one = folder_at(root.path(), "one");
        std::fs::write(registry.path(), b"").unwrap();
        assert!(registry.folders().is_err());
        assert!(registry.register(&one, "f1", None).is_err());
        assert_eq!(std::fs::read(registry.path()).unwrap(), b"");
        registry.add(&one, "f1", None).unwrap();
        assert_eq!(registry.folders().unwrap().len(), 1);

        use std::os::unix::fs::PermissionsExt;
        let shut = Registry::at(root.path().join("shut.json"));
        std::fs::write(shut.path(), b"").unwrap();
        std::fs::set_permissions(shut.path(), std::fs::Permissions::from_mode(0o000)).unwrap();
        assert!(shut.add(&one, "f1", None).is_err());
        std::fs::set_permissions(shut.path(), std::fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(std::fs::read(shut.path()).unwrap(), b"");
    }
}
