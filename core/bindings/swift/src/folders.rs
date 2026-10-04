//! Folders on this machine: directories whose files are kept in step with a
//! `system.folder`'s search, through the core the `marfa` binary uses, and
//! listed in the one registry the machine keeps.

use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use marfa_core::folder::registry;

use crate::{DrainReport, HydrateReport, MarfaError, Subscription, drained};

/// A folder as the machine's registry lists it.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ListedFolder {
    /// The directory, resolved as far as it exists.
    pub dir: String,
    /// The id of the `system.folder` whose settings it follows.
    pub folder: String,
}

/// Where one file stands, from the folder's own store.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum FileState {
    /// The file and its item agree.
    InStep,
    /// A write for it waits to be sent; `waits` names each kind.
    Waiting,
    /// It is not sent; `reason` says why.
    Held,
    /// Its item no longer matches the folder's search.
    Unmatched,
    /// The scan did not reach it, so it is held rather than deleted.
    Unreached,
    /// It lies where the folder does not take files.
    Outside,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct FileStatus {
    pub path: String,
    pub item_id: Option<String>,
    pub state: FileState,
    pub waits: Vec<String>,
    pub flag: Option<String>,
    pub reason: Option<String>,
    pub warning: Option<String>,
}

/// A large removal waiting for `confirm` or `restore`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Record)]
pub struct PausedRemoval {
    /// Files gone from the disk whose deletes are not sent.
    pub disk: u64,
    /// Files left in place whose items left the search elsewhere.
    pub pull: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct FolderStatus {
    pub files: Vec<FileStatus>,
    pub paused: PausedRemoval,
}

/// A file a pass held or warned about, with why.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct FlaggedFile {
    pub path: String,
    pub flag: String,
    pub reason: String,
}

/// What became of the folder's settings file in a pass.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct SettingsFileReport {
    /// Its edit went to the server.
    pub sent: bool,
    /// It was written from the settings in force.
    pub written: bool,
    /// Why its edit is not in force, where it is not.
    pub flagged: Option<String>,
    /// Why it could not be written; the next pass writes it.
    pub unwritten: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ScanReport {
    pub created: u64,
    pub updated: u64,
    pub renamed: u64,
    pub unchanged: u64,
    pub missing: u64,
    pub deleted: u64,
    pub skipped: u64,
    /// Files moved to another folder on this machine, so nothing was trashed.
    pub moved_away: u64,
    /// Deletes a large removal holds back.
    pub paused: u64,
    /// Files found in no folder on this machine, whose items were trashed.
    pub trashed: Vec<String>,
    /// Files not taken because their names are ones secrets go by.
    pub secrets: Vec<String>,
    pub warnings: Vec<FlaggedFile>,
    /// Why the scan read nothing, where the folder's directory is gone.
    pub root_gone: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct PullReport {
    pub written: u64,
    pub rewritten: u64,
    pub moved: u64,
    pub unchanged: u64,
    pub skipped: u64,
    /// Files of items trashed or gone from the search's states, removed.
    pub removed: u64,
    /// Files of items gone from the search, kept with the person's changes.
    pub kept: u64,
    /// Files the folder did not write, and would not write over.
    pub unwritten: u64,
    /// Items whose bytes could not be fetched.
    pub absent: u64,
    /// Placements the server refused.
    pub unplaced: u64,
    /// Files left in place whose items the search no longer matches.
    pub unmatched: u64,
    /// Files a large removal holds back.
    pub paused: u64,
    /// Why the pull wrote nothing, where the folder's directory is gone.
    pub root_gone: Option<String>,
}

/// One pass: the settings file's edit, the scan, the drain and the pull.
#[derive(Debug, Clone, uniffi::Record)]
pub struct FolderPass {
    pub settings: SettingsFileReport,
    pub scan: ScanReport,
    pub drain: DrainReport,
    /// Edits written from a version the server no longer holds, sent again.
    pub rebased: u64,
    /// Placements another machine made first, followed instead.
    pub gave_way: u64,
    /// `None` where the catch-up failed after the copy expired, leaving
    /// nothing to pull from.
    pub pull: Option<PullReport>,
    /// The files the scan and the pull held, each once.
    pub flagged: Vec<FlaggedFile>,
}

/// What a sync did.
#[derive(Debug, Clone, uniffi::Record)]
pub struct FolderSync {
    /// The hydration a copy that did not answer for its slice took first.
    pub hydrated: Option<HydrateReport>,
    /// Why the server's changes could not be caught up, where they could not;
    /// the sync still wrote out the copy it holds.
    pub catch_up_error: Option<MarfaError>,
    pub pass: FolderPass,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct UnsureFile {
    pub path: String,
    pub reason: String,
}

/// What letting a paused removal go did.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ConfirmedRemoval {
    /// Deletes queued, sent at the next sync.
    pub deleted: u64,
    /// Files found in another folder on this machine, whose items stay.
    pub moved: u64,
    /// Files taken away whose items left elsewhere.
    pub removed: u64,
    /// Files not let go, because the other folders could not all be read.
    pub unsure: Vec<UnsureFile>,
}

/// What cancelling a paused removal did.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct RestoredRemoval {
    /// Files gone from the disk, written back.
    pub put_back: u64,
    /// Items that left elsewhere, restored at the next sync.
    pub restored: u64,
    pub pull: PullReport,
}

