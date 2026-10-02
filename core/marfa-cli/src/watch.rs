use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use marfa_core::{CoreError, Folder};
use notify::{EventKind, RecursiveMode, Watcher};

use crate::error::CliError;
use crate::folders;
use crate::output;
use crate::remote::Session;

/// An editor saves a file in several steps; a scan between two of them
/// would push a half-written file.
const SETTLE: Duration = Duration::from_millis(250);

/// Nothing on the filesystem marks a journaled delete's grace running out.
const TICK: Duration = Duration::from_secs(1);

/// Finds a change that size and time did not show.
const FULL_PASS: Duration = Duration::from_secs(60);

fn full_due(last: Option<Instant>, now: Instant) -> bool {
    last.is_none_or(|last| now.duration_since(last) >= FULL_PASS)
}

/// A file written more often than `SETTLE`, a log say, would otherwise hold
/// off every pass for as long as it is written.
const HELD_MOST: Duration = Duration::from_secs(5);

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

pub fn watch(
    dir: &Path,
    session: Session,
    stop_after: Option<Duration>,
    json: bool,
) -> Result<(), CliError> {
    let server = session.server.url.clone();
    let folder = folders::opened(dir, Some(session))?;
    let stop = AtomicBool::new(false);
    let (sender, wakes) = mpsc::channel::<Wake>();
    std::thread::scope(|scope| {
        let server_wakes = sender.clone();
        let follower = scope.spawn(|| follow(&folder, &stop, server_wakes));
        let watched = watch_files(&folder, dir, &server, sender, &wakes, stop_after, json);
        stop.store(true, Ordering::SeqCst);
        let followed = follower.join().map_err(|_| {
            CliError::Watch("the follow of the server's changes ended in a fault".into())
        })?;
        watched.and(followed)
    })
}

enum Wake {
    File(notify::Result<notify::Event>),
    Server,
    /// Why the server cannot be reached, or `None` where it answers again.
    Reach(Option<String>),
    Ended(CoreError),
}

const RETRY_FIRST: Duration = Duration::from_secs(1);
const RETRY_MOST: Duration = Duration::from_secs(30);

