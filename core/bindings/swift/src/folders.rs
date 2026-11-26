//! Folders on this machine: directories whose files are kept in step with a
//! `system.folder`'s query, through the core the `marfa` binary uses, and
//! listed in the one registry the machine keeps.

use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use crate::guard::guarded;
use crate::renewal::Renewal;
use crate::{CredentialRenewer, DrainReport, HydrateReport, MarfaError, Subscription, drained};

/// A folder as the machine's registry lists it.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ListedFolder {
    /// The directory, resolved as far as it exists.
    pub dir: String,
    /// The id of the `system.folder` whose settings it follows.
    pub folder: String,
    /// Its sync is paused with `Folders.pause`.
    pub paused: bool,
    /// The opaque ID this directory's copy reports under, the
    /// `folder_store_id` the server returns for it in a folder's status. It
    /// is not a path and names no machine. `nil` where the registry entry
    /// holds none.
    pub store: Option<String>,
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
    /// Git tracks the directory: it is in a git work tree whose index holds a
    /// file in it. Checking out, resetting or switching branches then changes
    /// the files, and the folder syncs those changes. `false` where git cannot
    /// be run or errors. The folder is added all the same.
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

fn listed_of(entry: marfa_core::folder::Registered) -> ListedFolder {
    ListedFolder {
        paused: marfa_core::Folder::paused_at(&entry.dir),
        dir: entry.dir.display().to_string(),
        folder: entry.folder,
        store: entry.store,
    }
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

/// A large removal, or a large drop of new files, waiting for `confirm`; a
/// removal can also be cancelled by `restore`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Record)]
pub struct FolderPaused {
    /// Files gone from the disk whose deletes are not sent.
    pub disk: u64,
    /// Files left in place whose items left the query elsewhere.
    pub pull: u64,
    /// New files held back for being more than the folder's addition
    /// threshold lets in at once. `confirm` sends them.
    pub additions: u64,
    /// New files held because the query would not hold them and the folder's
    /// `outside_query` is `hold`.
    pub outside_query: u64,
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
    pub paused: FolderPaused,
    /// Set while the folder's first sync waits to be confirmed.
    pub first_sync: Option<WaitingFirstSync>,
    /// The directory's sync is paused with `Folders.pause`.
    pub sync_paused: bool,
    /// How many directories a watch last found it could not watch, from the
    /// folder's last health report.
    pub unwatched: u64,
}

/// A file a pass held or warned about, with why.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct FlaggedFile {
    pub path: String,
    pub flag: String,
    pub reason: String,
    /// The item this flag refers to, when known.
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
    /// New files a large drop holds back, so they are not sent.
    pub paused_additions: u64,
    /// New files held on the disk because the query would not hold them.
    pub held_outside: u64,
    /// Files found in no folder on this machine, whose items were trashed.
    pub trashed: Vec<String>,
    /// Files not taken because their names are ones secrets go by.
    pub secrets: Vec<String>,
    pub warnings: Vec<FlaggedFile>,
    /// Why the scan read nothing, where the folder's directory is gone.
    pub root_gone: Option<String>,
    /// Why links by name wait though the server answered, where they do: it
    /// refused a title lookup as a whole, or has none. Said once for the
    /// folder, not for each file.
    pub lookup_refused: Option<String>,
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
    /// Files left because a program holds them open for writing, which a later
    /// pull writes or removes once it closes them.
    pub busy: u64,
    /// Items whose bytes could not be fetched.
    pub absent: u64,
    /// Placements the server refused.
    pub unplaced: u64,
    /// Files left in place whose items the query does not match.
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

/// What letting a folder's paused removal and paused new files go did.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ConfirmedFolder {
    /// Deletes queued, sent at the next sync.
    pub deleted: u64,
    /// Files found in another folder on this machine, whose items stay.
    pub moved: u64,
    /// Files taken away whose items left elsewhere.
    pub removed: u64,
    /// New files held back by the addition threshold that the confirmation
    /// let go, queued as items.
    pub added: u64,
    /// Files not let go, because the other folders could not all be read.
    pub unsure: Vec<UnsureFile>,
    /// Paused files the volume could not take away safely, which stay
    /// paused.
    pub refused: Vec<UnsureFile>,
}

/// What `Folders.remove` did.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct FolderRemoval {
    /// The directory, resolved as far as it exists.
    pub dir: String,
    /// The folder's state went; where false, only its registry entry did.
    pub removed: bool,
    /// Why nothing was deleted, where `removed` is false.
    pub reason: Option<String>,
    /// The id of the `system.folder` it followed, where its state went: what
    /// `Folders.add` takes to follow that folder again.
    pub folder: Option<String>,
    /// Writes that waited unsent, because another Marfa instance answers at
    /// the folder's server.
    pub unsent: u64,
    /// The files that hold changes the folder could not send.
    pub files: Vec<UnsentFile>,
}

