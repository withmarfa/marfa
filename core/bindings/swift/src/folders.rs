//! Folders on this machine: directories whose files are kept in step with a
//! `system.folder`'s query, through the core the `marfa` binary uses, and
//! listed in the one registry the machine keeps.

use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use crate::renewal::Renewal;
use crate::{CredentialRenewer, DrainReport, HydrateReport, MarfaError, Subscription, drained};

/// A folder as the machine's registry lists it.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ListedFolder {
    /// The directory, resolved as far as it exists.
    pub dir: String,
    /// The id of the `system.folder` whose settings it follows.
    pub folder: String,
}

/// Why a folder's directory is in cloud-synced or network storage, where
/// two programs may sync the same files or changes may not be noticed. An app
/// shows it; it is a warning, and the folder works.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Enum)]
pub enum StorageCause {
    /// iCloud Drive syncs the files: the directory is below
    /// `Library/Mobile Documents`.
    ICloudDrive,
    /// A cloud service's File Provider syncs the files: the directory is
    /// below `Library/CloudStorage`.
    CloudService,
    /// macOS reports the directory as ubiquitous outside both of those
    /// places, as it does for `Desktop` and `Documents` where iCloud's
    /// "Desktop & Documents" is on. It reports every File Provider item so,
    /// so which service syncs it is not known: say "iCloud Drive or another
    /// cloud service".
    CloudSynced,
    /// A network file system, named as the operating system names it
    /// (`smbfs`, `nfs`, `afpfs`, `webdav`, `cifs` or `smb2`). Changes made
    /// from another computer may not be noticed.
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

/// A folder `add` made, listed in the machine's registry.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct AddedFolder {
    /// The directory, resolved as far as it exists.
    pub dir: String,
    /// The id of the `system.folder` whose settings it follows.
    pub folder: String,
    /// Why the directory is in cloud-synced or network storage, where it is.
    pub storage: Option<StorageCause>,
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
    /// Its item no longer matches the folder's query.
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
    /// Files left in place whose items left the query elsewhere.
    pub pull: u64,
}

/// What a folder's first sync will do, read from the folder as it stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Record)]
pub struct FirstSyncPlan {
    /// Files it will write into the directory. Not those `left` counts.
    pub write: u64,
    /// Files in the directory it will send, as new items or as the edits of
    /// the items they name.
    pub send: u64,
    /// Of the files it will write, those whose path a file it sends already
    /// has. Both end up in the folder, and one of the two takes a number in
    /// its name; none is written over.
    pub beside: u64,
    /// Items whose file it will not write, because a file it does not send
    /// is at the path: one it holds back, or one it takes no part in. That
    /// file stays as it is and no number is added.
    pub left: u64,
}

impl From<marfa_core::FirstSync> for FirstSyncPlan {
    fn from(plan: marfa_core::FirstSync) -> Self {
        FirstSyncPlan {
            write: plan.write as u64,
            send: plan.send as u64,
            beside: plan.beside as u64,
            left: plan.left as u64,
        }
    }
}

/// A first sync that waits for `confirm_first_sync`, and what the last read of the
/// folder said it will do.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Record)]
pub struct WaitingFirstSync {
    /// `None` until `sync` has read the folder.
    pub plan: Option<FirstSyncPlan>,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct FolderStatus {
    pub directories: Vec<FlaggedFile>,
    pub files: Vec<FileStatus>,
    pub paused: PausedRemoval,
    /// Set while the folder's first sync waits to be confirmed.
    pub first_sync: Option<WaitingFirstSync>,
}

/// A file a pass held or warned about, with why.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct FlaggedFile {
    pub path: String,
    pub flag: String,
    pub reason: String,
    /// The item whose file a pull did not write, or could not let go to
    /// another folder.
    pub item: Option<String>,
}

