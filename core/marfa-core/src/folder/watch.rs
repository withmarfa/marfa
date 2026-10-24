use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, mpsc};
use std::time::{Duration, Instant};

use notify::{EventKind, RecursiveMode, Watcher};

use super::handover::{self, Requests};
use super::lists::Lists;
use super::{
    Drained, Flagged, Folder, PullReport, SETTINGS_FILE, STATE_DIR, ScanReport, SettingsFileReport,
    StorageCause, Uncarried, Unsure,
};
use crate::error::CoreError;

/// An editor saves a file in several steps; a scan between two of them
/// would push a half-written file.
const SETTLE: Duration = Duration::from_millis(250);

/// Nothing on the filesystem marks a journaled delete's grace running out.
/// A tick starts a pass only while the last one left such work.
const TICK: Duration = Duration::from_secs(1);

/// Finds a change that size and time did not show.
const FULL_PASS: Duration = Duration::from_secs(60);

/// A file written more often than `SETTLE`, a log say, would otherwise hold
/// off every pass for as long as it is written.
const HELD_MOST: Duration = Duration::from_secs(5);

const RETRY_FIRST: Duration = Duration::from_secs(1);

/// The longest a watch waits before trying a failed hydration again, unless
/// the server names a longer wait.
pub const RETRY_MOST: Duration = Duration::from_secs(30);

/// What a watch tells its caller, each when it happens.
#[derive(Debug, Clone)]
pub enum WatchEvent {
    /// The directory is watched, as its resolved path, and passes begin.
    /// `storage` says why it is in cloud-synced or network storage, where it
    /// is.
    Watching {
        dir: PathBuf,
        storage: Option<StorageCause>,
    },
    /// The filesystem reported an error; the watch goes on.
    WatcherFailed(String),
    /// A hydration failed and is tried again after `wait`, which doubles
    /// after each failure up to `RETRY_MOST`, or a pull met a copy changing
    /// under it and the next pass, after `wait`, pulls again. Told once for
    /// each run of failures.
    Retrying { error: CoreError, wait: Duration },
    /// The server cannot be reached, for `Some` reason, or answers again,
    /// for `None`. Told only when it changes.
    Reach(Option<String>),
    /// The folder's directory is gone, and the watch waits for it to come
    /// back. Told once for as long as it stays gone.
    Waiting {
        settings: SettingsFileReport,
        scan: Box<ScanReport>,
    },
    /// A pass that did something, or whose standing conditions differ from
    /// the pass before it.
    Passed(Box<WatchPass>),
}

/// One pass of a watch: the settings edit sent, the scan, the drain and the
/// pull.
#[derive(Debug, Clone)]
pub struct WatchPass {
    pub settings: SettingsFileReport,
    pub scan: ScanReport,
    pub drain: Drained,
    pub pull: PullReport,
    /// The files the scan and the pull held, each once.
    pub flagged: Vec<Flagged>,
    /// The embeds the pass found, with those a quick pass, which reads no
    /// unchanged file, carries from the pass before.
    pub embeds: Vec<Flagged>,
    /// Whether the count of placements the server refused differs from the
    /// pass before.
    pub unplaced_changed: bool,
    /// Whether why the drain stopped differs from the pass before.
    pub stopped_changed: bool,
    /// Whether anything a pass says on a line of its own while it stands, a
    /// refused secret or a held file say, differs from the pass before. A
    /// pass that did something else says them again only where it does.
    pub notices_changed: bool,
}

/// How a watch ended where nothing went wrong.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WatchEnd {
    /// Its stop was raised.
    Stopped,
    /// A command asked for the folder, and the watch stopped at the end of
    /// a step of its pass. The caller drops the folder, so the command can
    /// take it, and opens it again once the command lets it go.
    HandedOver,
}

/// Why a watch ended other than by its stop.
#[derive(Debug)]
pub enum WatchError<E> {
    /// The server refused the credential, so nothing the watch sends can
    /// land until a working one replaces it.
    CredentialRefused(CoreError),
    /// The server's changes stopped reaching the folder.
    FollowEnded(CoreError),
    /// The directory could not be watched, or the follow ended in a fault.
    Unwatchable(String),
    /// A pass failed.
    Core(CoreError),
    /// The caller's `tell` failed.
    Told(E),
}

impl<E> From<CoreError> for WatchError<E> {
    fn from(error: CoreError) -> Self {
        WatchError::Core(error)
    }
}

#[derive(Default)]
struct FollowHealth {
    generation: u64,
    consumed: u64,
    live: bool,
}

impl FollowHealth {
    fn observe(&mut self, live: bool) {
        self.live = live;
        if live {
            self.generation = self.generation.saturating_add(1);
        }
    }

    fn available(&self) -> bool {
        self.live && self.generation > self.consumed
    }
}

enum Wake {
    File(notify::Result<notify::Event>),
    Server,
    Retrying(CoreError, Duration),
    /// Why the server cannot be reached, or `None` where it answers again.
    Reach(Option<String>),
    Ended(CoreError),
    /// A command asks for the folder.
    Asked,
}

impl Folder {
    /// Keeps the folder in step until `stop` is raised: each change on disk
    /// the folder takes, once it settles, and each change on the server starts
    /// a pass. A pass also runs every second while the last one left work that
    /// time alone moves on, such as a delete's grace running out, and a full
    /// one every minute. A pass under way when `stop` is raised finishes
    /// first.
    pub fn watch<E>(
        &self,
        stop: &AtomicBool,
        tell: impl FnMut(WatchEvent) -> Result<(), E>,
    ) -> Result<(), WatchError<E>> {
        self.watching(stop, None, tell).map(|_| ())
    }

    /// `watch`, but a command asking for the folder, as `open_asking` does,
    /// ends it with `WatchEnd::HandedOver` once the step of the pass under
    /// way ends, and at once where one asks as it starts.
    pub fn watch_handing_over<E>(
        &self,
        stop: &AtomicBool,
        tell: impl FnMut(WatchEvent) -> Result<(), E>,
    ) -> Result<WatchEnd, WatchError<E>> {
        let mut requests = Requests::of(&self.state_dir);
        if requests.asked() {
            return Ok(WatchEnd::HandedOver);
        }
        self.watching(stop, Some(requests), tell)
    }

