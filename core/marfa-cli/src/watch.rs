use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use marfa_core::folder::RETRY_MOST;
use marfa_core::{CoreError, Folder, WatchError, WatchEvent, WatchPass};

use crate::error::CliError;
use crate::folders;
use crate::output;
use crate::remote::Session;

pub fn watch(
    dir: &Path,
    session: Session,
    stop_after: Option<Duration>,
    json: bool,
) -> Result<(), CliError> {
    let server = session.server.url.clone();
    let folder = folders::opened(dir, Some(session))?;
    let stop = Arc::new(AtomicBool::new(false));
    let mut conflicts = folders::Conflicts::default();
    folder
        .watch(&stop, |event| {
            if let (WatchEvent::Watching { .. }, Some(limit)) = (&event, stop_after) {
                let stop = Arc::clone(&stop);
                // Detached: the process ends with the watch.
                std::thread::spawn(move || {
                    std::thread::sleep(limit);
                    stop.store(true, Ordering::SeqCst);
                });
            }
            tell(&server, json, &folder, &mut conflicts, event)
        })
        .map_err(|error| match error {
            WatchError::CredentialRefused(error) => refused_credential(&server, &error),
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
                if pulled.unmatched > 0 {
                    format!(
                        ", {} whose item the search no longer matches",
                        pulled.unmatched
                    )
                } else {
                    String::new()
                },
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
