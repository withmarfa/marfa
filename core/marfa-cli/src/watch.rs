use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use marfa_core::folder::RETRY_MOST;
use marfa_core::{CoreError, Folder, WatchError, WatchEvent, WatchPass};

use crate::error::CliError;
use crate::folders;
use crate::interrupt;
use crate::output;
use crate::remote::Session;

/// How long a pass under way gets to finish once Ctrl-C has arrived. A pass
/// can wait on a server that never answers, and Ctrl-C has to end the command
/// anyway.
const INTERRUPT_GRACE: Duration = Duration::from_secs(2);

const POLL: Duration = Duration::from_millis(100);

pub fn watch(
    dir: &Path,
    session: Session,
    stop_after: Option<Duration>,
    json: bool,
) -> Result<(), CliError> {
    let server = session.server.url.clone();
    let folder = folders::opened(dir, Some(session))?;
    // Once the folder is open, so that an interrupt before then ends the
    // command as it always did.
    interrupt::stop_on_interrupt();
    let (done, ended) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = done.send(keep_in_step(&folder, &server, stop_after, json));
    });
    let result = await_end(&ended, interrupt::signaled, INTERRUPT_GRACE);
    if result.is_ok() {
        interrupt::ended_by_interrupt();
    }
    result
}

/// The watch's result once it ends, or `Ok` once `interrupted` has been true
/// for `grace` and the watch still has not ended. That watch is left to the
/// process's end: what a pass had not finished stays queued or on disk for the
/// next one.
fn await_end(
    ended: &mpsc::Receiver<Result<(), CliError>>,
    interrupted: impl Fn() -> bool,
    grace: Duration,
) -> Result<(), CliError> {
    let mut interrupted_at = None;
    loop {
        match ended.recv_timeout(POLL) {
            Ok(result) => return result,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if interrupted()
                    && interrupted_at.get_or_insert_with(Instant::now).elapsed() >= grace
                {
                    return Ok(());
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(CliError::Watch("the watch ended in a fault".into()));
            }
        }
    }
}

fn keep_in_step(
    folder: &Folder,
    server: &str,
    stop_after: Option<Duration>,
    json: bool,
) -> Result<(), CliError> {
    let stop = interrupt::stop();
    let mut conflicts = folders::Conflicts::default();
    folder
        .watch(stop, |event| {
            if let (WatchEvent::Watching { .. }, Some(limit)) = (&event, stop_after) {
                // Detached: the process ends with the watch.
                std::thread::spawn(move || {
                    std::thread::sleep(limit);
                    stop.store(true, Ordering::SeqCst);
                });
            }
            tell(server, json, folder, &mut conflicts, event)
        })
        .map_err(|error| match error {
            WatchError::CredentialRefused(error) => refused_credential(server, &error),
            WatchError::FollowEnded(error) => CliError::Watch(format!(
                "the server's changes stopped reaching this folder: {error}"
            )),
            WatchError::Unwatchable(reason) => CliError::Watch(reason),
            WatchError::Core(error) => error.into(),
            WatchError::Told(error) => error,
        })
}