/// What a watch tells its listener, each when it happens.
// UniFFI carries a variant's fields by value, with no box to hold a pass in.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, uniffi::Enum)]
pub enum FolderEvent {
    /// The directory is watched, and passes begin.
    Watching { dir: String },
    /// The filesystem reported an error; the watch goes on.
    WatcherFailed { message: String },
    /// A hydration failed, and is tried again after `wait_ms`. Told once for
    /// each run of failures.
    Retrying { error: MarfaError, wait_ms: u64 },
    /// The server cannot be reached; writes wait. Told when it changes.
    Unreachable { reason: String },
    /// The server answers again. Told when it changes.
    Reachable,
    /// The folder's directory is gone, and the watch waits for it. Told once
    /// for as long as it stays gone.
    Waiting { reason: String },
    /// A pass that did something, or whose standing conditions changed.
    Passed { pass: FolderPass },
}

/// What an app hands `watch`: told of each event on a thread of the core's,
/// and once when the watch ends, with the error that ended it or none where
/// it was stopped.
#[uniffi::export(with_foreign)]
pub trait FolderListener: Send + Sync {
    fn told(&self, event: FolderEvent);
    fn ended(&self, error: Option<MarfaError>);
}

/// The folders on this machine, worked with one server's credential. Every
/// method blocks; call from off the main thread.
#[derive(uniffi::Object)]
pub struct Folders {
    server: Option<marfa_core::Server>,
}

#[uniffi::export]
impl Folders {
    /// `url` and `key` go together; without them only `list`, `status`,
    /// `confirm`, `restore` and `remove` work.
    #[uniffi::constructor]
    pub fn new(url: Option<String>, key: Option<String>) -> Result<Arc<Self>, MarfaError> {
        let server = match (url, key) {
            (Some(url), Some(key)) => Some(marfa_core::Server { url, key }),
            (None, None) => None,
            _ => {
                return Err(MarfaError::Invalid {
                    message: "url and key go together".into(),
                });
            }
        };
        Ok(Arc::new(Folders { server }))
    }

    /// Makes `dir` a folder that follows the `system.folder` `folder`, and
    /// lists it in the machine's registry. The directory is made if it is
    /// not there. Its files are written at the first sync.
    pub fn add(&self, dir: String, folder: String) -> Result<ListedFolder, MarfaError> {
        let added = marfa_core::Folder::add(&dir, &folder, self.server.clone())?;
        Ok(ListedFolder {
            dir: registry::resolved(added.root()).display().to_string(),
            folder: added.folder_id().to_string(),
        })
    }

    /// The folders the machine's registry lists, the command line's among
    /// them.
    pub fn list(&self) -> Result<Vec<ListedFolder>, MarfaError> {
        let Some(registry) = marfa_core::folder::Registry::located() else {
            return Ok(Vec::new());
        };
        Ok(registry
            .folders()?
            .into_iter()
            .map(|entry| ListedFolder {
                dir: entry.dir.display().to_string(),
                folder: entry.folder,
            })
            .collect())
    }

