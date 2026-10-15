//! One watch over every folder a machine's registry lists.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::{Scope, ScopedJoinHandle};
use std::time::{Duration, Instant};

use super::registry::Registry;
use super::watch::{WatchError, WatchEvent};
use super::{Folder, STATE_DIR, first};
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

/// How long a folder tried again is watched before it is said to be watched,
/// so one that fails the same way at every try is said to fail once.
const RECOVERED: Duration = Duration::from_secs(10);

const POLL: Duration = Duration::from_millis(100);

/// Why a listed folder is not watched.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Unwatched {
    /// The error code, such as `first_sync_waiting`, `reading_handle` or
    /// `unauthorized`, or `watch` where the watch itself failed.
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
    /// The folder at `dir` is not watched, for `reason`, and is tried again.
    /// Told once for as long as the reason stays the same.
    Unwatched {
        dir: &'a Path,
        reason: &'a Unwatched,
    },
    /// The registry no longer lists the folder at `dir`, and its watch ended.
    Left { dir: &'a Path },
    /// The registry lists no folder. Told once each time it comes to.
    NoFolders,
    /// The registry cannot be read, for `Some` reason, and the folders watched
    /// go on as they are; or it reads again, for `None`. Told only when it
    /// changes.
    Registry(Option<&'a str>),
}

/// What [`watch_every`] asks of its caller.
pub trait EveryFolder: Sync {
    type Error: Send;

    /// Opens the folder at `dir` with the server and credential it follows.
    /// `origin` is the server its copy was hydrated from, where it has been.
    fn open(&self, dir: &Path, origin: Option<&str>) -> Result<Folder, Unwatched>;

    /// An error ends the watch of every folder.
    fn tell(&self, event: Every<'_>) -> Result<(), Self::Error>;
}

/// Keeps every folder `registry` lists in step until `stop` is raised, each
/// with a watch of its own on a thread of its own. The registry is read again
/// every few seconds: a folder it comes to list is watched, and the watch of
/// one it no longer lists ends. A folder that cannot be watched is told once
/// and tried again, and the others go on.
pub fn watch_every<W: EveryFolder>(
    registry: &Registry,
    stop: &AtomicBool,
    every: &W,
) -> Result<(), W::Error> {
    supervise(|| read(registry), stop, &Machine(every), Timing::default())
}

fn read(registry: &Registry) -> Listing {
    match registry.read() {
        Ok(Some(listed)) => Listing::Listed(listed.into_iter().map(|entry| entry.dir).collect()),
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
    let core = Core::read_directory(&state_dir, &root.join(STATE_DIR).join("core.sqlite"))?;
    let conn = core.conn()?;
    Ok(Recorded {
        origin: store::meta_get(&conn, store::META_SERVER_ORIGIN)?,
        first_sync_waiting: first::waiting(&conn)?,
    })
}

#[derive(Clone)]
enum Listing {
    Listed(Vec<PathBuf>),
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
    recovered: Duration,
}

impl Default for Timing {
    fn default() -> Timing {
        Timing {
            poll: POLL,
            reread: REREAD,
            unopened: RETRY_UNOPENED,
            ended: RETRY_ENDED,
            recovered: RECOVERED,
        }
    }
}

/// A folder as the supervisor runs it, apart from how it is opened.
trait Watched: Sync {
    fn watch<E>(
        &self,
        stop: &AtomicBool,
        tell: impl FnMut(WatchEvent) -> Result<(), E>,
    ) -> Result<(), WatchError<E>>;
}

impl Watched for Folder {
    fn watch<E>(
        &self,
        stop: &AtomicBool,
        tell: impl FnMut(WatchEvent) -> Result<(), E>,
    ) -> Result<(), WatchError<E>> {
        Folder::watch(self, stop, tell)
    }
}

trait Supervised: Sync {
    type Folder: Watched;
    type Error: Send;
    fn open(&self, dir: &Path) -> Result<Self::Folder, Unwatched>;
    fn tell(&self, event: Every<'_, Self::Folder>) -> Result<(), Self::Error>;
}

struct Machine<'a, W>(&'a W);

impl<W: EveryFolder> Supervised for Machine<'_, W> {
    type Folder = Folder;
    type Error = W::Error;

    fn open(&self, dir: &Path) -> Result<Folder, Unwatched> {
        let recorded = recorded(dir).map_err(|error| Unwatched::of(&error))?;
        // Read without claiming the folder, so a person confirming it is
        // never refused because the watch holds it for a moment.
        if recorded.first_sync_waiting {
            return Err(Unwatched::of(&CoreError::FirstSyncWaiting));
        }
        self.0.open(dir, recorded.origin.as_deref())
    }

    fn tell(&self, event: Every<'_>) -> Result<(), W::Error> {
        self.0.tell(event)
    }
}

/// How the start of a folder's watch is told.
struct Start {
    /// Held back until the watch lasts or tells something else, for a folder
    /// tried again after it was said not to be watched.
    quiet: bool,
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
    timing: Timing,
) -> Result<(), S::Error> {
    std::thread::scope(|scope| {
        let mut entries: BTreeMap<PathBuf, Entry<'_, S::Error>> = BTreeMap::new();
        let mut unread: Option<String> = None;
        let mut none_said = false;
        let mut next_read = Instant::now();
        let watched = loop {
            if stop.load(Ordering::SeqCst) {
                break Ok(());
            }
            if let Err(error) = reap(&mut entries, every, stop, timing) {
                break Err(error);
            }
            if Instant::now() >= next_read {
                next_read = Instant::now() + timing.reread;
                let read = reconcile(list(), &mut entries, every, &mut unread, &mut none_said);
                if let Err(error) = read {
                    break Err(error);
                }
            }
            if let Err(error) = start_due(scope, &mut entries, every, timing) {
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
        watched
    })
}

/// Takes in the watches that ended, and decides what comes of each.
fn reap<S: Supervised>(
    entries: &mut BTreeMap<PathBuf, Entry<'_, S::Error>>,
    every: &S,
    stop: &AtomicBool,
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
        if lock(&start).said == Said::Told {
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
            every.tell(Every::Left { dir: &dir })?;
            continue;
        }
        let (reason, wait) = match ended {
            // Raised for a folder the registry lists again since: it starts
            // again at once.
            Outcome::Stopped if own.load(Ordering::SeqCst) || stop.load(Ordering::SeqCst) => {
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
            Outcome::Ended(reason) => (reason, timing.ended),
            Outcome::Told(_) => unreachable!("a failed tell ended the watch above"),
        };
        entry.run = Run::Waiting { until: now + wait };
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
    for dir in &listed {
        entries
            .entry(dir.clone())
            .and_modify(|entry| entry.leaving = false)
            .or_insert(Entry {
                run: Run::Waiting { until: now },
                told: None,
                leaving: false,
            });
    }
    let unlisted: Vec<PathBuf> = entries
        .keys()
        .filter(|dir| !listed.contains(dir))
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
    timing: Timing,
) -> Result<(), S::Error> {
    let now = Instant::now();
    for (dir, entry) in entries.iter_mut() {
        match &entry.run {
            Run::Waiting { until } if *until <= now && !entry.leaving => {
                let stop = Arc::new(AtomicBool::new(false));
                let start = Arc::new(Mutex::new(Start {
                    quiet: entry.told.is_some(),
                    said: Said::NotYet,
                }));
                let handle = {
                    let (dir, stop, start) = (dir.clone(), Arc::clone(&stop), Arc::clone(&start));
                    scope.spawn(move || run(every, &dir, &stop, &start))
                };
                entry.run = Run::Watching {
                    stop,
                    start,
                    handle,
                };
            }
            Run::Watching { start, .. } => {
                let mut start = lock(start);
                if let Said::Held(at) = start.said
                    && now.duration_since(at) >= timing.recovered
                {
                    every.tell(Every::Watching { dir })?;
                    start.said = Said::Told;
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
    dir: &Path,
    stop: &AtomicBool,
    start: &Mutex<Start>,
) -> Outcome<S::Error> {
    let folder = match every.open(dir) {
        Ok(folder) => folder,
        Err(reason) => return Outcome::Unopened(reason),
    };
    let watched = folder.watch(stop, |event| {
        {
            let mut start = lock(start);
            if matches!(event, WatchEvent::Watching { .. }) {
                if start.quiet {
                    start.said = Said::Held(Instant::now());
                    return Ok(());
                }
                every.tell(Every::Watching { dir })?;
                start.said = Said::Told;
                return Ok(());
            }
            if matches!(start.said, Said::Held(_)) {
                every.tell(Every::Watching { dir })?;
                start.said = Said::Told;
            }
        }
        every.tell(Every::Folder {
            dir,
            folder: &folder,
            event,
        })
    });
    match watched {
        Ok(()) => Outcome::Stopped,
        Err(error) => match Unwatched::ended(error) {
            Ok(reason) => Outcome::Ended(reason),
            Err(told) => Outcome::Told(told),
        },
    }
}

#[cfg(test)]
mod tests {
    use std::collections::{HashMap, VecDeque};

    use super::*;

    /// How a fake folder's watch goes once it is open.
    #[derive(Clone)]
    enum Goes {
        /// Until its stop.
        Lasts,
        /// Ends with this, after telling it is watched.
        Ends(Unwatched),
        /// Tells a pass, then lasts.
        Passes,
        Panics,
    }

    struct Fake {
        goes: Goes,
    }

    impl Watched for Fake {
        fn watch<E>(
            &self,
            stop: &AtomicBool,
            mut tell: impl FnMut(WatchEvent) -> Result<(), E>,
        ) -> Result<(), WatchError<E>> {
            tell(WatchEvent::Watching {
                dir: PathBuf::from("/resolved"),
            })
            .map_err(WatchError::Told)?;
            match &self.goes {
                Goes::Ends(reason) => {
                    return Err(WatchError::Unwatchable(reason.message.clone()));
                }
                Goes::Panics => panic!("a folder's watch panicked"),
                Goes::Passes => {
                    tell(WatchEvent::Reach(None)).map_err(WatchError::Told)?;
                }
                Goes::Lasts => {}
            }
            while !stop.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(2));
            }
            Ok(())
        }
    }

    /// Each folder's opens in turn, the last repeating, and what was told.
    #[derive(Default)]
    struct Machine {
        opens: Mutex<HashMap<PathBuf, VecDeque<Result<Goes, Unwatched>>>>,
        opened: Mutex<Vec<PathBuf>>,
        told: Mutex<Vec<String>>,
        refuse_telling: AtomicBool,
    }

    impl Machine {
        fn opens(&self, dir: &str, opens: Vec<Result<Goes, Unwatched>>) {
            lock(&self.opens).insert(PathBuf::from(dir), opens.into());
        }

        fn told(&self) -> Vec<String> {
            lock(&self.told).clone()
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

        fn open(&self, dir: &Path) -> Result<Fake, Unwatched> {
            lock(&self.opened).push(dir.to_path_buf());
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
                Every::Unwatched { dir, reason } => {
                    format!("unwatched {} {}", dir.display(), reason.code)
                }
                Every::Left { dir } => format!("left {}", dir.display()),
                Every::NoFolders => "no folders".into(),
                Every::Registry(reason) => format!("registry {reason:?}"),
            };
            lock(&self.told).push(said);
            Ok(())
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
            recovered: Duration::from_millis(150),
        }
    }

    /// Runs the supervisor over the listing `listed` gives until `until`
    /// holds or a bound passes, then stops it and answers what it returned.
    fn supervised(
        machine: &Machine,
        listed: &Mutex<Listing>,
        until: impl Fn(&Machine) -> bool,
    ) -> Result<(), String> {
        let stop = AtomicBool::new(false);
        std::thread::scope(|scope| {
            let running =
                scope.spawn(|| supervise(|| lock(listed).clone(), &stop, machine, quick()));
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

    fn listed(dirs: &[&str]) -> Mutex<Listing> {
        Mutex::new(Listing::Listed(dirs.iter().map(PathBuf::from).collect()))
    }

    fn count(machine: &Machine, line: &str) -> usize {
        machine.told().iter().filter(|told| *told == line).count()
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
            count(machine, "watching /held") == 1
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
                *lock(&listing) = Listing::Listed(Vec::new());
            }
            if count(machine, "left /a") == 1 {
                *lock(&listing) = Listing::Listed(vec![PathBuf::from("/a")]);
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
                *lock(&listing) = Listing::Listed(vec![PathBuf::from("/b")]);
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
                *lock(&listing) = Listing::Listed(vec![PathBuf::from("/a")]);
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
                *lock(&listing) = Listing::Listed(vec![PathBuf::from("/a")]);
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
        let ended = std::thread::scope(|scope| {
            let running =
                scope.spawn(|| supervise(|| lock(&listing).clone(), &stop, &machine, quick()));
            while machine.told().len() < 2 {
                std::thread::sleep(Duration::from_millis(2));
            }
            machine.refuse_telling.store(true, Ordering::SeqCst);
            // Telling that the folder left meets the closed output.
            *lock(&listing) = Listing::Listed(vec![PathBuf::from("/a")]);
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
            count(machine, "unwatched /b watch") == 1 && count(machine, "watching /b") == 2
        })
        .unwrap();
        assert_eq!(count(&machine, "watching /a"), 1);
    }
}
