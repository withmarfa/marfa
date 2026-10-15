//! What a machine's folder watches are doing, kept in a file beside the
//! folder registry for any program on the machine to read.
//!
//! Every watch process owns one entry in the file, under the process's id. It
//! rewrites the whole file under a lock of its own, keeping the entries of the
//! other processes, so two watches never lose each other's entries and a
//! reader never sees half of a record.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use super::Folder;
use super::health::{Problem, Snapshot};
use super::landing::land_at;
use super::registry::{Registry, open_lock, resolved};
use super::watch::{WatchError, WatchEvent};
use crate::directory::Directory;
use crate::store;

/// The record's file name, beside the registry's `folders.json`.
pub const FILE_NAME: &str = "folder-watch.json";

const LOCK_NAME: &str = "folder-watch.lock";

/// The version of the file's shape.
const FORMAT: u32 = 1;

/// How often a running watch writes the record again, whether or not
/// anything changed, so that a reader can tell a current record from one
/// whose process has gone.
pub const HEARTBEAT: Duration = Duration::from_secs(5);

/// How long an entry nothing has written to is kept by the processes that
/// write after it. A process that crashed leaves its entry until then.
const KEPT: Duration = Duration::from_secs(3600);

/// The least wait between two writes that follow a change.
const GAP: Duration = Duration::from_millis(250);

const POLL: Duration = Duration::from_millis(100);

/// How often a folder's saved health is looked at again.
const LOOK: Duration = Duration::from_secs(1);

#[derive(Debug, Clone, Serialize, Deserialize)]
struct File {
    version: u32,
    processes: Vec<Process>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Process {
    pid: u32,
    started_at: String,
    heartbeat_at: String,
    heartbeat_interval_seconds: u64,
    /// When the process stopped its watches on purpose; `None` while it runs
    /// or if it was killed.
    ended_at: Option<String>,
    folders: Vec<Entry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Entry {
    dir: String,
    folder: String,
    watching: bool,
    /// The code of the error that keeps a listed folder from being watched;
    /// `None` while it is watched or has not been tried.
    reason: Option<String>,
    last_success_at: Option<String>,
    first_sync_waiting: bool,
    problems: Vec<Problem>,
}

/// What the watch of one folder holds.
struct Held {
    folder: String,
    watching: bool,
    reason: Option<String>,
    health: Option<Snapshot>,
}

impl Held {
    fn entry(&self, dir: &Path) -> Entry {
        Entry {
            dir: dir.to_string_lossy().into_owned(),
            folder: self.folder.clone(),
            watching: self.watching,
            reason: self.reason.clone(),
            last_success_at: self
                .health
                .as_ref()
                .and_then(|health| health.last_success_at.clone()),
            first_sync_waiting: self
                .health
                .as_ref()
                .is_some_and(|health| health.first_sync_waiting)
                || self.reason.as_deref() == Some("first_sync_waiting"),
            problems: self
                .health
                .as_ref()
                .map(|health| health.problems.clone())
                .unwrap_or_default(),
        }
    }
}

#[derive(Default)]
struct Inner {
    folders: BTreeMap<PathBuf, Held>,
    ended_at: Option<String>,
    finished: bool,
    changed: bool,
    last_write: Option<Instant>,
    warned: bool,
}

/// A watch process's entry in the machine's record of folder watches.
pub struct WatchRecord {
    path: PathBuf,
    pid: u32,
    started_at: String,
    heartbeat: Duration,
    inner: Mutex<Inner>,
}

/// A folder whose saved health can be looked at while it is watched.
pub(super) trait Observed: Sync {
    fn observed(&self) -> Option<Snapshot>;
}

impl Observed for Folder {
    fn observed(&self) -> Option<Snapshot> {
        self.observed_health()
    }
}

struct Raise<'a>(&'a AtomicBool);

impl Drop for Raise<'_> {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

impl WatchRecord {
    /// The record beside this machine's folder registry; `None` where there is
    /// none to put it beside.
    pub fn located() -> Option<WatchRecord> {
        Registry::located().map(|registry| WatchRecord::beside(&registry))
    }

