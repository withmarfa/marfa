use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex, MutexGuard, mpsc};
use std::time::{Duration, Instant};

use marfa_core::folder::{
    Every, EveryFolder, RETRY_MOST, Registry, TakeBack, Unwatched, WatchRecord,
};
use marfa_core::{CoreError, Folder, Server, WatchEnd, WatchError, WatchEvent, WatchPass};
use serde_json::Value;

use crate::error::CliError;
use crate::folders;
use crate::interrupt;
use crate::output;
use crate::remote::Named;
use crate::storage;

/// How long a pass under way gets to finish once Ctrl-C or `SIGTERM` has
/// arrived. A pass can wait on a server that never answers, and the stop has
/// to end the command anyway.
const INTERRUPT_GRACE: Duration = Duration::from_secs(2);

const POLL: Duration = Duration::from_millis(100);

pub fn watch(
    dir: &Path,
    named: &Named,
    stop_after: Option<Duration>,
    json: bool,
) -> Result<(), CliError> {
    let (server, renew) = folders::kept_session(named.session()?);
    let folder = folders::reopened(dir, &server, renew.as_ref())?;
    // Once the folder is open, so that an interrupt before then ends the
    // command as it always did.
    interrupt::stop_on_interrupt();
    let record = WatchRecord::located().map(Arc::new);
    if let Some(record) = &record {
        let record = Arc::clone(record);
        std::thread::spawn(move || {
            record.keep(|reason| record_unwritten(json, record.path(), reason));
        });
    }
    let (done, ended) = mpsc::channel();
    let kept = record.clone();
    std::thread::spawn(move || {
        let _ = done.send(keep_in_step(
            folder,
            &server,
            renew.as_ref(),
            stop_after,
            json,
            kept.as_deref(),
        ));
    });
    let result = await_end(&ended, interrupt::asked_to_stop, INTERRUPT_GRACE);
    if let Some(record) = &record {
        record.finish();
    }
    if result.is_ok() {
        interrupt::ended_by_interrupt();
    }
    result
}

/// Watches every folder the machine's registry lists, until Ctrl-C,
/// `SIGTERM` or `stop_after` seconds.
pub fn watch_every(named: &Named, stop_after: Option<u64>, json: bool) -> Result<(), CliError> {
    let registry = Registry::located().ok_or_else(|| {
        CliError::Watch(
            "there is no folder registry to read: HOME is not set, and MARFA_FOLDER_REGISTRY names none".into(),
        )
    })?;
    interrupt::stop_on_interrupt();
    let stop = interrupt::stop_after(stop_after);
    eprintln!(
        "watching every folder {} lists (interrupt to stop)",
        registry.path().display()
    );
    let machine = Machine {
        named: named.clone(),
        json,
        registry: registry.path().to_path_buf(),
        folders: Mutex::default(),
    };
    let record = Arc::new(WatchRecord::beside(&registry));
    let (done, ended) = mpsc::channel();
    let kept = Arc::clone(&record);
    std::thread::spawn(move || {
        let _ = done.send(marfa_core::folder::watch_every(
            &registry, stop, &machine, &kept,
        ));
    });
    let result = await_end(&ended, interrupt::asked_to_stop, INTERRUPT_GRACE);
    // A watch left behind at the end of the grace is not stopped, so its
    // folders are marked not watched here.
    record.finish();
    if result.is_ok() {
        interrupt::ended_by_interrupt();
    }
    result
}

/// What a watch over every folder keeps of each folder it opened.
struct Opened {
    server: String,
    /// The credential it was opened with, and the refusal it met, so a folder
    /// whose credential was refused is opened again only with another.
    bearer: String,
    refused: Option<Unwatched>,
    conflicts: folders::Conflicts,
}

struct Machine {
    named: Named,
    json: bool,
    registry: PathBuf,
    folders: Mutex<HashMap<PathBuf, Opened>>,
}

impl Machine {
    fn folders(&self) -> MutexGuard<'_, HashMap<PathBuf, Opened>> {
        self.folders
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// The refusal a folder's credential met, where `bearer` is the credential
    /// it met it with: opening it again would only be refused again.
    fn still_refused(&self, dir: &Path, bearer: &str) -> Option<Unwatched> {
        self.folders()
            .get(dir)
            .filter(|opened| opened.bearer == bearer)
            .and_then(|opened| opened.refused.clone())
    }

