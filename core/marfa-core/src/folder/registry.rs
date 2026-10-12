use crate::directory::Directory;
use crate::directory::{Mode, OFlags};
use std::io::Write;
use std::path::{Component, Path, PathBuf};

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
        Registry::unnamed()
    }

    #[cfg(not(test))]
    fn unnamed() -> Option<Registry> {
        Some(Registry::at(machine_path(Path::new(
            &std::env::var_os("HOME").filter(|home| !home.is_empty())?,
        ))))
    }

    /// The runner that names a registry applies only when Cargo runs from
    /// under `core/`, so a unit test run from elsewhere or by an editor would
    /// otherwise list its folders in the machine's own.
    #[cfg(test)]
    fn unnamed() -> Option<Registry> {
        static OWN: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
        let dir = OWN.get_or_init(|| {
            tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap())
                .expect("a temporary directory for the tests' folder registry")
                .keep()
        });
        Some(Registry::at(dir.join(FILE_NAME)))
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
        let directory = Directory::create(&resolved(parent))
            .map_err(|error| self.failed("make the directory of", &error))?;
        let name = Path::new(
            self.path
                .file_name()
                .ok_or_else(|| CoreError::Invalid("registry needs a file name".into()))?,
        );
        // Two folders registering at once would each write back a list
        // missing the other's entry.
        let lock = directory
            .open_file(
                &name.with_extension("lock"),
                OFlags::WRONLY | OFlags::CREATE,
                Mode::from_raw_mode(0o600),
            )
            .map_err(|error| self.failed("lock", &error))?;
        lock.lock().map_err(|error| self.failed("lock", &error))?;
        let (mut listing, replaced) = match directory.read(name) {
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
            entry.dir = resolved(&entry.dir);
            if gone(&entry) {
                continue;
            }
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
            self.write(&directory, name, &listing)?;
        }
        Ok((listing.folders, edited))
    }

    /// Held under the lock, so whatever is there is this process's to replace.
    fn write(&self, directory: &Directory, name: &Path, listing: &Listing) -> Result<()> {
        let bytes = serde_json::to_vec_pretty(listing)?;
        super::landing::land_at(directory, name, |file, _| file.write_all(&bytes), |_| true)
            .map_err(|unlanded| self.failed("write", &unlanded.into()))
    }

    fn failed(&self, doing: &str, error: &std::io::Error) -> CoreError {
        CoreError::Store(format!(
            "cannot {doing} the folder registry {}: {error}",
            self.path.display()
        ))
    }
}

fn machine_path(home: &Path) -> PathBuf {
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
    base.join(FILE_NAME)
}

/// Parent components are removed only after both spellings open the same
/// directory without following links, so a link before `..` cannot disappear.
pub fn resolved(dir: &Path) -> PathBuf {
    let absolute = std::path::absolute(dir).unwrap_or_else(|_| dir.to_path_buf());
    let absolute = with_ancestors_resolved(&absolute);
    if !absolute
        .components()
        .any(|part| part == Component::ParentDir)
    {
        return absolute;
    }
    let Ok(admitted) = Directory::open(&absolute) else {
        return absolute;
    };
    let mut normalized = PathBuf::new();
    for part in absolute.components() {
        match part {
            Component::ParentDir => {
                normalized.pop();
            }
            Component::CurDir => {}
            part => normalized.push(part.as_os_str()),
        }
    }
    if Directory::open(&normalized)
        .is_ok_and(|directory| admitted.same(&directory).unwrap_or(false))
    {
        normalized
    } else {
        absolute
    }
}

/// The directories above a root are the person's and outside the folder, and
/// the system links some of them (`/var` and `/tmp` on macOS), so links there
/// are followed. The root's own entry, and any component a later `..` climbs
/// back out of, are left for the no-follow open to judge.
fn with_ancestors_resolved(absolute: &Path) -> PathBuf {
    let parts: Vec<Component> = absolute.components().collect();
    let mut depth = 0usize;
    let mut lowest = usize::MAX;
    for part in &parts {
        match part {
            Component::Normal(_) => depth += 1,
            Component::ParentDir => {
                depth = depth.saturating_sub(1);
                lowest = lowest.min(depth);
            }
            _ => {}
        }
    }
    let lead = parts
        .iter()
        .take_while(|part| !matches!(part, Component::Normal(_)))
        .count();
    let (above, rest) = parts.split_at(lead + lowest.min(depth.saturating_sub(1)));
    let above: PathBuf = above.iter().collect();
    for base in above.ancestors() {
        if let Ok(mut found) = std::fs::canonicalize(base) {
            if let Ok(missing) = above.strip_prefix(base)
                && !missing.as_os_str().is_empty()
            {
                found.push(missing);
            }
            found.extend(rest);
            return found;
        }
    }
    absolute.to_path_buf()
}

