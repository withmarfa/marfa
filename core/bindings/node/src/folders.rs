//! Folder operations and their ordered watch callbacks for Node.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeCallContext, ThreadsafeFunctionCallMode};
use napi_derive::napi;

use crate::{DrainReport, Ending, HydrateReport, Subscription, count, record, report_of};
use marfa_core::CoreError;

#[napi(object)]
pub struct ListedFolder {
    pub dir: String,
    pub folder: String,
    pub paused: bool,
    /// The opaque ID this directory's copy reports under, the
    /// `folder_store_id` the server returns for it in a folder's status. It
    /// is not a path and names no machine. Unset where the registry entry
    /// holds none.
    pub store: Option<String>,
}

fn listed_of(entry: marfa_core::folder::Registered) -> ListedFolder {
    ListedFolder {
        paused: marfa_core::Folder::paused_at(&entry.dir),
        dir: entry.dir.display().to_string(),
        folder: entry.folder,
        store: entry.store,
    }
}
#[napi(discriminant = "cause", discriminant_case = "camelCase")]
pub enum StorageCause {
    ICloudDrive,
    CloudService,
    CloudSynced,
    NetworkFileSystem { kind: String },
}

fn storage_of(cause: Option<marfa_core::StorageCause>) -> Option<StorageCause> {
    use marfa_core::StorageCause as C;
    cause.map(|cause| match cause {
        C::ICloudDrive => StorageCause::ICloudDrive,
        C::CloudService => StorageCause::CloudService,
        C::CloudSynced => StorageCause::CloudSynced,
        C::NetworkFileSystem(kind) => StorageCause::NetworkFileSystem { kind },
    })
}
#[napi(object)]
pub struct AddedFolder {
    pub dir: String,
    pub folder: String,
    pub storage: Option<StorageCause>,
    /// Git tracks the directory: it is in a git work tree whose index holds a
    /// file in it. Checking out, resetting or switching branches then changes
    /// the files, and the folder syncs those changes. `false` where git cannot
    /// be run, errors or does not answer within a second.
    pub git_tracked: bool,
}

fn added_of(added: &marfa_core::Folder) -> AddedFolder {
    AddedFolder {
        dir: added.root().display().to_string(),
        folder: added.folder_id().to_string(),
        storage: storage_of(added.storage_cause()),
        git_tracked: added.git_tracked(),
    }
}
/// What `remove` did: the folder's state went, or only its registry entry,
/// for `reason`. Where another instance answers at the folder's server,
/// `unsent` writes waited, and `files` hold changes the folder could not send.
#[napi(object)]
pub struct FolderRemoval {
    pub dir: String,
    pub removed: bool,
    pub reason: Option<String>,
    pub folder: Option<String>,
    pub unsent: i64,
    pub files: Vec<UnsentFile>,
}
#[napi(string_enum = "snake_case")]
pub enum UnsentChange {
    Changed,
    New,
    Moved,
    Deleted,
}
#[napi(object)]
pub struct UnsentFile {
    pub change: UnsentChange,
    pub path: Option<String>,
    pub from: Option<String>,
    pub item: Option<String>,
}
#[napi(string_enum = "snake_case")]
pub enum FileState {
    InStep,
    Waiting,
    Held,
    Unmatched,
    Unreached,
    Outside,
}

#[napi(object)]
pub struct FileStatus {
    pub path: String,
    pub item_id: Option<String>,
    pub state: FileState,
    pub waits: Vec<String>,
    pub flag: Option<String>,
    pub reason: Option<String>,
    pub warning: Option<String>,
}
#[napi(object)]
pub struct FolderPaused {
    pub disk: i64,
    pub pull: i64,
    pub additions: i64,
    pub outside_query: i64,
}
#[napi(object)]
pub struct FirstSyncPlan {
    pub write: i64,
    pub send: i64,
    pub beside: i64,
    pub left: i64,
}

impl From<marfa_core::FirstSync> for FirstSyncPlan {
    fn from(plan: marfa_core::FirstSync) -> Self {
        FirstSyncPlan {
            write: count(plan.write as u64),
            send: count(plan.send as u64),
            beside: count(plan.beside as u64),
            left: count(plan.left as u64),
        }
    }
}
#[napi(object)]
pub struct WaitingFirstSync {
    pub plan: Option<FirstSyncPlan>,
}

#[napi(object)]
pub struct FolderStatus {
    pub directories: Vec<FlaggedFile>,
    pub files: Vec<FileStatus>,
    pub paused: FolderPaused,
    pub first_sync: Option<WaitingFirstSync>,
    pub sync_paused: bool,
    pub unwatched: i64,
}
#[napi(object)]
pub struct FlaggedFile {
    pub path: String,
    pub flag: String,
    pub reason: String,
    pub item: Option<String>,
}
#[napi(object)]
pub struct SettingsFileOutcome {
    pub sent: bool,
    pub written: bool,
    pub flagged: Option<String>,
    pub unwritten: Option<String>,
}

#[napi(object)]
pub struct FolderScan {
    pub created: i64,
    pub updated: i64,
    pub renamed: i64,
    pub unchanged: i64,
    pub waiting: i64,
    pub missing: i64,
    pub deleted: i64,
    pub skipped: i64,
    pub moved_away: i64,
    pub paused: i64,
    pub paused_additions: i64,
    pub held_outside: i64,
    pub trashed: Vec<String>,
    pub secrets: Vec<String>,
    pub warnings: Vec<FlaggedFile>,
    pub root_gone: Option<String>,
    /// Why links by name wait though the server answered, where they do: it
    /// refused a title lookup as a whole, or has none. Said once for the
    /// folder, not for each file.
    pub lookup_refused: Option<String>,
}

#[napi(object)]
pub struct FolderPull {
    pub written: i64,
    pub rewritten: i64,
    pub moved: i64,
    pub unchanged: i64,
    pub skipped: i64,
    pub removed: i64,
    pub purged: i64,
    pub kept: i64,
    pub unwritten: i64,
    pub busy: i64,
    pub absent: i64,
    pub unplaced: i64,
    pub unmatched: i64,
    pub paused: i64,
    pub root_gone: Option<String>,
}
#[napi(object)]
pub struct FolderPass {
    pub settings: SettingsFileOutcome,
    pub scan: FolderScan,
    pub drain: DrainReport,
    pub rebased: i64,
    pub gave_way: i64,
    pub pull: Option<FolderPull>,
    pub flagged: Vec<FlaggedFile>,
}
#[allow(clippy::large_enum_variant)]
#[napi(discriminant = "kind", discriminant_case = "camelCase")]
pub enum FolderSyncOutcome {
    Done { sync: FolderSync },
    Waiting { plan: FirstSyncPlan },
}
#[napi(object)]
pub struct FolderSync {
    pub hydrated: Option<HydrateReport>,
    pub catch_up_error: Option<serde_json::Value>,
    pub pass: FolderPass,
}

