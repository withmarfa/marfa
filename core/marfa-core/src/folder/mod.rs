pub mod document;
pub mod edge_types;
mod elsewhere;
mod embeds;
mod every;
mod executable;
pub mod fields;
mod first;
mod handover;
pub mod identity;
mod landing;
mod lines;
pub mod lists;
mod made;
mod names;
pub(crate) mod placement;
mod preserve;
mod pull;
mod push;
mod refused;
mod removal;
mod scan;
mod unmatched;
pub(crate) use first::waiting;
pub use first::{FirstSync, Synced};
pub use pull::{PullReport, copy_changed};
pub use removal::{Confirmed, Restored};
mod health;
pub mod registry;
pub mod settings;
pub(crate) mod settings_file;
mod status;
mod storage;
mod sync;
mod taking_back;
mod transfer;
mod watch;
mod watch_record;
pub use every::{Every, EveryFolder, HANDED_OVER, MISSING, RETRY_HANDED, Unwatched, watch_every};
pub use handover::{HANDOVER_WAIT, held_by_another, not_handed_over};
pub use status::{FileStatus, FirstSyncStatus, Paused, StatusReport};
pub use storage::StorageCause;
#[cfg(unix)]
pub use storage::user_home;
pub use sync::{Removal, SendReport, SyncReport};
pub use taking_back::TakeBack;
pub use unmatched::{Unmatched, UnmatchedRemoved};
pub use watch::{RETRY_MOST, WatchEnd, WatchError, WatchEvent, WatchPass};
pub use watch_record::WatchRecord;
pub mod state;

use std::cell::{OnceCell, RefCell};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::ops::ControlFlow;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::Duration;

use serde::Serialize;
use serde_json::{Map, Value};

use crate::catalog::Catalog;
use crate::directory::Directory;
use crate::directory::{Mode, OFlags};
use crate::drain::Cut;
use crate::error::CoreError;
use crate::http::REQUEST_LIMIT;
use crate::model::{BlockedReason, Draft, Edit, Item, ItemState, WriteKind};
use crate::{Core, Result, Server};
use std::io::{Read, Seek};

use crate::body::embed::{FILE_TYPE, bytes_of, carries_frontmatter, is_document};
use crate::body::resolve::{Names, Resolver};
use crate::names::{name_of, title_of};
use edge_types::EdgeTypes;
use elsewhere::{Look, Peers};
use embeds::ATTACHMENT_EDGE;
pub use fields::{ID_FIELD, Uncarried, VERSION_FIELD};
use lines::{BoundFiles, EdgeWork};
use lists::{Lists, in_package};
pub use placement::PLACEMENT_EDGE;
use placement::{beside, cleaned, path_of, suited};
use pull::{Departing, PullPlan};
pub use registry::{REGISTRY_ENV, Registered, Registry};
use scan::{Missing, Sweep};

pub use settings::{FOLDER_TYPE, Settings};
pub use settings_file::SettingsFileReport;

pub const STATE_DIR: &str = ".marfa";

/// The window in which the other half of a rename can arrive.
pub const RENAME_GRACE: Duration = Duration::from_secs(5);

pub const SETTINGS_FILE: &str = "folder.yaml";

pub const NEAR_LIMIT: usize = REQUEST_LIMIT * 9 / 10;

/// Each held as `encoding`, by the same binding an `unreadable` file is.
const NOT_UTF8: &str = "it is not UTF-8 text; saved as UTF-8, it is sent";
const HOLDS_NUL: &str = "it holds a NUL byte, as UTF-16 text does, so it is not read as text; saved as UTF-8 with no NUL, it is sent";

fn encoding(reason: &str) -> bool {
    reason == NOT_UTF8 || reason == HOLDS_NUL
}

/// UTF-8 holding no NUL, or why not: UTF-16 with no byte-order mark decodes
/// as UTF-8 where its letters are ASCII, each beside a NUL.
fn text_of(bytes: &[u8]) -> std::result::Result<&str, &'static str> {
    let text = std::str::from_utf8(bytes).map_err(|_| NOT_UTF8)?;
    if text.contains('\0') {
        return Err(HOLDS_NUL);
    }
    Ok(text)
}

/// The item id a file names for the claim, with `read` its document where
/// its text is readable. A document whose text is not still names its id by
/// its id line, which is ASCII.
fn id_named(path: &Path, bytes: &[u8], read: Option<&document::Document>) -> Option<String> {
    if !carries_frontmatter(path) {
        return None;
    }
    match read {
        Some(read) if read.unreadable.is_none() => read
            .front
            .get(ID_FIELD)
            .and_then(Value::as_str)
            .map(str::to_string),
        _ => document::id_line_of(bytes),
    }
}

/// Whether a file naming the item's id is its file: a file item's file is
/// its bytes, never a document naming it, and no `system.*` row is a file's
/// item.
fn named_by_its_file(item: &Item, catalog: &Catalog) -> bool {
    bytes_of(item, catalog).is_none() && !item.r#type.starts_with("system.")
}

/// Each file's identity, where no other of `paths` shares it.
fn captured_identities(paths: &[PathBuf], walked: &Walked) -> HashMap<PathBuf, identity::Identity> {
    identity::resolve(paths.iter().map(|path| {
        (
            path,
            walked
                .opened
                .get(path)
                .and_then(|capture| identity::of(&capture.metadata.borrow()))
                .or_else(|| walked.unread.get(path).copied()),
        )
    }))
}

/// Measured as the JSON string the text is sent in; a file item's bytes go up
/// outside the request.
fn near_limit(key: &str, text: &str) -> Option<Flagged> {
    if !is_document(Path::new(key)) || text.len().saturating_mul(6) < NEAR_LIMIT {
        return None;
    }
    let size = serde_json::to_string(text).map_or(text.len(), |sent| sent.len());
    (size >= NEAR_LIMIT).then(|| Flagged {
        path: key.to_string(),
        flag: "size",
        reason: format!(
            "is {size} bytes as it is sent, {}% of the {REQUEST_LIMIT} a request may carry; past that the server refuses it request_too_large and the file is held",
            size * 100 / REQUEST_LIMIT
        ),
        item: None,
    })
}