/// How a file differs from what the folder's server last received.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum UnsentChange {
    /// Its changes stay in the file.
    Changed,
    /// A file the server never received; it stays in the directory.
    New,
    /// Moved from `from`, which no file records.
    Moved,
    /// Gone from the directory, which no file records.
    Deleted,
}

/// A file whose change the folder's server never received.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct UnsentFile {
    pub change: UnsentChange,
    /// Its path in the directory; `None` for a deleted file whose path the
    /// copy holds no record of.
    pub path: Option<String>,
    /// Where a moved file was before it moved.
    pub from: Option<String>,
    /// Its item, where it has one.
    pub item: Option<String>,
}

impl From<marfa_core::Removal> for FolderRemoval {
    fn from(removal: marfa_core::Removal) -> Self {
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
                unsent: unsent.writes as u64,
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
}

/// A missing file whose deletion is held, because Marfa cannot tell whether
/// it was deleted or moved into another folder.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct HeldFile {
    pub path: String,
    pub item: String,
    /// When this folder first found it missing.
    pub missing_since: String,
    pub reason: String,
}

/// What settling held files did.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct SettledHeld {
    /// Files whose items' deletes are queued, sent at the next sync.
    pub trashed: Vec<String>,
    /// Files whose items were already in the bin or gone.
    pub gone: Vec<String>,
    /// Files one other readable folder now holds, whose items stay.
    pub moved: Vec<String>,
    /// Files whose items stay, and which the folder lets go.
    pub kept: Vec<String>,
    /// Kept files written again.
    pub written_back: Vec<String>,
    /// Kept files not written again, each with why.
    pub not_written_back: Vec<FlaggedFile>,
    /// Named files left as they were, each with why.
    pub not_settled: Vec<UnsureFile>,
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
    /// The directory's sync was paused with `Folders.pause`, and the watch
    /// let the folder go and waits, holding nothing, for `Folders.resume`. Told
    /// once for each pause; the watch takes the folder back once it ends.
    Paused,
    /// The watch took the folder back and keeps it in step again. It follows
    /// `HandedOver`, `HeldElsewhere` or `Paused`, and stands in for a second
    /// `Watching`.
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

