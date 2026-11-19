//! A quick pass that looks only at what events named.
//!
//! A watch hears which paths changed. Where it can trust that, a quick pass
//! has no need to walk a folder of any size to find the one file a person
//! saved: it looks at the paths the events named, and at the few files a pass
//! always judges again (a held or refused file, and a new file not yet sent).
//! Everything else stands as the last pass left it, which is what a quick pass
//! over a folder nothing touched finds in any case, and a full pass still
//! reads every file.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};

use notify::EventKind;
use notify::event::{ModifyKind, RenameMode};

use super::pull::PullReport;
use super::settings::Settings;
use super::{
    Captured, Flagged, Folder, Lists, Result, STATE_DIR, Unchanged, WalkRoute, Walked, embeds,
    identity,
    landing, lists, state, take_file,
};

/// The most paths one quick pass looks at by name. A burst of changes, a
/// checkout or a copy of a directory, is read as a walk reads it.
pub(super) const MOST_TOUCHED: usize = 256;

/// The paths the events heard since the last pass named, or that events
/// cannot be trusted to have named them all.
#[derive(Debug, Clone, Default)]
pub(super) struct Touched {
    keys: BTreeSet<String>,
    /// The watcher lost events or named something no path says, so the next
    /// pass walks the folder as it always did.
    untrusted: bool,
}

impl Touched {
    /// A watch before its first pass has heard nothing it can trust.
    pub(super) fn untrusted() -> Touched {
        Touched {
            keys: BTreeSet::new(),
            untrusted: true,
        }
    }

    /// Takes in the paths of an event a pass is to look at.
    pub(super) fn hear(&mut self, root: &Path, event: &notify::Event) {
        if event.need_rescan() || event.paths.is_empty() {
            self.distrust();
            return;
        }
        // A rename between directories is two changes a pass would have to
        // match up: the walk does that.
        if let EventKind::Modify(ModifyKind::Name(RenameMode::Both)) = event.kind
            && let [from, to] = event.paths.as_slice()
            && from.parent() != to.parent()
        {
            self.distrust();
            return;
        }
        for path in &event.paths {
            let Ok(relative) = path.strip_prefix(root) else {
                self.distrust();
                return;
            };
            if relative.as_os_str().is_empty() {
                self.distrust();
                return;
            }
            // The folder's own state is no file of the folder's.
            if relative.starts_with(STATE_DIR) {
                continue;
            }
            match identity::relative(root, path) {
                Ok(key) => {
                    self.keys.insert(key);
                }
                Err(_) => {
                    self.distrust();
                    return;
                }
            }
        }
        if self.keys.len() > MOST_TOUCHED {
            self.distrust();
        }
    }

    /// Says the paths cannot be trusted to be all that changed.
    pub(super) fn distrust(&mut self) {
        self.untrusted = true;
        self.keys.clear();
    }

    /// The paths to look at, or `None` where only a walk will do.
    pub(super) fn scope(&self) -> Option<Vec<String>> {
        (!self.untrusted).then(|| self.keys.iter().cloned().collect())
    }

    /// Forgets what a pass that ran to its end took in.
    pub(super) fn taken(&mut self) {
        self.keys.clear();
        self.untrusted = false;
    }
}

/// The most files one quick pass looks at without a walk: those the events
/// named and those it always judges again. Beyond that a walk is no dearer.
const MOST_ACTIVE: usize = 1024;

/// What a quick pass's reading of the folder rests on. A pass that finds it
/// changed walks, since the lists or the types decide which files are taken
/// and which are pushed.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct Guard {
    pub(super) settings: Settings,
    pub(super) catalog: Option<u64>,
}

/// What the last quick pass found in the folder, held for the next.
pub(super) struct Inventory {
    pub(super) guard: Guard,
    /// Every file the walk found.
    pub(super) keys: HashSet<String>,
    /// The same files, indexed for resolving embeds and telling a name a new
    /// file would share with one of them.
    pub(super) index: embeds::Files,
    /// The files the last pass read or judged, which this one judges again:
    /// every other file stood as the last read left it.
    pub(super) dirty: HashSet<String>,
    /// Files nothing sends and no embed names, which stand unread until an
    /// event names one.
    pub(super) skipped: HashSet<String>,
    pub(super) directories: Vec<Flagged>,
    pub(super) secrets: Vec<String>,
}

/// The files of a quick pass that looks at named paths alone.
pub(super) struct Plan {
    /// Taken before any file's metadata was.
    pub(super) began: std::time::SystemTime,
    pub(super) inventory: Inventory,
    pub(super) snapshot: Vec<state::Bound>,
    /// The files to look at that stand, in path order.
    pub(super) found: Vec<(PathBuf, String)>,
    pub(super) opened: HashMap<PathBuf, Captured>,
    /// Files the pass looked for that the last walk found and are gone.
    pub(super) vanished: Vec<String>,
}

/// What one named path is now.
pub(super) enum Looked {
    Gone,
    /// A file the folder does not take.
    Ignored,
    Secret,
    File(PathBuf, Captured),
}