/// What became of the folder's settings file in a pass.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct SettingsFileOutcome {
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
pub struct FolderScan {
    pub created: u64,
    pub updated: u64,
    pub renamed: u64,
    /// Files whose bytes are as they were and have no write waiting.
    pub unchanged: u64,
    /// Files whose bytes are as they were but whose item's create or edit the
    /// server has not answered yet. Not counted in `unchanged`.
    pub waiting: u64,
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
pub struct FolderPull {
    pub written: u64,
    pub rewritten: u64,
    pub moved: u64,
    pub unchanged: u64,
    pub skipped: u64,
    /// Files of items trashed, purged or gone from the query's states, removed.
    pub removed: u64,
    /// Of `removed`, the files of items purged, which no restore brings back.
    pub purged: u64,
    /// Files of items gone from the query, kept with the person's changes.
    pub kept: u64,
    /// Files the folder did not write, and would not write over.
    pub unwritten: u64,
    /// Items whose bytes could not be fetched.
    pub absent: u64,
    /// Placements the server refused.
    pub unplaced: u64,
    /// Files left in place whose items the query no longer matches.
    pub unmatched: u64,
    /// Files a large removal holds back.
    pub paused: u64,
    /// Why the pull wrote nothing, where the folder's directory is gone.
    pub root_gone: Option<String>,
}

/// One pass: the settings file's edit, the scan, the drain and the pull.
#[derive(Debug, Clone, uniffi::Record)]
pub struct FolderPass {
    pub settings: SettingsFileOutcome,
    pub scan: FolderScan,
    pub drain: DrainReport,
    /// Edits written from a version the server no longer holds, sent again.
    pub rebased: u64,
    /// Placements another machine made first, followed instead.
    pub gave_way: u64,
    /// `None` where the catch-up failed after the copy expired, leaving
    /// nothing to pull from.
    pub pull: Option<FolderPull>,
    /// The files the scan and the pull held, each once.
    pub flagged: Vec<FlaggedFile>,
}

/// What a sync came to: it ran, or the folder's first sync waits to be
/// confirmed and nothing was written or sent.
// UniFFI carries a variant's fields by value, with no box to hold a sync in.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, uniffi::Enum)]
pub enum FolderSyncOutcome {
    /// The sync ran.
    Done { sync: FolderSync },
    /// The first sync waits. `confirm_first_sync` lets it go, and `remove`
    /// drops the folder, leaving its files.
    Waiting { plan: FirstSyncPlan },
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
    /// Files gone from the disk that could not be written back, such as one
    /// whose bytes could not be fetched, each with why. Every later sync
    /// tries each again.
    pub not_written_back: Vec<FlaggedFile>,
    /// Items that left elsewhere, restored at the next sync.
    pub restored: u64,
    pub pull: FolderPull,
}

/// What a watch tells its listener, each when it happens.
// UniFFI carries a variant's fields by value, with no box to hold a pass in.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, uniffi::Enum)]
pub enum FolderEvent {
    /// The directory is watched, and passes begin. `storage` says why it is
    /// in cloud-synced or network storage, where it is.
    Watching {
        dir: String,
        storage: Option<StorageCause>,
    },
    /// The filesystem reported an error; the watch goes on.
    WatcherFailed { message: String },
    /// A hydration failed, and is tried again after `wait_ms`; or a pull met
    /// the copy changing under it, with the error `StreamIncomplete` and the
    /// reason `local_copy_changed`, and the next pass pulls again. Told once
    /// for each run of failures.
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
    /// A command or another call asked for the folder, and the watch let it
    /// go at the end of the step of its pass under way. The watch waits, and
    /// takes the folder back once the folder is free: `TakenBack` says so.
    HandedOver,
    /// The folder was let go, and another process keeps it past the time a
    /// caller waits, with no command or call asking for it. Told once; the
    /// watch takes the folder back once that process lets it go.
    HeldElsewhere,
    /// The watch took the folder back and keeps it in step again. It follows
    /// `HandedOver` or `HeldElsewhere`, and stands in for a second `Watching`.
    TakenBack,
    /// The call the folder was let go to removed the folder from this
    /// machine, so there is nothing to watch. The watch ends.
    Removed,
    /// The call the folder was let go to took the folder off the machine's
    /// registry and left its state, so the watch ends and the folder stays
    /// off the registry.
    Unlisted,
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
    renewal: Option<Arc<Renewal>>,
}

impl Folders {
    fn renew(&self) -> Option<marfa_core::http::Renew> {
        self.renewal.as_ref().map(Renewal::renew)
    }

    /// The server, with the newest token where a renewal answered one.
    fn server(&self) -> Option<marfa_core::Server> {
        sending(self.server.as_ref(), self.renewal.as_ref())
    }
}

fn sending(
    server: Option<&marfa_core::Server>,
    renewal: Option<&Arc<Renewal>>,
) -> Option<marfa_core::Server> {
    match (server, renewal) {
        (Some(server), Some(renewal)) => Some(renewal.sending(server)),
        (server, _) => server.cloned(),
    }
}

#[uniffi::export]
impl Folders {
    /// `url` and `key` go together; without them only `list`, `status`,
    /// `confirm_first_sync`, `confirm`, `restore` and `remove` work.
    /// `renewer` renews `key` when the server refuses it, for every folder
    /// these calls and watches work, as `CredentialRenewer` describes; it needs
    /// `url` and `key`.
    #[uniffi::constructor(default(renewer = None))]
    pub fn new(
        url: Option<String>,
        key: Option<String>,
        renewer: Option<Arc<dyn CredentialRenewer>>,
    ) -> Result<Arc<Self>, MarfaError> {
        let server = crate::server_of(url, key)?;
        let renewal = Renewal::of(renewer, server.as_ref())?;
        Ok(Arc::new(Folders { server, renewal }))
    }