    fn watching<E>(
        &self,
        stop: &AtomicBool,
        requests: Option<Requests>,
        mut tell: impl FnMut(WatchEvent) -> Result<(), E>,
    ) -> Result<WatchEnd, WatchError<E>> {
        // Only a person's go-ahead lets it write or send, and none can reach
        // a folder this watch holds.
        self.refuse_while_waiting()?;
        // Raised as the passes end, whatever ended them, so the follow and a
        // hydration it runs end with them.
        let ended = AtomicBool::new(false);
        let asked = AtomicBool::new(false);
        let (sender, wakes) = mpsc::channel::<Wake>();
        let health = Mutex::new(FollowHealth::default());
        std::thread::scope(|scope| {
            let server_wakes = sender.clone();
            let follower = scope.spawn(|| follow(self, &ended, server_wakes, &health));
            let reporter = scope.spawn(|| self.health_follow(&ended));
            let looker = requests.map(|requests| {
                let (wakes, ended, asked) = (sender.clone(), &ended, &asked);
                scope.spawn(move || look(requests, ended, asked, wakes))
            });
            let watched = {
                // A guard, so a pass or a `tell` that panics still ends the
                // follow: the scope waits for it before the panic goes on.
                let _ending = Raise(&ended);
                self.watch_files(stop, &asked, sender, &wakes, &mut tell, &health)
            };
            if let Some(looker) = looker {
                looker.join().map_err(|_| {
                    WatchError::Unwatchable(
                        "looking for a command asking for the folder ended in a fault".into(),
                    )
                })?;
            }
            reporter.join().map_err(|_| {
                WatchError::Unwatchable("folder health reporting ended in a fault".into())
            })?;
            let followed = follower.join().map_err(|_| {
                WatchError::Unwatchable(
                    "the follow of the server's changes ended in a fault".into(),
                )
            })?;
            watched.and_then(|end| followed.map(|()| end).map_err(WatchError::Core))
        })
    }