guarded! {
    #[uniffi::export]
    impl Folders {
        /// Supply both `url` and `key` for calls that contact the server.
        /// Listing, removing unmatched files and discarding kept files work offline.
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
        /// in cloud-synced or network storage, where it is, and whether git
        /// tracks it; the folder is added all the same. Reads the file system,
        /// so it can wait on a mount that does not answer. Over a folder a watch
        /// holds, asks the watch to let it go and waits up to 10 seconds, as
        /// every call that works a folder does: past that, it is refused with
        /// `ReadingHandle`, naming the folder.
        pub fn add(&self, dir: String, folder: String) -> Result<AddedFolder, MarfaError> {
            let added = marfa_core::Folder::add(&dir, &folder, self.server(), self.renew())
                .map_err(asked(&dir))?;
            Ok(added_of(&added))
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
                .map(listed_of)
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
                paused: FolderPaused {
                    disk: report.paused.disk as u64,
                    pull: report.paused.pull as u64,
                    additions: report.paused.additions as u64,
                    outside_query: report.paused.outside_query as u64,
                },
                first_sync: report.first_sync.map(|waiting| WaitingFirstSync {
                    plan: waiting.plan.map(Into::into),
                }),
                sync_paused: report.sync_paused,
                unwatched: report.unwatched,
            })
        }

        /// Pauses the directory's sync until `resume`: a watch skips it, and
        /// `sync`, `confirm`, `restore` and the other calls that read the
        /// server's side or write either side are refused with `SyncPaused`.
        /// Answers whether it was running. Asks a watch that holds the folder
        /// to let it go, as `add` does.
        pub fn pause(&self, dir: String) -> Result<bool, MarfaError> {
            Ok(working(&dir, self.server(), self.renewal.as_ref())?.pause_sync()?)
        }

        /// Lets a paused directory's sync go on. Answers whether it was
        /// paused. Asks a watch that holds the folder to let it go, as `add`
        /// does.
        pub fn resume(&self, dir: String) -> Result<bool, MarfaError> {
            Ok(working(&dir, self.server(), self.renewal.as_ref())?.resume_sync()?)
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
        pub fn confirm(&self, dir: String) -> Result<ConfirmedFolder, MarfaError> {
            let confirmed = working(&dir, None, None)?.confirm()?;
            Ok(ConfirmedFolder {
                deleted: confirmed.deleted as u64,
                moved: confirmed.moved as u64,
                removed: confirmed.removed as u64,
                added: confirmed.added as u64,
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

        /// The folder's held files, in path order. Asks no watch for the folder.
        pub fn held(&self, dir: String) -> Result<Vec<HeldFile>, MarfaError> {
            Ok(marfa_core::Folder::held_of(&dir)?
                .into_iter()
                .map(|file| HeldFile {
                    path: file.path,
                    item: file.item,
                    missing_since: file.missing_since,
                    reason: file.reason,
                })
                .collect())
        }

        /// Sends the delete of each named held file's item, checked against
        /// the item's version. Show the person each file before calling. Asks
        /// a watch that holds the folder to let it go, as `add` does.
        pub fn trash_held(
            &self,
            dir: String,
            paths: Vec<String>,
        ) -> Result<SettledHeld, MarfaError> {
            let folder = working(&dir, None, None)?;
            Ok(settled_held(folder.settle_held(&paths, marfa_core::Settle::Trash)?))
        }

        /// Keeps each named held file's item and lets the folder's file of it
        /// go. With `write_back`, writes the file again where the folder's
        /// query holds the item, never over a file now at its path. Asks a
        /// watch that holds the folder to let it go, as `add` does.
        pub fn keep_held(
            &self,
            dir: String,
            paths: Vec<String>,
            write_back: bool,
        ) -> Result<SettledHeld, MarfaError> {
            let folder = working(&dir, self.server(), self.renewal.as_ref())?;
            Ok(settled_held(
                folder.settle_held(&paths, marfa_core::Settle::Keep { write_back })?,
            ))
        }

        /// Takes the folder off this machine: its state under `.marfa` goes and
        /// its files stay. Refused while writes wait, except for a first sync
        /// still waiting to be confirmed, which this cancels, and except where
        /// another Marfa instance answers at the folder's server, which none of
        /// them can reach; the answer then names each file holding a change the
        /// folder could not send. Follows no symbolic
        /// link, and takes a path through one only where it is the path the
        /// registry lists. Where that path is
        /// gone, passes through a link, or holds state the registry does not
        /// show to be the folder's own, the folder is only taken off the
        /// registry. Asks a watch that holds the folder to let it go, as `add`
        /// does; that watch then ends with `Removed` or `Unlisted`.
        pub fn remove(&self, dir: String) -> Result<FolderRemoval, MarfaError> {
            marfa_core::Folder::remove_at_asking(&dir)
                .map(FolderRemoval::from)
                .map_err(asked(&dir))
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
                    Err(fault) => Some(MarfaError::Fault {
                        message: format!("the watch stopped on a fault: {}", said(fault.as_ref())),
                    }),
                });
            });
            Ok(Subscription::raising(stop))
        }
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
                    listener.told(FolderEvent::TakenBack);
                    return Ok(());
                }
                listener.told(event_of(event)?);
                Ok::<(), MarfaError>(())
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
            listener.told(FolderEvent::Paused);
            if !marfa_core::Folder::wait_resumed(&root, stop) {
                return Ok(());
            }
        } else {
            listener.told(FolderEvent::HandedOver);
        }
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
            server: said.answer().map(crate::ServerAnswer::from),
            code: "credential_refused".into(),
            message: marfa_core::folder::credential_refused_said(
                origin.unwrap_or("this folder's server"),
                &said,
            ),
        },
        W::FollowEnded(error) | W::Core(error) => error.into(),
        W::InstanceChanged { .. } => {
            marfa_core::CoreError::expired(marfa_core::http::INSTANCE_CHANGED).into()
        }
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
        W::Retrying { error, wait } | W::QueryWaits { error, wait } => FolderEvent::Retrying {
            error: error.into(),
            wait_ms: u64::try_from(wait.as_millis()).unwrap_or(u64::MAX),
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
        paused_additions: scan.paused_additions as u64,
        held_outside: scan.held_outside as u64,
        trashed: scan.trashed,
        secrets: scan.secrets,
        warnings: scan.warnings.into_iter().map(flagged_file).collect(),
        root_gone: scan.root_gone,
        lookup_refused: scan.lookup_refused,
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
        busy: pull.busy as u64,
        absent: pull.absent as u64,
        unplaced: pull.unplaced as u64,
        unmatched: pull.unmatched as u64,
        paused: pull.paused as u64,
        root_gone: pull.root_gone,
    }
}