pub struct Folder {
    root: PathBuf,
    root_dir: Directory,
    state_dir: Directory,
    store_mark: (u64, u64),
    folder: String,
    core: Core,
    key: std::sync::Mutex<Option<placement::KeyRead>>,
    /// Placement writes whose give-way read failed in a watch, by queue id,
    /// and when.
    unread_give_ways: std::sync::Mutex<HashMap<String, std::time::Instant>>,
    permissions: std::sync::OnceLock<bool>,
    /// Renames to follow a title that the file system refused, by item: the
    /// path the file kept and the one refused, not tried again while both
    /// stand, so a volume that refuses them is not asked at every pass.
    refused_renames: std::sync::Mutex<HashMap<String, (String, String)>>,
    /// Why the store this open found was refused, where the open replaced it.
    replaced: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct ScanReport {
    pub created: usize,
    pub updated: usize,
    pub renamed: usize,
    /// Files whose bytes are as they were and have no write waiting.
    pub unchanged: usize,
    /// Files whose bytes are as they were but whose item's create or edit
    /// the server has not answered yet.
    pub waiting: usize,
    pub missing: usize,
    pub deleted: usize,
    pub trashed: Vec<String>,
    pub moved_away: usize,
    pub unsure: Vec<Unsure>,
    pub registry: Option<String>,
    pub skipped: usize,
    /// Files whose bytes a watch left for a later pass, still changing:
    /// files that are not documents, and file items at a document name.
    pub settling: Vec<String>,
    /// Counted in `created` too.
    pub requeued: usize,
    pub lost: usize,
    pub flagged: Vec<Flagged>,
    pub embeds: Vec<Flagged>,
    pub unreached: usize,
    pub directories: Vec<Flagged>,
    pub secrets: Vec<String>,
    pub paused: usize,
    pub warnings: Vec<Flagged>,
    /// Why the pass read nothing, where the folder's directory is gone.
    pub root_gone: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Unsure {
    pub path: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Flagged {
    pub path: String,
    pub flag: &'static str,
    pub reason: String,
    /// The item whose file this is, where a pull did not write it or could
    /// not let it go to another folder.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item: Option<String>,
}

/// A scan's flagged files and then a pull's, each once: two items a pull did
/// not write at one path are two entries.
pub fn merged_flagged<'a>(
    scan: &[Flagged],
    pull: impl IntoIterator<Item = &'a Flagged>,
) -> Vec<Flagged> {
    let mut flagged = scan.to_vec();
    for file in pull {
        if !flagged
            .iter()
            .any(|seen| seen.path == file.path && seen.item == file.item)
        {
            flagged.push(file.clone());
        }
    }
    flagged
}

impl Flagged {
    fn of(path: &str, held: &str) -> Flagged {
        let (flag, reason) = if let Some(reason) = held.strip_prefix(state::UNREADABLE) {
            (
                if encoding(reason) {
                    "encoding"
                } else {
                    "unreadable"
                },
                reason,
            )
        } else if let Some(reason) = held
            .strip_prefix(state::EDGES)
            .or_else(|| held.strip_prefix(state::EDGES_WAITING))
        {
            ("edges", reason)
        } else {
            ("refused", held.strip_prefix(state::REFUSED).unwrap_or(held))
        };
        Flagged {
            path: path.to_string(),
            flag,
            reason: reason.to_string(),
            item: None,
        }
    }
}

impl Folder {
    /// The directory need not exist.
    /// Installs `renew` before binding makes its first server request.
    /// A refused or failed add takes back the directories and files it made,
    /// but for anything it put in a `.marfa` that already held a store, and
    /// leaves everything that was there before it. A refusal after the
    /// settings file is written leaves the one found there rewritten.
    /// Where another process holds the folder, asks it to let the folder go
    /// and waits up to `HANDOVER_WAIT`, as `open_asking` does.
    pub fn add(
        root: impl AsRef<Path>,
        folder: &str,
        server: Option<Server>,
        renew: Option<crate::http::Renew>,
    ) -> Result<Folder> {
        let server = server.ok_or(CoreError::NoServer)?;
        let root = registry::named(root.as_ref())?;
        let mut made = made::Made::default();
        let added = Folder::admit(root, folder, server, renew, &mut made);
        if added.is_err() {
            made.take_back();
        }
        added
    }

    /// Records in `made` what it makes, before it can fail.
    fn admit(
        root: PathBuf,
        folder: &str,
        server: Server,
        renew: Option<crate::http::Renew>,
        made: &mut made::Made,
    ) -> Result<Folder> {
        let root_dir =
            Directory::create_recorded(&root, &mut made.directories).map_err(|error| {
                registry::named(&root)
                    .err()
                    .unwrap_or_else(|| io_error(error))
            })?;
        admitted_root(&root_dir).map_err(io_error)?;
        crate::directory_vfs::DirectoryVfs::supported(root_dir.file())?;
        let state_dir = root_dir
            .child_recorded(Path::new(STATE_DIR), &mut made.directories)
            .map_err(io_error)?;
        swap_root(&root, "replace-root-before-store-open");
        let lock_there = state_dir
            .entry_kind(Path::new(crate::lock::DIRECTORY_LOCK))
            .is_ok();
        // An add over a folder a watch holds asks for it, as a command that
        // works a folder does.
        let lock = Arc::new(handover::claim_asking(
            &state_dir,
            &root,
            handover::HANDOVER_WAIT,
            true,
        )?);
        made.lock = Some(Arc::clone(&lock));
        made.holding(&state_dir, lock_there);
        let (core, replaced) = refused::opened(
            &state_dir,
            &root.join(STATE_DIR).join("core.sqlite"),
            Some(server),
            lock,
            true,
        )?;
        let mut added = Folder::bind(root, root_dir, state_dir, folder, working(core)?, renew)?;
        added.replaced = replaced;
        Ok(added)
    }

    fn bind(
        root: PathBuf,
        root_dir: Directory,
        state_dir: Directory,
        folder: &str,
        core: Core,
        renew: Option<crate::http::Renew>,
    ) -> Result<Folder> {
        if let Some(renew) = renew {
            core.renew_credential_with(renew);
        }
        let fresh = settings_file::bound(&core)?.is_none();
        if let Some(bound) = settings_file::bound(&core)?
            && bound != folder
        {
            return Err(CoreError::Invalid(format!(
                "{} already follows the folder {bound}; a directory follows one",
                root.display()
            )));
        }
        let added = Folder {
            root,
            root_dir,
            store_mark: state_dir
                .entry_identity(Path::new("core.sqlite"))
                .map_err(io_error)?,
            state_dir,
            folder: folder.to_string(),
            core,
            key: std::sync::Mutex::new(None),
            unread_give_ways: std::sync::Mutex::new(Default::default()),
            permissions: std::sync::OnceLock::new(),
            refused_renames: std::sync::Mutex::new(HashMap::new()),
            replaced: None,
        };
        let row = added.row_on_server()?;
        // The catalog the hydration would read, so a default type the
        // query does not hold is refused before anything is bound.
        {
            let catalog = added.core.http()?.catalog()?;
            let conn = added.core.conn()?;
            crate::store::replace_catalog(&conn, &catalog)?;
            Settings::of_wire(&row.item)?.check_types(&Catalog::load(&conn)?)?;
        }
        // A key that cannot place its files would lay the folder out on this
        // machine alone; a credential that is not a key is not asked.
        if let Some(key) = added.core.http()?.current_key()?
            && !placement::places(&key)
        {
            return Err(CoreError::Forbidden {
                code: "edge_permission_denied".into(),
                message: format!(
                    "this key cannot write the {PLACEMENT_EDGE} edges that say where each file sits, so the folder cannot place its files: it needs `edge.{PLACEMENT_EDGE}:write`"
                ),
            });
        }
        settings_file::bind(&added.core, folder)?;
        // Only a store made now has never synced: one added again over its
        // own state keeps what it was asked.
        if fresh {
            added.wait_for_confirmation()?;
        }
        if let settings_file::Wrote::Failed(reason) =
            added.write_settings_file(&row.item.properties, row.item.version, None)?
        {
            return Err(CoreError::Store(reason));
        }
        // Unlisted, its moves would read as deletes to the others.
        if let Some(registry) = Registry::located() {
            let store = elsewhere::store_id(&added.core)?;
            registry.add(&added.root, &added.root_dir, folder, Some(&store))?;
            elsewhere::listed_in(&added.core, &registry);
        }
        Ok(added)
    }

    /// Refused with `ReadingHandle` at once where another process holds the
    /// folder.
    pub fn open(root: impl AsRef<Path>, server: Option<Server>) -> Result<Folder> {
        Folder::open_waiting(root.as_ref(), server, None)
    }

    /// `open`, but where another process holds the folder, asks it to let
    /// the folder go and waits up to `handover::HANDOVER_WAIT` for it. A
    /// watch lets go when asked; a watch must not ask, or two would take a
    /// folder from each other in turn.
    pub fn open_asking(root: impl AsRef<Path>, server: Option<Server>) -> Result<Folder> {
        Folder::open_waiting(root.as_ref(), server, Some(handover::HANDOVER_WAIT))
    }

    fn open_waiting(root: &Path, server: Option<Server>, wait: Option<Duration>) -> Result<Folder> {
        let opened = Folder::open_without_listing(reached(root)?, server, wait)?;
        // A lost registry is the scan's to notice before listing again.
        if let Some(registry) = Registry::located()
            && !elsewhere::lost(&opened.core, &registry)
        {
            let _ = opened.register();
        }
        if wait.is_some() {
            handover::hold_if_asked();
        }
        Ok(opened)
    }

    /// Opens `root` as given, without resolving it again or listing the
    /// folder found there. With a `wait`, asks the process holding it to let
    /// it go and waits that long.
    fn open_without_listing(
        root: PathBuf,
        server: Option<Server>,
        wait: Option<Duration>,
    ) -> Result<Folder> {
        let state = root.join(STATE_DIR);
        let root_dir = Directory::open(&root).map_err(|_| not_a_folder(&root))?;
        admitted_root(&root_dir).map_err(io_error)?;
        let state_dir = root_dir
            .child(Path::new(STATE_DIR), false)
            .map_err(|_| not_a_folder(&root))?;
        let store = state_dir
            .entry_identity(Path::new("core.sqlite"))
            .map_err(|_| not_a_folder(&root))?;
        let lock = match wait {
            None => Core::claim_directory(&state_dir)?,
            Some(wait) => {
                let lock = handover::claim_asking(&state_dir, &root, wait, false)?;
                // The holder may have removed the folder, or put another
                // store in its place, while this waited.
                if state_dir.entry_identity(Path::new("core.sqlite")).ok() != Some(store) {
                    return Err(not_a_folder(&root));
                }
                lock
            }
        };
        let (core, replaced) = refused::opened(
            &state_dir,
            &state.join("core.sqlite"),
            server,
            Arc::new(lock),
            false,
        )?;
        let core = working(core)?;
        let folder = settings_file::bound(&core)?.ok_or_else(|| not_a_folder(&root))?;
        Ok(Folder {
            root,
            root_dir,
            store_mark: state_dir
                .entry_identity(Path::new("core.sqlite"))
                .map_err(io_error)?,
            state_dir,
            folder,
            core,
            key: std::sync::Mutex::new(None),
            unread_give_ways: std::sync::Mutex::new(Default::default()),
            permissions: std::sync::OnceLock::new(),
            refused_renames: std::sync::Mutex::new(HashMap::new()),
            replaced,
        })
    }

    /// Why the store this open found was refused, where the open replaced
    /// it: another build of the core made it, and it held no write still to
    /// be sent and no answer the folder had yet to record
    /// (`folders/refused-store-replaced`).
    pub fn replaced_store(&self) -> Option<&str> {
        self.replaced.as_deref()
    }

    /// Reads the store without claiming it, so it answers beside a running
    /// watch and never keeps one from starting.
    pub fn status_of(root: impl AsRef<Path>) -> Result<StatusReport> {
        Folder::reading(root.as_ref())?.status()
    }

    /// The folder at `root` with a store opened to read only.
    fn reading(root: &Path) -> Result<Folder> {
        let root = reached(root)?;
        let state = root.join(STATE_DIR);
        let root_dir = Directory::open(&root).map_err(|_| not_a_folder(&root))?;
        admitted_root(&root_dir).map_err(io_error)?;
        let state_dir = root_dir
            .child(Path::new(STATE_DIR), false)
            .map_err(|_| not_a_folder(&root))?;
        let core = Core::read_directory(&state_dir, &state.join("core.sqlite"))?;
        let folder = settings_file::bound(&core)?.ok_or_else(|| not_a_folder(&root))?;
        Ok(Folder {
            root,
            root_dir,
            store_mark: state_dir
                .entry_identity(Path::new("core.sqlite"))
                .map_err(io_error)?,
            state_dir,
            folder,
            core,
            key: std::sync::Mutex::new(None),
            unread_give_ways: std::sync::Mutex::new(Default::default()),
            permissions: std::sync::OnceLock::new(),
            refused_renames: std::sync::Mutex::new(HashMap::new()),
            replaced: None,
        })
    }

    /// Answers whether the directory was listed.
    pub fn forget(dir: impl AsRef<Path>) -> Result<bool> {
        match Registry::located() {
            Some(registry) => registry.unregister(dir.as_ref(), None),
            None => Ok(false),
        }
    }

    /// Answers what to report, and whether the registry was lost, which leaves
    /// this pass unable to tell a move.
    fn register(&self) -> (Option<String>, bool) {
        let Some(registry) = Registry::located() else {
            return (None, false);
        };
        let lost = elsewhere::lost(&self.core, &registry);
        let store = elsewhere::store_id(&self.core).ok();
        match registry.register(&self.root, &self.root_dir, &self.folder, store.as_deref()) {
            Ok(()) => {
                elsewhere::listed_in(&self.core, &registry);
                let said = lost.then(|| {
                    format!(
                        "the folder registry {} was gone, so no missing file is trashed this pass; it lists this folder again",
                        registry.path().display()
                    )
                });
                (said, lost)
            }
            Err(error) => (Some(error.to_string()), lost),
        }
    }

    /// Leaves the folder's files; refused while writes wait, unless the first
    /// sync still waits to be confirmed.
    pub fn remove(self) -> Result<()> {
        // A first sync still waiting has sent nothing, so its queue holds
        // only what the scan read from files that stay.
        let waiting = if self.awaiting_confirmation()? {
            0
        } else {
            self.core
                .queue()?
                .iter()
                .filter(|write| {
                    matches!(write.verdict, None | Some(crate::model::Verdict::Blocked))
                })
                .count()
        };
        if waiting > 0 {
            return Err(CoreError::Invalid(format!(
                "{} has {waiting} write(s) not yet sent; push it first, or they are lost with the folder",
                self.root.display()
            )));
        }
        if let Some(registry) = Registry::located() {
            registry.unregister(&self.root, elsewhere::listed_store(&self.core).as_deref())?;
        }
        self.refuse_if_gone()?;
        let Folder {
            root,
            state_dir,
            core,
            ..
        } = self;
        drop(core);
        swap_root(&root, "replace-root-before-cleanup");
        state_dir.clear().map_err(|error| {
            CoreError::Store(format!(
                "cannot remove {}: {error}",
                root.join(STATE_DIR).display()
            ))
        })
    }

    pub fn folder_id(&self) -> &str {
        &self.folder
    }

    pub fn core(&self) -> &Core {
        &self.core
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Why the folder's directory is in cloud-synced or network storage, or
    /// `None` where it is not. Reads the file system, so it can wait on a
    /// mount that does not answer.
    pub fn storage_cause(&self) -> Option<StorageCause> {
        storage::storage_cause(&self.root)
    }

    /// The path, from the folder's root, of the file bound to the item, if
    /// one is.
    pub fn file_of(&self, item_id: &str) -> Result<Option<String>> {
        Ok(state::bound_to_item(&*self.core.conn()?, item_id)?.map(|bound| bound.path))
    }

    /// Read from the copy, not the server.
    pub fn settings(&self) -> Result<Settings> {
        match self.core.get(&self.folder)? {
            Some(item) => {
                let settings = Settings::of(&item)?;
                settings.check_types(&Catalog::load(&*self.core.conn()?)?)?;
                Ok(settings)
            }
            None => Err(CoreError::Invalid(format!(
                "this folder's copy does not hold its settings, the {FOLDER_TYPE} {}; hydrate it again with a key holding `{FOLDER_TYPE}:read`",
                self.folder
            ))),
        }
    }

    fn row_on_server(&self) -> Result<crate::wire::WireItemWithMetadata> {
        let cannot_read = || CoreError::Forbidden {
            code: "type_not_permitted".into(),
            message: format!(
                "this key cannot read {FOLDER_TYPE}, so the folder cannot follow its settings: it needs `{FOLDER_TYPE}:read`"
            ),
        };
        let http = self.core.http()?;
        let read =
            crate::hydrate::read_with_edges(http, &self.folder).map_err(|error| match error {
                CoreError::Forbidden { code, .. } if code == "type_not_permitted" => cannot_read(),
                other => other,
            })?;
        let Some((row, _)) = read else {
            // The server answers a folder the key cannot read as no folder at
            // all, so the key's own map says which of the two this is.
            let message = match http.current_key()? {
                Some(key) if !placement::reads(&key, FOLDER_TYPE) => return Err(cannot_read()),
                Some(_) => format!(
                    "the server holds no folder {}; `folders create` makes one",
                    self.folder
                ),
                // A credential that is not a key cannot read its own map.
                None => format!(
                    "the server holds no folder {} that this credential may read: it needs `{FOLDER_TYPE}:read`, or `folders create` makes one",
                    self.folder
                ),
            };
            return Err(CoreError::NotFound {
                code: "item_not_found".into(),
                message,
            });
        };
        Settings::read(
            &row.item.id,
            &row.item.r#type,
            &row.item.state,
            &row.item.properties,
        )?;
        Ok(row)
    }

    pub fn hydrate(&self) -> Result<crate::model::HydrateReport> {
        self.hydrate_until(&crate::NEVER_STOPPED)
    }

    fn hydrate_until(&self, stop: &AtomicBool) -> Result<crate::model::HydrateReport> {
        let row = self.row_on_server()?;
        let settings = Settings::of_wire(&row.item)?;
        let fetched = self.core.http()?.catalog()?;
        let planning = crate::store::open_in_memory()?;
        crate::store::replace_catalog(&planning, &fetched)?;
        let edge_types = EdgeTypes::load(&planning)?;
        crate::store::pin(&*self.core.conn()?, &self.folder)?;
        let catalog = Catalog::load(&planning)?;
        let whole = whole_edge_types(&settings, &edge_types, &catalog);
        self.core
            .hydrate_until(&settings.slice_types(), settings.tier(), &whole, stop)
    }

    /// `None` where the copy already answers for the slice the settings ask.
    pub fn resume(&self) -> Result<Option<crate::model::HydrateReport>> {
        self.resume_until(&crate::NEVER_STOPPED)
    }

    /// `resume`, ended with `Canceled` soon after `stop` is raised.
    fn resume_until(&self, stop: &AtomicBool) -> Result<Option<crate::model::HydrateReport>> {
        if crate::store::hydrated(&*self.core.conn()?)? && !self.slice_moved()? {
            return Ok(None);
        }
        self.hydrate_until(stop).map(Some)
    }

    /// Settings the copy cannot read count as moved, so the hydration that
    /// follows says why.
    fn slice_moved(&self) -> Result<bool> {
        let Ok(settings) = self.settings() else {
            return Ok(true);
        };
        let conn = self.core.conn()?;
        let Some((types, tier)) = crate::store::slice(&conn)? else {
            return Ok(true);
        };
        let held: HashSet<&str> = types.iter().map(String::as_str).collect();
        let asked_types = settings.slice_types();
        let asked: HashSet<&str> = asked_types.iter().map(String::as_str).collect();
        let Ok(edge_types) = EdgeTypes::load(&conn) else {
            return Ok(true);
        };
        let whole: HashSet<String> = crate::store::whole_edge_types(&conn)?.into_iter().collect();
        let wanted: HashSet<String> =
            whole_edge_types(&settings, &edge_types, &Catalog::load(&conn)?)
                .into_iter()
                .collect();
        Ok(held != asked || tier != settings.tier() || whole != wanted)
    }

    pub fn catch_up(&self) -> Result<CaughtUp> {
        match self.core.catch_up() {
            // Settings changed elsewhere can ask for another slice.
            Ok(report) if self.slice_moved()? => Ok(CaughtUp {
                caught_up: Some(report),
                hydrated: Some(self.hydrate()?),
            }),
            Ok(report) => Ok(CaughtUp {
                caught_up: Some(report),
                hydrated: None,
            }),
            Err(CoreError::CopyExpired { .. }) => Ok(CaughtUp {
                caught_up: None,
                hydrated: Some(self.hydrate()?),
            }),
            Err(error) => Err(error),
        }
    }

    fn walked(&self, lists: &Lists) -> Walked {
        let mut walked = Walked::default();
        walk(&self.root, &self.root, &self.root_dir, lists, &mut walked);
        walked.files.sort();
        walked
    }

    /// Whether a scan that can read every directory reaches a bound file at
    /// `path`, to read it, follow its move or journal it gone.
    fn reaches(&self, lists: &Lists, path: &str) -> bool {
        lists.takes(path) && !in_nested_folder(&self.root_dir, path)
    }

    fn writes_at(&self, lists: &Lists, path: &str) -> bool {
        self.not_writing_at(lists, path).is_none()
    }

    /// Why the folder does not write at `path`, where it does not.
    fn not_writing_at(&self, lists: &Lists, path: &str) -> Option<&'static str> {
        if !plainly_inside(&self.root_dir, path) {
            Some("the path leads out of the folder")
        } else if !lists.takes(path) {
            Some("the folder's lists do not take the path")
        } else if in_package(&self.root_dir, path) {
            Some("the path is inside a package")
        } else if in_nested_folder(&self.root_dir, path) {
            Some("the path is inside another folder")
        } else {
            None
        }
    }
}

fn swap_root(root: &Path, fault: &str) {
    if crate::fault::named(fault).is_some() {
        std::fs::rename(root, root.with_extension("original")).expect("fixture root rename");
        std::fs::rename(root.with_extension("replacement"), root)
            .expect("fixture replacement rename");
    }
}

fn io_error(error: std::io::Error) -> CoreError {
    CoreError::Io(error.to_string())
}

fn require_birth(birth: Option<u128>) -> std::io::Result<()> {
    if same_birth(birth, birth) {
        return Ok(());
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "folder identity requires a nonzero birth timestamp; use a filesystem that reports file and directory creation times",
    ))
}

fn admitted_root(directory: &Directory) -> std::io::Result<()> {
    let birth = match crate::fault::named("root-birth-time").as_deref() {
        Some("missing") => None,
        Some("zero") => Some(0),
        _ => identity::born(&directory.metadata()?),
    };
    require_birth(birth)
}

fn read_file(file: &std::fs::File) -> std::io::Result<Vec<u8>> {
    let mut file = file.try_clone()?;
    file.rewind()?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    Ok(bytes)
}

/// The directory every command but an add and a removal works: a listed
/// folder at its listed path, refused where a link now stands in that path.
fn reached(dir: &Path) -> Result<PathBuf> {
    match registry::reach(dir)? {
        registry::Reached::Listed(entry) => match registry::linked_listing(&entry.dir) {
            Some(refused) => Err(refused),
            None => Ok(entry.dir),
        },
        registry::Reached::Unlisted(root) => Ok(root),
    }
}

/// A root that became a link since it was named is refused by the open with
/// the system's own error; the walk names the link instead.
fn not_a_folder(root: &Path) -> CoreError {
    registry::named(root).err().unwrap_or_else(|| {
        CoreError::Invalid(format!(
            "{} is not a folder; `folders add` makes one",
            root.display()
        ))
    })
}

/// One process works a folder at a time: every working path starts from a
/// `Folder` this makes, so a second opener is refused before it reads or
/// writes a file, a binding or the server.
fn working(core: Core) -> Result<Core> {
    core.lock.refuse_unless_writer()?;
    Ok(core)
}

fn in_nested_folder(root: &Directory, relative: &str) -> bool {
    let mut directory = root.clone();
    let mut names = relative.split('/').peekable();
    while let Some(name) = names.next() {
        if names.peek().is_none() {
            break;
        }
        let Ok(child) = directory.child(Path::new(name), false) else {
            return false;
        };
        if child
            .child(Path::new(STATE_DIR), false)
            .is_ok_and(|state| state.entry_identity(Path::new("core.sqlite")).is_ok())
        {
            return true;
        }
        directory = child;
    }
    false
}

impl Folder {
    /// Writes a file into the folder, through `inside`, which every write
    /// and every rename into the folder passes: refused where the folder's
    /// directory is gone, so a pull never makes it anew.
    fn land(
        &self,
        path: &Path,
        fill: impl FnOnce(&mut std::fs::File, &Path) -> std::io::Result<()>,
        still: impl FnOnce(Option<&[u8]>) -> bool,
    ) -> std::result::Result<(), landing::Unlanded> {
        if let Some(gone) = self.root_gone() {
            return Err(std::io::Error::new(std::io::ErrorKind::NotFound, gone).into());
        }
        let (directory, name) = self.location(path, true)?;
        swap_root(&self.root, "replace-root-before-publication");
        landing::land_at(&directory, Path::new(&name), fill, still)
    }

    fn location(
        &self,
        path: &Path,
        create: bool,
    ) -> std::io::Result<(Directory, std::ffi::OsString)> {
        let relative = path
            .strip_prefix(&self.root)
            .map_err(|_| std::io::Error::other("path outside folder"))?;
        if let Ok(below) = relative.strip_prefix(STATE_DIR) {
            self.state_dir.parent(below, create)
        } else {
            self.root_dir.parent(relative, create)
        }
    }

    fn read(&self, path: impl AsRef<Path>) -> std::io::Result<Vec<u8>> {
        let (directory, name) = self.location(path.as_ref(), false)?;
        directory.read(Path::new(&name))
    }

    fn read_text(&self, path: impl AsRef<Path>) -> std::io::Result<String> {
        String::from_utf8(self.read(path)?)
            .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))
    }

    fn metadata(&self, path: impl AsRef<Path>) -> std::io::Result<std::fs::Metadata> {
        let (directory, name) = self.location(path.as_ref(), false)?;
        directory.entry_metadata(Path::new(&name))
    }

    fn exists(&self, path: impl AsRef<Path>) -> bool {
        self.location(path.as_ref(), false)
            .is_ok_and(|(directory, name)| directory.entry_kind(Path::new(&name)).is_ok())
    }

    fn remove_file(&self, path: &Path, still: impl FnOnce(&[u8]) -> bool) -> std::io::Result<bool> {
        let (directory, name) = self.location(path, false)?;
        landing::remove_at(&directory, Path::new(&name), still)
    }

    fn inside(&self, dir: Option<&Path>) -> std::io::Result<()> {
        if let Some(gone) = self.root_gone() {
            return Err(std::io::Error::new(std::io::ErrorKind::NotFound, gone));
        }
        if let Some(below) = dir.and_then(|dir| dir.strip_prefix(&self.root).ok()) {
            self.root_dir.child(below, true)?;
        }
        Ok(())
    }
}

impl Folder {
    /// `Some` with why where the folder's directory is not where this handle
    /// found it: moved, renamed, on a volume no longer mounted, or another
    /// directory put in its place. Every file would then read as deleted, so
    /// a pass reads and writes nothing until it is back.
    fn root_gone(&self) -> Option<String> {
        let unavailable = |path: &Path, error: std::io::Error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                format!(
                    "{} cannot be found, so nothing in the folder is read or written; restore the original directory and state to resume",
                    path.display()
                )
            } else {
                format!(
                    "{} cannot be checked ({error}), so nothing in the folder is read or written; check access and restore the original directory and state to resume",
                    path.display()
                )
            }
        };
        let same = |left: &Directory, right: &Directory| -> std::io::Result<bool> {
            let matches = left.same(right)?;
            if !matches {
                // A missing birth identity cannot establish replacement.
                require_birth(identity::born(&left.metadata()?))?;
                require_birth(identity::born(&right.metadata()?))?;
            }
            Ok(matches)
        };
        let current = match Directory::open(&self.root) {
            Ok(current) => current,
            Err(error) => return Some(unavailable(&self.root, error)),
        };
        match same(&self.root_dir, &current) {
            Ok(true) => {}
            Ok(false) => {
                return Some(format!(
                    "{} is no longer the directory this folder opened, so nothing in it is read or written; restore the original directory to resume",
                    self.root.display()
                ));
            }
            Err(error) => return Some(unavailable(&self.root, error)),
        }
        let state_path = self.root.join(STATE_DIR);
        let state = match current.child(Path::new(STATE_DIR), false) {
            Ok(state) => state,
            Err(error) => return Some(unavailable(&state_path, error)),
        };
        let state_matches = match same(&self.state_dir, &state) {
            Ok(matches) => matches,
            Err(error) => return Some(unavailable(&state_path, error)),
        };
        if state_matches {
            match state.entry_identity(Path::new("core.sqlite")) {
                Ok(mark) if mark == self.store_mark => return None,
                Ok(_) => {}
                Err(error) => return Some(unavailable(&state_path.join("core.sqlite"), error)),
            }
        }
        Some(format!(
            "{} is no longer the administrative state this folder opened, so nothing in the folder is read or written; restore the original state to resume",
            state_path.display()
        ))
    }

    /// For a command that has nothing to report a gone directory in.
    fn refuse_if_gone(&self) -> Result<()> {
        match self.root_gone() {
            Some(gone) => Err(CoreError::Invalid(gone)),
            None => Ok(()),
        }
    }
}