#[napi(object)]
pub struct UnsureFile {
    pub path: String,
    pub reason: String,
}
#[napi(object)]
pub struct ConfirmedFolder {
    pub deleted: i64,
    pub moved: i64,
    pub removed: i64,
    pub added: i64,
    pub unsure: Vec<UnsureFile>,
    pub refused: Vec<UnsureFile>,
}
#[napi(object)]
pub struct HeldFile {
    pub path: String,
    pub item: String,
    pub missing_since: String,
    pub reason: String,
}
#[napi(object)]
pub struct SettledHeld {
    pub trashed: Vec<String>,
    pub gone: Vec<String>,
    pub moved: Vec<String>,
    pub kept: Vec<String>,
    pub written_back: Vec<String>,
    pub not_written_back: Vec<FlaggedFile>,
    pub not_settled: Vec<UnsureFile>,
}
#[napi(object)]
pub struct RestoredRemoval {
    pub put_back: i64,
    pub restored: i64,
    pub pull: FolderPull,
}
/// An unmatched file `removeUnmatched` took away. Its item is unchanged.
#[napi(object)]
pub struct UnmatchedFile {
    pub path: String,
    pub item_id: Option<String>,
}
/// A path `removeUnmatched` was given and left in place, with why, as a
/// clause that follows "is kept:".
#[napi(object)]
pub struct KeptUnmatched {
    pub path: String,
    pub item_id: Option<String>,
    pub reason: String,
}
/// What `removeUnmatched` did. `ended` counts the folder's placements of the
/// removed files' items, ended and queued to be sent at the next sync.
/// `settled` lists the removals Marfa stopped on that it ended, because it
/// showed each file gone or, where a record does not read, because no file is
/// at its path in the folder's own directory; their items are unchanged.
#[napi(object)]
pub struct UnmatchedRemoved {
    pub removed: Vec<UnmatchedFile>,
    pub kept: Vec<KeptUnmatched>,
    pub ended: i64,
    pub settled: Vec<UnmatchedFile>,
}
/// What Marfa last found of the programs writing to a kept file: `not_looked`
/// where it has not looked since it set the file aside.
#[napi(string_enum = "snake_case")]
pub enum KeptWriters {
    Open,
    Unknown,
    NotLooked,
}
/// A file a pull set aside under a `.marfa-kept-` name because a program
/// might still write to it. `until` is the UTC discard date of an unchanged
/// file, as `YYYY-MM-DD`, where Marfa cannot tell whether a program writes.
#[napi(object)]
pub struct KeptFile {
    pub path: String,
    pub from: String,
    pub writers: KeptWriters,
    pub until: Option<String>,
    pub reason: String,
}
/// What `discardKept` did: the kept files deleted, the paths a written kept
/// file went back to or was kept beside, the records that remain, and the
/// records of a stopped discard that do not read, forgotten because no file is
/// at their paths in the folder's own directory.
#[napi(object)]
pub struct KeptDiscarded {
    pub discarded: Vec<String>,
    pub put_back: Vec<String>,
    pub kept: Vec<KeptFile>,
    pub forgotten: Vec<String>,
}
#[allow(clippy::large_enum_variant)]
#[napi(discriminant = "kind", discriminant_case = "camelCase")]
pub enum FolderEvent {
    Watching {
        dir: String,
        storage: Option<StorageCause>,
    },
    WatcherFailed {
        message: String,
    },
    Retrying {
        error: serde_json::Value,
        wait_ms: i64,
    },
    Unreachable {
        reason: String,
    },
    Reachable,
    Waiting {
        reason: String,
    },
    Passed {
        pass: FolderPass,
    },
    HandedOver,
    HeldElsewhere,
    Paused,
    TakenBack,
    Removed,
    Unlisted,
}

#[napi]
pub struct Folders {
    server: Option<marfa_core::Server>,
    #[cfg(debug_assertions)]
    probe: Arc<std::sync::Mutex<Option<Arc<marfa_core::Folder>>>>,
}

#[napi]
impl Folders {
    #[napi(constructor)]
    pub fn new(env: Env, url: Option<String>, key: Option<String>) -> Result<Self> {
        let server = match (url, key) {
            (Some(url), Some(key)) => Some(marfa_core::Server { url, key }),
            (None, None) => None,
            _ => {
                return Err(crate::failure(
                    env,
                    CoreError::Invalid("url and key go together".into()),
                ));
            }
        };
        Ok(Self {
            server,
            #[cfg(debug_assertions)]
            probe: Arc::default(),
        })
    }

    #[napi(ts_return_type = "Promise<AddedFolder>")]
    pub fn add(&self, dir: String, folder: String) -> AsyncTask<AddFolder> {
        AsyncTask::new(AddFolder {
            dir,
            folder,
            server: self.server.clone(),
            failed: None,
        })
    }

    #[napi(ts_return_type = "Promise<Array<ListedFolder>>")]
    pub fn list(&self) -> AsyncTask<ListFolders> {
        AsyncTask::new(ListFolders { failed: None })
    }

    #[napi(ts_return_type = "Promise<FolderStatus>")]
    pub fn status(&self, dir: String) -> AsyncTask<ReadFolderStatus> {
        AsyncTask::new(ReadFolderStatus { dir, failed: None })
    }

    #[napi(ts_return_type = "Promise<FolderSyncOutcome>")]
    pub fn sync(&self, dir: String) -> AsyncTask<SyncFolder> {
        AsyncTask::new(SyncFolder {
            dir,
            server: self.server.clone(),
            failed: None,
        })
    }

    #[napi(ts_return_type = "Promise<boolean>")]
    pub fn confirm_first_sync(&self, dir: String) -> AsyncTask<ConfirmFirstSync> {
        AsyncTask::new(ConfirmFirstSync { dir, failed: None })
    }

    #[napi(ts_return_type = "Promise<boolean>")]
    pub fn pause(&self, dir: String) -> AsyncTask<PauseSync> {
        AsyncTask::new(PauseSync {
            dir,
            server: self.server.clone(),
            pausing: true,
            failed: None,
        })
    }

    #[napi(ts_return_type = "Promise<boolean>")]
    pub fn resume(&self, dir: String) -> AsyncTask<PauseSync> {
        AsyncTask::new(PauseSync {
            dir,
            server: self.server.clone(),
            pausing: false,
            failed: None,
        })
    }

    #[napi(ts_return_type = "Promise<ConfirmedFolder>")]
    pub fn confirm(&self, dir: String) -> AsyncTask<ConfirmFolder> {
        AsyncTask::new(ConfirmFolder { dir, failed: None })
    }

    #[napi(ts_return_type = "Promise<RestoredRemoval>")]
    pub fn restore(&self, dir: String) -> AsyncTask<RestoreRemoval> {
        AsyncTask::new(RestoreRemoval {
            dir,
            server: self.server.clone(),
            failed: None,
        })
    }

    #[napi(ts_return_type = "Promise<Array<HeldFile>>")]
    pub fn held(&self, dir: String) -> AsyncTask<ReadHeld> {
        AsyncTask::new(ReadHeld { dir, failed: None })
    }

    #[napi(ts_return_type = "Promise<SettledHeld>")]
    pub fn trash_held(&self, dir: String, paths: Vec<String>) -> AsyncTask<SettleHeld> {
        AsyncTask::new(SettleHeld {
            dir,
            paths,
            settle: marfa_core::Settle::Trash,
            server: None,
            failed: None,
        })
    }

    #[napi(ts_return_type = "Promise<SettledHeld>")]
    pub fn keep_held(
        &self,
        dir: String,
        paths: Vec<String>,
        write_back: bool,
    ) -> AsyncTask<SettleHeld> {
        AsyncTask::new(SettleHeld {
            dir,
            paths,
            settle: marfa_core::Settle::Keep { write_back },
            server: self.server.clone(),
            failed: None,
        })
    }

    #[napi(ts_return_type = "Promise<FolderRemoval>")]
    pub fn remove(&self, dir: String) -> AsyncTask<RemoveFolder> {
        AsyncTask::new(RemoveFolder { dir, failed: None })
    }

    /// Takes away the named unmatched files and never their items. Needs no
    /// server, and asks a watch that holds the folder to let it go.
    #[napi(ts_return_type = "Promise<UnmatchedRemoved>")]
    pub fn remove_unmatched(&self, dir: String, paths: Vec<String>) -> AsyncTask<RemoveUnmatched> {
        AsyncTask::new(RemoveUnmatched {
            dir,
            paths,
            failed: None,
        })
    }

