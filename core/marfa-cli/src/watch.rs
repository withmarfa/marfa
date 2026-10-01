use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use marfa_core::{CoreError, Folder, Server};
use notify::{EventKind, RecursiveMode, Watcher};

use crate::error::CliError;
use crate::output;

/// How long the watcher waits for the filesystem to go quiet before it acts.
///
/// An editor saving a file writes it in several steps, and a scan run
/// between two of them reads a file halfway through being written and pushes
/// it. The debounce is what makes a burst of events one scan.
const SETTLE: Duration = Duration::from_millis(250);

/// How often the folder acts with nothing happening: nothing on the
/// filesystem marks the moment a journaled delete's grace runs out
/// (`folders.md` 21).
const TICK: Duration = Duration::from_secs(1);

/// How often a pass reads every file, rather than only those whose size,
/// time or identity changed (`folders.md` 49).
const FULL_PASS: Duration = Duration::from_secs(60);

/// Whether this pass reads every file: the first does, and then one a
/// minute, which finds a change the size and time did not show.
fn full_due(last: Option<Instant>, now: Instant) -> bool {
    last.is_none_or(|last| now.duration_since(last) >= FULL_PASS)
}

/// The longest changes that never settle hold off a pass. A file written
/// more often than the debounce, a log say, would otherwise keep every
/// other file and every change from the server out of step for as long as
/// it is written. An editor's save settles long before this, so only a
/// change that never stops is read mid-write, and the next pass reads it
/// again.
const HELD_MOST: Duration = Duration::from_secs(5);

/// When the watch last saw a change and last ran a pass, which decide
/// whether a pass runs now.
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

    /// Measured from the end: a pass's own reads are events passed over, and
    /// measured from its start a pass longer than a tick would set off the
    /// next one.
    fn passed(&mut self, now: Instant) {
        self.last_pass = now;
    }

    /// Whether an event the loop passes over lets the tick's pass run: only
    /// once a tick has gone by since the last pass ended and since the last
    /// change, as a receive that timed out would. inotify reports every open
    /// of a file, so a reader faster than the tick would otherwise keep the
    /// receive from ever timing out.
    fn passed_over_is_due(&self, now: Instant) -> bool {
        now.duration_since(self.last_pass) >= TICK && now.duration_since(self.last_change) >= TICK
    }

    /// Whether a pass runs now: once the folder has settled, or once
    /// changes that never settle have held it off for `HELD_MOST`.
    fn due(&self, now: Instant) -> bool {
        now.duration_since(self.last_change) >= SETTLE
            || now.duration_since(self.last_pass) >= HELD_MOST
    }
}

/// Watches a folder and keeps it in step. Every pass, the first included,
/// decides identity by the same rule (`folders.md` 18).
pub fn watch(
    dir: &Path,
    server: Server,
    stop_after: Option<Duration>,
    json: bool,
) -> Result<(), CliError> {
    let folder = Folder::open(dir, Some(server))?;
    let stop = AtomicBool::new(false);
    let (sender, wakes) = mpsc::channel::<Wake>();
    std::thread::scope(|scope| {
        // The server's side is held open beside the folder's, so another
        // device's change reaches the copy as it happens and the next pass
        // writes it out, where a folder that only ever pushed would hold what
        // it had at its last hydration for good.
        let server_wakes = sender.clone();
        let follower = scope.spawn(|| follow(&folder, &stop, server_wakes));
        let watched = watch_files(&folder, dir, sender, &wakes, stop_after, json);
        stop.store(true, Ordering::SeqCst);
        let followed = follower.join().map_err(|_| {
            CliError::Watch("the follow of the server's changes ended in a fault".into())
        })?;
        watched.and(followed)
    })
}

/// What wakes the watcher: the filesystem, or the server's side.
enum Wake {
    File(notify::Result<notify::Event>),
    /// A change from the server reached the copy.
    Server,
    /// The follow ended for a reason no retry changes.
    Ended(String),
}

/// The first wait before a failed hydration is tried again, and the longest
/// it doubles to.
const RETRY_FIRST: Duration = Duration::from_secs(1);
const RETRY_MOST: Duration = Duration::from_secs(30);