fn tell(
    server: &str,
    json: bool,
    folder: &Folder,
    conflicts: &mut folders::Conflicts,
    event: WatchEvent,
) -> Result<(), CliError> {
    match event {
        WatchEvent::Watching { dir } => {
            eprintln!("watching {} (interrupt to stop)", dir.display());
            Ok(())
        }
        WatchEvent::WatcherFailed(error) => {
            eprintln!("watch error: {error}");
            Ok(())
        }
        WatchEvent::Retrying { error, wait } if marfa_core::folder::copy_changed(&error) => {
            eprintln!(
                "the copy changed under the pull as the server's changes arrived; the next pass, in {wait:?}, pulls again"
            );
            Ok(())
        }
        WatchEvent::Retrying { error, wait } => {
            eprintln!(
                "could not hydrate ({error}); trying again in {wait:?}, and after each failure \
                 a wait that doubles to {RETRY_MOST:?}, or longer where the server names one"
            );
            Ok(())
        }
        WatchEvent::Reach(Some(reason)) => output::line_of(
            &serde_json::json!({ "server": server, "reachable": false, "reason": reason }),
            json,
            || {
                format!(
                    "cannot reach the server at {server} ({reason}); edits wait here and go when it answers"
                )
            },
        ),
        WatchEvent::Reach(None) => output::line_of(
            &serde_json::json!({ "server": server, "reachable": true, "reason": null }),
            json,
            || format!("the server at {server} answers again"),
        ),
        WatchEvent::Waiting { settings, scan } => output::report(
            &serde_json::json!({ "settings": settings, "scan": scan }),
            json,
            || format!("waiting: {}", scan.root_gone.as_deref().unwrap_or_default()),
        ),
        WatchEvent::Passed(pass) => passed(json, folder, conflicts, &pass),
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

fn passed(
    json: bool,
    folder: &Folder,
    conflicts: &mut folders::Conflicts,
    pass: &WatchPass,
) -> Result<(), CliError> {
    let WatchPass {
        settings,
        scan: scanned,
        drain: drained,
        pull: pulled,
        flagged,
        embeds,
        unplaced_changed,
        stopped_changed,
        notices_changed,
    } = pass;
    let unplaced = unplaced_changed
        .then(|| folders::unplaced_line(pulled.unplaced))
        .flatten();
    let stopped = drained
        .report
        .stopped
        .clone()
        .filter(|_| *stopped_changed)
        .map(|reason| format!("the drain stopped: {reason}"));
    // What stands is said when it changes; what happened, every time.
    let standing: Vec<String> = if *notices_changed {
        folders::unsure_lines(scanned)
            .into_iter()
            .chain(folders::uncarried_line(&pulled.uncarried))
            .chain((scanned.paused > 0).then(|| folders::paused_line(scanned.paused, false)))
            .chain((pulled.paused > 0).then(|| folders::paused_line(pulled.paused, true)))
            .chain(
                scanned
                    .warnings
                    .iter()
                    .map(|file| format!("{}: {}", file.path, file.reason)),
            )
            .chain(folders::directory_lines(&scanned.directories))
            .chain(folders::secret_lines(&scanned.secrets))
            .chain(scanned.settling.iter().map(|path| {
                format!("{path}: still changing, so not sent yet; it is sent once it stops")
            }))
            .chain(folders::flagged_lines(flagged))
            .chain(folders::embed_lines(embeds))
            .collect()
    } else {
        Vec::new()
    };
    let said: Vec<String> = if json {
        Vec::new()
    } else {
        folders::trashed_lines(scanned)
            .into_iter()
            .chain(stopped)
            .chain(conflicts.say(folder, &drained.report))
            .chain(standing)
            .collect()
    };
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
            // A standing refusal of the settings file is said when it changes,
            // and an edit sent, whenever it is.
            let sent = marfa_core::SettingsFileReport {
                flagged: None,
                unwritten: None,
                ..settings.clone()
            };
            let settings: String = if *notices_changed {
                folders::settings_lines(settings, Some(&pulled.settings))
            } else {
                folders::settings_lines(&sent, None)
            }
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
                [
                    (pulled.unmatched > 0).then(|| {
                        format!(
                            ", {} whose item the search no longer matches",
                            pulled.unmatched
                        )
                    }),
                    (pulled.removed > pulled.purged).then(|| {
                        format!(
                            ", {} removed whose item was trashed or left by state",
                            pulled.removed - pulled.purged
                        )
                    }),
                    (pulled.purged > 0)
                        .then(|| format!(", {} removed whose item was purged", pulled.purged)),
                ]
                .into_iter()
                .flatten()
                .collect::<String>(),
                [
                    (drained.rebased > 0).then(|| folders::rebased_line(drained.rebased)),
                    (drained.gave_way > 0).then(|| folders::gave_way_line(drained.gave_way)),
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

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::AtomicBool;

    use super::*;

    #[test]
    fn an_interrupt_ends_a_watch_whose_pass_never_finishes_after_the_grace_and_not_before() {
        let (_never, ended) = mpsc::channel::<Result<(), CliError>>();
        let interrupted = Arc::new(AtomicBool::new(false));
        let seen = Arc::clone(&interrupted);
        let waiting = std::thread::spawn(move || {
            await_end(
                &ended,
                || seen.load(Ordering::SeqCst),
                Duration::from_millis(300),
            )
            .is_ok()
        });
        // The witness: with no interrupt it goes on waiting.
        std::thread::sleep(Duration::from_millis(700));
        assert!(!waiting.is_finished(), "ended with no interrupt");
        let raised = Instant::now();
        interrupted.store(true, Ordering::SeqCst);
        assert!(waiting.join().unwrap());
        let took = raised.elapsed();
        assert!(took >= Duration::from_millis(250), "{took:?}");
        assert!(took < Duration::from_secs(2), "{took:?}");
    }

    #[test]
    fn a_watch_that_ends_gives_its_own_result_and_a_fault_is_a_watch_error() {
        let (done, ended) = mpsc::channel();
        done.send(Err(CliError::Watch("stopped".into()))).unwrap();
        let result = await_end(&ended, || true, Duration::from_secs(60));
        assert!(matches!(result, Err(CliError::Watch(ref reason)) if reason == "stopped"));
        let (done, ended) = mpsc::channel::<Result<(), CliError>>();
        drop(done);
        let result = await_end(&ended, || false, Duration::from_secs(60));
        assert!(matches!(result, Err(CliError::Watch(_))));
    }
}