    /// Where every file stands, read from the folder's store without asking
    /// the server, and beside a watch that holds the folder.
    pub fn status(&self, dir: String) -> Result<FolderStatus, MarfaError> {
        let report = marfa_core::Folder::status_of(&dir)?;
        Ok(FolderStatus {
            files: report
                .files
                .into_iter()
                .map(|file| {
                    Ok(FileStatus {
                        state: state_of(file.status)?,
                        path: file.path,
                        item_id: file.item_id,
                        waits: file.waits.iter().map(|wait| wait.to_string()).collect(),
                        flag: file.flag.map(str::to_string),
                        reason: file.reason,
                        warning: file.warning,
                    })
                })
                .collect::<Result<_, MarfaError>>()?,
            paused: PausedRemoval {
                disk: report.paused.disk as u64,
                pull: report.paused.pull as u64,
            },
        })
    }

    /// Everything a folder does, once: sends what changed on disk, catches
    /// up with the server and writes out what its search matches.
    pub fn sync(&self, dir: String) -> Result<FolderSync, MarfaError> {
        let synced = marfa_core::Folder::open(&dir, self.server.clone())?.sync()?;
        Ok(FolderSync {
            hydrated: synced.hydrated.map(Into::into),
            catch_up_error: synced.catch_up.err().map(Into::into),
            pass: pass_of(
                synced.settings,
                synced.scan,
                synced.drain,
                synced.pull,
                None,
            )?,
        })
    }

    /// Lets a paused large removal go: its deletes are queued, and files
    /// whose items left elsewhere are taken away.
    pub fn confirm(&self, dir: String) -> Result<ConfirmedRemoval, MarfaError> {
        let confirmed = marfa_core::Folder::open(&dir, None)?.confirm()?;
        Ok(ConfirmedRemoval {
            deleted: confirmed.deleted as u64,
            moved: confirmed.moved as u64,
            removed: confirmed.removed as u64,
            unsure: confirmed
                .unsure
                .into_iter()
                .map(|file| UnsureFile {
                    path: file.path,
                    reason: file.reason,
                })
                .collect(),
        })
    }

    /// Cancels a paused large removal: files gone from the disk are written
    /// back, and items that left elsewhere are restored.
    pub fn restore(&self, dir: String) -> Result<RestoredRemoval, MarfaError> {
        let restored = marfa_core::Folder::open(&dir, self.server.clone())?.restore()?;
        Ok(RestoredRemoval {
            put_back: restored.put_back as u64,
            restored: restored.restored as u64,
            pull: pull_of(restored.pull),
        })
    }

    /// Takes the folder off this machine: its state under `.marfa` goes and
    /// its files stay. Refused while writes wait. A folder whose directory is
    /// gone is only taken off the registry.
    pub fn remove(&self, dir: String) -> Result<(), MarfaError> {
        Ok(marfa_core::Folder::remove_at(&dir)?)
    }

    /// Keeps the folder in step on a thread of its own, as the command
    /// line's watch does, until the subscription is stopped or let go. The
    /// folder is held while it runs, so another process cannot work it. A
    /// pass under way when it is stopped finishes before `ended` is called.
    pub fn watch(
        &self,
        dir: String,
        listener: Arc<dyn FolderListener>,
    ) -> Result<Arc<Subscription>, MarfaError> {
        let folder = marfa_core::Folder::open(&dir, self.server.clone())?;
        let origin = self.server.as_ref().map(|server| server.url.clone());
        let stop = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&stop);
        std::thread::spawn(move || {
            let watched = folder.watch(&flag, |event| {
                listener.told(event_of(event)?);
                Ok::<(), MarfaError>(())
            });
            // Let go of the folder before saying so: a listener that works it
            // again on being told must find it free.
            drop(folder);
            listener.ended(watched.err().map(|error| ended(error, origin.as_deref())));
        });
        Ok(Arc::new(Subscription { stop }))
    }
}

fn ended(error: marfa_core::WatchError<MarfaError>, origin: Option<&str>) -> MarfaError {
    use marfa_core::WatchError as W;
    match error {
        W::CredentialRefused(said) => MarfaError::Unauthorized {
            code: "credential_refused".into(),
            message: format!(
                "the server at {} refused this watch's credential ({said}), so the watch stopped; queued writes wait until a working credential is kept",
                origin.unwrap_or("this folder's server")
            ),
        },
        W::FollowEnded(error) | W::Core(error) => error.into(),
        W::Unwatchable(message) => MarfaError::Io { message },
        W::Told(error) => error,
    }
}