    fn watch_files<E>(
        &self,
        stop: &AtomicBool,
        asked: &AtomicBool,
        sender: mpsc::Sender<Wake>,
        events: &mpsc::Receiver<Wake>,
        tell: &mut impl FnMut(WatchEvent) -> Result<(), E>,
        health: &Mutex<FollowHealth>,
    ) -> Result<WatchEnd, WatchError<E>> {
        let absolute = std::path::absolute(&self.root)
            .map_err(|error| WatchError::Unwatchable(error.to_string()))?;
        let dir = &absolute;
        let mut watcher = notify::recommended_watcher(move |event| {
            let _ = sender.send(Wake::File(event));
        })
        .map_err(|error| WatchError::Unwatchable(format!("cannot watch: {error}")))?;
        // Before the first pass, so a file arriving during it is not missed.
        watcher
            .watch(dir, RecursiveMode::Recursive)
            .map_err(|error| {
                WatchError::Unwatchable(format!("cannot watch {}: {error}", dir.display()))
            })?;
        tell(WatchEvent::Watching {
            dir: dir.clone(),
            storage: self.storage_cause(),
        })
        .map_err(WatchError::Told)?;

        let mut gate = Gate::new(crate::clock::now());
        let mut telling = Telling::default();
        let mut last_full: Option<Instant> = None;
        let mut send_again_at = self.kept_wait();
        let mut lists = self.settings().and_then(|settings| settings.lists()).ok();
        // Whether anything has happened since the last pass began that it
        // did not see.
        let mut changed = true;
        loop {
            if stop.load(Ordering::SeqCst) {
                break;
            }
            if asked.load(Ordering::SeqCst) {
                return Ok(WatchEnd::HandedOver);
            }
            #[cfg(debug_assertions)]
            crate::fault::hold(|| "folder-watch-turn");
            match crate::clock::recv_timeout(events, stop, TICK) {
                Ok(Wake::File(Ok(event))) => {
                    // `Access` is an open or the close after a write, which has
                    // already shown itself as a modify.
                    let passed_over = matches!(event.kind, EventKind::Access(_))
                        || event.paths.iter().all(|path| {
                            !settings_file(dir, path)
                                && match &lists {
                                    Some(lists) => unreached(lists, dir, path),
                                    None => dot_led(dir, path),
                                }
                        });
                    if !passed_over {
                        changed = true;
                        gate.changed(crate::clock::now());
                        #[cfg(debug_assertions)]
                        crate::fault::hold(|| "folder-file-changed");
                        telling.health_changed = true;
                    } else if !gate.passed_over_is_due(crate::clock::now()) {
                        continue;
                    }
                }
                Ok(Wake::File(Err(error))) => {
                    tell(WatchEvent::WatcherFailed(error.to_string())).map_err(WatchError::Told)?;
                }
                Ok(Wake::Server) => {
                    changed = true;
                    telling.health_changed = true;
                }
                Ok(Wake::Retrying(error, wait)) => {
                    tell(WatchEvent::Retrying { error, wait }).map_err(WatchError::Told)?;
                }
                Ok(Wake::Reach(lost)) => {
                    changed = true;
                    if let Some(event) = telling.reach(lost) {
                        tell(event).map_err(WatchError::Told)?;
                    }
                }
                Ok(Wake::Ended(error @ CoreError::Unauthorized { .. })) => {
                    return Err(WatchError::CredentialRefused(error));
                }
                Ok(Wake::Ended(error)) => return Err(WatchError::FollowEnded(error)),
                Ok(Wake::Asked) => continue,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
            // No "was there a change" flag: it would stop the journal being
            // swept in a folder that went quiet after a delete.
            // No pass runs while the server's rate limit lasts, since a write
            // sent before it ends is refused again: changes on disk wait
            // unscanned and nothing is pulled.
            if send_again_at.is_some_and(|at| crate::clock::now() < at)
                || !gate.due(crate::clock::now())
            {
                continue;
            }
            let full = full_due(last_full, crate::clock::now());
            // A tick alone moves nothing on a folder the last pass left at
            // rest: a pass renders every file, so it is not run to find out.
            if !full && !changed && telling.at_rest {
                continue;
            }
            changed = false;
            if full {
                last_full = Some(crate::clock::now());
            }
            #[cfg(debug_assertions)]
            crate::fault::hold(|| "folder-pass-start");
            let passed = self.pass(full, asked, &mut telling, tell, health);
            if let Err(WatchError::Core(error) | WatchError::CredentialRefused(error)) = &passed {
                self.health_observe(false, full, None, Some(error), false);
            }
            match passed {
                Err(WatchError::Core(error)) if hydrated_by_the_follow(&error) => {}
                // The follow kept changing the copy under the pull; the next
                // pass reads it again.
                Err(WatchError::Core(error)) if super::copy_changed(&error) => {
                    if let Some(event) = telling.unsettled(&error) {
                        tell(event).map_err(WatchError::Told)?;
                    }
                    continue;
                }
                other => send_again_at = other?.map(|wait| crate::clock::now() + wait),
            }
            telling.settled();
            gate.passed(crate::clock::now());
            #[cfg(debug_assertions)]
            crate::fault::hold(|| "folder-pass-ended");
            lists = self.settings().and_then(|settings| settings.lists()).ok();
        }
        Ok(WatchEnd::Stopped)
    }

    /// Ends early, telling nothing, where a command asks for the folder: each
    /// step has committed what it did, so the next pass, or the command,
    /// takes up from there.
    fn pass<E>(
        &self,
        full: bool,
        asked: &AtomicBool,
        telling: &mut Telling,
        tell: &mut impl FnMut(WatchEvent) -> Result<(), E>,
        health: &Mutex<FollowHealth>,
    ) -> Result<Option<Duration>, WatchError<E>> {
        let asking = || asked.load(Ordering::SeqCst);
        telling.at_rest = false;
        let settings = self.send_settings_edit()?;
        if asking() {
            return Ok(None);
        }
        #[cfg(debug_assertions)]
        crate::fault::hold(|| {
            if full {
                "folder-full-scan"
            } else {
                "folder-quick-scan"
            }
        });
        let scan = self.scan_watching(full, SETTLE)?;
        // Told once, and every tick looks again, so the watch goes on where
        // it left off once the directory is back.
        if scan.root_gone.is_some() {
            self.health_observe(false, full, None, None, false);
            if let Some(event) = telling.waiting(settings, scan) {
                tell(event).map_err(WatchError::Told)?;
            }
            return Ok(None);
        }
        if asking() {
            return Ok(None);
        }
        let generation = health.lock().expect("follow health lock").generation;
        let drain = self.drain_in(true)?;
        let reached = match &drain.report.unavailable {
            Some(why) => telling.reach(Some(why.clone())),
            None if drain.report.answered > 0 => telling.reach(None),
            None => None,
        };
        if let Some(event) = reached {
            tell(event).map_err(WatchError::Told)?;
        }
        if asking() {
            return Ok(None);
        }
        #[cfg(debug_assertions)]
        crate::fault::hold(|| "folder-pass-pull");
        let pull = self.pull()?;
        let problem = drain
            .report
            .unavailable
            .as_ref()
            .map(|_| CoreError::Network("unavailable".into()))
            .or_else(|| credential_refused(&drain))
            .or_else(|| {
                telling
                    .unreachable
                    .then(|| CoreError::Network("unavailable".into()))
            });
        let mut progress = health.lock().expect("follow health lock");
        let complete = full
            && progress.available()
            && progress.generation == generation
            && problem.is_none()
            && drain.report.unavailable.is_none()
            && drain.report.stopped.is_none()
            && drain.report.undelivered == 0
            && drain.report.unsent == 0
            && drain.report.held == 0
            && drain.report.unmade == 0
            && !scan
                .directories
                .iter()
                .any(|entry| matches!(entry.flag, "unreadable" | "gone"));
        let event = telling.passed(
            full,
            settings.clone(),
            scan.clone(),
            drain.clone(),
            pull.clone(),
        );
        if full || event.is_some() || telling.health_changed {
            self.health_observe(
                complete,
                full,
                Some(&pull),
                problem.as_ref(),
                settings.flagged.is_some()
                    || settings.unwritten.is_some()
                    || pull.settings.flagged.is_some()
                    || pull.settings.unwritten.is_some(),
            );
            telling.health_changed = false;
        }
        if complete {
            progress.consumed = generation;
        }
        drop(progress);
        let refused = credential_refused(&drain);
        let wait = rate_limit_wait(&drain.report);
        telling.at_rest = wait.is_none()
            && refused.is_none()
            && problem.is_none()
            && !telling.unreachable
            && !stirred(&settings, &scan, &drain, &pull)
            && scan.settling.is_empty()
            && scan.missing == 0
            && scan.waiting == 0
            && scan.paused == 0
            && scan.unsure.is_empty()
            && pull.paused == 0
            && pull.kept == 0
            && pull.elsewhere == 0
            && drain.rebased == 0
            && drain.report.unavailable.is_none()
            && drain.report.stopped.is_none()
            && drain.report.undelivered == 0
            && drain.report.unsent == 0
            && drain.report.held == 0
            && drain.report.unmade == 0
            && self
                .unread_give_ways
                .lock()
                .expect("give-way lock")
                .is_empty();
        if let Some(event) = event {
            tell(event).map_err(WatchError::Told)?;
        }
        refused.map_or(Ok(wait), |error| Err(WatchError::CredentialRefused(error)))
    }
}

/// The write the drain stopped at says why: only a refused credential ends
/// the watch, as it ends a one-off command.
fn credential_refused(drain: &Drained) -> Option<CoreError> {
    let credential = drain
        .report
        .verdicts
        .last()
        .is_some_and(|verdict| verdict.reason.as_deref() == Some("credential_refused"));
    drain
        .report
        .stopped
        .as_ref()
        .filter(|_| credential)
        .map(|stopped| CoreError::Unauthorized {
            code: "unauthorized".into(),
            message: stopped.clone(),
        })
}

/// Raises its flag when dropped, unwinding included.
pub(super) struct Raise<'a>(pub(super) &'a AtomicBool);