    /// Makes `dir` a folder that follows the `system.folder` `folder`, and
    /// lists it in the machine's registry. The directory is made if it is
    /// not there. Its first sync waits: `sync` says what it will do, and
    /// `confirm_first_sync` lets it go. The answer says why the directory is
    /// in cloud-synced or network storage, where it is; the folder is added
    /// all the same. Reads the file system, so it can wait on a mount that
    /// does not answer. Over a folder a watch holds, asks the watch to let it
    /// go and waits up to 10 seconds, as every call that works a folder does:
    /// past that, it is refused with `ReadingHandle`, naming the folder.
    pub fn add(&self, dir: String, folder: String) -> Result<AddedFolder, MarfaError> {
        let added = marfa_core::Folder::add(&dir, &folder, self.server(), self.renew())
            .map_err(asked(&dir))?;
        Ok(AddedFolder {
            dir: added.root().display().to_string(),
            folder: added.folder_id().to_string(),
            storage: storage_of(added.storage_cause()),
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
            directories: report.directories.into_iter().map(flagged_file).collect(),
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
            first_sync: report.first_sync.map(|waiting| WaitingFirstSync {
                plan: waiting.plan.map(Into::into),
            }),
        })
    }

    /// Everything a folder does, once: sends what changed on disk, catches
    /// up with the server and writes out what its query matches. A folder
    /// whose first sync waits to be confirmed is only read, and `Waiting`
    /// says what the sync will do. Asks a watch that holds the folder to let
    /// it go, as `add` does.
    pub fn sync(&self, dir: String) -> Result<FolderSyncOutcome, MarfaError> {
        let synced = match working(&dir, self.server(), self.renewal.as_ref())?.sync()? {
            marfa_core::Synced::Done(synced) => *synced,
            marfa_core::Synced::Waiting(plan) => {
                return Ok(FolderSyncOutcome::Waiting { plan: plan.into() });
            }
        };
        Ok(FolderSyncOutcome::Done {
            sync: FolderSync {
                hydrated: synced.hydrated.map(Into::into),
                catch_up_error: synced.catch_up.err().map(Into::into),
                pass: pass_of(
                    synced.settings,
                    synced.scan,
                    synced.drain,
                    synced.pull,
                    None,
                )?,
            },
        })
    }

    /// Lets a folder's first sync go, at the next sync or watch. Answers
    /// whether it was waiting. A paused removal is not touched. Asks a watch
    /// that holds the folder to let it go, as `add` does.
    pub fn confirm_first_sync(&self, dir: String) -> Result<bool, MarfaError> {
        Ok(working(&dir, None, None)?.confirm_first_sync()?)
    }

    /// Lets a paused large removal go: its deletes are queued, and files
    /// whose items left elsewhere are taken away. Refused while the first
    /// sync waits. Asks a watch that holds the folder to let it go, as `add`
    /// does.
    pub fn confirm(&self, dir: String) -> Result<ConfirmedRemoval, MarfaError> {
        let confirmed = working(&dir, None, None)?.confirm()?;
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
    /// back, and items that left elsewhere are restored. Asks a watch that
    /// holds the folder to let it go, as `add` does.
    pub fn restore(&self, dir: String) -> Result<RestoredRemoval, MarfaError> {
        let restored = working(&dir, self.server(), self.renewal.as_ref())?.restore()?;
        Ok(RestoredRemoval {
            put_back: restored.put_back as u64,
            not_written_back: restored
                .not_written_back
                .into_iter()
                .map(flagged_file)
                .collect(),
            restored: restored.restored as u64,
            pull: pull_of(restored.pull),
        })
    }

    /// Takes the folder off this machine: its state under `.marfa` goes and
    /// its files stay. Refused while writes wait, except for a first sync
    /// still waiting to be confirmed, which this cancels. Follows no symbolic
    /// link, and takes a path through one only where it is the path the
    /// registry lists. Where that path is
    /// gone, passes through a link, or holds state the registry does not
    /// show to be the folder's own, the folder is only taken off the
    /// registry. Asks a watch that holds the folder to let it go, as `add`
    /// does; that watch then ends with `Removed` or `Unlisted`.
    pub fn remove(&self, dir: String) -> Result<(), MarfaError> {
        marfa_core::Folder::remove_at_asking(&dir).map_err(asked(&dir))?;
        Ok(())
    }

    /// Keeps the folder in step on a thread of its own, as the command
    /// line's watch does, until the subscription is stopped or let go. The
    /// folder is held while it runs, so another process cannot work it
    /// unasked; a watch does not ask for a folder another process holds, and
    /// is refused at once with `ReadingHandle`.
    ///
    /// A call of `Folders`, or a command, that works the folder asks for it.
    /// The watch lets it go at the end of the step of its pass under way and
    /// tells `HandedOver`, then takes the folder back once the call ends and
    /// tells `TakenBack`. A folder removed or taken off the registry meanwhile
    /// ends the watch, after `Removed` or `Unlisted`. A pass under way when
    /// it is stopped finishes before `ended` is called.
    pub fn watch(
        &self,
        dir: String,
        listener: Arc<dyn FolderListener>,
    ) -> Result<Arc<Subscription>, MarfaError> {
        let folder = marfa_core::Folder::open(&dir, self.server())
            .map(|folder| renewing(folder, self.renewal.as_ref()))
            .map_err(held(&dir))?;
        // Refused here rather than ended later, so the caller is told at once.
        if folder.awaiting_confirmation()? {
            return Err(marfa_core::CoreError::FirstSyncWaiting.into());
        }
        let server = self.server.clone();
        let renewal = self.renewal.clone();
        let origin = server.as_ref().map(|server| server.url.clone());
        let stop = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&stop);
        std::thread::spawn(move || {
            // Caught, so a listener waiting to be told the watch ended is told.
            let watched = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                keep_in_step(folder, server, renewal, &flag, &*listener)
            }));
            // The folder is let go by now, before the listener is told: one
            // that works it again on being told must find it free.
            listener.ended(match watched {
                Ok(watched) => watched.err().map(|error| ended(error, origin.as_deref())),
                Err(fault) => Some(MarfaError::Invalid {
                    message: format!("the watch stopped on a fault: {}", said(fault.as_ref())),
                }),
            });
        });
        Ok(Subscription::raising(stop))
    }
}