    /// Lists kept-file records in path order, even while a watch holds the folder.
    #[napi(ts_return_type = "Promise<Array<KeptFile>>")]
    pub fn kept(&self, dir: String) -> AsyncTask<ReadKept> {
        AsyncTask::new(ReadKept { dir, failed: None })
    }

    /// Deletes each kept file unchanged since Marfa set it aside; one a
    /// program wrote to goes back instead. Needs no server, and asks a watch
    /// that holds the folder to let it go.
    #[napi(ts_return_type = "Promise<KeptDiscarded>")]
    pub fn discard_kept(&self, dir: String) -> AsyncTask<DiscardKept> {
        AsyncTask::new(DiscardKept { dir, failed: None })
    }

    /// The paths of listed records Marfa cannot prove gone where nothing is
    /// at the path, read beside a running watch.
    #[napi(ts_return_type = "Promise<Array<string>>")]
    pub fn unproved_gone(&self, dir: String) -> AsyncTask<UnprovedGone> {
        AsyncTask::new(UnprovedGone { dir, failed: None })
    }

    /// Forgets each record `unprovedGone` lists at one of `paths` where
    /// nothing is at its path still, once the person confirms Marfa cannot
    /// prove the file is gone. Deletes no file, and asks a watch that holds
    /// the folder to let it go.
    #[napi(ts_return_type = "Promise<Array<string>>")]
    pub fn forget_unproved(&self, dir: String, paths: Vec<String>) -> AsyncTask<ForgetUnproved> {
        AsyncTask::new(ForgetUnproved {
            dir,
            paths,
            failed: None,
        })
    }

    /// The callbacks share one event-loop queue, so the end follows every event.
    /// A callback that throws stops the watch and ends it with `listener_threw`.
    #[napi(
        ts_args_type = "dir: string, onEvent: (event: FolderEvent) => void, onEnd: (error: (Error & { code: string }) | null) => void"
    )]
    pub fn watch(
        &self,
        env: Env,
        dir: String,
        on_event: Function<FolderEvent, ()>,
        on_end: Function<Option<Unknown<'static>>, ()>,
    ) -> Result<Subscription> {
        let folder = marfa_core::Folder::open(&dir, self.server.clone())
            .map_err(|error| folder_failure(env, error, &dir, false))?;
        if folder
            .awaiting_confirmation()
            .map_err(|error| crate::failure(env, error))?
        {
            return Err(crate::failure(env, CoreError::FirstSyncWaiting));
        }
        let stop = Arc::new(AtomicBool::new(false));
        let tell = told_by(env, on_event, on_end, Arc::clone(&stop))?;
        let flag = Arc::clone(&stop);
        let server = self.server.clone();
        let origin = server.as_ref().map(|server| server.url.clone());
        std::thread::spawn(move || {
            let watched = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                keep_in_step(folder, server, &flag, &tell)
            }));
            let error = match watched {
                Ok(watched) => watched.err().map(|error| ended(error, origin.as_deref())),
                Err(fault) => Some(CoreError::Fault(format!(
                    "the watch stopped on a fault: {}",
                    said(fault.as_ref())
                ))),
            };
            tell(Told::End(error));
        });
        Ok(Subscription {
            ending: Ending::Flag(stop),
        })
    }
}

fn folder_failure(env: Env, error: CoreError, dir: &str, asking: bool) -> Error {
    if !matches!(error, CoreError::ReadingHandle) {
        return crate::failure(env, error);
    }
    let message = if asking {
        marfa_core::folder::not_handed_over(std::path::Path::new(dir))
    } else {
        marfa_core::folder::held_by_another(std::path::Path::new(dir))
    };
    let made = (|| {
        let mut error = crate::error_object(&env, &error)?;
        error.set_named_property("message", format!("reading_handle: {message}"))?;
        error.into_unknown(&env)
    })();
    match made {
        Ok(error) => Error::from(error),
        Err(error) => error,
    }
}

fn rejected(env: Env, error: Option<CoreError>, plain: Error, dir: &str) -> Error {
    match error {
        Some(error) => folder_failure(env, error, dir, true),
        None => plain,
    }
}

fn working(
    dir: &str,
    server: Option<marfa_core::Server>,
) -> marfa_core::Result<marfa_core::Folder> {
    marfa_core::Folder::open_asking(dir, server)
}

pub struct AddFolder {
    dir: String,
    folder: String,
    server: Option<marfa_core::Server>,
    failed: Option<CoreError>,
}
#[napi]
impl Task for AddFolder {
    type Output = AddedFolder;
    type JsValue = AddedFolder;
    fn reject(&mut self, env: Env, error: Error) -> Result<Self::JsValue> {
        Err(rejected(env, self.failed.take(), error, &self.dir))
    }
    fn compute(&mut self) -> Result<Self::Output> {
        (|| -> marfa_core::Result<Self::Output> {
            let added =
                marfa_core::Folder::add(&self.dir, &self.folder, self.server.clone(), None)?;
            Ok(added_of(&added))
        })()
        .map_err(|error| record(&mut self.failed, error))
    }
    fn resolve(&mut self, _: Env, report: Self::Output) -> Result<Self::JsValue> {
        Ok(report)
    }
}

pub struct ListFolders {
    failed: Option<CoreError>,
}
#[napi]
impl Task for ListFolders {
    type Output = Vec<ListedFolder>;
    type JsValue = Vec<ListedFolder>;
    fn reject(&mut self, env: Env, error: Error) -> Result<Self::JsValue> {
        Err(crate::rethrown(env, self.failed.take(), error))
    }
    fn compute(&mut self) -> Result<Self::Output> {
        (|| -> marfa_core::Result<Self::Output> {
            let Some(registry) = marfa_core::folder::Registry::located() else {
                return Ok(Vec::new());
            };
            Ok(registry.folders()?.into_iter().map(listed_of).collect())
        })()
        .map_err(|error| record(&mut self.failed, error))
    }
    fn resolve(&mut self, _: Env, report: Self::Output) -> Result<Self::JsValue> {
        Ok(report)
    }
}

pub struct ReadFolderStatus {
    dir: String,
    failed: Option<CoreError>,
}
#[napi]
impl Task for ReadFolderStatus {
    type Output = FolderStatus;
    type JsValue = FolderStatus;
    fn reject(&mut self, env: Env, error: Error) -> Result<Self::JsValue> {
        Err(rejected(env, self.failed.take(), error, &self.dir))
    }
    fn compute(&mut self) -> Result<Self::Output> {
        (|| -> marfa_core::Result<Self::Output> {
            let report = marfa_core::Folder::status_of(&self.dir)?;
            Ok(FolderStatus {
                directories: report.directories.into_iter().map(flagged_file).collect(),
                files: report
                    .files
                    .into_iter()
                    .map(|file| {
                        Ok(FileStatus {
                            state: state_of(file.status)?,
                            path: file.path,
                            item_id: file.item_id,
                            waits: file.waits.into_iter().map(str::to_string).collect(),
                            flag: file.flag.map(str::to_string),
                            reason: file.reason,
                            warning: file.warning,
                        })
                    })
                    .collect::<marfa_core::Result<_>>()?,
                paused: FolderPaused {
                    disk: count(report.paused.disk as u64),
                    pull: count(report.paused.pull as u64),
                    additions: count(report.paused.additions as u64),
                    outside_query: count(report.paused.outside_query as u64),
                },
                first_sync: report.first_sync.map(|waiting| WaitingFirstSync {
                    plan: waiting.plan.map(Into::into),
                }),
                sync_paused: report.sync_paused,
                unwatched: count(report.unwatched),
            })
        })()
        .map_err(|error| record(&mut self.failed, error))
    }
    fn resolve(&mut self, _: Env, report: Self::Output) -> Result<Self::JsValue> {
        Ok(report)
    }
}

