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
/// (`folders.md` 18).
const TICK: Duration = Duration::from_secs(1);

/// Watches a folder and keeps it in step. Every pass, the first included, is
/// the same scan (`folders.md` 15).
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
    let mut quiet_since = Instant::now();
    // What stood after the last pass that printed, so a standing condition
    // is said once rather than once a second.
    let mut standing: Option<Standing> = None;
    loop {
        if let Some(limit) = stop_after
            && started.elapsed() >= limit
        {
            break;
        }
        match events.recv_timeout(TICK) {
            Ok(Wake::File(Ok(event))) => {
                // `Access` is a read, and a folder does not push a file
                // because somebody opened it.
                if matches!(event.kind, EventKind::Access(_)) {
                    continue;
                }
                // Dot-led paths are never watched (`folders.md` 22, 23), but
                // for the settings file; this stops a write under `.marfa`
                // waking a pass.
                if event
                    .paths
                    .iter()
                    .all(|path| dot_led(dir, path) && !settings_file(dir, path))
                {
                    continue;
                }
                quiet_since = Instant::now();
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
        // filesystem marks that. So the only gate is the debounce — an
        // editor writes a file in several steps, and a pass between two of
        // them reads a file halfway through being written and pushes it.
        //
        // There is deliberately no "was there a change" flag beside this.
        // A pass with nothing to do is cheap and says nothing, and a flag
        // that gated the pass would stop the journal ever being swept in a
        // folder that went quiet after a delete.
        if quiet_since.elapsed() < SETTLE {
            continue;
        }
        match step(folder, json, &mut standing) {
            // The follow is hydrating the copy, or will try again, and a
            // later pass finds it whole.
            Err(CliError::Core(CoreError::HydrationIncomplete)) => {}
            other => other?,
        }
    }
    Ok(())
}

/// What a pass leaves standing rather than does: files that are not in step.
/// Said when it changes, not on every pass it stays the same.
#[derive(Debug, Clone, PartialEq)]
struct Standing {
    lost: usize,
    unwritten: usize,
    outside: usize,
    absent: usize,
    kept: usize,
    unmatched: usize,
    settings: Option<String>,
}

/// One pass: read the folder, send what it queued, write back what came in.
fn step(folder: &Folder, json: bool, standing: &mut Option<Standing>) -> Result<(), CliError> {
    let settings = folder.send_settings_edit()?;
    let scanned = folder.scan()?;
    let drained = folder.drain()?;
    let pulled = folder.pull()?;
    // Quiet unless something happened or what stands changed. Files already
    // in step, or outside the search, are not events.
    let happened = scanned.created
        + scanned.updated
        + scanned.renamed
        + scanned.missing
        + scanned.deleted
        + scanned.requeued
        + drained.report.verdicts.len()
        + pulled.written
        + pulled.rewritten
        + pulled.moved
        + pulled.removed
        + pulled.revived
        + usize::from(settings.sent)
        > 0;
    let now = Standing {
        lost: scanned.lost,
        unwritten: pulled.unwritten,
        outside: pulled.outside,
        absent: pulled.absent,
        kept: pulled.kept,
        unmatched: pulled.unmatched,
        settings: settings.flagged.clone().or(pulled.settings.flagged.clone()),
    };
    let changed = standing.as_ref() != Some(&now);
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
            let held = pulled.unwritten + pulled.outside + pulled.absent;
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
                if scanned.lost > 0 {
                    format!(", {} bound to an item that is gone", scanned.lost)
                } else {
                    String::new()
                },
                if pulled.unmatched > 0 {
                    format!(
                        ", {} whose item the search no longer matches",
                        pulled.unmatched
                    )
                } else {
                    String::new()
                },
                if drained.rebased > 0 {
                    format!("; {}", crate::folders::rebased_line(drained.rebased))
                } else {
                    String::new()
                }
            )
        },
    )
}

/// Whether a path is the folder's settings file, the one file under `.marfa`
/// a watch watches, so a save of it is waited out as any file's is (`folders.md` 23).
fn settings_file(root: &Path, path: &Path) -> bool {
    path == root
        .join(marfa_core::folder::STATE_DIR)
        .join(marfa_core::folder::SETTINGS_FILE)
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
