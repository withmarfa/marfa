//! What a watch listens to: which events can matter to a pass, and, where the
//! platform watches one directory at a time, which directories it is asked to
//! watch.

use std::collections::{BTreeSet, HashSet};
use std::path::{Path, PathBuf};

use notify::event::{ModifyKind, RenameMode};
use notify::{EventKind, RecursiveMode, Watcher, WatcherKind};

use super::lists::Lists;
use super::scoped::Touched;
use super::{SETTINGS_FILE, STATE_DIR, StorageCause};

/// The most directories `Reach` remembers of each kind, so a stream of new
/// directory names cannot grow it without end.
const REMEMBERED: usize = 4096;

/// A thing that watches directories one by one.
pub(super) trait Directories {
    fn watch(&mut self, directory: &Path) -> notify::Result<()>;
    fn unwatch(&mut self, directory: &Path) -> notify::Result<()>;
}

impl<W: Watcher> Directories for W {
    fn watch(&mut self, directory: &Path) -> notify::Result<()> {
        #[cfg(debug_assertions)]
        if refused_by_fault(directory) {
            return Err(notify::Error::generic("no watches left"));
        }
        Watcher::watch(self, directory, RecursiveMode::NonRecursive)
    }

    fn unwatch(&mut self, directory: &Path) -> notify::Result<()> {
        Watcher::unwatch(self, directory)
    }
}

/// Whether a fixture has the registration of `directory` refused: the file the
/// fault names lists, one to a line, names that end the path of a directory it
/// refuses with every directory below it, and refuses none once the file is
/// gone.
#[cfg(debug_assertions)]
fn refused_by_fault(directory: &Path) -> bool {
    crate::fault::named("watch-refuse")
        .and_then(|file| std::fs::read_to_string(file).ok())
        .is_some_and(|names| {
            names
                .lines()
                .any(|name| !name.is_empty() && directory.ancestors().any(|up| up.ends_with(name)))
        })
}

/// Whether a fixture has the watch register directories one by one on every
/// platform, so that `watch-refuse` has a registration to refuse.
fn by_directory_forced() -> bool {
    cfg!(debug_assertions) && crate::fault::named("watch-refuse").is_some()
}

/// The folder's rules, and the directories they were found to leave out. An
/// event inside one is dropped from its path alone, with no read of the disk.
pub(super) struct Reach {
    lists: Option<Lists>,
    /// Directories, as paths inside the folder, that a scan does not enter.
    ignored: HashSet<String>,
    /// Directories a scan enters.
    entered: HashSet<String>,
}

impl Reach {
    pub(super) fn new(lists: Option<Lists>) -> Reach {
        Reach {
            lists,
            ignored: HashSet::new(),
            entered: HashSet::new(),
        }
    }

    /// Takes the rules a new read of the settings gave. Returns whether they
    /// differ from the ones held, in which case what was learned of them is
    /// forgotten.
    pub(super) fn replace(&mut self, lists: Option<Lists>) -> bool {
        let same = match (&self.lists, &lists) {
            (Some(held), Some(new)) => held.same_rules(new),
            (held, new) => held.is_none() && new.is_none(),
        };
        self.lists = lists;
        if !same {
            self.ignored.clear();
            self.entered.clear();
        }
        !same
    }

    /// Whether a scan enters the directory at `relative`, a path inside the
    /// folder.
    fn enters(&self, relative: &str) -> bool {
        match &self.lists {
            Some(lists) => lists.enters(relative),
            None => !relative
                .rsplit('/')
                .next()
                .unwrap_or(relative)
                .starts_with('.'),
        }
    }

    /// Whether an event starts no pass: it names only paths no pass can find,
    /// or is an access. An event that says events were lost, or names no
    /// path, is never passed over. A path where `stands` holds is one that
    /// counts as found by no pass.
    pub(super) fn passes_over(
        &mut self,
        event: &notify::Event,
        root: &Path,
        stands: impl Fn(&Path) -> bool,
    ) -> bool {
        if event.need_rescan() || event.paths.is_empty() {
            return false;
        }
        let Reach {
            lists,
            ignored,
            entered,
        } = self;
        matches!(event.kind, EventKind::Access(_))
            || event.paths.iter().all(|path| {
                !settings_file(root, path)
                    && (match lists {
                        Some(lists) => {
                            inside_ignored(lists, (ignored, entered), root, path)
                                || unreached(lists, root, path)
                        }
                        None => dot_led(root, path),
                    } || stands(path))
            })
    }
}

/// Whether `path` lies inside a directory the scan does not enter, found from
/// the names alone. What a scan would never read cannot start a pass, a
/// secret's name included.
fn inside_ignored(
    lists: &Lists,
    (ignored, entered): (&mut HashSet<String>, &mut HashSet<String>),
    root: &Path,
    path: &Path,
) -> bool {
    let Some(relative) = path.strip_prefix(root).ok().and_then(Path::to_str) else {
        return false;
    };
    let mut end = 0;
    while let Some(at) = relative[end..].find('/') {
        end += at;
        let directory = &relative[..end];
        if ignored.contains(directory) {
            return true;
        }
        if !entered.contains(directory) {
            if !lists.enters(directory) {
                if ignored.len() >= REMEMBERED {
                    ignored.clear();
                }
                ignored.insert(directory.to_owned());
                return true;
            }
            if entered.len() >= REMEMBERED {
                entered.clear();
            }
            entered.insert(directory.to_owned());
        }
        end += 1;
    }
    false
}

pub(super) fn settings_file(root: &Path, path: &Path) -> bool {
    path == root.join(STATE_DIR).join(SETTINGS_FILE)
}

/// Whether no pass can find anything at `path`, which an event names: it is
/// a directory the walk does not enter, or a file the folder does not take,
/// or it is gone and was neither. A directory is reached unless a line
/// excludes it by itself, since `include` may match the files inside it by
/// name. A path outside the folder's root or the root itself is never
/// unreached.
fn unreached(lists: &Lists, root: &Path, path: &Path) -> bool {
    let Some(relative) = path
        .strip_prefix(root)
        .ok()
        .and_then(|relative| relative.to_str())
        .filter(|relative| !relative.is_empty())
    else {
        return false;
    };
    if lists.secret(relative) {
        return false;
    }
    match std::fs::symlink_metadata(path) {
        Ok(found) if found.is_dir() => !lists.enters(relative),
        Ok(_) => !lists.takes(relative),
        Err(_) => !lists.enters(relative) && !lists.takes(relative),
    }
}