/// Held whole, since their other ends may lie outside the slice.
fn whole_edge_types(settings: &Settings, edge_types: &EdgeTypes, catalog: &Catalog) -> Vec<String> {
    let mut whole = edge_types.written_at_targets();
    // `beneath` walks `parent-of` from rows the slice may not hold.
    if settings.query.beneath.is_some() {
        whole.push(crate::filter::PARENT_OF.into());
    }
    // A query of files alone holds no document to embed one.
    let documents = settings.names_every_type()
        || settings
            .types()
            .iter()
            .any(|named| !catalog.matches(FILE_TYPE, named.trim()));
    if documents && edge_types.get(ATTACHMENT_EDGE).is_some() {
        whole.push(ATTACHMENT_EDGE.into());
    }
    whole.sort();
    whole.dedup();
    whole
}

#[derive(Default)]
struct Walked {
    files: Vec<PathBuf>,
    opened: HashMap<PathBuf, Captured>,
    unread: HashMap<PathBuf, identity::Identity>,
    directories: Vec<Flagged>,
    secrets: Vec<String>,
    /// Files a crashed write left beside their target.
    left: Vec<(WalkRoute, PathBuf)>,
}

impl Walked {
    fn file_birth(&mut self, root: &Path, dir: &Path, birth: Option<u128>) -> bool {
        match require_birth(birth) {
            Ok(()) => true,
            Err(error) => {
                self.unreadable(root, dir, &error);
                false
            }
        }
    }

    fn passed_over(&self, relative: &str) -> bool {
        self.directories.iter().any(|dir| {
            dir.path.is_empty()
                || relative
                    .strip_prefix(&dir.path)
                    .is_some_and(|rest| rest.starts_with('/'))
        })
    }

    fn unreadable(&mut self, root: &Path, dir: &Path, error: &std::io::Error) {
        // Gone while the walk read it: moved or renamed, its files are
        // somewhere this walk did not look.
        let (flag, reason) = if error.kind() == std::io::ErrorKind::NotFound {
            (
                "gone",
                "went away while the walk read it, so this pass journals no missing file".into(),
            )
        } else {
            (
                "unreadable",
                format!("cannot be read ({error}), so the files bound in it are held"),
            )
        };
        let path = identity::relative(root, dir).unwrap_or_default();
        if !self.directories.iter().any(|dir| dir.path == path) {
            self.directories.push(Flagged {
                path,
                flag,
                reason,
                item: None,
            });
        }
    }

    fn incomplete(&self) -> bool {
        self.directories
            .iter()
            .any(|dir| matches!(dir.flag, "gone" | "unreadable"))
    }
}

/// Reopening a walked parent must prove every component is the same directory.
/// Keeping identities instead of descriptors bounds the walk's open files.
#[derive(Clone)]
struct WalkRoute {
    root: Directory,
    steps: Vec<(std::ffi::OsString, std::fs::Metadata)>,
}

impl WalkRoute {
    fn open(&self) -> std::io::Result<Directory> {
        let mut directory = self.root.clone();
        for (name, expected) in &self.steps {
            directory = directory.child(Path::new(name), false)?;
            if !same_file(expected, &directory.metadata()?) {
                return Err(std::io::Error::other(
                    "walked directory identity cannot be confirmed",
                ));
            }
        }
        Ok(directory)
    }

    fn child(&self, name: &std::ffi::OsStr, directory: &Directory) -> std::io::Result<Self> {
        let mut route = self.clone();
        let metadata = directory.metadata()?;
        require_birth(identity::born(&metadata))?;
        route.steps.push((name.to_owned(), metadata));
        Ok(route)
    }
}

#[cfg(unix)]
fn same_file(left: &std::fs::Metadata, right: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    left.dev() == right.dev()
        && left.ino() == right.ino()
        && same_birth(identity::born(left), identity::born(right))
}

fn same_birth(left: Option<u128>, right: Option<u128>) -> bool {
    left.is_some_and(|birth| birth > 0) && left == right
}

#[cfg(not(unix))]
fn same_file(_: &std::fs::Metadata, _: &std::fs::Metadata) -> bool {
    false
}

struct Captured {
    route: WalkRoute,
    name: std::ffi::OsString,
    metadata: RefCell<std::fs::Metadata>,
}

impl Captured {
    fn open(&self) -> std::io::Result<std::fs::File> {
        let directory = self.route.open()?;
        let file = directory.capture_file(Path::new(&self.name))?;
        let metadata = file.metadata()?;
        require_birth(identity::born(&self.metadata.borrow()))?;
        require_birth(identity::born(&metadata))?;
        if !same_file(&self.metadata.borrow(), &metadata) {
            return Err(std::io::Error::other(
                "walked file identity cannot be confirmed",
            ));
        }
        *self.metadata.borrow_mut() = metadata;
        Ok(file)
    }

    fn read_settled(&self, settle: Option<Duration>) -> std::io::Result<Option<Vec<u8>>> {
        let mut file = self.open()?;
        if settle.is_some_and(|settle| changed_within(&self.metadata.borrow(), settle)) {
            return Ok(None);
        }
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)?;
        #[cfg(debug_assertions)]
        crate::fault::hold(|| "folder-scan-read");
        Ok(Some(bytes))
    }

    fn read(&self) -> std::io::Result<Vec<u8>> {
        Ok(self
            .read_settled(None)?
            .expect("a read without a settling interval never waits"))
    }
}

fn walk(root: &Path, dir: &Path, directory: &Directory, lists: &Lists, walked: &mut Walked) {
    let route = WalkRoute {
        root: directory.clone(),
        steps: Vec::new(),
    };
    walk_at(root, dir, directory, &route, lists, walked);
}

/// A directory it cannot read is reported and passed over, so one does not
/// stop the scan of every other.
fn walk_at(
    root: &Path,
    dir: &Path,
    directory: &Directory,
    route: &WalkRoute,
    lists: &Lists,
    walked: &mut Walked,
) {
    if let Some(gone) = crate::fault::named("vanish-while-walking")
        && identity::relative(root, dir).is_ok_and(|relative| relative == gone)
    {
        let _ = std::fs::rename(dir, root.join(format!("{gone}.vanished")));
        return walked.unreadable(root, dir, &std::io::ErrorKind::NotFound.into());
    }
    let entries = match directory.entries() {
        Ok(entries) => entries,
        Err(error) => return walked.unreadable(root, dir, &error),
    };
    for name in entries {
        let path = dir.join(&name);
        let entry = Path::new(&name);
        let Ok(relative) = identity::relative(root, &path) else {
            continue;
        };
        let kind = match directory.entry_kind(entry) {
            Ok(kind) => kind,
            Err(error) => {
                walked.unreadable(root, dir, &error);
                continue;
            }
        };
        if kind == crate::directory::FileType::Directory {
            if !lists.enters(&relative) {
                continue;
            }
            let child = match directory.child(entry, false) {
                Ok(child) => child,
                Err(error) => {
                    walked.unreadable(root, &path, &error);
                    continue;
                }
            };
            if child
                .child(Path::new(STATE_DIR), false)
                .is_ok_and(|state| state.entry_identity(Path::new("core.sqlite")).is_ok())
            {
                continue;
            }
            if lists::is_package_at(&path, &child) {
                walked.directories.push(Flagged {
                    path: relative,
                    flag: "package",
                    reason: "is a package, which macOS opens as one thing, so the folder does not walk into it".into(),
                    item: None,
                });
            } else {
                match route.child(&name, &child) {
                    Ok(route) => walk_at(root, &path, &child, &route, lists, walked),
                    Err(error) => walked.unreadable(root, &path, &error),
                }
            }
        } else if kind == crate::directory::FileType::RegularFile {
            if landing::left_behind(&path) {
                walked.left.push((route.clone(), PathBuf::from(name)));
            } else if lists.takes(&relative) {
                match directory.capture_file(entry).and_then(|file| {
                    Ok(Captured {
                        metadata: RefCell::new(file.metadata()?),
                        route: route.clone(),
                        name: name.clone(),
                    })
                }) {
                    Ok(captured) => {
                        let born = identity::born(&captured.metadata.borrow());
                        if walked.file_birth(root, dir, born) {
                            walked.opened.insert(path.clone(), captured);
                        }
                    }
                    Err(error) => {
                        if let Ok(Some((device, inode, born))) = directory.observed_identity(entry)
                            && let Some(identity) =
                                identity::Identity::from_parts(device, inode, born)
                        {
                            // An identity can prove a move even where unread bytes
                            // leave the rest of this inventory incomplete.
                            walked.unread.insert(path.clone(), identity);
                        }
                        walked.unreadable(root, dir, &error);
                    }
                }
                walked.files.push(path);
            } else if lists.secret(&relative) {
                walked.secrets.push(relative);
            }
        }
    }
}

fn one_per_name(
    paths: &[PathBuf],
    keys: Vec<String>,
    snapshot: &[state::Bound],
    report: &mut ScanReport,
) -> (Vec<PathBuf>, Vec<String>) {
    let bound: HashSet<&str> = snapshot.iter().map(|row| row.path.as_str()).collect();
    let holders = names::holders(&keys, |key| bound.contains(key));
    let mut kept = (Vec::new(), Vec::new());
    for (at, (path, key)) in paths.iter().zip(&keys).enumerate() {
        let held = holders[at];
        if held == at {
            kept.0.push(path.clone());
            kept.1.push(key.clone());
        } else {
            report.flagged.push(Flagged {
                path: key.clone(),
                flag: "name",
                reason: format!(
                    "differs from {} only in case or Unicode form, which a folder reads as one name, so it is held until one of them is renamed",
                    keys[held]
                ),
                item: None,
            });
        }
    }
    kept
}

struct Scanned {
    key: String,
    path: PathBuf,
    text: String,
    hash: String,
    /// Device, inode and birth time, where the filesystem gave a usable
    /// three.
    mark: Option<String>,
    born: Option<u128>,
    id: Option<String>,
    /// The version its `marfa_version` line names, where that is one the
    /// server could have minted.
    line: Option<i64>,
    unreadable: Option<String>,
    deferred: bool,
    source: Option<Vec<u8>>,
    /// `None` on a volume that keeps no permission.
    executable: Option<bool>,
    /// An old buffer taken over the file a pull moved, at this file's path.
    folded: bool,
}

/// The title a rename gives an item, and what the item held under it.
struct Retitle {
    r#type: String,
    field: String,
    title: String,
    held: Option<Value>,
    version: i64,
}

impl Retitle {
    /// Why the copy would refuse `title` as the item's, where it would.
    fn refusal(&self, title: &str, catalog: &Catalog) -> Option<CoreError> {
        let mut properties = Map::new();
        properties.insert(self.field.clone(), Value::String(title.into()));
        catalog
            .validate_properties(&self.r#type, &properties, false)
            .err()
            .filter(local_admission_refusal)
    }
}

impl Scanned {
    fn deferred(
        root: &Path,
        path: &Path,
        mark: Option<String>,
        captured: Option<&Captured>,
    ) -> Result<Self> {
        Ok(Self {
            key: identity::relative(root, path)?,
            path: path.to_path_buf(),
            mark,
            born: captured.and_then(|captured| identity::born(&captured.metadata.borrow())),
            text: String::new(),
            hash: String::new(),
            id: None,
            line: None,
            unreadable: None,
            deferred: true,
            source: None,
            executable: None,
            folded: false,
        })
    }

    fn document(&self) -> document::Document {
        #[cfg(test)]
        tests::DOCUMENTS_READ.with(|read| read.set(read.get() + 1));
        if is_document(&self.path) {
            document_of(&self.path, &self.text)
        } else {
            document::read_body(&String::from_utf8_lossy(
                self.source.as_deref().unwrap_or_default(),
            ))
        }
    }
}

/// A document's front matter and body, read as the scan reads them.
fn document_of(path: &Path, text: &str) -> document::Document {
    if carries_frontmatter(path) {
        document::read(text)
    } else {
        document::read_body(text)
    }
}

/// Keyed by the file's place in the scan.
type Waiting = HashMap<usize, String>;

impl Folder {
    /// Whether the copy holds the item, and as bytes rather than as a document.
    /// The item decides, not the name of the file it is at.
    fn file_item(&self, item_id: &str, catalog: &Catalog) -> Result<bool> {
        Ok(self
            .core
            .get(item_id)?
            .is_some_and(|item| bytes_of(&item, catalog).is_some()))
    }

    fn peers(&self) -> Peers<'_> {
        let (registry, lost) = self.register();
        Peers::of(self, registry.filter(|_| lost))
    }

    fn pushes(&self, path: &Path, settings: &Settings, catalog: &Catalog) -> bool {
        is_document(path) || self.file_type_of(path, settings, catalog).is_some()
    }

    fn file_type_of(&self, path: &Path, settings: &Settings, catalog: &Catalog) -> Option<String> {
        let file_type = bytes_type(path, catalog)?;
        settings
            .holds_type(catalog, &file_type)
            .then_some(file_type)
    }

    /// A document's links and lines, to read once every file is bound.
    fn edge_work(&self, file: &Scanned, item_id: &str, bound: Option<&state::Bound>) -> EdgeWork {
        let document = file.document();
        EdgeWork {
            path: file.key.clone(),
            item_id: item_id.to_string(),
            links: document.links,
            front: document.front,
            had_links: bound.map(|bound| bound.links.clone()).unwrap_or_default(),
            had_lines: bound.map(|bound| bound.lines.clone()).unwrap_or_default(),
            embeds: Vec::new(),
        }
    }

    fn bind_held(
        &self,
        file: &Scanned,
        item_id: &str,
        bound: Option<&state::Bound>,
        held: String,
        named: Option<&(String, Option<Value>)>,
    ) -> Result<()> {
        let links = bound.map(|bound| bound.links.clone()).unwrap_or_default();
        let lines = bound.map(|bound| bound.lines.clone()).unwrap_or_default();
        let kept = Kept {
            edit_line: bound.and_then(|bound| bound.edit_line),
            own: bound.and_then(|bound| bound.own.clone()),
            held: Some(held),
            writes: bound.map(|bound| bound.writes.clone()).unwrap_or_default(),
            named: named.cloned(),
            bytes: false,
            blob: bound.and_then(|bound| bound.blob.clone()),
        };
        self.bind_scanned(file, item_id, links, lines, kept)
    }

    /// Whether a file at `path` takes the name `title` makes, where it was
    /// in step with the title it showed before, `was`, or that was blank.
    fn follows_title(&self, path: &str, was: Option<&str>, title: &str) -> bool {
        let name = name_of(path);
        !title.trim().is_empty()
            && !names::in_step(name, title)
            && was.is_none_or(|was| was.trim().is_empty() || names::in_step(name, was))
    }
}

const LOCAL_ADMISSION_REFUSAL: &str = "refused: local item validation: ";

/// What the copy refuses a write for before queueing it: a field the type
/// does not take, a type it does not hold, and a tag or property name the
/// server would refuse.
fn local_admission_refusal(error: &CoreError) -> bool {
    matches!(error, CoreError::Validation {code, ..}
        if code == "invalid_properties" || code == "validation_error")
        || matches!(error, CoreError::UnknownType { .. })
}

fn local_properties_refusal(bound: &state::Bound) -> bool {
    bound
        .held
        .as_deref()
        .is_some_and(|reason| reason.starts_with(LOCAL_ADMISSION_REFUSAL))
}

/// Whether a move was answered that another machine deleted its edge first.
fn gone_before_its_move(row: &crate::model::QueuedWrite) -> bool {
    row.kind == WriteKind::UpdateEdge
        && row.verdict == Some(crate::model::Verdict::Refused)
        && row.reason.as_deref() == Some("edge_not_found")
}

/// Kept with the end it named before, so a refusal can point the record back
/// there.
struct MovedLine {
    from: String,
    to: state::Line,
}

/// Read from the row, since the copy may no longer hold the edge once the
/// server has answered.
fn moved_line(
    conn: &rusqlite::Connection,
    row: &crate::model::QueuedWrite,
    bound: &state::Bound,
) -> Result<Option<MovedLine>> {
    let (Some(source), Some(target), Some(edge_id)) = (&row.item_id, &row.target_id, &row.edge_id)
    else {
        return Ok(None);
    };
    let body: Value = serde_json::from_str(&crate::store::payload_of(conn, &row.id)?)?;
    let (end, from, to) = match (body["source_id"].as_str(), body["target_id"].as_str()) {
        (None, Some(to)) if source == &bound.item_id => (crate::catalog::End::Source, target, to),
        (Some(to), None) if target == &bound.item_id => (crate::catalog::End::Target, source, to),
        _ => return Ok(None),
    };
    let edge_type = match crate::store::edge_ends(conn, edge_id)? {
        Some(edge) => edge.edge_type,
        None => match bound
            .lines
            .iter()
            .find(|line| line.end == end && line.other == to)
        {
            Some(line) => line.edge_type.clone(),
            None => return Ok(None),
        },
    };
    Ok(Some(MovedLine {
        from: from.clone(),
        to: state::Line {
            edge_type,
            end,
            other: to.to_string(),
        },
    }))
}