/// Whether a pull left every file where the last pass found it, though it may
/// have changed what some hold.
pub(super) fn keeps_the_files(pull: &PullReport) -> bool {
    pull.written
        + pull.moved
        + pull.revived
        + pull.placed
        + pull.ended
        + pull.removed
        + pull.purged
        + pull.taken
        + pull.let_go
        + pull.beside
        + pull.relinked
        == 0
        && pull.root_gone.is_none()
}

impl Folder {
    /// Forgets what the last pass found, so the next walks.
    pub(super) fn forget_inventory(&self) {
        *self.inventory.lock().expect("inventory lock") = None;
    }

    pub(super) fn keep_inventory(&self, inventory: Inventory) {
        *self.inventory.lock().expect("inventory lock") = Some(inventory);
    }

    pub(super) fn guard_of(&self, settings: &Settings) -> Result<Guard> {
        let conn = self.core.conn()?;
        Ok(Guard {
            settings: settings.clone(),
            catalog: crate::store::catalog_version(&conn)?,
        })
    }

    /// The files a quick pass is to look at, taken from what the last pass
    /// found and the paths events named, or `None` where only a walk will do.
    /// The last pass's inventory is taken either way: a pass that ends well
    /// puts back what it found, and any other leaves none.
    pub(super) fn plan_scoped(
        &self,
        settings: &Settings,
        lists: &Lists,
        touched: &[String],
    ) -> Result<Option<Plan>> {
        let Some(mut inventory) = self.inventory.lock().expect("inventory lock").take() else {
            return Ok(None);
        };
        let began = std::time::SystemTime::now();
        let (kept, snapshot) = {
            let conn = self.core.conn()?;
            // A save set aside by a pull is judged by the walk that moved it.
            if !state::moved_from(&conn)?.is_empty() || !state::stale_waits(&conn)?.is_empty() {
                return Ok(None);
            }
            (
                inventory.guard
                    == Guard {
                        settings: settings.clone(),
                        catalog: crate::store::catalog_version(&conn)?,
                    },
                state::every_bound(&conn)?,
            )
        };
        if !kept {
            return Ok(None);
        }
        let mut active: BTreeSet<String> = touched.iter().cloned().collect();
        active.extend(inventory.dirty.iter().cloned());
        // What the folder judges again whatever the file's bytes say.
        active.extend(
            snapshot
                .iter()
                .filter(|row| {
                    inventory.keys.contains(&row.path)
                        && (row.held.is_some()
                            || row.holds_refusal()
                            || row.identity.is_none()
                            || state::untaken_read_version(&row.content_hash).is_some())
                })
                .map(|row| row.path.clone()),
        );
        if active.len() > MOST_ACTIVE {
            return Ok(None);
        }
        let (mut found, mut opened, mut vanished) = (Vec::new(), HashMap::new(), Vec::new());
        for key in &active {
            match self.look_at(lists, &inventory, key) {
                None => return Ok(None),
                Some(Looked::Gone) => vanished.push(key.clone()),
                Some(Looked::Ignored) => {}
                Some(Looked::Secret) => {
                    if !inventory.secrets.contains(key) {
                        return Ok(None);
                    }
                }
                Some(Looked::File(path, captured)) => {
                    opened.insert(path.clone(), captured);
                    found.push((path, key.clone()));
                }
            }
        }
        // A name a file left is free for one that took it in the same pass.
        for key in &vanished {
            inventory.keys.remove(key);
            inventory.index.remove(key);
        }
        for (_, key) in &found {
            if !inventory.keys.contains(key) {
                if inventory.index.holds_as(key) {
                    return Ok(None);
                }
                inventory.keys.insert(key.clone());
                inventory.index.insert(key);
            }
        }
        found.sort();
        Ok(Some(Plan {
            began,
            inventory,
            snapshot,
            found,
            opened,
            vanished,
        }))
    }

    /// The folder as the last quick pass left it, for a status that has no
    /// need to take the metadata of every file again: a file the scan read and
    /// no event has named since stands as it read it, and any other is looked
    /// at. `None` where only a walk will do.
    pub(super) fn inventory_walked(&self) -> Option<Walked> {
        let lists = self.settings().ok()?.lists().ok()?;
        let guard = self.inventory.lock().expect("inventory lock");
        let inventory = guard.as_ref()?;
        let mut walked = Walked::default();
        let mut identities = HashSet::new();
        {
            let last = self.last_reads.lock().expect("last reads lock");
            for key in &inventory.keys {
                let path = self.root.join(key);
                match last.get(key) {
                    Some(read) => {
                        // A file two names share is told apart by a walk alone.
                        if let Some(identity) = &read.identity
                            && !identities.insert(identity.clone())
                        {
                            return None;
                        }
                        walked.unchanged.insert(
                            path.clone(),
                            Unchanged {
                                hash: read.hash.clone(),
                                identity: read.identity.clone(),
                            },
                        );
                    }
                    None => match self.look_at(&lists, inventory, key)? {
                        Looked::File(path, captured) => {
                            walked.opened.insert(path, captured);
                        }
                        _ => return None,
                    },
                }
                walked.files.push(path);
            }
        }
        walked.files.sort();
        walked.directories = inventory.directories.clone();
        Some(walked)
    }