    fn opened_with(&self, dir: &Path, server: String, bearer: String) {
        self.folders().insert(
            dir.to_path_buf(),
            Opened {
                server,
                bearer,
                refused: None,
                conflicts: folders::Conflicts::default(),
            },
        );
    }

    fn line(&self, value: &Value, human: impl FnOnce() -> String) -> Result<(), CliError> {
        output::line_of(value, self.json, human)
    }
}

fn unwatched(error: &CliError) -> Unwatched {
    let message = match error {
        // Its own words tell a one-off command to stop the other process.
        CliError::FolderHeld(_) => {
            "another process is working this folder, such as a `folders watch` of it alone; it joins this watch once that process lets it go".into()
        }
        other => other.to_string(),
    };
    Unwatched {
        code: error.code().to_string(),
        message,
    }
}

impl EveryFolder for Machine {
    type Error = CliError;

    fn open(&self, dir: &Path, origin: Option<&str>) -> Result<Folder, Unwatched> {
        let session = self
            .named
            .session_for(origin)
            .map_err(|error| unwatched(&error))?;
        let (server, bearer) = (session.server.url.clone(), session.server.key.clone());
        if let Some(refused) = self.still_refused(dir, &bearer) {
            return Err(refused);
        }
        let folder = folders::opened(dir, Some(session)).map_err(|error| unwatched(&error))?;
        self.opened_with(dir, server, bearer);
        Ok(folder)
    }

    fn ended(&self, dir: &Path, reason: &Unwatched) {
        if reason.code == "unauthorized"
            && let Some(opened) = self.folders().get_mut(dir)
        {
            opened.refused = Some(reason.clone());
        }
    }

    fn tell(&self, event: Every<'_>) -> Result<(), CliError> {
        let json = self.json;
        match event {
            Every::Watching { dir } => {
                say(json, dir).line(serde_json::json!({ "watching": true }), || "watching".into())
            }
            Every::Storage { dir, cause } => {
                storage::warn_of(dir, cause);
                Ok(())
            }
            Every::Folder { dir, folder, event } => {
                let mut folders = self.folders();
                let opened = folders
                    .get_mut(dir)
                    .expect("a folder's events come after it is opened");
                tell(&opened.server, say(json, dir), folder, &mut opened.conflicts, event)
            }
            Every::Unwatched { dir, reason } => {
                say(json, dir).line(
                    serde_json::json!({
                        "watching": false,
                        "code": reason.code,
                        "reason": reason.message,
                    }),
                    || {
                        format!(
                            "not watched: {}; trying again",
                            reason.message
                        )
                    },
                )
            }
            Every::HandedOver { dir } => say(json, dir).line(handed_over(), || {
                HANDED_OVER_LINE.into()
            }),
            Every::TakenBack { dir } => say(json, dir).line(taken_back(), || TAKEN_BACK_LINE.into()),
            Every::Missing { dirs } => self.line(
                &serde_json::json!({ "missing": dirs, "watching": false }),
                || {
                    format!(
                        "{} listed folder(s) cannot be found, so they are not watched; each is watched once its directory is back, and `marfa folders remove DIR` takes one off the list: {}",
                        dirs.len(),
                        dirs.iter()
                            .map(|dir| dir.display().to_string())
                            .collect::<Vec<_>>()
                            .join(", ")
                    )
                },
            ),
            Every::Left { dir } => {
                self.folders().remove(dir);
                say(json, dir).line(
                    serde_json::json!({ "watching": false, "listed": false }),
                    || "no longer listed, so no longer watched".into(),
                )
            }
            Every::NoFolders => self.line(
                &serde_json::json!({ "registry": self.registry, "folders": 0 }),
                || {
                    format!(
                        "{} lists no folders; the watch waits for `folders add` to list one",
                        self.registry.display()
                    )
                },
            ),
            Every::Registry(Some(reason)) => self.line(
                &serde_json::json!({ "registry": self.registry, "readable": false, "reason": reason }),
                || format!("{reason}; the folders already watched keep syncing"),
            ),
            Every::Record { path, reason } => {
                record_unwritten(json, path, reason);
                Ok(())
            }
            Every::Registry(None) => self.line(
                &serde_json::json!({ "registry": self.registry, "readable": true, "reason": null }),
                || format!("the folder registry {} can be read again", self.registry.display()),
            ),
        }
    }
}