/// The folder, for a call that works it: a watch holding it is asked to let
/// it go, and takes it back once the call ends.
fn working(
    dir: &str,
    server: Option<marfa_core::Server>,
    renewal: Option<&Arc<Renewal>>,
) -> Result<marfa_core::Folder, MarfaError> {
    marfa_core::Folder::open_asking(dir, server)
        .map(|folder| renewing(folder, renewal))
        .map_err(asked(dir))
}

/// Opening a folder sends nothing, so a renewer set now is in place for its
/// first request.
fn renewing(folder: marfa_core::Folder, renewal: Option<&Arc<Renewal>>) -> marfa_core::Folder {
    if let Some(renewal) = renewal {
        folder.core().renew_credential_with(renewal.renew());
    }
    folder
}

/// A refusal after asking for the folder, naming the folder.
fn asked(dir: &str) -> impl FnOnce(marfa_core::CoreError) -> MarfaError + '_ {
    move |error| match error {
        marfa_core::CoreError::ReadingHandle => MarfaError::ReadingHandle {
            message: marfa_core::folder::not_handed_over(std::path::Path::new(dir)),
        },
        other => other.into(),
    }
}

/// A refusal of a call that does not ask for the folder, naming the folder.
fn held(dir: &str) -> impl FnOnce(marfa_core::CoreError) -> MarfaError + '_ {
    move |error| match error {
        marfa_core::CoreError::ReadingHandle => MarfaError::ReadingHandle {
            message: marfa_core::folder::held_by_another(std::path::Path::new(dir)),
        },
        other => other.into(),
    }
}