    /// The bytes of a file a status trusted unchanged, which it needed after
    /// all.
    pub(super) fn read_unchanged(&self, key: &str) -> Option<std::io::Result<Vec<u8>>> {
        let lists = self.settings().ok()?.lists().ok()?;
        let looked = {
            let guard = self.inventory.lock().expect("inventory lock");
            self.look_at(&lists, guard.as_ref()?, key)
        };
        match looked? {
            Looked::File(_, captured) => Some(captured.read()),
            _ => None,
        }
    }

    /// What the path `key` is now, as a walk would find it, or `None` where
    /// something about it only a walk can settle: a directory, a link on the
    /// way, a package, a file the walk could not read or would clear.
    pub(super) fn look_at(
        &self,
        lists: &Lists,
        inventory: &Inventory,
        key: &str,
    ) -> Option<Looked> {
        use crate::directory::FileType;
        let known = inventory.keys.contains(key);
        let secret = inventory.secrets.iter().any(|held| held == key);
        let relative = Path::new(key);
        let looked = match self.root_dir.entry_kind(relative) {
            Ok(kind) if kind == FileType::RegularFile => self.look_at_file(lists, known, key)?,
            Ok(kind) if kind == FileType::Directory => return None,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if known {
                    // Its directory must stand for the file to be gone.
                    self.parent_stands(relative).then_some(Looked::Gone)?
                } else if landing::left_behind(relative)
                    || !inventory
                        .keys
                        .iter()
                        .any(|held| held.starts_with(&format!("{key}/")))
                {
                    Looked::Ignored
                } else {
                    // A directory that went takes its files with it.
                    return None;
                }
            }
            // A link or another kind the walk passes over, or a path it
            // cannot read: a file it found there is lost to it, which only a
            // walk can say.
            Ok(_) | Err(_) => {
                if known {
                    return None;
                }
                Looked::Ignored
            }
        };
        // A secret that went, or stopped being one, changes what the pass says.
        (!secret || matches!(looked, Looked::Secret)).then_some(looked)
    }

    fn parent_stands(&self, relative: &Path) -> bool {
        match relative
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            Some(parent) => self
                .root_dir
                .entry_kind(parent)
                .is_ok_and(|kind| kind == crate::directory::FileType::Directory),
            None => true,
        }
    }

    /// The file at `key`, which stands, walked to through the directories the
    /// walk enters.
    fn look_at_file(&self, lists: &Lists, known: bool, key: &str) -> Option<Looked> {
        let ignored = || (!known).then_some(Looked::Ignored);
        let mut directory = self.root_dir.clone();
        let mut route = WalkRoute {
            root: directory.clone(),
            steps: Vec::new(),
        };
        let mut path = self.root.clone();
        let mut at = String::new();
        let mut parts = key.split('/').peekable();
        let mut last = "";
        while let Some(part) = parts.next() {
            if parts.peek().is_none() {
                last = part;
                break;
            }
            if !at.is_empty() {
                at.push('/');
            }
            at.push_str(part);
            path.push(part);
            if !lists.enters(&at) {
                return ignored();
            }
            let child = directory.child(Path::new(part), false).ok()?;
            if child
                .child(Path::new(STATE_DIR), false)
                .is_ok_and(|state| state.entry_identity(Path::new("core.sqlite")).is_ok())
            {
                return ignored();
            }
            if lists::is_package_at(&path, &child) {
                return None;
            }
            route = route.child(std::ffi::OsStr::new(part), &child).ok()?;
            directory = child;
        }
        let name = std::ffi::OsString::from(last);
        let dir = path.clone();
        path.push(last);
        let mut walked = Walked::default();
        take_file(
            (&self.root, &dir, &directory, &route),
            (&name, path.clone(), key.to_string()),
            lists,
            &mut walked,
        );
        if !walked.left.is_empty() || !walked.directories.is_empty() || !walked.unread.is_empty() {
            return None;
        }
        if !walked.secrets.is_empty() {
            return Some(Looked::Secret);
        }
        let Some(captured) = walked.opened.remove(&path) else {
            return ignored();
        };
        // A file another name links to shares its identity, which only a walk
        // over every name can withhold from both.
        if linked_elsewhere(&captured.metadata.borrow()) {
            return None;
        }
        Some(Looked::File(path, captured))
    }
}

#[cfg(unix)]
fn linked_elsewhere(metadata: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    metadata.nlink() > 1
}

#[cfg(not(unix))]
fn linked_elsewhere(_: &std::fs::Metadata) -> bool {
    true
}

/// How a pass finds the files to look at.
#[derive(Debug, Clone, Copy)]
pub(super) enum Reading<'a> {
    /// Walks the folder and keeps nothing for a later pass.
    Walk,
    /// Walks the folder, and keeps what it finds for a quick pass that looks
    /// at the paths events named.
    Keeping,
    /// Looks at the paths events named, where the last pass left what it found.
    Named(&'a [String]),
}

impl Touched {
    pub(super) fn reading(scope: &Option<Vec<String>>) -> Reading<'_> {
        scope.as_deref().map_or(Reading::Keeping, Reading::Named)
    }
}
