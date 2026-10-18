//! One watch over every folder a machine's registry lists.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::{Scope, ScopedJoinHandle};
use std::time::{Duration, Instant};

use super::registry::Registry;
use super::watch::{WatchEnd, WatchError, WatchEvent};
use super::watch_record::{Observed, WatchRecord};
use super::{Folder, STATE_DIR, StorageCause, first, handover};
use crate::directory::Directory;
use crate::error::CoreError;
use crate::{Core, store};

/// How often the registry is read again for folders added and removed.
const REREAD: Duration = Duration::from_secs(2);

/// What keeps a folder from being opened is on this machine, and costs little
/// to look at again.
const RETRY_UNOPENED: Duration = Duration::from_secs(5);

/// What ends a folder's watch is mostly the server's answer, which a try every
/// few seconds would only ask again.
const RETRY_ENDED: Duration = Duration::from_secs(60);

/// How often a folder let go to a command is tried again, so it is taken back
/// soon after the command ends.
pub const RETRY_HANDED: Duration = Duration::from_secs(1);
/// The longest wait between two looks at a folder whose directory cannot be
/// found. A volume that is away comes back at any time, but a directory
/// deleted long ago is looked at for as long as the registry lists it.
const RETRY_MISSING_MOST: Duration = Duration::from_secs(300);

/// How long a folder tried again is watched before it is said to be watched,
/// so one that fails the same way at every try is said to fail once.
const RECOVERED: Duration = Duration::from_secs(10);

const POLL: Duration = Duration::from_millis(100);

/// The code of a folder let go to a command that asked for it.
pub const HANDED_OVER: &str = "handed_over";

/// The reason the record of folder watches gives a listed folder whose
/// directory cannot be found. It is no error code: nothing failed.
pub const MISSING: &str = "missing";

/// Why a listed folder is not watched.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Unwatched {
    /// The error code, such as `first_sync_waiting`, `reading_handle` or
    /// `unauthorized`, `watch` where the watch itself failed, or [`MISSING`]
    /// where its directory cannot be found.
    pub code: String,
    pub message: String,
}

impl Unwatched {
    pub fn of(error: &CoreError) -> Unwatched {
        Unwatched {
            code: error.code().to_string(),
            message: error.to_string(),
        }
    }

    fn ended<E>(error: WatchError<E>) -> Result<Unwatched, E> {
        Ok(match error {
            WatchError::CredentialRefused(error) => Unwatched {
                code: error.code().to_string(),
                message: format!(
                    "the server refused this folder's credential ({error}), so its watch stopped; its writes wait until a working credential is kept"
                ),
            },
            WatchError::FollowEnded(error) => Unwatched {
                code: error.code().to_string(),
                message: format!("the server's changes stopped reaching this folder: {error}"),
            },
            WatchError::Unwatchable(message) => Unwatched {
                code: "watch".into(),
                message,
            },
            WatchError::Core(error) => Unwatched::of(&error),
            WatchError::Told(error) => return Err(error),
        })
    }

    /// A command asks for the folder.
    pub fn handed_over() -> Unwatched {
        Unwatched {
            code: HANDED_OVER.into(),
            message:
                "a command asked for this folder; it is watched again once that command lets it go"
                    .into(),
        }
    }

    fn fault() -> Unwatched {
        Unwatched {
            code: "watch".into(),
            message: "the watch of this folder ended in a fault".into(),
        }
    }
}