pub struct SyncFolder {
    dir: String,
    server: Option<marfa_core::Server>,
    failed: Option<CoreError>,
}
#[napi]
impl Task for SyncFolder {
    type Output = FolderSyncOutcome;
    type JsValue = FolderSyncOutcome;
    fn reject(&mut self, env: Env, error: Error) -> Result<Self::JsValue> {
        Err(rejected(env, self.failed.take(), error, &self.dir))
    }
    fn compute(&mut self) -> Result<Self::Output> {
        (|| -> marfa_core::Result<Self::Output> {
            let synced = match working(&self.dir, self.server.clone())?.sync()? {
                marfa_core::Synced::Done(synced) => *synced,
                marfa_core::Synced::Waiting(plan) => {
                    return Ok(FolderSyncOutcome::Waiting { plan: plan.into() });
                }
            };
            Ok(FolderSyncOutcome::Done {
                sync: FolderSync {
                    hydrated: synced.hydrated.map(HydrateReport::from),
                    catch_up_error: synced.catch_up.err().map(error_report),
                    pass: pass_of(
                        synced.settings,
                        synced.scan,
                        synced.drain,
                        synced.pull,
                        None,
                    )?,
                },
            })
        })()
        .map_err(|error| record(&mut self.failed, error))
    }
    fn resolve(&mut self, _: Env, report: Self::Output) -> Result<Self::JsValue> {
        Ok(report)
    }
}

pub struct ConfirmFirstSync {
    dir: String,
    failed: Option<CoreError>,
}
#[napi]
impl Task for ConfirmFirstSync {
    type Output = bool;
    type JsValue = bool;
    fn reject(&mut self, env: Env, error: Error) -> Result<Self::JsValue> {
        Err(rejected(env, self.failed.take(), error, &self.dir))
    }
    fn compute(&mut self) -> Result<Self::Output> {
        (|| -> marfa_core::Result<Self::Output> { working(&self.dir, None)?.confirm_first_sync() })(
        )
        .map_err(|error| record(&mut self.failed, error))
    }
    fn resolve(&mut self, _: Env, report: Self::Output) -> Result<Self::JsValue> {
        Ok(report)
    }
}

pub struct PauseSync {
    dir: String,
    server: Option<marfa_core::Server>,
    pausing: bool,
    failed: Option<CoreError>,
}
#[napi]
impl Task for PauseSync {
    type Output = bool;
    type JsValue = bool;
    fn reject(&mut self, env: Env, error: Error) -> Result<Self::JsValue> {
        Err(rejected(env, self.failed.take(), error, &self.dir))
    }
    fn compute(&mut self) -> Result<Self::Output> {
        (|| -> marfa_core::Result<Self::Output> {
            let folder = working(&self.dir, self.server.clone())?;
            if self.pausing {
                folder.pause_sync()
            } else {
                folder.resume_sync()
            }
        })()
        .map_err(|error| record(&mut self.failed, error))
    }
    fn resolve(&mut self, _: Env, report: Self::Output) -> Result<Self::JsValue> {
        Ok(report)
    }
}

pub struct ConfirmFolder {
    dir: String,
    failed: Option<CoreError>,
}
#[napi]
impl Task for ConfirmFolder {
    type Output = ConfirmedFolder;
    type JsValue = ConfirmedFolder;
    fn reject(&mut self, env: Env, error: Error) -> Result<Self::JsValue> {
        Err(rejected(env, self.failed.take(), error, &self.dir))
    }
    fn compute(&mut self) -> Result<Self::Output> {
        (|| -> marfa_core::Result<Self::Output> {
            let confirmed = working(&self.dir, None)?.confirm()?;
            Ok(ConfirmedFolder {
                deleted: count(confirmed.deleted as u64),
                moved: count(confirmed.moved as u64),
                removed: count(confirmed.removed as u64),
                added: count(confirmed.added as u64),
                unsure: confirmed
                    .unsure
                    .into_iter()
                    .map(|file| UnsureFile {
                        path: file.path,
                        reason: file.reason,
                    })
                    .collect(),
                refused: confirmed
                    .refused
                    .into_iter()
                    .map(|file| UnsureFile {
                        path: file.path,
                        reason: file.reason,
                    })
                    .collect(),
            })
        })()
        .map_err(|error| record(&mut self.failed, error))
    }
    fn resolve(&mut self, _: Env, report: Self::Output) -> Result<Self::JsValue> {
        Ok(report)
    }
}

pub struct RestoreRemoval {
    dir: String,
    server: Option<marfa_core::Server>,
    failed: Option<CoreError>,
}
#[napi]
impl Task for RestoreRemoval {
    type Output = RestoredRemoval;
    type JsValue = RestoredRemoval;
    fn reject(&mut self, env: Env, error: Error) -> Result<Self::JsValue> {
        Err(rejected(env, self.failed.take(), error, &self.dir))
    }
    fn compute(&mut self) -> Result<Self::Output> {
        (|| -> marfa_core::Result<Self::Output> {
            let restored = working(&self.dir, self.server.clone())?.restore()?;
            Ok(RestoredRemoval {
                put_back: count(restored.put_back as u64),
                restored: count(restored.restored as u64),
                pull: pull_of(restored.pull),
            })
        })()
        .map_err(|error| record(&mut self.failed, error))
    }
    fn resolve(&mut self, _: Env, report: Self::Output) -> Result<Self::JsValue> {
        Ok(report)
    }
}

pub struct RemoveUnmatched {
    dir: String,
    paths: Vec<String>,
    failed: Option<CoreError>,
}
#[napi]
impl Task for RemoveUnmatched {
    type Output = UnmatchedRemoved;
    type JsValue = UnmatchedRemoved;
    fn reject(&mut self, env: Env, error: Error) -> Result<Self::JsValue> {
        Err(rejected(env, self.failed.take(), error, &self.dir))
    }
    fn compute(&mut self) -> Result<Self::Output> {
        (|| -> marfa_core::Result<Self::Output> {
            let done = working(&self.dir, None)?.remove_unmatched(&self.paths)?;
            Ok(UnmatchedRemoved {
                removed: done
                    .removed
                    .into_iter()
                    .map(|file| UnmatchedFile {
                        path: file.path,
                        item_id: file.item_id,
                    })
                    .collect(),
                kept: done
                    .kept
                    .into_iter()
                    .map(|file| KeptUnmatched {
                        reason: file.kept.or(file.held).unwrap_or_default(),
                        path: file.path,
                        item_id: file.item_id,
                    })
                    .collect(),
                ended: count(done.ended as u64),
                settled: done
                    .settled
                    .into_iter()
                    .map(|file| UnmatchedFile {
                        path: file.path,
                        item_id: file.item_id,
                    })
                    .collect(),
            })
        })()
        .map_err(|error| record(&mut self.failed, error))
    }
    fn resolve(&mut self, _: Env, report: Self::Output) -> Result<Self::JsValue> {
        Ok(report)
    }
}

pub struct ReadKept {
    dir: String,
    failed: Option<CoreError>,
}
#[napi]
impl Task for ReadKept {
    type Output = Vec<KeptFile>;
    type JsValue = Vec<KeptFile>;
    fn reject(&mut self, env: Env, error: Error) -> Result<Self::JsValue> {
        Err(rejected(env, self.failed.take(), error, &self.dir))
    }
    fn compute(&mut self) -> Result<Self::Output> {
        marfa_core::Folder::kept_of(&self.dir)
            .and_then(|files| files.into_iter().map(kept_file).collect())
            .map_err(|error| record(&mut self.failed, error))
    }
    fn resolve(&mut self, _: Env, report: Self::Output) -> Result<Self::JsValue> {
        Ok(report)
    }
}

