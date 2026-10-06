use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use notify::{EventKind, RecursiveMode, Watcher};

use super::lists::Lists;
use super::{
    Drained, Flagged, Folder, PullReport, SETTINGS_FILE, STATE_DIR, ScanReport, SettingsFileReport,
    Uncarried, Unsure,
};
use crate::error::CoreError;

/// An editor saves a file in several steps; a scan between two of them
/// would push a half-written file.
const SETTLE: Duration = Duration::from_millis(250);

/// Nothing on the filesystem marks a journaled delete's grace running out.
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
    Watching { dir: PathBuf },
    /// The filesystem reported an error; the watch goes on.
    WatcherFailed(String),
    /// A hydration failed and is tried again after `wait`, which doubles
    /// after each failure up to `RETRY_MOST`. Told once for each run of
    /// failures.
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

enum Wake {
    File(notify::Result<notify::Event>),
    Server,
    Retrying(CoreError, Duration),
    /// Why the server cannot be reached, or `None` where it answers again.
    Reach(Option<String>),
    Ended(CoreError),
}

impl Folder {
    /// Keeps the folder in step until `stop` is raised: each change on disk,
    /// once it settles, and each change on the server starts a pass, and a
    /// pass runs every second besides. A pass under way when `stop` is raised
    /// finishes first.
    pub fn watch<E>(
        &self,
        stop: &AtomicBool,
        mut tell: impl FnMut(WatchEvent) -> Result<(), E>,
    ) -> Result<(), WatchError<E>> {
        // Only a person's go-ahead lets it write or send, and none can reach
        // a folder this watch holds.
        self.refuse_while_waiting()?;
        // Raised as the passes end, whatever ended them, so the follow and a
        // hydration it runs end with them.
        let ended = AtomicBool::new(false);
        let (sender, wakes) = mpsc::channel::<Wake>();
        std::thread::scope(|scope| {
            let server_wakes = sender.clone();
            let follower = scope.spawn(|| follow(self, &ended, server_wakes));
            let watched = {
                // A guard, so a pass or a `tell` that panics still ends the
                // follow: the scope waits for it before the panic goes on.
                let _ending = Raise(&ended);
                self.watch_files(stop, sender, &wakes, &mut tell)
            };
            let followed = follower.join().map_err(|_| {
                WatchError::Unwatchable(
                    "the follow of the server's changes ended in a fault".into(),
                )
            })?;
            watched.and(followed.map_err(WatchError::Core))
        })
    }