impl Drop for Raise<'_> {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

fn follow(
    folder: &Folder,
    ended: &AtomicBool,
    wakes: mpsc::Sender<Wake>,
    health: &Mutex<FollowHealth>,
) -> Result<(), CoreError> {
    let mut retry = RETRY_FIRST;
    // Told once for each run of failures, as the reachability is.
    let mut said = false;
    // Carried into the next follow, which otherwise says nothing of a server
    // it has at once, and the watch would go on telling it unreachable.
    let mut unreachable = false;
    while !ended.load(Ordering::SeqCst) {
        let followed = folder.resume_until(ended).and_then(|hydrated| {
            retry = RETRY_FIRST;
            said = false;
            if hydrated.is_some() {
                let _ = wakes.send(Wake::Server);
            }
            folder.core().follow_observed(
                ended,
                unreachable,
                |change| {
                    let _ = wakes.send(match &change.event {
                        crate::ChangeEvent::ServerUnreachable(reason) => {
                            unreachable = true;
                            Wake::Reach(Some(reason.to_string()))
                        }
                        crate::ChangeEvent::ServerReachable => {
                            unreachable = false;
                            Wake::Reach(None)
                        }
                        _ => Wake::Server,
                    });
                },
                |live| {
                    health.lock().expect("follow health lock").observe(live);
                },
            )
        });
        match followed {
            Ok(_) => break,
            Err(CoreError::Canceled) if ended.load(Ordering::SeqCst) => break,
            Err(CoreError::CopyExpired { .. }) => {}
            Err(error) if error.is_environmental() => {
                let (wait, next) = retry_schedule(retry, &error);
                if !said {
                    let _ = wakes.send(Wake::Retrying(error, wait));
                    said = true;
                }
                wait_unless_stopped(ended, wait);
                retry = next;
            }
            Err(error) => {
                let _ = wakes.send(Wake::Ended(error.clone()));
                return Err(error);
            }
        }
    }
    Ok(())
}

/// Raises `asked` once a command asks for the folder, and wakes the watch.
fn look(mut requests: Requests, ended: &AtomicBool, asked: &AtomicBool, wakes: mpsc::Sender<Wake>) {
    while !ended.load(Ordering::SeqCst) {
        if requests.asked() {
            asked.store(true, Ordering::SeqCst);
            let _ = wakes.send(Wake::Asked);
            return;
        }
        wait_unless_stopped(ended, handover::LOOK);
    }
}

/// Where the folder's store keeps, in milliseconds since the Unix epoch on the
/// engine's wall clock, the time before which the server asked for no write.
/// Kept in the store rather than the watch, so a watch that hands its folder
/// to a command, and is started again, waits out what the server last said.
const SEND_AGAIN_AT: &str = "folder_send_again_at";

impl Folder {
    /// Keeps the wait a drain of this folder was told, whoever drained: a
    /// later answer replaces an earlier one, and a later drain with no wait
    /// ends it where the server took writes or writes were left undelivered
    /// (`folders/watch-rate-limit-handover`).
    pub(super) fn keep_wait(&self, drain: &crate::DrainReport) -> Result<(), CoreError> {
        let conn = self.core.conn()?;
        if let Some(wait) = rate_limit_wait(drain) {
            let until = crate::clock::system_time() + wait;
            let millis = until
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |since| since.as_millis());
            crate::store::meta_set(&conn, SEND_AGAIN_AT, &millis.to_string())
        } else if drain.retry_after_seconds.is_none()
            && (drain.answered > 0 || drain.undelivered > 0)
        {
            crate::store::meta_delete(&conn, SEND_AGAIN_AT)
        } else {
            Ok(())
        }
    }

    /// When the wait the store keeps ends on the clock the watch runs by.
    /// Never further off than the longest wait a drain keeps, so a wall
    /// clock set back cannot hold the watch.
    fn kept_wait(&self) -> Option<Instant> {
        let conn = self.core.conn().ok()?;
        let millis: u64 = crate::store::meta_get(&conn, SEND_AGAIN_AT)
            .ok()??
            .parse()
            .ok()?;
        let until = std::time::UNIX_EPOCH + Duration::from_millis(millis);
        let left = until.duration_since(crate::clock::system_time()).ok()?;
        Some(crate::clock::now() + left.min(crate::error::RETRY_AFTER_MOST))
    }
}

/// How long the server asked the watch to leave its writes alone, where a
/// pass left some undelivered: no pass runs until it is over.
fn rate_limit_wait(drain: &crate::DrainReport) -> Option<Duration> {
    if drain.stopped.is_some() || drain.undelivered == 0 {
        return None;
    }
    drain.retry_after_seconds.map(Duration::from_secs)
}

fn retry_schedule(backoff: Duration, error: &CoreError) -> (Duration, Duration) {
    let wait = error
        .retry_after()
        .map_or(backoff, |named| backoff.max(named));
    (wait, (backoff * 2).min(RETRY_MOST))
}

fn wait_unless_stopped(stop: &AtomicBool, wait: Duration) {
    crate::clock::wait(stop, wait, Duration::from_millis(250));
}

fn full_due(last: Option<Instant>, now: Instant) -> bool {
    last.is_none_or(|last| now.duration_since(last) >= FULL_PASS)
}

struct Gate {
    last_change: Instant,
    last_pass: Instant,
}

impl Gate {
    fn new(now: Instant) -> Gate {
        Gate {
            last_change: now,
            last_pass: now,
        }
    }

    fn changed(&mut self, now: Instant) {
        self.last_change = now;
    }

    /// Call at a pass's end: its own reads are events passed over, and from
    /// its start a pass longer than a tick would set off the next one.
    fn passed(&mut self, now: Instant) {
        self.last_pass = now;
    }

    /// inotify reports every open, so a reader faster than the tick would
    /// otherwise keep the receive from ever timing out.
    fn passed_over_is_due(&self, now: Instant) -> bool {
        now.duration_since(self.last_pass) >= TICK && now.duration_since(self.last_change) >= TICK
    }

