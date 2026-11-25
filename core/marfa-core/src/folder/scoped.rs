//! A quick pass that looks only at the paths the watch's events named, and at
//! the few files every pass judges again. Everything else stands as the last
//! pass left it; a full pass still reads every file.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::{Component, Path, PathBuf};

use notify::EventKind;
use notify::event::{ModifyKind, RenameMode};
use unicode_normalization::UnicodeNormalization;

use super::pull::PullReport;
use super::settings::Settings;
use super::{
    Captured, Flagged, Folder, Lists, Result, STATE_DIR, Unchanged, WalkRoute, Walked, embeds,
    identity, landing, lists, state, take_file,
};

/// The most paths one quick pass looks at by name; beyond that a walk is no dearer.
pub(super) const MOST_TOUCHED: usize = 256;

/// The paths the events heard since the last pass named.
#[derive(Debug, Clone, Default)]
pub(super) struct Touched {
    scope: Scope,
    /// The next pass walks.
    untrusted: bool,
}

/// The paths a quick pass looks at.
#[derive(Debug, Clone, Default, PartialEq)]
pub(super) struct Scope {
    pub(super) keys: BTreeSet<String>,
    /// The paths a rename event named.
    pub(super) renamed: BTreeSet<String>,
    /// The files a look at the unwatched directories found, however many.
    pub(super) beneath: BTreeSet<String>,
}

impl Touched {
    /// A watch before its first pass has heard nothing it can trust.
    pub(super) fn untrusted() -> Touched {
        Touched {
            untrusted: true,
            ..Touched::default()
        }
    }

    /// Takes in the paths of an event a pass is to look at.
    pub(super) fn hear(&mut self, root: &Path, event: &notify::Event) {
        if event.need_rescan() || event.paths.is_empty() {
            self.distrust();
            return;
        }
        // A rename between directories is two changes the walk matches up.
        if let EventKind::Modify(ModifyKind::Name(RenameMode::Both)) = event.kind
            && let [from, to] = event.paths.as_slice()
            && from.parent() != to.parent()
        {
            self.distrust();
            return;
        }
        let renaming = matches!(event.kind, EventKind::Modify(ModifyKind::Name(_)));
        for path in &event.paths {
            let Ok(relative) = path.strip_prefix(root) else {
                self.distrust();
                return;
            };
            if relative.as_os_str().is_empty()
                || !relative
                    .components()
                    .all(|part| matches!(part, Component::Normal(_)))
            {
                self.distrust();
                return;
            }
            if relative.starts_with(STATE_DIR) {
                continue;
            }
            match identity::relative(root, path) {
                Ok(key) => {
                    if renaming {
                        self.scope.renamed.insert(key.clone());
                    }
                    self.scope.keys.insert(key);
                }
                Err(_) => {
                    self.distrust();
                    return;
                }
            }
        }
        if self.scope.keys.len() > MOST_TOUCHED {
            self.distrust();
        }
    }

    /// Names files no event named; `false` where one is outside the folder.
    pub(super) fn name(&mut self, root: &Path, paths: impl IntoIterator<Item = PathBuf>) -> bool {
        for path in paths {
            let Ok(key) = identity::relative(root, &path) else {
                self.distrust();
                return false;
            };
            self.scope.beneath.insert(key);
        }
        true
    }

    /// Says the paths cannot be trusted to be all that changed.
    pub(super) fn distrust(&mut self) {
        self.untrusted = true;
        self.scope = Scope::default();
    }

    /// The paths to look at, or `None` where only a walk will do.
    pub(super) fn scope(&self) -> Option<Scope> {
        (!self.untrusted).then(|| self.scope.clone())
    }

    /// Forgets what a pass that ran to its end took in.
    pub(super) fn taken(&mut self) {
        self.scope = Scope::default();
        self.untrusted = false;
    }
}

/// The most files one quick pass looks at without a walk.
const MOST_ACTIVE: usize = 1024;