/// Said once: the watch goes on without the record other programs read.
fn record_unwritten(json: bool, path: &Path, reason: &str) {
    if json {
        let _ = output::line_of(
            &serde_json::json!({ "record": path, "written": false, "reason": reason }),
            true,
            String::new,
        );
    } else {
        eprintln!("{reason}; the watch goes on without it");
    }
}

const HANDED_OVER_LINE: &str =
    "let go to a command that asked for it; taken back once that command ends";

const TAKEN_BACK_LINE: &str = "taken back from the command it was let go to, and watched again";

fn handed_over() -> Value {
    serde_json::json!({
        "watching": false,
        "code": marfa_core::folder::HANDED_OVER,
        "reason": HANDED_OVER_LINE,
    })
}

fn taken_back() -> Value {
    serde_json::json!({ "watching": true, "taken_back": true })
}

/// How a watch says what happens: a watch of one folder as it always has, and
/// a watch over every folder in one line each, naming its folder.
#[derive(Clone, Copy)]
struct Say<'a> {
    json: bool,
    dir: Option<&'a Path>,
}

impl Say<'_> {
    fn report(&self, value: Value, human: impl FnOnce() -> String) -> Result<(), CliError> {
        match self.dir {
            None => output::report(&value, self.json, human),
            Some(_) => self.line(value, human),
        }
    }

    fn line(&self, value: Value, human: impl FnOnce() -> String) -> Result<(), CliError> {
        match self.dir {
            None => output::line_of(&value, self.json, human),
            Some(dir) => {
                output::line_of(&naming(value, dir), self.json, || prefixed(dir, &human()))
            }
        }
    }

    /// A line for a person on stderr, in either mode.
    fn note(&self, text: &str) {
        match self.dir {
            None => eprintln!("{text}"),
            Some(dir) => eprintln!("{}", prefixed(dir, text)),
        }
    }
}

fn say(json: bool, dir: &Path) -> Say<'_> {
    Say {
        json,
        dir: Some(dir),
    }
}

fn naming(mut value: Value, dir: &Path) -> Value {
    if let Value::Object(map) = &mut value {
        map.insert("dir".into(), serde_json::json!(dir));
    }
    value
}

fn prefixed(dir: &Path, text: &str) -> String {
    text.lines()
        .map(|line| format!("{}: {line}", dir.display()))
        .collect::<Vec<_>>()
        .join("\n")
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
                return Err(CliError::Core(CoreError::Fault(
                    "the watch ended in a fault".into(),
                )));
            }
        }
    }
}

/// Watches `folder` until the stop, letting it go to a command that asks
/// for it and taking it back once that command ends.
fn keep_in_step(
    mut folder: Folder,
    server: &Server,
    renew: Option<&folders::Renewal>,
    stop_after: Option<Duration>,
    json: bool,
    record: Option<&WatchRecord>,
) -> Result<(), CliError> {
    let stop = interrupt::stop();
    let say = Say { json, dir: None };
    let url = server.url.as_str();
    let mut conflicts = folders::Conflicts::default();
    let mut timed = false;
    // Whether the last thing said of the folder is that it was let go.
    let mut let_go = false;
    // What to say once the folder is watched again.
    let mut back: Option<Back> = None;
    loop {
        let end = {
            let tell_event = |event: WatchEvent| {
                if let WatchEvent::Watching { .. } = &event {
                    if let (false, Some(limit)) = (timed, stop_after) {
                        timed = true;
                        // Detached: the process ends with the watch.
                        std::thread::spawn(move || {
                            std::thread::sleep(limit);
                            stop.store(true, Ordering::SeqCst);
                        });
                    }
                    if let Some(back) = back.take() {
                        let_go = false;
                        return match back {
                            Back::TakenBack => say.line(taken_back(), || TAKEN_BACK_LINE.into()),
                            Back::Watching => say
                                .line(serde_json::json!({ "watching": true }), || {
                                    "watched again".into()
                                }),
                        };
                    }
                }
                tell(url, say, &folder, &mut conflicts, event)
            };
            match record {
                Some(record) => record.watch_folder(&folder, stop, tell_event),
                None => folder.watch_handing_over(stop, tell_event),
            }
        }
        .map_err(|error| ended(url, error))?;
        if end == WatchEnd::Stopped {
            return Ok(());
        }
        // The path it was opened by, which reaches it however it was named.
        let root = folder.root().to_path_buf();
        let listed = Folder::listed_at(&root);
        drop(folder);
        if !let_go {
            let_go = true;
            say.line(handed_over(), || HANDED_OVER_LINE.into())?;
        }
        let taken = Folder::take_back(
            &root,
            listed,
            stop,
            || folders::reopening(&root, server, renew),
            || held_elsewhere(say, record, &root),
        )
        .map_err(|error| ended(url, error))?;
        folder = match taken {
            TakeBack::Folder { folder, held } => {
                back = Some(if held {
                    Back::Watching
                } else {
                    Back::TakenBack
                });
                *folder
            }
            TakeBack::Stopped => return Ok(()),
            TakeBack::Removed => {
                return say.line(
                    serde_json::json!({ "watching": false, "listed": false }),
                    || "no longer a folder, so no longer watched".into(),
                );
            }
            TakeBack::Unlisted => {
                return say.line(
                    serde_json::json!({ "watching": false, "listed": false }),
                    || "no longer listed, so no longer watched".into(),
                );
            }
        };
    }
}