fn dot_led(root: &Path, path: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(root) else {
        return false;
    };
    relative
        .components()
        .any(|part| part.as_os_str().to_string_lossy().starts_with('.'))
}

/// A watch of a directory and the directories below it, as the platform
/// offers: one watch of the whole tree where it can only watch a tree whole,
/// and where it watches a directory at a time, one for each directory a scan
/// enters and none below one it leaves out.
pub(super) struct Listening<W> {
    watcher: W,
    pub(super) reach: Reach,
    tree: Option<Tree>,
    /// Whether the watch is of a place where another machine's change fires
    /// no event, so no event can be taken to name all that changed.
    remote: bool,
}

impl<W: Watcher> Listening<W> {
    /// Starts the watch of `root`. The first failure to watch the root is an
    /// error; a directory below it that cannot be watched is returned.
    pub(super) fn start(
        mut watcher: W,
        root: &Path,
        reach: Reach,
    ) -> Result<(Listening<W>, Vec<notify::Error>), notify::Error> {
        if W::kind() == WatcherKind::Inotify || by_directory_forced() {
            return Listening::by_directory(watcher, root, reach);
        }
        watcher.watch(root, RecursiveMode::Recursive)?;
        Ok((
            Listening {
                watcher,
                reach,
                tree: None,
                remote: false,
            },
            Vec::new(),
        ))
    }
}

impl<W: Directories> Listening<W> {
    /// Starts a watch that watches `root` and each directory below it a scan
    /// enters, one by one.
    pub(super) fn by_directory(
        mut watcher: W,
        root: &Path,
        reach: Reach,
    ) -> Result<(Listening<W>, Vec<notify::Error>), notify::Error> {
        let mut tree = Tree::new(root.to_path_buf());
        let failures = tree.open(&mut watcher, &reach)?;
        Ok((
            Listening {
                watcher,
                reach,
                tree: Some(tree),
                remote: false,
            },
            failures,
        ))
    }

    /// Notes where the folder is stored. On a network file system every
    /// registration succeeds, yet a change another machine makes fires no
    /// event, so the watch is then never trusted to name what changed.
    pub(super) fn stored(&mut self, cause: Option<&StorageCause>) {
        self.remote = matches!(cause, Some(StorageCause::NetworkFileSystem(_)));
    }

    /// Takes the rules a new read of the settings gave. Returns whether they
    /// changed, and the directories that a change left unwatchable.
    pub(super) fn reload(&mut self, lists: Option<Lists>) -> (bool, Vec<notify::Error>) {
        let changed = self.reach.replace(lists);
        let failures = match &mut self.tree {
            Some(tree) if changed => tree.sync(&mut self.watcher, &self.reach),
            _ => Vec::new(),
        };
        (changed, failures)
    }

    /// Follows the directories an event shows come and go.
    pub(super) fn follow(&mut self, event: &notify::Event) -> Vec<notify::Error> {
        match &mut self.tree {
            Some(tree) => tree.follow(&mut self.watcher, &self.reach, event),
            None => Vec::new(),
        }
    }

    /// Watches the folder again where its directory went away and is back,
    /// which a watch by directory dropped when it left. `None` where the watch
    /// stands, or the directory is still away; otherwise the directories that
    /// could not be watched. Events from before are lost, so a pass that
    /// follows walks.
    pub(super) fn restore(&mut self) -> Option<Vec<notify::Error>> {
        let tree = self.tree.as_mut()?;
        tree.reopen(&mut self.watcher, &self.reach)
    }

    /// The directories that could not be watched, and are not now. No event
    /// names a change in one, or in any directory below it.
    pub(super) fn unwatched(&self) -> Vec<PathBuf> {
        self.tree
            .as_ref()
            .map(|tree| tree.unwatched.iter().cloned().collect())
            .unwrap_or_default()
    }

    /// The files on disk in `directories` and below them, where a scan enters them.
    pub(super) fn files_beneath(&self, root: &Path, directories: &[PathBuf]) -> BTreeSet<PathBuf> {
        let mut found = BTreeSet::new();
        let mut pending = directories.to_vec();
        while let Some(directory) = pending.pop() {
            let Ok(entries) = std::fs::read_dir(&directory) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                    let enters = path
                        .strip_prefix(root)
                        .ok()
                        .and_then(Path::to_str)
                        .is_some_and(|relative| self.reach.enters(relative));
                    if enters {
                        pending.push(path);
                    }
                } else {
                    found.insert(path);
                }
            }
        }
        found
    }

    /// Readies the watch for a pass. A directory that could not be watched is
    /// tried again. While the folder is on a network file system, or the
    /// directory has only now come back, no event names what changed, so the
    /// pass walks. Returns the directories that could not be watched and were
    /// not told of before, or `None` where there are none.
    pub(super) fn ready(&mut self, touched: &mut Touched) -> Option<Vec<notify::Error>> {
        let mut failures = Vec::new();
        if let Some(tree) = &mut self.tree {
            failures = tree.retry(&mut self.watcher, &self.reach);
        }
        let restored = self.restore();
        if self.remote || restored.is_some() {
            touched.distrust();
        }
        match restored {
            Some(mut restored) => {
                restored.extend(failures);
                Some(restored)
            }
            None => (!failures.is_empty()).then_some(failures),
        }
    }
}

/// The directories watched one by one.
struct Tree {
    root: PathBuf,
    held: BTreeSet<PathBuf>,
    /// Directories a scan enters that the platform would not watch, until one
    /// is watched or no longer wanted.
    unwatched: BTreeSet<PathBuf>,
}

impl Tree {
    fn new(root: PathBuf) -> Tree {
        Tree {
            root,
            held: BTreeSet::new(),
            unwatched: BTreeSet::new(),
        }
    }

    /// Watches the root, which must work, then every directory below it a
    /// scan enters.
    fn open(
        &mut self,
        watcher: &mut impl Directories,
        reach: &Reach,
    ) -> Result<Vec<notify::Error>, notify::Error> {
        watcher.watch(&self.root)?;
        self.held.insert(self.root.clone());
        Ok(self.sync(watcher, reach))
    }