pub struct DiscardKept {
    dir: String,
    failed: Option<CoreError>,
}
#[napi]
impl Task for DiscardKept {
    type Output = KeptDiscarded;
    type JsValue = KeptDiscarded;
    fn reject(&mut self, env: Env, error: Error) -> Result<Self::JsValue> {
        Err(rejected(env, self.failed.take(), error, &self.dir))
    }
    fn compute(&mut self) -> Result<Self::Output> {
        (|| -> marfa_core::Result<Self::Output> {
            let done = working(&self.dir, None)?.discard_kept()?;
            Ok(KeptDiscarded {
                discarded: done.discarded,
                put_back: done.put_back,
                forgotten: done.forgotten,
                kept: done
                    .kept
                    .into_iter()
                    .map(kept_file)
                    .collect::<marfa_core::Result<_>>()?,
            })
        })()
        .map_err(|error| record(&mut self.failed, error))
    }
    fn resolve(&mut self, _: Env, report: Self::Output) -> Result<Self::JsValue> {
        Ok(report)
    }
}

pub struct UnprovedGone {
    dir: String,
    failed: Option<CoreError>,
}
#[napi]
impl Task for UnprovedGone {
    type Output = Vec<String>;
    type JsValue = Vec<String>;
    fn reject(&mut self, env: Env, error: Error) -> Result<Self::JsValue> {
        Err(rejected(env, self.failed.take(), error, &self.dir))
    }
    fn compute(&mut self) -> Result<Self::Output> {
        marfa_core::Folder::unproved_gone_of(&self.dir)
            .map_err(|error| record(&mut self.failed, error))
    }
    fn resolve(&mut self, _: Env, paths: Self::Output) -> Result<Self::JsValue> {
        Ok(paths)
    }
}

pub struct ForgetUnproved {
    dir: String,
    paths: Vec<String>,
    failed: Option<CoreError>,
}
#[napi]
impl Task for ForgetUnproved {
    type Output = Vec<String>;
    type JsValue = Vec<String>;
    fn reject(&mut self, env: Env, error: Error) -> Result<Self::JsValue> {
        Err(rejected(env, self.failed.take(), error, &self.dir))
    }
    fn compute(&mut self) -> Result<Self::Output> {
        working(&self.dir, None)
            .and_then(|folder| folder.forget_unproved(&self.paths))
            .map_err(|error| record(&mut self.failed, error))
    }
    fn resolve(&mut self, _: Env, paths: Self::Output) -> Result<Self::JsValue> {
        Ok(paths)
    }
}

fn kept_file(file: marfa_core::KeptFile) -> marfa_core::Result<KeptFile> {
    Ok(KeptFile {
        writers: match file.writers {
            "open" => KeptWriters::Open,
            "unknown" => KeptWriters::Unknown,
            "none" => KeptWriters::NotLooked,
            other => {
                return Err(CoreError::Decoding(format!(
                    "a kept file names writers this build does not know: {other}"
                )));
            }
        },
        path: file.path,
        from: file.from,
        until: file.until,
        reason: file.reason,
    })
}

pub struct ReadHeld {
    dir: String,
    failed: Option<CoreError>,
}
#[napi]
impl Task for ReadHeld {
    type Output = Vec<HeldFile>;
    type JsValue = Vec<HeldFile>;
    fn reject(&mut self, env: Env, error: Error) -> Result<Self::JsValue> {
        Err(rejected(env, self.failed.take(), error, &self.dir))
    }
    fn compute(&mut self) -> Result<Self::Output> {
        marfa_core::Folder::held_of(&self.dir)
            .map(|files| {
                files
                    .into_iter()
                    .map(|file| HeldFile {
                        path: file.path,
                        item: file.item,
                        missing_since: file.missing_since,
                        reason: file.reason,
                    })
                    .collect()
            })
            .map_err(|error| record(&mut self.failed, error))
    }
    fn resolve(&mut self, _: Env, files: Self::Output) -> Result<Self::JsValue> {
        Ok(files)
    }
}

pub struct SettleHeld {
    dir: String,
    paths: Vec<String>,
    settle: marfa_core::Settle,
    server: Option<marfa_core::Server>,
    failed: Option<CoreError>,
}
#[napi]
impl Task for SettleHeld {
    type Output = SettledHeld;
    type JsValue = SettledHeld;
    fn reject(&mut self, env: Env, error: Error) -> Result<Self::JsValue> {
        Err(rejected(env, self.failed.take(), error, &self.dir))
    }
    fn compute(&mut self) -> Result<Self::Output> {
        (|| -> marfa_core::Result<Self::Output> {
            let settled =
                working(&self.dir, self.server.clone())?.settle_held(&self.paths, self.settle)?;
            Ok(SettledHeld {
                trashed: settled.trashed,
                gone: settled.gone,
                moved: settled.moved,
                kept: settled.kept,
                written_back: settled.written_back,
                not_written_back: settled
                    .not_written_back
                    .into_iter()
                    .map(flagged_file)
                    .collect(),
                not_settled: settled
                    .not_settled
                    .into_iter()
                    .map(|file| UnsureFile {
                        path: file.path,
                        reason: file.reason,
                    })
                    .collect(),
            })
        })()
        .map_err(|error| record(&mut self.failed, error))
    }
    fn resolve(&mut self, _: Env, report: Self::Output) -> Result<Self::JsValue> {
        Ok(report)
    }
}

pub struct RemoveFolder {
    dir: String,
    failed: Option<CoreError>,
}
#[napi]
impl Task for RemoveFolder {
    type Output = FolderRemoval;
    type JsValue = FolderRemoval;
    fn reject(&mut self, env: Env, error: Error) -> Result<Self::JsValue> {
        Err(rejected(env, self.failed.take(), error, &self.dir))
    }
    fn compute(&mut self) -> Result<Self::Output> {
        marfa_core::Folder::remove_at_asking(&self.dir)
            .map(folder_removal)
            .map_err(|error| record(&mut self.failed, error))
    }
    fn resolve(&mut self, _: Env, report: Self::Output) -> Result<Self::JsValue> {
        Ok(report)
    }
}

fn folder_removal(removal: marfa_core::Removal) -> FolderRemoval {
    use marfa_core::folder::UnsentChange as Change;
    match removal {
        marfa_core::Removal::Deleted {
            dir,
            folder,
            unsent,
        } => FolderRemoval {
            dir: dir.display().to_string(),
            removed: true,
            reason: None,
            folder: Some(folder),
            unsent: i64::try_from(unsent.writes).unwrap_or(i64::MAX),
            files: unsent
                .files
                .into_iter()
                .map(|file| UnsentFile {
                    change: match file.change {
                        Change::Changed => UnsentChange::Changed,
                        Change::New => UnsentChange::New,
                        Change::Moved => UnsentChange::Moved,
                        Change::Deleted => UnsentChange::Deleted,
                    },
                    path: file.path,
                    from: file.from,
                    item: file.item,
                })
                .collect(),
        },
        marfa_core::Removal::Unlisted { dir, reason } => FolderRemoval {
            dir: dir.display().to_string(),
            removed: false,
            reason: Some(reason),
            folder: None,
            unsent: 0,
            files: Vec::new(),
        },
    }
}