/// What a quick pass's reading of the folder rests on; a pass that finds it
/// changed walks.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct Guard {
    pub(super) settings: Settings,
    pub(super) catalog: Option<u64>,
}

pub(super) struct Inventory {
    pub(super) guard: Guard,
    /// Every file the walk found.
    pub(super) keys: HashSet<String>,
    pub(super) index: embeds::Files,
    /// The files the last pass read or judged, which this one judges again.
    pub(super) dirty: HashSet<String>,
    /// Files nothing sends and no embed names.
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
    pub(super) vanished: Vec<String>,
}

/// What one named path is now.
pub(super) enum Looked {
    Gone,
    /// A file the folder does not take.
    Ignored,
    Secret,
    File(PathBuf, Box<Captured>),
}

/// Whether a pull left every file where the last pass found it.
pub(super) fn keeps_the_files(pull: &PullReport) -> bool {
    pull.written
        + pull.moved
        + pull.revived
        + pull.placed
        + pull.ended
        + pull.removed
        + pull.purged
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

    /// The files the last pass found beneath `directories`.
    pub(super) fn kept_beneath(&self, root: &Path, directories: &[PathBuf]) -> Option<Vec<String>> {
        let directories: HashSet<String> = directories
            .iter()
            .map(|directory| identity::relative(root, directory))
            .collect::<std::result::Result<_, _>>()
            .ok()?;
        let guard = self.inventory.lock().expect("inventory lock");
        Some(beneath(&guard.as_ref()?.keys, &directories))
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

    /// The files a quick pass is to look at, or `None` where only a walk will
    /// do. The inventory is taken either way; only a pass that ends well puts
    /// one back.
    pub(super) fn plan_scoped(
        &self,
        settings: &Settings,
        lists: &Lists,
        scope: &Scope,
    ) -> Result<Option<Plan>> {
        let Some(mut inventory) = self.inventory.lock().expect("inventory lock").take() else {
            return Ok(None);
        };
        let began = std::time::SystemTime::now();
        let (snapshot, journaled, lost) = {
            let conn = self.core.conn()?;
            // A save set aside by a pull is judged by the walk that moved it.
            if !state::moved_from(&conn)?.is_empty() || !state::stale_waits(&conn)?.is_empty() {
                return Ok(None);
            }
            let kept = inventory.guard
                == Guard {
                    settings: settings.clone(),
                    catalog: crate::store::catalog_version(&conn)?,
                };
            if !kept {
                return Ok(None);
            }
            (
                state::every_bound(&conn)?,
                state::journaled(&conn)?,
                state::bound_to_lost_items(&conn)?,
            )
        };
        // Only a walk sees every file that may carry a binding instead.
        let carriers: HashSet<String> = journaled
            .iter()
            .filter_map(|row| match &row.kept {
                Some(state::Kept::Carried(carrier)) => Some(carrier.clone()),
                _ => None,
            })
            .collect();
        let (named, mut gone) = self.spelled(&inventory, scope);
        let mut active: BTreeSet<String> = named;
        active.extend(inventory.dirty.iter().cloned());
        // What the folder judges again whatever the file's bytes say, and each
        // file missing, which no event may say has returned.
        active.extend(journaled.into_iter().map(|row| row.path));
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
                .map(|row| row.path.clone())
                .chain(
                    lost.into_iter()
                        .filter(|path| inventory.keys.contains(path)),
                ),
        );
        if active.len() > MOST_ACTIVE {
            return Ok(None);
        }
        active.extend(scope.beneath.iter().cloned());
        let by_identity: HashMap<&str, &str> = snapshot
            .iter()
            .filter_map(|row| Some((row.identity.as_deref()?, row.path.as_str())))
            .collect();
        let (mut found, mut opened) = (Vec::new(), HashMap::new());
        let mut vanished = Vec::new();
        let mut looked: BTreeSet<String> = BTreeSet::new();
        let mut queue: Vec<String> = active.into_iter().collect();
        while let Some(key) = queue.pop() {
            if !looked.insert(key.clone()) {
                continue;
            }
            let looking = if gone.remove(&key) {
                Some(Looked::Gone)
            } else {
                self.look_at(lists, &inventory, &key)
            };
            match looking {
                None => return Ok(None),
                Some(Looked::Gone) => vanished.push(key),
                Some(Looked::Ignored) => {}
                Some(Looked::Secret) => {
                    if !inventory.secrets.contains(&key) {
                        return Ok(None);
                    }
                }
                Some(Looked::File(path, captured)) => {
                    // The other half of a rename an event named one half of.
                    if let Some(old) = identity::of(&captured.metadata.borrow())
                        .and_then(|found| by_identity.get(found.key().as_str()).copied())
                        && old != key
                        && inventory.keys.contains(old)
                    {
                        queue.push(old.to_string());
                    }
                    opened.insert(path.clone(), *captured);
                    found.push((path, key));
                }
            }
        }
        if found
            .iter()
            .map(|(_, key)| key)
            .chain(&vanished)
            .any(|key| carriers.contains(key))
        {
            return Ok(None);
        }
        // A file that is gone is a delete or half a rename; only one that
        // turned up elsewhere is a move this pass sees whole.
        let turned_up: HashSet<String> = opened
            .values()
            .filter_map(|captured| identity::of(&captured.metadata.borrow()))
            .map(|found| found.key())
            .collect();
        let at: HashMap<&str, &state::Bound> = snapshot
            .iter()
            .map(|row| (row.path.as_str(), row))
            .collect();
        if vanished.iter().any(|key| {
            !at.get(key.as_str())
                .and_then(|row| row.identity.as_ref())
                .is_some_and(|identity| turned_up.contains(identity))
        }) {
            return Ok(None);
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

    /// The paths events named as their directories spell them, which an event
    /// may spell in another Unicode form or case, and those gone under the
    /// name an event gave. Only a new path or a renamed one can differ, so no
    /// other costs a read of its directory.
    fn spelled(&self, inventory: &Inventory, scope: &Scope) -> (BTreeSet<String>, HashSet<String>) {
        let mut named = BTreeSet::new();
        let mut gone = HashSet::new();
        let mut listings: HashMap<String, Option<Vec<String>>> = HashMap::new();
        for key in &scope.keys {
            let known = inventory.keys.contains(key);
            if known && !scope.renamed.contains(key) {
                named.insert(key.clone());
                continue;
            }
            let mut spelt = String::new();
            let mut exact = true;
            let mut parts = key.split('/').peekable();
            while let Some(part) = parts.next() {
                let names = listings
                    .entry(spelt.clone())
                    .or_insert_with(|| self.names_in(&spelt));
                let Some(names) = names else {
                    // Where it cannot be listed, the look at the path says.
                    spelt = key.clone();
                    break;
                };
                if !spelt.is_empty() {
                    spelt.push('/');
                }
                match names.iter().find(|held| held.as_str() == part) {
                    Some(_) => spelt.push_str(part),
                    None => {
                        exact = false;
                        match names.iter().find(|held| same_name(held, part)) {
                            Some(held) if !known => spelt.push_str(held),
                            _ => {
                                spelt.push_str(part);
                                for rest in parts.by_ref() {
                                    spelt.push('/');
                                    spelt.push_str(rest);
                                }
                                break;
                            }
                        }
                    }
                }
            }
            if known && !exact {
                gone.insert(key.clone());
            }
            named.insert(spelt);
        }
        (named, gone)
    }

    /// The names in the directory at `relative`, where it can be listed.
    fn names_in(&self, relative: &str) -> Option<Vec<String>> {
        let directory = if relative.is_empty() {
            self.root_dir.clone()
        } else {
            self.root_dir.child(Path::new(relative), false).ok()?
        };
        let names = directory.entries().ok()?;
        Some(
            names
                .into_iter()
                .map(|name| name.to_string_lossy().into_owned())
                .collect(),
        )
    }

    /// The folder as the last quick pass left it, for a status that takes the
    /// metadata of no file the scan read and no event has named since. `None`
    /// where only a walk will do.
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
                            walked.opened.insert(path, *captured);
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

    /// The bytes of a file a status trusted unchanged.
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
    /// only a walk can settle it.
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
            Ok(FileType::RegularFile) => self.look_at_file(lists, known, key)?,
            Ok(FileType::Directory) => return None,
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
            // A link or another kind the walk passes over: a file it found
            // there is lost to it, which only a walk can say.
            Ok(_) => {
                if known {
                    return None;
                }
                Looked::Ignored
            }
            // A path this cannot place, such as one with `..` in it.
            Err(_) => return None,
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

    /// The file at `key`, which stands, reached through the directories the
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
        Some(Looked::File(path, Box::new(captured)))
    }
}

/// The `keys` beneath any of `directories`, by each key's ancestors.
fn beneath(keys: &HashSet<String>, directories: &HashSet<String>) -> Vec<String> {
    keys.iter()
        .filter(|key| {
            key.match_indices('/')
                .any(|(at, _)| directories.contains(&key[..at]))
        })
        .cloned()
        .collect()
}

/// Whether two spellings are one name to a volume that ignores case or Unicode
/// form.
fn same_name(one: &str, other: &str) -> bool {
    let fold = |name: &str| name.nfc().collect::<String>().to_lowercase();
    fold(one) == fold(other)
}

#[cfg(unix)]
pub(super) fn linked_elsewhere(metadata: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    metadata.nlink() > 1
}

#[cfg(not(unix))]
pub(super) fn linked_elsewhere(_: &std::fs::Metadata) -> bool {
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
    Named(&'a Scope),
}

impl Touched {
    pub(super) fn reading(scope: &Option<Scope>) -> Reading<'_> {
        scope.as_ref().map_or(Reading::Keeping, Reading::Named)
    }
}

#[cfg(test)]
mod name_tests {
    use super::*;

    #[test]
    fn the_keys_beneath_a_directory_are_those_it_is_an_ancestor_of() {
        let keys: HashSet<String> = [
            "a.md",
            "sub/b.md",
            "sub/deep/c.md",
            "sub2/d.md",
            "other/sub/e.md",
        ]
        .map(String::from)
        .into();
        let found = |directories: &[&str]| {
            let mut found = beneath(
                &keys,
                &directories.iter().map(|name| name.to_string()).collect(),
            );
            found.sort();
            found
        };
        assert_eq!(found(&["sub"]), ["sub/b.md", "sub/deep/c.md"]);
        assert_eq!(found(&["sub/deep", "sub2"]), ["sub/deep/c.md", "sub2/d.md"]);
        assert!(
            found(&["su"]).is_empty(),
            "a name that only begins as a directory's does"
        );
        assert!(found(&["a.md"]).is_empty(), "a file is no directory");
    }

    #[test]
    fn named_paths_join_the_scope_however_many_unless_one_is_outside() {
        let root = Path::new("/folder");
        let under = |count: usize| (0..count).map(|at| root.join(format!("d/n{at}.md")));

        let mut touched = Touched::default();
        assert!(touched.name(root, under(3)));
        let scope = touched.scope().expect("trusted");
        assert_eq!(scope.beneath.len(), 3);
        assert!(scope.beneath.contains("d/n0.md"));
        assert!(scope.keys.is_empty(), "no event named them");

        let mut many = Touched::default();
        assert!(many.name(root, under(MOST_TOUCHED * 8)));
        assert_eq!(
            many.scope().expect("trusted").beneath.len(),
            MOST_TOUCHED * 8
        );

        let mut outside = Touched::default();
        assert!(!outside.name(root, [PathBuf::from("/elsewhere/a.md")]));
        assert!(
            outside.scope().is_none(),
            "a path outside the folder leaves the pass to walk"
        );
    }
}
