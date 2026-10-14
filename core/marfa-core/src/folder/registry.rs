use crate::directory::Directory;
use crate::directory::{FileType, Mode, OFlags};
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

    /// Lists a folder being added at `dir`, whose directory `root` holds,
    /// refusing one nested with another and taking the place of an entry
    /// that lists the same directory by another spelling. An unreadable
    /// registry is written afresh.
    pub(crate) fn add(
        &self,
        dir: &Path,
        root: &Directory,
        folder: &str,
        store: Option<&str>,
    ) -> Result<()> {
        let entry = Registered {
            dir: absolute(dir),
            folder: folder.to_string(),
            store: store.map(str::to_string),
        };
        let mut nested = None;
        // Judged under the lock, so two folders added at once cannot each
        // miss the other.
        self.change(Unreadable::Replace, |listed| {
            let mut respelled = Vec::new();
            for other in listed.iter() {
                match relation(root, &entry.dir, other) {
                    Relation::Nested => {
                        nested = Some(other.dir.clone());
                        return false;
                    }
                    Relation::Same if other.dir != entry.dir => respelled.push(other.dir.clone()),
                    Relation::Same | Relation::Apart => {}
                }
            }
            let before = listed.len();
            listed.retain(|other| !respelled.contains(&other.dir));
            put(listed, &entry) || listed.len() != before
        })?;
        match nested {
            Some(other) => Err(CoreError::Invalid(format!(
                "{} and the folder {} would hold one another's files; a folder cannot sit inside another",
                entry.dir.display(),
                other.display()
            ))),
            None => Ok(()),
        }
    }

    fn list(
        &self,
        dir: &Path,
        folder: &str,
        store: Option<&str>,
        unreadable: Unreadable,
    ) -> Result<()> {
        let entry = Registered {
            dir: absolute(dir),
            folder: folder.to_string(),
            store: store.map(str::to_string),
        };
        self.change(unreadable, |listed| put(listed, &entry))
            .map(|_| ())
    }

    /// Takes off the entry for `dir`, and every entry for `store` where one
    /// is given, so a folder moved since it was listed leaves no entry
    /// behind. Answers whether any was listed.
    pub fn unregister(&self, dir: &Path, store: Option<&str>) -> Result<bool> {
        let dir = absolute(dir);
        self.change(Unreadable::Refuse, |listed| {
            let before = listed.len();
            listed.retain(|entry| {
                entry.dir != dir && (store.is_none() || entry.store.as_deref() != store)
            });
            listed.len() != before
        })
        .map(|(_, changed)| changed)
    }

    /// The entries as written, read without the lock or a rewrite, since
    /// every write lands whole.
    fn listing(&self) -> Option<Vec<Registered>> {
        let path = resolved(&self.path);
        let (parent, name) = (path.parent()?, path.file_name()?);
        let bytes = Directory::open(parent)
            .and_then(|directory| directory.read(Path::new(name)))
            .ok()?;
        serde_json::from_slice::<Listing>(&bytes)
            .ok()
            .map(|listing| listing.folders)
    }

    /// Reads the list under the registry's lock, tidies it, applies `edit`,
    /// and writes it back where anything changed.
    fn change(
        &self,
        unreadable: Unreadable,
        edit: impl FnOnce(&mut Vec<Registered>) -> bool,
    ) -> Result<(Vec<Registered>, bool)> {
        // Resolved as a file, so a link at the registry's own directory is
        // followed and only the file itself is opened without following.
        let path = resolved(&self.path);
        let parent = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        let directory = Directory::create(parent)
            .map_err(|error| self.failed("make the directory of", &error))?;
        let name = Path::new(
            path.file_name()
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
        // Entries are listed resolved; resolving one again would follow a
        // link that replaced its directory since.
        for entry in std::mem::take(&mut listing.folders) {
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

/// Lists `entry` in place of any entry for its directory spelled the same,
/// or for its store. Answers whether the list changed.
fn put(listed: &mut Vec<Registered>, entry: &Registered) -> bool {
    if listed.contains(entry) {
        return false;
    }
    listed.retain(|other| {
        other.dir != entry.dir && (entry.store.is_none() || other.store != entry.store)
    });
    listed.push(entry.clone());
    true
}

/// How a folder being added stands to a listed one.
enum Relation {
    /// The same directory.
    Same,
    /// One directory holds the other.
    Nested,
    Apart,
}

/// Judged by the directories themselves, so that no spelling of either path,
/// such as another letter case on a case-insensitive volume, hides one
/// folder inside the other. A listed path that does not open without
/// following links, as on a volume that is away, is judged by its spelling,
/// which is all there is of it.
fn relation(root: &Directory, dir: &Path, entry: &Registered) -> Relation {
    let spelled = || {
        if entry.dir == dir {
            Relation::Same
        } else if dir.starts_with(&entry.dir) || entry.dir.starts_with(dir) {
            Relation::Nested
        } else {
            Relation::Apart
        }
    };
    let Ok(listed) = Directory::open(&entry.dir) else {
        return spelled();
    };
    if listed.same(root).unwrap_or(false) {
        return Relation::Same;
    }
    match (within(&listed, root), within(root, &listed)) {
        (Some(true), _) | (_, Some(true)) => Relation::Nested,
        (Some(false), Some(false)) => Relation::Apart,
        _ => spelled(),
    }
}

/// Whether `inner` lies below `outer`, climbing from `inner` one `..` at a
/// time; `None` where a step cannot be taken.
fn within(inner: &Directory, outer: &Directory) -> Option<bool> {
    // No path reaches deeper than `PATH_MAX` allows; a file system that
    // answers `..` with ever new directories would otherwise never end.
    const DEEPEST: usize = 4096;
    let mut at = inner.clone();
    for _ in 0..DEEPEST {
        let up = at.up().ok()?;
        if up.same(&at).ok()? {
            return Some(false);
        }
        if up.same(outer).ok()? {
            return Some(true);
        }
        at = up;
    }
    None
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

/// The directories above a root are the person's and outside the folder, and
/// the system links some of them (`/var` and `/tmp` on macOS), so links there
/// are followed. The root's own entry, and every component a later `..`
/// climbs back out of, are opened without following links, and a `..` is
/// removed only after the walk through it returns to the directory it left,
/// so a link before `..` cannot disappear. A path [`named`] refuses keeps
/// its spelling from the refused component on.
pub fn resolved(dir: &Path) -> PathBuf {
    walk(dir).0
}

/// What a path given for an existing folder reaches.
pub(crate) enum Reached {
    /// The listed folder this path names, at the path it is listed at.
    Listed(Registered),
    /// No listed folder: the path as [`named`] resolves it.
    Unlisted(PathBuf),
}

/// A path the registry lists by this spelling names that entry, never
/// resolved again. Any other path is [`named`], and names a listed folder
/// only where that folder's own listed path, opened without following links,
/// is the directory it reaches. Where a listed path now reaches that
/// directory only through a link, or two listed paths reach it, the path
/// could mean either folder, so it is refused.
pub(crate) fn reach(dir: &Path) -> Result<Reached> {
    let spelled = absolute(dir);
    let listed = listing();
    if let Some(entry) = listed.iter().find(|entry| entry.dir == spelled) {
        return Ok(Reached::Listed(entry.clone()));
    }
    let root = named(dir)?;
    let Ok(target) = Directory::open(&root) else {
        return Ok(match listed.into_iter().find(|entry| entry.dir == root) {
            Some(entry) => Reached::Listed(entry),
            None => Reached::Unlisted(root),
        });
    };
    let leading: Vec<&Registered> = listed
        .iter()
        .filter(|entry| leads_to(&entry.dir, &target))
        .collect();
    match leading.as_slice() {
        [] => Ok(Reached::Unlisted(root)),
        [entry] if stands_at(&entry.dir, &target) => Ok(Reached::Listed((*entry).clone())),
        _ => Err(CoreError::Invalid(format!(
            "{} could name more than one folder: {} is also reached from the listed folder paths {}, through a symbolic link that has replaced a listed folder's directory, so nothing was changed; name the folder by the path `folders list` shows for it",
            spelled.display(),
            root.display(),
            leading
                .iter()
                .map(|entry| entry.dir.display().to_string())
                .collect::<Vec<_>>()
                .join(" and ")
        ))),
    }
}

/// The machine's registry as written, or nothing where there is none or it
/// cannot be read.
pub(crate) fn listing() -> Vec<Registered> {
    Registry::located()
        .and_then(|registry| registry.listing())
        .unwrap_or_default()
}

/// The entry listed at the directory `root` names: the one whose listed path,
/// opened without following links, is that directory, or where nothing opens
/// there, the one listed by that path.
pub(crate) fn listed_at(root: &Path, listed: &[Registered]) -> Option<Registered> {
    match Directory::open(root) {
        Ok(target) => listed
            .iter()
            .find(|entry| stands_at(&entry.dir, &target))
            .cloned(),
        Err(_) => listed.iter().find(|entry| entry.dir == root).cloned(),
    }
}

/// The first symbolic link on `path`, checked one spelled prefix at a time.
pub(crate) fn first_link(path: &Path) -> Option<PathBuf> {
    let mut prefix = PathBuf::new();
    for part in path.components() {
        prefix.push(part);
        if std::fs::symlink_metadata(&prefix).is_ok_and(|entry| entry.file_type().is_symlink()) {
            return Some(prefix);
        }
    }
    None
}

/// Why a listed path is not opened: a symbolic link that now stands in it,
/// which a listed folder is never reached through. A listed folder the path
/// now leads to is named, since naming that directory would work on that
/// folder instead.
pub(crate) fn linked_listing(dir: &Path) -> Option<CoreError> {
    let link = first_link(dir)?;
    let leads = std::fs::canonicalize(dir)
        .ok()
        .and_then(|target| listed_at(&target, &listing()))
        .map(|other| {
            format!(
                "; {} now leads to {}, another listed folder",
                dir.display(),
                other.dir.display()
            )
        })
        .unwrap_or_default();
    Some(CoreError::Invalid(format!(
        "{} is listed in the folder registry, but {} is now a symbolic link, and a listed folder is never reached through one{leads}; `folders remove {}` only takes it off the list",
        dir.display(),
        link.display(),
        dir.display()
    )))
}

/// Whether `dir`, following its links, is the directory `target` holds.
fn leads_to(dir: &Path, target: &Directory) -> bool {
    std::fs::canonicalize(dir)
        .and_then(|path| Directory::open(&path))
        .is_ok_and(|directory| directory.same(target).unwrap_or(false))
}

/// Whether `dir`, opened without following links, is the directory `target`
/// holds.
pub(crate) fn stands_at(dir: &Path, target: &Directory) -> bool {
    Directory::open(dir).is_ok_and(|directory| directory.same(target).unwrap_or(false))
}

pub(crate) fn absolute(dir: &Path) -> PathBuf {
    std::path::absolute(dir).unwrap_or_else(|_| dir.to_path_buf())
}

/// [`resolved`], or why a folder cannot be named by this path: a symbolic
/// link it would be opened through, or a `..` that climbs back out of a
/// directory that does not exist, which creating the folder would make.
pub(crate) fn named(dir: &Path) -> Result<PathBuf> {
    match walk(dir) {
        (path, None) => Ok(path),
        (_, Some(refused)) => Err(refused.into_error()),
    }
}

/// Why a walk stopped short. It becomes an error only where a path is
/// [`named`], because saying why reads the registry, whose own path is
/// [`resolved`].
enum Refusal {
    /// A symbolic link the folder would be opened through: the folder's own
    /// entry where `own`, and what the link, or else the whole path, reaches.
    Link {
        link: PathBuf,
        reached: std::io::Result<PathBuf>,
        own: bool,
        /// The whole path, made absolute.
        named: PathBuf,
    },
    /// A `..` that climbs back out of a directory that does not exist.
    Missing(CoreError),
}

impl Refusal {
    fn into_error(self) -> CoreError {
        match self {
            Refusal::Missing(error) => error,
            Refusal::Link {
                link,
                reached,
                own,
                named,
            } => {
                let listed = listing();
                // A link standing where a folder is listed has taken that
                // folder's place, however the path spells the link, so the
                // directory it leads to is not the folder the path names.
                if let Some(refused) =
                    replaced(&link, &listed).and_then(|entry| linked_listing(&entry.dir))
                {
                    return refused;
                }
                // A directory that a listed path reaches only through a link
                // is not offered, since any link to that listing, or a chain
                // of them, reaches it too, and the folder meant may be the
                // listed one. Past a climbed link, a path can also read as
                // one directory and reach another.
                let reached = reached.ok().filter(|target| {
                    !reached_through_link(target, &listed)
                        && (own || same_directory(target, &resolved(&as_written(&named))))
                });
                through_link(&link, reached.as_deref(), own)
            }
        }
    }
}

fn walk(dir: &Path) -> (PathBuf, Option<Refusal>) {
    let absolute = absolute(dir);
    let parts: Vec<Component> = absolute.components().collect();
    let mut closed_by: Vec<Option<usize>> = vec![None; parts.len()];
    let mut entered = Vec::new();
    for (index, part) in parts.iter().enumerate() {
        match part {
            Component::Normal(_) => entered.push(index),
            Component::ParentDir => {
                if let Some(start) = entered.pop() {
                    closed_by[start] = Some(index);
                }
            }
            _ => {}
        }
    }
    let own = entered.last().copied();
    let mut at = PathBuf::new();
    let mut settled = true;
    let mut index = 0;
    while index < parts.len() {
        let part = parts[index];
        match (part, closed_by[index]) {
            (Component::Normal(_), Some(close)) => {
                if !settled {
                    at = existing_prefix_resolved(&at);
                    settled = true;
                }
                let climbed: PathBuf = parts[index..=close].iter().collect();
                if !returns(&at, &climbed) {
                    let refused = climb_refused(&at, &parts[index..=close], &absolute);
                    at.extend(&parts[index..]);
                    return (at, refused);
                }
                index = close;
            }
            (Component::Normal(_), None) if Some(index) == own => {
                if !settled {
                    at = existing_prefix_resolved(&at);
                    settled = true;
                }
                at.push(part);
                if std::fs::symlink_metadata(&at).is_ok_and(|entry| entry.file_type().is_symlink())
                {
                    let refused = Refusal::Link {
                        link: at.clone(),
                        reached: std::fs::canonicalize(&at),
                        own: true,
                        named: absolute.clone(),
                    };
                    at.extend(&parts[index + 1..]);
                    return (at, Some(refused));
                }
            }
            (Component::Normal(_), None) => {
                at.push(part);
                settled = false;
            }
            (Component::ParentDir, _) if at.has_root() => {}
            (part, _) => at.push(part),
        }
        index += 1;
    }
    (at, None)
}

/// Why a walk through `segment` from `at` did not come back: the first link
/// on it, or the first directory on it that does not exist. Anything else is
/// left for the open to report.
fn climb_refused(at: &Path, segment: &[Component], absolute: &Path) -> Option<Refusal> {
    let mut prefix = at.to_path_buf();
    for part in segment {
        if let Component::Normal(name) = part {
            let entry = prefix.join(name);
            let kind = Directory::open(&prefix)
                .and_then(|directory| directory.entry_kind(Path::new(name)));
            match kind {
                Ok(FileType::Symlink) => {
                    return Some(Refusal::Link {
                        link: entry,
                        reached: std::fs::canonicalize(absolute),
                        own: false,
                        named: absolute.to_path_buf(),
                    });
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    return Some(Refusal::Missing(CoreError::Invalid(format!(
                        "{} climbs back out of {}, which does not exist, so nothing was created or followed; name the folder without that `..`",
                        absolute.display(),
                        entry.display()
                    ))));
                }
                Ok(_) => {}
                Err(_) => return None,
            }
        }
        prefix.push(part);
    }
    None
}

/// The no-follow open refuses a link with the system's own error, such as
/// `Not a directory` on macOS, which names neither the link nor the
/// directory to name instead.
fn through_link(link: &Path, reached: Option<&Path>, own: bool) -> CoreError {
    let instead = match (reached, own) {
        (Some(target), true) => format!("the directory it points to, {}", target.display()),
        (Some(target), false) => format!("the directory the path reaches, {}", target.display()),
        (None, true) => "the directory itself".into(),
        (None, false) => "the folder by a path without it".into(),
    };
    CoreError::Invalid(format!(
        "{} is a symbolic link, and a folder is never opened through one; name {instead}",
        link.display()
    ))
}

/// The listed folder whose own directory entry, reached through any links
/// above it, is now the symbolic link at `link`. Found by the link's
/// identity, so that no spelling of either path is missed.
fn replaced(link: &Path, listed: &[Registered]) -> Option<Registered> {
    let found = link_identity(link)?;
    listed
        .iter()
        .find(|entry| link_identity(&resolved(&entry.dir)) == Some(found))
        .cloned()
}

/// Whether a listed folder's path reaches `target` only through a symbolic
/// link.
fn reached_through_link(target: &Path, listed: &[Registered]) -> bool {
    Directory::open(target).is_ok_and(|target| {
        listed
            .iter()
            .any(|entry| leads_to(&entry.dir, &target) && !stands_at(&entry.dir, &target))
    })
}

/// The identity of the symbolic link at `path`, reached without following
/// any link above it.
fn link_identity(path: &Path) -> Option<(u64, u64)> {
    let (parent, name) = (path.parent()?, path.file_name()?);
    Directory::open(parent)
        .and_then(|parent| parent.link_identity(Path::new(name)))
        .ok()
}

/// `path` as it reads, each `..` taking off the name before it.
fn as_written(path: &Path) -> PathBuf {
    let mut written = PathBuf::new();
    for part in path.components() {
        match part {
            Component::ParentDir => {
                written.pop();
            }
            Component::CurDir => {}
            part => written.push(part),
        }
    }
    written
}

/// Whether `one` and `other`, opened without following links, are one
/// directory.
fn same_directory(one: &Path, other: &Path) -> bool {
    match (Directory::open(one), Directory::open(other)) {
        (Ok(one), Ok(other)) => one.same(&other).unwrap_or(false),
        _ => false,
    }
}

/// Whether walking `climbed` from `at` without following links comes back
/// to the directory `at` names.
fn returns(at: &Path, climbed: &Path) -> bool {
    let (Ok(left), Ok(back)) = (Directory::open(at), Directory::open(&at.join(climbed))) else {
        return false;
    };
    left.same(&back).unwrap_or(false)
}

/// Resolves the longest prefix that exists and keeps the components that do
/// not exist yet, since a folder being added need not exist.
fn existing_prefix_resolved(path: &Path) -> PathBuf {
    for base in path.ancestors() {
        if let Ok(mut found) = std::fs::canonicalize(base) {
            if let Ok(missing) = path.strip_prefix(base)
                && !missing.as_os_str().is_empty()
            {
                found.push(missing);
            }
            return found;
        }
    }
    path.to_path_buf()
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

    /// Adds the folder at `dir` as a folder add does, with its directory open.
    fn add(registry: &Registry, dir: &Path, folder: &str, store: Option<&str>) -> Result<()> {
        registry.add(dir, &Directory::open(dir).unwrap(), folder, store)
    }

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
        let parent_spelling = resolved(&outer.join("child/.."));
        let registry = Registry::at(temp.path().join(FILE_NAME));
        add(&registry, &parent_spelling, "outer", None).unwrap();
        assert!(add(&registry, &inner, "inner", None).is_err());
        registry.unregister(&parent_spelling, None).unwrap();
        add(&registry, &inner, "inner", None).unwrap();
        assert!(add(&registry, &parent_spelling, "outer", None).is_err());
    }

    #[test]
    fn a_folder_holding_a_listed_folder_or_inside_one_is_refused_however_either_is_spelled() {
        let temp = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let base = temp.path();
        let registry = Registry::at(base.join(FILE_NAME));
        let listed = folder_at(&base.join("a"), "notes");
        std::fs::create_dir(listed.join("inner")).unwrap();
        std::fs::create_dir(base.join("x")).unwrap();
        let apart = folder_at(base, "apart");
        // A spelling through `..` reaches the listed directory on any volume
        // without either path being a prefix of the other.
        let spelled = base.join("x/../a/notes");
        registry.register(&spelled, "f1", Some("s1")).unwrap();
        let refused = |dir: &Path| {
            matches!(
                add(&registry, dir, "f2", Some("s2")),
                Err(CoreError::Invalid(message)) if message.contains("would hold one another's files")
            )
        };

        assert!(refused(&base.join("a")), "a folder holding the listed one");
        assert!(
            refused(&listed.join("inner")),
            "a folder inside the listed one"
        );
        // The witness: a directory beside it holds nothing listed.
        add(&registry, &apart, "f3", Some("s3")).unwrap();
        let dirs: Vec<PathBuf> = registry
            .folders()
            .unwrap()
            .into_iter()
            .map(|entry| entry.dir)
            .collect();
        assert_eq!(dirs, vec![spelled, apart]);
    }

    #[test]
    fn a_folder_holding_a_listed_folder_is_refused_when_spelled_in_another_case() {
        let temp = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let base = temp.path();
        let registry = Registry::at(base.join(FILE_NAME));
        let listed = folder_at(&base.join("a"), "notes");
        std::fs::create_dir(listed.join("inner")).unwrap();
        registry.register(&listed, "f1", Some("s1")).unwrap();

        for folded in [base.join("A"), base.join("a/NOTES/inner")] {
            // On a case-sensitive volume the spelling is another directory,
            // which holds nothing listed and lies inside nothing listed.
            let insensitive = folded.exists();
            if !insensitive {
                std::fs::create_dir_all(&folded).unwrap();
            }
            let added = add(&registry, &folded, "f2", Some("s2"));
            let nested = matches!(
                &added,
                Err(CoreError::Invalid(message)) if message.contains("would hold one another's files")
            );
            assert_eq!(nested, insensitive, "{}: {added:?}", folded.display());
            if !insensitive {
                added.unwrap();
            }
        }
    }

    #[test]
    fn a_folder_added_at_a_listed_directory_by_another_spelling_takes_its_place() {
        let temp = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let base = temp.path();
        let registry = Registry::at(base.join(FILE_NAME));
        let listed = folder_at(&base.join("a"), "notes");
        std::fs::create_dir(base.join("x")).unwrap();
        registry
            .register(&base.join("x/../a/notes"), "f1", Some("s1"))
            .unwrap();

        add(&registry, &listed, "f2", Some("s2")).unwrap();
        assert_eq!(
            registry.folders().unwrap(),
            vec![Registered {
                dir: listed,
                folder: "f2".into(),
                store: Some("s2".into()),
            }]
        );
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
    fn a_link_after_the_last_parent_component_is_resolved_and_one_climbed_out_of_is_not() {
        let temp = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let base = temp.path();
        let real = base.join("real");
        std::fs::create_dir_all(real.join("notes")).unwrap();
        std::fs::create_dir(real.join("child")).unwrap();
        std::fs::create_dir(base.join("elsewhere")).unwrap();
        std::os::unix::fs::symlink(&real, base.join("link")).unwrap();

        let after = base.join("elsewhere/../link/notes");
        assert_eq!(resolved(&after), real.join("notes"));
        assert!(Directory::open(&resolved(&after)).is_ok());
        assert_eq!(
            resolved(&base.join("elsewhere/../link/child/../notes")),
            real.join("notes")
        );
        assert_eq!(
            resolved(&base.join("elsewhere/../link/fresh")),
            real.join("fresh")
        );
        assert_eq!(
            resolved(&base.join("real/../real/notes")),
            real.join("notes")
        );
        let climbed = base.join("link/../real/notes");
        assert_eq!(resolved(&climbed), climbed);
        assert!(Directory::open(&resolved(&climbed)).is_err());
    }

    #[test]
    fn a_registry_inside_a_linked_directory_is_written_where_it_resolves() {
        let temp = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let real = temp.path().join("real");
        std::fs::create_dir(&real).unwrap();
        std::os::unix::fs::symlink(&real, temp.path().join("link")).unwrap();
        let one = folder_at(temp.path(), "one");
        let registry = Registry::at(temp.path().join("link").join(FILE_NAME));
        add(&registry, &one, "f1", None).unwrap();
        assert_eq!(registry.folders().unwrap().len(), 1);
        assert!(real.join(FILE_NAME).is_file());
        std::fs::remove_file(real.join(FILE_NAME)).unwrap();
        std::os::unix::fs::symlink(temp.path().join("elsewhere.json"), real.join(FILE_NAME))
            .unwrap();
        assert!(add(&registry, &one, "f1", None).is_err());
        assert!(!temp.path().join("elsewhere.json").exists());
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
        // Its copy holds no settings, so the status is refused only after
        // the folder opened.
        assert!(!matches!(
            Folder::status_of(&named),
            Err(CoreError::Invalid(message)) if message.contains("is not a folder")
        ));
        // A removal through a link is refused, naming the listed path.
        assert!(matches!(
            Folder::remove_at(&named),
            Err(CoreError::Invalid(message))
                if message.contains(&format!("listed at {}", root.display()))
        ));
        assert!(root.join(STATE_DIR).join("core.sqlite").exists());
        assert_eq!(
            Folder::remove_at(&root).unwrap(),
            crate::folder::Removal::Deleted(root.clone())
        );
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
    fn a_folder_named_by_a_link_is_refused_naming_the_link_and_its_directory() {
        use crate::folder::Folder;
        let temp = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let root = temp.path().join("notes");
        std::fs::create_dir_all(root.join(STATE_DIR)).unwrap();
        let core = crate::Core::open(root.join(STATE_DIR).join("core.sqlite"), None).unwrap();
        super::super::settings_file::bind(&core, "01a00000-0000-7000-8000-000000000001").unwrap();
        drop(core);
        let alias = temp.path().join("alias");
        std::os::unix::fs::symlink(&root, &alias).unwrap();
        let names = |error: Option<CoreError>, instead: &str| match error {
            Some(CoreError::Invalid(message)) => {
                message.starts_with(&format!("{} is a symbolic link", alias.display()))
                    && message.ends_with(instead)
            }
            _ => false,
        };
        let target = format!("points to, {}", root.display());

        assert_eq!(Folder::open(&root, None).unwrap().root(), root);
        assert!(names(Folder::open(&alias, None).err(), &target));
        assert!(names(Folder::status_of(&alias).err(), &target));
        assert!(names(Folder::remove_at(&alias).err(), &target));
        let server = Some(crate::Server {
            url: "http://127.0.0.1:9".into(),
            key: "fixture".into(),
        });
        let added = Folder::add(&alias, "01a00000-0000-7000-8000-000000000001", server, None);
        assert!(names(added.err(), &target));
        std::fs::remove_dir_all(&root).unwrap();
        assert!(names(
            Folder::status_of(&alias).err(),
            "the directory itself"
        ));
    }

    #[test]
    fn a_listed_folder_whose_directory_became_a_link_is_judged_where_it_was_listed() {
        let temp = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let base = temp.path();
        let registry = Registry::at(base.join(FILE_NAME));
        let first = folder_at(&base.join("a"), "notes");
        registry.register(&first, "f1", Some("s1")).unwrap();
        let listed = |dir: &Path, folder: &str, store: &str| Registered {
            dir: dir.to_path_buf(),
            folder: folder.into(),
            store: Some(store.into()),
        };

        std::fs::rename(base.join("a"), base.join("a-moved")).unwrap();
        std::fs::create_dir_all(base.join("plain/notes")).unwrap();
        std::os::unix::fs::symlink(base.join("plain"), base.join("a")).unwrap();
        assert_eq!(
            registry.folders().unwrap(),
            vec![listed(&first, "f1", "s1")]
        );

        let second = folder_at(&base.join("b"), "notes");
        registry.register(&second, "f2", Some("s2")).unwrap();
        std::fs::remove_file(base.join("a")).unwrap();
        std::os::unix::fs::symlink(base.join("b"), base.join("a")).unwrap();
        assert_eq!(
            registry.folders().unwrap(),
            vec![listed(&first, "f1", "s1"), listed(&second, "f2", "s2")]
        );
    }

    #[test]
    fn a_path_climbing_out_of_a_missing_directory_is_refused_before_anything_is_made() {
        use crate::folder::Folder;
        let temp = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let base = temp.path();
        let real = base.join("real");
        std::fs::create_dir_all(real.join("notes")).unwrap();
        std::os::unix::fs::symlink(&real, base.join("link")).unwrap();
        let named = base.join("missing/../link/notes");
        let missing = format!(
            "climbs back out of {}, which does not exist",
            base.join("missing").display()
        );
        let refused = |error: Option<CoreError>| matches!(error, Some(CoreError::Invalid(message)) if message.contains(&missing));
        let server = Some(crate::Server {
            url: "http://127.0.0.1:9".into(),
            key: "fixture".into(),
        });

        assert!(refused(
            Folder::add(&named, "01a00000-0000-7000-8000-000000000001", server, None).err()
        ));
        assert!(!base.join("missing").exists());
        assert!(refused(Folder::open(&named, None).err()));
        assert!(refused(Folder::status_of(&named).err()));
        assert!(refused(Folder::remove_at(&named).err()));
        assert!(!base.join("missing").exists());
        assert_eq!(resolved(&named), named);
    }

    #[test]
    fn a_refused_link_on_the_named_path_is_named_in_the_refusal() {
        use crate::folder::Folder;
        let temp = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let base = temp.path();
        let real = base.join("real");
        let root = real.join("notes");
        std::fs::create_dir_all(root.join(STATE_DIR)).unwrap();
        let core = crate::Core::open(root.join(STATE_DIR).join("core.sqlite"), None).unwrap();
        super::super::settings_file::bind(&core, "01a00000-0000-7000-8000-000000000001").unwrap();
        drop(core);
        std::fs::create_dir(base.join("elsewhere")).unwrap();
        std::os::unix::fs::symlink(&real, base.join("link")).unwrap();
        std::os::unix::fs::symlink(base.join("elsewhere"), root.join("inside")).unwrap();
        let server = || {
            Some(crate::Server {
                url: "http://127.0.0.1:9".into(),
                key: "fixture".into(),
            })
        };

        // The directory the path reaches is offered only where the path,
        // read without following the link, names the same directory.
        for (named, link, instead) in [
            (
                base.join("link/../real/notes"),
                base.join("link"),
                format!("the directory the path reaches, {}", root.display()),
            ),
            (
                root.join("inside/.."),
                root.join("inside"),
                "the folder by a path without it".to_string(),
            ),
        ] {
            let names = |error: Option<CoreError>| match error {
                Some(CoreError::Invalid(message)) => {
                    message.starts_with(&format!("{} is a symbolic link", link.display()))
                        && message.ends_with(&instead)
                }
                _ => false,
            };
            assert!(
                names(Folder::open(&named, None).err()),
                "{}",
                named.display()
            );
            assert!(names(Folder::status_of(&named).err()));
            assert!(names(Folder::remove_at(&named).err()));
            assert!(names(
                Folder::add(
                    &named,
                    "01a00000-0000-7000-8000-000000000001",
                    server(),
                    None
                )
                .err()
            ));
        }
        assert!(root.join(STATE_DIR).join("core.sqlite").exists());
        assert!(Folder::open(&root, None).is_ok());
    }

    fn bound_folder(dir: &Path, folder: &str) {
        std::fs::create_dir_all(dir.join(STATE_DIR)).unwrap();
        let core = crate::Core::open(dir.join(STATE_DIR).join("core.sqlite"), None).unwrap();
        super::super::settings_file::bind(&core, folder).unwrap();
    }

    #[test]
    fn a_listed_folder_whose_directory_became_a_link_to_another_folder_is_only_unlisted() {
        use crate::folder::Folder;
        let temp = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let base = temp.path();
        let (first, second) = (base.join("a/notes"), base.join("b/notes"));
        bound_folder(&first, "01a00000-0000-7000-8000-000000000001");
        bound_folder(&second, "01a00000-0000-7000-8000-000000000002");
        drop(Folder::open(&first, None).unwrap());
        drop(Folder::open(&second, None).unwrap());
        std::fs::rename(base.join("a"), base.join("a-moved")).unwrap();
        std::os::unix::fs::symlink(base.join("b"), base.join("a")).unwrap();
        let store = |dir: &Path| dir.join(STATE_DIR).join("core.sqlite");
        let listed = || -> Vec<PathBuf> {
            Registry::located()
                .unwrap()
                .folders()
                .unwrap()
                .into_iter()
                .map(|entry| entry.dir)
                .collect()
        };

        assert!(Folder::open(&first, None).is_err());
        assert!(Folder::status_of(&first).is_err());
        assert!(matches!(
            Folder::remove_at(&first).unwrap(),
            crate::folder::Removal::Unlisted { dir, reason }
                if dir == first && reason == format!("{} is now a symbolic link", base.join("a").display())
        ));
        assert!(
            store(&second).exists(),
            "the other folder's store was removed"
        );
        assert!(store(&base.join("a-moved/notes")).exists());
        assert!(listed().contains(&second));
        assert!(!listed().contains(&first));
    }

    #[test]
    fn a_listed_folder_whose_own_directory_became_a_link_to_another_names_both_folders() {
        use crate::folder::Folder;
        let temp = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let base = temp.path();
        let (first, second) = (base.join("a/notes"), base.join("b/notes"));
        bound_folder(&first, "01a00000-0000-7000-8000-000000000001");
        bound_folder(&second, "01a00000-0000-7000-8000-000000000002");
        drop(Folder::open(&first, None).unwrap());
        drop(Folder::open(&second, None).unwrap());
        std::fs::rename(&first, base.join("a/notes-moved")).unwrap();
        std::os::unix::fs::symlink(&second, &first).unwrap();
        std::fs::create_dir(base.join("x")).unwrap();
        let alias = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        std::os::unix::fs::symlink(base, alias.path().join("base")).unwrap();
        let names_both = |error: Option<CoreError>| match error {
            Some(CoreError::Invalid(message)) => {
                message.contains(&format!(
                    "{} now leads to {}, another listed folder",
                    first.display(),
                    second.display()
                )) && message.contains(&format!("`folders remove {}`", first.display()))
                    && !message.contains("name the directory")
            }
            _ => false,
        };
        let server = || {
            Some(crate::Server {
                url: "http://127.0.0.1:9".into(),
                key: "fixture".into(),
            })
        };

        let mut spellings = vec![
            first.clone(),
            alias.path().join("base/a/notes"),
            base.join("a/notes/../notes"),
            base.join("a/notes/../../a/notes"),
            base.join("a/notes/inner/.."),
            base.join("x/../a/notes"),
        ];
        // Only a volume that folds letter case reaches the link by these.
        spellings.extend(
            [
                base.join("a/NOTES"),
                base.join("A/NOTES"),
                base.join("A/notes"),
            ]
            .into_iter()
            .filter(|folded| folded.exists()),
        );
        for spelling in &spellings {
            let said = spelling.display();
            assert!(names_both(Folder::open(spelling, None).err()), "{said}");
            assert!(names_both(Folder::status_of(spelling).err()), "{said}");
            assert!(
                names_both(
                    Folder::add(
                        spelling,
                        "01a00000-0000-7000-8000-000000000001",
                        server(),
                        None
                    )
                    .err()
                ),
                "{said}"
            );
            if *spelling != first {
                assert!(names_both(Folder::remove_at(spelling).err()), "{said}");
            }
            assert!(
                second.join(STATE_DIR).join("core.sqlite").exists(),
                "{said}"
            );
        }

        // A listed path whose directory above is now a link to a directory
        // where a link to the other folder stands: every path to that link
        // names the listing.
        let fourth = base.join("d/notes");
        bound_folder(&fourth, "01a00000-0000-7000-8000-000000000004");
        drop(Folder::open(&fourth, None).unwrap());
        std::fs::rename(base.join("d"), base.join("d-moved")).unwrap();
        std::fs::create_dir(base.join("e")).unwrap();
        std::os::unix::fs::symlink(&second, base.join("e/notes")).unwrap();
        std::os::unix::fs::symlink(base.join("e"), base.join("d")).unwrap();
        let mut reaching = vec![fourth.clone(), base.join("e/notes")];
        reaching.extend(
            [base.join("D/notes"), base.join("e/NOTES")]
                .into_iter()
                .filter(|folded| folded.exists()),
        );
        for spelling in &reaching {
            assert!(
                matches!(
                    Folder::status_of(spelling).err(),
                    Some(CoreError::Invalid(message))
                        if message.contains(&format!("`folders remove {}`", fourth.display()))
                            && !message.contains("name the directory")
                ),
                "{}",
                spelling.display()
            );
        }

        // A climb out of a link whose path reads as one directory and reaches
        // another is never told to name the one it reaches.
        std::fs::create_dir_all(base.join("c")).unwrap();
        std::fs::create_dir(second.join("sub")).unwrap();
        std::os::unix::fs::symlink(second.join("sub"), base.join("c/l")).unwrap();
        let climbed = base.join("c/l/..");
        assert!(matches!(
            Folder::status_of(&climbed).err(),
            Some(CoreError::Invalid(message))
                if message.ends_with("name the folder by a path without it")
        ));

        // The witness: a link to a folder that no relinked listing reaches is
        // refused naming the directory it points to.
        let third = base.join("g/notes");
        bound_folder(&third, "01a00000-0000-7000-8000-000000000007");
        drop(Folder::open(&third, None).unwrap());
        let unlisted = base.join("unlisted");
        std::os::unix::fs::symlink(&third, &unlisted).unwrap();
        assert!(matches!(
            Folder::status_of(&unlisted).err(),
            Some(CoreError::Invalid(message))
                if message.ends_with(&format!("name the directory it points to, {}", third.display()))
        ));
        assert!(matches!(
            Folder::remove_at(&first).unwrap(),
            crate::folder::Removal::Unlisted { .. }
        ));
        assert!(second.join(STATE_DIR).join("core.sqlite").exists());
    }

    #[test]
    fn a_link_to_a_relinked_listing_is_never_told_to_name_where_the_listing_now_leads() {
        use crate::folder::Folder;
        let temp = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let base = temp.path();
        let folders = [("a", 1), ("b", 2), ("d", 4), ("e", 5), ("c", 3)].map(|(name, n)| {
            let dir = base.join(name).join("notes");
            bound_folder(&dir, &format!("01a00000-0000-7000-8000-00000000010{n}"));
            drop(Folder::open(&dir, None).unwrap());
            dir
        });
        let [first, second, fourth, fifth, third] = &folders;
        let stores = || {
            folders
                .iter()
                .all(|dir| dir.join(STATE_DIR).join("core.sqlite").exists())
        };
        // Links the person made to listed folders, then the listings relinked:
        // the first folder's own directory to the second folder, and the
        // directory above the fourth folder to the one holding the fifth.
        std::os::unix::fs::symlink(first, base.join("alias")).unwrap();
        std::os::unix::fs::symlink(base.join("alias"), base.join("chain")).unwrap();
        std::os::unix::fs::symlink(fourth, base.join("ln")).unwrap();
        std::fs::rename(first, base.join("a/notes-moved")).unwrap();
        std::os::unix::fs::symlink(second, first).unwrap();
        std::fs::rename(base.join("d"), base.join("d-moved")).unwrap();
        std::os::unix::fs::symlink(base.join("e"), base.join("d")).unwrap();
        let server = || {
            Some(crate::Server {
                url: "http://127.0.0.1:9".into(),
                key: "fixture".into(),
            })
        };
        let withheld = |error: Option<CoreError>| match error {
            Some(CoreError::Invalid(message)) => {
                message.ends_with("name the directory itself")
                    && !message.contains(&second.display().to_string())
                    && !message.contains(&fifth.display().to_string())
            }
            _ => false,
        };

        for name in ["alias", "chain", "ln"] {
            let link = base.join(name);
            assert!(withheld(Folder::open(&link, None).err()), "{name}");
            assert!(withheld(Folder::status_of(&link).err()), "{name}");
            assert!(withheld(Folder::remove_at(&link).err()), "{name}");
            assert!(withheld(
                Folder::add(
                    &link,
                    "01a00000-0000-7000-8000-000000000101",
                    server(),
                    None
                )
                .err()
            ));
            assert!(stores(), "{name}");
        }

        // The witness: a link to a folder that no relinked listing reaches is
        // refused naming the directory it points to.
        std::os::unix::fs::symlink(third, base.join("to-third")).unwrap();
        assert!(matches!(
            Folder::status_of(base.join("to-third")).err(),
            Some(CoreError::Invalid(message))
                if message.ends_with(&format!("name the directory it points to, {}", third.display()))
        ));
    }

    #[test]
    fn no_other_spelling_of_a_relinked_listed_folder_removes_the_folder_its_link_leads_to() {
        use crate::folder::Folder;
        let temp = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let base = temp.path();
        let (first, second) = (base.join("a/notes"), base.join("b/notes"));
        bound_folder(&first, "01a00000-0000-7000-8000-000000000001");
        bound_folder(&second, "01a00000-0000-7000-8000-000000000002");
        drop(Folder::open(&first, None).unwrap());
        drop(Folder::open(&second, None).unwrap());
        std::fs::rename(base.join("a"), base.join("a-moved")).unwrap();
        std::os::unix::fs::symlink(base.join("b"), base.join("a")).unwrap();
        let alias = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        std::os::unix::fs::symlink(base, alias.path().join("base")).unwrap();
        let registry = Registry::located().unwrap();
        let listed = || -> Vec<PathBuf> {
            registry
                .folders()
                .unwrap()
                .into_iter()
                .map(|entry| entry.dir)
                .collect()
        };
        let intact = |spelling: &Path| {
            assert!(
                second.join(STATE_DIR).join("core.sqlite").exists(),
                "{} removed the folder its link leads to",
                spelling.display()
            );
        };

        // None is told to name a directory, which would be the other folder's.
        let redirects = |error: Option<CoreError>| match error {
            Some(CoreError::Invalid(message)) => message.contains("name the directory"),
            _ => true,
        };
        for spelling in [
            alias.path().join("base/a/notes"),
            base.join("A/notes"),
            base.join("a/NOTES"),
            base.join("b/../a/notes"),
            base.join("a/../a/notes"),
        ] {
            let said = spelling.display();
            assert!(!redirects(Folder::open(&spelling, None).err()), "{said}");
            assert!(!redirects(Folder::status_of(&spelling).err()), "{said}");
            assert!(!redirects(Folder::remove_at(&spelling).err()), "{said}");
            intact(&spelling);
            assert!(listed().contains(&first) && listed().contains(&second));
        }

        let kept = std::fs::read(registry.path()).unwrap();
        std::fs::remove_file(registry.path()).unwrap();
        assert!(Folder::remove_at(&first).is_err());
        intact(&first);
        std::fs::write(registry.path(), kept).unwrap();

        Folder::remove_at(&first).unwrap();
        intact(&first);
        assert!(listed().contains(&second));
        assert!(!listed().contains(&first));
        assert!(Folder::remove_at(alias.path().join("base/b/notes")).is_err());
        intact(&second);
        assert_eq!(
            Folder::remove_at(&second).unwrap(),
            crate::folder::Removal::Deleted(second.clone())
        );
        assert!(!second.join(STATE_DIR).join("core.sqlite").exists());
    }

    #[test]
    fn a_relinked_listed_path_never_removes_the_folder_it_leads_to_however_often_or_unlisted() {
        use crate::folder::Folder;
        let temp = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let base = temp.path();
        let (first, second) = (base.join("a/notes"), base.join("b/notes"));
        bound_folder(&first, "01a00000-0000-7000-8000-000000000001");
        bound_folder(&second, "01a00000-0000-7000-8000-000000000002");
        drop(Folder::open(&first, None).unwrap());
        drop(Folder::open(&second, None).unwrap());
        std::fs::rename(base.join("a"), base.join("a-moved")).unwrap();
        std::os::unix::fs::symlink(base.join("b"), base.join("a")).unwrap();
        let store = second.join(STATE_DIR).join("core.sqlite");
        let registry = Registry::located().unwrap();

        assert!(
            Folder::remove_at(&first).is_ok(),
            "the listed path is taken off the list"
        );
        assert!(
            Folder::remove_at(&first).is_err(),
            "a second removal followed the link"
        );
        assert!(store.exists());

        // A pass through the path once the registry is lost lists the folder
        // the path leads to, as a scan does.
        std::fs::remove_file(registry.path()).unwrap();
        Folder::open(&first, None).unwrap().register();
        assert!(
            registry
                .folders()
                .unwrap()
                .iter()
                .any(|entry| entry.dir == second)
        );
        assert!(
            Folder::remove_at(&first).is_err(),
            "a removal followed the link once the registry was lost"
        );
        assert!(store.exists());
    }

    #[test]
    fn removing_a_moved_folder_takes_every_entry_for_its_store_off_the_list() {
        use crate::folder::Folder;
        let temp = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let base = temp.path();
        let first = base.join("a/notes");
        bound_folder(&first, "01a00000-0000-7000-8000-000000000001");
        drop(Folder::open(&first, None).unwrap());
        std::fs::create_dir(base.join("c")).unwrap();
        let moved = base.join("c/notes");
        std::fs::rename(&first, &moved).unwrap();

        Folder::remove_at(&moved).unwrap();
        assert!(!moved.join(STATE_DIR).join("core.sqlite").exists());
        let listed = Registry::located().unwrap().folders().unwrap();
        assert!(
            !listed
                .iter()
                .any(|entry| entry.dir == first || entry.dir == moved),
            "{listed:?}"
        );
    }

    #[test]
    fn a_folder_moved_into_a_listed_folders_place_is_never_removed_in_its_stead() {
        use crate::folder::Folder;
        let temp = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let base = temp.path();
        let (first, second) = (base.join("a/notes"), base.join("b/notes"));
        bound_folder(&first, "01a00000-0000-7000-8000-000000000001");
        bound_folder(&second, "01a00000-0000-7000-8000-000000000002");
        drop(Folder::open(&first, None).unwrap());
        drop(Folder::open(&second, None).unwrap());
        std::fs::rename(base.join("a"), base.join("a-moved")).unwrap();
        std::fs::create_dir(base.join("a")).unwrap();
        std::fs::rename(&second, &first).unwrap();
        let registry = Registry::located().unwrap();

        assert!(matches!(
            Folder::remove_at(&first).unwrap(),
            crate::folder::Removal::Unlisted { dir, reason }
                if dir == first && reason.contains("not the one the registry lists")
                    && reason.ends_with(&format!("it is the state of the folder listed at {}", second.display()))
        ));
        assert!(
            first.join(STATE_DIR).join("core.sqlite").exists(),
            "the folder moved into the listed folder's place was removed"
        );

        // State the registry lists for no folder is said to be unlisted.
        let (fourth, fifth) = (base.join("d/notes"), base.join("e/notes"));
        bound_folder(&fourth, "01a00000-0000-7000-8000-000000000004");
        bound_folder(&fifth, "01a00000-0000-7000-8000-000000000005");
        drop(Folder::open(&fourth, None).unwrap());
        drop(Folder::open(&fifth, None).unwrap());
        assert!(Folder::forget(&fifth).unwrap());
        std::fs::rename(base.join("d"), base.join("d-moved")).unwrap();
        std::fs::create_dir(base.join("d")).unwrap();
        std::fs::rename(&fifth, &fourth).unwrap();
        assert!(matches!(
            Folder::remove_at(&fourth).unwrap(),
            crate::folder::Removal::Unlisted { reason, .. }
                if reason.ends_with("it is the state of a folder the registry does not list")
        ));
        assert!(fourth.join(STATE_DIR).join("core.sqlite").exists());

        // State whose store id cannot be read is not said to be anyone's.
        let sixth = base.join("f/notes");
        bound_folder(&sixth, "01a00000-0000-7000-8000-000000000006");
        registry
            .register(&sixth, "01a00000-0000-7000-8000-000000000006", Some("s6"))
            .unwrap();
        assert_eq!(
            Folder::remove_at(&sixth).unwrap(),
            crate::folder::Removal::Unlisted {
                dir: sixth.clone(),
                reason: "no store id can be read from the folder state there, so it cannot be shown to be its own".into(),
            }
        );
        assert!(sixth.join(STATE_DIR).join("core.sqlite").exists());

        // An entry with no store cannot be shown to own the state there.
        let third = base.join("c/notes");
        bound_folder(&third, "01a00000-0000-7000-8000-000000000003");
        registry
            .register(&third, "01a00000-0000-7000-8000-000000000003", None)
            .unwrap();
        assert!(matches!(
            Folder::remove_at(&third).unwrap(),
            crate::folder::Removal::Unlisted { reason, .. } if reason.contains("lists no store")
        ));
        assert!(third.join(STATE_DIR).join("core.sqlite").exists());
        let listed = registry.folders().unwrap();
        assert!(!listed.iter().any(|entry| entry.dir == first));
        assert!(
            listed
                .iter()
                .any(|entry| entry.dir == second && entry.folder.ends_with('2'))
        );
    }

    #[test]
    fn a_listed_folder_whose_directory_became_a_link_to_a_plain_directory_is_unlisted() {
        use crate::folder::Folder;
        let temp = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let base = temp.path();
        let first = base.join("a/notes");
        bound_folder(&first, "01a00000-0000-7000-8000-000000000001");
        drop(Folder::open(&first, None).unwrap());
        std::fs::rename(base.join("a"), base.join("a-moved")).unwrap();
        std::fs::create_dir_all(base.join("plain/notes")).unwrap();
        std::os::unix::fs::symlink(base.join("plain"), base.join("a")).unwrap();

        Folder::remove_at(&first).unwrap();
        let registry = Registry::located().unwrap();
        assert!(
            !registry
                .folders()
                .unwrap()
                .iter()
                .any(|entry| entry.dir == first)
        );
        assert!(!base.join("plain/notes").join(STATE_DIR).exists());
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
        add(&registry, &one, "f1", None).unwrap();
        assert_eq!(registry.folders().unwrap().len(), 1);

        use std::os::unix::fs::PermissionsExt;
        let shut = Registry::at(root.path().join("shut.json"));
        std::fs::write(shut.path(), b"").unwrap();
        std::fs::set_permissions(shut.path(), std::fs::Permissions::from_mode(0o000)).unwrap();
        assert!(add(&shut, &one, "f1", None).is_err());
        std::fs::set_permissions(shut.path(), std::fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(std::fs::read(shut.path()).unwrap(), b"");
    }
}