    /// Opens the watch again where the root was dropped and is a directory.
    fn reopen(
        &mut self,
        watcher: &mut impl Directories,
        reach: &Reach,
    ) -> Option<Vec<notify::Error>> {
        if self.held.contains(&self.root) || !is_directory(&self.root) {
            return None;
        }
        Some(
            self.open(watcher, reach)
                .unwrap_or_else(|error| vec![error]),
        )
    }

    /// Watches the directories a scan enters, and the state directory, which
    /// holds the settings file, and no others.
    fn sync(&mut self, watcher: &mut impl Directories, reach: &Reach) -> Vec<notify::Error> {
        let mut wanted: BTreeSet<PathBuf> = entered_under(&self.root, &self.root, reach)
            .into_iter()
            .collect();
        let state = self.state();
        if is_directory(&state) {
            wanted.insert(state);
        }
        let stale: Vec<PathBuf> = self
            .held
            .iter()
            .filter(|held| !wanted.contains(*held))
            .cloned()
            .collect();
        for directory in stale {
            self.held.remove(&directory);
            let _ = watcher.unwatch(&directory);
        }
        self.unwatched
            .retain(|directory| wanted.contains(directory));
        self.add(watcher, wanted, false)
    }

    /// Tries again to watch the directories that could not be, without saying
    /// again that they could not, and watches what a scan enters below each one
    /// that now is, which was out of sight while it was not. Returns the
    /// directories found below that could not be watched. The first refusal for
    /// want of watches ends the round with the rest still unwatched.
    fn retry(&mut self, watcher: &mut impl Directories, reach: &Reach) -> Vec<notify::Error> {
        let mut failures = Vec::new();
        let mut pending = std::mem::take(&mut self.unwatched).into_iter();
        while let Some(directory) = pending.next() {
            if self.held.contains(&directory) || self.unwatched.contains(&directory) {
                continue;
            }
            let mut out = self
                .add(watcher, BTreeSet::from([directory.clone()]), true)
                .iter()
                .any(out_of_watches);
            if !out && self.held.contains(&directory) {
                let below = entered_under(&self.root, &directory, reach)
                    .into_iter()
                    .collect();
                let found = self.add(watcher, below, true);
                out = found.iter().any(out_of_watches);
                failures.extend(found);
            }
            if out {
                self.unwatched
                    .extend(pending.filter(|left| !self.held.contains(left)));
                break;
            }
        }
        failures
    }

    /// The state directory. A scan never enters it, but an edit of the
    /// settings file in it must be heard.
    fn state(&self) -> PathBuf {
        self.root.join(STATE_DIR)
    }

    /// Watches each of `wanted` not yet watched, a parent before its
    /// children. With `stopping`, the first refusal for want of watches leaves
    /// the rest of `wanted` unwatched without asking for them.
    fn add(
        &mut self,
        watcher: &mut impl Directories,
        wanted: BTreeSet<PathBuf>,
        stopping: bool,
    ) -> Vec<notify::Error> {
        let mut failures = Vec::new();
        let mut wanted = wanted.into_iter();
        while let Some(directory) = wanted.next() {
            if self.held.contains(&directory) {
                continue;
            }
            match watcher.watch(&directory) {
                Ok(()) => {
                    self.unwatched.remove(&directory);
                    self.held.insert(directory);
                }
                // It went between the walk and the watch.
                Err(error) if matches!(error.kind, notify::ErrorKind::PathNotFound) => {
                    self.unwatched.remove(&directory);
                }
                Err(error) => {
                    self.unwatched.insert(directory);
                    let out = out_of_watches(&error);
                    failures.push(error);
                    if stopping && out {
                        self.unwatched
                            .extend(wanted.filter(|left| !self.held.contains(left)));
                        break;
                    }
                }
            }
        }
        failures
    }

    fn follow(
        &mut self,
        watcher: &mut impl Directories,
        reach: &Reach,
        event: &notify::Event,
    ) -> Vec<notify::Error> {
        let mut failures = Vec::new();
        match event.kind {
            EventKind::Create(_) | EventKind::Modify(ModifyKind::Name(RenameMode::To)) => {
                for path in &event.paths {
                    failures.extend(self.arrived(watcher, reach, path));
                }
            }
            EventKind::Remove(_) | EventKind::Modify(ModifyKind::Name(RenameMode::From)) => {
                for path in &event.paths {
                    self.left(watcher, path);
                }
            }
            EventKind::Modify(ModifyKind::Name(RenameMode::Both)) => {
                if let [from, to] = event.paths.as_slice() {
                    self.left(watcher, from);
                    failures.extend(self.arrived(watcher, reach, to));
                }
            }
            _ => {}
        }
        failures
    }

    /// Watches the directory at `path`, and the ones below it a scan enters,
    /// where it is one inside a directory watched; the state directory alone,
    /// when that is the one. A link is not followed, as a scan does not.
    fn arrived(
        &mut self,
        watcher: &mut impl Directories,
        reach: &Reach,
        path: &Path,
    ) -> Vec<notify::Error> {
        let inside_watched = path
            .parent()
            .is_some_and(|parent| self.held.contains(parent));
        let enters = path
            .strip_prefix(&self.root)
            .ok()
            .and_then(Path::to_str)
            .is_some_and(|relative| reach.enters(relative));
        if self.held.contains(path) || !inside_watched || !is_directory(path) {
            return Vec::new();
        }
        let wanted = if path == self.state() {
            BTreeSet::from([path.to_path_buf()])
        } else if enters {
            entered_under(&self.root, path, reach).into_iter().collect()
        } else {
            return Vec::new();
        };
        self.add(watcher, wanted, false)
    }

    /// Stops watching `path` and everything below it.
    fn left(&mut self, watcher: &mut impl Directories, path: &Path) {
        let gone: Vec<PathBuf> = self
            .held
            .range(path.to_path_buf()..)
            .take_while(|held| held.starts_with(path))
            .cloned()
            .collect();
        for directory in gone {
            self.held.remove(&directory);
            let _ = watcher.unwatch(&directory);
        }
        self.unwatched
            .retain(|directory| !directory.starts_with(path));
    }
}

fn out_of_watches(error: &notify::Error) -> bool {
    matches!(error.kind, notify::ErrorKind::MaxFilesWatch)
}

fn is_directory(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|found| found.is_dir())
}