/// Watches `folder` until the stop, letting it go to a call that asks for it
/// and taking it back once that call ends. The folder is let go when this
/// returns.
fn keep_in_step(
    mut folder: marfa_core::Folder,
    server: Option<marfa_core::Server>,
    renewal: Option<Arc<Renewal>>,
    stop: &AtomicBool,
    listener: &dyn FolderListener,
) -> Result<(), marfa_core::WatchError<MarfaError>> {
    use marfa_core::folder::TakeBack;
    // The watch has taken the folder back, and its first `Watching` says so.
    let mut back = false;
    loop {
        let end = folder.watch_handing_over(stop, |event| {
            if matches!(event, marfa_core::WatchEvent::Busy { .. }) {
                return Ok(());
            }
            if back && matches!(event, marfa_core::WatchEvent::Watching { .. }) {
                back = false;
                listener.told(FolderEvent::TakenBack);
                return Ok(());
            }
            listener.told(event_of(event)?);
            Ok::<(), MarfaError>(())
        })?;
        if end == marfa_core::WatchEnd::Stopped {
            return Ok(());
        }
        let root = folder.root().to_path_buf();
        let listed = marfa_core::Folder::listed_at(&root);
        drop(folder);
        listener.told(FolderEvent::HandedOver);
        let taken = marfa_core::Folder::take_back(
            &root,
            listed,
            stop,
            || {
                marfa_core::Folder::open(&root, sending(server.as_ref(), renewal.as_ref()))
                    .map(|folder| renewing(folder, renewal.as_ref()))
            },
            || {
                listener.told(FolderEvent::HeldElsewhere);
                Ok::<(), MarfaError>(())
            },
        )?;
        folder = match taken {
            TakeBack::Folder { folder, .. } => {
                back = true;
                *folder
            }
            TakeBack::Stopped => return Ok(()),
            TakeBack::Removed => {
                listener.told(FolderEvent::Removed);
                return Ok(());
            }
            TakeBack::Unlisted => {
                listener.told(FolderEvent::Unlisted);
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
        W::Watching { dir, storage } => FolderEvent::Watching {
            dir: dir.display().to_string(),
            storage: storage_of(storage),
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
        W::Busy { .. } => unreachable!("the watch callback drops it"),
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
        rebased: drain.rebased as u64,
        gave_way: drain.gave_way as u64,
        drain: drained(drain.report)?,
        pull: pull.map(pull_of),
        flagged: flagged.into_iter().map(flagged_file).collect(),
    })
}

fn scan_of(scan: marfa_core::ScanReport) -> FolderScan {
    FolderScan {
        created: scan.created as u64,
        updated: scan.updated as u64,
        renamed: scan.renamed as u64,
        unchanged: scan.unchanged as u64,
        waiting: scan.waiting as u64,
        missing: scan.missing as u64,
        deleted: scan.deleted as u64,
        skipped: scan.skipped as u64,
        moved_away: scan.moved_away as u64,
        paused: scan.paused as u64,
        trashed: scan.trashed,
        secrets: scan.secrets,
        warnings: scan.warnings.into_iter().map(flagged_file).collect(),
        root_gone: scan.root_gone,
    }
}

fn pull_of(pull: marfa_core::PullReport) -> FolderPull {
    FolderPull {
        written: pull.written as u64,
        rewritten: pull.rewritten as u64,
        moved: pull.moved as u64,
        unchanged: pull.unchanged as u64,
        skipped: pull.skipped as u64,
        removed: pull.removed as u64,
        purged: pull.purged as u64,
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
        item: file.item,
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
    fn a_scan_counts_a_file_with_a_write_waiting_apart_from_an_unchanged_one() {
        let scan = scan_of(marfa_core::ScanReport {
            unchanged: 3,
            waiting: 2,
            ..Default::default()
        });
        assert_eq!(scan.unchanged, 3);
        assert_eq!(scan.waiting, 2);
    }

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
    fn a_folder_held_by_another_process_is_refused_naming_the_folder() {
        use marfa_core::CoreError;
        let refused = |error: MarfaError, said: &str| match error {
            MarfaError::ReadingHandle { message } => {
                assert!(message.contains("/notes"), "{message}");
                assert!(message.contains(said), "{message}");
            }
            other => panic!("{other:?}"),
        };
        refused(
            held("/notes")(CoreError::ReadingHandle),
            "worked by another",
        );
        refused(
            asked("/notes")(CoreError::ReadingHandle),
            "did not let it go within 10 seconds",
        );
        // The witness: any other failure keeps its own kind.
        assert!(matches!(
            asked("/notes")(CoreError::NoServer),
            MarfaError::NoServer { .. }
        ));
        assert!(matches!(
            held("/notes")(CoreError::NoServer),
            MarfaError::NoServer { .. }
        ));
    }

    #[test]
    fn a_url_without_a_key_is_refused() {
        assert!(Folders::new(Some("http://127.0.0.1:9".into()), None, None).is_err());
        assert!(Folders::new(None, None, None).is_ok());
    }

    /// Lists every folder in a registry under a temporary directory, named
    /// once before any folder call reads it.
    #[test]
    fn a_storage_cause_reaches_an_app_with_its_network_type() {
        use marfa_core::StorageCause as C;
        assert_eq!(storage_of(None), None);
        assert_eq!(
            storage_of(Some(C::ICloudDrive)),
            Some(StorageCause::ICloudDrive)
        );
        assert_eq!(
            storage_of(Some(C::CloudService)),
            Some(StorageCause::CloudService)
        );
        assert_eq!(
            storage_of(Some(C::CloudSynced)),
            Some(StorageCause::CloudSynced)
        );
        assert_eq!(
            storage_of(Some(C::NetworkFileSystem("nfs".into()))),
            Some(StorageCause::NetworkFileSystem { kind: "nfs".into() })
        );
    }

    #[test]
    fn a_watch_that_starts_says_why_its_directory_is_in_synced_storage() {
        let watching = |storage| {
            event_of(marfa_core::WatchEvent::Watching {
                dir: "/notes".into(),
                storage,
            })
            .unwrap()
        };
        assert!(matches!(
            watching(Some(marfa_core::StorageCause::ICloudDrive)),
            FolderEvent::Watching {
                storage: Some(StorageCause::ICloudDrive),
                ..
            }
        ));
        assert!(matches!(
            watching(None),
            FolderEvent::Watching { storage: None, .. }
        ));
    }

    fn registry() {
        static NAMED: std::sync::Once = std::sync::Once::new();
        NAMED.call_once(|| {
            let dir = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap())
                .unwrap()
                .keep();
            // SAFETY: under the `Once`, before this test reads the environment.
            unsafe {
                std::env::set_var(marfa_core::folder::REGISTRY_ENV, dir.join("folders.json"))
            };
        });
    }

    struct Panicking {
        ended: std::sync::Mutex<std::sync::mpsc::Sender<Option<MarfaError>>>,
    }

    impl FolderListener for Panicking {
        fn told(&self, _: FolderEvent) {
            panic!("the listener faulted");
        }

        fn ended(&self, error: Option<MarfaError>) {
            let _ = self.ended.lock().unwrap().send(error);
        }
    }

    /// Tells what the watch tells, in order, and when it ends.
    struct Recording {
        told: std::sync::Mutex<std::sync::mpsc::Sender<FolderEvent>>,
        ended: std::sync::Mutex<std::sync::mpsc::Sender<Option<MarfaError>>>,
    }

    impl FolderListener for Recording {
        fn told(&self, event: FolderEvent) {
            let _ = self.told.lock().unwrap().send(event);
        }

        fn ended(&self, error: Option<MarfaError>) {
            let _ = self.ended.lock().unwrap().send(error);
        }
    }

    struct Watched {
        events: std::sync::mpsc::Receiver<FolderEvent>,
        ended: std::sync::mpsc::Receiver<Option<MarfaError>>,
        subscription: Arc<Subscription>,
    }

    impl Watched {
        /// The events after the last one waited for, up to the first that
        /// `wanted` takes. Fails with every event seen if none comes in time.
        fn until(&self, wanted: impl Fn(&FolderEvent) -> bool, within: Duration) -> Vec<String> {
            let bound = Instant::now() + within;
            let mut seen = Vec::new();
            loop {
                let left = bound.saturating_duration_since(Instant::now());
                match self.events.recv_timeout(left) {
                    Ok(event) => {
                        let wanted_now = wanted(&event);
                        seen.push(format!("{event:?}").chars().take(40).collect());
                        if wanted_now {
                            return seen;
                        }
                    }
                    Err(_) => panic!("the event never came; saw {seen:?}"),
                }
            }
        }

        fn stop(self) {
            self.subscription.stop();
            let ended = self
                .ended
                .recv_timeout(Duration::from_secs(30))
                .expect("a stopped watch never said it ended");
            assert!(ended.is_none(), "{ended:?}");
        }
    }

    use std::time::{Duration, Instant};

    /// A folder on the booted server whose first sync is done, and the watch
    /// of it when `watching` is set, told as it begins.
    fn fixture(tag: &str, watching: bool) -> (Arc<Folders>, String, Option<Watched>) {
        let (url, key) = booted();
        fixture_with(
            tag,
            watching,
            Folders::new(Some(url), Some(key), None).unwrap(),
        )
    }

    fn booted() -> (String, String) {
        registry();
        (
            std::env::var("MARFA_TEST_URL").expect("MARFA_TEST_URL names the server"),
            std::env::var("MARFA_TEST_KEY").expect("MARFA_TEST_KEY holds a working key"),
        )
    }

    /// `fixture`, worked through `folders`.
    fn fixture_with(
        tag: &str,
        watching: bool,
        folders: Arc<Folders>,
    ) -> (Arc<Folders>, String, Option<Watched>) {
        let seed = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../scripts/seed.sh");
        let made = std::process::Command::new(seed)
            .args([
                "folder",
                tag,
                &format!(
                    r#"{{"query":{{"types":["core.note"],"filter":"tags contains \"{tag}\""}}}}"#
                ),
            ])
            .output()
            .unwrap();
        assert!(
            made.status.success(),
            "{}",
            String::from_utf8_lossy(&made.stderr)
        );
        let id = String::from_utf8(made.stdout).unwrap().trim().to_string();
        let dir = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap())
            .unwrap()
            .keep();
        let path = dir.display().to_string();
        folders.add(path.clone(), id).unwrap();
        folders.confirm_first_sync(path.clone()).unwrap();
        folders.sync(path.clone()).unwrap();
        let watched = watching.then(|| {
            let (told, events) = std::sync::mpsc::channel();
            let (ended, ended_in) = std::sync::mpsc::channel();
            let subscription = folders
                .watch(
                    path.clone(),
                    Arc::new(Recording {
                        told: std::sync::Mutex::new(told),
                        ended: std::sync::Mutex::new(ended),
                    }),
                )
                .unwrap();
            let watched = Watched {
                events,
                ended: ended_in,
                subscription,
            };
            watched.until(
                |event| matches!(event, FolderEvent::Watching { .. }),
                Duration::from_secs(30),
            );
            watched
        });
        (folders, path, watched)
    }

    #[test]
    #[ignore = "needs a running server: MARFA_TEST_URL and MARFA_TEST_KEY"]
    fn each_call_that_works_a_folder_a_watch_holds_gets_it_and_the_watch_takes_it_back() {
        let (folders, path, watched) = fixture("binding handover calls", true);
        let watched = watched.unwrap();
        type Call = Box<dyn Fn() -> Result<(), MarfaError>>;
        let calls: Vec<(&str, Call)> = vec![
            ("confirm_first_sync", {
                let (folders, path) = (folders.clone(), path.clone());
                Box::new(move || folders.confirm_first_sync(path.clone()).map(drop))
            }),
            ("confirm", {
                let (folders, path) = (folders.clone(), path.clone());
                Box::new(move || folders.confirm(path.clone()).map(drop))
            }),
            ("restore", {
                let (folders, path) = (folders.clone(), path.clone());
                Box::new(move || folders.restore(path.clone()).map(drop))
            }),
            ("sync", {
                let (folders, path) = (folders.clone(), path.clone());
                Box::new(move || folders.sync(path.clone()).map(drop))
            }),
        ];
        for (name, call) in calls {
            let started = Instant::now();
            call().unwrap_or_else(|error| panic!("{name} was refused: {error:?}"));
            assert!(started.elapsed() < Duration::from_secs(10), "{name}");
            let seen = watched.until(
                |event| matches!(event, FolderEvent::TakenBack),
                Duration::from_secs(30),
            );
            assert!(
                seen.iter().any(|event| event.starts_with("HandedOver")),
                "{name} worked the folder and the watch never said it let go: {seen:?}"
            );
        }

        // A second watch does not ask, so it is refused at once.
        let second = std::sync::mpsc::channel();
        let ended = std::sync::mpsc::channel();
        let started = Instant::now();
        let refused = folders.watch(
            path.clone(),
            Arc::new(Recording {
                told: std::sync::Mutex::new(second.0),
                ended: std::sync::Mutex::new(ended.0),
            }),
        );
        assert!(
            matches!(&refused, Err(MarfaError::ReadingHandle { message }) if message.contains("another process")),
            "{:?}",
            refused.err()
        );
        assert!(started.elapsed() < Duration::from_secs(2));

        watched.stop();
        folders
            .sync(path)
            .expect("the stopped watch let the folder go");
    }

    #[test]
    #[ignore = "needs a running server: MARFA_TEST_URL and MARFA_TEST_KEY"]
    fn a_call_is_refused_naming_the_folder_when_its_holder_does_not_let_go_in_ten_seconds() {
        let (folders, path, _) = fixture("binding handover refused", false);
        let holder = marfa_core::Folder::open(&path, None).unwrap();
        type Call = Box<dyn Fn() -> Result<(), MarfaError>>;
        let calls: [(&str, Call); 2] = [
            ("confirm", {
                let (folders, path) = (folders.clone(), path.clone());
                Box::new(move || folders.confirm(path.clone()).map(drop))
            }),
            ("remove", {
                let (folders, path) = (folders.clone(), path.clone());
                Box::new(move || folders.remove(path.clone()))
            }),
        ];
        for (name, call) in calls {
            let started = Instant::now();
            let refused = call();
            let waited = started.elapsed();
            assert!(
                matches!(&refused, Err(MarfaError::ReadingHandle { message })
                    if message.contains(&path) && message.contains("did not let it go within 10 seconds")),
                "{name}: {refused:?}"
            );
            assert!(
                waited >= Duration::from_secs(10) && waited < Duration::from_secs(20),
                "{name} waited {waited:?}"
            );
        }
        // The witness: the same calls, with nothing holding the folder, do not wait.
        drop(holder);
        let started = Instant::now();
        folders.confirm(path.clone()).unwrap();
        assert!(started.elapsed() < Duration::from_secs(5));
        // Refused before anything changed: the folder is still one.
        assert!(folders.status(path).is_ok());
    }

    #[test]
    #[ignore = "needs a running server: MARFA_TEST_URL and MARFA_TEST_KEY"]
    fn a_watch_ends_once_the_call_it_let_the_folder_go_to_removes_the_folder() {
        let (folders, path, watched) = fixture("binding handover removed", true);
        let watched = watched.unwrap();
        folders.remove(path.clone()).unwrap();
        watched.until(
            |event| matches!(event, FolderEvent::Removed),
            Duration::from_secs(30),
        );
        let ended = watched
            .ended
            .recv_timeout(Duration::from_secs(30))
            .expect("the watch of a removed folder never ended");
        assert!(ended.is_none(), "{ended:?}");
        assert!(
            folders.status(path).is_err(),
            "the folder is still a folder"
        );
    }

    #[test]
    #[ignore = "needs a running server: MARFA_TEST_URL and MARFA_TEST_KEY"]
    fn a_folder_another_process_keeps_after_it_was_let_go_is_said_to_be_held_once() {
        let (folders, path, watched) = fixture("binding handover held", true);
        let watched = watched.unwrap();
        // Another process takes the folder in the thread of the call the
        // watch let it go to, as that call ends, so nothing the test thread
        // does can delay it past the watch's next try. A watch that took the
        // folder first, in the moment between, is waited for and the call made
        // again.
        let mut keeper = None;
        for _ in 0..5 {
            let taking = {
                let (folders, path) = (folders.clone(), path.clone());
                std::thread::spawn(move || {
                    folders.confirm(path.clone()).unwrap();
                    let bound = Instant::now() + Duration::from_millis(500);
                    loop {
                        match marfa_core::Folder::open(&path, None) {
                            Ok(keeper) => return Some(keeper),
                            Err(_) if Instant::now() < bound => {
                                std::thread::sleep(Duration::from_millis(1))
                            }
                            Err(_) => return None,
                        }
                    }
                })
            };
            watched.until(
                |event| matches!(event, FolderEvent::HandedOver),
                Duration::from_secs(30),
            );
            let taken = taking.join().unwrap();
            if taken.is_some() {
                keeper = taken;
                break;
            }
            watched.until(
                |event| matches!(event, FolderEvent::TakenBack),
                Duration::from_secs(30),
            );
        }
        let keeper = keeper.expect("the watch took the folder first five times over");
        let seen = watched.until(
            |event| matches!(event, FolderEvent::HeldElsewhere),
            Duration::from_secs(30),
        );
        assert!(!seen.iter().any(|event| event.starts_with("TakenBack")));
        // Said once, however long it is kept.
        std::thread::sleep(Duration::from_secs(3));
        drop(keeper);
        let seen = watched.until(
            |event| matches!(event, FolderEvent::TakenBack),
            Duration::from_secs(30),
        );
        assert!(
            !seen.iter().any(|event| event.starts_with("HeldElsewhere")),
            "said again: {seen:?}"
        );
        watched.stop();
    }

    #[test]
    #[ignore = "needs a running server: MARFA_TEST_URL and MARFA_TEST_KEY"]
    fn a_watch_whose_listener_panics_ends_with_an_error_and_lets_the_folder_go() {
        let (folders, path, _) = fixture("binding watch", false);
        let (sender, ended) = std::sync::mpsc::channel();
        let _watch = folders
            .watch(
                path.clone(),
                Arc::new(Panicking {
                    ended: std::sync::Mutex::new(sender),
                }),
            )
            .unwrap();
        let error = ended
            .recv_timeout(std::time::Duration::from_secs(30))
            .expect("a watch whose listener panicked never said it ended");
        assert!(
            matches!(&error, Some(MarfaError::Invalid { message }) if message.contains("the listener faulted")),
            "{error:?}"
        );
        folders.sync(path).expect("the watch let the folder go");
    }

    /// Answers every renewal with the booted server's key, and records the
    /// token it was handed.
    struct Renewing {
        key: String,
        refused: std::sync::Mutex<Vec<String>>,
    }

    impl crate::CredentialRenewer for Renewing {
        fn renew(&self, refused: String) -> Result<String, crate::RenewalError> {
            self.refused.lock().unwrap().push(refused);
            Ok(self.key.clone())
        }
    }

    #[test]
    #[ignore = "needs a running server: MARFA_TEST_URL and MARFA_TEST_KEY"]
    fn folders_renew_a_refused_token_through_the_app_once() {
        let (url, key) = booted();
        let renewer = Arc::new(Renewing {
            key,
            refused: std::sync::Mutex::default(),
        });
        let folders = Folders::new(
            Some(url),
            Some("marfa_refused_by_the_server".into()),
            Some(renewer.clone()),
        )
        .unwrap();
        let (folders, path, watched) = fixture_with("binding renewal", true, folders);
        watched.unwrap().stop();
        folders.sync(path).unwrap();
        // Each call opened the folder again: the add, the sync, the watch and
        // the last sync, and only the first was refused.
        assert_eq!(
            *renewer.refused.lock().unwrap(),
            vec!["marfa_refused_by_the_server".to_string()]
        );
    }
}