/// Missing or unreadable roots are kept, since a disconnected volume or a
/// replaced root cannot establish that the admitted folder was removed.
pub(super) fn gone(entry: &Registered) -> bool {
    let Ok(root) = Directory::open(&entry.dir) else {
        return false;
    };
    matches!(
        root.child(Path::new(STATE_DIR), false).and_then(|state| state.entry_identity(Path::new("core.sqlite"))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound
    )
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
    fn parent_components_do_not_hide_nested_registered_folders() {
        let temp = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let outer = folder_at(temp.path(), "outer");
        std::fs::create_dir(outer.join("child")).unwrap();
        let inner = folder_at(&outer, "nested");
        let parent_spelling = outer.join("child/..");
        let registry = Registry::at(temp.path().join(FILE_NAME));
        registry.add(&parent_spelling, "outer", None).unwrap();
        assert!(registry.add(&inner, "inner", None).is_err());
        registry.unregister(&parent_spelling).unwrap();
        registry.add(&inner, "inner", None).unwrap();
        assert!(registry.add(&parent_spelling, "outer", None).is_err());
    }

    #[test]
    fn a_linked_ancestor_is_resolved_and_nothing_at_or_below_the_root_is_followed() {
        let temp = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let base = temp.path();
        let real = base.join("real");
        std::fs::create_dir_all(real.join("notes/child")).unwrap();
        std::fs::create_dir(base.join("elsewhere")).unwrap();
        std::os::unix::fs::symlink(&real, base.join("link")).unwrap();
        let named = base.join("link/notes");
        assert!(Directory::open(&named).is_err());
        assert_eq!(resolved(&named), real.join("notes"));
        assert!(Directory::open(&resolved(&named)).is_ok());
        assert_eq!(
            resolved(&base.join("link/new/deeper")),
            real.join("new/deeper")
        );
        assert_eq!(
            resolved(&base.join("link/notes/child/..")),
            real.join("notes")
        );

        std::os::unix::fs::symlink(real.join("notes"), base.join("alias")).unwrap();
        assert_eq!(resolved(&base.join("alias")), base.join("alias"));
        assert!(Directory::open(&resolved(&base.join("alias"))).is_err());
        assert!(Directory::open(&resolved(&base.join("alias/child/.."))).is_err());
        std::os::unix::fs::symlink(base.join("elsewhere"), real.join("notes/inside")).unwrap();
        let root = Directory::open(&resolved(&named)).unwrap();
        assert!(root.child(Path::new("child"), false).is_ok());
        assert!(root.child(Path::new("inside"), false).is_err());
        let back = base.join("link/notes/inside/..");
        assert_eq!(resolved(&back), real.join("notes/inside/.."));
        assert!(Directory::open(&resolved(&back)).is_err());
    }

    #[test]
    fn a_folder_named_through_a_linked_ancestor_is_added_opened_and_removed_where_it_resolves() {
        use crate::folder::Folder;
        let temp = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let real = temp.path().join("real");
        let root = real.join("notes");
        std::fs::create_dir_all(root.join(STATE_DIR)).unwrap();
        let core = crate::Core::open(root.join(STATE_DIR).join("core.sqlite"), None).unwrap();
        super::super::settings_file::bind(&core, "01a00000-0000-7000-8000-000000000001").unwrap();
        drop(core);
        std::os::unix::fs::symlink(&real, temp.path().join("link")).unwrap();
        let named = temp.path().join("link/notes");

        assert_eq!(Folder::open(&named, None).unwrap().root(), root);
        let not_a_folder = |status: Result<crate::folder::StatusReport>| match status {
            Err(CoreError::Invalid(message)) => message.contains("is not a folder"),
            _ => false,
        };
        assert!(!not_a_folder(Folder::status_of(&named)));
        std::os::unix::fs::symlink(&root, temp.path().join("alias")).unwrap();
        assert!(Folder::open(temp.path().join("alias"), None).is_err());
        assert!(not_a_folder(Folder::status_of(temp.path().join("alias"))));
        Folder::remove_at(&named).unwrap();
        assert!(!root.join(STATE_DIR).join("core.sqlite").exists());

        let server = crate::scripted::Scripted::start();
        let added = Folder::add(
            temp.path().join("link/fresh"),
            "01a00000-0000-7000-8000-000000000002",
            Some(crate::Server {
                url: server.url(),
                key: "fixture".into(),
            }),
            None,
        );
        assert!(!matches!(added, Err(CoreError::Io(_))), "{:?}", added.err());
        assert!(real.join("fresh").join(STATE_DIR).is_dir());
    }

    #[test]
    fn a_unit_test_that_names_no_registry_never_reaches_the_machines_own() {
        let home = std::env::var_os("HOME").unwrap_or_default();
        let machine = machine_path(Path::new(&home));
        assert_eq!(machine.file_name(), Some(FILE_NAME.as_ref()));
        let unnamed = Registry::unnamed().unwrap();
        assert_ne!(unnamed.path(), machine);
        assert!(
            unnamed
                .path()
                .starts_with(std::env::temp_dir().canonicalize().unwrap())
        );
        assert_ne!(Registry::located().unwrap().path(), machine);
    }

    #[test]
    fn a_registry_that_cannot_be_read_is_left_by_a_listing_and_written_afresh_by_an_add() {
        let root = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
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