fn event_of(event: marfa_core::WatchEvent) -> Result<FolderEvent, MarfaError> {
    use marfa_core::WatchEvent as W;
    Ok(match event {
        W::Watching { dir } => FolderEvent::Watching {
            dir: dir.display().to_string(),
        },
        W::WatcherFailed(message) => FolderEvent::WatcherFailed { message },
        W::Retrying { error, wait } => FolderEvent::Retrying {
            error: error.into(),
            wait_ms: u64::try_from(wait.as_millis()).unwrap_or(u64::MAX),
        },
        W::Reach(Some(reason)) => FolderEvent::Unreachable { reason },
        W::Reach(None) => FolderEvent::Reachable,
        W::Waiting { scan, .. } => FolderEvent::Waiting {
            reason: scan.root_gone.unwrap_or_default(),
        },
        W::Passed(pass) => {
            let pass = *pass;
            FolderEvent::Passed {
                pass: pass_of(
                    pass.settings,
                    pass.scan,
                    pass.drain,
                    Some(pass.pull),
                    Some(pass.flagged),
                )?,
            }
        }
    })
}

/// `flagged`, where the watch has merged it already; otherwise the scan's and
/// the pull's, each file once.
fn pass_of(
    settings: marfa_core::SettingsFileReport,
    scan: marfa_core::ScanReport,
    drain: marfa_core::Drained,
    pull: Option<marfa_core::PullReport>,
    flagged: Option<Vec<marfa_core::folder::Flagged>>,
) -> Result<FolderPass, MarfaError> {
    let flagged = flagged.unwrap_or_else(|| {
        let mut flagged = scan.flagged.clone();
        for file in pull.iter().flat_map(|pull| &pull.flagged) {
            if !flagged.iter().any(|seen| seen.path == file.path) {
                flagged.push(file.clone());
            }
        }
        flagged
    });
    Ok(FolderPass {
        settings: SettingsFileReport {
            sent: settings.sent,
            written: settings.written,
            flagged: settings.flagged,
            unwritten: settings.unwritten,
        },
        scan: ScanReport {
            created: scan.created as u64,
            updated: scan.updated as u64,
            renamed: scan.renamed as u64,
            unchanged: scan.unchanged as u64,
            missing: scan.missing as u64,
            deleted: scan.deleted as u64,
            skipped: scan.skipped as u64,
            moved_away: scan.moved_away as u64,
            paused: scan.paused as u64,
            trashed: scan.trashed,
            secrets: scan.secrets,
            warnings: scan.warnings.into_iter().map(flagged_file).collect(),
            root_gone: scan.root_gone,
        },
        rebased: drain.rebased as u64,
        gave_way: drain.gave_way as u64,
        drain: drained(drain.report)?,
        pull: pull.map(pull_of),
        flagged: flagged.into_iter().map(flagged_file).collect(),
    })
}

fn pull_of(pull: marfa_core::PullReport) -> PullReport {
    PullReport {
        written: pull.written as u64,
        rewritten: pull.rewritten as u64,
        moved: pull.moved as u64,
        unchanged: pull.unchanged as u64,
        skipped: pull.skipped as u64,
        removed: pull.removed as u64,
        kept: pull.kept as u64,
        unwritten: pull.unwritten as u64,
        absent: pull.absent as u64,
        unplaced: pull.unplaced as u64,
        unmatched: pull.unmatched as u64,
        paused: pull.paused as u64,
        root_gone: pull.root_gone,
    }
}

fn flagged_file(file: marfa_core::folder::Flagged) -> FlaggedFile {
    FlaggedFile {
        path: file.path,
        flag: file.flag.to_string(),
        reason: file.reason,
    }
}

fn state_of(status: &str) -> Result<FileState, MarfaError> {
    Ok(match status {
        "in_step" => FileState::InStep,
        "waiting" => FileState::Waiting,
        "held" => FileState::Held,
        "unmatched" => FileState::Unmatched,
        "unreached" => FileState::Unreached,
        "outside" => FileState::Outside,
        other => {
            return Err(MarfaError::Decoding {
                message: format!(
                    "the folder's status names a state this build does not know: {other}"
                ),
            });
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_state_a_status_names_crosses() {
        for state in [
            "in_step",
            "waiting",
            "held",
            "unmatched",
            "unreached",
            "outside",
        ] {
            assert!(state_of(state).is_ok(), "{state}");
        }
        assert!(matches!(
            state_of("drifting"),
            Err(MarfaError::Decoding { .. })
        ));
    }

    #[test]
    fn a_url_without_a_key_is_refused() {
        assert!(Folders::new(Some("http://127.0.0.1:9".into()), None).is_err());
        assert!(Folders::new(None, None).is_ok());
    }
}