    fn due(&self, now: Instant) -> bool {
        now.duration_since(self.last_change) >= SETTLE
            || now.duration_since(self.last_pass) >= HELD_MOST
    }
}

/// Whether a pass did anything: it changed a file, sent a write or took an
/// answer in.
fn stirred(
    settings: &SettingsFileReport,
    scan: &ScanReport,
    drain: &Drained,
    pull: &PullReport,
) -> bool {
    scan.created
        + scan.updated
        + scan.renamed
        + scan.deleted
        + scan.moved_away
        + scan.requeued
        + drain.report.answered
        + drain.gave_way
        + pull.written
        + pull.rewritten
        + pull.moved
        + pull.removed
        + pull.taken
        + pull.let_go
        + pull.revived
        + usize::from(settings.sent)
        > 0
}

/// What the passes have told, so a standing condition is told once, not
/// once a second.
#[derive(Debug, Default)]
struct Telling {
    standing: Option<Standing>,
    unreachable: bool,
    unsettled: bool,
    health_changed: bool,
    /// The last pass ran to its end and left nothing that time alone would
    /// move on.
    at_rest: bool,
}

#[derive(Debug, Clone, Default, PartialEq)]
struct Standing {
    root_gone: Option<String>,
    undelivered: usize,
    stopped: Option<String>,
    lost: usize,
    unreached: usize,
    /// Each as its path and reason.
    directories: Vec<(String, String)>,
    secrets: Vec<String>,
    settling: Vec<String>,
    warnings: Vec<Flagged>,
    unwritten: usize,
    outside: usize,
    unsuited: usize,
    unplaced: usize,
    absent: usize,
    kept: usize,
    unmatched: usize,
    settings: Option<String>,
    flagged: Vec<Flagged>,
    uncarried: Vec<Uncarried>,
    embeds: Vec<Flagged>,
    registry: Option<String>,
    unsure: Vec<Unsure>,
    paused: (usize, usize),
}

impl Standing {
    /// Whether the conditions a pass says on lines of their own are these.
    fn same_notices(&self, other: &Standing) -> bool {
        self.registry == other.registry
            && self.unsure == other.unsure
            && self.paused == other.paused
            && self.uncarried == other.uncarried
            && self.directories == other.directories
            && self.secrets == other.secrets
            && self.settling == other.settling
            && self.warnings == other.warnings
            && self.flagged == other.flagged
            && self.embeds == other.embeds
            && self.settings == other.settings
    }
}

impl Telling {
    /// Told once for each run of passes the copy changed under.
    fn unsettled(&mut self, error: &CoreError) -> Option<WatchEvent> {
        (!std::mem::replace(&mut self.unsettled, true)).then(|| WatchEvent::Retrying {
            error: error.clone(),
            wait: TICK,
        })
    }

    fn settled(&mut self) {
        self.unsettled = false;
    }

    fn reach(&mut self, lost: Option<String>) -> Option<WatchEvent> {
        match lost {
            Some(reason) if !self.unreachable => {
                self.unreachable = true;
                self.health_changed = true;
                Some(WatchEvent::Reach(Some(reason)))
            }
            None if self.unreachable => {
                self.unreachable = false;
                self.health_changed = true;
                Some(WatchEvent::Reach(None))
            }
            _ => None,
        }
    }

    fn waiting(&mut self, settings: SettingsFileReport, scan: ScanReport) -> Option<WatchEvent> {
        let now = Standing {
            root_gone: scan.root_gone.clone(),
            ..Standing::default()
        };
        let changed = self.standing.as_ref() != Some(&now);
        self.standing = Some(now);
        changed.then(|| WatchEvent::Waiting {
            settings,
            scan: Box::new(scan),
        })
    }

    fn passed(
        &mut self,
        full: bool,
        settings: SettingsFileReport,
        scan: ScanReport,
        drain: Drained,
        pull: PullReport,
    ) -> Option<WatchEvent> {
        let happened = stirred(&settings, &scan, &drain, &pull);
        let flagged = super::merged_flagged(&scan.flagged, &pull.flagged);
        let mut embeds: Vec<Flagged> = Vec::new();
        for embed in scan.embeds.iter().chain(&pull.embeds) {
            if !embeds.iter().any(|said| same_line(said, embed)) {
                embeds.push(embed.clone());
            }
        }
        // A quick pass reads no unchanged file, so finds none of its embeds.
        if !full && let Some(before) = &self.standing {
            for embed in &before.embeds {
                if !embeds.iter().any(|said| same_line(said, embed)) {
                    embeds.push(embed.clone());
                }
            }
        }
        let now = Standing {
            root_gone: None,
            undelivered: drain.report.undelivered,
            stopped: drain.report.stopped.clone(),
            paused: (scan.paused, pull.paused),
            lost: scan.lost,
            unreached: scan.unreached,
            directories: scan
                .directories
                .iter()
                .map(|dir| (dir.path.clone(), dir.reason.clone()))
                .collect(),
            secrets: scan.secrets.clone(),
            settling: scan.settling.clone(),
            warnings: scan.warnings.clone(),
            unwritten: pull.unwritten,
            outside: pull.outside,
            unsuited: pull.unsuited,
            unplaced: pull.unplaced,
            absent: pull.absent,
            kept: pull.kept,
            unmatched: pull.unmatched,
            settings: settings
                .flagged
                .clone()
                .or(pull.settings.flagged.clone())
                .or(settings.unwritten.clone())
                .or(pull.settings.unwritten.clone()),
            flagged: flagged.clone(),
            uncarried: pull.uncarried.clone(),
            embeds: embeds.clone(),
            registry: scan.registry.clone(),
            unsure: scan.unsure.clone(),
        };
        let before = self.standing.replace(now.clone());
        let changed = before.as_ref() != Some(&now);
        let unplaced_changed = before
            .as_ref()
            .is_none_or(|before| before.unplaced != now.unplaced);
        let stopped_changed = before
            .as_ref()
            .is_none_or(|before| before.stopped != now.stopped);
        let notices_changed = before
            .as_ref()
            .is_none_or(|before| !before.same_notices(&now));
        (happened || changed).then(|| {
            WatchEvent::Passed(Box::new(WatchPass {
                settings,
                scan,
                drain,
                pull,
                flagged,
                embeds,
                unplaced_changed,
                stopped_changed,
                notices_changed,
            }))
        })
    }
}