/// Follows the server, hydrating first where the copy cannot answer
/// (`device.md` 16); an answer no retry changes ends the watch.
fn follow(folder: &Folder, stop: &AtomicBool, wakes: mpsc::Sender<Wake>) -> Result<(), CliError> {
    let mut retry = RETRY_FIRST;
    while !stop.load(Ordering::SeqCst) {
        let followed = folder.resume().and_then(|hydrated| {
            retry = RETRY_FIRST;
            if hydrated.is_some() {
                let _ = wakes.send(Wake::Server);
            }
            folder.core().follow(stop, |_| {
                let _ = wakes.send(Wake::Server);
            })
        });
        match followed {
            Ok(_) => break,
            Err(CoreError::CatchUpTooOld { .. }) => {}
            Err(error) if error.is_environmental() => {
                let (wait, next) = retry_schedule(retry, &error);
                eprintln!("could not hydrate ({error}); trying again in {wait:?}");
                wait_unless_stopped(stop, wait);
                retry = next;
            }
            Err(error) => {
                let _ = wakes.send(Wake::Ended(error.to_string()));
                return Err(error.into());
            }
        }
    }
    Ok(())
}

/// The wait before the next hydration after one that failed with `error`,
/// the server's `Retry-After` where it names longer, and the backoff after it.
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