fn edge_change(
    conn: &rusqlite::Connection,
    row: &crate::model::QueuedWrite,
    item_id: &str,
) -> Result<Option<state::Change>> {
    let (Some(source), Some(target)) = (&row.item_id, &row.target_id) else {
        return Ok(None);
    };
    let body: Value = serde_json::from_str(&crate::store::payload_of(conn, &row.id)?)?;
    let Some(edge_type) = body["edge_type"].as_str() else {
        return Ok(None);
    };
    let (end, other) = if source == item_id {
        (crate::catalog::End::Source, target)
    } else {
        (crate::catalog::End::Target, source)
    };
    Ok(Some(state::Change::Edge {
        line: state::Line {
            edge_type: edge_type.to_string(),
            end,
            other: other.clone(),
        },
        shown: row.kind == WriteKind::CreateEdge,
    }))
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Drained {
    #[serde(flatten)]
    pub report: crate::DrainReport,
    pub rebased: usize,
    pub gave_way: usize,
}

impl Drained {
    /// Takes in a later drain of the same sync, so the two read as one.
    pub(crate) fn absorb(&mut self, later: Drained) {
        self.report.absorb(later.report);
        self.rebased += later.rebased;
        self.gave_way += later.gave_way;
    }
}

impl Folder {
    /// Its passes are one drain: another on the store waits for all of them.
    pub fn drain(&self) -> Result<Drained> {
        self.drain_in(false)
    }

    /// Whether the queue holds a write no drain has answered, as a pull's
    /// placement or edit leaves one. Taken as yes where the queue cannot be
    /// read.
    pub(super) fn has_unanswered_writes(&self) -> bool {
        self.core
            .conn()
            .and_then(|conn| crate::store::has_unanswered_writes(&conn))
            .unwrap_or(true)
    }

    /// `drain`, for a watch where `watched`, which waits out
    /// `placement::GIVE_WAY_REREAD` before it reads again for a give-way.
    pub(super) fn drain_in(&self, watched: bool) -> Result<Drained> {
        self.drain_keeping(watched).map_err(|cut| cut.error)
    }

    /// `drain_in`, keeping what a drain that ends in an error settled before
    /// it. The refusals among them are remembered and their files held, as
    /// for a drain that ends well; nothing is read from the server for them,
    /// since the error may say the copy can no longer be read from.
    pub(super) fn drain_keeping(
        &self,
        watched: bool,
    ) -> std::result::Result<Drained, Cut<Drained>> {
        let one = self.core.one_drain();
        let mut report = crate::DrainReport::empty();
        let mut rebased = 0;
        let ended = self.drain_rebasing(&one, &mut report, &mut rebased).err();
        if let Some(drain_error) = ended {
            // A refusal that could not be remembered is told in place of the
            // drain's own error, since a caller that went on would lose it.
            let error = self
                .remember_refusals(&report)
                .and_then(|()| self.hold_refused())
                .err()
                .unwrap_or(drain_error);
            return Err(Cut {
                error,
                settled: Box::new(Drained {
                    report,
                    rebased,
                    gave_way: 0,
                }),
            });
        }
        let settled = (|| {
            // Queued even where the drain stopped, so the copy holds the edge the line asks for.
            self.make_edges_gone_before_their_move()?;
            let gave_way = self.settle_placements(&mut report, watched)?;
            self.keep_wait(&report)?;
            self.hold_refused()?;
            Ok(gave_way)
        })();
        let drained = |report, gave_way| Drained {
            report,
            rebased,
            gave_way,
        };
        match settled {
            Ok(gave_way) => Ok(drained(report, gave_way)),
            Err(error) => Err(Cut {
                error,
                settled: Box::new(drained(report, 0)),
            }),
        }
    }

    /// Drains, and again for as long as the edits the server could not
    /// apply are rebased, taking each drain's report into `report`.
    fn drain_rebasing(
        &self,
        one: &std::sync::MutexGuard<'_, ()>,
        report: &mut crate::DrainReport,
        rebased: &mut usize,
    ) -> Result<()> {
        loop {
            match self.core.drain_held(one) {
                Ok(later) => report.absorb(later),
                Err(cut) => {
                    report.absorb(*cut.settled);
                    return Err(cut.error);
                }
            }
            if report.stopped.is_some() || report.unavailable.is_some() {
                return Ok(());
            }
            let now = self.rebase_thinned()? + self.make_edges_gone_before_their_move()?;
            if now == 0 {
                return Ok(());
            }
            *rebased += now;
        }
    }

    /// Read from the queue rather than this drain's report, so a refusal a plain
    /// device drain was answered holds its file too.
    fn hold_refused(&self) -> Result<()> {
        let queue = self.core.queue()?;
        let conn = self.core.conn()?;
        for mut bound in state::every_bound(&conn)? {
            let was = (bound.writes.clone(), bound.lines.clone(), bound.edit_line);
            for verdict in &queue {
                let Some(at) = bound.writes.queued.iter().position(|q| q.id == verdict.id) else {
                    continue;
                };
                let save = bound.writes.queued[at].save;
                let row = verdict;
                let mut moved: Option<MovedLine> = None;
                let change = match row.kind {
                    WriteKind::UpdateItem => state::Change::Edit,
                    WriteKind::AddTag => state::Change::AddTag(row.tag.clone().unwrap_or_default()),
                    WriteKind::RemoveTag => {
                        state::Change::RemoveTag(row.tag.clone().unwrap_or_default())
                    }
                    WriteKind::TransitionItem => {
                        let body: Value =
                            serde_json::from_str(&crate::store::payload_of(&conn, &row.id)?)?;
                        match body["state"].as_str().and_then(|state| state.parse().ok()) {
                            Some(state) => state::Change::State(state),
                            None => continue,
                        }
                    }
                    WriteKind::CreateEdge | WriteKind::DeleteEdge => {
                        match edge_change(&conn, row, &bound.item_id)? {
                            Some(change) => change,
                            None => continue,
                        }
                    }
                    WriteKind::UpdateEdge => match moved_line(&conn, row, &bound)? {
                        Some(line) => {
                            let change = state::Change::Edge {
                                line: line.to.clone(),
                                shown: true,
                            };
                            moved = Some(line);
                            change
                        }
                        None => continue,
                    },
                    _ => continue,
                };
                // Left for the next drain that is not stopped to make the edge it asks for.
                if moved.is_some() && gone_before_its_move(row) {
                    continue;
                }
                // A delete of an edge already gone did what it was asked.
                let gone = row.kind == WriteKind::DeleteEdge
                    && verdict.reason.as_deref() == Some("edge_not_found");
                match verdict.verdict {
                    Some(crate::model::Verdict::Refused) if !gone => {
                        let code = verdict.reason.clone().unwrap_or_default();
                        let message = row
                            .answer
                            .as_deref()
                            .and_then(|answer| serde_json::from_str::<Value>(answer).ok())
                            .and_then(|answer| {
                                answer["error"]["message"].as_str().map(str::to_string)
                            });
                        // A refused move left the edge where it was, so the record names it there again.
                        if let Some(moved) = &moved {
                            for line in &mut bound.lines {
                                if *line == moved.to {
                                    line.other = moved.from.clone();
                                }
                            }
                        }
                        let refused = state::Refused {
                            change,
                            save,
                            reason: match message {
                                Some(message) => format!("{code}: {message}"),
                                None => code,
                            },
                        };
                        if !bound.writes.refused.contains(&refused) {
                            bound.writes.refused.push(refused);
                        }
                    }
                    Some(
                        crate::model::Verdict::Accepted
                        | crate::model::Verdict::Merged
                        | crate::model::Verdict::Refused,
                    ) => {
                        bound.writes.refused.retain(|refused| {
                            refused.save >= save || !change.supersedes(&refused.change)
                        });
                    }
                    // Answered, its own value set aside in a copy beside the row.
                    Some(crate::model::Verdict::Conflicted) => {}
                    // Kept with its line spent, since it may have landed;
                    // released, it is answered here again.
                    Some(crate::model::Verdict::Dead) => continue,
                    _ => continue,
                }
                // A refused edit spends no line.
                let spent = bound.writes.queued.remove(at).line;
                if verdict.verdict != Some(crate::model::Verdict::Refused)
                    && let Some(line) = spent
                {
                    bound.edit_line = Some(bound.edit_line.unwrap_or(0).max(line));
                }
            }
            if (&bound.writes, &bound.lines, bound.edit_line) != (&was.0, &was.1, was.2) {
                state::bind(&conn, &bound)?;
            }
        }
        Ok(())
    }

    /// Makes the edge a line names where its move was answered that another
    /// machine deleted the edge first: the line still asks for it.
    fn make_edges_gone_before_their_move(&self) -> Result<usize> {
        let queue = self.core.queue()?;
        let mut made = 0;
        let bounds = state::every_bound(&*self.core.conn()?)?;
        for mut bound in bounds {
            let mut changed = false;
            for at in 0..bound.writes.queued.len() {
                let Some(row) = queue
                    .iter()
                    .find(|row| row.id == bound.writes.queued[at].id)
                else {
                    continue;
                };
                if !gone_before_its_move(row) {
                    continue;
                }
                let Some(moved) = moved_line(&*self.core.conn()?, row, &bound)? else {
                    continue;
                };
                let body: Value =
                    serde_json::from_str(&crate::store::payload_of(&*self.core.conn()?, &row.id)?)?;
                let (source_id, target_id) = match moved.to.end {
                    crate::catalog::End::Source => (bound.item_id.clone(), moved.to.other.clone()),
                    crate::catalog::End::Target => (moved.to.other.clone(), bound.item_id.clone()),
                };
                let created = self.core.create_edge(&crate::model::EdgeDraft {
                    source_id,
                    target_id,
                    edge_type: moved.to.edge_type.clone(),
                    properties: body["properties"].as_object().cloned().unwrap_or_default(),
                    id: None,
                })?;
                bound.writes.queued[at].id = created.id;
                changed = true;
                made += 1;
            }
            if changed {
                state::bind(&*self.core.conn()?, &bound)?;
            }
        }
        Ok(made)
    }

    /// Only the first `ancestor_unavailable` edit of each item: the next was
    /// made against it, so it goes on its answer, a pass later.
    fn rebase_thinned(&self) -> Result<usize> {
        let queue = self.core.queue()?;
        let mut first: HashSet<&str> = HashSet::new();
        let mut rebased = 0;
        for row in &queue {
            let Some(item_id) = row.item_id.as_deref() else {
                continue;
            };
            if row.kind != WriteKind::UpdateItem
                || row.blocked_reason() != Some(BlockedReason::AncestorUnavailable)
                || !first.insert(item_id)
            {
                continue;
            }
            if self.core.rebase_on_held(&row.id)? {
                rebased += 1;
            }
        }
        Ok(rebased)
    }
}

impl Folder {
    fn keeps_permissions(&self) -> bool {
        *self
            .permissions
            .get_or_init(|| executable::kept(&self.state_dir))
    }

    /// Answered as a list in the folder is, so the two hold the same items.
    fn members(&self, settings: &Settings) -> Result<HashSet<String>> {
        Ok(self
            .core
            .held_by(settings)?
            .into_iter()
            .map(|item| item.id)
            .collect())
    }

    fn render(
        &self,
        item: &Item,
        path: &str,
        line: Option<i64>,
        catalog: &Catalog,
        edge_types: &EdgeTypes,
        lines: LinesBy<'_>,
    ) -> Result<Rendered> {
        let body_field = fields::body_field(catalog, &item.r#type);
        let body = item
            .properties
            .get(body_field)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let links = self.body_links(item, &body, catalog, lines.0)?;
        if !carries_frontmatter(Path::new(path)) {
            return Ok(Rendered {
                text: Ok(body),
                links,
                lines: Vec::new(),
            });
        }
        let embedded: Vec<String> = self
            .shown_in(item, path, &body, catalog)?
            .into_iter()
            .filter_map(|shown| shown.item)
            .collect();
        let (names, typed, recorded) = lines;
        let mut front = fields::lines_of(item, typed.map(|document| &document.front))?;
        // A file that already says when the item happened goes on saying it,
        // and a blank line stays blank where there is no time to show.
        match typed.and_then(|document| document.front.get(fields::OCCURRED_AT_FIELD)) {
            Some(Value::Null) if !front.contains_key(fields::OCCURRED_AT_FIELD) => {
                front.insert(fields::OCCURRED_AT_FIELD.into(), Value::Null);
            }
            Some(_) => {
                front.insert(
                    fields::OCCURRED_AT_FIELD.into(),
                    Value::String(item.occurred_at.clone()),
                );
            }
            None => {}
        }
        for (field, value) in &item.properties {
            if field != body_field && !fields::reserved(field, edge_types) {
                front.insert(field.clone(), value.clone());
            }
        }
        let (entries, written) = self.lines_for(
            item,
            edge_types,
            catalog,
            names,
            typed.map(|document| &document.front),
            (&links, &embedded),
            recorded,
        )?;
        front.extend(entries);
        front.insert(ID_FIELD.into(), Value::String(item.id.clone()));
        if let Some(line) = line {
            front.insert(VERSION_FIELD.into(), Value::from(line));
        }
        if let Some(typed) = typed {
            fields::keep_empty_properties(&mut front, &typed.front, edge_types, body_field);
            fields::keep_equivalent(&mut front, &typed.front, edge_types);
        }
        Ok(Rendered {
            text: if crate::fault::named("render-frontmatter").as_deref() == Some(path) {
                Err(CoreError::Invalid(
                    "cannot preserve this frontmatter: injected rendering failure".into(),
                ))
            } else {
                document::write(&front, &body, typed)
            },
            links,
            lines: written,
        })
    }
}

/// What a render writes lines by: the copy's names, the file's own lines,
/// and the edges its record says it carried.
type LinesBy<'a> = (&'a Names, Option<&'a document::Document>, &'a [state::Line]);

struct Rendered {
    // Byte preservation can fail for one document. Read authority and store
    // errors from constructing its fields still fail the whole operation.
    text: Result<String>,
    links: Vec<String>,
    lines: Vec<state::Line>,
}

#[derive(Default)]
struct Kept {
    edit_line: Option<i64>,
    own: Option<fields::OwnBase>,
    held: Option<String>,
    writes: state::Writes,
    /// A title line edited away from the title the file's name was made
    /// from: the field, and what the agreed presentation goes on showing.
    named: Option<(String, Option<Value>)>,
    /// Bound as a file item, whose binding holds no presentation, as a pull's
    /// does: its bytes are no text.
    bytes: bool,
    /// The blob a file item's file was sent as, or last agreed at.
    blob: Option<String>,
}

fn blank(value: &Value) -> bool {
    value.is_null() || value.as_str().is_some_and(|text| text.trim().is_empty())
}

/// The status change time where the system keeps one, which an editor
/// restoring the modification time does not move back.
fn changed_within(metadata: &std::fs::Metadata, settle: Duration) -> bool {
    #[cfg(unix)]
    let changed = {
        use std::os::unix::fs::MetadataExt;
        u64::try_from(metadata.ctime())
            .ok()
            .map(|seconds| {
                std::time::UNIX_EPOCH
                    + Duration::new(seconds, u32::try_from(metadata.ctime_nsec()).unwrap_or(0))
            })
            .or_else(|| metadata.modified().ok())
    };
    #[cfg(not(unix))]
    let changed = metadata.modified().ok();
    changed.is_some_and(|changed| {
        std::time::SystemTime::now()
            .duration_since(changed)
            .is_ok_and(|since| since < settle)
    })
}

/// What a quick pass compares with what its last read recorded.
fn stat_metadata(metadata: &std::fs::Metadata) -> Option<String> {
    let modified = metadata
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_nanos();
    Some(format!(
        "{}:{modified}:{}",
        metadata.len(),
        executable::of(metadata)
    ))
}

fn bytes_type(path: &Path, catalog: &Catalog) -> Option<String> {
    if is_document(path) {
        return None;
    }
    let named = crate::blob::file_type_for(&crate::blob::mime_type_for(path, None), None);
    Some(if catalog.known(&named) {
        named
    } else {
        FILE_TYPE.to_string()
    })
}

pub const LINK_EDGE: &str = "references";

/// Only a version the server could have minted.
fn line_of(front: &Map<String, Value>) -> Option<i64> {
    version_named(front.get(VERSION_FIELD)?)
}

fn version_named(line: &Value) -> Option<i64> {
    // An editor typing the line as text writes it quoted.
    let number = match line {
        Value::String(text) => text.trim().parse::<f64>().ok()?,
        other => other.as_f64()?,
    };
    // `1.0` is the version 1; `1.5` names none.
    (number.fract() == 0.0 && number >= 1.0 && number <= i64::MAX as f64).then_some(number as i64)
}

/// `hydrated` where the log had aged past the cursor or the settings ask for
/// another slice.
#[derive(Debug, Clone, Serialize)]
pub struct CaughtUp {
    pub caught_up: Option<crate::model::CatchUpReport>,
    pub hydrated: Option<crate::model::HydrateReport>,
}

/// Directory opens enforce the same component rule again when they operate.
fn plainly_inside(root: &Directory, relative: &str) -> bool {
    let mut directory = root.clone();
    let mut names = relative.split('/').peekable();
    while let Some(name) = names.next() {
        if name.is_empty() || name == "." || name == ".." {
            return false;
        }
        match directory.entry_kind(Path::new(name)) {
            Ok(crate::directory::FileType::Symlink) => return false,
            Ok(crate::directory::FileType::Directory) if names.peek().is_some() => {
                match directory.child(Path::new(name), false) {
                    Ok(child) => directory = child,
                    Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
                        return names.all(|part| !part.is_empty() && part != "." && part != "..");
                    }
                    Err(_) => return false,
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return names.all(|part| !part.is_empty() && part != "." && part != "..");
            }
            _ if names.peek().is_some() => {
                return names.all(|part| !part.is_empty() && part != "." && part != "..");
            }
            _ => {}
        }
    }
    true
}

/// The title a renamed document's line says where the person changed it
/// from the one the file last showed, and it is not the name's.
fn typed_title(
    bound: &state::Bound,
    document: &document::Document,
    retitle: &Retitle,
) -> Option<String> {
    let typed = document.front.get(&retitle.field)?.as_str()?;
    let shown = bound
        .presentation
        .as_ref()
        .and_then(|agreed| agreed.front().get(&retitle.field))
        .and_then(Value::as_str);
    (shown != Some(typed) && !typed.trim().is_empty() && typed != retitle.title)
        .then(|| typed.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A move queued before its edge was damaged still names the edge's type,
    /// which is all the folder pass needs of the edge.
    #[test]
    fn a_move_of_an_edge_whose_stored_properties_cannot_be_read_still_names_its_type() {
        use crate::model::{Draft, EdgeDraft, EdgeEdit};
        let dir = tempfile::tempdir().unwrap();
        let core = Core::open(dir.path().join("copy.db"), None).unwrap();
        let note = |title: &str| {
            core.create_item(&Draft {
                r#type: "core.note".into(),
                properties: serde_json::json!({ "title": title, "body": "" })
                    .as_object()
                    .unwrap()
                    .clone(),
                ..Default::default()
            })
            .unwrap()
            .item_id
            .unwrap()
        };
        let (from, to, other) = (note("from"), note("to"), note("other"));
        let edge = core
            .create_edge(&EdgeDraft {
                source_id: from,
                target_id: to.clone(),
                edge_type: "parent-of".into(),
                ..Default::default()
            })
            .unwrap()
            .edge_id
            .unwrap();
        let moved = core
            .update_edge(
                &edge,
                &EdgeEdit {
                    source_id: Some(other),
                    base_version: Some(0),
                    ..EdgeEdit::default()
                },
            )
            .unwrap()
            .unwrap();
        let bound = state::Bound {
            path: "to.md".into(),
            item_id: to,
            identity: None,
            content_hash: "hash".into(),
            presentation: None,
            blob: None,
            written_hash: None,
            links: Vec::new(),
            lines: Vec::new(),
            edit_line: None,
            held: None,
            own: None,
            writes: Default::default(),
        };
        let conn = core.conn().unwrap();
        // The witness: the readable edge names its type.
        let line = moved_line(&conn, &moved, &bound).unwrap().unwrap();
        assert_eq!(line.to.edge_type, "parent-of");

        conn.execute(
            "UPDATE edges SET properties = '{\"a\":' WHERE id = ?1",
            [&edge],
        )
        .unwrap();
        let line = moved_line(&conn, &moved, &bound).unwrap().unwrap();
        assert_eq!(line.to.edge_type, "parent-of");
    }

    #[cfg(unix)]
    #[test]
    fn a_large_walk_keeps_descriptors_available() {
        // Names the file the child writes once it has run to its end, so a
        // filter that matches no test cannot pass as a clean exit.
        const CHILD: &str = "MARFA_TEST_LARGE_WALK_CHILD";
        let Some(marker) = std::env::var_os(CHILD) else {
            let scratch = tempfile::tempdir().unwrap();
            let marker = scratch.path().join("ran");
            let output = std::process::Command::new("sh")
                .args(["-c", "ulimit -n 128; exec \"$@\"", "large-walk"])
                .arg(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "folder::tests::a_large_walk_keeps_descriptors_available",
                    "--nocapture",
                ])
                .env(CHILD, &marker)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            assert!(
                marker.exists(),
                "the child exited cleanly without running the walk, so its test \
                 filter matches no test\n{}",
                String::from_utf8_lossy(&output.stdout)
            );
            return;
        };
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        for at in 0..256 {
            std::fs::write(root.join(format!("note-{at}.md")), "original note").unwrap();
        }
        let directory = Directory::open(&root).unwrap();
        let mut walked = Walked::default();
        walk(
            &root,
            &root,
            &directory,
            &Lists::new(&[], &[]).unwrap(),
            &mut walked,
        );
        let readable = walked
            .opened
            .values()
            .filter(|captured| captured.read().is_ok())
            .count();
        let root_present = Directory::open(&root).is_ok();
        assert_eq!(
            (walked.opened.len(), readable, root_present),
            (256, 256, true)
        );
        drop(walked);
        let mut ended = std::process::Command::new("true").spawn().unwrap();
        let gone = ended.id();
        ended.wait().unwrap();
        for at in 0..256 {
            let child = root.join(format!("child-{at}"));
            std::fs::create_dir(&child).unwrap();
            std::fs::write(child.join("note.md"), "original note").unwrap();
            std::fs::write(child.join(format!(".marfa-{gone}-0.tmp")), "unfinished").unwrap();
        }
        let mut walked = Walked::default();
        walk(
            &root,
            &root,
            &directory,
            &Lists::new(&[], &[]).unwrap(),
            &mut walked,
        );
        assert_eq!(walked.opened.len(), 512);
        assert_eq!(walked.left.len(), 256);
        for captured in walked.opened.values() {
            assert_eq!(captured.read().unwrap(), b"original note");
        }
        for (route, name) in &walked.left {
            route.open().unwrap().unlink(name).unwrap();
        }
        assert!(Directory::open(&root).is_ok());
        std::fs::write(marker, "ran").unwrap();
    }

    #[test]
    fn a_walk_refuses_replaced_children_and_reads_restored_originals() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let child = root.join("child");
        std::fs::create_dir(&child).unwrap();
        std::fs::write(child.join("note.md"), "original").unwrap();
        let directory = Directory::open(&root).unwrap();
        let mut walked = Walked::default();
        walk(
            &root,
            &root,
            &directory,
            &Lists::new(&[], &[]).unwrap(),
            &mut walked,
        );
        let captured = &walked.opened[&child.join("note.md")];
        assert_eq!(captured.read().unwrap(), b"original");
        std::fs::rename(&child, root.join("original")).unwrap();
        std::fs::create_dir(&child).unwrap();
        std::fs::write(child.join("note.md"), "replacement").unwrap();
        assert!(captured.read().is_err());
        std::fs::rename(&child, root.join("replacement")).unwrap();
        std::fs::rename(root.join("original"), &child).unwrap();
        assert_eq!(captured.read().unwrap(), b"original");
        std::fs::rename(child.join("note.md"), child.join("original.md")).unwrap();
        std::fs::write(child.join("note.md"), "replacement file").unwrap();
        assert!(captured.read().is_err());
        assert_eq!(
            std::fs::read(root.join("replacement/note.md")).unwrap(),
            b"replacement"
        );
    }

    #[test]
    fn reopened_identity_requires_a_known_nonzero_birth_time() {
        assert!(same_birth(Some(1), Some(1)));
        assert!(!same_birth(Some(1), Some(2)));
        assert!(!same_birth(None, None));
        assert!(!same_birth(Some(0), Some(0)));
        assert!(require_birth(Some(1)).is_ok());
        assert_eq!(
            require_birth(None).unwrap_err().kind(),
            std::io::ErrorKind::Unsupported
        );
        assert_eq!(
            require_birth(Some(0)).unwrap_err().kind(),
            std::io::ErrorKind::Unsupported
        );
    }

    #[test]
    fn a_binary_changed_after_walking_waits_for_settling() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let path = root.join("file.bin");
        std::fs::write(&path, b"original").unwrap();
        let directory = Directory::open(&root).unwrap();
        let mut walked = Walked::default();
        walk(
            &root,
            &root,
            &directory,
            &Lists::new(&[], &[]).unwrap(),
            &mut walked,
        );
        let captured = &walked.opened[&path];
        let settle = Duration::from_millis(200);
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while changed_within(&captured.metadata.borrow(), settle) {
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(
            captured.read_settled(Some(settle)).unwrap(),
            Some(b"original".to_vec())
        );
        std::fs::write(&path, b"still writing").unwrap();
        assert!(changed_within(&std::fs::metadata(&path).unwrap(), settle));
        assert_eq!(captured.read_settled(Some(settle)).unwrap(), None);
    }

    thread_local! {
        /// How many times this thread's scans built a document from a file.
        pub(super) static DOCUMENTS_READ: std::cell::Cell<usize> =
            const { std::cell::Cell::new(0) };
    }

    fn documents_read() -> usize {
        DOCUMENTS_READ.with(std::cell::Cell::get)
    }

    thread_local! {
        /// How many times this thread walked another folder's directory.
        pub(super) static PEERS_WALKED: std::cell::Cell<usize> =
            const { std::cell::Cell::new(0) };
    }

    /// How many times this thread walked another folder's directory since
    /// the last call.
    fn peers_walked() -> usize {
        PEERS_WALKED.with(|walked| walked.replace(0))
    }

    /// A folder over a fresh directory, with a copy that holds its settings.
    fn scanned_folder() -> (ScannedDir, Folder) {
        scanned_folder_with(serde_json::json!({ "query": {} }), None)
    }

    /// A scanned folder's directory, with the registry of its own the test
    /// lists its folders in, so no two tests share one.
    struct ScannedDir {
        dir: tempfile::TempDir,
        _registry: registry::tests::OwnRegistry,
    }

    impl std::ops::Deref for ScannedDir {
        type Target = tempfile::TempDir;

        fn deref(&self) -> &tempfile::TempDir {
            &self.dir
        }
    }

    /// The same, with these settings and, where given, these types in the
    /// copy's catalog.
    fn scanned_folder_with(settings: Value, types: Option<Value>) -> (ScannedDir, Folder) {
        let (_, registry) = registry::tests::own_registry();
        let (dir, folder) = folder_with("01a00000-0000-7000-8000-000000000001", settings, types);
        (
            ScannedDir {
                dir,
                _registry: registry,
            },
            folder,
        )
    }

    /// A folder over a fresh directory, listed in the registry this thread
    /// already has, whose copy holds the folder item `id` with `settings`.
    fn folder_with(id: &str, settings: Value, types: Option<Value>) -> (tempfile::TempDir, Folder) {
        let dir = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let state = dir.path().join(STATE_DIR);
        std::fs::create_dir_all(&state).unwrap();
        let core = Core::open(state.join("core.sqlite"), None).unwrap();
        if let Some(types) = types {
            let mut catalog = crate::builtin::catalog().unwrap();
            catalog
                .types
                .extend(serde_json::from_value::<Vec<crate::wire::WireType>>(types).unwrap());
            crate::store::replace_catalog(&core.conn().unwrap(), &catalog).unwrap();
        }
        crate::store::upsert_item(
            &core.conn().unwrap(),
            &crate::store::testing::wire_item(
                id,
                "system.folder",
                "active",
                "2026-01-01T00:00:00Z",
                settings,
            ),
            None,
            &Default::default(),
        )
        .unwrap();
        settings_file::bind(&core, id).unwrap();
        drop(core);
        let folder = Folder::open(dir.path(), None).unwrap();
        (dir, folder)
    }

    #[test]
    fn a_scanned_file_item_is_bound_with_no_text_copy_of_its_bytes() {
        let (dir, folder) = scanned_folder();
        // Lone continuation bytes, none of them UTF-8, so a lossy decode
        // would triple them.
        let binary: Vec<u8> = (0..1 << 20).map(|at| 0x80 | (at % 64) as u8).collect();
        std::fs::write(dir.path().join("archive.bin"), &binary).unwrap();
        std::fs::write(dir.path().join("table.csv"), "a,b\n1,2\n".repeat(1 << 16)).unwrap();
        std::fs::write(dir.path().join("note.md"), "a note\n").unwrap();
        let report = folder.scan().unwrap();
        assert_eq!(report.created, 3, "{report:?}");
        let conn = folder.core.conn().unwrap();
        let bound = |path: &str| state::bound_at(&conn, path).unwrap().unwrap();
        // The witness: a document's binding holds its presentation.
        assert!(bound("note.md").presentation.is_some());
        for path in ["archive.bin", "table.csv"] {
            let bound = bound(path);
            assert!(
                bound.presentation.is_none(),
                "{path} is bound with a text copy of its bytes"
            );
            assert!(bound.held.is_none(), "{path} is held: {:?}", bound.held);
        }
        let stored: i64 = conn
            .query_row(
                "SELECT COALESCE(SUM(LENGTH(presentation)), 0) FROM folder_files",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(stored < 1024, "the bindings hold {stored} bytes of text");
    }

    #[test]
    fn a_file_item_renamed_to_a_document_name_stays_a_file_item_and_is_not_decoded() {
        // Lone continuation bytes, none of them UTF-8.
        let binary: Vec<u8> = (0..1 << 16).map(|at| 0x80 | (at % 64) as u8).collect();
        for name in ["archive.md", "archive.markdown", "archive.txt"] {
            let (dir, folder) = scanned_folder();
            std::fs::write(dir.path().join("archive.bin"), &binary).unwrap();
            // The witness: a note's rename does build its document.
            std::fs::write(dir.path().join("note.md"), "a note\n").unwrap();
            assert_eq!(folder.scan().unwrap().created, 2);
            let item = |path: &str| {
                state::bound_at(&folder.core.conn().unwrap(), path)
                    .unwrap()
                    .unwrap_or_else(|| panic!("{path} is not bound"))
                    .item_id
            };
            let (file_item, note_item) = (item("archive.bin"), item("note.md"));

            std::fs::rename(dir.path().join("note.md"), dir.path().join("moved.md")).unwrap();
            let before = documents_read();
            assert_eq!(folder.scan().unwrap().renamed, 1);
            assert!(
                documents_read() > before,
                "a note's rename read no document"
            );

            std::fs::rename(dir.path().join("archive.bin"), dir.path().join(name)).unwrap();
            let before = documents_read();
            let report = folder.scan().unwrap();
            assert_eq!(
                documents_read(),
                before,
                "{name} was read as a document though its item is bytes"
            );
            assert_eq!(report.renamed, 1, "{name}: {report:?}");
            assert!(report.flagged.is_empty(), "{name}: {:?}", report.flagged);
            assert!(report.warnings.is_empty(), "{name}: {:?}", report.warnings);
            assert_eq!(item("moved.md"), note_item);
            let held = folder.core.get(&file_item).unwrap().unwrap();
            let conn = folder.core.conn().unwrap();
            assert!(bytes_of(&held, &Catalog::load(&conn).unwrap()).is_some());
            assert!(state::bound_at(&conn, "archive.bin").unwrap().is_none());
            let bound = state::bound_at(&conn, name).unwrap().expect(name);
            assert_eq!(bound.item_id, file_item, "{name} lost its item");
            assert!(bound.held.is_none(), "{name} is held: {:?}", bound.held);
            assert!(
                bound.presentation.is_none(),
                "{name} is bound with a text copy"
            );
            assert_eq!(bound.content_hash, state::hash(&binary));
        }
    }

    #[test]
    fn a_file_item_at_a_document_name_is_sent_as_bytes_whatever_they_hold() {
        // Valid UTF-8, each a block that does not parse as frontmatter.
        for (label, edited) in [
            ("unclosed list", "---\ntitle: [unclosed\n---\nbody\n"),
            ("duplicate key", "---\ntitle: a\ntitle: b\n---\nbody\n"),
            ("unterminated quote", "---\ntitle: 'x\n---\nbody\n"),
        ] {
            let (dir, folder) = scanned_folder();
            std::fs::write(dir.path().join("archive.bin"), [0x80; 4096]).unwrap();
            // The witness: a note with the same bytes is held.
            std::fs::write(dir.path().join("note.md"), "a note\n").unwrap();
            assert_eq!(folder.scan().unwrap().created, 2);
            std::fs::write(dir.path().join("note.md"), edited).unwrap();
            let report = folder.scan().unwrap();
            let flagged = |report: &ScanReport, path: &str| {
                report.flagged.iter().any(|flagged| flagged.path == path)
            };
            assert!(flagged(&report, "note.md"), "{label}: {report:?}");

            std::fs::rename(dir.path().join("archive.bin"), dir.path().join("notes.md")).unwrap();
            let report = folder.scan().unwrap();
            assert_eq!(report.renamed, 1, "{label}: {report:?}");
            let item_id = {
                let conn = folder.core.conn().unwrap();
                let bound = state::bound_at(&conn, "notes.md").unwrap().unwrap();
                assert!(bound.held.is_none(), "{label}: {:?}", bound.held);
                bound.item_id
            };

            std::fs::write(dir.path().join("notes.md"), edited).unwrap();
            let report = folder.scan().unwrap();
            assert!(!flagged(&report, "notes.md"), "{label}: {report:?}");
            assert_eq!(report.updated, 1, "{label}: {report:?}");
            let conn = folder.core.conn().unwrap();
            let bound = state::bound_at(&conn, "notes.md").unwrap().unwrap();
            assert_eq!(bound.item_id, item_id, "{label}");
            assert!(bound.held.is_none(), "{label}: {:?}", bound.held);
            assert_eq!(
                bound.content_hash,
                state::hash(edited.as_bytes()),
                "{label}"
            );
            assert!(bound.presentation.is_none(), "{label}");
        }
    }

    #[test]
    fn a_document_that_is_not_utf8_is_held_and_keeps_its_item_by_its_id_line() {
        let (dir, folder) = scanned_folder();
        std::fs::write(dir.path().join("note.md"), "a note\n").unwrap();
        assert_eq!(folder.scan().unwrap().created, 1);
        let item_id = {
            let conn = folder.core.conn().unwrap();
            state::bound_at(&conn, "note.md").unwrap().unwrap().item_id
        };
        // Latin-1, as an older editor saves it, moved to another name.
        let mut latin1 = format!("---\nmarfa_id: {item_id}\n---\ncaf").into_bytes();
        latin1.extend([0xe9, b'\n']);
        // Much more of it is not text than the id line is.
        latin1.extend((0..1 << 16).map(|at| 0x80 | (at % 64) as u8));
        std::fs::remove_file(dir.path().join("note.md")).unwrap();
        std::fs::write(dir.path().join("cafe.md"), &latin1).unwrap();
        std::fs::write(dir.path().join("dump.txt"), &latin1).unwrap();
        std::fs::write(
            dir.path().join("wide.txt"),
            "wide\n"
                .encode_utf16()
                .flat_map(u16::to_le_bytes)
                .collect::<Vec<_>>(),
        )
        .unwrap();
        let before = documents_read();
        let report = folder.scan().unwrap();
        assert_eq!(documents_read(), before);
        let mut flagged: Vec<(&str, &str)> = report
            .flagged
            .iter()
            .map(|flagged| (flagged.path.as_str(), flagged.flag))
            .collect();
        flagged.sort_unstable();
        assert_eq!(
            flagged,
            [
                ("cafe.md", "encoding"),
                ("dump.txt", "encoding"),
                ("wide.txt", "encoding")
            ],
            "{report:?}"
        );
        let reasons: HashMap<&str, &str> = report
            .flagged
            .iter()
            .map(|flagged| (flagged.path.as_str(), flagged.reason.as_str()))
            .collect();
        assert_eq!(reasons["cafe.md"], NOT_UTF8);
        assert_eq!(reasons["dump.txt"], NOT_UTF8);
        assert_eq!(reasons["wide.txt"], HOLDS_NUL);
        assert_eq!((report.created, report.updated), (0, 0), "{report:?}");
        let conn = folder.core.conn().unwrap();
        let bound = state::bound_at(&conn, "cafe.md").unwrap().unwrap();
        assert_eq!(
            bound.item_id, item_id,
            "the id line no longer names its item"
        );
        assert_eq!(
            bound.held.as_deref(),
            Some(format!("{}{NOT_UTF8}", state::UNREADABLE).as_str())
        );
        assert!(state::bound_at(&conn, "note.md").unwrap().is_none());
        for path in ["dump.txt", "wide.txt"] {
            assert!(state::bound_at(&conn, path).unwrap().is_none(), "{path}");
        }
    }

    #[test]
    fn a_file_item_at_a_document_name_gets_no_size_warning() {
        // 200 KB of control characters, each sent as six: past the limit.
        let valid = "\u{1}".repeat(200_000);
        // Lone continuation bytes, each three as replacement characters.
        let invalid: Vec<u8> = vec![0x80; 400_000];
        for (name, bytes) in [("big.md", valid.as_bytes()), ("big.txt", &invalid)] {
            let (dir, folder) = scanned_folder_with(
                serde_json::json!({ "query": {}, "defaults": { "type": "user.large_text" } }),
                Some(serde_json::json!([
                    {
                        "id": "user.large_text",
                        "display_hints": { "title_field": "title", "body_field": "body" },
                        "fields": {
                            "title": { "type": "string" },
                            "body": { "type": "string", "maxLength": 1_000_000 },
                        },
                    },
                ])),
            );
            std::fs::write(dir.path().join("big.bin"), bytes).unwrap();
            // The witness: a note this size is warned of.
            std::fs::write(dir.path().join("note.md"), &valid).unwrap();
            let report = folder.scan().unwrap();
            assert_eq!(report.created, 2, "{report:?}");
            let warned: Vec<&str> = report.warnings.iter().map(|w| w.path.as_str()).collect();
            assert_eq!(warned, ["note.md"], "{name}: {report:?}");

            std::fs::rename(dir.path().join("big.bin"), dir.path().join(name)).unwrap();
            let report = folder.scan().unwrap();
            assert_eq!(report.renamed, 1, "{name}: {report:?}");
            assert!(report.warnings.is_empty(), "{name}: {:?}", report.warnings);
            // Edited at the document name, it still goes up as bytes.
            std::fs::write(dir.path().join(name), [bytes, b"."].concat()).unwrap();
            let report = folder.scan().unwrap();
            assert_eq!(report.updated, 1, "{name}: {report:?}");
            assert!(report.warnings.is_empty(), "{name}: {:?}", report.warnings);
        }
    }

    #[test]
    fn a_file_item_emptied_at_a_document_name_waits_and_fails_no_scan() {
        for name in ["notes.md", "notes.markdown", "notes.txt"] {
            let (dir, folder) = scanned_folder();
            let bytes = vec![0x82; 4096];
            std::fs::write(dir.path().join("archive.bin"), &bytes).unwrap();
            std::fs::write(dir.path().join("note.md"), "a note\n").unwrap();
            assert_eq!(folder.scan().unwrap().created, 2, "{name}");
            std::fs::rename(dir.path().join("archive.bin"), dir.path().join(name)).unwrap();
            assert_eq!(folder.scan().unwrap().renamed, 1, "{name}");
            let held = |folder: &Folder| {
                state::bound_at(&folder.core.conn().unwrap(), name)
                    .unwrap()
                    .unwrap_or_else(|| panic!("{name} is not bound"))
            };
            let bound = held(&folder);

            // An editor empties the file before it writes. The witnesses: a
            // note emptied is sent empty, and a new file in the same scan is
            // sent.
            std::fs::write(dir.path().join(name), b"").unwrap();
            std::fs::write(dir.path().join("note.md"), "").unwrap();
            std::fs::write(dir.path().join("witness.bin"), [7, 7, 1]).unwrap();
            let report = folder.scan().unwrap_or_else(|error| {
                panic!("{name}: an emptied file item failed the scan: {error}")
            });
            assert_eq!(
                (report.created, report.updated),
                (1, 1),
                "{name}: {report:?}"
            );
            assert!(report.flagged.is_empty(), "{name}: {:?}", report.flagged);
            assert!(report.skipped >= 1, "{name}: {report:?}");
            let waiting = held(&folder);
            assert_eq!(waiting.item_id, bound.item_id, "{name}");
            assert_eq!(waiting.content_hash, bound.content_hash, "{name}");
            assert!(waiting.held.is_none(), "{name}: {:?}", waiting.held);

            // Written whole, it goes up as the item's new bytes.
            let edited = [bytes.as_slice(), b"."].concat();
            std::fs::write(dir.path().join(name), &edited).unwrap();
            let report = folder.scan().unwrap();
            assert_eq!(report.updated, 1, "{name}: {report:?}");
            assert_eq!(held(&folder).content_hash, state::hash(&edited), "{name}");
        }
    }

    /// A file item at `notes.md` that has been moved to `moved.md`, and a new
    /// note written at `notes.md` in its place, before the next scan.
    fn note_where_a_file_item_was(note: &str) -> (ScannedDir, Folder, String) {
        let (dir, folder) = scanned_folder();
        std::fs::write(dir.path().join("archive.bin"), [0x83; 4096]).unwrap();
        assert_eq!(folder.scan().unwrap().created, 1);
        std::fs::rename(dir.path().join("archive.bin"), dir.path().join("notes.md")).unwrap();
        assert_eq!(folder.scan().unwrap().renamed, 1);
        let file_item = state::bound_at(&folder.core.conn().unwrap(), "notes.md")
            .unwrap()
            .unwrap()
            .item_id;
        std::fs::rename(dir.path().join("notes.md"), dir.path().join("moved.md")).unwrap();
        std::fs::write(dir.path().join("notes.md"), note).unwrap();
        (dir, folder, file_item)
    }

    #[test]
    fn a_new_note_where_a_moved_file_item_was_is_read_as_a_note() {
        let note = "---\ntitle: Fresh\ntags: [kept]\n---\nthe body\n![[y.png]]\n";
        let (dir, folder, file_item) = note_where_a_file_item_was(note);
        std::fs::write(dir.path().join("y.png"), [7, 7, 5]).unwrap();
        let report = folder.scan().unwrap();
        assert!(report.flagged.is_empty(), "{:?}", report.flagged);
        let bound = |path: &str| state::bound_at(&folder.core.conn().unwrap(), path).unwrap();
        let moved = bound("moved.md").unwrap();
        assert_eq!(moved.item_id, file_item, "the file item lost its file");
        assert!(moved.presentation.is_none() && moved.held.is_none());
        let fresh = bound("notes.md").unwrap();
        assert_ne!(fresh.item_id, file_item, "the new note took the file item");
        assert!(fresh.held.is_none(), "{:?}", fresh.held);
        let item = folder.core.get(&fresh.item_id).unwrap().unwrap();
        assert_eq!(item.r#type, "core.note");
        assert_eq!(
            item.properties.get("body").and_then(Value::as_str),
            Some("the body\n![[y.png]]\n"),
            "the new note was created without its body"
        );
        assert_eq!(
            item.properties.get("title").and_then(Value::as_str),
            Some("Fresh")
        );
        let text = std::fs::read_to_string(dir.path().join("notes.md")).unwrap();
        assert!(
            text.contains("title: Fresh") && text.contains("the body\n"),
            "the note's file lost its frontmatter or its body: {text}"
        );
        // The note's embed is followed, as any note's is.
        assert!(
            bound("y.png").is_some(),
            "an embed in the new note was not followed"
        );
    }

    #[test]
    fn a_note_that_takes_a_file_items_name_is_not_sent_as_its_bytes() {
        // A watch pass settles first; a plain scan does not.
        for watching in [true, false] {
            let (dir, folder) = scanned_folder();
            let bytes = vec![0x84; 4096];
            std::fs::write(dir.path().join("archive.bin"), &bytes).unwrap();
            std::fs::write(dir.path().join("note.md"), "a note\n").unwrap();
            assert_eq!(folder.scan().unwrap().created, 2);
            std::fs::rename(dir.path().join("archive.bin"), dir.path().join("notes.md")).unwrap();
            assert_eq!(folder.scan().unwrap().renamed, 1);
            let bound = |path: &str| state::bound_at(&folder.core.conn().unwrap(), path).unwrap();
            let file_item = bound("notes.md").unwrap();
            let note_item = bound("note.md").unwrap().item_id;
            assert_ne!(file_item.item_id, note_item);

            // The note's file, with its id line, written whole at another
            // path and put over the file item's file: a new inode at
            // `notes.md`. The note's old file is gone.
            let note = format!("---\nmarfa_id: {note_item}\n---\na note\n").into_bytes();
            std::fs::write(dir.path().join("note.tmp"), &note).unwrap();
            std::fs::rename(dir.path().join("note.tmp"), dir.path().join("notes.md")).unwrap();
            std::fs::remove_file(dir.path().join("note.md")).unwrap();

            let mut missing = 0;
            if watching {
                let report = folder
                    .scan_watching(true, Duration::from_secs(3600))
                    .unwrap();
                missing += report.missing;
                // A note is sent as soon as it is read, however new its file.
                assert!(report.settling.is_empty(), "{report:?}");
                assert_eq!(bound("notes.md").unwrap().item_id, note_item, "{report:?}");
            }
            let report = folder.scan().unwrap();
            missing += report.missing;
            assert_eq!(missing, 0, "watching {watching}: the note went missing");
            let now = bound("notes.md").unwrap();
            assert_eq!(now.item_id, note_item, "watching {watching}: {report:?}");
            assert!(now.held.is_none(), "watching {watching}: {:?}", now.held);
            assert_eq!(
                now.content_hash,
                state::hash(&note),
                "watching {watching}: the file is not the note"
            );
            let held = folder.core.get(&file_item.item_id).unwrap().unwrap();
            let item = folder.core.get(&note_item).unwrap().unwrap();
            let catalog = Catalog::load(&folder.core.conn().unwrap()).unwrap();
            assert!(bytes_of(&held, &catalog).is_some());
            assert_eq!(item.r#type, "core.note", "watching {watching}");
            assert_ne!(item.state, ItemState::Trashed, "watching {watching}");
            assert_eq!(
                item.properties.get("body").and_then(Value::as_str),
                Some("a note\n"),
                "watching {watching}: the note lost its body"
            );
        }
    }

    /// Settings whose default type takes a note of 200 KB, so a note past the
    /// size warning is created and warned of.
    fn large_text_folder() -> (ScannedDir, Folder) {
        scanned_folder_with(
            serde_json::json!({ "query": {}, "defaults": { "type": "user.large_text" } }),
            Some(serde_json::json!([
                {
                    "id": "user.large_text",
                    "display_hints": { "title_field": "title", "body_field": "body" },
                    "fields": {
                        "title": { "type": "string" },
                        "body": { "type": "string", "maxLength": 1_000_000 },
                    },
                },
            ])),
        )
    }

    #[test]
    fn status_reads_a_file_item_at_a_document_name_as_its_item() {
        // Lone continuation bytes, none of them UTF-8.
        let binary: Vec<u8> = (0..4096).map(|at| 0x80 | (at % 64) as u8).collect();
        // 200 KB of control characters, each sent as six: past the warning.
        let large = "\u{1}".repeat(200_000);
        let mut latin1 = b"caf".to_vec();
        latin1.extend([0xe9, b'\n']);
        for ext in ["md", "markdown", "txt"] {
            let (dir, folder) = large_text_folder();
            let path = |name: &str| dir.path().join(name);
            std::fs::write(path("archive.bin"), &binary).unwrap();
            std::fs::write(path("large.bin"), &large).unwrap();
            assert_eq!(folder.scan().unwrap().created, 2, "{ext}");
            let (archive, big) = (format!("archive.{ext}"), format!("large.{ext}"));
            std::fs::rename(path("archive.bin"), path(&archive)).unwrap();
            std::fs::rename(path("large.bin"), path(&big)).unwrap();
            // The witnesses: a new document that is not UTF-8 is held, and a
            // new note this size is warned of.
            let cafe = format!("cafe.{ext}");
            std::fs::write(path(&cafe), &latin1).unwrap();
            std::fs::write(path("note.md"), &large).unwrap();

            // Before the scan that follows the renames, and after it.
            for when in ["renamed", "scanned"] {
                let status = folder.status().unwrap();
                let of = |name: &str| {
                    status
                        .files
                        .iter()
                        .find(|file| file.path == name)
                        .unwrap_or_else(|| panic!("{ext} {when}: no status for {name}"))
                        .clone()
                };
                for name in [&archive, &big] {
                    let file = of(name);
                    assert_ne!(file.status, "held", "{ext} {when}: {file:?}");
                    assert_eq!(file.flag, None, "{ext} {when}: {file:?}");
                    assert_eq!(file.warning, None, "{ext} {when}: {file:?}");
                }
                let held = of(&cafe);
                assert_eq!(
                    (held.status, held.flag),
                    ("held", Some("encoding")),
                    "{ext} {when}"
                );
                assert!(of("note.md").warning.is_some(), "{ext} {when}");
                if when == "renamed" {
                    let report = folder.scan().unwrap();
                    assert_eq!(report.renamed, 2, "{ext}: {report:?}");
                    let flagged: Vec<&str> =
                        report.flagged.iter().map(|f| f.path.as_str()).collect();
                    assert_eq!(flagged, [cafe.as_str()], "{ext}: {report:?}");
                }
            }
        }
    }

    #[test]
    fn a_file_item_at_a_document_name_waits_for_the_settle_window() {
        let settle = Duration::from_secs(3600);
        for name in ["notes.md", "notes.markdown", "notes.txt"] {
            let (dir, folder) = scanned_folder();
            let bytes = vec![0x85; 4096];
            std::fs::write(dir.path().join("archive.bin"), &bytes).unwrap();
            assert_eq!(folder.scan().unwrap().created, 1, "{name}");
            std::fs::rename(dir.path().join("archive.bin"), dir.path().join(name)).unwrap();
            assert_eq!(folder.scan().unwrap().renamed, 1, "{name}");
            let bound = |folder: &Folder| {
                state::bound_at(&folder.core.conn().unwrap(), name)
                    .unwrap()
                    .unwrap_or_else(|| panic!("{name} is not bound"))
            };
            let before = bound(&folder);

            // Still being written, in place. The witness: a file that is no
            // document, changed beside it, waits too.
            let edited = [bytes.as_slice(), b"."].concat();
            std::fs::write(dir.path().join(name), &edited).unwrap();
            std::fs::write(dir.path().join("witness.bin"), [7, 7, 6]).unwrap();
            let report = folder.scan_watching(true, settle).unwrap();
            let mut settling = report.settling.clone();
            settling.sort();
            assert_eq!(settling, [name, "witness.bin"], "{name}: {report:?}");
            assert_eq!(report.updated, 0, "{name}: {report:?}");
            let waiting = bound(&folder);
            assert_eq!(waiting.item_id, before.item_id, "{name}");
            assert_eq!(waiting.content_hash, before.content_hash, "{name}");

            // Settled, the next quick pass reads it.
            let report = folder.scan_watching(false, Duration::ZERO).unwrap();
            assert_eq!(report.updated, 1, "{name}: {report:?}");
            assert_eq!(bound(&folder).content_hash, state::hash(&edited), "{name}");
        }
    }

    #[test]
    fn a_new_note_where_a_moved_file_item_was_does_not_wait_for_the_settle_window() {
        let (dir, folder, file_item) = note_where_a_file_item_was("---\ntitle: Fresh\n---\nbody\n");
        let report = folder
            .scan_watching(true, Duration::from_secs(3600))
            .unwrap();
        assert!(
            !report.settling.iter().any(|path| path == "notes.md"),
            "{report:?}"
        );
        assert_eq!(report.created, 1, "{report:?}");
        let fresh = state::bound_at(&folder.core.conn().unwrap(), "notes.md")
            .unwrap()
            .expect("the new note is not bound");
        assert_ne!(fresh.item_id, file_item);
        assert_eq!(
            fresh.content_hash,
            state::hash(&std::fs::read(dir.path().join("notes.md")).unwrap())
        );
    }

    #[test]
    fn a_file_items_bytes_at_a_document_name_embed_nothing() {
        for name in ["notes.md", "notes.markdown"] {
            let (dir, folder) = scanned_folder_with(
                serde_json::json!({ "query": { "types": ["core.note", "core.file.audio"] } }),
                None,
            );
            let path = |file: &str| dir.path().join(file);
            std::fs::write(path("archive.mp3"), "![[x.png]]\n").unwrap();
            std::fs::write(path("x.png"), [7, 7, 7]).unwrap();
            let report = folder.scan().unwrap();
            assert_eq!(report.created, 1, "{name}: {report:?}");
            std::fs::rename(path("archive.mp3"), path(name)).unwrap();
            // The witness: a note's embed in the same scan is followed.
            std::fs::write(path("note.md"), "a note\n![[y.png]]\n").unwrap();
            std::fs::write(path("y.png"), [7, 7, 8]).unwrap();
            let report = folder.scan().unwrap();
            assert_eq!(report.renamed, 1, "{name}: {report:?}");
            let bound = |file: &str| state::bound_at(&folder.core.conn().unwrap(), file).unwrap();
            assert!(bound("y.png").is_some(), "{name}: {report:?}");
            assert!(
                bound("x.png").is_none(),
                "{name}: an embed in a file item's bytes was followed"
            );
            assert_eq!(report.created, 2, "{name}: {report:?}");
            assert!(report.embeds.is_empty(), "{name}: {:?}", report.embeds);
            let item = folder
                .core
                .get(&bound(name).unwrap().item_id)
                .unwrap()
                .unwrap();
            assert_eq!(item.r#type, "core.file.audio", "{name}");
        }
    }

    #[test]
    fn a_file_item_moved_from_a_document_name_is_followed_whatever_the_query_says() {
        // The witness first: from a name that is no document, the move is
        // followed though the query holds no type for `archive.bin`.
        for via in [None, Some("notes.md"), Some("notes.markdown")] {
            let (dir, folder) = scanned_folder_with(
                serde_json::json!({ "query": { "types": ["core.note", "core.file.audio"] } }),
                None,
            );
            let path = |file: &str| dir.path().join(file);
            std::fs::write(path("archive.mp3"), [7, 7, 7]).unwrap();
            assert_eq!(folder.scan().unwrap().created, 1, "{via:?}");
            let mut at = "archive.mp3";
            if let Some(via) = via {
                std::fs::rename(path(at), path(via)).unwrap();
                assert_eq!(folder.scan().unwrap().renamed, 1, "{via:?}");
                at = via;
            }
            let item_id = state::bound_at(&folder.core.conn().unwrap(), at)
                .unwrap()
                .unwrap()
                .item_id;
            std::fs::rename(path(at), path("archive.bin")).unwrap();
            let report = folder.scan().unwrap();
            assert_eq!(
                (report.renamed, report.missing),
                (1, 0),
                "{via:?}: {report:?}"
            );
            let bound = state::bound_at(&folder.core.conn().unwrap(), "archive.bin").unwrap();
            assert_eq!(bound.map(|bound| bound.item_id), Some(item_id), "{via:?}");
        }
    }

    #[test]
    fn a_file_without_birth_identity_makes_its_parent_inventory_incomplete() {
        let root = Path::new("root");
        let child = root.join("child");
        let mut complete = Walked::default();
        assert!(complete.file_birth(root, &child, Some(1)));
        assert!(!complete.passed_over("child/old-name.md"));
        assert!(!complete.incomplete());
        for birth in [None, Some(0)] {
            let mut partial = Walked::default();
            assert!(!partial.file_birth(root, &child, birth));
            assert!(partial.passed_over("child/old-name.md"));
            assert_eq!(partial.directories[0].flag, "unreadable");
            assert!(!partial.passed_over("elsewhere/note.md"));
            assert!(
                partial.incomplete(),
                "an unresolved move can start outside the unread subtree"
            );
        }
    }

    #[test]
    fn a_folder_another_process_holds_is_refused_before_it_is_worked() {
        let dir = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let state = dir.path().join(STATE_DIR);
        std::fs::create_dir_all(&state).unwrap();
        let holder = Core::open(state.join("core.sqlite"), None).unwrap();
        settings_file::bind(&holder, "01a00000-0000-7000-8000-000000000001").unwrap();
        assert!(
            matches!(
                Folder::open(dir.path(), None),
                Err(CoreError::ReadingHandle)
            ),
            "a second opener was handed a folder to work beside the one holding it"
        );
        assert!(working(holder).is_ok());
    }

    #[test]
    fn a_folder_waiting_for_its_first_sync_refuses_every_step_that_writes_or_sends() {
        let dir = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let state = dir.path().join(STATE_DIR);
        std::fs::create_dir_all(&state).unwrap();
        let core = Core::open(state.join("core.sqlite"), None).unwrap();
        settings_file::bind(&core, "01a00000-0000-7000-8000-000000000001").unwrap();
        drop(core);
        let folder = Folder::open(dir.path(), None).unwrap();
        assert!(
            !folder.awaiting_confirmation().unwrap(),
            "a store made without an add has never been asked"
        );
        folder.wait_for_confirmation().unwrap();
        assert!(folder.awaiting_confirmation().unwrap());

        assert!(matches!(folder.drain(), Err(CoreError::FirstSyncWaiting)));
        assert!(matches!(folder.pull(), Err(CoreError::FirstSyncWaiting)));
        assert!(matches!(
            folder.send_settings_edit(),
            Err(CoreError::FirstSyncWaiting)
        ));
        assert!(matches!(folder.restore(), Err(CoreError::FirstSyncWaiting)));
        let stop = AtomicBool::new(false);
        assert!(matches!(
            folder.watch(&stop, |_| Ok::<(), ()>(())),
            Err(WatchError::Core(CoreError::FirstSyncWaiting))
        ));

        // The witness: confirmed, the same calls are not refused for waiting.
        assert!(folder.confirm_first_sync().unwrap());
        assert!(!folder.confirm_first_sync().unwrap());
        assert!(!matches!(folder.pull(), Err(CoreError::FirstSyncWaiting)));
        assert!(!matches!(folder.drain(), Err(CoreError::FirstSyncWaiting)));
    }

    /// A folder holding one bound note per name, scanned until the notes are
    /// at rest: the first scan binds each and writes its id line, the second
    /// takes in what the first wrote and records each file's size and time.
    fn settled_notes(names: &[&str]) -> (ScannedDir, Folder) {
        let (dir, folder) = scanned_folder();
        for name in names {
            std::fs::write(
                dir.path().join(name),
                format!("---\ntitle: {name}\n---\nbody\n"),
            )
            .unwrap();
        }
        assert_eq!(folder.scan().unwrap().created, names.len());
        folder.scan().unwrap();
        (dir, folder)
    }

    /// Changes `body` to `edit` in the note at `path`, in place, so its size,
    /// time and identity are what the last read recorded. Only a pass that
    /// reads the file sees it.
    fn edit_unseen(path: &Path, edit: &str) {
        let before = std::fs::metadata(path).unwrap().modified().unwrap();
        let text = std::fs::read_to_string(path).unwrap();
        assert_eq!(edit.len(), "body".len());
        let text = text.replace("body", edit);
        let file = std::fs::File::options().write(true).open(path).unwrap();
        std::io::Write::write_all(&mut &file, text.as_bytes()).unwrap();
        file.set_modified(before).unwrap();
    }

    fn body_of(folder: &Folder, path: &str) -> String {
        let item_id = state::bound_at(&folder.core.conn().unwrap(), path)
            .unwrap()
            .unwrap()
            .item_id;
        let item = folder.core.get(&item_id).unwrap().unwrap();
        item.properties
            .get("body")
            .and_then(Value::as_str)
            .unwrap()
            .to_string()
    }

    // The settle time for `scan_watching`, which only a file that is not a
    // document waits on. No server answers in these tests, so a bound note
    // whose write is unanswered counts as `waiting`, not `unchanged`.
    const QUICK: Duration = Duration::from_secs(3600);

    #[test]
    fn a_quick_pass_does_not_reread_an_unchanged_bound_document() {
        let (dir, folder) = settled_notes(&["a.md", "b.md"]);
        edit_unseen(&dir.path().join("a.md"), "bad1");
        let report = folder.scan_watching(false, QUICK).unwrap();
        assert_eq!(report.waiting, 2, "{report:?}");
        assert_eq!(report.updated + report.created + report.renamed, 0);
        assert!(body_of(&folder, "a.md").starts_with("body"));

        // The witness: a full pass over the same state reads the file and
        // takes the edit.
        let report = folder.scan_watching(true, QUICK).unwrap();
        assert_eq!(report.updated, 1, "{report:?}");
        assert!(body_of(&folder, "a.md").starts_with("bad1"));

        // So does a plain scan.
        edit_unseen(&dir.path().join("b.md"), "bad2");
        let report = folder.scan().unwrap();
        assert_eq!(report.updated, 1, "{report:?}");
        assert!(body_of(&folder, "b.md").starts_with("bad2"));
    }

    #[test]
    fn a_quick_pass_reads_a_file_whose_size_or_time_changed() {
        let (dir, folder) = settled_notes(&["a.md", "b.md", "c.md", "d.md"]);
        let path = |name: &str| dir.path().join(name);
        // a: another size.
        let mut text = std::fs::read_to_string(path("a.md")).unwrap();
        text.push_str("more\n");
        std::fs::write(path("a.md"), text).unwrap();
        // b: the same size and new bytes, with another time.
        edit_unseen(&path("b.md"), "bad1");
        let earlier =
            std::fs::metadata(path("b.md")).unwrap().modified().unwrap() - Duration::from_secs(5);
        std::fs::File::options()
            .write(true)
            .open(path("b.md"))
            .unwrap()
            .set_modified(earlier)
            .unwrap();
        // c: unseen, as in the witness.
        edit_unseen(&path("c.md"), "bad2");
        let report = folder.scan_watching(false, QUICK).unwrap();
        assert_eq!(report.updated, 2, "{report:?}");
        assert_eq!(report.waiting, 2, "{report:?}");
        assert!(body_of(&folder, "a.md").contains("more"));
        assert!(body_of(&folder, "b.md").starts_with("bad1"));
        assert!(body_of(&folder, "c.md").starts_with("body"));
        assert!(body_of(&folder, "d.md").starts_with("body"));
    }

    #[test]
    fn a_quick_pass_finds_a_copy_of_a_bound_file_and_rereads_the_original() {
        let (dir, folder) = settled_notes(&["a.md", "b.md"]);
        let path = |name: &str| dir.path().join(name);
        // The copy names the item the original is bound to.
        let item_id = state::bound_at(&folder.core.conn().unwrap(), "a.md")
            .unwrap()
            .unwrap()
            .item_id;
        std::fs::write(
            path("copy.md"),
            format!("---\nmarfa_id: {item_id}\ntitle: a.md\n---\nbody\n"),
        )
        .unwrap();
        // Neither original changed in size or time, so only a read sees these.
        edit_unseen(&path("a.md"), "bad1");
        edit_unseen(&path("b.md"), "bad2");
        let report = folder.scan_watching(false, QUICK).unwrap();
        assert!(body_of(&folder, "b.md").starts_with("body"), "{report:?}");
        // The original was read: its edit was taken, and the copy was too.
        assert!(body_of(&folder, "a.md").starts_with("bad1"), "{report:?}");
        assert!(
            state::bound_at(&folder.core.conn().unwrap(), "copy.md")
                .unwrap()
                .is_some()
        );
        assert_eq!(
            (
                report.created,
                report.updated,
                report.renamed,
                report.waiting
            ),
            (1, 1, 0, 1),
            "{report:?}"
        );
    }

    /// A note a pull moved from `a.md` to `moved.md`, and an editor's save of
    /// its old buffer, with another body, at `a.md` in a new file.
    fn moved_note_with_a_stale_save() -> (ScannedDir, Folder, String) {
        let (dir, folder) = settled_notes(&["a.md"]);
        let item_id = state::bound_at(&folder.core.conn().unwrap(), "a.md")
            .unwrap()
            .unwrap()
            .item_id;
        std::fs::rename(dir.path().join("a.md"), dir.path().join("moved.md")).unwrap();
        {
            let conn = folder.core.conn().unwrap();
            let bound = state::bound_at(&conn, "a.md").unwrap().unwrap();
            state::unbind(&conn, "a.md").unwrap();
            state::bind(
                &conn,
                &state::Bound {
                    path: "moved.md".into(),
                    ..bound
                },
            )
            .unwrap();
            state::set_moved_from(
                &conn,
                &item_id,
                &state::MovedFrom {
                    path: "a.md".into(),
                    version: 5,
                },
            )
            .unwrap();
        }
        std::fs::write(
            dir.path().join("a.md"),
            format!("---\nmarfa_id: {item_id}\nmarfa_version: 3\ntitle: a.md\n---\nstal\n"),
        )
        .unwrap();
        (dir, folder, item_id)
    }

    fn flagged_waiting(report: &ScanReport) -> Vec<(&str, &str)> {
        report
            .flagged
            .iter()
            .map(|flagged| (flagged.path.as_str(), flagged.flag))
            .collect()
    }

    fn read(dir: &Path, name: &str) -> Option<String> {
        std::fs::read_to_string(dir.join(name)).ok()
    }

    #[test]
    fn a_scan_that_writes_files_takes_a_save_at_the_path_a_file_was_moved_from() {
        let (dir, folder, item_id) = moved_note_with_a_stale_save();
        let save = read(dir.path(), "a.md").unwrap();
        let report = folder.scan().unwrap();
        assert_eq!((report.created, report.updated), (0, 1), "{report:?}");
        assert!(report.flagged.is_empty(), "{report:?}");
        // The save took the moved file's place; no file is left at the old path.
        assert_eq!(read(dir.path(), "a.md"), None);
        assert_eq!(read(dir.path(), "moved.md"), Some(save));
        let conn = folder.core.conn().unwrap();
        let bound: Vec<_> = state::every_bound(&conn)
            .unwrap()
            .into_iter()
            .map(|bound| (bound.path, bound.item_id))
            .collect();
        assert_eq!(bound, [("moved.md".to_string(), item_id.clone())]);
        // An old buffer taken is no edit of the moved file: the record stays.
        assert!(state::moved_from(&conn).unwrap().contains_key(&item_id));
        assert!(state::stale_waits(&conn).unwrap().is_empty());
        drop(conn);
        assert!(body_of(&folder, "moved.md").starts_with("stal"));
        assert_eq!(folder.scan().unwrap().missing, 0);
    }

    #[test]
    fn a_scan_that_keeps_files_leaves_a_save_at_the_old_path_for_the_scan_that_writes() {
        let (dir, folder, item_id) = moved_note_with_a_stale_save();
        let save = read(dir.path(), "a.md").unwrap();
        let moved = read(dir.path(), "moved.md").unwrap();
        let report = folder.scan_keeping_files().unwrap();
        assert_eq!(
            flagged_waiting(&report),
            [("a.md", "waiting")],
            "{report:?}"
        );
        assert_eq!(
            report.flagged[0].reason,
            "it is an old copy of moved.md, which a push that writes files takes"
        );
        assert_eq!((report.created, report.updated), (0, 0), "{report:?}");
        assert_eq!(read(dir.path(), "a.md"), Some(save.clone()));
        assert_eq!(read(dir.path(), "moved.md"), Some(moved));
        let conn = folder.core.conn().unwrap();
        // Held in this pass alone: no record keeps it, and no item is made.
        assert!(state::stale_waits(&conn).unwrap().is_empty());
        assert!(state::bound_at(&conn, "a.md").unwrap().is_none());
        assert!(state::moved_from(&conn).unwrap().contains_key(&item_id));
        drop(conn);
        assert!(body_of(&folder, "moved.md").starts_with("body"));

        // The witness: the scan that writes files takes the same save.
        let report = folder.scan().unwrap();
        assert!(report.flagged.is_empty(), "{report:?}");
        assert_eq!(read(dir.path(), "a.md"), None);
        assert_eq!(read(dir.path(), "moved.md"), Some(save));
    }

    #[test]
    fn a_save_is_held_while_the_moved_file_holds_an_edit_of_its_own() {
        for keeping in [false, true] {
            let (dir, folder, item_id) = moved_note_with_a_stale_save();
            let save = read(dir.path(), "a.md").unwrap();
            edit_unseen(&dir.path().join("moved.md"), "edit");
            let report = if keeping {
                folder.scan_keeping_files()
            } else {
                folder.scan()
            }
            .unwrap();
            let reason = "it is an old copy of moved.md, which holds an edit of its own; keep one of the two";
            assert_eq!(
                flagged_waiting(&report),
                [("a.md", "waiting")],
                "{keeping}: {report:?}"
            );
            assert_eq!(report.flagged[0].reason, reason, "{keeping}");
            assert_eq!(read(dir.path(), "a.md"), Some(save.clone()), "{keeping}");
            let conn = folder.core.conn().unwrap();
            let waits = state::stale_waits(&conn).unwrap();
            assert_eq!(waits.len(), 1, "{keeping}");
            assert_eq!(waits["a.md"].reason, reason);
            assert_eq!(waits["a.md"].hash, state::hash(save.as_bytes()));
            assert!(state::bound_at(&conn, "a.md").unwrap().is_none());
            drop(conn);
            // The moved file's own edit is not the save's to lose.
            assert!(
                read(dir.path(), "moved.md").unwrap().contains("edit"),
                "{keeping}"
            );
            // Either mode sends it: keeping files withholds only file writes.
            let kept = body_of(&folder, "moved.md");
            assert!(kept.starts_with("edit"), "{keeping}: {kept}");
            // Held until the save changes, though the edit has ended the
            // record of the move.
            assert!(
                !state::moved_from(&folder.core.conn().unwrap())
                    .unwrap()
                    .contains_key(&item_id),
                "{keeping}"
            );
            let again = folder.scan().unwrap();
            assert_eq!(flagged_waiting(&again), [("a.md", "waiting")], "{keeping}");
        }
    }

    /// As if the copy had synced and the server had taken the folder's
    /// create of the file's item, so a pull reaches it, and the item's id.
    fn landed(folder: &Folder, path: &str) -> String {
        use crate::store::{self, meta_set};
        let conn = folder.core.conn().unwrap();
        meta_set(&conn, store::META_EVENT_CURSOR, "10").unwrap();
        meta_set(&conn, crate::reach::FENCE, crate::scripted::FENCE).unwrap();
        meta_set(&conn, store::META_INSTANCE_ID, crate::scripted::INSTANCE).unwrap();
        meta_set(
            &conn,
            store::META_SLICE_TYPES,
            "[\"core.note\",\"core.file\"]",
        )
        .unwrap();
        meta_set(&conn, store::META_SLICE_TIER, "library").unwrap();
        let item_id = state::bound_at(&conn, path).unwrap().unwrap().item_id;
        conn.execute("UPDATE items SET version = 1 WHERE id = ?1", [&item_id])
            .unwrap();
        item_id
    }

    /// Moves the journaled delete at `path` past the grace.
    fn past_the_grace(folder: &Folder, path: &str) {
        let long_ago = crate::store::iso_at(
            crate::clock::system_time() - RENAME_GRACE - Duration::from_secs(1),
        );
        let conn = folder.core.conn().unwrap();
        let aged = conn
            .execute(
                "UPDATE folder_journal SET missing_since = ?2 WHERE path = ?1",
                [path, long_ago.as_str()],
            )
            .unwrap();
        assert_eq!(aged, 1, "{path} is not journaled");
    }

    fn kept(folder: &Folder, path: &str) -> Option<state::Kept> {
        state::journaled(&folder.core.conn().unwrap())
            .unwrap()
            .into_iter()
            .find(|row| row.path == path)
            .and_then(|row| row.kept)
    }

    #[test]
    fn a_file_kept_for_the_folder_it_moved_to_is_looked_for_there_once_a_full_pass() {
        let (_, _registry) = registry::tests::own_registry();
        let query = serde_json::json!({ "query": {} });
        let (from, a) = folder_with("01a00000-0000-7000-8000-0000000000b1", query.clone(), None);
        let (to, b) = folder_with("01a00000-0000-7000-8000-0000000000b2", query, None);
        b.scan().unwrap();
        std::fs::write(from.path().join("photo.bin"), [7, 7, 7]).unwrap();
        assert_eq!(a.scan().unwrap().created, 1);
        landed(&a, "photo.bin");
        std::fs::rename(from.path().join("photo.bin"), to.path().join("photo.bin")).unwrap();
        assert_eq!(a.scan().unwrap().missing, 1);
        past_the_grace(&a, "photo.bin");
        peers_walked();

        // The witness: deciding walks the other folder, even in a quick pass.
        let decided = a.scan_watching(false, QUICK).unwrap();
        assert_eq!(peers_walked(), 1);
        assert_eq!(decided.moved_away, 0, "{decided:?}");
        assert_eq!(kept(&a, "photo.bin"), Some(state::Kept::Arriving));

        let quick = a.scan_watching(false, QUICK).unwrap();
        assert_eq!(
            peers_walked(),
            0,
            "a quick pass walked the other folder for a file the last sweep kept"
        );
        assert!(quick.unsure.is_empty(), "{quick:?}");
        let pulled = a.pull().unwrap();
        assert_eq!(
            peers_walked(),
            0,
            "a pull walked the other folder for a missing file"
        );
        assert_eq!(pulled.elsewhere, 1, "{pulled:?}");
        assert!(!from.path().join("photo.bin").exists());

        a.scan().unwrap();
        assert_eq!(peers_walked(), 1, "a full pass did not look again");
        assert_eq!(kept(&a, "photo.bin"), Some(state::Kept::Arriving));
    }

    #[test]
    fn a_pull_writes_back_no_missing_file_the_sweep_holds_as_unsure() {
        let (registry, _registry) = registry::tests::own_registry();
        let (dir, folder) = folder_with(
            "01a00000-0000-7000-8000-0000000000c1",
            serde_json::json!({ "query": {} }),
            None,
        );
        let names = ["restored.txt", "held.txt", "graced.txt"];
        for name in names {
            std::fs::write(dir.path().join(name), format!("{name} words\n")).unwrap();
        }
        assert_eq!(folder.scan().unwrap().created, 3);
        let [restored, held_id, graced] = names.map(|name| landed(&folder, name));

        // The witness: a missing file no other folder holds is written back
        // with its item's change.
        std::fs::remove_file(dir.path().join("restored.txt")).unwrap();
        assert_eq!(folder.scan().unwrap().missing, 1);
        changed_elsewhere(&folder, &restored, "changed elsewhere");
        let pulled = folder.pull().unwrap();
        assert!(dir.path().join("restored.txt").exists(), "{pulled:?}");
        assert_eq!(pulled.revived, 1, "{pulled:?}");

        for name in ["held.txt", "graced.txt"] {
            std::fs::remove_file(dir.path().join(name)).unwrap();
        }
        assert_eq!(folder.scan().unwrap().missing, 2);
        past_the_grace(&folder, "held.txt");
        std::fs::write(registry.path(), "not a registry").unwrap();
        let held = folder.scan().unwrap();
        assert_eq!(
            held.unsure
                .iter()
                .map(|file| file.path.as_str())
                .collect::<Vec<_>>(),
            ["held.txt"],
            "{held:?}"
        );
        assert!(matches!(
            kept(&folder, "held.txt"),
            Some(state::Kept::Unsure(_))
        ));
        let quick = folder.scan_watching(false, QUICK).unwrap();
        assert_eq!(
            quick.unsure, held.unsure,
            "a quick pass forgot why it holds"
        );
        for id in [&held_id, &graced] {
            changed_elsewhere(&folder, id, "changed elsewhere");
        }

        // Past the grace or inside it, a file that may have moved to a folder
        // the registry no longer names stays unwritten.
        let pulled = folder.pull().unwrap();
        for name in ["held.txt", "graced.txt"] {
            assert!(
                !dir.path().join(name).exists(),
                "{name}, whose move cannot be told, was written back: {pulled:?}"
            );
        }
        assert_eq!(pulled.revived, 0, "{pulled:?}");
        assert_eq!(pulled.elsewhere, 0, "{pulled:?}");
    }

    #[test]
    fn a_sweep_queues_no_delete_of_an_item_changed_elsewhere_while_it_decides() {
        let (_, _registry) = registry::tests::own_registry();
        let (dir, folder) = folder_with(
            "01a00000-0000-7000-8000-0000000000c2",
            serde_json::json!({ "query": {} }),
            None,
        );
        std::fs::write(dir.path().join("note.txt"), "the person's words\n").unwrap();
        assert_eq!(folder.scan().unwrap().created, 1);
        let id = landed(&folder, "note.txt");
        std::fs::remove_file(dir.path().join("note.txt")).unwrap();
        assert_eq!(folder.scan().unwrap().missing, 1);
        past_the_grace(&folder, "note.txt");

        // A follow applies another device's change once the sweep has
        // found nothing changed and before it queues the delete.
        let point = &format!("folder-sweep-decided:{id}");
        crate::fault::arm(point);
        // The sweep stays on this thread, which holds this test's registry.
        let swept = std::thread::scope(|scope| {
            let following = scope.spawn(|| {
                let waited = std::time::Instant::now();
                while crate::fault::waiting(point) == 0 {
                    if waited.elapsed() > Duration::from_secs(10) {
                        crate::fault::release(point);
                        panic!("the sweep never decided");
                    }
                    std::thread::sleep(Duration::from_millis(5));
                }
                changed_elsewhere(&folder, &id, "changed elsewhere");
                crate::fault::release(point);
            });
            let swept = folder.scan();
            following.join().unwrap();
            swept
        })
        .unwrap();
        let deletes: Vec<_> = folder
            .core
            .queue()
            .unwrap()
            .into_iter()
            .filter(|write| write.kind == crate::model::WriteKind::DeleteItem)
            .map(|write| write.base_version)
            .collect();
        assert_eq!(
            deletes,
            Vec::<Option<i64>>::new(),
            "a delete was queued over a change the sweep never saw: {swept:?}"
        );
        assert!(swept.trashed.is_empty(), "{swept:?}");
        let pulled = folder.pull().unwrap();
        assert_eq!(pulled.revived, 1, "{pulled:?}");
        assert!(
            std::fs::read_to_string(dir.path().join("note.txt"))
                .unwrap()
                .contains("changed elsewhere")
        );
    }

    #[test]
    fn a_sweep_with_no_server_trashes_a_file_item_whose_bytes_it_no_longer_holds() {
        let (_, _registry) = registry::tests::own_registry();
        let (dir, folder) = folder_with(
            "01a00000-0000-7000-8000-0000000000c3",
            serde_json::json!({ "query": {} }),
            None,
        );
        for name in ["kept.bin", "changed.bin"] {
            std::fs::write(dir.path().join(name), name.as_bytes()).unwrap();
        }
        assert_eq!(folder.scan().unwrap().created, 2);
        let [unchanged, changed] = ["kept.bin", "changed.bin"].map(|name| landed(&folder, name));
        // As a pull leaves a file item it wrote: its bytes on the disk alone.
        folder
            .core
            .conn()
            .unwrap()
            .execute(
                "DELETE FROM queue WHERE kind = ?1",
                [crate::model::WriteKind::UploadBlob.as_str()],
            )
            .unwrap();
        let catalog = Catalog::load(&folder.core.conn().unwrap()).unwrap();
        for id in [&unchanged, &changed] {
            let item = folder.core.get(id).unwrap().unwrap();
            let blob = bytes_of(&item, &catalog).unwrap();
            folder.core.let_go_blob(blob);
            assert!(folder.core.blob_file(blob).is_err(), "{blob} is still held");
        }
        for name in ["kept.bin", "changed.bin"] {
            std::fs::remove_file(dir.path().join(name)).unwrap();
        }
        assert_eq!(folder.scan().unwrap().missing, 2);
        // The witness: bytes changed elsewhere bring the file back.
        folder
            .core
            .conn()
            .unwrap()
            .execute(
                "UPDATE items SET version = version + 1,
                   properties = json_set(properties, '$.blob_ref', ?2)
                 WHERE id = ?1",
                [&changed, &crate::blob::name_of(b"theirs")],
            )
            .unwrap();
        for name in ["kept.bin", "changed.bin"] {
            past_the_grace(&folder, name);
        }
        let swept = folder.scan().unwrap();
        assert_eq!(swept.trashed, ["kept.bin"], "{swept:?}");
        let deleted: Vec<_> = folder
            .core
            .queue()
            .unwrap()
            .into_iter()
            .filter(|write| write.kind == crate::model::WriteKind::DeleteItem)
            .filter_map(|write| write.item_id)
            .collect();
        assert_eq!(deleted, [unchanged]);
        assert_eq!(kept(&folder, "changed.bin"), None);
        assert!(
            state::bound_at(&folder.core.conn().unwrap(), "changed.bin")
                .unwrap()
                .is_some()
        );
    }

    /// As if another device had changed the item's body to `body`.
    fn changed_elsewhere(folder: &Folder, item_id: &str, body: &str) {
        folder
            .core
            .conn()
            .unwrap()
            .execute(
                "UPDATE items SET version = version + 1,
                   properties = json_set(properties, '$.body', ?2)
                 WHERE id = ?1",
                [item_id, body],
            )
            .unwrap();
    }

    /// The files in the folder, its own state left out, with what each holds.
    fn files_in(dir: &Path) -> Vec<(String, String)> {
        let mut files: Vec<_> = walkdir(dir)
            .into_iter()
            .map(|path| {
                let text = std::fs::read_to_string(&path).unwrap();
                let name = path
                    .strip_prefix(dir)
                    .unwrap()
                    .to_string_lossy()
                    .into_owned();
                (name, text)
            })
            .collect();
        files.sort();
        files
    }

    fn walkdir(dir: &Path) -> Vec<std::path::PathBuf> {
        let mut found = Vec::new();
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.file_name().is_some_and(|name| name == STATE_DIR) {
                continue;
            }
            if path.is_dir() {
                found.extend(walkdir(&path));
            } else {
                found.push(path);
            }
        }
        found
    }

    fn bound_paths(folder: &Folder) -> Vec<(String, String)> {
        state::every_bound(&folder.core.conn().unwrap())
            .unwrap()
            .into_iter()
            .map(|bound| (bound.path, bound.item_id))
            .collect()
    }

    #[test]
    fn a_pull_writes_back_no_file_moved_since_the_scan() {
        // Where the file goes, and the edit the person made in it as it went.
        for (to, edit) in [
            ("moved.md", None),
            ("sub/moved.md", None),
            ("moved.md", Some("mine")),
        ] {
            let (dir, folder) = settled_notes(&["a.md"]);
            let item_id = landed(&folder, "a.md");
            if let Some(parent) = Path::new(to).parent() {
                std::fs::create_dir_all(dir.path().join(parent)).unwrap();
            }
            std::fs::rename(dir.path().join("a.md"), dir.path().join(to)).unwrap();
            if let Some(edit) = edit {
                let text = read(dir.path(), to).unwrap().replace("body", edit);
                std::fs::write(dir.path().join(to), text).unwrap();
            }

            let pulled = folder.pull().unwrap();
            assert!(
                !dir.path().join("a.md").exists(),
                "{to} {edit:?}: the pull wrote back a file moved since the scan: {pulled:?}"
            );
            assert_eq!(pulled.written + pulled.rewritten, 0, "{to}: {pulled:?}");
            assert_eq!(pulled.unwritten, 1, "{to}: {pulled:?}");

            let scanned = folder.scan().unwrap();
            assert_eq!(
                (scanned.created, scanned.renamed, scanned.missing),
                (0, 1, 0),
                "{to}: {scanned:?}"
            );
            folder.pull().unwrap();
            folder.scan().unwrap();
            let files = files_in(dir.path());
            assert_eq!(files.len(), 1, "{to}: {files:?}");
            assert_eq!(files[0].0, to);
            assert!(files[0].1.contains(&format!("marfa_id: {item_id}")));
            assert_eq!(bound_paths(&folder), [(to.to_string(), item_id.clone())]);
            // The item followed the move: its title is the new name.
            let item = folder.core.get(&item_id).unwrap().unwrap();
            assert_eq!(item.properties["title"], "moved", "{to}");
            if let Some(edit) = edit {
                assert!(files[0].1.contains(edit), "{to}: {files:?}");
                assert!(body_of(&folder, to).starts_with(edit));
            }
        }
    }

    #[test]
    fn a_pull_writes_back_no_file_deleted_since_the_scan_and_the_delete_stands() {
        // A note the pull has written into, and one deleted before the
        // folder wrote its own lines into it.
        for written in [true, false] {
            let (dir, folder) = settled_notes(&["a.md"]);
            let item_id = landed(&folder, "a.md");
            if written {
                // Shown before the delete, so the item has moved on in
                // nothing the file shows once it is gone.
                changed_elsewhere(&folder, &item_id, "from b");
                folder.pull().unwrap();
                folder.scan().unwrap();
                assert!(read(dir.path(), "a.md").unwrap().contains("from b"));
            }
            std::fs::remove_file(dir.path().join("a.md")).unwrap();

            let pulled = folder.pull().unwrap();
            assert!(!dir.path().join("a.md").exists(), "{written}: {pulled:?}");
            assert_eq!(pulled.unwritten, 1, "{written}: {pulled:?}");

            assert_eq!(folder.scan().unwrap().missing, 1);
            let pulled = folder.pull().unwrap();
            assert_eq!(pulled.revived, 0, "{written}: {pulled:?}");
            assert!(!dir.path().join("a.md").exists(), "{written}");
            past_the_grace(&folder, "a.md");
            let swept = folder.scan().unwrap();
            assert_eq!(swept.deleted, 1, "{written}: {swept:?}");
            assert_eq!(swept.trashed, ["a.md"], "{written}");
            assert!(files_in(dir.path()).is_empty());
            folder.pull().unwrap();
            assert!(files_in(dir.path()).is_empty());
            assert!(bound_paths(&folder).is_empty(), "{written}");
        }
    }

    #[test]
    fn a_file_deleted_since_the_scan_comes_back_once_journaled_for_a_change_it_shows() {
        let (dir, folder) = settled_notes(&["a.md"]);
        let item_id = landed(&folder, "a.md");
        std::fs::remove_file(dir.path().join("a.md")).unwrap();
        changed_elsewhere(&folder, &item_id, "from b");

        let pulled = folder.pull().unwrap();
        assert!(!dir.path().join("a.md").exists(), "{pulled:?}");
        assert_eq!(pulled.unwritten, 1, "{pulled:?}");

        // The scan journals it, and the pull after revives it inside the grace.
        assert_eq!(folder.scan().unwrap().missing, 1);
        let revived = folder.pull().unwrap();
        assert_eq!(revived.revived, 1, "{revived:?}");
        let files = files_in(dir.path());
        assert_eq!(files.len(), 1, "{files:?}");
        assert!(files[0].1.contains("from b"));
        assert!(files[0].1.contains(&format!("marfa_id: {item_id}")));
        let scanned = folder.scan().unwrap();
        assert_eq!((scanned.created, scanned.missing), (0, 0), "{scanned:?}");
        assert!(
            state::journaled(&folder.core.conn().unwrap())
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn a_file_the_pull_wrote_and_then_gone_since_the_scan_is_unwritten_not_unchanged() {
        // Kept in place, the witness; deleted; moved.
        for gone in [None, Some(None), Some(Some("moved.md"))] {
            let (dir, folder) = settled_notes(&["a.md"]);
            let item_id = landed(&folder, "a.md");
            std::fs::remove_file(dir.path().join("a.md")).unwrap();
            changed_elsewhere(&folder, &item_id, "from b");
            folder.pull().unwrap();
            assert_eq!(folder.scan().unwrap().missing, 1);
            // Revived, the file is all the pull's: no line in it was typed.
            assert_eq!(folder.pull().unwrap().revived, 1, "{gone:?}");
            folder.scan().unwrap();
            let revived = read(dir.path(), "a.md").unwrap();
            match gone {
                None => {}
                Some(None) => std::fs::remove_file(dir.path().join("a.md")).unwrap(),
                Some(Some(to)) => {
                    std::fs::rename(dir.path().join("a.md"), dir.path().join(to)).unwrap();
                }
            }

            let pulled = folder.pull().unwrap();
            assert_eq!(pulled.written + pulled.rewritten, 0, "{gone:?}: {pulled:?}");
            if gone.is_none() {
                assert_eq!((pulled.unchanged, pulled.unwritten), (1, 0), "{pulled:?}");
                assert!(pulled.flagged.is_empty(), "{pulled:?}");
                assert_eq!(read(dir.path(), "a.md"), Some(revived));
                continue;
            }
            assert_eq!(
                (pulled.unchanged, pulled.unwritten),
                (0, 1),
                "{gone:?}: {pulled:?}"
            );
            assert_eq!(pulled.flagged.len(), 1, "{pulled:?}");
            assert_eq!(
                (pulled.flagged[0].path.as_str(), pulled.flagged[0].flag),
                ("a.md", "unwritten")
            );
            assert!(!dir.path().join("a.md").exists(), "{gone:?}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_pull_writes_nothing_over_a_file_it_cannot_read() {
        use std::os::unix::fs::PermissionsExt;
        let (dir, folder) = settled_notes(&["a.md"]);
        let item_id = landed(&folder, "a.md");
        changed_elsewhere(&folder, &item_id, "from b");
        let path = dir.path().join("a.md");
        let before = std::fs::read(&path).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).unwrap();
        if std::fs::read(&path).is_ok() {
            // Run as a user every file is readable to.
            return;
        }

        let pulled = folder.pull().unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(pulled.unwritten, 1, "{pulled:?}");
        assert_eq!(pulled.written + pulled.rewritten, 0, "{pulled:?}");
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert_eq!(bound_paths(&folder), [("a.md".to_string(), item_id)]);
        assert!(
            state::journaled(&folder.core.conn().unwrap())
                .unwrap()
                .is_empty()
        );
        // The witness: readable again, the same pull writes the change.
        folder.pull().unwrap();
        assert!(read(dir.path(), "a.md").unwrap().contains("from b"));
    }

    #[test]
    fn a_pull_writes_into_a_present_file_changed_elsewhere() {
        // The witness for the tests above: the same pull with the file in
        // place writes the change.
        let (dir, folder) = settled_notes(&["a.md"]);
        let item_id = landed(&folder, "a.md");
        changed_elsewhere(&folder, &item_id, "from b");
        let pulled = folder.pull().unwrap();
        assert_eq!(pulled.unwritten, 0, "{pulled:?}");
        assert!(read(dir.path(), "a.md").unwrap().contains("from b"));
    }
}
