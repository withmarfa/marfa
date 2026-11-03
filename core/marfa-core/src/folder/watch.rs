use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, mpsc};
use std::time::{Duration, Instant};

use notify::{EventKind, RecursiveMode, Watcher};

use super::handover::{self, Requests};
use super::lists::Lists;
use super::selective::Selection;
use super::{
    Barred, Drained, Flagged, Folder, PullReport, SETTINGS_FILE, STATE_DIR, ScanReport,
    SettingsFileReport, StorageCause, Uncarried, Unsure,
};
use crate::error::CoreError;
use crate::priority::{inheriting, lowered};

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
    /// More than one pass a second has started, on average, within a minute,
    /// which a folder at rest never needs: `passes` is how many started in
    /// that minute. Told at most once a minute, to a log; the bindings do not
    /// carry it.
    Busy { passes: usize },
    /// The hourly render of every file rewrote the file at `path`, which the
    /// watch's choice of the files a change reaches would have left as it
    /// was: a change that choice does not follow. Told to a log; the
    /// bindings do not carry it.
    Missed { path: String },
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
    /// Whether the refusal of the folder's title lookups, which a pass says
    /// when it changes and apart from the other notices, differs from the
    /// pass before.
    pub lookup_changed: bool,
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
    /// The directory could not be watched.
    Unwatchable(String),
    /// A pass failed, or a thread of the watch panicked (`CoreError::Fault`).
    Core(CoreError),
    /// The caller's `tell` failed.
    Told(E),
}