fn keep_in_step(
    mut folder: marfa_core::Folder,
    server: Option<marfa_core::Server>,
    stop: &AtomicBool,
    tell: &(impl Fn(Told) + Send + Sync),
) -> std::result::Result<(), marfa_core::WatchError<CoreError>> {
    use marfa_core::folder::TakeBack;
    let mut back = false;
    // A directory paused before the watch began is refused; one paused under it is waited for.
    let mut begun = false;
    loop {
        let paused = begun && folder.is_paused()?;
        let end = (if paused {
            Ok(marfa_core::WatchEnd::HandedOver)
        } else {
            folder.watch_handing_over(stop, |event| {
                if matches!(
                    event,
                    marfa_core::WatchEvent::Busy { .. }
                        | marfa_core::WatchEvent::Limited { .. }
                        | marfa_core::WatchEvent::Missed { .. }
                        | marfa_core::WatchEvent::Reclaimed { .. }
                        | marfa_core::WatchEvent::ReclaimFailed(_)
                ) {
                    return Ok(());
                }
                if back && matches!(event, marfa_core::WatchEvent::Watching { .. }) {
                    back = false;
                    tell(Told::Event(Box::new(FolderEvent::TakenBack)));
                    return Ok(());
                }
                tell(Told::Event(Box::new(event_of(event)?)));
                Ok::<(), CoreError>(())
            })
        })?;
        if end == marfa_core::WatchEnd::Stopped {
            return Ok(());
        }
        begun = true;
        let root = folder.root().to_path_buf();
        let listed = marfa_core::Folder::listed_at(&root);
        drop(folder);
        if paused {
            tell(Told::Event(Box::new(FolderEvent::Paused)));
            if !marfa_core::Folder::wait_resumed(&root, stop) {
                return Ok(());
            }
        } else {
            tell(Told::Event(Box::new(FolderEvent::HandedOver)));
        }
        let taken = marfa_core::Folder::take_back(
            &root,
            listed,
            stop,
            || marfa_core::Folder::open(&root, server.clone()),
            || {
                tell(Told::Event(Box::new(FolderEvent::HeldElsewhere)));
                Ok::<(), CoreError>(())
            },
        )?;
        folder = match taken {
            TakeBack::Folder { folder, .. } => {
                back = true;
                *folder
            }
            TakeBack::Stopped => return Ok(()),
            TakeBack::Removed => {
                tell(Told::Event(Box::new(FolderEvent::Removed)));
                return Ok(());
            }
            TakeBack::Unlisted => {
                tell(Told::Event(Box::new(FolderEvent::Unlisted)));
                return Ok(());
            }
        };
    }
}

fn said(fault: &(dyn std::any::Any + Send)) -> String {
    fault
        .downcast_ref::<&str>()
        .map(|said| (*said).to_string())
        .or_else(|| fault.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "no message".into())
}

fn ended(error: marfa_core::WatchError<CoreError>, origin: Option<&str>) -> CoreError {
    use marfa_core::WatchError as W;
    match error {
        W::CredentialRefused(said) => CoreError::Unauthorized {
            server: said.answer().map(Box::new),
            code: "credential_refused".into(),
            message: marfa_core::folder::credential_refused_said(
                origin.unwrap_or("this folder's server"),
                &said,
            ),
        },
        W::FollowEnded(error) | W::Core(error) => error,
        W::InstanceChanged { .. } => CoreError::expired(marfa_core::http::INSTANCE_CHANGED),
        W::Unwatchable(message) => CoreError::Io(message),
        W::Told(error) => error,
    }
}