    fn watch_files<E>(
        &self,
        stop: &AtomicBool,
        sender: mpsc::Sender<Wake>,
        events: &mpsc::Receiver<Wake>,
        tell: &mut impl FnMut(WatchEvent) -> Result<(), E>,
    ) -> Result<(), WatchError<E>> {
        // macOS reports resolved paths (`/private/var/...`); unresolved, every
        // strip below fails and the folder wakes itself through `.marfa` writes.
        let dir = &std::fs::canonicalize(&self.root).unwrap_or_else(|_| self.root.clone());
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
        tell(WatchEvent::Watching { dir: dir.clone() }).map_err(WatchError::Told)?;

        let mut gate = Gate::new(Instant::now());
        let mut telling = Telling::default();
        let mut last_full: Option<Instant> = None;
        let mut lists = self.settings().and_then(|settings| settings.lists()).ok();
        loop {
            if stop.load(Ordering::SeqCst) {
                break;
            }
            match events.recv_timeout(TICK) {
                Ok(Wake::File(Ok(event))) => {
                    // `Access` is an open or the close after a write, which has
                    // already shown itself as a modify.
                    let passed_over = matches!(event.kind, EventKind::Access(_))
                        || event.paths.iter().all(|path| {
                            dot_led(dir, path)
                                && !settings_file(dir, path)
                                && !lists.as_ref().is_some_and(|lists| taken(lists, dir, path))
                        });
                    if !passed_over {
                        gate.changed(Instant::now());
                    } else if !gate.passed_over_is_due(Instant::now()) {
                        continue;
                    }
                }
                Ok(Wake::File(Err(error))) => {
                    tell(WatchEvent::WatcherFailed(error.to_string())).map_err(WatchError::Told)?;
                }
                Ok(Wake::Server) => {}
                Ok(Wake::Retrying(error, wait)) => {
                    tell(WatchEvent::Retrying { error, wait }).map_err(WatchError::Told)?;
                }
                Ok(Wake::Reach(lost)) => {
                    if let Some(event) = telling.reach(lost) {
                        tell(event).map_err(WatchError::Told)?;
                    }
                }
                Ok(Wake::Ended(error @ CoreError::Unauthorized { .. })) => {
                    return Err(WatchError::CredentialRefused(error));
                }
                Ok(Wake::Ended(error)) => return Err(WatchError::FollowEnded(error)),
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
            // No "was there a change" flag: it would stop the journal being
            // swept in a folder that went quiet after a delete.
            if !gate.due(Instant::now()) {
                continue;
            }
            let full = full_due(last_full, Instant::now());
            if full {
                last_full = Some(Instant::now());
            }
            match self.pass(full, &mut telling, tell) {
                // The follow is hydrating the copy; a later pass finds it whole.
                Err(WatchError::Core(CoreError::HydrationIncomplete)) => {}
                other => other?,
            }
            gate.passed(Instant::now());
            lists = self.settings().and_then(|settings| settings.lists()).ok();
        }
        Ok(())
    }

    fn pass<E>(
        &self,
        full: bool,
        telling: &mut Telling,
        tell: &mut impl FnMut(WatchEvent) -> Result<(), E>,
    ) -> Result<(), WatchError<E>> {
        let settings = self.send_settings_edit()?;
        let scan = self.scan_watching(full, SETTLE)?;
        // Told once, and every tick looks again, so the watch goes on where
        // it left off once the directory is back.
        if scan.root_gone.is_some() {
            if let Some(event) = telling.waiting(settings, scan) {
                tell(event).map_err(WatchError::Told)?;
            }
            return Ok(());
        }
        let drain = self.drain()?;
        let reached = match &drain.report.unavailable {
            Some(why) => telling.reach(Some(why.clone())),
            None if drain.report.answered > 0 => telling.reach(None),
            None => None,
        };
        if let Some(event) = reached {
            tell(event).map_err(WatchError::Told)?;
        }
        let pull = self.pull()?;
        let refused = credential_refused(&drain);
        if let Some(event) = telling.passed(full, settings, scan, drain, pull) {
            tell(event).map_err(WatchError::Told)?;
        }
        refused.map_or(Ok(()), |error| Err(WatchError::CredentialRefused(error)))
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
struct Raise<'a>(&'a AtomicBool);

impl Drop for Raise<'_> {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

fn follow(folder: &Folder, ended: &AtomicBool, wakes: mpsc::Sender<Wake>) -> Result<(), CoreError> {
    let mut retry = RETRY_FIRST;
    // Told once for each run of failures, as the reachability is.
    let mut said = false;
    while !ended.load(Ordering::SeqCst) {
        let followed = folder.resume_until(ended).and_then(|hydrated| {
            retry = RETRY_FIRST;
            said = false;
            if hydrated.is_some() {
                let _ = wakes.send(Wake::Server);
            }
            folder.core().follow(ended, |change| {
                let _ = wakes.send(match change.event.as_str() {
                    crate::SERVER_UNREACHABLE => {
                        Wake::Reach(Some(change.reason.as_ref().map_or_else(
                            || "the event stream could not be opened".into(),
                            ToString::to_string,
                        )))
                    }
                    crate::SERVER_REACHABLE => Wake::Reach(None),
                    _ => Wake::Server,
                });
            })
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

fn retry_schedule(backoff: Duration, error: &CoreError) -> (Duration, Duration) {
    let wait = error
        .retry_after()
        .map_or(backoff, |named| backoff.max(named));
    (wait, (backoff * 2).min(RETRY_MOST))
}

fn wait_unless_stopped(stop: &AtomicBool, wait: Duration) {
    let until = Instant::now() + wait;
    while !stop.load(Ordering::SeqCst) {
        let left = until.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return;
        }
        std::thread::sleep(left.min(Duration::from_millis(250)));
    }
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

/// What the passes have told, so a standing condition is told once, not
/// once a second.
#[derive(Debug, Default)]
struct Telling {
    standing: Option<Standing>,
    unreachable: bool,
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
    fn reach(&mut self, lost: Option<String>) -> Option<WatchEvent> {
        match lost {
            Some(reason) if !self.unreachable => {
                self.unreachable = true;
                Some(WatchEvent::Reach(Some(reason)))
            }
            None if self.unreachable => {
                self.unreachable = false;
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
        let happened = scan.created
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
            > 0;
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

fn taken(lists: &Lists, root: &Path, path: &Path) -> bool {
    path.strip_prefix(root)
        .ok()
        .and_then(|relative| relative.to_str())
        .is_some_and(|relative| lists.takes(relative))
}

fn dot_led(root: &Path, path: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(root) else {
        return false;
    };
    relative
        .components()
        .any(|part| part.as_os_str().to_string_lossy().starts_with('.'))
}

#[cfg(test)]
mod tests {
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

    #[test]
    fn the_first_pass_reads_every_file_and_then_one_a_minute() {
        let now = Instant::now();
        assert!(full_due(None, now));
        assert!(!full_due(Some(now), now + 59 * SECOND));
        assert!(full_due(Some(now), now + FULL_PASS));
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