/// A thread of the watch panicked.
fn faulted<E>(said: &str) -> WatchError<E> {
    WatchError::Core(CoreError::Fault(said.into()))
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
    /// What the watcher delivered, with when it delivered it: a pass can run
    /// for seconds before the loop reads it.
    File(notify::Result<notify::Event>, Instant),
    /// The copy changed, as of when the follow had applied the change, with
    /// the item the change names where it names one.
    Server(Instant, Option<String>),
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
    /// first. On Apple platforms the calling thread runs at utility quality of
    /// service until this returns, and so do the threads the watch starts.
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
        let _lowered = lowered();
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
            let follower = scope.spawn(inheriting(|| follow(self, &ended, server_wakes, &health)));
            let reporter = scope.spawn(inheriting(|| self.health_follow(&ended)));
            let looker = requests.map(|requests| {
                let (wakes, ended, asked) = (sender.clone(), &ended, &asked);
                scope.spawn(inheriting(move || look(requests, ended, asked, wakes)))
            });
            let watched = {
                // A guard, so a pass or a `tell` that panics still ends the
                // follow: the scope waits for it before the panic goes on.
                let _ending = Raise(&ended);
                self.watch_files(stop, &asked, sender, &wakes, &mut tell, &health)
            };
            if let Some(looker) = looker {
                looker.join().map_err(|_| {
                    faulted("looking for a command asking for the folder ended in a fault")
                })?;
            }
            reporter
                .join()
                .map_err(|_| faulted("folder health reporting ended in a fault"))?;
            let followed = follower
                .join()
                .map_err(|_| faulted("the follow of the server's changes ended in a fault"))?;
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
            let _ = sender.send(Wake::File(event, crate::clock::now()));
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
        // Whether `lists` may no longer be the settings' lists: a settings
        // change on disk or from the server.
        let mut stale = false;
        let mut rate = PassRate::default();
        let mut unread: Option<Wake> = None;
        loop {
            if stop.load(Ordering::SeqCst) {
                break;
            }
            if asked.load(Ordering::SeqCst) {
                return Ok(WatchEnd::HandedOver);
            }
            #[cfg(debug_assertions)]
            crate::fault::hold(|| "folder-watch-turn");
            let heard = match unread.take() {
                Some(wake) => Ok(wake),
                None => {
                    crate::clock::recv_timeout(events, stop, gate.listen_for(crate::clock::now()))
                }
            };
            match heard {
                Ok(Wake::File(Ok(event), delivered)) => {
                    if stale {
                        lists = self.settings().and_then(|settings| settings.lists()).ok();
                        stale = false;
                    }
                    stale |= event.paths.iter().any(|path| settings_file(dir, path));
                    if !event_passed_over_unless(&event, dir, lists.as_ref(), |path| {
                        self.stands_as_read(path)
                    }) {
                        changed = true;
                        gate.changed(delivered);
                        #[cfg(debug_assertions)]
                        crate::fault::hold(|| "folder-file-changed");
                        telling.health_changed = true;
                    } else if !gate.passed_over_is_due(crate::clock::now()) {
                        continue;
                    }
                }
                Ok(Wake::File(Err(error), delivered)) => {
                    // The watcher may have lost events, so nothing says the
                    // folder is unchanged.
                    changed = true;
                    gate.changed(delivered);
                    tell(WatchEvent::WatcherFailed(error.to_string())).map_err(WatchError::Told)?;
                }
                Ok(Wake::Server(applied, item)) => {
                    stale = true;
                    if self.unseen_by_pass(&telling, applied, item.as_deref()) {
                        changed = true;
                        telling.health_changed = true;
                    }
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
                // The follow caught a panic of the core's: the server is not
                // what ended it.
                Ok(Wake::Ended(error @ CoreError::Fault(_))) => {
                    return Err(WatchError::Core(error));
                }
                Ok(Wake::Ended(error)) => return Err(WatchError::FollowEnded(error)),
                Ok(Wake::Asked) => continue,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
            // What arrived while a pass ran is read, in order, before the gate
            // is asked: a change heard first is older than one still waiting.
            unread = events.try_recv().ok();
            if unread.is_some() && gate.reads_first(crate::clock::now()) {
                continue;
            }
            // No pass runs while the server's rate limit lasts, since a write
            // sent before it ends is refused again: changes on disk wait
            // unscanned and nothing is pulled.
            if send_again_at.is_some_and(|at| crate::clock::now() < at)
                || !gate.due(crate::clock::now())
            {
                continue;
            }
            let full = full_due(last_full, crate::clock::now());
            if telling.rests(full, changed) {
                continue;
            }
            changed = false;
            if full {
                last_full = Some(crate::clock::now());
            }
            #[cfg(debug_assertions)]
            crate::fault::hold(|| "folder-pass-start");
            if let Some(passes) = rate.started(crate::clock::now()) {
                tell(WatchEvent::Busy { passes }).map_err(WatchError::Told)?;
            }
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
            stale = false;
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
        telling.scan_began = Some(crate::clock::now());
        let scan = self.scan_watching(full, SETTLE)?;
        // Told once, and every tick looks again, so the watch goes on where
        // it left off once the directory is back.
        if scan.root_gone.is_some() {
            telling.pulled = None;
            telling.selection.forget();
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
        telling.pull_began = Some(crate::clock::now());
        let mark = self.mark()?;
        let pull = match telling.pulled.take().filter(|last| {
            last.from == mark
                && quiet(&settings, &scan, &drain)
                && !telling.unreachable
                && !telling.selection.full_render_due()
                && !self.has_unanswered_writes()
                && self
                    .unread_give_ways
                    .lock()
                    .expect("give-way lock")
                    .is_empty()
                && self.still_barred(&last.barred)
        }) {
            Some(last) => {
                // The settings file is in the folder's state directory, which
                // no scan reads, and putting it back renders no file.
                let pull = PullReport {
                    settings: self.write_settings_if_moved()?,
                    ..last.report.clone()
                };
                telling.pulled = Some(last);
                pull
            }
            None => {
                #[cfg(test)]
                {
                    telling.pulls += 1;
                }
                #[cfg(debug_assertions)]
                crate::fault::hold(|| "folder-pass-pull");
                let (pull, barred) =
                    self.pull_noting(|| self.pull_selecting(&mut telling.selection));
                let pull = pull?;
                for path in telling.selection.take_missed() {
                    tell(WatchEvent::Missed { path }).map_err(WatchError::Told)?;
                }
                if self.left_nothing(&pull) {
                    telling.pulled = Some(Pulled {
                        from: mark,
                        barred,
                        report: pull.clone(),
                    });
                }
                pull
            }
        };
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
            self.health_observe_reusing(
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
        // Only what time alone moves on keeps the ticks running. A file that
        // stays missing, a held delete, a file waiting on another folder or a
        // directory that cannot be read stands as it is until a file event,
        // a server change or the next full pass, and a pass a second would
        // only find it again.
        telling.at_rest = wait.is_none()
            && refused.is_none()
            && !stirred(&settings, &scan, &drain, &pull)
            && scan.settling.is_empty()
            && !self.grace_running()?
            && drain.rebased == 0
            && drain.report.unavailable.is_none()
            && drain.report.stopped.is_none()
            && drain.report.undelivered == 0
            && drain.report.unsent == 0
            && drain.report.held == 0
            && drain.report.unmade == 0
            && !self.has_unanswered_writes()
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

/// A watch's passes run one at a time on the calling thread, with no follow
/// and no file events, for a test to say when each runs.
#[cfg(test)]
#[derive(Default)]
pub(super) struct Passes {
    telling: Telling,
    health: Mutex<FollowHealth>,
    /// The paths each `Missed` the passes told named.
    pub(super) missed: Vec<String>,
    /// The ticks since the last full pass.
    ticks: u64,
}

#[cfg(test)]
impl Passes {
    pub(super) fn run(&mut self, folder: &Folder, full: bool) -> Result<(), CoreError> {
        let asked = AtomicBool::new(false);
        let missed = &mut self.missed;
        let mut told = |event: WatchEvent| {
            if let WatchEvent::Missed { path } = event {
                missed.push(path);
            }
            Ok::<(), ()>(())
        };
        match folder.pass(full, &asked, &mut self.telling, &mut told, &self.health) {
            Ok(_) => Ok(()),
            Err(WatchError::Core(error)) => Err(error),
            Err(other) => panic!("the pass ended the watch: {other:?}"),
        }
    }

    /// Runs what a second's tick of a watch that hears no file event and no
    /// server change runs: a full pass once a minute, and otherwise a quick
    /// pass only where the last pass left the folder short of rest. Answers
    /// whether a pass ran.
    pub(super) fn tick(&mut self, folder: &Folder) -> Result<bool, CoreError> {
        self.ticks += 1;
        let full = self.ticks >= FULL_PASS.as_secs() / TICK.as_secs();
        if self.telling.rests(full, false) {
            return Ok(false);
        }
        if full {
            self.ticks = 0;
        }
        self.run(folder, full).map(|()| true)
    }

    /// Runs what the watch runs when its follow says the server's reach was
    /// lost, with why, or is back. Answers whether a pass ran.
    pub(super) fn reach(
        &mut self,
        folder: &Folder,
        lost: Option<String>,
    ) -> Result<bool, CoreError> {
        self.telling.reach(lost);
        if self.telling.rests(false, true) {
            return Ok(false);
        }
        self.run(folder, false).map(|()| true)
    }

    /// The pulls the passes ran rather than reused since the last call.
    pub(super) fn pulls(&mut self) -> usize {
        std::mem::take(&mut self.telling.pulls)
    }

    /// Makes the next pull render every file, as an hour after the last
    /// that did.
    #[cfg(debug_assertions)]
    pub(super) fn render_all_next(&mut self) {
        self.telling.selection.render_all_next();
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
                let _ = wakes.send(Wake::Server(crate::clock::now(), None));
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
                        _ => Wake::Server(crate::clock::now(), change.item_id.clone()),
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
pub(super) const SEND_AGAIN_AT: &str = "folder_send_again_at";

impl Folder {
    /// Whether the file at `path` is as the last scan or pull left it: the
    /// identity, size and time it was read at, and the bytes the folder bound
    /// it with. A pass has nothing to find in it, so an event naming it, such
    /// as the pull's own write, starts none. A different file with the same
    /// size, time and bytes is not that file: a later rename of it would move
    /// no item if the binding still named the old identity.
    pub(super) fn stands_as_read(&self, path: &Path) -> bool {
        self.file_stands_as_read(path).unwrap_or(false)
    }

    fn file_stands_as_read(&self, path: &Path) -> Result<bool, CoreError> {
        let key = super::identity::relative(&self.root, path)?;
        let Ok(metadata) = self.metadata(path) else {
            return Ok(false);
        };
        let Some(stat) = metadata
            .is_file()
            .then(|| super::stat_metadata(&metadata))
            .flatten()
        else {
            return Ok(false);
        };
        let Some(identity) = super::identity::of(&metadata).map(|found| found.key()) else {
            return Ok(false);
        };
        let bound = {
            let conn = self.core.conn()?;
            if super::state::stat_of(&conn, &key)?.as_deref() != Some(stat.as_str()) {
                return Ok(false);
            }
            super::state::bound_at(&conn, &key)?
        };
        Ok(bound.is_some_and(|bound| {
            bound.identity.as_deref() == Some(identity.as_str())
                && bound.held.is_none()
                && !bound.holds_refusal()
                && super::state::untaken_read_version(&bound.content_hash).is_none()
                && self
                    .read(path)
                    .is_ok_and(|bytes| super::state::hash(&bytes) == bound.content_hash)
        }))
    }

    /// Whether a server change the copy took at `applied`, to `item` where it
    /// names one, is one the last pass did not act on. The pull read every
    /// change applied before it began, but it leaves a held file be, and only
    /// the scan judges such a file's links again. So a change applied after
    /// the scan began is news to the pass where a file is held or refused and
    /// the change is to an item no file is bound to, which may be what a held
    /// link names. Bound items are excluded to avoid another pass for the
    /// echo of an edit this pass sent. A bound item's rename can also change
    /// a held link's target; the next full pass judges that link again.
    fn unseen_by_pass(&self, telling: &Telling, applied: Instant, item: Option<&str>) -> bool {
        telling.unseen_by_pull(applied)
            || (telling.scan_began.is_none_or(|began| applied >= began)
                && self.core.conn().is_ok_and(|conn| {
                    super::state::any_held_or_refused(&conn).unwrap_or(true)
                        && item.is_none_or(|item| {
                            super::state::bound_to_item(&conn, item)
                                .map_or(true, |bound| bound.is_none())
                        })
                }))
    }

    /// Read in one transaction, so a change committed between two of the
    /// reads is not half seen.
    fn mark(&self) -> Result<Mark, CoreError> {
        let conn = self.core.conn()?;
        let read = conn.unchecked_transaction()?;
        let mark = Mark {
            revision: crate::store::copy_revision(&read)?,
            generation: crate::reach::generation(&read)?,
            record: super::state::record_digest(&read)?,
        };
        read.commit()?;
        Ok(mark)
    }

    /// Whether a pull changed nothing and left nothing that the next pull of
    /// the same copy and record would read anew: a write it failed or held
    /// back, or a file another folder may yet take or let go.
    fn left_nothing(&self, pull: &PullReport) -> bool {
        pull.written
            + pull.rewritten
            + pull.moved
            + pull.revived
            + pull.placed
            + pull.ended
            + pull.removed
            + pull.taken
            + pull.let_go
            + pull.relinked
            + pull.unrelinked
            + pull.unwritten
            + pull.absent
            + pull.unplaced
            + pull.unmatched
            + pull.kept
            + pull.paused
            + pull.elsewhere
            == 0
            && !pull.settings.sent
            && !pull.settings.written
            && pull.settings.flagged.is_none()
            && pull.settings.unwritten.is_none()
            && pull.root_gone.is_none()
    }

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

    /// A change that was delivered at `at`. Never moves the last change back:
    /// the loop reads what arrived during a pass in the order it came, after
    /// the pass, and a later change stands.
    fn changed(&mut self, at: Instant) {
        self.last_change = self.last_change.max(at);
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

    /// Whether events already waiting are read before a pass is considered:
    /// until the longest a steady change holds a pass off is over.
    fn reads_first(&self, now: Instant) -> bool {
        now.duration_since(self.last_pass) < HELD_MOST
    }

    /// How long to wait for an event before looking again: the settle time
    /// a change still has to run, or a tick where no pass waits on it.
    fn listen_for(&self, now: Instant) -> Duration {
        let settles = (self.last_change + SETTLE).saturating_duration_since(now);
        let held = (self.last_pass + HELD_MOST).saturating_duration_since(now);
        match settles.min(held) {
            left if left.is_zero() => TICK,
            left => left.min(TICK),
        }
    }
}

/// Where the copy and the folder's record stood as a pull began.
#[derive(Debug, Clone, PartialEq)]
struct Mark {
    revision: u64,
    generation: u64,
    record: [u8; 32],
}

/// A pull that changed nothing and left nothing to do, where it began, and
/// where the disk kept it from writing.
#[derive(Debug, Clone)]
struct Pulled {
    from: Mark,
    barred: Barred,
    report: PullReport,
}

/// Whether a pass's settings step, scan and drain found nothing to do and
/// nothing still on its way: a file settling or waiting on an answer, or a
/// write the server has not taken. A file that stays missing, a held
/// removal, an unsure delete or a directory that cannot be read is not on
/// its way: each stands in the folder's record, which a pull's mark covers,
/// or in the disk, which its barred paths cover.
fn quiet(settings: &SettingsFileReport, scan: &ScanReport, drain: &Drained) -> bool {
    !settings.sent
        && !settings.written
        && settings.flagged.is_none()
        && settings.unwritten.is_none()
        && scan.created
            + scan.updated
            + scan.renamed
            + scan.deleted
            + scan.moved_away
            + scan.requeued
            + scan.waiting
            == 0
        && scan.trashed.is_empty()
        && scan.settling.is_empty()
        && drain.report.answered
            + drain.report.held
            + drain.report.undelivered
            + drain.report.unsent
            + drain.report.unmade
            + drain.rebased
            + drain.gave_way
            == 0
        && drain.report.unavailable.is_none()
        && drain.report.stopped.is_none()
        && drain.report.unclaimed_sources.is_empty()
}

/// Whether the pass changed something a later pass still needs to observe.
/// A completed edit or writeback alone leaves no work for that pass.
fn stirred(
    settings: &SettingsFileReport,
    scan: &ScanReport,
    drain: &Drained,
    pull: &PullReport,
) -> bool {
    scan.created
        + scan.renamed
        + scan.deleted
        + scan.moved_away
        + scan.requeued
        + drain.gave_way
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
    /// When the last pass began its scan.
    scan_began: Option<Instant>,
    /// When the last pass began to read the copy for its pull.
    pull_began: Option<Instant>,
    /// The last pull, where a pass that finds the copy and the record as it
    /// began, and the disk still in the way where it was, would render every
    /// file as it was, so pulls nothing.
    pulled: Option<Pulled>,
    selection: Selection,
    /// The pulls the passes ran rather than reused.
    #[cfg(test)]
    pulls: usize,
}

impl Telling {
    /// Whether a tick leaves the folder be. A tick alone moves nothing on a
    /// folder the last pass left at rest: a pass walks the whole folder, so
    /// it is not run to find out.
    fn rests(&self, full: bool, changed: bool) -> bool {
        !full && !changed && self.at_rest
    }

    /// Whether a change the copy took at `applied` is one the last pull did not
    /// read. The follow applies a change before it tells it, so a change told
    /// before the pull began was in the copy the pull read.
    fn unseen_by_pull(&self, applied: Instant) -> bool {
        self.pull_began.is_none_or(|began| applied >= began)
    }
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
    lookup_refused: Option<String>,
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
        // A pass that read nothing heard nothing from the server.
        let now = Standing {
            root_gone: scan.root_gone.clone(),
            lookup_refused: self
                .standing
                .as_ref()
                .and_then(|before| before.lookup_refused.clone()),
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
        // The refusal stands as the last pass that asked the server found it,
        // until a pass hears the server answer or refuse again: a pass that
        // asked no name, or whose calls failed with no answer, proves neither.
        let mut scan = scan;
        if scan.lookup_refused.is_none()
            && !scan.lookup_answered
            && let Some(before) = &self.standing
        {
            scan.lookup_refused = before.lookup_refused.clone();
        }
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
            lookup_refused: scan.lookup_refused.clone(),
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
        let lookup_changed = before
            .as_ref()
            .map_or(now.lookup_refused.is_some(), |before| {
                before.lookup_refused != now.lookup_refused
            });
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
                lookup_changed,
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

/// Whether an event starts no pass: it names only paths no pass can find,
/// or is an access. An event that says events were lost, or names no path,
/// is never passed over.
#[cfg(test)]
fn event_passed_over(event: &notify::Event, root: &Path, lists: Option<&Lists>) -> bool {
    event_passed_over_unless(event, root, lists, |_| false)
}

/// `event_passed_over`, where a path `stands` as a scan read it counts as
/// one no pass can find anything at.
fn event_passed_over_unless(
    event: &notify::Event,
    root: &Path,
    lists: Option<&Lists>,
    stands: impl Fn(&Path) -> bool,
) -> bool {
    if event.need_rescan() || event.paths.is_empty() {
        return false;
    }
    matches!(event.kind, EventKind::Access(_))
        || event.paths.iter().all(|path| {
            !settings_file(root, path)
                && (match lists {
                    Some(lists) => unreached(lists, root, path),
                    None => dot_led(root, path),
                } || stands(path))
        })
}

/// How often passes start, so a loop of them shows in a log.
#[derive(Debug, Default)]
struct PassRate {
    /// When the passes of the last minute started, oldest first.
    recent: std::collections::VecDeque<Instant>,
}

impl PassRate {
    const WINDOW: Duration = Duration::from_secs(60);

    /// Counts a pass starting at `now`. Returns how many passes started in
    /// the last minute when they exceed one a second, then forgets them so a
    /// minute is told once.
    fn started(&mut self, now: Instant) -> Option<usize> {
        while self
            .recent
            .front()
            .is_some_and(|at| now.saturating_duration_since(*at) >= Self::WINDOW)
        {
            self.recent.pop_front();
        }
        self.recent.push_back(now);
        if self.recent.len() as u64 <= Self::WINDOW.as_secs() {
            return None;
        }
        let count = self.recent.len();
        self.recent.clear();
        Some(count)
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
    fn the_watch_listens_only_for_the_settle_time_that_is_left() {
        let now = Instant::now() + 10 * SECOND;
        let gate = |since_change: Duration, since_pass: Duration| Gate {
            last_change: now - since_change,
            last_pass: now - since_pass,
        };
        let ms = Duration::from_millis;
        assert_eq!(gate(ms(0), SECOND).listen_for(now), SETTLE);
        assert_eq!(gate(ms(100), SECOND).listen_for(now), ms(150));
        // The longest a steady change holds a pass off bounds the wait too.
        assert_eq!(gate(ms(10), HELD_MOST - ms(40)).listen_for(now), ms(40));
        // Witness: with nothing to settle it waits out a tick, as it did.
        assert!(gate(SETTLE, SECOND).due(now));
        assert_eq!(gate(SETTLE, SECOND).listen_for(now), TICK);
        assert_eq!(gate(5 * SECOND, SECOND).listen_for(now), TICK);
    }

    #[test]
    fn a_change_that_arrived_during_a_pass_settles_from_when_it_arrived() {
        let start = Instant::now();
        let mut gate = Gate::new(start);
        let delivered = start + SECOND;
        let ended = start + 3 * SECOND;
        gate.changed(delivered);
        gate.passed(ended);
        assert!(
            gate.due(ended),
            "a file written two seconds before the pass ended is read at once"
        );
        // Witness: a change that arrives as the pass ends still settles first.
        gate.changed(ended);
        assert!(!gate.due(ended));
        assert!(gate.due(ended + SETTLE));
    }

    #[test]
    fn a_change_heard_late_does_not_move_the_last_change_back() {
        let start = Instant::now();
        let mut gate = Gate::new(start);
        gate.changed(start + 3 * SECOND);
        gate.changed(start + SECOND);
        gate.passed(start + 3 * SECOND);
        assert!(!gate.due(start + 3 * SECOND));
        assert!(gate.due(start + 3 * SECOND + SETTLE));
    }

    #[test]
    fn events_waiting_are_read_before_a_pass_unless_the_ceiling_is_reached() {
        let now = Instant::now() + 10 * SECOND;
        let gate = |since_pass: Duration| Gate {
            last_change: now - 10 * SECOND,
            last_pass: now - since_pass,
        };
        assert!(gate(SECOND).reads_first(now));
        assert!(gate(HELD_MOST - Duration::from_millis(1)).reads_first(now));
        // Witness: past the ceiling the gate is asked whatever waits.
        assert!(!gate(HELD_MOST).reads_first(now));
    }

    #[test]
    fn a_server_change_told_before_the_last_pull_began_starts_no_pass() {
        let began = Instant::now() + SECOND;
        let telling = Telling {
            pull_began: Some(began),
            ..Telling::default()
        };
        // The witness: one applied as the pull began, or later, is not in it.
        assert!(telling.unseen_by_pull(began));
        assert!(telling.unseen_by_pull(began + SECOND));
        assert!(!telling.unseen_by_pull(began - Duration::from_millis(1)));
        // Before any pull, every change waits for one.
        assert!(Telling::default().unseen_by_pull(began));
    }

    #[test]
    fn a_server_change_applied_between_the_scan_and_the_pull_starts_a_pass_where_a_file_is_held() {
        let (_dir, folder, _server, _passes, bound_item) =
            super::super::quiet_watch_tests::held_note();
        let scan_began = Instant::now();
        let telling = Telling {
            scan_began: Some(scan_began),
            pull_began: Some(scan_began + 2 * SECOND),
            ..Telling::default()
        };
        // The scan judged the held file's links before this change was
        // applied, and the pull leaves a held file be.
        let between = scan_began + SECOND;
        assert!(
            folder.unseen_by_pass(&telling, between, Some("an-item-no-file-is-bound-to")),
            "a new item the scan did not see, with a file held, started no pass"
        );
        assert!(
            folder.unseen_by_pass(&telling, between, None),
            "a change naming no item, with a file held, started no pass"
        );
        // The witnesses: the echo of an edit to a bound item, one the scan
        // had, one after the pull's start, and one where no file is held.
        assert!(!folder.unseen_by_pass(&telling, between, Some(&bound_item)));
        assert!(!folder.unseen_by_pass(
            &telling,
            scan_began - Duration::from_millis(1),
            Some("an-item-no-file-is-bound-to")
        ));
        assert!(folder.unseen_by_pass(&telling, scan_began + 2 * SECOND, Some(&bound_item)));
        let (_dir, quiet, _server, _passes) = crate::folder::tests::watched_notes(&["a.md"]);
        assert!(
            !quiet.unseen_by_pass(&telling, between, Some("an-item-no-file-is-bound-to")),
            "the pull read it and nothing is held, yet a pass would run"
        );
    }

    #[test]
    fn an_edit_a_pass_sent_and_wrote_back_leaves_no_work_for_a_tick() {
        let settings = SettingsFileReport::default();
        let mut scan = heard_nothing();
        scan.updated = 1;
        let mut drain = drained();
        drain.report.answered = 1;
        let mut pull = PullReport {
            rewritten: 1,
            written: 1,
            ..PullReport::default()
        };
        assert!(!stirred(&settings, &scan, &drain, &pull));
        // The witness: a file the pass has yet to see made, or moved, is work.
        scan.created = 1;
        assert!(stirred(&settings, &scan, &drain, &pull));
        scan.created = 0;
        pull.moved = 1;
        assert!(stirred(&settings, &scan, &drain, &pull));
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
    fn an_event_that_says_events_were_lost_or_names_no_path_starts_a_pass() {
        use notify::event::{AccessKind, CreateKind, Flag};
        let (lists, root) = (record_lists(), Path::new("/folder"));
        let ignored = || root.join("Repos/app/out.o");
        let create = || notify::Event::new(EventKind::Create(CreateKind::File));
        // The witness: the same event on an ignored path is passed over.
        assert!(event_passed_over(
            &create().add_path(ignored()),
            root,
            Some(&lists)
        ));
        assert!(!event_passed_over(
            &create().add_path(ignored()).set_flag(Flag::Rescan),
            root,
            Some(&lists)
        ));
        assert!(!event_passed_over(&create(), root, Some(&lists)));
        assert!(!event_passed_over(
            &notify::Event::new(EventKind::Other).set_flag(Flag::Rescan),
            root,
            None
        ));
        assert!(event_passed_over(
            &notify::Event::new(EventKind::Access(AccessKind::Any))
                .add_path(root.join("Notes/a.md")),
            root,
            Some(&lists)
        ));
    }

    #[test]
    fn passes_are_reported_only_when_a_minute_of_them_exceeds_one_a_second() {
        let start = Instant::now();
        let at = |seconds: f64| start + Duration::from_secs_f64(seconds);
        let mut rate = PassRate::default();
        // A pass every half second: the sixty-first within a minute is told.
        for step in 0..60 {
            assert_eq!(rate.started(at(step as f64 * 0.5)), None);
        }
        assert_eq!(rate.started(at(30.0)), Some(61));
        // A pass a second or fewer never is, however long it goes on.
        for second in 31..300 {
            assert_eq!(rate.started(at(second as f64)), None);
        }
        // A minute is told once however many passes follow.
        for step in 0..60 {
            assert_eq!(rate.started(at(400.0 + step as f64 * 0.01)), None);
        }
        assert_eq!(rate.started(at(401.0)), Some(61));
    }

    #[test]
    fn passes_that_stop_and_start_again_are_not_counted_over_more_than_a_minute() {
        let start = Instant::now();
        let at = |seconds: f64| start + Duration::from_secs_f64(seconds);
        let mut rate = PassRate::default();
        for step in 0..40 {
            assert_eq!(rate.started(at(step as f64 * 0.1)), None);
        }
        // Nothing for ten minutes, then more: forty and thirty are not seventy.
        for step in 0..30 {
            assert_eq!(rate.started(at(600.0 + step as f64 * 0.1)), None);
        }
        // The witness: thirty-one more within the same minute are told.
        for step in 30..60 {
            rate.started(at(600.0 + step as f64 * 0.1));
        }
        assert_eq!(rate.started(at(606.0)), Some(61));
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
            withdrawn: std::collections::HashSet::new(),
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

    /// A pass that heard a whole-call refusal, one that heard the server
    /// answer, and one that heard nothing: no name was asked, or every call
    /// failed with no answer.
    fn refused() -> ScanReport {
        ScanReport {
            lookup_refused: Some("links by name wait".into()),
            ..ScanReport::default()
        }
    }

    fn answered() -> ScanReport {
        ScanReport {
            lookup_answered: true,
            ..ScanReport::default()
        }
    }

    fn heard_nothing() -> ScanReport {
        ScanReport::default()
    }

    fn passed_with(telling: &mut Telling, full: bool, scan: ScanReport) -> Option<WatchPass> {
        match telling.passed(
            full,
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
    fn a_refused_title_lookup_is_told_once_while_it_stands_and_again_when_it_clears() {
        let mut telling = Telling::default();
        let first = passed_with(&mut telling, true, refused()).unwrap();
        assert!(first.lookup_changed, "the refusal was not told");
        assert_eq!(
            first.scan.lookup_refused.as_deref(),
            Some("links by name wait")
        );
        assert!(
            passed_with(&mut telling, true, refused()).is_none(),
            "a full pass told the standing refusal again"
        );
        let cleared = passed_with(&mut telling, true, answered()).unwrap();
        assert!(cleared.lookup_changed, "a cleared refusal was not told");
        assert_eq!(cleared.scan.lookup_refused, None);
        assert!(
            passed_with(&mut telling, true, heard_nothing()).is_none(),
            "a cleared refusal came back"
        );
    }

    #[test]
    fn a_refusal_stands_through_a_pass_that_heard_nothing_of_the_server() {
        for full in [true, false] {
            let mut telling = Telling::default();
            passed_with(&mut telling, true, refused()).unwrap();
            assert!(
                passed_with(&mut telling, full, heard_nothing()).is_none(),
                "a pass that asked the server nothing lifted the refusal (full: {full})"
            );
            // The witness: the same pass lifts it where the server answered.
            let lifted = passed_with(&mut telling, full, answered()).unwrap();
            assert!(lifted.lookup_changed, "full: {full}");
            assert_eq!(lifted.scan.lookup_refused, None, "full: {full}");
        }
    }

    #[test]
    fn a_quick_pass_that_hears_the_server_answer_lifts_the_refusal_and_it_stays_lifted() {
        let mut telling = Telling::default();
        passed_with(&mut telling, true, refused()).unwrap();
        // Held files are judged again on a quick pass, and the server answers.
        let lifted = passed_with(&mut telling, false, answered()).unwrap();
        assert!(lifted.lookup_changed);
        assert_eq!(lifted.scan.lookup_refused, None);
        for full in [false, true] {
            assert!(
                passed_with(&mut telling, full, heard_nothing()).is_none(),
                "the old refusal was put back by a pass that heard nothing (full: {full})"
            );
        }
    }

    #[test]
    fn a_quick_pass_that_hears_a_refusal_sets_it() {
        let mut telling = Telling::default();
        passed_with(&mut telling, true, answered()).unwrap();
        let set = passed_with(&mut telling, false, refused()).unwrap();
        assert!(set.lookup_changed);
        assert_eq!(
            set.scan.lookup_refused.as_deref(),
            Some("links by name wait")
        );
    }

    #[test]
    fn a_refusal_heard_beside_an_answered_call_stands() {
        let mut telling = Telling::default();
        let both = ScanReport {
            lookup_answered: true,
            ..refused()
        };
        let first = passed_with(&mut telling, true, both).unwrap();
        assert_eq!(
            first.scan.lookup_refused.as_deref(),
            Some("links by name wait")
        );
    }

    #[test]
    fn a_new_notice_does_not_say_the_standing_lookup_refusal_again() {
        let mut telling = Telling::default();
        passed_with(&mut telling, true, refused()).unwrap();
        let more = passed_with(
            &mut telling,
            true,
            ScanReport {
                secrets: vec![".env".into()],
                ..heard_nothing()
            },
        )
        .unwrap();
        assert!(more.notices_changed, "the witness: the secret is news");
        assert!(
            !more.lookup_changed,
            "an unchanged refusal was told again beside a new notice"
        );
    }

    #[test]
    fn a_folder_whose_directory_is_gone_keeps_the_refusal_it_had() {
        let mut telling = Telling::default();
        passed_with(&mut telling, true, refused()).unwrap();
        telling.waiting(
            SettingsFileReport::default(),
            ScanReport {
                root_gone: Some("gone".into()),
                ..ScanReport::default()
            },
        );
        assert!(
            passed_with(&mut telling, true, heard_nothing()).is_some_and(|pass| {
                !pass.lookup_changed
                    && pass.scan.lookup_refused.as_deref() == Some("links by name wait")
            })
        );
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
    #[cfg(target_vendor = "apple")]
    #[test]
    fn a_direct_call_to_watch_runs_at_utility_and_puts_the_callers_class_back() {
        use crate::priority::current_class;
        const UTILITY: u32 = libc::qos_class_t::QOS_CLASS_UTILITY as u32;
        let dir = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let state = dir.path().join(crate::folder::STATE_DIR);
        std::fs::create_dir_all(&state).unwrap();
        let core = crate::Core::open(state.join("core.sqlite"), None).unwrap();
        crate::folder::settings_file::bind(&core, "01a00000-0000-7000-8000-000000000001").unwrap();
        drop(core);
        let folder = Folder::open(dir.path(), None).unwrap();
        let (before, during, after) = std::thread::scope(|scope| {
            scope
                .spawn(|| {
                    let stop = AtomicBool::new(false);
                    let before = current_class();
                    let mut during = None;
                    let _ = folder.watch(&stop, |event| {
                        if let WatchEvent::Watching { .. } = event {
                            during = Some(current_class());
                            stop.store(true, Ordering::SeqCst);
                        }
                        Ok::<(), ()>(())
                    });
                    (before, during, current_class())
                })
                .join()
                .unwrap()
        });
        // The witness: the thread that calls is not at utility until it watches.
        assert_ne!(before, UTILITY);
        assert_eq!(during, Some(UTILITY));
        assert_eq!(after, before);
    }
}