/// The filesystem side of a watch: a pass whenever the folder settles, and
/// on every tick.
fn watch_files(
    folder: &Folder,
    dir: &Path,
    sender: mpsc::Sender<Wake>,
    events: &mpsc::Receiver<Wake>,
    stop_after: Option<Duration>,
    json: bool,
) -> Result<(), CliError> {
    // Resolved, because the filter below strips this prefix off the paths
    // the watcher reports and macOS reports them resolved: a folder under
    // `/var/folders/...` comes back as `/private/var/folders/...`, every
    // strip fails, every path reads as not dot-led, and the folder wakes
    // itself through its own writes under `.marfa` a few times a second.
    let dir = &std::fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
    let mut watcher = notify::recommended_watcher(move |event| {
        let _ = sender.send(Wake::File(event));
    })
    .map_err(|error| CliError::Watch(format!("cannot watch: {error}")))?;
    // Watching starts before the first pass, so a file that arrives during
    // that pass is seen by the watcher rather than falling between the two.
    watcher
        .watch(dir, RecursiveMode::Recursive)
        .map_err(|error| CliError::Watch(format!("cannot watch {}: {error}", dir.display())))?;
    eprintln!("watching {} (interrupt to stop)", dir.display());

    let started = Instant::now();
    let mut gate = Gate::new(Instant::now());
    // What stood after the last pass that printed, so a standing condition
    // is said once rather than once a second.
    let mut standing: Option<Standing> = None;
    let mut last_full: Option<Instant> = None;
    // Read again after each pass, which is when the settings can change.
    let mut lists = folder.settings().and_then(|settings| settings.lists()).ok();
    loop {
        if let Some(limit) = stop_after
            && started.elapsed() >= limit
        {
            break;
        }
        match events.recv_timeout(TICK) {
            Ok(Wake::File(Ok(event))) => {
                // `Access` is an open or the close after a write, and a folder
                // does not push a file because somebody opened it; a write
                // has already shown itself as a modify. A dot-led path is watched only
                // where the include list names it (`folders.md` 25), and
                // `.marfa` only for the settings file (28); this stops a write
                // under `.marfa` waking a pass.
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
            Ok(Wake::File(Err(error))) => eprintln!("watch error: {error}"),
            // A change from elsewhere is written out on the pass below.
            Ok(Wake::Server) => {}
            Ok(Wake::Ended(reason)) => {
                return Err(CliError::Watch(format!(
                    "the server's changes stopped reaching this folder: {reason}"
                )));
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
        // A pass on every tick, not only on a change: a journaled delete
        // becomes a delete when its grace runs out, and nothing on the
        // filesystem marks that. So once a tick is due, the only gate is
        // the debounce — an editor writes a file in several steps, and a
        // pass between two of them reads a file halfway through being
        // written and pushes it. Only changes that never settle pass it,
        // once they have held a pass off for `HELD_MOST`.
        //
        // There is deliberately no "was there a change" flag beside this.
        // A pass with nothing to do is cheap and says nothing, and a flag
        // that gated the pass would stop the journal ever being swept in a
        // folder that went quiet after a delete.
        if !gate.due(Instant::now()) {
            continue;
        }
        let full = full_due(last_full, Instant::now());
        if full {
            last_full = Some(Instant::now());
        }
        match step(folder, json, full, &mut standing) {
            // The follow is hydrating the copy, or will try again, and a
            // later pass finds it whole.
            Err(CliError::Core(CoreError::HydrationIncomplete)) => {}
            other => other?,
        }
        gate.passed(Instant::now());
        lists = folder.settings().and_then(|settings| settings.lists()).ok();
    }
    Ok(())
}

/// What a pass leaves standing rather than does: files that are not in step.
/// Said when it changes, not on every pass it stays the same.
#[derive(Debug, Clone, PartialEq)]
struct Standing {
    lost: usize,
    unreached: usize,
    directories: Vec<String>,
    secrets: Vec<String>,
    unwritten: usize,
    outside: usize,
    unsuited: usize,
    unplaced: usize,
    absent: usize,
    kept: usize,
    unmatched: usize,
    settings: Option<String>,
    flagged: Vec<marfa_core::folder::Flagged>,
    uncarried: Vec<marfa_core::folder::Uncarried>,
    embeds: Vec<String>,
    registry: Option<String>,
    unsure: Vec<marfa_core::folder::Unsure>,
    /// A large removal waiting, from the disk and from a pull.
    paused: (usize, usize),
}

/// One pass: read the folder, send what it queued, write back what came in.
fn step(
    folder: &Folder,
    json: bool,
    full: bool,
    standing: &mut Option<Standing>,
) -> Result<(), CliError> {
    let settings = folder.send_settings_edit()?;
    let scanned = if full {
        folder.scan()?
    } else {
        folder.scan_quick()?
    };
    let drained = folder.drain()?;
    let pulled = folder.pull()?;
    // Quiet unless something happened or what stands changed. Files already
    // in step, or outside the search, are not events.
    let happened = scanned.created
        + scanned.updated
        + scanned.renamed
        // A paused removal's files are missing at every pass, and are said
        // through `paused` when it changes.
        + scanned.missing.saturating_sub(scanned.paused)
        + scanned.deleted
        + scanned.moved_away
        + scanned.requeued
        + drained.report.verdicts.len()
        + drained.gave_way
        + pulled.written
        + pulled.rewritten
        + pulled.moved
        + pulled.removed
        + pulled.taken
        + pulled.let_go
        + pulled.revived
        + usize::from(settings.sent)
        > 0;
    let now = Standing {
        paused: (scanned.paused, pulled.paused),
        lost: scanned.lost,
        unreached: scanned.unreached,
        directories: crate::folders::directory_lines(&scanned.directories),
        secrets: crate::folders::secret_lines(&scanned.secrets),
        unwritten: pulled.unwritten,
        outside: pulled.outside,
        unsuited: pulled.unsuited,
        unplaced: pulled.unplaced,
        absent: pulled.absent,
        kept: pulled.kept,
        unmatched: pulled.unmatched,
        settings: settings.flagged.clone().or(pulled.settings.flagged.clone()),
        flagged: {
            let mut flagged = scanned.flagged.clone();
            for file in &pulled.flagged {
                if !flagged.iter().any(|seen| seen.path == file.path) {
                    flagged.push(file.clone());
                }
            }
            flagged
        },
        uncarried: pulled.uncarried.clone(),
        embeds: {
            let mut embeds =
                crate::folders::embed_lines(scanned.embeds.iter().chain(&pulled.embeds));
            // A quick pass reads no unchanged file, so says none of its embeds.
            if !full && let Some(before) = standing.as_ref() {
                for line in &before.embeds {
                    if !embeds.contains(line) {
                        embeds.push(line.clone());
                    }
                }
            }
            embeds
        },
        registry: scanned.registry.clone(),
        unsure: scanned.unsure.clone(),
    };
    let changed = standing.as_ref() != Some(&now);
    // Said when it changes, as what stands is, not at every eventful pass.
    let unplaced = standing
        .as_ref()
        .is_none_or(|before| before.unplaced != now.unplaced)
        .then(|| crate::folders::unplaced_line(pulled.unplaced))
        .flatten();
    let said: Vec<String> = crate::folders::trashed_lines(&scanned)
        .into_iter()
        .chain(crate::folders::uncarried_line(&now.uncarried))
        .chain((scanned.paused > 0).then(|| crate::folders::paused_line(scanned.paused, false)))
        .chain((pulled.paused > 0).then(|| crate::folders::paused_line(pulled.paused, true)))
        .chain(
            scanned
                .warnings
                .iter()
                .map(|file| format!("{}: {}", file.path, file.reason)),
        )
        .chain(now.directories.iter().cloned())
        .chain(now.secrets.iter().cloned())
        .chain(crate::folders::flagged_lines(&now.flagged))
        .chain(now.embeds.iter().cloned())
        .collect();
    *standing = Some(now);
    if !happened && !changed {
        return Ok(());
    }
    output::report(
        &serde_json::json!({
            "settings": settings,
            "scan": scanned,
            "drain": drained,
            "pull": pulled,
        }),
        json,
        || {
            // An item with no file is named, never left out of the line.
            let held = pulled.unwritten + pulled.outside + pulled.unsuited + pulled.absent;
            let settings = crate::folders::settings_line(&settings)
                .map(|line| format!("{line}\n"))
                .unwrap_or_default();
            format!(
                "{settings}{} created, {} updated, {} renamed, {} deleted; sent {}; {} file(s) written{}{}{}{}",
                scanned.created,
                scanned.updated,
                scanned.renamed,
                scanned.deleted,
                drained.report.sent,
                pulled.written + pulled.rewritten,
                if held > 0 {
                    format!(", {held} not written")
                } else {
                    String::new()
                },
                [
                    (scanned.lost > 0)
                        .then(|| format!(", {} bound to an item that is gone", scanned.lost)),
                    (scanned.unreached > 0).then(|| {
                        format!(
                            ", {} held where the walk did not reach them",
                            scanned.unreached
                        )
                    }),
                ]
                .into_iter()
                .flatten()
                .collect::<String>(),
                if pulled.unmatched > 0 {
                    format!(
                        ", {} whose item the search no longer matches",
                        pulled.unmatched
                    )
                } else {
                    String::new()
                },
                [
                    (drained.rebased > 0).then(|| crate::folders::rebased_line(drained.rebased)),
                    (drained.gave_way > 0).then(|| crate::folders::gave_way_line(drained.gave_way)),
                    unplaced.clone(),
                ]
                .into_iter()
                .flatten()
                .map(|line| format!("; {line}"))
                .collect::<String>()
            ) + &said
                .iter()
                .map(|line| format!("\n{line}"))
                .collect::<String>()
        },
    )
}

/// Whether a path is the folder's settings file, the one file under `.marfa`
/// a watch watches, so a save of it is waited out as any file's is (`folders.md` 28).
fn settings_file(root: &Path, path: &Path) -> bool {
    path == root
        .join(marfa_core::folder::STATE_DIR)
        .join(marfa_core::folder::SETTINGS_FILE)
}

/// Whether the folder's lists take the file at `path`.
fn taken(lists: &marfa_core::folder::lists::Lists, root: &Path, path: &Path) -> bool {
    path.strip_prefix(root)
        .ok()
        .and_then(|relative| relative.to_str())
        .is_some_and(|relative| lists.takes(relative))
}

/// Whether a path lies under a dot-led directory inside the folder.
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

    /// The loop's timing on a clock the test moves: one file changing twice
    /// a second, each change waking the watch. A pass carries both
    /// directions, its scan and drain sending what changed on the disk and
    /// its pull writing what came from the server, so a bound on the wait
    /// for a pass is a bound on both.
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

        // Witness: the same clock with the changes stopped settles at once,
        // so the bound above is what steady changes cost and nothing more.
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