fn event_of(event: marfa_core::WatchEvent) -> std::result::Result<FolderEvent, CoreError> {
    use marfa_core::WatchEvent as W;
    Ok(match event {
        W::Watching { dir, storage } => FolderEvent::Watching {
            dir: dir.display().to_string(),
            storage: storage_of(storage),
        },
        W::WatcherFailed(message) => FolderEvent::WatcherFailed { message },
        W::Retrying { error, wait } | W::QueryWaits { error, wait } => FolderEvent::Retrying {
            error: error_report(error),
            wait_ms: i64::try_from(wait.as_millis()).unwrap_or(i64::MAX),
        },
        W::Reach(Some(reason)) => FolderEvent::Unreachable { reason },
        W::Reach(None) => FolderEvent::Reachable,
        W::Waiting { scan, .. } => FolderEvent::Waiting {
            reason: scan.root_gone.unwrap_or_default(),
        },
        W::Busy { .. }
        | W::Limited { .. }
        | W::Missed { .. }
        | W::Reclaimed { .. }
        | W::ReclaimFailed(_) => {
            unreachable!("the watch callback drops it")
        }
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
fn pass_of(
    settings: marfa_core::SettingsFileReport,
    scan: marfa_core::ScanReport,
    drain: marfa_core::Drained,
    pull: Option<marfa_core::PullReport>,
    flagged: Option<Vec<marfa_core::folder::Flagged>>,
) -> std::result::Result<FolderPass, CoreError> {
    let flagged = flagged.unwrap_or_else(|| {
        marfa_core::folder::merged_flagged(
            &scan.flagged,
            pull.iter().flat_map(|pull| &pull.flagged),
        )
    });
    Ok(FolderPass {
        settings: SettingsFileOutcome {
            sent: settings.sent,
            written: settings.written,
            flagged: settings.flagged,
            unwritten: settings.unwritten,
        },
        scan: scan_of(scan),
        rebased: count(drain.rebased as u64),
        gave_way: count(drain.gave_way as u64),
        drain: report_of(drain.report)?,
        pull: pull.map(pull_of),
        flagged: flagged.into_iter().map(flagged_file).collect(),
    })
}

fn pull_of(pull: marfa_core::PullReport) -> FolderPull {
    FolderPull {
        written: count(pull.written as u64),
        rewritten: count(pull.rewritten as u64),
        moved: count(pull.moved as u64),
        unchanged: count(pull.unchanged as u64),
        skipped: count(pull.skipped as u64),
        removed: count(pull.removed as u64),
        purged: count(pull.purged as u64),
        kept: count(pull.kept as u64),
        unwritten: count(pull.unwritten as u64),
        busy: count(pull.busy as u64),
        absent: count(pull.absent as u64),
        unplaced: count(pull.unplaced as u64),
        unmatched: count(pull.unmatched as u64),
        paused: count(pull.paused as u64),
        root_gone: pull.root_gone,
    }
}

fn flagged_file(file: marfa_core::folder::Flagged) -> FlaggedFile {
    FlaggedFile {
        path: file.path,
        flag: file.flag.to_string(),
        reason: file.reason,
        item: file.item,
    }
}

fn state_of(status: &str) -> std::result::Result<FileState, CoreError> {
    Ok(match status {
        "in_step" => FileState::InStep,
        "waiting" => FileState::Waiting,
        "held" => FileState::Held,
        "unmatched" => FileState::Unmatched,
        "unreached" => FileState::Unreached,
        "outside" => FileState::Outside,
        other => {
            return Err(CoreError::Decoding(format!(
                "the folder's status names a state this build does not know: {other}"
            )));
        }
    })
}

fn error_report(error: CoreError) -> serde_json::Value {
    let (message, fields) = crate::describe(&error);
    let mut report = serde_json::Map::new();
    report.insert("code".into(), error.code().into());
    report.insert("message".into(), message.into());
    report.extend(fields.into_iter().map(|(name, value)| (name.into(), value)));
    serde_json::Value::Object(report)
}

enum Told {
    Event(Box<FolderEvent>),
    End(Option<CoreError>),
}

fn told_by(
    env: Env,
    on_event: Function<FolderEvent, ()>,
    on_end: Function<Option<Unknown<'static>>, ()>,
    stop: Arc<AtomicBool>,
) -> Result<impl Fn(Told) + Send + Sync + 'static> {
    let on_event = on_event.create_ref()?;
    let on_end = on_end.create_ref()?;
    let mut threw: Option<String> = None;
    let tell = env
        .create_function_from_closure::<(), (), _>("folderListener", |_| Ok(()))?
        .build_threadsafe_function::<Told>()
        .callee_handled::<false>()
        .weak::<true>()
        .build_callback(move |context: ThreadsafeCallContext<Told>| {
            match context.value {
                Told::Event(event) => {
                    if threw.is_none()
                        && let Err(thrown) = on_event.borrow_back(&context.env)?.call(*event)
                    {
                        threw = Some(thrown.reason);
                        stop.store(true, Ordering::Relaxed);
                    }
                }
                Told::End(error) => {
                    let env = &context.env;
                    let error = match (threw.take(), error) {
                        (Some(thrown), _) => {
                            let mut made = env.create_error(Error::new(
                                napi::Status::GenericFailure,
                                format!("listener_threw: onEvent threw {thrown}"),
                            ))?;
                            made.set_named_property("code", "listener_threw")?;
                            Some(made.into_unknown(env)?)
                        }
                        (None, Some(error)) => Some(crate::error_value(env, &error)?),
                        (None, None) => None,
                    };
                    on_end.borrow_back(env)?.call(error)?;
                }
            }
            Ok(())
        })?;
    Ok(move |told| {
        tell.call(told, ThreadsafeFunctionCallMode::NonBlocking);
    })
}

fn scan_of(scan: marfa_core::ScanReport) -> FolderScan {
    FolderScan {
        created: count(scan.created as u64),
        updated: count(scan.updated as u64),
        renamed: count(scan.renamed as u64),
        unchanged: count(scan.unchanged as u64),
        waiting: count(scan.waiting as u64),
        missing: count(scan.missing as u64),
        deleted: count(scan.deleted as u64),
        skipped: count(scan.skipped as u64),
        moved_away: count(scan.moved_away as u64),
        paused: count(scan.paused as u64),
        paused_additions: count(scan.paused_additions as u64),
        held_outside: count(scan.held_outside as u64),
        trashed: scan.trashed,
        secrets: scan.secrets,
        warnings: scan.warnings.into_iter().map(flagged_file).collect(),
        root_gone: scan.root_gone,
        lookup_refused: scan.lookup_refused,
    }
}

#[cfg(debug_assertions)]
#[napi(object)]
pub struct FolderCatchUp {
    pub caught_up: Option<crate::CatchUpReport>,
    pub hydrated: Option<HydrateReport>,
}

#[cfg(debug_assertions)]
#[napi(object)]
pub struct FolderDrain {
    pub drain: DrainReport,
    pub rebased: i64,
    pub gave_way: i64,
}

#[cfg(debug_assertions)]
#[napi]
impl Folders {
    #[napi(ts_return_type = "Promise<void>")]
    pub fn test_open(&self, dir: String) -> AsyncTask<OpenProbeFolder> {
        AsyncTask::new(OpenProbeFolder {
            dir,
            server: self.server.clone(),
            probe: Arc::clone(&self.probe),
            failed: None,
        })
    }

    #[napi]
    pub fn test_close(&self) {
        self.probe
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
    }

    #[napi(ts_return_type = "Promise<FolderPull>")]
    pub fn test_pull(&self, env: Env) -> Result<AsyncTask<ProbePull>> {
        let folder = self
            .probe
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
            .ok_or_else(|| {
                crate::failure(env, CoreError::Invalid("no folder probe is open".into()))
            })?;
        Ok(AsyncTask::new(ProbePull {
            folder,
            failed: None,
        }))
    }

    #[napi(ts_return_type = "Promise<SettingsFileOutcome>")]
    pub fn test_submit_settings_file(
        &self,
        env: Env,
    ) -> Result<AsyncTask<ProbeSubmitSettingsFile>> {
        let folder = self
            .probe
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
            .ok_or_else(|| {
                crate::failure(env, CoreError::Invalid("no folder probe is open".into()))
            })?;
        Ok(AsyncTask::new(ProbeSubmitSettingsFile {
            folder,
            failed: None,
        }))
    }

    #[napi(ts_return_type = "Promise<FolderCatchUp>")]
    pub fn test_catch_up(&self, env: Env) -> Result<AsyncTask<ProbeCatchUp>> {
        let folder = self
            .probe
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
            .ok_or_else(|| {
                crate::failure(env, CoreError::Invalid("no folder probe is open".into()))
            })?;
        Ok(AsyncTask::new(ProbeCatchUp {
            folder,
            failed: None,
        }))
    }

    #[napi(ts_return_type = "Promise<FolderDrain>")]
    pub fn test_drain(&self, env: Env) -> Result<AsyncTask<ProbeDrain>> {
        let folder = self
            .probe
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
            .ok_or_else(|| {
                crate::failure(env, CoreError::Invalid("no folder probe is open".into()))
            })?;
        Ok(AsyncTask::new(ProbeDrain {
            folder,
            failed: None,
        }))
    }

    #[napi(ts_return_type = "Promise<FolderScan>")]
    pub fn test_scan(&self, env: Env) -> Result<AsyncTask<ProbeScan>> {
        let folder = self
            .probe
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
            .ok_or_else(|| {
                crate::failure(env, CoreError::Invalid("no folder probe is open".into()))
            })?;
        Ok(AsyncTask::new(ProbeScan {
            folder,
            failed: None,
        }))
    }

    #[napi(ts_return_type = "Promise<HydrateReport>")]
    pub fn test_hydrate(&self, env: Env) -> Result<AsyncTask<ProbeHydrate>> {
        let folder = self
            .probe
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
            .ok_or_else(|| {
                crate::failure(env, CoreError::Invalid("no folder probe is open".into()))
            })?;
        Ok(AsyncTask::new(ProbeHydrate {
            folder,
            failed: None,
        }))
    }
}

#[cfg(debug_assertions)]
pub struct OpenProbeFolder {
    dir: String,
    server: Option<marfa_core::Server>,
    probe: Arc<std::sync::Mutex<Option<Arc<marfa_core::Folder>>>>,
    failed: Option<CoreError>,
}

#[cfg(debug_assertions)]
#[napi]
impl Task for OpenProbeFolder {
    type Output = ();
    type JsValue = ();
    fn reject(&mut self, env: Env, error: Error) -> Result<()> {
        Err(rejected(env, self.failed.take(), error, &self.dir))
    }
    fn compute(&mut self) -> Result<()> {
        (|| -> marfa_core::Result<()> {
            if self
                .probe
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .is_some()
            {
                return Err(CoreError::Invalid("a folder probe is already open".into()));
            }
            let folder = Arc::new(working(&self.dir, self.server.clone())?);
            let mut held = self
                .probe
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if held.is_some() {
                return Err(CoreError::Invalid("a folder probe is already open".into()));
            }
            *held = Some(folder);
            Ok(())
        })()
        .map_err(|error| record(&mut self.failed, error))
    }
    fn resolve(&mut self, _: Env, _: ()) -> Result<()> {
        Ok(())
    }
}

#[cfg(debug_assertions)]
pub struct ProbePull {
    folder: Arc<marfa_core::Folder>,
    failed: Option<CoreError>,
}

#[cfg(debug_assertions)]
#[napi]
impl Task for ProbePull {
    type Output = FolderPull;
    type JsValue = FolderPull;
    fn reject(&mut self, env: Env, error: Error) -> Result<Self::JsValue> {
        Err(crate::rethrown(env, self.failed.take(), error))
    }
    fn compute(&mut self) -> Result<Self::Output> {
        (|| -> marfa_core::Result<Self::Output> { Ok(pull_of(self.folder.pull()?)) })()
            .map_err(|error| record(&mut self.failed, error))
    }
    fn resolve(&mut self, _: Env, value: Self::Output) -> Result<Self::JsValue> {
        Ok(value)
    }
}

#[cfg(debug_assertions)]
pub struct ProbeSubmitSettingsFile {
    folder: Arc<marfa_core::Folder>,
    failed: Option<CoreError>,
}

#[cfg(debug_assertions)]
#[napi]
impl Task for ProbeSubmitSettingsFile {
    type Output = SettingsFileOutcome;
    type JsValue = SettingsFileOutcome;
    fn reject(&mut self, env: Env, error: Error) -> Result<Self::JsValue> {
        Err(crate::rethrown(env, self.failed.take(), error))
    }
    fn compute(&mut self) -> Result<Self::Output> {
        (|| -> marfa_core::Result<Self::Output> {
            let report = self.folder.send_settings_edit()?;
            Ok(SettingsFileOutcome {
                sent: report.sent,
                written: report.written,
                flagged: report.flagged,
                unwritten: report.unwritten,
            })
        })()
        .map_err(|error| record(&mut self.failed, error))
    }
    fn resolve(&mut self, _: Env, value: Self::Output) -> Result<Self::JsValue> {
        Ok(value)
    }
}

#[cfg(debug_assertions)]
pub struct ProbeCatchUp {
    folder: Arc<marfa_core::Folder>,
    failed: Option<CoreError>,
}

#[cfg(debug_assertions)]
#[napi]
impl Task for ProbeCatchUp {
    type Output = FolderCatchUp;
    type JsValue = FolderCatchUp;
    fn reject(&mut self, env: Env, error: Error) -> Result<Self::JsValue> {
        Err(crate::rethrown(env, self.failed.take(), error))
    }
    fn compute(&mut self) -> Result<Self::Output> {
        (|| -> marfa_core::Result<Self::Output> {
            let report = self.folder.catch_up()?;
            Ok(FolderCatchUp {
                caught_up: report.caught_up.map(crate::CatchUpReport::from),
                hydrated: report.hydrated.map(HydrateReport::from),
            })
        })()
        .map_err(|error| record(&mut self.failed, error))
    }
    fn resolve(&mut self, _: Env, value: Self::Output) -> Result<Self::JsValue> {
        Ok(value)
    }
}

#[cfg(debug_assertions)]
pub struct ProbeDrain {
    folder: Arc<marfa_core::Folder>,
    failed: Option<CoreError>,
}

#[cfg(debug_assertions)]
#[napi]
impl Task for ProbeDrain {
    type Output = FolderDrain;
    type JsValue = FolderDrain;
    fn reject(&mut self, env: Env, error: Error) -> Result<Self::JsValue> {
        Err(crate::rethrown(env, self.failed.take(), error))
    }
    fn compute(&mut self) -> Result<Self::Output> {
        (|| -> marfa_core::Result<Self::Output> {
            let report = self.folder.drain()?;
            Ok(FolderDrain {
                rebased: count(report.rebased as u64),
                gave_way: count(report.gave_way as u64),
                drain: report_of(report.report)?,
            })
        })()
        .map_err(|error| record(&mut self.failed, error))
    }
    fn resolve(&mut self, _: Env, value: Self::Output) -> Result<Self::JsValue> {
        Ok(value)
    }
}

#[cfg(debug_assertions)]
pub struct ProbeScan {
    folder: Arc<marfa_core::Folder>,
    failed: Option<CoreError>,
}

#[cfg(debug_assertions)]
#[napi]
impl Task for ProbeScan {
    type Output = FolderScan;
    type JsValue = FolderScan;
    fn reject(&mut self, env: Env, error: Error) -> Result<Self::JsValue> {
        Err(crate::rethrown(env, self.failed.take(), error))
    }
    fn compute(&mut self) -> Result<Self::Output> {
        (|| -> marfa_core::Result<Self::Output> { Ok(scan_of(self.folder.scan()?)) })()
            .map_err(|error| record(&mut self.failed, error))
    }
    fn resolve(&mut self, _: Env, value: Self::Output) -> Result<Self::JsValue> {
        Ok(value)
    }
}

#[cfg(debug_assertions)]
pub struct ProbeHydrate {
    folder: Arc<marfa_core::Folder>,
    failed: Option<CoreError>,
}

#[cfg(debug_assertions)]
#[napi]
impl Task for ProbeHydrate {
    type Output = HydrateReport;
    type JsValue = HydrateReport;
    fn reject(&mut self, env: Env, error: Error) -> Result<Self::JsValue> {
        Err(crate::rethrown(env, self.failed.take(), error))
    }
    fn compute(&mut self) -> Result<Self::Output> {
        (|| -> marfa_core::Result<Self::Output> { Ok(self.folder.hydrate()?.into()) })()
            .map_err(|error| record(&mut self.failed, error))
    }
    fn resolve(&mut self, _: Env, value: Self::Output) -> Result<Self::JsValue> {
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_scan_carries_why_a_title_lookup_was_refused() {
        let refused = scan_of(marfa_core::ScanReport {
            lookup_refused: Some("links by name wait".into()),
            ..Default::default()
        });
        assert_eq!(
            refused.lookup_refused.as_deref(),
            Some("links by name wait")
        );
        assert_eq!(scan_of(Default::default()).lookup_refused, None);
    }

    #[test]
    fn a_listed_folder_carries_the_store_its_registry_entry_holds() {
        let entry = |store: Option<&str>| marfa_core::folder::Registered {
            dir: "/notes".into(),
            folder: "folder".into(),
            store: store.map(str::to_string),
            root: None,
        };
        assert_eq!(
            listed_of(entry(Some("0192-store"))).store.as_deref(),
            Some("0192-store")
        );
        // The witness: an entry with none lists none.
        assert_eq!(listed_of(entry(None)).store, None);
    }

    fn scratch_directory() -> tempfile::TempDir {
        tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap()
    }

    /// A directory in a work tree of its own, with a file in it that `git add`
    /// has put in the index.
    fn tracked_directory() -> tempfile::TempDir {
        let work_tree = scratch_directory();
        let git = |args: &[&str]| {
            let ran = std::process::Command::new("git")
                .arg("-C")
                .arg(work_tree.path())
                .args(args)
                .output()
                .unwrap();
            assert!(
                ran.status.success(),
                "{}",
                String::from_utf8_lossy(&ran.stderr)
            );
        };
        git(&["init", "-q"]);
        std::fs::create_dir(work_tree.path().join("notes")).unwrap();
        std::fs::write(work_tree.path().join("notes/a.md"), "a").unwrap();
        git(&["add", "notes"]);
        work_tree
    }

    #[test]
    #[ignore = "needs a running server: MARFA_TEST_URL and MARFA_TEST_KEY"]
    fn an_added_folder_says_whether_git_tracks_its_directory() {
        let registry = scratch_directory().keep().join("folders.json");
        // SAFETY: nextest runs each test in a process of its own, and nothing
        // else in this one reads the environment while it is set.
        unsafe { std::env::set_var(marfa_core::folder::REGISTRY_ENV, registry) };
        let server = marfa_core::Server {
            url: std::env::var("MARFA_TEST_URL").expect("MARFA_TEST_URL names the server"),
            key: std::env::var("MARFA_TEST_KEY").expect("MARFA_TEST_KEY holds a working key"),
        };
        let seed = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../scripts/seed.sh");
        let made = std::process::Command::new(seed)
            .args([
                "folder",
                "node git tracked",
                r#"{"query":{"types":["core.note"]}}"#,
            ])
            .output()
            .unwrap();
        assert!(
            made.status.success(),
            "{}",
            String::from_utf8_lossy(&made.stderr)
        );
        let folder = String::from_utf8(made.stdout).unwrap().trim().to_string();
        let work_tree = tracked_directory();
        let add = |dir: &std::path::Path| {
            marfa_core::Folder::add(dir, &folder, Some(server.clone()), None).unwrap()
        };
        let tracked = added_of(&add(&work_tree.path().join("notes")));
        assert!(tracked.git_tracked);
        // The witness: the same call for a directory outside any work tree.
        let outside = scratch_directory();
        assert!(!added_of(&add(outside.path())).git_tracked);
    }
}