enum Back {
    TakenBack,
    Watching,
}

const HELD_LINE: &str = "held by another process, not the command it was let go to; watched again once that process lets it go";

/// A folder held with no command asking for it for longer than a command
/// waits is another process's, and is said to be, once.
fn held_elsewhere(say: Say<'_>, record: Option<&WatchRecord>, root: &Path) -> Result<(), CliError> {
    if let Some(record) = record {
        record.unwatched(root, Some(CoreError::ReadingHandle.code()));
    }
    say.line(
        serde_json::json!({
            "watching": false,
            "code": CoreError::ReadingHandle.code(),
            "reason": HELD_LINE,
        }),
        || HELD_LINE.into(),
    )
}

fn ended(server: &str, error: WatchError<CliError>) -> CliError {
    match error {
        WatchError::CredentialRefused(error) => refused_credential(server, &error),
        WatchError::FollowEnded(error) => CliError::Watch(format!(
            "the server's changes stopped reaching this folder: {error}"
        )),
        WatchError::Unwatchable(reason) => CliError::Watch(reason),
        WatchError::Core(error) => error.into(),
        WatchError::Told(error) => error,
    }
}

fn tell(
    server: &str,
    say: Say<'_>,
    folder: &Folder,
    conflicts: &mut folders::Conflicts,
    event: WatchEvent,
) -> Result<(), CliError> {
    match event {
        WatchEvent::Watching { dir, storage } => {
            if let Some(cause) = &storage {
                storage::warn_of(&dir, cause);
            }
            say.note(&format!("watching {} (interrupt to stop)", dir.display()));
            Ok(())
        }
        WatchEvent::Busy { passes } => {
            say.note(&format!(
                "busy: {passes} passes started in the last minute; a folder at rest starts almost none"
            ));
            Ok(())
        }
        WatchEvent::Missed { path } => {
            say.note(&format!(
                "warning: the hourly check rewrote {path}, which a change had reached and the watch had left as it was"
            ));
            Ok(())
        }
        WatchEvent::WatcherFailed(error) => {
            say.note(&format!("watch error: {error}"));
            Ok(())
        }
        WatchEvent::Retrying { error, wait } if marfa_core::folder::copy_changed(&error) => {
            say.note(&format!(
                "the copy changed under the pull as the server's changes arrived; the next pass, in {wait:?}, pulls again"
            ));
            Ok(())
        }
        WatchEvent::Retrying { error, wait } => {
            say.note(&format!(
                "could not hydrate ({error}); trying again in {wait:?}, and after each failure \
                 a wait that doubles to {RETRY_MOST:?}, or longer where the server names one"
            ));
            Ok(())
        }
        WatchEvent::Reach(Some(reason)) => say.line(
            serde_json::json!({ "server": server, "reachable": false, "reason": reason }),
            || {
                format!(
                    "cannot reach the server at {server} ({reason}); edits wait here and go when it answers"
                )
            },
        ),
        WatchEvent::Reach(None) => say.line(
            serde_json::json!({ "server": server, "reachable": true, "reason": null }),
            || format!("the server at {server} answers again"),
        ),
        WatchEvent::Waiting { settings, scan } => say.report(
            serde_json::json!({ "settings": settings, "scan": scan }),
            || format!("waiting: {}", scan.root_gone.as_deref().unwrap_or_default()),
        ),
        WatchEvent::Passed(pass) => passed(say, folder, conflicts, &pass),
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

/// What the pass's drain came to, in the words `counts` uses for the same
/// numbers, with the writes it left undelivered for the next pass.
fn drain_clause(report: &marfa_core::DrainReport) -> String {
    let mut clause = crate::output::answered_and_held(report);
    if report.undelivered > 0 {
        clause.push_str(&format!(
            ", {} not delivered, waiting for the next pass",
            report.undelivered
        ));
    }
    clause
}

fn passed(
    say: Say<'_>,
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
    let said: Vec<String> = if say.json {
        Vec::new()
    } else {
        folders::trashed_lines(scanned)
            .into_iter()
            .chain(stopped)
            .chain(conflicts.say(folder, &drained.report))
            .chain(standing)
            .collect()
    };
    say.report(
        serde_json::json!({
            "settings": settings,
            "scan": scanned,
            "drain": drained,
            "pull": pulled,
        }),
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
                "{settings}{} created, {} updated, {} renamed, {} deleted; {}; {} file(s) written{}{}{}{}",
                scanned.created,
                scanned.updated,
                scanned.renamed,
                scanned.deleted,
                drain_clause(&drained.report),
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
                        ", {} whose item the query no longer matches",
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
    use crate::output::tests::{pass, verdict};
    use marfa_core::{Verdict, WriteKind};

    #[test]
    fn a_watch_line_says_the_drain_in_the_words_a_push_does() {
        let mut report = pass(
            3,
            12,
            vec![
                verdict(WriteKind::CreateItem, Some(Verdict::Accepted)),
                verdict(WriteKind::CreateItem, Some(Verdict::Accepted)),
            ],
        );
        report.undelivered = 2;
        assert_eq!(
            drain_clause(&report),
            "the server answered 3 write(s), creating 2 item(s); 12 more held back until the write each follows is answered, 2 not delivered, waiting for the next pass"
        );
        assert!(
            drain_clause(&report).starts_with(&crate::output::counts(&report)),
            "the watch and the push say the same drain differently"
        );
        assert_eq!(
            drain_clause(&pass(0, 0, Vec::new())),
            "the server answered 0 write(s)"
        );
    }

    #[test]
    fn a_refused_credential_is_not_sent_again_and_one_kept_since_is_tried_once() {
        let machine = Machine {
            named: Named::default(),
            json: false,
            registry: PathBuf::from("folders.json"),
            folders: Mutex::default(),
        };
        let dir = Path::new("/notes");
        let refused = Unwatched {
            code: "unauthorized".into(),
            message: "the server refused this folder's credential".into(),
        };
        machine.opened_with(dir, "https://one.test".into(), "first".into());
        machine.ended(dir, &refused);
        assert_eq!(machine.still_refused(dir, "first"), Some(refused.clone()));
        // The witness: another credential is tried.
        assert_eq!(machine.still_refused(dir, "second"), None);
        // Refused the same way, so nothing is said of it: kept all the same.
        machine.opened_with(dir, "https://one.test".into(), "second".into());
        machine.ended(dir, &refused);
        assert_eq!(
            machine.still_refused(dir, "second"),
            Some(refused.clone()),
            "a second refused credential would be sent again at every try"
        );
        // A watch that ends otherwise does not hold its credential back.
        let ended = Unwatched {
            code: "not_found".into(),
            message: "the server's changes stopped reaching this folder".into(),
        };
        machine.opened_with(dir, "https://one.test".into(), "third".into());
        machine.ended(dir, &ended);
        assert_eq!(machine.still_refused(dir, "third"), None);
    }

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
    fn a_watch_that_ends_gives_its_own_result_and_a_thread_that_died_is_a_fault() {
        let (done, ended) = mpsc::channel();
        done.send(Err(CliError::Watch("stopped".into()))).unwrap();
        let result = await_end(&ended, || true, Duration::from_secs(60));
        assert!(matches!(result, Err(CliError::Watch(ref reason)) if reason == "stopped"));
        let (done, ended) = mpsc::channel::<Result<(), CliError>>();
        drop(done);
        let result = await_end(&ended, || false, Duration::from_secs(60));
        assert!(matches!(result, Err(CliError::Core(CoreError::Fault(_)))));
    }
}