/// Whether two embeds read as one line.
fn same_line(one: &Flagged, other: &Flagged) -> bool {
    one.path == other.path && one.reason == other.reason
}

fn settings_file(root: &Path, path: &Path) -> bool {
    path == root.join(STATE_DIR).join(SETTINGS_FILE)
}

/// Whether no pass can find anything at `path`, which an event names: the
/// folder takes no file there, nor under it where it is a directory. A path
/// outside the folder's root or the root itself is never unreached.
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
    let under = !lists.takes(&format!("{relative}/x"));
    if lists.takes(relative) {
        // Taken as a file: unless it is a directory, which the lists skip
        // whole. A path already gone may have been either, and is reached.
        return under && std::fs::symlink_metadata(path).is_ok_and(|found| found.is_dir());
    }
    under
}

fn dot_led(root: &Path, path: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(root) else {
        return false;
    };
    relative
        .components()
        .any(|part| part.as_os_str().to_string_lossy().starts_with('.'))
}

/// The follow hydrates a copy that is part way through a hydration or has
/// expired, and a pass that meets either finds the copy whole a pass later.
/// A drain refuses both before it sends anything.
fn hydrated_by_the_follow(error: &CoreError) -> bool {
    matches!(
        error,
        CoreError::HydrationIncomplete | CoreError::CopyExpired { .. }
    )
}

#[cfg(test)]
mod tests {
    #[test]
    fn health_markers_are_consumed_once_and_invalidated_by_lost_or_incomplete_follow() {
        let mut health = super::FollowHealth::default();
        assert!(!health.available());
        health.observe(true);
        assert!(health.available());
        health.consumed = health.generation;
        assert!(
            !health.available(),
            "quiet refresh cannot claim another success"
        );
        health.observe(true);
        assert!(health.available());
        health.observe(false);
        assert!(
            !health.available(),
            "a lost or incomplete follow cannot authorise success"
        );
    }

    use super::*;

    const SECOND: Duration = Duration::from_secs(1);

    #[test]
    fn an_event_passed_over_runs_a_pass_only_a_tick_after_both_the_last_pass_and_change() {
        let under = Duration::from_millis(900);
        let due = |since_pass: Duration, since_change: Duration| {
            let now = Instant::now() + 10 * SECOND;
            Gate {
                last_change: now - since_change,
                last_pass: now - since_pass,
            }
            .passed_over_is_due(now)
        };
        assert!(due(SECOND, 5 * SECOND));
        assert!(!due(under, 5 * SECOND));
        assert!(!due(5 * SECOND, under));
        assert!(!due(under, under));
    }

    #[test]
    fn steady_changes_hold_a_pass_off_for_a_bounded_time() {
        let every = Duration::from_millis(500);
        let start = Instant::now();
        let mut gate = Gate::new(start);
        let mut passes = Vec::new();
        let mut at = start;
        while at < start + 30 * SECOND {
            at += every;
            gate.changed(at);
            if gate.due(at) {
                passes.push(at);
                gate.passed(at);
            }
        }
        assert!(
            !passes.is_empty(),
            "no pass ran in thirty seconds of a file changing twice a second, \
             so nothing from the server reached the folder and no other file \
             reached the server"
        );
        let waits: Vec<Duration> = std::iter::once(start)
            .chain(passes.iter().copied())
            .zip(passes.iter().copied())
            .map(|(before, after)| after - before)
            .collect();
        let longest = waits.iter().max().copied().unwrap_or_default();
        assert!(
            longest <= HELD_MOST + every,
            "a pass was held off for {longest:?} by changes that never settled"
        );

        let quiet = at + SETTLE;
        assert!(gate.due(quiet));
        assert!(!Gate::new(at).due(at + SETTLE / 2));
    }

    #[test]
    fn a_failed_hydration_is_tried_again_after_a_wait_that_doubles_to_thirty_seconds() {
        let failing = CoreError::Network("refused".into());
        let mut backoff = RETRY_FIRST;
        let mut waits = Vec::new();
        for _ in 0..7 {
            let (wait, next) = retry_schedule(backoff, &failing);
            waits.push(wait.as_secs());
            backoff = next;
        }
        assert_eq!(waits, [1, 2, 4, 8, 16, 30, 30]);
    }

    #[test]
    fn a_pass_that_left_writes_under_a_rate_limit_is_followed_when_it_ends() {
        let mut limited = drained().report;
        limited.undelivered = 4;
        limited.unavailable = Some("the server asked to be left alone".into());
        limited.retry_after_seconds = Some(3);
        assert_eq!(rate_limit_wait(&limited), Some(Duration::from_secs(3)));
        let mut sent = limited.clone();
        sent.undelivered = 0;
        assert_eq!(rate_limit_wait(&sent), None, "nothing is left to send");
        let mut unnamed = limited.clone();
        unnamed.retry_after_seconds = None;
        assert_eq!(rate_limit_wait(&unnamed), None, "the server named no wait");
        let mut refused = limited;
        refused.stopped = Some("the server refused the credential".into());
        assert_eq!(rate_limit_wait(&refused), None);
    }