/// `from` and the directories below it that a scan enters, found without
/// following a link.
fn entered_under(root: &Path, from: &Path, reach: &Reach) -> Vec<PathBuf> {
    let mut found = vec![from.to_path_buf()];
    let mut pending = vec![from.to_path_buf()];
    while let Some(directory) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.flatten() {
            if !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                continue;
            }
            let path = entry.path();
            let enters = path
                .strip_prefix(root)
                .ok()
                .and_then(Path::to_str)
                .is_some_and(|relative| reach.enters(relative));
            if enters {
                found.push(path.clone());
                pending.push(path);
            }
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;
    fn over(event: &notify::Event, root: &Path, lists: Option<Lists>) -> bool {
        Reach::new(lists).passes_over(event, root, |_| false)
    }

    fn record_lists() -> Lists {
        let lines = |names: &[&str]| {
            names
                .iter()
                .map(|name| name.to_string())
                .collect::<Vec<_>>()
        };
        Lists::new(
            &lines(&["/Notes/", "/Agents/"]),
            &lines(&["/Repos/", "/Sandbox/"]),
        )
        .unwrap()
    }

    #[test]
    fn an_event_under_an_ignored_or_unlisted_folder_reaches_nothing() {
        let (lists, root) = (record_lists(), Path::new("/folder"));
        let reached = |relative: &str| !unreached(&lists, root, &root.join(relative));
        // The witness: what the folder takes, and the folders on the way to
        // it, are reached.
        assert!(reached("Notes/a.md"));
        assert!(reached("Agents/Sessions/001 One.md"));
        assert!(reached("Notes"));
        assert!(reached("Notes/Sub"));
        for relative in [
            "Repos",
            "Repos/marfa/target/debug/build.o",
            "Sandbox/Xcode Builds/App/Info.plist",
            ".marfa/core.sqlite-wal",
        ] {
            assert!(!reached(relative), "{relative}");
        }
    }

    #[test]
    fn a_path_that_is_gone_is_reached_unless_both_lists_exclude_it() {
        // None of these exist: a gone path may have been a directory or a
        // file, so it is passed over only when no pass could have found it
        // as either.
        let (lists, root) = (record_lists(), Path::new("/folder"));
        let reached = |relative: &str| !unreached(&lists, root, &root.join(relative));
        for relative in ["_tmp/clone/file.rs", "README.md"] {
            assert!(reached(relative), "{relative}");
        }
        for relative in ["Repos/marfa/gone.rs", "Sandbox/gone.txt"] {
            assert!(!reached(relative), "{relative}");
        }
    }

    #[test]
    fn an_ignored_folder_is_unreached_while_it_is_a_directory() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let lists = Lists::new(&[], &["/Repos/".to_string()]).unwrap();
        // No include list: a file called `Repos` would be taken.
        std::fs::create_dir(root.join("Repos")).unwrap();
        std::fs::write(root.join("Repos/a.rs"), "").unwrap();
        std::fs::write(root.join("notes.md"), "").unwrap();
        assert!(unreached(&lists, root, &root.join("Repos")));
        assert!(unreached(&lists, root, &root.join("Repos/a.rs")));
        assert!(!unreached(&lists, root, &root.join("notes.md")));
        assert!(!unreached(&lists, root, &root.join("Other/new.md")));
        // Gone, it may have been a file the lists take.
        std::fs::remove_dir_all(root.join("Repos")).unwrap();
        assert!(!unreached(&lists, root, &root.join("Repos")));
        std::fs::write(root.join("Repos"), "").unwrap();
        assert!(!unreached(&lists, root, &root.join("Repos")));
    }

    #[test]
    fn a_directory_moved_in_is_reached_where_include_matches_by_file_name() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let lists = Lists::new(&["*.md".to_string()], &["/Repos/".to_string()]).unwrap();
        std::fs::create_dir_all(root.join("Moved/in")).unwrap();
        std::fs::write(root.join("Moved/in/a.md"), "").unwrap();
        std::fs::write(root.join("Moved/in/b.txt"), "").unwrap();
        // One event names only the directory.
        assert!(!unreached(&lists, root, &root.join("Moved")));
        assert!(!unreached(&lists, root, &root.join("Moved/in")));
        // The witness: a file include does not match, and an ignored folder.
        assert!(unreached(&lists, root, &root.join("Moved/in/b.txt")));
        std::fs::create_dir_all(root.join("Repos/x")).unwrap();
        assert!(unreached(&lists, root, &root.join("Repos")));
        assert!(unreached(&lists, root, &root.join("Repos/x")));
        // Gone, it may have been a directory holding files the folder took.
        assert!(!unreached(&lists, root, &root.join("Gone")));
    }

    #[test]
    fn an_event_under_an_ignored_folder_reads_nothing_and_one_under_a_synced_folder_does() {
        use notify::event::CreateKind;
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let lists = Lists::new(&[], &["/Repos/".to_string()]).unwrap();
        for relative in ["Repos/app/node_modules/pkg", "Notes/pkg"] {
            std::fs::create_dir_all(root.join(relative)).unwrap();
            std::fs::write(root.join(relative).join("server.pem"), "key").unwrap();
            std::fs::write(root.join(relative).join("index.js"), "js").unwrap();
        }
        let reach = std::cell::RefCell::new(Reach::new(Some(lists)));
        let looked = std::cell::Cell::new(0);
        let passed_over = |relative: &str| {
            looked.set(0);
            let event = notify::Event::new(EventKind::Create(CreateKind::File))
                .add_path(root.join(relative));
            let passed = reach.borrow_mut().passes_over(&event, root, |_| {
                looked.set(looked.get() + 1);
                false
            });
            (passed, looked.get())
        };
        // The witness: a file the folder reads is looked at, whether or not
        // its name is one a secret has.
        assert_eq!(passed_over("Notes/pkg/index.js"), (false, 1));
        assert_eq!(passed_over("Notes/pkg/server.pem"), (false, 1));
        // The scan never enters the folder, so even a secret's name there
        // names nothing for a pass to find.
        assert_eq!(
            passed_over("Repos/app/node_modules/pkg/index.js"),
            (true, 0)
        );
        assert_eq!(
            passed_over("Repos/app/node_modules/pkg/server.pem"),
            (true, 0)
        );
    }

    #[test]
    fn an_event_that_says_events_were_lost_or_names_no_path_starts_a_pass() {
        use notify::event::{AccessKind, CreateKind, Flag};
        let root = Path::new("/folder");
        let ignored = || root.join("Repos/app/out.o");
        let create = || notify::Event::new(EventKind::Create(CreateKind::File));
        // The witness: the same event on an ignored path is passed over.
        assert!(over(
            &create().add_path(ignored()),
            root,
            Some(record_lists())
        ));
        assert!(!over(
            &create().add_path(ignored()).set_flag(Flag::Rescan),
            root,
            Some(record_lists())
        ));
        assert!(!over(&create(), root, Some(record_lists())));
        assert!(!over(
            &notify::Event::new(EventKind::Other).set_flag(Flag::Rescan),
            root,
            None
        ));
        assert!(over(
            &notify::Event::new(EventKind::Access(AccessKind::Any))
                .add_path(root.join("Notes/a.md")),
            root,
            Some(record_lists())
        ));
    }

    #[test]
    fn an_event_the_folder_cannot_place_is_reached() {
        let (lists, root) = (record_lists(), Path::new("/folder"));
        assert!(!unreached(&lists, root, root), "the root itself");
        assert!(
            !unreached(&lists, root, Path::new("/elsewhere/Notes/a.md")),
            "a path outside the root"
        );
    }

    fn lines(names: &[&str]) -> Vec<String> {
        names.iter().map(|name| name.to_string()).collect()
    }

    fn created(path: PathBuf) -> notify::Event {
        notify::Event::new(EventKind::Create(notify::event::CreateKind::File)).add_path(path)
    }

    #[test]
    fn a_path_inside_an_ignored_folder_is_dropped_from_its_name_alone() {
        // Nothing here exists on the disk, so a path judged by looking at it
        // would be reached.
        let root = Path::new("/folder");
        let mut reach = Reach::new(Some(Lists::new(&[], &lines(&["node_modules/"])).unwrap()));
        let mut judge =
            |relative: &str| reach.passes_over(&created(root.join(relative)), root, |_| false);
        assert!(judge("app/node_modules/pkg/deep/x.js"));
        assert!(judge("app/node_modules/pkg/y.js"));
        // The witness: the same names under a folder the scan enters.
        assert!(!judge("app/src/pkg/deep/x.js"));
        // A dot-led folder is one the scan does not enter either.
        assert!(judge(".git/objects/ab/cd"));
        assert!(!judge("notes/a.md"));
    }

    #[test]
    fn a_rule_that_changes_stops_dropping_what_it_dropped() {
        let root = Path::new("/folder");
        let ignoring = || Some(Lists::new(&[], &lines(&["build/"])).unwrap());
        let mut reach = Reach::new(ignoring());
        let event = created(root.join("build/out/a.o"));
        // A path under a folder that is not there is reached only where a scan
        // would take it, so the witness is the same event once the rule goes.
        assert!(reach.passes_over(&event, root, |_| false));
        assert!(!reach.replace(ignoring()));
        assert!(reach.passes_over(&event, root, |_| false));
        let kept = Some(Lists::new(&[], &lines(&["other/"])).unwrap());
        assert!(reach.replace(kept));
        assert!(!reach.passes_over(&event, root, |_| false));
        assert!(reach.replace(ignoring()));
        assert!(reach.passes_over(&event, root, |_| false));
    }

    #[test]
    fn the_settings_file_is_never_dropped_though_the_state_folder_is_ignored() {
        let root = Path::new("/folder");
        let mut reach = Reach::new(Some(Lists::new(&[], &[]).unwrap()));
        let settings = created(root.join(STATE_DIR).join(SETTINGS_FILE));
        assert!(!reach.passes_over(&settings, root, |_| false));
        assert!(
            reach.passes_over(&created(root.join(".marfa/core.sqlite-wal")), root, |_| {
                false
            })
        );
    }

    /// Watches nothing: records which directories it was asked to.
    #[derive(Default)]
    struct Recorder {
        asked: Vec<PathBuf>,
        dropped: Vec<PathBuf>,
    }

    impl Directories for Recorder {
        fn watch(&mut self, directory: &Path) -> notify::Result<()> {
            if !directory.is_dir() {
                return Err(notify::Error::path_not_found());
            }
            self.asked.push(directory.to_path_buf());
            Ok(())
        }

        fn unwatch(&mut self, directory: &Path) -> notify::Result<()> {
            self.dropped.push(directory.to_path_buf());
            Ok(())
        }
    }

    fn folder_of(names: &[&str]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for name in names {
            std::fs::create_dir_all(dir.path().join(name)).unwrap();
        }
        dir
    }

    fn reaching(ignore: &[&str]) -> Reach {
        Reach::new(Some(Lists::new(&[], &lines(ignore)).unwrap()))
    }

    fn relative(root: &Path, watched: &[PathBuf]) -> BTreeSet<String> {
        watched
            .iter()
            .map(|path| {
                path.strip_prefix(root)
                    .unwrap()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect()
    }

    fn names(names: &[&str]) -> BTreeSet<String> {
        names.iter().map(|name| name.to_string()).collect()
    }

    #[test]
    fn a_watch_by_directory_leaves_out_what_a_scan_does_not_enter() {
        let dir = folder_of(&[
            "notes/deep",
            "app/node_modules/pkg/lib",
            ".git/objects",
            ".marfa/inner",
            "app/src",
        ]);
        let root = dir.path();
        let mut recorder = Recorder::default();
        let mut tree = Tree::new(root.to_path_buf());
        let failures = tree
            .open(&mut recorder, &reaching(&["node_modules/"]))
            .unwrap();
        assert!(failures.is_empty());
        // The witness: the folders a scan walks are watched, parents first,
        // and the state directory, which holds the settings file, alone.
        assert_eq!(
            relative(root, &recorder.asked),
            names(&["", ".marfa", "app", "app/src", "notes", "notes/deep"])
        );
        assert_eq!(recorder.asked[0], root);
    }

    #[test]
    fn a_watch_by_directory_watches_the_root_again_when_it_comes_back() {
        let dir = folder_of(&["notes"]);
        let root = dir.path();
        let mut recorder = Recorder::default();
        let mut tree = Tree::new(root.to_path_buf());
        let reach = reaching(&[]);
        tree.open(&mut recorder, &reach).unwrap();
        // A watch that stands is left alone.
        assert!(tree.reopen(&mut recorder, &reach).is_none());
        let away = root.with_file_name("away");
        let moved = notify::Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::From)))
            .add_path(root.to_path_buf());
        tree.follow(&mut recorder, &reach, &moved);
        std::fs::rename(root, &away).unwrap();
        // The witness: with the directory away, nothing is watched anew.
        assert!(tree.reopen(&mut recorder, &reach).is_none());
        recorder.asked.clear();
        std::fs::rename(&away, root).unwrap();
        let failures = tree.reopen(&mut recorder, &reach).unwrap();
        assert!(failures.is_empty());
        assert_eq!(relative(root, &recorder.asked), names(&["", "notes"]));
        assert!(tree.reopen(&mut recorder, &reach).is_none());
    }

    #[test]
    fn a_watch_by_directory_does_not_follow_a_link() {
        let outside = folder_of(&["inner"]);
        let dir = folder_of(&["real/sub"]);
        std::os::unix::fs::symlink(outside.path(), dir.path().join("link")).unwrap();
        let mut recorder = Recorder::default();
        let mut tree = Tree::new(dir.path().to_path_buf());
        tree.open(&mut recorder, &reaching(&[])).unwrap();
        assert_eq!(
            relative(dir.path(), &recorder.asked),
            names(&["", "real", "real/sub"])
        );
    }

    #[test]
    fn a_directory_that_arrives_is_watched_with_what_it_holds_unless_it_is_ignored() {
        let dir = folder_of(&["notes", "scratch"]);
        let root = dir.path();
        let reach = reaching(&["node_modules/"]);
        let mut recorder = Recorder::default();
        let mut tree = Tree::new(root.to_path_buf());
        tree.open(&mut recorder, &reach).unwrap();
        recorder.asked.clear();
        // A directory moved in from an ignored folder, with its children.
        std::fs::create_dir_all(root.join("notes/moved/inner/node_modules/x")).unwrap();
        let moved = notify::Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::To)))
            .add_path(root.join("notes/moved"));
        assert!(tree.follow(&mut recorder, &reach, &moved).is_empty());
        assert_eq!(
            relative(root, &recorder.asked),
            names(&["notes/moved", "notes/moved/inner"])
        );
        // The same event again watches nothing twice.
        recorder.asked.clear();
        tree.follow(&mut recorder, &reach, &moved);
        assert!(recorder.asked.is_empty());
        // A directory made ignored by its name is not watched.
        recorder.asked.clear();
        std::fs::create_dir_all(root.join("notes/node_modules")).unwrap();
        let made = created(root.join("notes/node_modules"));
        tree.follow(&mut recorder, &reach, &made);
        assert!(recorder.asked.is_empty());
        // Nor is one made inside a folder that is not watched.
        std::fs::create_dir_all(root.join("elsewhere/new")).unwrap();
        tree.follow(&mut recorder, &reach, &created(root.join("elsewhere/new")));
        assert!(recorder.asked.is_empty());
        // A file is no directory.
        std::fs::write(root.join("notes/a.md"), "").unwrap();
        tree.follow(&mut recorder, &reach, &created(root.join("notes/a.md")));
        assert!(recorder.asked.is_empty());
    }

    #[test]
    fn a_state_directory_made_after_the_watch_began_is_watched_alone() {
        let dir = folder_of(&["notes"]);
        let root = dir.path();
        let reach = reaching(&[]);
        let mut recorder = Recorder::default();
        let mut tree = Tree::new(root.to_path_buf());
        tree.open(&mut recorder, &reach).unwrap();
        recorder.asked.clear();
        std::fs::create_dir_all(root.join(".marfa/inner")).unwrap();
        tree.follow(&mut recorder, &reach, &created(root.join(".marfa")));
        assert_eq!(relative(root, &recorder.asked), names(&[".marfa"]));
        // A rule that changes keeps it watched.
        let mut reach = reach;
        assert!(reach.replace(Some(Lists::new(&[], &lines(&["notes/"])).unwrap())));
        recorder.asked.clear();
        recorder.dropped.clear();
        tree.sync(&mut recorder, &reach);
        assert!(!recorder.dropped.contains(&root.join(".marfa")));
    }

    #[test]
    fn a_directory_that_goes_is_dropped_with_what_was_below_it() {
        let dir = folder_of(&["a/b/c", "ab"]);
        let root = dir.path();
        let reach = reaching(&[]);
        let mut recorder = Recorder::default();
        let mut tree = Tree::new(root.to_path_buf());
        tree.open(&mut recorder, &reach).unwrap();
        let removed = notify::Event::new(EventKind::Remove(notify::event::RemoveKind::Folder))
            .add_path(root.join("a"));
        tree.follow(&mut recorder, &reach, &removed);
        // Not the sibling that begins with the same letters.
        assert_eq!(
            relative(root, &recorder.dropped),
            names(&["a", "a/b", "a/b/c"])
        );
        // Moved to a new name: the old paths go and the new ones are watched.
        std::fs::rename(root.join("ab"), root.join("renamed")).unwrap();
        let renamed = notify::Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::Both)))
            .add_path(root.join("ab"))
            .add_path(root.join("renamed"));
        recorder.asked.clear();
        tree.follow(&mut recorder, &reach, &renamed);
        assert_eq!(relative(root, &recorder.asked), names(&["renamed"]));
        assert!(recorder.dropped.contains(&root.join("ab")));
    }

    #[test]
    fn a_rule_that_changes_changes_the_directories_watched() {
        let dir = folder_of(&["keep", "cache/deep", "node_modules/pkg"]);
        let root = dir.path();
        let mut recorder = Recorder::default();
        let mut tree = Tree::new(root.to_path_buf());
        let mut reach = reaching(&["node_modules/"]);
        tree.open(&mut recorder, &reach).unwrap();
        assert_eq!(
            relative(root, &recorder.asked),
            names(&["", "keep", "cache", "cache/deep"])
        );
        // `cache` becomes ignored, and `node_modules` stops being.
        assert!(reach.replace(Some(Lists::new(&[], &lines(&["cache/"])).unwrap())));
        recorder.asked.clear();
        assert!(tree.sync(&mut recorder, &reach).is_empty());
        assert_eq!(
            relative(root, &recorder.asked),
            names(&["node_modules", "node_modules/pkg"])
        );
        assert_eq!(
            relative(root, &recorder.dropped),
            names(&["cache", "cache/deep"])
        );
    }

    #[test]
    fn a_directory_that_cannot_be_watched_is_told_and_the_rest_are_watched() {
        struct Limited(Recorder);
        impl Directories for Limited {
            fn watch(&mut self, directory: &Path) -> notify::Result<()> {
                if directory.ends_with("heavy") {
                    return Err(notify::Error::new(notify::ErrorKind::MaxFilesWatch));
                }
                self.0.watch(directory)
            }

            fn unwatch(&mut self, directory: &Path) -> notify::Result<()> {
                self.0.unwatch(directory)
            }
        }
        let dir = folder_of(&["heavy", "light"]);
        let mut limited = Limited(Recorder::default());
        let mut tree = Tree::new(dir.path().to_path_buf());
        let failures = tree.open(&mut limited, &reaching(&[])).unwrap();
        assert_eq!(failures.len(), 1);
        assert_eq!(
            relative(dir.path(), &limited.0.asked),
            names(&["", "light"])
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn an_inotify_watch_hears_an_edit_of_the_settings_file() {
        use std::sync::mpsc;
        use std::time::{Duration, Instant};
        let dir = folder_of(&["notes", ".marfa"]);
        let root = dir.path().canonicalize().unwrap();
        let settings = root.join(STATE_DIR).join(SETTINGS_FILE);
        std::fs::write(&settings, "include: []\n").unwrap();
        let (sender, events) = mpsc::channel();
        let watcher = notify::recommended_watcher(move |event| {
            let _ = sender.send(event);
        })
        .unwrap();
        let (mut listening, failures) = Listening::start(watcher, &root, reaching(&[])).unwrap();
        assert!(failures.is_empty());
        let mut starts_a_pass = |wanted: &Path| {
            let deadline = Instant::now() + Duration::from_secs(5);
            while let Some(left) = deadline.checked_duration_since(Instant::now()) {
                let Ok(Ok(event)) = events.recv_timeout(left) else {
                    return false;
                };
                listening.follow(&event);
                if event.paths.iter().any(|path| path == wanted)
                    && !listening.reach.passes_over(&event, &root, |_| false)
                {
                    return true;
                }
            }
            false
        };
        std::fs::write(&settings, "include: [\"*.md\"]\n").unwrap();
        assert!(starts_a_pass(&settings));
        // The witness: the state directory's other files are heard and then
        // passed over.
        let wal = root.join(STATE_DIR).join("core.sqlite-wal");
        std::fs::write(&wal, "w").unwrap();
        assert!(!starts_a_pass(&wal));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn an_inotify_watch_hears_a_synced_folder_and_none_of_an_ignored_one() {
        use std::sync::mpsc;
        use std::time::{Duration, Instant};
        let dir = folder_of(&["notes", "node_modules/pkg"]);
        let root = dir.path().canonicalize().unwrap();
        let (sender, events) = mpsc::channel();
        let watcher = notify::recommended_watcher(move |event| {
            let _ = sender.send(event);
        })
        .unwrap();
        let (mut listening, failures) =
            Listening::start(watcher, &root, reaching(&["node_modules/"])).unwrap();
        assert!(failures.is_empty());
        // Follows each event as the watch does, until one names `wanted`.
        let mut hears = |wanted: &Path| {
            let deadline = Instant::now() + Duration::from_secs(5);
            while let Some(left) = deadline.checked_duration_since(Instant::now()) {
                let Ok(Ok(event)) = events.recv_timeout(left) else {
                    return false;
                };
                listening.follow(&event);
                if event.paths.iter().any(|path| path == wanted) {
                    return true;
                }
            }
            false
        };
        // The witness: a write in a folder a scan walks is heard.
        std::fs::write(root.join("notes/a.md"), "a").unwrap();
        assert!(hears(&root.join("notes/a.md")));
        // A folder made there is watched, and so is what is written in it.
        std::fs::create_dir(root.join("notes/new")).unwrap();
        assert!(hears(&root.join("notes/new")));
        std::fs::write(root.join("notes/new/b.md"), "b").unwrap();
        assert!(hears(&root.join("notes/new/b.md")));
        // Nothing of an ignored folder is heard: a write there, then a
        // later one the watch does hear, which would have come after it.
        std::fs::write(root.join("node_modules/pkg/x.js"), "x").unwrap();
        std::fs::write(root.join("notes/z.md"), "z").unwrap();
        assert!(!hears(&root.join("node_modules/pkg/x.js")));
    }

    /// Refuses the directories named in `refused` until they are taken out.
    struct Refusing {
        refused: BTreeSet<PathBuf>,
    }

    impl Directories for Refusing {
        fn watch(&mut self, directory: &Path) -> notify::Result<()> {
            if !directory.is_dir() {
                return Err(notify::Error::path_not_found());
            }
            if self.refused.contains(directory) {
                return Err(notify::Error::generic("no watches left"));
            }
            Ok(())
        }

        fn unwatch(&mut self, _: &Path) -> notify::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn a_directory_that_cannot_be_watched_stays_unwatched_until_it_is_or_is_gone() {
        let dir = folder_of(&["a/inner", "b", "c"]);
        let root = dir.path();
        let reach = reaching(&[]);
        let mut watcher = Refusing {
            refused: BTreeSet::from([root.join("a"), root.join("b"), root.join("c")]),
        };
        let mut tree = Tree::new(root.to_path_buf());
        // The witness: nothing is unwatched while every directory is watched.
        let mut other = Tree::new(root.to_path_buf());
        let mut everything = Refusing {
            refused: BTreeSet::new(),
        };
        assert!(other.open(&mut everything, &reach).unwrap().is_empty());
        assert!(other.unwatched.is_empty());

        let failures = tree.open(&mut watcher, &reach).unwrap();
        assert_eq!(failures.len(), 3);
        assert_eq!(tree.unwatched.len(), 3);
        // Tried again, it fails without being told again, and stays unwatched.
        tree.retry(&mut watcher, &reach);
        assert_eq!(tree.unwatched.len(), 3);
        // One is watched at last; one is removed; one is no longer entered.
        watcher.refused.remove(&root.join("a"));
        std::fs::remove_dir(root.join("b")).unwrap();
        tree.retry(&mut watcher, &reach);
        assert_eq!(tree.unwatched, BTreeSet::from([root.join("c")]));
        assert!(tree.held.contains(&root.join("a")));
        let mut reach = reach;
        assert!(reach.replace(Some(Lists::new(&[], &lines(&["c/"])).unwrap())));
        tree.sync(&mut watcher, &reach);
        assert!(tree.unwatched.is_empty());
    }

    #[test]
    fn a_directory_below_one_that_could_not_be_watched_is_watched_when_it_is() {
        let dir = folder_of(&["a", "b"]);
        let root = dir.path();
        let reach = reaching(&[]);
        let mut watcher = Refusing {
            refused: BTreeSet::from([root.join("a")]),
        };
        let mut tree = Tree::new(root.to_path_buf());
        assert_eq!(tree.open(&mut watcher, &reach).unwrap().len(), 1);
        // Made, and one moved in, while `a` was not watched: no event named
        // either, and the watch of `a` found neither.
        std::fs::create_dir_all(root.join("a/new/deep")).unwrap();
        // The witness: still refused, the retry reaches nothing below.
        assert!(tree.retry(&mut watcher, &reach).is_empty());
        assert_eq!(tree.unwatched, BTreeSet::from([root.join("a")]));
        assert!(!tree.held.contains(&root.join("a/new")));
        watcher.refused.clear();
        assert!(tree.retry(&mut watcher, &reach).is_empty());
        assert!(tree.unwatched.is_empty());
        for held in ["a", "a/new", "a/new/deep"] {
            assert!(tree.held.contains(&root.join(held)), "{held}");
        }
        // One of them refused is told, and tried again without being told.
        std::fs::create_dir(root.join("b/more")).unwrap();
        tree.held.remove(&root.join("b"));
        tree.unwatched.insert(root.join("b"));
        watcher.refused = BTreeSet::from([root.join("b/more")]);
        assert_eq!(tree.retry(&mut watcher, &reach).len(), 1);
        assert_eq!(tree.unwatched, BTreeSet::from([root.join("b/more")]));
        assert!(tree.retry(&mut watcher, &reach).is_empty());
    }

    #[test]
    fn a_retry_stops_asking_once_the_watches_are_used_up() {
        struct Counting(usize);
        impl Directories for Counting {
            fn watch(&mut self, _: &Path) -> notify::Result<()> {
                self.0 += 1;
                Err(notify::Error::new(notify::ErrorKind::MaxFilesWatch))
            }

            fn unwatch(&mut self, _: &Path) -> notify::Result<()> {
                Ok(())
            }
        }
        let dir = folder_of(&["a", "b", "c", "d"]);
        let reach = reaching(&[]);
        let mut tree = Tree::new(dir.path().to_path_buf());
        tree.unwatched = ["a", "b", "c", "d"]
            .iter()
            .map(|name| dir.path().join(name))
            .collect();
        let before = tree.unwatched.clone();
        let mut counting = Counting(0);
        tree.retry(&mut counting, &reach);
        assert_eq!(counting.0, 1);
        assert_eq!(tree.unwatched, before, "the rest are put back");
    }

    #[test]
    fn a_folder_on_a_network_file_system_is_never_trusted_to_name_what_changed() {
        let dir = folder_of(&["notes"]);
        let ready = |cause: Option<StorageCause>| {
            let (mut listening, failures) =
                Listening::by_directory(Recorder::default(), dir.path(), reaching(&[])).unwrap();
            assert!(failures.is_empty());
            listening.stored(cause.as_ref());
            let mut touched = Touched::default();
            listening.ready(&mut touched);
            touched.scope().is_none()
        };
        // The witness: every directory watched and no remote storage.
        assert!(!ready(None));
        assert!(!ready(Some(StorageCause::ICloudDrive)));
        assert!(ready(Some(StorageCause::NetworkFileSystem("nfs".into()))));
        assert!(ready(Some(StorageCause::NetworkFileSystem("smbfs".into()))));
    }

    #[test]
    fn a_directory_that_cannot_be_watched_does_not_send_every_pass_to_walk() {
        let dir = folder_of(&["notes", "refused"]);
        let ready = |refused: &[&str]| {
            let watcher = Refusing {
                refused: refused.iter().map(|name| dir.path().join(name)).collect(),
            };
            let (mut listening, failures) =
                Listening::by_directory(watcher, dir.path(), reaching(&[])).unwrap();
            assert_eq!(failures.len(), refused.len());
            let mut touched = Touched::default();
            listening.ready(&mut touched);
            (listening.unwatched().len(), touched.scope().is_none())
        };
        // The witness: a watch the system will not trust does make a pass walk.
        let (_, walks) = {
            let (mut listening, _) = Listening::by_directory(
                Refusing {
                    refused: BTreeSet::new(),
                },
                dir.path(),
                reaching(&[]),
            )
            .unwrap();
            listening.stored(Some(&StorageCause::NetworkFileSystem("nfs".into())));
            let mut touched = Touched::default();
            listening.ready(&mut touched);
            (0, touched.scope().is_none())
        };
        assert!(walks);
        assert_eq!(ready(&[]), (0, false));
        assert_eq!(ready(&["refused"]), (1, false));
    }

    #[test]
    fn the_files_beneath_the_unwatched_directories_are_named() {
        let dir = folder_of(&["a/deeper", "b", "skipped/inner"]);
        let root = dir.path();
        for file in [
            "a/one.md",
            "a/deeper/two.md",
            "b/three.md",
            "skipped/inner/four.md",
        ] {
            std::fs::write(root.join(file), "x").unwrap();
        }
        let (listening, _) = Listening::by_directory(
            Refusing {
                refused: BTreeSet::new(),
            },
            root,
            reaching(&["skipped/"]),
        )
        .unwrap();
        let named = |directories: &[&str]| {
            let directories: Vec<PathBuf> =
                directories.iter().map(|name| root.join(name)).collect();
            relative(
                root,
                &listening
                    .files_beneath(root, &directories)
                    .into_iter()
                    .collect::<Vec<_>>(),
            )
        };
        // Everything beneath a directory, none of what a scan leaves out, and
        // none of a directory that is not named.
        assert_eq!(
            named(&["a"]),
            BTreeSet::from(["a/deeper/two.md".to_string(), "a/one.md".to_string()])
        );
        assert_eq!(named(&["skipped"]), BTreeSet::new());
        assert_eq!(named(&["a", "b"]).len(), 3);
    }
}