/// What a watch over every listed folder tells its caller. Each folder's own
/// events, and the start of its watch, are told on that folder's thread.
#[derive(Debug)]
pub enum Every<'a, F = Folder> {
    /// The folder at `dir` is watched. A folder tried again after it could not
    /// be watched is said to be watched once its watch has lasted, or has
    /// something else to tell.
    Watching { dir: &'a Path },
    /// One of a watched folder's own events. Its `Watching` is told as
    /// [`Every::Watching`] instead.
    Folder {
        dir: &'a Path,
        folder: &'a F,
        event: WatchEvent,
    },
    /// The folder at `dir` is watched, and its directory is in cloud-synced or
    /// network storage, for `cause`. Told at every start of its watch, before
    /// anything else of that start, even where the start is held back from
    /// [`Every::Watching`].
    Storage {
        dir: &'a Path,
        cause: &'a StorageCause,
    },
    /// The folder at `dir` is not watched, for `reason`, and is tried again.
    /// Told once for as long as the reason stays the same.
    Unwatched {
        dir: &'a Path,
        reason: &'a Unwatched,
    },
    /// A command asked for the folder at `dir`, and its watch let it go. It
    /// is tried again every second, quietly while the command holds it.
    HandedOver { dir: &'a Path },
    /// The folder at `dir`, let go to a command, is watched again. Told in
    /// place of [`Every::Watching`].
    TakenBack { dir: &'a Path },
    /// The listed folders at `dirs` are not watched because their
    /// directories cannot be found, as a deleted directory or a volume that
    /// is away. Told once the set has settled, and again only when a folder
    /// joins it; each is tried again, less often the longer it stays away,
    /// and is not told as [`Every::Unwatched`].
    Missing { dirs: &'a [PathBuf] },
    /// The registry no longer lists the folder at `dir`, and its watch ended.
    Left { dir: &'a Path },
    /// The registry lists no folder. Told once each time it comes to.
    NoFolders,
    /// The registry cannot be read, for `Some` reason, and the folders watched
    /// go on as they are; or it reads again, for `None`. Told only when it
    /// changes.
    Registry(Option<&'a str>),
    /// The record of the watches that other programs on the machine read
    /// cannot be written, for `reason`, and the watches go on without it.
    /// Told once.
    Record { path: &'a Path, reason: &'a str },
}

/// What [`watch_every`] asks of its caller.
pub trait EveryFolder: Sync {
    type Error: Send;

    /// Opens the folder at `dir` with the server and credential it follows.
    /// `origin` is the server its copy was hydrated from, where it has been.
    fn open(&self, dir: &Path, origin: Option<&str>) -> Result<Folder, Unwatched>;

    /// An error ends the watch of every folder.
    fn tell(&self, event: Every<'_>) -> Result<(), Self::Error>;

    /// The folder's watch, opened at `dir`, ended for `reason`. Called at
    /// every end, though [`Every::Unwatched`] is told only when the reason
    /// changes, so what decides the next open is kept even when nothing is
    /// said.
    fn ended(&self, dir: &Path, reason: &Unwatched);
}

/// Keeps every folder `registry` lists in step until `stop` is raised, each
/// with a watch of its own on a thread of its own. The registry is read again
/// every few seconds: a folder it comes to list is watched, and the watch of
/// one it no longer lists ends. A folder that cannot be watched is told once
/// and tried again, and the others go on. What each folder's watch is doing
/// is kept in `record`, and its watches are marked ended once this returns.
pub fn watch_every<W: EveryFolder>(
    registry: &Registry,
    stop: &AtomicBool,
    every: &W,
    record: &WatchRecord,
) -> Result<(), W::Error> {
    supervise(
        || read(registry),
        stop,
        &Machine(every),
        record,
        Timing::default(),
    )
}

fn read(registry: &Registry) -> Listing {
    match registry.read() {
        Ok(Some(listed)) => Listing::Listed(
            listed
                .into_iter()
                .map(|entry| (entry.dir, entry.folder))
                .collect(),
        ),
        Ok(None) => Listing::Absent(format!(
            "the folder registry {} is not there",
            registry.path().display()
        )),
        Err(CoreError::Store(reason)) => Listing::Unread(reason),
        Err(error) => Listing::Unread(error.to_string()),
    }
}

/// What a folder's own store says of it, read without claiming the folder, so
/// it answers beside a process that holds it.
struct Recorded {
    origin: Option<String>,
    first_sync_waiting: bool,
    /// A command waits for the folder, so the watch must not take it.
    asked: bool,
}

fn recorded(dir: &Path) -> crate::Result<Recorded> {
    let root = super::reached(dir)?;
    let root_dir = Directory::open(&root).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            CoreError::Io(format!(
                "{} cannot be found; it is watched once it is back",
                root.display()
            ))
        } else {
            super::not_a_folder(&root)
        }
    })?;
    super::admitted_root(&root_dir).map_err(super::io_error)?;
    let state_dir = root_dir
        .child(Path::new(STATE_DIR), false)
        .map_err(|_| super::not_a_folder(&root))?;
    state_dir
        .entry_identity(Path::new("core.sqlite"))
        .map_err(|_| super::not_a_folder(&root))?;
    let core = Core::read_directory(&state_dir, &root.join(STATE_DIR).join("core.sqlite"))?;
    let conn = core.conn()?;
    Ok(Recorded {
        origin: store::meta_get(&conn, store::META_SERVER_ORIGIN)?,
        first_sync_waiting: first::waiting(&conn)?,
        asked: handover::asked_at(&state_dir),
    })
}

#[derive(Clone)]
enum Listing {
    /// Each folder's directory and its `system.folder` id.
    Listed(Vec<(PathBuf, String)>),
    /// There is no registry file, with what to say of it.
    Absent(String),
    Unread(String),
}

#[derive(Clone, Copy)]
struct Timing {
    poll: Duration,
    reread: Duration,
    unopened: Duration,
    ended: Duration,
    handed: Duration,
    /// How long a folder let go may be held by a process with no request
    /// standing before it is said to be held by another process.
    held: Duration,
    recovered: Duration,
    missing_most: Duration,
}

impl Default for Timing {
    fn default() -> Timing {
        Timing {
            poll: POLL,
            reread: REREAD,
            unopened: RETRY_UNOPENED,
            ended: RETRY_ENDED,
            handed: RETRY_HANDED,
            held: handover::HANDOVER_WAIT,
            recovered: RECOVERED,
            missing_most: RETRY_MISSING_MOST,
        }
    }
}

/// A folder as the supervisor runs it, apart from how it is opened.
trait Watched: Observed {
    fn watch<E>(
        &self,
        stop: &AtomicBool,
        tell: impl FnMut(WatchEvent) -> Result<(), E>,
    ) -> Result<WatchEnd, WatchError<E>>;
}

impl Watched for Folder {
    fn watch<E>(
        &self,
        stop: &AtomicBool,
        tell: impl FnMut(WatchEvent) -> Result<(), E>,
    ) -> Result<WatchEnd, WatchError<E>> {
        Folder::watch_handing_over(self, stop, tell)
    }
}

trait Supervised: Sync {
    type Folder: Watched;
    type Error: Send;
    /// Whether the folder's directory cannot be found: the file system
    /// answers that it is not there, rather than failing to answer.
    fn missing(&self, dir: &Path) -> bool;
    fn open(&self, dir: &Path) -> Result<Self::Folder, Unwatched>;
    fn tell(&self, event: Every<'_, Self::Folder>) -> Result<(), Self::Error>;
    fn ended(&self, dir: &Path, reason: &Unwatched);
}

struct Machine<'a, W>(&'a W);

impl<W: EveryFolder> Supervised for Machine<'_, W> {
    type Folder = Folder;
    type Error = W::Error;

    fn missing(&self, dir: &Path) -> bool {
        std::fs::symlink_metadata(dir)
            .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
    }

    fn open(&self, dir: &Path) -> Result<Folder, Unwatched> {
        let recorded = recorded(dir).map_err(|error| Unwatched::of(&error))?;
        // Read without claiming the folder, so a person confirming it is
        // never refused because the watch holds it for a moment.
        if recorded.first_sync_waiting {
            return Err(Unwatched::of(&CoreError::FirstSyncWaiting));
        }
        // Taken now, it would only be let go again at once.
        if recorded.asked {
            return Err(Unwatched::handed_over());
        }
        self.0.open(dir, recorded.origin.as_deref())
    }

    fn tell(&self, event: Every<'_>) -> Result<(), W::Error> {
        self.0.tell(event)
    }

    fn ended(&self, dir: &Path, reason: &Unwatched) {
        self.0.ended(dir, reason);
    }
}

/// How the start of a folder's watch is told.
struct Start {
    /// Held back until the watch lasts or tells something else, for a folder
    /// tried again after it was said not to be watched.
    quiet: bool,
    /// Said as [`Every::TakenBack`], for a folder let go to a command.
    taken_back: bool,
    said: Said,
}

#[derive(Clone, Copy, PartialEq)]
enum Said {
    NotYet,
    Held(Instant),
    Told,
}

enum Outcome<E> {
    /// Its stop was raised.
    Stopped,
    /// A command asked for it, and the folder was let go.
    HandedOver,
    /// Its directory cannot be found.
    Missing,
    Unopened(Unwatched),
    Ended(Unwatched),
    Told(E),
}

enum Run<'scope, E> {
    Watching {
        stop: Arc<AtomicBool>,
        start: Arc<Mutex<Start>>,
        handle: ScopedJoinHandle<'scope, Outcome<E>>,
    },
    Waiting {
        until: Instant,
    },
}

struct Entry<'scope, E> {
    run: Run<'scope, E>,
    /// The reason last said, until the folder is said to be watched again.
    told: Option<Unwatched>,
    /// Its watch was stopped because the registry no longer lists it.
    leaving: bool,
    /// Let go to a command, and taken back once that command lets it go.
    parked: bool,
    /// When a command was last seen asking for or working the folder.
    asked_at: Option<Instant>,
    /// The wait before the next look, while its directory cannot be found.
    missing: Option<Duration>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn supervise<S: Supervised>(
    mut list: impl FnMut() -> Listing,
    stop: &AtomicBool,
    every: &S,
    record: &WatchRecord,
    timing: Timing,
) -> Result<(), S::Error> {
    std::thread::scope(|scope| {
        scope.spawn(|| {
            record.keep(|reason| {
                let _ = every.tell(Every::Record {
                    path: record.path(),
                    reason,
                });
            });
        });
        let mut entries: BTreeMap<PathBuf, Entry<'_, S::Error>> = BTreeMap::new();
        let mut unread: Option<String> = None;
        let mut none_said = false;
        let mut missing = Missing::new();
        let mut next_read = Instant::now();
        let watched = loop {
            if stop.load(Ordering::SeqCst) {
                break Ok(());
            }
            if let Err(error) = reap(&mut entries, every, stop, record, timing) {
                break Err(error);
            }
            // A folder let go is tried again only on a fresh reading, so one
            // the command took off the registry leaves rather than being
            // said to be no folder.
            if parked_due(&entries) {
                next_read = Instant::now();
            }
            if let Err(error) = missing.tell(&entries, every, timing) {
                break Err(error);
            }
            if Instant::now() >= next_read {
                next_read = Instant::now() + timing.reread;
                let read = reconcile(
                    list(),
                    &mut entries,
                    every,
                    record,
                    &mut unread,
                    &mut none_said,
                );
                if let Err(error) = read {
                    break Err(error);
                }
            }
            if let Err(error) = start_due(scope, &mut entries, every, record, timing) {
                break Err(error);
            }
            std::thread::sleep(timing.poll);
        };
        // Every watch is stopped before any is waited for, so they wind down
        // together.
        for entry in entries.values() {
            if let Run::Watching { stop, .. } = &entry.run {
                stop.store(true, Ordering::SeqCst);
            }
        }
        for (_, entry) in entries {
            if let Run::Watching { handle, .. } = entry.run {
                let _ = handle.join();
            }
        }
        record.finish();
        watched
    })
}

fn parked_due<E>(entries: &BTreeMap<PathBuf, Entry<'_, E>>) -> bool {
    let now = Instant::now();
    entries
        .values()
        .any(|entry| entry.parked && matches!(entry.run, Run::Waiting { until } if until <= now))
}

/// The folders whose directories cannot be found, told together: a machine's
/// registry can list many folders deleted long ago.
struct Missing {
    /// The set as last seen, and since when it has been so.
    seen: (Vec<PathBuf>, Instant),
    /// Those told, less any found since.
    told: Vec<PathBuf>,
}

impl Missing {
    fn new() -> Missing {
        Missing {
            seen: (Vec::new(), Instant::now()),
            told: Vec::new(),
        }
    }

    /// Tells the set once it has stayed the same for a reread, where it holds
    /// a folder not told yet. The folders are tried at once at the start, so
    /// the set settles before it is told.
    fn tell<S: Supervised>(
        &mut self,
        entries: &BTreeMap<PathBuf, Entry<'_, S::Error>>,
        every: &S,
        timing: Timing,
    ) -> Result<(), S::Error> {
        let now: Vec<PathBuf> = entries
            .iter()
            .filter(|(_, entry)| entry.missing.is_some() && !entry.leaving)
            .map(|(dir, _)| dir.clone())
            .collect();
        self.told.retain(|dir| now.contains(dir));
        if now != self.seen.0 {
            self.seen = (now, Instant::now());
            return Ok(());
        }
        if self.seen.1.elapsed() >= timing.reread && now.iter().any(|dir| !self.told.contains(dir))
        {
            every.tell(Every::Missing { dirs: &now })?;
            self.told = now;
        }
        Ok(())
    }
}

/// Takes in the watches that ended, and decides what comes of each.
fn reap<S: Supervised>(
    entries: &mut BTreeMap<PathBuf, Entry<'_, S::Error>>,
    every: &S,
    stop: &AtomicBool,
    record: &WatchRecord,
    timing: Timing,
) -> Result<(), S::Error> {
    let finished: Vec<PathBuf> = entries
        .iter()
        .filter(
            |(_, entry)| matches!(&entry.run, Run::Watching { handle, .. } if handle.is_finished()),
        )
        .map(|(dir, _)| dir.clone())
        .collect();
    let now = Instant::now();
    for dir in finished {
        let entry = entries.get_mut(&dir).expect("a finished entry");
        let Run::Watching {
            stop: own,
            start,
            handle,
        } = std::mem::replace(&mut entry.run, Run::Waiting { until: now })
        else {
            unreachable!("only a watching entry finishes");
        };
        let said = lock(&start).said == Said::Told;
        if said {
            entry.told = None;
        }
        let ended = handle
            .join()
            .unwrap_or_else(|_| Outcome::Ended(Unwatched::fault()));
        if let Outcome::Told(error) = ended {
            return Err(error);
        }
        if entry.leaving {
            entries.remove(&dir);
            record.left(&dir);
            every.tell(Every::Left { dir: &dir })?;
            continue;
        }
        let asked = match &ended {
            Outcome::HandedOver => true,
            Outcome::Unopened(reason) => reason.code == HANDED_OVER,
            _ => false,
        };
        if asked {
            entry.asked_at = Some(now);
        }
        // Held with no command asking for longer than a command waits, it is
        // another process's, and said to be.
        let handed = asked
            || matches!(&ended, Outcome::Unopened(reason) if entry.parked
                && reason.code == CoreError::ReadingHandle.code()
                && entry.asked_at.is_some_and(|at| now.duration_since(at) < timing.held));
        if handed {
            let first = !entry.parked;
            entry.parked = true;
            record.unwatched(&dir, Some(HANDED_OVER));
            entry.run = Run::Waiting {
                until: now + timing.handed,
            };
            match ended {
                // Said again only where it was taken back in between.
                Outcome::HandedOver if first || said => {
                    every.tell(Every::HandedOver { dir: &dir })?;
                }
                // Never watched since this process began: why is said as for
                // any folder that cannot be opened.
                Outcome::Unopened(reason) if first && entry.told.as_ref() != Some(&reason) => {
                    every.tell(Every::Unwatched {
                        dir: &dir,
                        reason: &reason,
                    })?;
                    entry.told = Some(reason);
                }
                _ => {}
            }
            continue;
        }
        entry.parked = false;
        if let Outcome::Missing = ended {
            let wait = entry
                .missing
                .map_or(timing.unopened, |wait| (wait * 2).min(timing.missing_most));
            entry.missing = Some(wait);
            entry.run = Run::Waiting { until: now + wait };
            let reason = Unwatched {
                code: MISSING.into(),
                message: format!(
                    "{} cannot be found; it is watched once it is back",
                    dir.display()
                ),
            };
            record.unwatched(&dir, Some(&reason.code));
            // Told with the others that cannot be found, by the supervisor.
            entry.told = Some(reason);
            continue;
        }
        entry.missing = None;
        let (reason, wait) = match ended {
            // Raised for a folder the registry lists again since: it starts
            // again at once.
            Outcome::Stopped if own.load(Ordering::SeqCst) || stop.load(Ordering::SeqCst) => {
                record.unwatched(&dir, None);
                continue;
            }
            Outcome::Stopped => (
                Unwatched {
                    code: "watch".into(),
                    message: "the watch of this folder ended".into(),
                },
                timing.ended,
            ),
            Outcome::Unopened(reason) => (reason, timing.unopened),
            Outcome::Ended(reason) => {
                every.ended(&dir, &reason);
                (reason, timing.ended)
            }
            Outcome::Told(_) => unreachable!("a failed tell ended the watch above"),
            Outcome::HandedOver => unreachable!("a folder let go is parked above"),
            Outcome::Missing => unreachable!("a missing directory is taken in above"),
        };
        entry.run = Run::Waiting { until: now + wait };
        record.unwatched(&dir, Some(&reason.code));
        if entry.told.as_ref() != Some(&reason) {
            every.tell(Every::Unwatched {
                dir: &dir,
                reason: &reason,
            })?;
            entry.told = Some(reason);
        }
    }
    Ok(())
}

/// Brings the folders watched into line with what the registry lists.
fn reconcile<S: Supervised>(
    listing: Listing,
    entries: &mut BTreeMap<PathBuf, Entry<'_, S::Error>>,
    every: &S,
    record: &WatchRecord,
    unread: &mut Option<String>,
    none_said: &mut bool,
) -> Result<(), S::Error> {
    let listed = match listing {
        Listing::Listed(listed) => listed,
        // With nothing watched, no registry is no folders.
        Listing::Absent(_) if entries.is_empty() => Vec::new(),
        Listing::Absent(reason) | Listing::Unread(reason) => {
            if unread.as_deref() != Some(reason.as_str()) {
                every.tell(Every::Registry(Some(&reason)))?;
                *unread = Some(reason);
            }
            return Ok(());
        }
    };
    if unread.take().is_some() {
        every.tell(Every::Registry(None))?;
    }
    let now = Instant::now();
    for (dir, folder) in &listed {
        record.listed(dir, folder);
        entries
            .entry(dir.clone())
            .and_modify(|entry| entry.leaving = false)
            .or_insert(Entry {
                run: Run::Waiting { until: now },
                told: None,
                leaving: false,
                parked: false,
                asked_at: None,
                missing: None,
            });
    }
    let unlisted: Vec<PathBuf> = entries
        .keys()
        .filter(|dir| !listed.iter().any(|(listed, _)| listed == *dir))
        .cloned()
        .collect();
    for dir in unlisted {
        let entry = entries.get_mut(&dir).expect("an unlisted entry");
        match &entry.run {
            Run::Watching { stop, .. } => {
                stop.store(true, Ordering::SeqCst);
                entry.leaving = true;
            }
            Run::Waiting { .. } => {
                entries.remove(&dir);
                record.left(&dir);
                every.tell(Every::Left { dir: &dir })?;
            }
        }
    }
    if listed.is_empty() {
        if !*none_said {
            every.tell(Every::NoFolders)?;
            *none_said = true;
        }
    } else {
        *none_said = false;
    }
    Ok(())
}

/// Starts the folders due a try, and says a held-back start once its watch
/// has lasted.
fn start_due<'scope, 'env, S: Supervised>(
    scope: &'scope Scope<'scope, 'env>,
    entries: &mut BTreeMap<PathBuf, Entry<'scope, S::Error>>,
    every: &'env S,
    record: &'env WatchRecord,
    timing: Timing,
) -> Result<(), S::Error> {
    let now = Instant::now();
    for (dir, entry) in entries.iter_mut() {
        match &entry.run {
            Run::Waiting { until } if *until <= now && !entry.leaving => {
                let stop = Arc::new(AtomicBool::new(false));
                let start = Arc::new(Mutex::new(Start {
                    quiet: entry.told.is_some() && !entry.parked,
                    taken_back: entry.parked && entry.told.is_none(),
                    said: Said::NotYet,
                }));
                let handle = {
                    let (dir, stop, start) = (dir.clone(), Arc::clone(&stop), Arc::clone(&start));
                    scope.spawn(move || run(every, record, &dir, &stop, &start))
                };
                entry.run = Run::Watching {
                    stop,
                    start,
                    handle,
                };
            }
            Run::Watching { start, handle, .. } => {
                let mut start = lock(start);
                // A watch that has ended has not lasted, however long it ran
                // before the supervisor looked.
                if let Said::Held(at) = start.said
                    && !handle.is_finished()
                    && now.duration_since(at) >= timing.recovered
                {
                    every.tell(Every::Watching { dir })?;
                    start.said = Said::Told;
                    record.watching(dir);
                }
            }
            Run::Waiting { .. } => {}
        }
    }
    Ok(())
}

/// One folder's watch, on its own thread.
fn run<S: Supervised>(
    every: &S,
    record: &WatchRecord,
    dir: &Path,
    stop: &AtomicBool,
    start: &Mutex<Start>,
) -> Outcome<S::Error> {
    if every.missing(dir) {
        return Outcome::Missing;
    }
    let folder = match every.open(dir) {
        Ok(folder) => folder,
        Err(reason) => return Outcome::Unopened(reason),
    };
    let watched = record.beating(dir, &folder, || {
        folder.watch(stop, |event| {
            {
                let mut start = lock(start);
                if let WatchEvent::Watching { storage, .. } = &event {
                    if let Some(cause) = storage {
                        every.tell(Every::Storage { dir, cause })?;
                    }
                    if start.quiet {
                        start.said = Said::Held(Instant::now());
                        return Ok(());
                    }
                    if start.taken_back {
                        every.tell(Every::TakenBack { dir })?;
                    } else {
                        every.tell(Every::Watching { dir })?;
                    }
                    start.said = Said::Told;
                    record.watching(dir);
                    return Ok(());
                }
                if matches!(start.said, Said::Held(_)) {
                    every.tell(Every::Watching { dir })?;
                    start.said = Said::Told;
                    record.watching(dir);
                }
            }
            every.tell(Every::Folder {
                dir,
                folder: &folder,
                event,
            })
        })
    });
    match watched {
        Ok(WatchEnd::Stopped) => Outcome::Stopped,
        Ok(WatchEnd::HandedOver) => Outcome::HandedOver,
        Err(error) => match Unwatched::ended(error) {
            Ok(reason) => Outcome::Ended(reason),
            Err(told) => Outcome::Told(told),
        },
    }
}

#[cfg(test)]
mod tests {
    use std::collections::{HashMap, VecDeque};

    use super::super::health::Snapshot;
    use super::*;

    /// How a fake folder's watch goes once it is open.
    #[derive(Clone)]
    enum Goes {
        /// Until its stop.
        Lasts,
        /// Ends with this, after telling it is watched.
        Ends(Unwatched),
        /// As `Ends`, a moment after telling it is watched.
        EndsSlowly(Unwatched),
        /// Tells a pass, then lasts.
        Passes,
        Panics,
        /// Tells it is watched in synced storage, then lasts.
        Synced,
        /// Tells it is watched in synced storage, then ends with this.
        EndsSynced(Unwatched),
        /// Lets the folder go to a command, after telling it is watched.
        HandsOver,
        /// Lets the folder go to a command that asked as it opened.
        HandsOverAtOnce,
    }

    struct Fake {
        goes: Goes,
    }

    impl Observed for Fake {
        fn observed(&self) -> Option<Snapshot> {
            matches!(self.goes, Goes::Passes)
                .then(|| Snapshot::succeeded("2026-04-04T00:00:00.000Z"))
        }
    }

    impl Watched for Fake {
        fn watch<E>(
            &self,
            stop: &AtomicBool,
            mut tell: impl FnMut(WatchEvent) -> Result<(), E>,
        ) -> Result<WatchEnd, WatchError<E>> {
            if matches!(self.goes, Goes::HandsOverAtOnce) {
                return Ok(WatchEnd::HandedOver);
            }
            let storage = matches!(self.goes, Goes::Synced | Goes::EndsSynced(_))
                .then_some(StorageCause::CloudService);
            tell(WatchEvent::Watching {
                dir: PathBuf::from("/resolved"),
                storage,
            })
            .map_err(WatchError::Told)?;
            match &self.goes {
                Goes::HandsOver | Goes::HandsOverAtOnce => return Ok(WatchEnd::HandedOver),
                Goes::Ends(reason) | Goes::EndsSynced(reason) => {
                    return Err(WatchError::Unwatchable(reason.message.clone()));
                }
                Goes::EndsSlowly(reason) => {
                    std::thread::sleep(Duration::from_millis(30));
                    return Err(WatchError::Unwatchable(reason.message.clone()));
                }
                Goes::Panics => panic!("a folder's watch panicked"),
                Goes::Passes => {
                    tell(WatchEvent::Reach(None)).map_err(WatchError::Told)?;
                }
                Goes::Lasts | Goes::Synced => {}
            }
            while !stop.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(2));
            }
            Ok(WatchEnd::Stopped)
        }
    }

    #[derive(Default)]
    struct OpenGate {
        ready: AtomicBool,
        released: Mutex<bool>,
        changed: std::sync::Condvar,
    }

    impl OpenGate {
        fn wait(&self) {
            let released = lock(&self.released);
            self.ready.store(true, Ordering::SeqCst);
            let (released, _) = self
                .changed
                .wait_timeout_while(released, Duration::from_secs(10), |released| !*released)
                .unwrap();
            assert!(*released, "the held open was not released");
        }

        fn release(&self) {
            *lock(&self.released) = true;
            self.changed.notify_one();
        }
    }

    /// Each folder's opens in turn, the last repeating, and what was told.
    #[derive(Default)]
    struct Machine {
        opens: Mutex<HashMap<PathBuf, VecDeque<Result<Goes, Unwatched>>>>,
        opened: Mutex<Vec<PathBuf>>,
        open_gate: Option<(PathBuf, usize, Arc<OpenGate>)>,
        told: Mutex<Vec<String>>,
        ended: Mutex<Vec<String>>,
        refuse_telling: AtomicBool,
        /// Opens of these wait until it is lowered, as a directory on a
        /// network volume that does not answer.
        hung: Mutex<Vec<PathBuf>>,
        hanging: AtomicBool,
        /// Directories that cannot be found, and each look at one.
        missing: Mutex<Vec<PathBuf>>,
        looked: Mutex<Vec<PathBuf>>,
    }

    impl Machine {
        fn opens(&self, dir: &str, opens: Vec<Result<Goes, Unwatched>>) {
            lock(&self.opens).insert(PathBuf::from(dir), opens.into());
        }

        fn told(&self) -> Vec<String> {
            lock(&self.told).clone()
        }

        fn read(&self, listed: &Mutex<Listing>) -> Listing {
            let listing = lock(listed).clone();
            if let Some((dir, _, gate)) = &self.open_gate
                && matches!(&listing, Listing::Listed(dirs) if !dirs.iter().any(|(listed, _)| listed == dir))
            {
                // This pass reconciles the removal before it can reap the held open.
                gate.release();
            }
            listing
        }

        fn opened(&self, dir: &str) -> usize {
            lock(&self.opened)
                .iter()
                .filter(|opened| *opened == Path::new(dir))
                .count()
        }
    }

    impl Supervised for Machine {
        type Folder = Fake;
        type Error = String;

        fn missing(&self, dir: &Path) -> bool {
            lock(&self.looked).push(dir.to_path_buf());
            lock(&self.missing).iter().any(|missing| missing == dir)
        }

        fn open(&self, dir: &Path) -> Result<Fake, Unwatched> {
            lock(&self.opened).push(dir.to_path_buf());
            if let Some((gated_dir, at, gate)) = &self.open_gate
                && dir == gated_dir
                && self.opened(&dir.to_string_lossy()) == *at
            {
                gate.wait();
            }
            if lock(&self.hung).iter().any(|hung| hung == dir) {
                while self.hanging.load(Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_millis(2));
                }
            }
            let mut opens = lock(&self.opens);
            let queue = opens.get_mut(dir).expect("a scripted folder");
            let next = if queue.len() > 1 {
                queue.pop_front().unwrap()
            } else {
                queue.front().unwrap().clone()
            };
            next.map(|goes| Fake { goes })
        }

        fn tell(&self, event: Every<'_, Fake>) -> Result<(), String> {
            if self.refuse_telling.load(Ordering::SeqCst) {
                return Err("the output closed".into());
            }
            let said = match event {
                Every::Watching { dir } => format!("watching {}", dir.display()),
                Every::Folder { dir, event, .. } => {
                    format!("{} {}", dir.display(), short(&event))
                }
                Every::Storage { dir, cause } => format!("storage {} {cause:?}", dir.display()),
                Every::Unwatched { dir, reason } => {
                    format!("unwatched {} {}", dir.display(), reason.code)
                }
                Every::Missing { dirs } => format!("missing {}", dirs.len()),
                Every::Left { dir } => format!("left {}", dir.display()),
                Every::HandedOver { dir } => format!("handed {}", dir.display()),
                Every::TakenBack { dir } => format!("taken back {}", dir.display()),
                Every::NoFolders => "no folders".into(),
                Every::Registry(reason) => format!("registry {reason:?}"),
                Every::Record { reason, .. } => format!("record {reason}"),
            };
            lock(&self.told).push(said);
            Ok(())
        }

        fn ended(&self, dir: &Path, reason: &Unwatched) {
            lock(&self.ended).push(format!("{} {}", dir.display(), reason.code));
        }
    }

    fn short(event: &WatchEvent) -> &'static str {
        match event {
            WatchEvent::Reach(_) => "reach",
            _ => "other",
        }
    }

    fn reason(code: &str) -> Unwatched {
        Unwatched {
            code: code.into(),
            message: format!("{code} message"),
        }
    }

    fn quick() -> Timing {
        Timing {
            poll: Duration::from_millis(2),
            reread: Duration::from_millis(10),
            unopened: Duration::from_millis(20),
            ended: Duration::from_millis(40),
            handed: Duration::from_millis(15),
            held: Duration::from_millis(120),
            recovered: Duration::from_millis(150),
            missing_most: Duration::from_millis(160),
        }
    }

    /// Runs the supervisor over the listing `listed` gives until `until`
    /// holds or a bound passes, then stops it and answers what it returned.
    fn supervised(
        machine: &Machine,
        listed: &Mutex<Listing>,
        until: impl Fn(&Machine) -> bool,
    ) -> Result<(), String> {
        let temp = tempfile::tempdir().unwrap();
        let record = WatchRecord::at(temp.path().join("record.json"), 1, Duration::from_secs(5));
        supervised_with(machine, listed, &record, until)
    }

    fn supervised_with(
        machine: &Machine,
        listed: &Mutex<Listing>,
        record: &WatchRecord,
        until: impl Fn(&Machine) -> bool,
    ) -> Result<(), String> {
        supervised_timed(machine, listed, record, quick(), until)
    }

    fn supervised_timed(
        machine: &Machine,
        listed: &Mutex<Listing>,
        record: &WatchRecord,
        timing: Timing,
        until: impl Fn(&Machine) -> bool,
    ) -> Result<(), String> {
        let stop = AtomicBool::new(false);
        std::thread::scope(|scope| {
            let running =
                scope.spawn(|| supervise(|| machine.read(listed), &stop, machine, record, timing));
            let bound = Instant::now() + Duration::from_secs(10);
            while !until(machine) && !running.is_finished() {
                assert!(
                    Instant::now() < bound,
                    "never came to pass: {:?}",
                    machine.told()
                );
                std::thread::sleep(Duration::from_millis(2));
            }
            stop.store(true, Ordering::SeqCst);
            running.join().unwrap()
        })
    }

    fn listing_of(dirs: &[&str]) -> Listing {
        Listing::Listed(
            dirs.iter()
                .map(|dir| (PathBuf::from(dir), format!("id{dir}")))
                .collect(),
        )
    }

    fn listed(dirs: &[&str]) -> Mutex<Listing> {
        Mutex::new(listing_of(dirs))
    }

    fn count(machine: &Machine, line: &str) -> usize {
        machine.told().iter().filter(|told| *told == line).count()
    }

    #[test]
    fn folders_whose_directories_cannot_be_found_are_told_once_together_and_tried_less_often() {
        let machine = Machine::default();
        machine.opens("/real", vec![Ok(Goes::Lasts)]);
        let mut dirs = vec!["/real".to_string()];
        for n in 0..50 {
            let dir = format!("/gone{n}");
            // What opening one would say, were it opened.
            machine.opens(&dir, vec![Err(reason("io"))]);
            lock(&machine.missing).push(PathBuf::from(&dir));
            dirs.push(dir);
        }
        let listing = listed(&dirs.iter().map(String::as_str).collect::<Vec<_>>());
        let temp = tempfile::tempdir().unwrap();
        let record = WatchRecord::at(temp.path().join("record.json"), 1, Duration::from_secs(5));
        let started = Instant::now();
        supervised_timed(&machine, &listing, &record, quick(), |machine| {
            count(machine, "watching /real") == 1
                && count(machine, "missing 50") == 1
                && started.elapsed() >= Duration::from_secs(1)
        })
        .unwrap();
        let told = machine.told();
        assert_eq!(
            told.iter()
                .filter(|told| told.starts_with("missing"))
                .count(),
            1,
            "{told:?}"
        );
        assert!(
            !told.iter().any(|told| told.starts_with("unwatched /gone")),
            "a folder that cannot be found was told on its own: {told:?}"
        );
        assert_eq!(
            machine.opened("/gone0"),
            0,
            "a directory not there was opened"
        );
        // Tried every 20 milliseconds for a second, it would be looked at
        // about 50 times; backing off to 160, about 9.
        let looks = lock(&machine.looked)
            .iter()
            .filter(|looked| *looked == Path::new("/gone0"))
            .count();
        assert!((2..=12).contains(&looks), "looked at {looks} times");
        let entry = std::fs::read_to_string(record.path()).unwrap();
        assert!(entry.contains("\"dir\": \"/gone0\""), "{entry}");
        assert!(entry.contains("\"reason\": \"missing\""), "{entry}");

        // The witness: one that is back is watched, and the rest are told
        // together still.
        lock(&machine.missing).retain(|missing| missing != Path::new("/gone0"));
        machine.opens("/gone0", vec![Ok(Goes::Lasts)]);
        let machine_back = machine;
        lock(&machine_back.told).clear();
        supervised_timed(&machine_back, &listing, &record, quick(), |machine| {
            count(machine, "watching /gone0") == 1 && count(machine, "missing 49") == 1
        })
        .unwrap();
    }

    #[test]
    fn every_listed_folder_is_watched_at_once_and_each_watch_ends_with_the_stop() {
        let machine = Machine::default();
        machine.opens("/a", vec![Ok(Goes::Passes)]);
        machine.opens("/b", vec![Ok(Goes::Lasts)]);
        let listing = listed(&["/a", "/b"]);
        supervised(&machine, &listing, |machine| {
            count(machine, "watching /b") == 1 && count(machine, "/a reach") == 1
        })
        .unwrap();
        let told = machine.told();
        // Its own events name the folder they came from, after its start.
        let started = told.iter().position(|told| told == "watching /a").unwrap();
        let reached = told.iter().position(|told| told == "/a reach").unwrap();
        assert!(started < reached, "{told:?}");
        assert_eq!(machine.opened("/a"), 1, "a watch was started twice");
    }

    #[test]
    fn a_folder_that_cannot_be_opened_is_told_once_while_the_others_go_on_and_is_tried_again() {
        let machine = Machine::default();
        machine.opens(
            "/held",
            vec![
                Err(reason("reading_handle")),
                Err(reason("reading_handle")),
                Err(reason("reading_handle")),
                Err(reason("first_sync_waiting")),
                Ok(Goes::Lasts),
            ],
        );
        machine.opens("/a", vec![Ok(Goes::Lasts)]);
        let listing = listed(&["/a", "/held"]);
        supervised(&machine, &listing, |machine| {
            count(machine, "watching /held") == 1 && count(machine, "watching /a") == 1
        })
        .unwrap();
        let held: Vec<String> = machine
            .told()
            .into_iter()
            .filter(|told| told.contains("/held"))
            .collect();
        assert_eq!(
            held,
            vec![
                "unwatched /held reading_handle",
                "unwatched /held first_sync_waiting",
                "watching /held",
            ],
            "a reason was told at every try, or a changed one not at all"
        );
        assert_eq!(count(&machine, "watching /a"), 1);
        // The witness that it was tried at every turn, though told once.
        assert_eq!(machine.opened("/held"), 5);
    }

    #[test]
    fn a_folder_in_synced_storage_says_so_at_every_start_of_its_watch_and_one_elsewhere_never() {
        let machine = Machine::default();
        machine.opens(
            "/synced",
            vec![
                Ok(Goes::EndsSynced(reason("watch"))),
                Ok(Goes::EndsSynced(reason("watch"))),
                Ok(Goes::Synced),
            ],
        );
        machine.opens("/plain", vec![Ok(Goes::Lasts)]);
        let listing = listed(&["/synced", "/plain"]);
        supervised(&machine, &listing, |machine| {
            count(machine, "watching /plain") == 1
                && count(machine, "storage /synced CloudService") == 3
        })
        .unwrap();
        let synced: Vec<String> = machine
            .told()
            .into_iter()
            .filter(|told| told.contains("/synced") && told.starts_with("storage"))
            .collect();
        // A start held back from `watching` still says where it is.
        assert_eq!(
            synced,
            vec!["storage /synced CloudService"; 3],
            "{:?}",
            machine.told()
        );
        // The witness: the folder elsewhere started, and said nothing of storage.
        assert!(
            !machine
                .told()
                .iter()
                .any(|told| told.contains("/plain") && told.starts_with("storage")),
            "{:?}",
            machine.told()
        );
    }

    #[test]
    fn a_try_that_fails_as_the_last_did_says_nothing_and_one_that_lasts_is_told() {
        let machine = Machine::default();
        machine.opens(
            "/a",
            vec![
                Ok(Goes::Ends(reason("watch"))),
                Ok(Goes::Ends(reason("watch"))),
                Ok(Goes::Lasts),
            ],
        );
        let listing = listed(&["/a"]);
        supervised(&machine, &listing, |machine| {
            count(machine, "watching /a") == 2
        })
        .unwrap();
        assert_eq!(
            machine.told(),
            vec!["watching /a", "unwatched /a watch", "watching /a"],
            "a try that ended as the last one did was said to start"
        );
        assert_eq!(machine.opened("/a"), 3);
    }

    #[test]
    fn a_reason_is_told_again_once_the_folder_was_watched_in_between() {
        let machine = Machine::default();
        machine.opens(
            "/a",
            vec![
                Err(reason("io")),
                Ok(Goes::Passes),
                Err(reason("io")),
                Ok(Goes::Lasts),
            ],
        );
        let listing = listed(&["/a"]);
        let stop_first = AtomicBool::new(false);
        // The pass shows the folder was watched; its watch is then ended by
        // the registry and listed again.
        supervised(&machine, &listing, |machine| {
            if count(machine, "/a reach") == 1 && !stop_first.swap(true, Ordering::SeqCst) {
                *lock(&listing) = listing_of(&[]);
            }
            if count(machine, "left /a") == 1 {
                *lock(&listing) = listing_of(&["/a"]);
            }
            count(machine, "unwatched /a io") == 2
        })
        .unwrap();
        let told = machine.told();
        assert_eq!(
            told.iter()
                .filter(|told| told.starts_with("unwatched"))
                .count(),
            2,
            "{told:?}"
        );
    }

    #[test]
    fn a_folder_added_joins_and_one_removed_leaves_while_the_rest_go_on() {
        let machine = Machine::default();
        machine.opens("/a", vec![Ok(Goes::Lasts)]);
        machine.opens("/b", vec![Ok(Goes::Lasts)]);
        machine.opens("/c", vec![Err(reason("io"))]);
        let listing = listed(&["/a", "/c"]);
        supervised(&machine, &listing, |machine| {
            let told = machine.told();
            if told.contains(&"watching /a".to_string())
                && told.contains(&"unwatched /c io".to_string())
            {
                *lock(&listing) = listing_of(&["/b"]);
            }
            count(machine, "watching /b") == 1
                && count(machine, "left /a") == 1
                && count(machine, "left /c") == 1
        })
        .unwrap();
        assert_eq!(
            machine.opened("/a"),
            1,
            "the folder that left was opened again"
        );
        assert_eq!(count(&machine, "no folders"), 0);
    }

    #[test]
    fn a_registry_that_cannot_be_read_keeps_the_folders_watched_and_is_told_once() {
        let machine = Machine::default();
        machine.opens("/a", vec![Ok(Goes::Lasts)]);
        let listing = listed(&["/a"]);
        let reads = std::sync::atomic::AtomicUsize::new(0);
        supervised(&machine, &listing, |machine| {
            let told = machine.told();
            if told == ["watching /a"] {
                *lock(&listing) = Listing::Unread("unreadable".into());
            }
            if told.len() == 2 && reads.fetch_add(1, Ordering::SeqCst) == 20 {
                *lock(&listing) = Listing::Absent("not there".into());
            }
            if told.len() == 3 && reads.fetch_add(1, Ordering::SeqCst) == 40 {
                *lock(&listing) = listing_of(&["/a"]);
            }
            told.len() == 4
        })
        .unwrap();
        assert_eq!(
            machine.told(),
            vec![
                "watching /a",
                "registry Some(\"unreadable\")",
                "registry Some(\"not there\")",
                "registry None",
            ]
        );
        assert_eq!(
            machine.opened("/a"),
            1,
            "an unreadable registry stopped a watch"
        );
    }

    #[test]
    fn no_folders_is_told_once_and_the_watch_waits_for_one() {
        let machine = Machine::default();
        machine.opens("/a", vec![Ok(Goes::Lasts)]);
        let listing = Mutex::new(Listing::Absent("not there".into()));
        let polls = std::sync::atomic::AtomicUsize::new(0);
        supervised(&machine, &listing, |machine| {
            if polls.fetch_add(1, Ordering::SeqCst) == 50 {
                *lock(&listing) = listing_of(&["/a"]);
            }
            count(machine, "watching /a") == 1
        })
        .unwrap();
        assert_eq!(machine.told(), vec!["no folders", "watching /a"]);
    }

    #[test]
    fn a_tell_that_fails_ends_every_folder_s_watch() {
        let machine = Machine::default();
        machine.opens("/a", vec![Ok(Goes::Lasts)]);
        machine.opens("/b", vec![Ok(Goes::Lasts)]);
        let listing = listed(&["/a", "/b"]);
        let stop = AtomicBool::new(false);
        let temp = tempfile::tempdir().unwrap();
        let record = WatchRecord::at(temp.path().join("record.json"), 1, Duration::from_secs(5));
        let ended = std::thread::scope(|scope| {
            let running = scope
                .spawn(|| supervise(|| lock(&listing).clone(), &stop, &machine, &record, quick()));
            while machine.told().len() < 2 {
                std::thread::sleep(Duration::from_millis(2));
            }
            machine.refuse_telling.store(true, Ordering::SeqCst);
            // Telling that the folder left meets the closed output.
            *lock(&listing) = listing_of(&["/a"]);
            running.join().unwrap()
        });
        assert_eq!(ended, Err("the output closed".to_string()));
        assert!(!stop.load(Ordering::SeqCst), "the caller's stop was raised");
    }

    #[test]
    fn a_folder_whose_watch_panics_is_told_and_the_others_go_on() {
        let machine = Machine::default();
        machine.opens("/a", vec![Ok(Goes::Lasts)]);
        machine.opens("/b", vec![Ok(Goes::Panics), Ok(Goes::Lasts)]);
        let listing = listed(&["/a", "/b"]);
        supervised(&machine, &listing, |machine| {
            count(machine, "unwatched /b watch") == 1
                && count(machine, "watching /b") == 2
                && count(machine, "watching /a") == 1
        })
        .unwrap();
        assert_eq!(count(&machine, "watching /a"), 1);
    }

    #[test]
    fn every_end_is_handed_back_though_its_reason_is_told_once() {
        let machine = Machine::default();
        machine.opens(
            "/a",
            vec![
                Ok(Goes::Ends(reason("watch"))),
                Ok(Goes::Ends(reason("watch"))),
                Ok(Goes::Ends(reason("watch"))),
                Ok(Goes::Lasts),
            ],
        );
        let listing = listed(&["/a"]);
        supervised(&machine, &listing, |machine| {
            machine.opened("/a") == 4
                && lock(&machine.ended).len() == 3
                && count(machine, "unwatched /a watch") == 1
        })
        .unwrap();
        assert_eq!(
            count(&machine, "unwatched /a watch"),
            1,
            "{:?}",
            machine.told()
        );
        assert_eq!(
            lock(&machine.ended).clone(),
            vec!["/a watch", "/a watch", "/a watch"],
            "an end whose reason was not told again was not handed back"
        );
    }

    #[test]
    fn a_folder_whose_open_hangs_keeps_no_other_from_joining_or_leaving() {
        let machine = Machine::default();
        machine.opens("/hung", vec![Ok(Goes::Lasts)]);
        machine.opens("/a", vec![Ok(Goes::Lasts)]);
        machine.opens("/b", vec![Ok(Goes::Lasts)]);
        lock(&machine.hung).push(PathBuf::from("/hung"));
        machine.hanging.store(true, Ordering::SeqCst);
        let listing = listed(&["/hung", "/a"]);
        let at_release = Mutex::new(Vec::new());
        let result = supervised(&machine, &listing, |machine| {
            if count(machine, "watching /a") == 1 {
                *lock(&listing) = listing_of(&["/hung", "/b"]);
            }
            let done = count(machine, "watching /b") == 1 && count(machine, "left /a") == 1;
            if done {
                *lock(&at_release) = machine.told();
                // Let the hung open go, so the stop can wait for it.
                machine.hanging.store(false, Ordering::SeqCst);
            }
            done
        });
        result.unwrap();
        // The witness that it was hung throughout: it had not started.
        let told = lock(&at_release).clone();
        assert!(!told.is_empty());
        assert!(told.iter().all(|told| !told.contains("/hung")), "{told:?}");
    }

    fn kept(path: &Path) -> serde_json::Value {
        serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
    }

    fn folder_of<'a>(kept: &'a serde_json::Value, dir: &str) -> Option<&'a serde_json::Value> {
        kept["processes"][0]["folders"]
            .as_array()?
            .iter()
            .find(|folder| folder["dir"] == dir)
    }

    #[test]
    fn the_record_holds_each_listed_folder_watched_or_not_with_its_reason_and_ends_with_the_stop() {
        let machine = Machine::default();
        machine.opens("/a", vec![Ok(Goes::Lasts)]);
        machine.opens("/b", vec![Err(reason("unauthorized"))]);
        machine.opens("/c", vec![Ok(Goes::Passes)]);
        machine.opens("/d", vec![Ok(Goes::Lasts)]);
        let listing = listed(&["/a", "/b", "/c", "/d"]);
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("record.json");
        let record = WatchRecord::at(path.clone(), 7, Duration::from_millis(100));
        supervised_with(&machine, &listing, &record, |machine| {
            if count(machine, "left /d") == 0 && count(machine, "watching /d") == 1 {
                *lock(&listing) = listing_of(&["/a", "/b", "/c"]);
            }
            let held = path.exists() && {
                let kept = kept(&path);
                folder_of(&kept, "/a").is_some_and(|a| a["watching"] == true)
                    && folder_of(&kept, "/b").is_some_and(|b| b["reason"] == "unauthorized")
                    && folder_of(&kept, "/c").is_some_and(|c| c["last_success_at"].is_string())
                    && folder_of(&kept, "/d").is_none()
            };
            held && count(machine, "left /d") == 1
        })
        .unwrap();
        let kept = kept(&path);
        let process = &kept["processes"][0];
        assert_eq!(process["pid"], 7);
        assert!(process["ended_at"].is_string(), "{kept}");
        // The witness that the folders were watched before the stop.
        assert_eq!(count(&machine, "watching /a"), 1);
        for dir in ["/a", "/c"] {
            assert_eq!(folder_of(&kept, dir).unwrap()["watching"], false, "{kept}");
        }
        let b = folder_of(&kept, "/b").unwrap();
        assert_eq!(
            (b["watching"].clone(), b["folder"].clone()),
            (false.into(), "id/b".into())
        );
        assert_eq!(folder_of(&kept, "/a").unwrap()["folder"], "id/a");
    }

    #[test]
    fn a_record_that_cannot_be_written_is_told_once_and_the_watches_go_on() {
        let machine = Machine::default();
        machine.opens("/a", vec![Ok(Goes::Lasts)]);
        let listing = listed(&["/a"]);
        let temp = tempfile::tempdir().unwrap();
        let blocked = temp.path().join("blocked");
        std::fs::write(&blocked, b"in the way").unwrap();
        let record = WatchRecord::at(blocked.join("record.json"), 7, Duration::from_millis(50));
        supervised_with(&machine, &listing, &record, |machine| {
            std::thread::sleep(Duration::from_millis(300));
            count(machine, "watching /a") == 1
        })
        .unwrap();
        let told = machine.told();
        assert_eq!(
            told.iter()
                .filter(|told| told.starts_with("record "))
                .count(),
            1,
            "{told:?}"
        );
        assert_eq!(count(&machine, "watching /a"), 1);
    }

    #[test]
    fn a_folder_that_fails_the_same_way_at_every_try_keeps_its_reason_in_the_record() {
        let machine = Machine::default();
        machine.opens("/a", vec![Ok(Goes::EndsSlowly(reason("watch")))]);
        machine.opens("/b", vec![Ok(Goes::Lasts)]);
        let listing = listed(&["/a", "/b"]);
        let temp = tempfile::tempdir().unwrap();
        let record = WatchRecord::at(temp.path().join("record.json"), 7, Duration::from_secs(5));
        let (failed, lasting) = (AtomicBool::new(false), AtomicBool::new(false));
        let recovered = Mutex::new(Vec::new());
        // No wall-clock time is allowed to recover the folder: a watch that
        // is starved for longer than a short hold would be told, rightly, as
        // having lasted, and the test would then say nothing of the order.
        let never = Timing {
            recovered: Duration::from_secs(3600),
            ..quick()
        };
        supervised_timed(&machine, &listing, &record, never, |machine| {
            if record.state_of(Path::new("/b")) == Some((true, None)) {
                lasting.store(true, Ordering::SeqCst);
            }
            let state = record.state_of(Path::new("/a"));
            match state {
                Some((_, Some(_))) => failed.store(true, Ordering::SeqCst),
                Some((_, None)) if failed.load(Ordering::SeqCst) => {
                    lock(&recovered).push(state.clone());
                }
                _ => {}
            }
            machine.opened("/a") >= 5
        })
        .unwrap();
        assert!(failed.load(Ordering::SeqCst), "the folder never failed");
        assert_eq!(
            lock(&recovered).clone(),
            Vec::<Option<(bool, Option<String>)>>::new(),
            "its watch was started again, but it had not recovered"
        );
        // The witness: a folder that lasts is shown as watched.
        assert!(lasting.load(Ordering::SeqCst));
    }

    #[test]
    fn a_retry_that_lasts_is_shown_as_watched_once_it_is_told() {
        let machine = Machine::default();
        machine.opens(
            "/a",
            vec![Ok(Goes::EndsSlowly(reason("watch"))), Ok(Goes::Lasts)],
        );
        let listing = listed(&["/a"]);
        let temp = tempfile::tempdir().unwrap();
        let record = WatchRecord::at(temp.path().join("record.json"), 7, Duration::from_secs(5));
        let failed = AtomicBool::new(false);
        supervised_with(&machine, &listing, &record, |machine| {
            let state = record.state_of(Path::new("/a"));
            if matches!(state, Some((_, Some(_)))) {
                failed.store(true, Ordering::SeqCst);
            }
            // The witness for the test above: with the hold allowed to pass,
            // the same folder is shown as watched, and its reason is gone.
            failed.load(Ordering::SeqCst)
                && state == Some((true, None))
                && count(machine, "watching /a") == 2
        })
        .unwrap();
    }

    #[test]
    fn a_folder_let_go_to_a_command_is_taken_back_once_free_while_the_others_go_on() {
        let machine = Machine::default();
        machine.opens(
            "/asked",
            vec![
                Ok(Goes::HandsOver),
                // The command holds it, then another asks as it ends.
                Err(reason("reading_handle")),
                Err(reason("reading_handle")),
                Err(Unwatched::handed_over()),
                Ok(Goes::HandsOverAtOnce),
                Err(reason("reading_handle")),
                Ok(Goes::Lasts),
            ],
        );
        machine.opens("/a", vec![Ok(Goes::Passes)]);
        let listing = listed(&["/a", "/asked"]);
        supervised(&machine, &listing, |machine| {
            count(machine, "taken back /asked") == 1
                && count(machine, "watching /a") == 1
                && count(machine, "/a reach") == 1
        })
        .unwrap();
        let asked: Vec<String> = machine
            .told()
            .into_iter()
            .filter(|told| told.contains("/asked"))
            .collect();
        assert_eq!(
            asked,
            vec!["watching /asked", "handed /asked", "taken back /asked"],
            "a folder held by the command it was let go to was said not to be watched, or let go twice"
        );
        // The witness that it was tried at every turn, though told once.
        assert_eq!(machine.opened("/asked"), 7);
        assert_eq!(count(&machine, "watching /a"), 1);
        assert_eq!(count(&machine, "/a reach"), 1);
        assert!(
            lock(&machine.ended).is_empty(),
            "a handover was taken for an end"
        );
    }

    #[test]
    fn a_folder_another_process_keeps_after_the_command_is_said_to_be_held_once() {
        let machine = Machine::default();
        machine.opens(
            "/asked",
            vec![
                Ok(Goes::HandsOver),
                // The command works it, then another process takes it.
                Err(Unwatched::handed_over()),
                Err(Unwatched::handed_over()),
                Err(reason("reading_handle")),
            ],
        );
        let listing = listed(&["/asked"]);
        let temp = tempfile::tempdir().unwrap();
        let record = WatchRecord::at(temp.path().join("record.json"), 1, Duration::from_secs(5));
        supervised_with(&machine, &listing, &record, |machine| {
            count(machine, "unwatched /asked reading_handle") == 1 && machine.opened("/asked") > 12
        })
        .unwrap();
        assert_eq!(
            machine.told(),
            vec![
                "watching /asked",
                "handed /asked",
                "unwatched /asked reading_handle"
            ],
            "a folder another process keeps was said to be let go to a command for ever"
        );
        assert_eq!(
            record.state_of(Path::new("/asked")),
            Some((false, Some("reading_handle".to_string())))
        );
    }

    #[test]
    fn a_folder_let_go_and_taken_back_is_said_to_be_let_go_again() {
        let machine = Machine::default();
        machine.opens(
            "/asked",
            vec![Ok(Goes::HandsOver), Ok(Goes::HandsOver), Ok(Goes::Lasts)],
        );
        let listing = listed(&["/asked"]);
        supervised(&machine, &listing, |machine| {
            count(machine, "taken back /asked") == 2
        })
        .unwrap();
        assert_eq!(
            machine.told(),
            vec![
                "watching /asked",
                "handed /asked",
                "taken back /asked",
                "handed /asked",
                "taken back /asked",
            ]
        );
    }

    #[test]
    fn a_folder_let_go_that_the_command_took_off_the_registry_leaves_unsaid() {
        let gate = Arc::new(OpenGate::default());
        let machine = Machine {
            open_gate: Some((PathBuf::from("/asked"), 2, Arc::clone(&gate))),
            ..Machine::default()
        };
        machine.opens(
            "/asked",
            vec![
                Ok(Goes::HandsOver),
                Err(reason("reading_handle")),
                Err(reason("invalid")),
            ],
        );
        machine.opens("/a", vec![Ok(Goes::Lasts)]);
        let listing = listed(&["/a", "/asked"]);
        supervised(&machine, &listing, |machine| {
            if gate.ready.load(Ordering::SeqCst) {
                // The command removes the folder before its held open returns.
                *lock(&listing) = listing_of(&["/a"]);
            }
            count(machine, "left /asked") == 1 && count(machine, "watching /a") == 1
        })
        .unwrap();
        assert_eq!(count(&machine, "handed /asked"), 1);
        assert_eq!(count(&machine, "left /asked"), 1);
        assert_eq!(
            machine.opened("/asked"),
            2,
            "the removed folder was reopened"
        );
        assert_eq!(
            machine.opened("/a"),
            1,
            "the neighboring watch was restarted"
        );
        assert_eq!(count(&machine, "watching /a"), 1);
        assert_eq!(count(&machine, "left /a"), 0);
        assert!(
            machine
                .told()
                .iter()
                .all(|told| !told.starts_with("unwatched")),
            "{:?}",
            machine.told()
        );
    }

    #[test]
    fn a_folder_a_command_asks_for_as_the_watch_begins_is_said_once_and_watched_after() {
        let machine = Machine::default();
        machine.opens(
            "/asked",
            vec![
                Err(Unwatched::handed_over()),
                Err(reason("reading_handle")),
                Ok(Goes::Lasts),
            ],
        );
        let listing = listed(&["/asked"]);
        supervised(&machine, &listing, |machine| {
            count(machine, "watching /asked") == 1
        })
        .unwrap();
        assert_eq!(
            machine.told(),
            vec!["unwatched /asked handed_over", "watching /asked"]
        );
    }

    #[test]
    fn a_listed_directory_with_no_store_is_said_to_be_no_folder() {
        let temp = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let dir = temp.path().join("notes");
        std::fs::create_dir_all(dir.join(STATE_DIR)).unwrap();
        let Err(error) = recorded(&dir) else {
            panic!("a directory with an empty state directory read as a folder");
        };
        let said = Unwatched::of(&error);
        assert_eq!(said.code, "invalid", "{said:?}");
        assert!(said.message.contains("is not a folder"), "{said:?}");
    }
}