fn follow(folder: &Folder, stop: &AtomicBool, wakes: mpsc::Sender<Wake>) -> Result<(), CliError> {
    let mut retry = RETRY_FIRST;
    // Said once for each run of failures, as the reachability line is.
    let mut said = false;
    while !stop.load(Ordering::SeqCst) {
        let followed = folder.resume().and_then(|hydrated| {
            retry = RETRY_FIRST;
            said = false;
            if hydrated.is_some() {
                let _ = wakes.send(Wake::Server);
            }
            folder.core().follow(stop, |change| {
                let _ = wakes.send(match change.event.as_str() {
                    marfa_core::SERVER_UNREACHABLE => Wake::Reach(Some(
                        change
                            .reason
                            .clone()
                            .unwrap_or_else(|| "the event stream could not be opened".into()),
                    )),
                    marfa_core::SERVER_REACHABLE => Wake::Reach(None),
                    _ => Wake::Server,
                });
            })
        });
        match followed {
            Ok(_) => break,
            Err(CoreError::CatchUpTooOld { .. }) => {}
            Err(error) if error.is_environmental() => {
                let (wait, next) = retry_schedule(retry, &error);
                if !said {
                    eprintln!(
                        "could not hydrate ({error}); trying again in {wait:?}, and after each failure \
                         a wait that doubles to {RETRY_MOST:?}, or longer where the server names one"
                    );
                    said = true;
                }
                wait_unless_stopped(stop, wait);
                retry = next;
            }
            Err(error) => {
                let _ = wakes.send(Wake::Ended(error.clone()));
                return Err(error.into());
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

fn watch_files(
    folder: &Folder,
    dir: &Path,
    server: &str,
    sender: mpsc::Sender<Wake>,
    events: &mpsc::Receiver<Wake>,
    stop_after: Option<Duration>,
    json: bool,
) -> Result<(), CliError> {
    // macOS reports resolved paths (`/private/var/...`); unresolved, every
    // strip below fails and the folder wakes itself through `.marfa` writes.
    let dir = &std::fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
    let mut watcher = notify::recommended_watcher(move |event| {
        let _ = sender.send(Wake::File(event));
    })
    .map_err(|error| CliError::Watch(format!("cannot watch: {error}")))?;
    // Before the first pass, so a file arriving during it is not missed.
    watcher
        .watch(dir, RecursiveMode::Recursive)
        .map_err(|error| CliError::Watch(format!("cannot watch {}: {error}", dir.display())))?;
    eprintln!("watching {} (interrupt to stop)", dir.display());

    let started = Instant::now();
    let mut gate = Gate::new(Instant::now());
    // So a standing condition is said once, not once a second.
    let mut standing: Option<Standing> = None;
    let mut last_full: Option<Instant> = None;
    let mut lists = folder.settings().and_then(|settings| settings.lists()).ok();
    let mut reach = Reach::default();
    loop {
        if let Some(limit) = stop_after
            && started.elapsed() >= limit
        {
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
            Ok(Wake::File(Err(error))) => eprintln!("watch error: {error}"),
            Ok(Wake::Server) => {}
            Ok(Wake::Reach(lost)) => reach.told(server, lost, json)?,
            Ok(Wake::Ended(error @ CoreError::Unauthorized { .. })) => {
                return Err(refused_credential(server, &error));
            }
            Ok(Wake::Ended(error)) => {
                return Err(CliError::Watch(format!(
                    "the server's changes stopped reaching this folder: {error}"
                )));
            }
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
        match step(folder, server, json, full, &mut standing, &mut reach) {
            // The follow is hydrating the copy; a later pass finds it whole.
            Err(CliError::Core(CoreError::HydrationIncomplete)) => {}
            other => other?,
        }
        gate.passed(Instant::now());
        lists = folder.settings().and_then(|settings| settings.lists()).ok();
    }
    Ok(())
}

/// Whether the server could last be reached, so a watch says so once when it
/// changes rather than at every pass.
#[derive(Debug, Default)]
struct Reach {
    unreachable: bool,
}

impl Reach {
    /// `lost` is why the server cannot be reached, or `None` where it answers.
    fn told(&mut self, server: &str, lost: Option<String>, json: bool) -> Result<(), CliError> {
        match lost {
            Some(reason) if !self.unreachable => {
                self.unreachable = true;
                output::line_of(
                    &serde_json::json!({ "server": server, "reachable": false, "reason": reason }),
                    json,
                    || {
                        format!(
                            "cannot reach the server at {server} ({reason}); edits wait here and go when it answers"
                        )
                    },
                )
            }
            None if self.unreachable => {
                self.unreachable = false;
                output::line_of(
                    &serde_json::json!({ "server": server, "reachable": true, "reason": null }),
                    json,
                    || format!("the server at {server} answers again"),
                )
            }
            _ => Ok(()),
        }
    }
}

/// The exit a one-off command gives a refused credential: nothing this watch
/// sends can land until a person replaces it.
fn refused_credential(server: &str, said: &CoreError) -> CliError {
    CliError::Core(CoreError::Unauthorized {
        code: "credential_refused".into(),
        message: format!(
            "the server at {server} refused this watch's credential ({said}), so the watch stopped; \
             queued writes wait until a working credential is kept, and the next watch or push sends them"
        ),
    })
}

#[derive(Debug, Clone, Default, PartialEq)]
struct Standing {
    root_gone: Option<String>,
    undelivered: usize,
    stopped: Option<String>,
    lost: usize,
    unreached: usize,
    directories: Vec<String>,
    secrets: Vec<String>,
    settling: Vec<String>,
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
    paused: (usize, usize),
}

fn step(
    folder: &Folder,
    server: &str,
    json: bool,
    full: bool,
    standing: &mut Option<Standing>,
    reach: &mut Reach,
) -> Result<(), CliError> {
    let settings = folder.send_settings_edit()?;
    let scanned = folder.scan_watching(full, SETTLE)?;
    // Said once, and every tick looks again, so the watch goes on where it
    // left off once the directory is back.
    if let Some(gone) = &scanned.root_gone {
        let now = Standing {
            root_gone: Some(gone.clone()),
            ..Standing::default()
        };
        if standing.as_ref() != Some(&now) {
            output::report(
                &serde_json::json!({ "settings": settings, "scan": scanned }),
                json,
                || format!("waiting: {gone}"),
            )?;
        }
        *standing = Some(now);
        return Ok(());
    }
    let drained = folder.drain()?;
    match &drained.report.unavailable {
        Some(why) => reach.told(server, Some(why.clone()), json)?,
        None if drained.report.answered > 0 => reach.told(server, None, json)?,
        None => {}
    }
    let pulled = folder.pull()?;
    let happened = scanned.created
        + scanned.updated
        + scanned.renamed
        // A paused removal's files are missing at every pass.
        + scanned.missing.saturating_sub(scanned.paused)
        + scanned.deleted
        + scanned.moved_away
        + scanned.requeued
        + drained.report.answered
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
        root_gone: None,
        undelivered: drained.report.undelivered,
        stopped: drained.report.stopped.clone(),
        paused: (scanned.paused, pulled.paused),
        lost: scanned.lost,
        unreached: scanned.unreached,
        directories: crate::folders::directory_lines(&scanned.directories),
        secrets: crate::folders::secret_lines(&scanned.secrets),
        settling: scanned
            .settling
            .iter()
            .map(|path| {
                format!("{path}: still changing, so not sent yet; it is sent once it stops")
            })
            .collect(),
        unwritten: pulled.unwritten,
        outside: pulled.outside,
        unsuited: pulled.unsuited,
        unplaced: pulled.unplaced,
        absent: pulled.absent,
        kept: pulled.kept,
        unmatched: pulled.unmatched,
        settings: settings
            .flagged
            .clone()
            .or(pulled.settings.flagged.clone())
            .or(settings.unwritten.clone())
            .or(pulled.settings.unwritten.clone()),
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
    let unplaced = standing
        .as_ref()
        .is_none_or(|before| before.unplaced != now.unplaced)
        .then(|| crate::folders::unplaced_line(pulled.unplaced))
        .flatten();
    // Once each time it changes, as the reachability line is.
    let stopped = now
        .stopped
        .clone()
        .filter(|_| {
            standing
                .as_ref()
                .is_none_or(|before| before.stopped != now.stopped)
        })
        .map(|reason| format!("the drain stopped: {reason}"));
    let said: Vec<String> = crate::folders::trashed_lines(&scanned)
        .into_iter()
        .chain(stopped)
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
        .chain(now.settling.iter().cloned())
        .chain(crate::folders::flagged_lines(&now.flagged))
        .chain(now.embeds.iter().cloned())
        .collect();
    *standing = Some(now);
    // The write the drain stopped at says why: only a refused credential
    // ends the watch, as it ends a one-off command.
    let credential = drained
        .report
        .verdicts
        .last()
        .is_some_and(|verdict| verdict.reason.as_deref() == Some("credential_refused"));
    let refused = drained
        .report
        .stopped
        .as_ref()
        .filter(|_| credential)
        .map(|stopped| {
            refused_credential(
                server,
                &CoreError::Unauthorized {
                    code: "unauthorized".into(),
                    message: stopped.clone(),
                },
            )
        });
    if !happened && !changed {
        return refused.map_or(Ok(()), Err);
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
            let held = pulled.unwritten + pulled.outside + pulled.unsuited + pulled.absent;
            let settings: String =
                crate::folders::settings_lines(&settings, Some(&pulled.settings))
                    .into_iter()
                    .map(|line| format!("{line}\n"))
                    .collect();
            format!(
                "{settings}{} created, {} updated, {} renamed, {} deleted; answered {}{}; {} file(s) written{}{}{}{}",
                scanned.created,
                scanned.updated,
                scanned.renamed,
                scanned.deleted,
                drained.report.answered,
                if drained.report.undelivered > 0 {
                    format!(", {} waiting", drained.report.undelivered)
                } else {
                    String::new()
                },
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
    )?;
    refused.map_or(Ok(()), Err)
}

fn settings_file(root: &Path, path: &Path) -> bool {
    path == root
        .join(marfa_core::folder::STATE_DIR)
        .join(marfa_core::folder::SETTINGS_FILE)
}

fn taken(lists: &marfa_core::folder::lists::Lists, root: &Path, path: &Path) -> bool {
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