    #[test]
    fn a_rate_limit_is_waited_out_as_long_as_it_names() {
        let limited = |seconds| CoreError::RateLimited {
            code: "rate_limited".into(),
            message: String::new(),
            retry_after_seconds: Some(seconds),
        };
        assert_eq!(
            retry_schedule(SECOND, &limited(45)),
            (45 * SECOND, 2 * SECOND)
        );
        assert_eq!(retry_schedule(4 * SECOND, &limited(1)).0, 4 * SECOND);
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
            "_tmp/clone/file.rs",
            "README.md",
            ".marfa/core.sqlite-wal",
        ] {
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
    fn an_event_the_folder_cannot_place_is_reached() {
        let (lists, root) = (record_lists(), Path::new("/folder"));
        assert!(!unreached(&lists, root, root), "the root itself");
        assert!(
            !unreached(&lists, root, Path::new("/elsewhere/Notes/a.md")),
            "a path outside the root"
        );
    }

    #[test]
    fn the_first_pass_reads_every_file_and_then_one_a_minute() {
        let now = Instant::now();
        assert!(full_due(None, now));
        assert!(!full_due(Some(now), now + 59 * SECOND));
        assert!(full_due(Some(now), now + FULL_PASS));
    }

    #[test]
    fn a_later_drain_that_leaves_writes_undelivered_with_no_wait_ends_the_kept_wait() {
        let dir = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let db = dir.path().join(super::super::STATE_DIR).join("core.sqlite");
        std::fs::create_dir_all(db.parent().unwrap()).unwrap();
        let core = super::super::working(crate::Core::open(&db, None).unwrap()).unwrap();
        super::super::settings_file::bind(&core, "folder").unwrap();
        drop(core);
        let folder = Folder::open(
            dir.path(),
            Some(crate::Server {
                url: "http://127.0.0.1:9".into(),
                key: "fixture".into(),
            }),
        )
        .unwrap();
        let limited = || {
            let mut report = drained().report;
            report.undelivered = 2;
            report.retry_after_seconds = Some(30);
            report
        };
        folder.keep_wait(&limited()).unwrap();
        assert!(
            folder.kept_wait().is_some(),
            "a rate limit's wait was not kept"
        );
        // A drain that sent nothing says nothing of the wait.
        folder.keep_wait(&drained().report).unwrap();
        assert!(folder.kept_wait().is_some());

        let mut unavailable = drained().report;
        unavailable.undelivered = 1;
        unavailable.unavailable = Some("the server could not be reached".into());
        folder.keep_wait(&unavailable).unwrap();
        assert!(
            folder.kept_wait().is_none(),
            "a later drain left writes undelivered with no wait, and the older wait was kept"
        );

        folder.keep_wait(&limited()).unwrap();
        let mut answered = drained().report;
        answered.answered = 1;
        folder.keep_wait(&answered).unwrap();
        assert!(folder.kept_wait().is_none());
    }

    fn drained() -> Drained {
        Drained {
            report: crate::DrainReport {
                answered: 0,
                held: 0,
                undelivered: 0,
                unsent: 0,
                unmade: 0,
                unavailable: None,
                verdicts: Vec::new(),
                stopped: None,
                unclaimed_sources: Vec::new(),
                retry_after_seconds: None,
            },
            rebased: 0,
            gave_way: 0,
        }
    }

    fn told(telling: &mut Telling, full: bool, scan: ScanReport, pull: PullReport) -> bool {
        telling
            .passed(full, SettingsFileReport::default(), scan, drained(), pull)
            .is_some()
    }

    fn embed(path: &str) -> Flagged {
        Flagged {
            path: path.into(),
            flag: "embed",
            reason: "embeds a file the folder does not hold".into(),
            item: None,
        }
    }

    #[test]
    fn a_pass_is_told_when_it_does_something_and_a_standing_condition_once() {
        let mut telling = Telling::default();
        assert!(
            told(
                &mut telling,
                true,
                ScanReport::default(),
                PullReport::default()
            ),
            "the first pass is told, so the caller hears the folder's state"
        );
        assert!(!told(
            &mut telling,
            false,
            ScanReport::default(),
            PullReport::default()
        ));
        let created = ScanReport {
            created: 1,
            ..ScanReport::default()
        };
        assert!(told(&mut telling, false, created, PullReport::default()));
        let held = ScanReport {
            secrets: vec![".env".into()],
            ..ScanReport::default()
        };
        assert!(told(
            &mut telling,
            false,
            held.clone(),
            PullReport::default()
        ));
        assert!(!told(&mut telling, false, held, PullReport::default()));
        assert!(
            told(
                &mut telling,
                false,
                ScanReport::default(),
                PullReport::default()
            ),
            "a condition that clears is told"
        );
    }

    fn pass_of(telling: &mut Telling, scan: ScanReport) -> Option<WatchPass> {
        match telling.passed(
            false,
            SettingsFileReport::default(),
            scan,
            drained(),
            PullReport::default(),
        ) {
            Some(WatchEvent::Passed(pass)) => Some(*pass),
            _ => None,
        }
    }

    #[test]
    fn a_pass_waiting_out_a_delete_s_grace_is_not_told() {
        let mut telling = Telling::default();
        assert!(told(
            &mut telling,
            true,
            ScanReport::default(),
            PullReport::default()
        ));
        let waiting = ScanReport {
            missing: 1,
            secrets: vec![".env".into()],
            ..ScanReport::default()
        };
        // The first pass to meet the standing secret says it; the passes
        // after it, though a file is missing at each, have nothing to say.
        assert!(told(
            &mut telling,
            false,
            waiting.clone(),
            PullReport::default()
        ));
        for _ in 0..3 {
            assert!(!told(
                &mut telling,
                false,
                waiting.clone(),
                PullReport::default()
            ));
        }
        let deleted = ScanReport {
            deleted: 1,
            ..waiting
        };
        assert!(
            told(&mut telling, false, deleted, PullReport::default()),
            "the pass that sends the delete is told"
        );
    }

    #[test]
    fn a_standing_notice_is_told_again_only_where_it_changes() {
        let mut telling = Telling::default();
        let held = |secrets: &[&str], created| ScanReport {
            created,
            secrets: secrets.iter().map(|name| name.to_string()).collect(),
            ..ScanReport::default()
        };
        let first = pass_of(&mut telling, held(&[".env"], 0)).unwrap();
        assert!(first.notices_changed, "the first pass says what stands");
        let eventful = pass_of(&mut telling, held(&[".env"], 1)).unwrap();
        assert!(
            !eventful.notices_changed,
            "a pass that created a file said the standing secret again"
        );
        let more = pass_of(&mut telling, held(&[".env", "id_rsa"], 1)).unwrap();
        assert!(more.notices_changed, "a second secret is news");
        let cleared = pass_of(&mut telling, held(&[], 0)).unwrap();
        assert!(cleared.notices_changed, "a notice that clears is told");
    }

    #[test]
    fn a_paused_removal_is_not_a_change_at_every_pass() {
        let mut telling = Telling::default();
        let paused = ScanReport {
            missing: 40,
            paused: 40,
            ..ScanReport::default()
        };
        assert!(told(
            &mut telling,
            true,
            paused.clone(),
            PullReport::default()
        ));
        assert!(!told(&mut telling, false, paused, PullReport::default()));
    }

    #[test]
    fn two_items_not_written_at_one_path_are_each_told() {
        let not_written = |item: &str| Flagged {
            path: "id_rsa".into(),
            flag: "outside",
            reason: "the folder's lists do not take the path".into(),
            item: Some(item.into()),
        };
        let mut telling = Telling::default();
        let Some(WatchEvent::Passed(pass)) = telling.passed(
            true,
            SettingsFileReport::default(),
            ScanReport::default(),
            drained(),
            PullReport {
                outside: 2,
                flagged: vec![not_written("one"), not_written("two")],
                ..PullReport::default()
            },
        ) else {
            panic!("a first pass holding two items back was not told");
        };
        let items: Vec<Option<&str>> = pass
            .flagged
            .iter()
            .map(|file| file.item.as_deref())
            .collect();
        assert_eq!(items, [Some("one"), Some("two")]);
    }

    #[test]
    fn a_quick_pass_carries_the_embeds_the_pass_before_found() {
        let mut telling = Telling::default();
        let found = ScanReport {
            embeds: vec![embed("a.md")],
            ..ScanReport::default()
        };
        telling.passed(
            true,
            SettingsFileReport::default(),
            found,
            drained(),
            PullReport::default(),
        );
        let Some(WatchEvent::Passed(pass)) = telling.passed(
            false,
            SettingsFileReport::default(),
            ScanReport {
                created: 1,
                ..ScanReport::default()
            },
            drained(),
            PullReport {
                embeds: vec![embed("b.md"), embed("b.md")],
                ..PullReport::default()
            },
        ) else {
            panic!("a pass that created a file was not told");
        };
        let paths: Vec<&str> = pass
            .embeds
            .iter()
            .map(|embed| embed.path.as_str())
            .collect();
        assert_eq!(paths, ["b.md", "a.md"]);
        assert!(told(
            &mut telling,
            true,
            ScanReport::default(),
            PullReport::default()
        ));
        assert!(
            telling.standing.as_ref().unwrap().embeds.is_empty(),
            "a full pass finds every embed itself, so carries none"
        );
    }

    #[test]
    fn a_copy_changing_under_the_pull_is_told_once_for_each_run() {
        let mut telling = Telling::default();
        let changed = crate::reach::Context::changed();
        assert!(matches!(
            telling.unsettled(&changed),
            Some(WatchEvent::Retrying { .. })
        ));
        assert!(telling.unsettled(&changed).is_none());
        telling.settled();
        assert!(telling.unsettled(&changed).is_some(), "a new run is told");
    }

    #[test]
    fn the_server_s_reach_is_told_only_when_it_changes() {
        let mut telling = Telling::default();
        assert!(telling.reach(None).is_none(), "reachable from the start");
        assert!(matches!(
            telling.reach(Some("refused".into())),
            Some(WatchEvent::Reach(Some(_)))
        ));
        assert!(telling.reach(Some("refused again".into())).is_none());
        assert!(matches!(telling.reach(None), Some(WatchEvent::Reach(None))));
        assert!(telling.reach(None).is_none());
    }

    #[test]
    fn a_gone_directory_is_told_once_and_its_return_is_told() {
        let mut telling = Telling::default();
        let gone = ScanReport {
            root_gone: Some("the folder's directory is gone".into()),
            ..ScanReport::default()
        };
        assert!(
            telling
                .waiting(SettingsFileReport::default(), gone.clone())
                .is_some()
        );
        assert!(
            telling
                .waiting(SettingsFileReport::default(), gone)
                .is_none()
        );
        assert!(told(
            &mut telling,
            false,
            ScanReport::default(),
            PullReport::default()
        ));
    }

    #[test]
    fn only_a_drain_stopped_by_a_refused_credential_ends_the_watch() {
        let mut stopped = drained();
        stopped.report.stopped = Some("the server refused the credential".into());
        assert_eq!(credential_refused(&stopped), None, "no verdict says why");
        stopped.report.verdicts.push(crate::DrainVerdict {
            id: "w".into(),
            kind: crate::WriteKind::CreateItem,
            item_id: None,
            edge_id: None,
            verdict: None,
            reason: Some("credential_refused".into()),
            refusal: None,
            conflicted_copy_id: None,
            refusals: 0,
            replayed: false,
            merged_fields: Vec::new(),
        });
        assert!(matches!(
            credential_refused(&stopped),
            Some(CoreError::Unauthorized { message, .. }) if message == "the server refused the credential"
        ));
        assert_eq!(credential_refused(&drained()), None);
    }

    #[test]
    fn a_pass_waits_out_the_hydration_the_follow_runs() {
        assert!(hydrated_by_the_follow(&CoreError::HydrationIncomplete));
        assert!(hydrated_by_the_follow(&CoreError::CopyExpired {
            reason: "catchup_too_old".into()
        }));
        assert!(!hydrated_by_the_follow(&CoreError::NoCursor));
        assert!(!hydrated_by_the_follow(&CoreError::Unauthorized {
            code: "unauthorized".into(),
            message: "ended".into()
        }));
    }

    #[test]
    fn a_wait_ends_when_the_watch_stops() {
        let stop = AtomicBool::new(false);
        let started = Instant::now();
        std::thread::scope(|scope| {
            scope.spawn(|| {
                std::thread::sleep(Duration::from_millis(50));
                stop.store(true, Ordering::SeqCst);
            });
            wait_unless_stopped(&stop, RETRY_MOST);
        });
        assert!(started.elapsed() < 5 * SECOND, "{:?}", started.elapsed());
    }
}