fn settled_held(settled: marfa_core::Settled) -> SettledHeld {
    SettledHeld {
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

/// An unmatched file `remove_unmatched` took away. Its item is unchanged.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct UnmatchedFile {
    pub path: String,
    pub item_id: Option<String>,
}

/// A path `remove_unmatched` was given and left in place.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct KeptUnmatched {
    pub path: String,
    /// The file's item, where the path is a file of the folder.
    pub item_id: Option<String>,
    /// Why it was kept, as a clause that follows "is kept:".
    pub reason: String,
    /// Whether no file is at the path of a removal Marfa stopped on, but
    /// Marfa cannot prove the file is gone. Pass `forget_unproved` once the
    /// person confirms Marfa may stop tracking the path.
    pub unproved: bool,
}

/// What `remove_unmatched` did.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct UnmatchedRemoved {
    pub removed: Vec<UnmatchedFile>,
    pub kept: Vec<KeptUnmatched>,
    /// The folder's placements of the removed files' items, ended and queued
    /// to be sent at the next sync.
    pub ended: u64,
    /// Removals Marfa stopped on that it ended, because it showed each file
    /// gone or, with `forget_unproved`, because the person confirmed Marfa
    /// may stop tracking a path whose file it cannot prove gone. No file was
    /// deleted for them, and their items are unchanged.
    pub settled: Vec<UnmatchedFile>,
}

/// What Marfa last found of the programs writing to a kept file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum KeptWriters {
    /// A program holds it open for writing.
    Open,
    /// Marfa cannot tell. When set, `until` gives its discard date.
    Unknown,
    /// Marfa has not looked since it set the file aside.
    NotLooked,
}

/// A file a pull set aside under a `.marfa-kept-` name because a program
/// might still write to it.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct KeptFile {
    /// Its path in the directory, under the reserved name.
    pub path: String,
    /// The path Marfa replaced or removed it at.
    pub from: String,
    pub writers: KeptWriters,
    /// The UTC discard date for an unchanged file, when set, as `YYYY-MM-DD`.
    pub until: Option<String>,
    pub reason: String,
    /// Whether this is a record of a discard Marfa stopped on whose file is
    /// not at its path, and Marfa cannot prove the file gone. Pass
    /// `forget_unproved` once the person confirms Marfa may stop tracking it.
    pub unproved: bool,
}

/// What `discard_kept` did.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct KeptDiscarded {
    /// The kept files deleted, each unchanged since Marfa set it aside.
    pub discarded: Vec<String>,
    /// The paths a kept file a program wrote to went back to, or was kept
    /// beside, in place of being deleted. The next sync sends it.
    pub put_back: Vec<String>,
    /// The files whose records remain after the discard.
    pub kept: Vec<KeptFile>,
    /// Records of a stopped discard Marfa stopped tracking with
    /// `forget_unproved`, because no file is at their paths and Marfa cannot
    /// prove the file gone. No file was deleted for them.
    pub forgotten: Vec<String>,
}

guarded! {
    #[uniffi::export]
    impl Folders {
        /// Takes away the named unmatched files, as `folders unmatched
        /// --remove` does once the person agrees, and never the items: the
        /// folder's placement of each ends, sent at the next sync. A file is
        /// kept, with why, where its bytes differ from what the folder wrote,
        /// an edit of it waits or was held, it is not unmatched, or the path
        /// is not plainly a file inside the folder; a path named twice is
        /// taken once. Needs no server. Refused while the first sync waits
        /// and while the directory is paused. Asks a watch that holds the
        /// folder to let it go, as `add` does. With `forget_unproved`, set
        /// only once the person confirms, it also stops tracking each named
        /// path of a removal Marfa stopped on whose file it cannot prove
        /// gone, deleting no file and keeping the item.
        pub fn remove_unmatched(
            &self,
            dir: String,
            paths: Vec<String>,
            forget_unproved: bool,
        ) -> Result<UnmatchedRemoved, MarfaError> {
            let done = working(&dir, None, None)?.remove_unmatched(&paths, forget_unproved)?;
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
                        unproved: file.unproved,
                    })
                    .collect(),
                ended: done.ended as u64,
                settled: done
                    .settled
                    .into_iter()
                    .map(|file| UnmatchedFile {
                        path: file.path,
                        item_id: file.item_id,
                    })
                    .collect(),
            })
        }

        /// Lists kept-file records in path order, even while a watch holds the folder.
        pub fn kept(&self, dir: String) -> Result<Vec<KeptFile>, MarfaError> {
            marfa_core::Folder::kept_of(&dir)?
                .into_iter()
                .map(kept_file)
                .collect()
        }

        /// Deletes each kept file that is unchanged since Marfa set it
        /// aside, whatever programs hold it, as `folders kept --discard`
        /// does once the person agrees. One a program wrote to goes back to
        /// its path instead. Needs no server. Asks a watch that holds the
        /// folder to let it go, as `add` does. With `forget_unproved`, set
        /// only once the person confirms, it also forgets each record of a
        /// discard Marfa stopped on whose file it cannot prove gone, deleting
        /// no file.
        pub fn discard_kept(
            &self,
            dir: String,
            forget_unproved: bool,
        ) -> Result<KeptDiscarded, MarfaError> {
            let done = working(&dir, None, None)?.discard_kept(forget_unproved)?;
            Ok(KeptDiscarded {
                discarded: done.discarded,
                put_back: done.put_back,
                forgotten: done.forgotten,
                kept: done
                    .kept
                    .into_iter()
                    .map(kept_file)
                    .collect::<Result<_, _>>()?,
            })
        }
    }
}