    pub fn beside(registry: &Registry) -> WatchRecord {
        WatchRecord::at(
            registry.path().with_file_name(FILE_NAME),
            std::process::id(),
            HEARTBEAT,
        )
    }

    pub(super) fn at(path: PathBuf, pid: u32, heartbeat: Duration) -> WatchRecord {
        WatchRecord {
            path,
            pid,
            started_at: store::now_iso(),
            heartbeat,
            inner: Mutex::default(),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    fn inner(&self) -> MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn change(&self, dir: &Path, edit: impl FnOnce(&mut Held)) {
        let mut inner = self.inner();
        if inner.finished {
            return;
        }
        edit(
            inner
                .folders
                .entry(dir.to_path_buf())
                .or_insert_with(Held::unknown),
        );
        inner.changed = true;
    }

    /// A folder the registry lists, not yet watched.
    pub fn listed(&self, dir: &Path, folder: &str) {
        self.change(dir, |held| held.folder = folder.to_string());
    }

    /// The folder is watched.
    pub(super) fn watching(&self, dir: &Path) {
        self.change(dir, |held| {
            held.watching = true;
            held.reason = None;
        });
    }

    /// The folder is not watched, for the error `reason` names, or for none
    /// where its watch is about to start again.
    pub(super) fn unwatched(&self, dir: &Path, reason: Option<&str>) {
        self.change(dir, |held| {
            held.watching = false;
            held.reason = reason.map(str::to_string);
        });
    }

    /// The registry no longer lists the folder.
    pub(super) fn left(&self, dir: &Path) {
        let mut inner = self.inner();
        if inner.folders.remove(dir).is_some() {
            inner.changed = true;
        }
    }

    fn observed(&self, dir: &Path, health: Snapshot) {
        self.change(dir, |held| held.health = Some(health));
    }

    /// Runs `run`, the watch of the folder at `dir`, while the folder's saved
    /// health is looked at and kept in the record.
    pub(super) fn beating<O: Observed, R>(
        &self,
        dir: &Path,
        folder: &O,
        run: impl FnOnce() -> R,
    ) -> R {
        let done = AtomicBool::new(false);
        std::thread::scope(|scope| {
            scope.spawn(|| {
                let mut seen: Option<Snapshot> = None;
                while !done.load(Ordering::SeqCst) {
                    if let Some(health) = folder.observed()
                        && seen.as_ref() != Some(&health)
                    {
                        self.observed(dir, health.clone());
                        seen = Some(health);
                    }
                    let until = Instant::now() + LOOK;
                    while Instant::now() < until && !done.load(Ordering::SeqCst) {
                        std::thread::sleep(POLL);
                    }
                }
            });
            let raise = Raise(&done);
            let ran = run();
            drop(raise);
            // What the last pass saved, before the look that is waiting.
            if let Some(health) = folder.observed() {
                self.observed(dir, health);
            }
            ran
        })
    }

    /// Keeps the record of one folder's watch, as `folders watch DIR` does.
    pub fn watch_folder<E>(
        &self,
        folder: &Folder,
        stop: &AtomicBool,
        mut tell: impl FnMut(WatchEvent) -> Result<(), E>,
    ) -> Result<(), WatchError<E>> {
        let dir = folder.root();
        self.listed(dir, folder.folder_id());
        self.beating(dir, folder, || {
            folder.watch(stop, |event| {
                if matches!(event, WatchEvent::Watching { .. }) {
                    self.watching(dir);
                }
                tell(event)
            })
        })
    }

    /// Writes the record when something changed and as often as the heartbeat
    /// asks, until [`WatchRecord::finish`]. `warn` is told once, with the
    /// reason, if the record cannot be written; the writing goes on, so the
    /// record appears once it can be.
    pub fn keep(&self, warn: impl Fn(&str)) {
        loop {
            let failed = {
                let mut inner = self.inner();
                if inner.finished {
                    return;
                }
                let now = Instant::now();
                let since = inner.last_write.map(|at| now.duration_since(at));
                let due = since
                    .is_none_or(|since| since >= self.heartbeat || (inner.changed && since >= GAP));
                if due {
                    inner.changed = false;
                    inner.last_write = Some(now);
                    match self.write(&inner) {
                        Err(reason) if !inner.warned => {
                            inner.warned = true;
                            Some(reason)
                        }
                        _ => None,
                    }
                } else {
                    None
                }
            };
            if let Some(reason) = failed {
                warn(&reason);
            }
            std::thread::sleep(POLL);
        }
    }

    /// The watches are over: every folder is marked not watched, and nothing
    /// is written after. Answers at once the second time.
    pub fn finish(&self) {
        let mut inner = self.inner();
        if inner.finished {
            return;
        }
        for held in inner.folders.values_mut() {
            held.watching = false;
        }
        inner.ended_at = Some(store::now_iso());
        let _ = self.write(&inner);
        inner.finished = true;
    }

    /// Replaces this process's entry in the file, under its lock.
    fn write(&self, inner: &Inner) -> Result<(), String> {
        let mine = Process {
            pid: self.pid,
            started_at: self.started_at.clone(),
            heartbeat_at: store::now_iso(),
            heartbeat_interval_seconds: self.heartbeat.as_secs().max(1),
            ended_at: inner.ended_at.clone(),
            folders: inner
                .folders
                .iter()
                .map(|(dir, held)| held.entry(dir))
                .collect(),
        };
        let failed = |doing: &str, error: &dyn std::fmt::Display| {
            format!("cannot {doing} {}: {error}", self.path.display())
        };
        let path = resolved(&self.path);
        let parent = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        let name = Path::new(
            path.file_name()
                .ok_or_else(|| failed("write", &"it needs a file name"))?,
        );
        let directory =
            Directory::create(parent).map_err(|error| failed("make the directory of", &error))?;
        let lock =
            open_lock(&directory, Path::new(LOCK_NAME)).map_err(|error| failed("lock", &error))?;
        lock.lock().map_err(|error| failed("lock", &error))?;
        let existing = match directory.read(name) {
            Ok(bytes) => serde_json::from_slice::<File>(&bytes)
                .ok()
                .filter(|file| file.version == FORMAT),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(failed("read", &error)),
        };
        let mut processes: Vec<Process> = existing
            .map(|file| file.processes)
            .unwrap_or_default()
            .into_iter()
            .filter(|other| other.pid != self.pid && recent(other))
            .collect();
        processes.push(mine);
        let bytes = serde_json::to_vec_pretty(&File {
            version: FORMAT,
            processes,
        })
        .map_err(|error| failed("write", &error))?;
        land_at(
            &directory,
            name,
            |file, _| std::io::Write::write_all(file, &bytes),
            |_| true,
        )
        .map_err(|error| failed("write", &error))
    }
}

impl Held {
    fn unknown() -> Held {
        Held {
            folder: String::new(),
            watching: false,
            reason: None,
            health: None,
        }
    }
}

/// Whether an entry another process wrote was written lately enough to keep.
fn recent(process: &Process) -> bool {
    let Ok(at) = chrono::DateTime::parse_from_rfc3339(&process.heartbeat_at) else {
        return false;
    };
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    now.saturating_sub(at.timestamp_millis()) < KEPT.as_millis() as i64
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;

    fn read(path: &Path) -> File {
        serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
    }

    fn record(dir: &Path, pid: u32) -> WatchRecord {
        WatchRecord::at(dir.join(FILE_NAME), pid, Duration::from_millis(200))
    }

    fn only(file: &File, pid: u32) -> Process {
        file.processes
            .iter()
            .find(|process| process.pid == pid)
            .unwrap_or_else(|| panic!("no entry for process {pid}: {file:?}"))
            .clone()
    }

    #[test]
    fn it_names_each_folder_with_its_state_and_nothing_inside_the_folder() {
        let temp = tempfile::tempdir().unwrap();
        let record = record(temp.path(), 11);
        record.listed(Path::new("/notes"), "folder-1");
        record.listed(Path::new("/failing"), "folder-2");
        record.watching(Path::new("/notes"));
        record.unwatched(Path::new("/failing"), Some("unauthorized"));
        let mut health = Snapshot::succeeded("2026-01-01T00:00:00.000Z");
        health.problems = vec![Problem {
            code: super::super::health::Code::Conflict,
            count: 2,
        }];
        record.observed(Path::new("/notes"), health);
        let inner = record.inner();
        record.write(&inner).unwrap();
        drop(inner);
        let raw = std::fs::read_to_string(temp.path().join(FILE_NAME)).unwrap();
        let file = read(&temp.path().join(FILE_NAME));
        let process = only(&file, 11);
        let notes = process.folders.iter().find(|f| f.dir == "/notes").unwrap();
        assert!(notes.watching && notes.reason.is_none());
        assert_eq!(notes.folder, "folder-1");
        assert_eq!(
            notes.last_success_at.as_deref(),
            Some("2026-01-01T00:00:00.000Z")
        );
        assert_eq!(notes.problems.len(), 1);
        let failing = process
            .folders
            .iter()
            .find(|f| f.dir == "/failing")
            .unwrap();
        assert!(!failing.watching);
        assert_eq!(failing.reason.as_deref(), Some("unauthorized"));
        assert!(raw.contains("\"conflict\""), "{raw}");
        assert!(process.ended_at.is_none());
    }

    #[test]
    fn a_folder_waiting_for_its_first_sync_says_so_though_no_pass_has_run() {
        let temp = tempfile::tempdir().unwrap();
        let record = record(temp.path(), 11);
        record.listed(Path::new("/new"), "folder-1");
        record.unwatched(Path::new("/new"), Some("first_sync_waiting"));
        record.write(&record.inner()).unwrap();
        let file = read(&temp.path().join(FILE_NAME));
        assert!(only(&file, 11).folders[0].first_sync_waiting);
    }

    #[test]
    fn two_processes_keep_each_others_entries() {
        let temp = tempfile::tempdir().unwrap();
        let (first, second) = (record(temp.path(), 11), record(temp.path(), 12));
        first.listed(Path::new("/a"), "folder-a");
        second.listed(Path::new("/b"), "folder-b");
        first.write(&first.inner()).unwrap();
        second.write(&second.inner()).unwrap();
        first.watching(Path::new("/a"));
        first.write(&first.inner()).unwrap();
        let file = read(&temp.path().join(FILE_NAME));
        assert_eq!(file.processes.len(), 2, "{file:?}");
        assert!(only(&file, 11).folders[0].watching);
        assert_eq!(only(&file, 12).folders[0].dir, "/b");
    }

    #[test]
    fn processes_writing_at_once_never_lose_one_another() {
        let temp = tempfile::tempdir().unwrap();
        let records: Vec<_> = (20..26)
            .map(|pid| {
                let record = record(temp.path(), pid);
                record.listed(Path::new(&format!("/folder-{pid}")), "folder");
                Arc::new(record)
            })
            .collect();
        std::thread::scope(|scope| {
            for record in &records {
                scope.spawn(|| {
                    for _ in 0..40 {
                        record.write(&record.inner()).unwrap();
                    }
                });
            }
        });
        let file = read(&temp.path().join(FILE_NAME));
        for pid in 20..26 {
            assert_eq!(only(&file, pid).folders.len(), 1);
        }
    }

    #[test]
    fn a_reader_during_writes_always_reads_one_whole_record() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join(FILE_NAME);
        let record = record(temp.path(), 11);
        // Enough entries that a torn write would show.
        for n in 0..300 {
            record.listed(Path::new(&format!("/folder-{n}")), "folder");
        }
        record.write(&record.inner()).unwrap();
        let stop = AtomicBool::new(false);
        let (mut reads, mut versions) = (0_u32, std::collections::HashSet::new());
        std::thread::scope(|scope| {
            scope.spawn(|| {
                for n in 0..200 {
                    record.watching(Path::new(&format!("/folder-{}", n % 300)));
                    record.write(&record.inner()).unwrap();
                }
                stop.store(true, Ordering::SeqCst);
            });
            while !stop.load(Ordering::SeqCst) {
                let bytes = std::fs::read(&path).unwrap();
                let file: File = serde_json::from_slice(&bytes).unwrap_or_else(|error| {
                    panic!("a torn record ({error}) of {} bytes", bytes.len())
                });
                assert_eq!(only(&file, 11).folders.len(), 300);
                versions.insert(
                    only(&file, 11)
                        .folders
                        .iter()
                        .filter(|folder| folder.watching)
                        .count(),
                );
                reads += 1;
            }
        });
        // The witness: the reader saw the record change under it.
        assert!(
            reads > 20 && versions.len() > 3,
            "{reads} reads, {versions:?}"
        );
    }

    #[test]
    fn a_clean_stop_marks_every_folder_not_watched_and_says_when() {
        let temp = tempfile::tempdir().unwrap();
        let record = record(temp.path(), 11);
        record.listed(Path::new("/a"), "folder-a");
        record.watching(Path::new("/a"));
        record.write(&record.inner()).unwrap();
        assert!(only(&read(&temp.path().join(FILE_NAME)), 11).folders[0].watching);
        record.finish();
        let process = only(&read(&temp.path().join(FILE_NAME)), 11);
        assert!(!process.folders[0].watching);
        assert!(process.ended_at.is_some());
        // Nothing is written after the end.
        record.watching(Path::new("/a"));
        record.finish();
        assert!(!only(&read(&temp.path().join(FILE_NAME)), 11).folders[0].watching);
    }

    #[test]
    fn the_heartbeat_moves_while_nothing_changes() {
        let temp = tempfile::tempdir().unwrap();
        let record = record(temp.path(), 11);
        record.listed(Path::new("/a"), "folder-a");
        let beats = Mutex::new(Vec::new());
        std::thread::scope(|scope| {
            scope.spawn(|| record.keep(|_| {}));
            let until = Instant::now() + Duration::from_millis(1500);
            while Instant::now() < until {
                if let Ok(bytes) = std::fs::read(temp.path().join(FILE_NAME))
                    && let Ok(file) = serde_json::from_slice::<File>(&bytes)
                {
                    let beat = only(&file, 11).heartbeat_at;
                    let mut beats = beats.lock().unwrap();
                    if beats.last() != Some(&beat) {
                        beats.push(beat);
                    }
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            record.finish();
        });
        assert!(
            beats.lock().unwrap().len() >= 4,
            "{:?}",
            beats.lock().unwrap()
        );
    }

    #[test]
    fn a_record_nothing_has_written_to_for_long_is_dropped_by_the_next_writer() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join(FILE_NAME);
        let old = File {
            version: FORMAT,
            processes: vec![
                Process {
                    pid: 30,
                    started_at: "2020-01-01T00:00:00.000Z".into(),
                    heartbeat_at: "2020-01-01T00:00:00.000Z".into(),
                    heartbeat_interval_seconds: 5,
                    ended_at: None,
                    folders: Vec::new(),
                },
                Process {
                    pid: 31,
                    started_at: store::now_iso(),
                    heartbeat_at: store::now_iso(),
                    heartbeat_interval_seconds: 5,
                    ended_at: None,
                    folders: Vec::new(),
                },
                // The same process id as the writer's, so a process that
                // ended and whose id came round again.
                Process {
                    pid: 11,
                    started_at: "2020-01-01T00:00:00.000Z".into(),
                    heartbeat_at: store::now_iso(),
                    heartbeat_interval_seconds: 5,
                    ended_at: None,
                    folders: Vec::new(),
                },
            ],
        };
        std::fs::write(&path, serde_json::to_vec(&old).unwrap()).unwrap();
        let record = record(temp.path(), 11);
        record.write(&record.inner()).unwrap();
        let file = read(&path);
        let pids: Vec<u32> = file.processes.iter().map(|process| process.pid).collect();
        assert_eq!(pids, vec![31, 11]);
        assert_ne!(only(&file, 11).started_at, "2020-01-01T00:00:00.000Z");
    }

    #[test]
    fn a_file_that_is_not_a_record_is_written_afresh() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join(FILE_NAME);
        std::fs::write(&path, b"{ not json").unwrap();
        let record = record(temp.path(), 11);
        record.write(&record.inner()).unwrap();
        assert_eq!(read(&path).processes.len(), 1);
    }

    #[test]
    fn a_directory_that_cannot_be_written_warns_once_and_the_record_appears_once_it_can() {
        let temp = tempfile::tempdir().unwrap();
        // A file where the directory should be.
        let blocked = temp.path().join("status");
        std::fs::write(&blocked, b"in the way").unwrap();
        let record = WatchRecord::at(blocked.join(FILE_NAME), 11, Duration::from_millis(100));
        record.listed(Path::new("/a"), "folder-a");
        let warnings = Mutex::new(Vec::new());
        std::thread::scope(|scope| {
            scope.spawn(|| record.keep(|reason| warnings.lock().unwrap().push(reason.to_string())));
            std::thread::sleep(Duration::from_millis(800));
            assert_eq!(warnings.lock().unwrap().len(), 1, "{:?}", warnings.lock());
            std::fs::remove_file(&blocked).unwrap();
            let until = Instant::now() + Duration::from_secs(5);
            while !blocked.join(FILE_NAME).exists() {
                assert!(Instant::now() < until, "the record never appeared");
                std::thread::sleep(Duration::from_millis(20));
            }
            record.finish();
        });
        assert_eq!(warnings.lock().unwrap().len(), 1);
        assert!(warnings.lock().unwrap()[0].contains("cannot"));
    }

    #[test]
    fn a_folder_the_registry_stops_listing_leaves_the_record() {
        let temp = tempfile::tempdir().unwrap();
        let record = record(temp.path(), 11);
        record.listed(Path::new("/a"), "folder-a");
        record.listed(Path::new("/b"), "folder-b");
        record.left(Path::new("/a"));
        record.write(&record.inner()).unwrap();
        let process = only(&read(&temp.path().join(FILE_NAME)), 11);
        assert_eq!(process.folders.len(), 1);
        assert_eq!(process.folders[0].dir, "/b");
    }

    struct Scripted(Mutex<Option<Snapshot>>);

    impl Observed for Scripted {
        fn observed(&self) -> Option<Snapshot> {
            self.0.lock().unwrap().clone()
        }
    }

    #[test]
    fn a_folders_saved_health_reaches_the_record_while_it_is_watched_and_once_more_at_the_end() {
        let temp = tempfile::tempdir().unwrap();
        let record = record(temp.path(), 11);
        let dir = Path::new("/a");
        record.listed(dir, "folder-a");
        let scripted = Scripted(Mutex::new(None));
        let seen = |record: &WatchRecord| {
            record
                .inner()
                .folders
                .get(dir)
                .and_then(|held| held.health.clone())
                .and_then(|health| health.last_success_at)
        };
        record.beating(dir, &scripted, || {
            assert_eq!(seen(&record), None);
            *scripted.0.lock().unwrap() = Some(Snapshot::succeeded("2026-02-02T00:00:00.000Z"));
            let until = Instant::now() + Duration::from_secs(5);
            while seen(&record).is_none() {
                assert!(
                    Instant::now() < until,
                    "the health never reached the record"
                );
                std::thread::sleep(Duration::from_millis(20));
            }
            // Changed just before the end, inside the look's own wait.
            *scripted.0.lock().unwrap() = Some(Snapshot::succeeded("2026-03-03T00:00:00.000Z"));
        });
        assert_eq!(seen(&record).as_deref(), Some("2026-03-03T00:00:00.000Z"));
    }
}