fn kept_file(file: marfa_core::KeptFile) -> Result<KeptFile, MarfaError> {
    Ok(KeptFile {
        writers: match file.writers {
            "open" => KeptWriters::Open,
            "unknown" => KeptWriters::Unknown,
            "none" => KeptWriters::NotLooked,
            other => {
                return Err(MarfaError::Decoding {
                    message: format!("a kept file names writers this build does not know: {other}"),
                });
            }
        },
        path: file.path,
        from: file.from,
        until: file.until,
        reason: file.reason,
        unproved: file.unproved,
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

    /// The folder `tag` names on the booted server, which follows notes
    /// tagged `tag`.
    fn seeded_folder(tag: &str) -> String {
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
        String::from_utf8(made.stdout).unwrap().trim().to_string()
    }

    fn scratch_directory() -> tempfile::TempDir {
        tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap()
    }

    /// The `folder_store_id` of each copy the server holds a report from for
    /// `folder`.
    fn reported_copies(folder: &str) -> Vec<String> {
        let seed = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../scripts/seed.sh");
        let asked = std::process::Command::new(seed)
            .args(["folder-status", folder])
            .output()
            .unwrap();
        assert!(
            asked.status.success(),
            "{}",
            String::from_utf8_lossy(&asked.stderr)
        );
        let report: serde_json::Value = serde_json::from_slice(&asked.stdout).unwrap();
        let mut copies: Vec<String> = report["sign_ins"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|sign_in| sign_in["copies"].as_array().unwrap())
            .map(|copy| copy["folder_store_id"].as_str().unwrap().to_string())
            .collect();
        copies.sort();
        copies
    }

    /// The id the directory's own store keeps for its copy, which every health
    /// report of it carries.
    fn stored_copy_id(dir: &str) -> String {
        rusqlite::Connection::open_with_flags(
            std::path::Path::new(dir)
                .join(marfa_core::folder::STATE_DIR)
                .join("core.sqlite"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap()
        .query_row(
            "SELECT value FROM meta WHERE key = 'folder_store'",
            [],
            |row| row.get(0),
        )
        .unwrap()
    }

    #[test]
    #[ignore = "needs a running server: MARFA_TEST_URL and MARFA_TEST_KEY"]
    fn two_directories_following_one_folder_list_the_ids_their_copies_report() {
        let (url, key) = booted();
        let folders = Folders::new(Some(url), Some(key), None).unwrap();
        let folder = seeded_folder("binding listed stores");
        let (first, second) = (scratch_directory(), scratch_directory());
        let mut dirs = Vec::new();
        for directory in [&first, &second] {
            let path = directory.path().display().to_string();
            let added = folders.add(path.clone(), folder.clone()).unwrap();
            folders.confirm_first_sync(path.clone()).unwrap();
            folders.sync(path).unwrap();
            dirs.push(added.dir);
        }
        let listed = folders.list().unwrap();
        let store_of = |dir: &str| {
            listed
                .iter()
                .find(|entry| entry.dir == dir)
                .unwrap_or_else(|| panic!("{dir} is not listed in {listed:?}"))
                .store
                .clone()
                .expect("a directory that has reported lists its store")
        };
        let (first_store, second_store) = (store_of(&dirs[0]), store_of(&dirs[1]));
        assert_ne!(first_store, second_store);
        assert_eq!(first_store, stored_copy_id(&dirs[0]));
        assert_eq!(second_store, stored_copy_id(&dirs[1]));
        let mut both = vec![first_store, second_store];
        both.sort();
        assert_eq!(reported_copies(&folder), both);
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
        let (url, key) = booted();
        let folders = Folders::new(Some(url), Some(key), None).unwrap();
        let folder = seeded_folder("binding git tracked");
        let work_tree = tracked_directory();
        let tracked = folders
            .add(
                work_tree.path().join("notes").display().to_string(),
                folder.clone(),
            )
            .unwrap();
        assert!(tracked.git_tracked);
        // The witness: the same call for a directory outside any work tree.
        let outside = scratch_directory();
        let untracked = folders
            .add(outside.path().display().to_string(), folder)
            .unwrap();
        assert!(!untracked.git_tracked);
        let listed = folders.list().unwrap();
        for added in [&tracked, &untracked] {
            assert!(listed.iter().any(|entry| entry.dir == added.dir));
        }
    }

    #[test]
    #[ignore = "needs a running server: MARFA_TEST_URL and MARFA_TEST_KEY"]
    fn a_folder_is_added_untracked_where_git_cannot_be_run() {
        let (url, key) = booted();
        let folders = Folders::new(Some(url), Some(key), None).unwrap();
        let folder = seeded_folder("binding git missing");
        let work_tree = tracked_directory();
        let notes = work_tree.path().join("notes").display().to_string();
        // The witness: with git on the path, this directory is tracked.
        assert!(
            folders
                .add(notes.clone(), folder.clone())
                .unwrap()
                .git_tracked
        );
        let no_programs = scratch_directory();
        // SAFETY: nextest runs each test in a process of its own, and nothing
        // else in this one reads the environment while it is set.
        unsafe { std::env::set_var("PATH", no_programs.path()) };
        let added = folders.add(notes, folder).unwrap();
        assert!(!added.git_tracked);
        assert!(
            folders
                .list()
                .unwrap()
                .iter()
                .any(|entry| entry.dir == added.dir)
        );
    }

    #[test]
    #[ignore = "needs a running server: MARFA_TEST_URL and MARFA_TEST_KEY"]
    fn a_folder_is_added_untracked_where_git_does_not_answer() {
        use std::os::unix::fs::PermissionsExt;
        let (url, key) = booted();
        let folders = Folders::new(Some(url), Some(key), None).unwrap();
        let folder = seeded_folder("binding git stalls");
        let directory = scratch_directory();
        let (bin, pids) = (scratch_directory(), scratch_directory());
        let program = bin.path().join("git");
        std::fs::write(
            &program,
            format!(
                "#!/bin/sh\necho $$ > {pids}/git\nexec /bin/sleep 30\n",
                pids = pids.path().display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
        // SAFETY: nextest runs each test in a process of its own, and nothing
        // else in this one reads the environment while it is set.
        unsafe { std::env::set_var("PATH", bin.path()) };
        let started = std::time::Instant::now();
        let added = folders
            .add(directory.path().display().to_string(), folder)
            .unwrap();
        assert!(started.elapsed() < std::time::Duration::from_secs(10));
        assert!(!added.git_tracked);
        assert!(
            folders
                .list()
                .unwrap()
                .iter()
                .any(|entry| entry.dir == added.dir)
        );
        // No git is left running.
        let pid: i32 = std::fs::read_to_string(pids.path().join("git"))
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        let alive = |pid: i32| {
            std::process::Command::new("/bin/kill")
                .args(["-0", &pid.to_string()])
                .stderr(std::process::Stdio::null())
                .status()
                .unwrap()
                .success()
        };
        for _ in 0..200 {
            if !alive(pid) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(!alive(pid));
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
            ("remove_unmatched", {
                let (folders, path) = (folders.clone(), path.clone());
                Box::new(move || {
                    folders
                        .remove_unmatched(path.clone(), vec!["none.md".into()], false)
                        .map(drop)
                })
            }),
            ("discard_kept", {
                let (folders, path) = (folders.clone(), path.clone());
                Box::new(move || folders.discard_kept(path.clone(), false).map(drop))
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
                Box::new(move || folders.remove(path.clone()).map(drop))
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
            matches!(&error, Some(MarfaError::Fault { message }) if message.contains("the listener faulted")),
            "{error:?}"
        );
        folders.sync(path).expect("the watch let the folder go");
    }

    #[test]
    fn a_kept_file_crosses_with_every_field() {
        let crossed = |writers, until: Option<&str>| {
            kept_file(marfa_core::KeptFile {
                path: "Notes/.marfa-kept-1.tmp".into(),
                from: "Notes/Plan.md".into(),
                writers,
                until: until.map(str::to_string),
                reason: "set aside".into(),
                unproved: true,
            })
        };
        assert_eq!(
            crossed("unknown", Some("2026-12-02")).unwrap(),
            KeptFile {
                path: "Notes/.marfa-kept-1.tmp".into(),
                from: "Notes/Plan.md".into(),
                writers: KeptWriters::Unknown,
                until: Some("2026-12-02".into()),
                reason: "set aside".into(),
                unproved: true,
            }
        );
        assert_eq!(crossed("open", None).unwrap().writers, KeptWriters::Open);
        assert_eq!(
            crossed("none", None).unwrap().writers,
            KeptWriters::NotLooked
        );
        assert!(matches!(
            crossed("several", None),
            Err(MarfaError::Decoding { .. })
        ));
    }

    #[test]
    fn a_directory_that_is_no_folder_is_refused_and_left_as_it_is() {
        registry();
        let folders = Folders::new(None, None, None).unwrap();
        let dir = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        std::fs::write(dir.path().join("note.md"), "mine\n").unwrap();
        let path = dir.path().display().to_string();
        assert!(
            folders
                .remove_unmatched(path.clone(), vec!["note.md".into()], false)
                .is_err()
        );
        assert!(folders.kept(path.clone()).is_err());
        assert!(folders.discard_kept(path, false).is_err());
        let left: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(left, ["note.md"]);
        assert_eq!(
            std::fs::read_to_string(dir.path().join("note.md")).unwrap(),
            "mine\n"
        );
    }

    fn seeded_note(title: &str, tag: &str) -> String {
        let seed = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../scripts/seed.sh");
        let made = std::process::Command::new(seed)
            .args(["note", title, "as the server wrote it", tag])
            .output()
            .unwrap();
        assert!(
            made.status.success(),
            "{}",
            String::from_utf8_lossy(&made.stderr)
        );
        String::from_utf8(made.stdout).unwrap().trim().to_string()
    }

    fn file_of(folders: &Folders, dir: &str, id: &str) -> FileStatus {
        folders
            .status(dir.into())
            .unwrap()
            .files
            .into_iter()
            .find(|file| file.item_id.as_deref() == Some(id))
            .unwrap_or_else(|| panic!("no file holds {id}"))
    }

    /// Asserts `call` waits out the handover and is refused naming `dir`.
    fn refused_while_held(dir: &str, call: impl FnOnce() -> Result<(), MarfaError>) {
        let started = Instant::now();
        let refused = call();
        let waited = started.elapsed();
        assert!(
            matches!(&refused, Err(MarfaError::ReadingHandle { message })
                if message.contains(dir) && message.contains("did not let it go within 10 seconds")),
            "{refused:?}"
        );
        assert!(
            waited >= Duration::from_secs(10) && waited < Duration::from_secs(20),
            "waited {waited:?}"
        );
    }

    #[test]
    #[ignore = "needs a running server: MARFA_TEST_URL and MARFA_TEST_KEY"]
    fn an_app_removes_an_unmatched_file_offline_keeps_the_rest_and_no_item_goes() {
        let tag = "binding unmatched";
        let (folders, path, _) = fixture(tag, false);
        let removable = seeded_note("Removable", tag);
        let edited = seeded_note("Edited", tag);
        let matched = seeded_note("Matched", tag);
        folders.sync(path.clone()).unwrap();
        {
            let (url, key) = booted();
            let folder =
                marfa_core::Folder::open(&path, Some(marfa_core::Server { url, key })).unwrap();
            for id in [&removable, &edited] {
                folder.core().remove_tag(id, tag).unwrap();
            }
        }
        for _ in 0..3 {
            folders.sync(path.clone()).unwrap();
            if [&removable, &edited]
                .iter()
                .all(|id| file_of(&folders, &path, id).state == FileState::Unmatched)
            {
                break;
            }
        }
        let removable_at = file_of(&folders, &path, &removable);
        assert_eq!(removable_at.state, FileState::Unmatched, "{removable_at:?}");
        let edited_at = file_of(&folders, &path, &edited).path;
        let matched_at = file_of(&folders, &path, &matched).path;
        let root = std::path::Path::new(&path);
        std::fs::OpenOptions::new()
            .append(true)
            .open(root.join(&edited_at))
            .and_then(|mut file| std::io::Write::write_all(&mut file, b"by hand\n"))
            .unwrap();
        let named = vec![
            removable_at.path.clone(),
            removable_at.path.clone(),
            edited_at.clone(),
            matched_at.clone(),
            "../elsewhere.md".into(),
        ];

        let holder = marfa_core::Folder::open(&path, None).unwrap();
        refused_while_held(&path, || {
            folders
                .remove_unmatched(path.clone(), named.clone(), false)
                .map(drop)
        });
        drop(holder);
        assert!(
            root.join(&removable_at.path).is_file(),
            "refused, yet removed"
        );

        let (_, key) = booted();
        let offline = Folders::new(Some("http://127.0.0.1:9".into()), Some(key), None).unwrap();
        let done = offline
            .remove_unmatched(path.clone(), named, false)
            .unwrap();

        assert_eq!(
            done.removed,
            [UnmatchedFile {
                path: removable_at.path.clone(),
                item_id: Some(removable.clone()),
            }]
        );
        assert_eq!(done.ended, 1);
        let kept: Vec<(&str, &str)> = done
            .kept
            .iter()
            .map(|file| (file.path.as_str(), file.reason.as_str()))
            .collect();
        assert_eq!(
            kept,
            [
                (
                    edited_at.as_str(),
                    "its bytes differ from what the folder wrote"
                ),
                (matched_at.as_str(), "it is not unmatched any more"),
                ("../elsewhere.md", "it is not inside the folder"),
            ]
        );
        assert!(!root.join(&removable_at.path).exists());
        assert!(root.join(&edited_at).is_file());
        assert!(root.join(&matched_at).is_file());

        // The placement's end goes at the next sync, and the item stays.
        folders.sync(path.clone()).unwrap();
        let (url, key) = booted();
        let copy = tempfile::tempdir().unwrap();
        let core = crate::Core::open(
            copy.path().join("copy.db").display().to_string(),
            Some(url),
            Some(key),
            None,
        )
        .unwrap();
        core.hydrate(vec!["core.note".into()], crate::SliceTier::All, None)
            .unwrap();
        let item = core.get(removable.clone()).unwrap();
        assert!(
            item.is_some_and(|item| item.state == crate::ItemState::Active),
            "the removed file's item went"
        );
    }

    #[cfg(debug_assertions)]
    #[test]
    #[ignore = "needs a running server: MARFA_TEST_URL and MARFA_TEST_KEY"]
    fn an_app_lists_kept_files_then_discards_them_and_puts_back_one_a_program_wrote() {
        let tag = "binding kept";
        let (folders, path, _) = fixture(tag, false);
        let ids = [seeded_note("Plan", tag), seeded_note("Draft", tag)];
        folders.sync(path.clone()).unwrap();
        let froms: Vec<String> = ids
            .iter()
            .map(|id| file_of(&folders, &path, id).path)
            .collect();
        {
            let folder = marfa_core::Folder::open(&path, None).unwrap();
            for id in &ids {
                let mut properties = serde_json::Map::new();
                properties.insert("body".into(), "changed elsewhere".into());
                let version = folder.core().get(id).unwrap().unwrap().version;
                folder
                    .core()
                    .update_item(
                        id,
                        &marfa_core::Edit {
                            properties,
                            base_version: Some(version),
                            ..Default::default()
                        },
                    )
                    .unwrap();
            }
        }
        {
            let _unknown = marfa_core::fault::fail_on_this_thread("writers-unknown");
            folders.sync(path.clone()).unwrap();
            folders.sync(path.clone()).unwrap();
        }

        let mut kept = folders.kept(path.clone()).unwrap();
        kept.sort_by(|a, b| a.from.cmp(&b.from));
        let mut expected = froms.clone();
        expected.sort();
        assert_eq!(
            kept.iter()
                .map(|file| file.from.clone())
                .collect::<Vec<_>>(),
            expected,
            "{kept:?}"
        );
        for file in &kept {
            assert!(file.path.contains(".marfa-kept-"), "{file:?}");
            assert_eq!(file.writers, KeptWriters::Unknown, "{file:?}");
            assert!(file.until.is_some() && !file.reason.is_empty(), "{file:?}");
        }
        let root = std::path::Path::new(&path);
        let (written, unchanged) = (&kept[0], &kept[1]);
        std::fs::OpenOptions::new()
            .append(true)
            .open(root.join(&written.path))
            .and_then(|mut file| std::io::Write::write_all(&mut file, b"what the program wrote\n"))
            .unwrap();

        let holder = marfa_core::Folder::open(&path, None).unwrap();
        refused_while_held(&path, || {
            folders.discard_kept(path.clone(), false).map(drop)
        });
        drop(holder);
        assert_eq!(
            folders.kept(path.clone()).unwrap().len(),
            2,
            "refused, yet discarded"
        );

        let (_, key) = booted();
        let offline = Folders::new(Some("http://127.0.0.1:9".into()), Some(key), None).unwrap();
        let done = offline.discard_kept(path.clone(), false).unwrap();

        assert_eq!(
            done.discarded,
            std::slice::from_ref(&unchanged.path),
            "{done:?}"
        );
        assert_eq!(
            done.put_back,
            std::slice::from_ref(&written.from),
            "{done:?}"
        );
        assert!(done.kept.is_empty(), "{done:?}");
        assert!(folders.kept(path.clone()).unwrap().is_empty());
        assert!(!root.join(&unchanged.path).exists());
        assert!(
            std::fs::read_to_string(root.join(&written.from))
                .unwrap()
                .contains("what the program wrote")
        );
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
