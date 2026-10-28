#[cfg(test)]
mod attachment_tests;
mod blob;
mod body;
mod builtin;
mod catalog;
mod catch_up;
/// Public so a debug build's binding can move the clock it waits by.
pub mod clock;
pub mod contract;
mod directory;
#[cfg(unix)]
mod directory_vfs;
#[cfg(not(unix))]
#[path = "directory_vfs_unsupported.rs"]
mod directory_vfs;
mod drain;
mod error;
/// Public so the binary can name a fault of its own.
pub mod fault;
mod file_cache;
mod filter;
pub mod folder;
mod folder_settings;
/// Public for the call shapes it shares with the binary's own transport.
pub mod http;
mod hydrate;
#[cfg(test)]
mod hydrate_refill_tests;
#[cfg(test)]
mod hydrate_resume_tests;
mod instance;
mod integers;
mod js;
mod lock;
mod model;
mod names;
mod priority;
mod query;
mod reach;
#[cfg(test)]
mod refusal_tests;
#[cfg(test)]
mod relocation_tests;
#[cfg(test)]
mod remove_tests;
#[cfg(test)]
mod replace_tests;
mod scaffold;
#[cfg(test)]
mod scripted;
mod search;
mod sse;
#[cfg(test)]
mod stop_tests;
mod store;
mod telemetry;
#[cfg(all(test, feature = "telemetry"))]
mod telemetry_tests;
#[cfg(test)]
mod tier_tests;
mod time;
#[cfg(test)]
mod upload_credential_tests;
mod url_host;
mod validation;
mod view_writes;
mod views;
mod watch;
#[cfg(test)]
mod watch_tests;
mod wire;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use rusqlite::Connection;
use serde_json::Value;

pub use blob::{file_type_for, mime_type_for};
pub use body::{BodyLinks, BodyName, BodyTarget};
pub use catalog::{EdgeType, End, ItemType, ServerCatalog, TypeField, WrittenAt};
pub use catch_up::{Change, ChangeEvent, FollowReport};
pub use drain::{DrainReport, DrainVerdict};
pub use error::{CODES as ERROR_CODES, CoreError, CoreErrorKind, FolderStore};
pub use file_cache::{
    Attachments, DEFAULT_FLOOR as FILE_BUDGET_FLOOR, FileBudget, FileCache, KeptFetch, NotHeld,
    NotHeldReason,
};
pub use folder::{
    CaughtUp, Confirmed, Drained, FOLDER_TYPE, FileStatus, FirstSync, Folder, Paused, PullReport,
    Removal, Restored, ScanReport, SendReport, Settings, SettingsFileReport, StatusReport,
    StorageCause, SyncReport, Synced, Unmatched, UnmatchedRemoved, WatchEnd, WatchError,
    WatchEvent, WatchPass,
};
pub use folder_settings::FolderRow;
pub use instance::{InstanceDescription, instance_description};
pub use integers::refuse_inexact_integers;
pub use lock::Handle;
pub use model::{
    Added, Attached, Attachment, BinPage, BlockedReason, CatchUpFailed, CatchUpReport,
    Completeness, Draft, Edge, EdgeDraft, EdgeEdit, Edit, FieldRefusal, GrantKind, GrantLevel,
    HydrateReport, HydrateRestart, Hydration, Item, ItemState, LastFailure, ListFilters,
    MetadataWrite, MissingGrant, Outcome, QueuedWrite, Refusal, Rows, SearchFilters, SearchHit,
    Shown, SliceTier, Sort, SortDirection, SortField, Status, Thumbnail, Tier, UnregisteredType,
    Verdict, WriteKind,
};
pub use scaffold::{ScaffoldField, scaffold_type};
pub use store::CEILING;
pub use views::{VIEW_TYPE, ViewGroup, ViewRow};
pub use watch::{Listening, WatchListener};
#[cfg(debug_assertions)]
pub use watch::{ReentryAnswers, ReentryProbe};

pub type Result<T> = std::result::Result<T, CoreError>;

/// Made readable by its owner alone where it is absent: a store holds what a
/// key reads, and the process umask would let every account on the machine
/// read it. SQLite gives its journal files the store's own mode.
pub(crate) fn owner_only(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)
        {
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => {
                return Err(CoreError::Store(format!(
                    "{} cannot be made: {error}",
                    path.display()
                )));
            }
        }
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

/// Removes the file, folder or symbolic link at `name`, following no link,
/// so nothing outside `name` goes. A name already absent is removed.
pub(crate) fn remove_name(name: &Path) -> Result<()> {
    let removed = match name.symlink_metadata() {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => Err(error),
        // `remove_dir_all` removes a link inside the folder, never what it
        // leads to.
        Ok(held) if held.is_dir() => std::fs::remove_dir_all(name),
        Ok(_) => std::fs::remove_file(name),
    };
    match removed {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(CoreError::Store(format!(
            "{} cannot be removed: {error}",
            name.display()
        ))),
    }
}

/// For the calls that cannot be stopped.
pub(crate) static NEVER_STOPPED: AtomicBool = AtomicBool::new(false);

/// What moves the one cursor now.
#[derive(Default)]
struct Streaming {
    holder: Option<Mover>,
    /// A follow is open, holding the stream or waiting for a hydration
    /// without it, so a second follow is refused at once.
    following: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mover {
    Hydration,
    CatchUp,
    Follow,
}

struct StreamClaim<'a>(&'a Mutex<Streaming>);

impl Drop for StreamClaim<'_> {
    fn drop(&mut self) {
        streaming_of(self.0).holder = None;
    }
}

struct FollowClaim<'a>(&'a Mutex<Streaming>);

impl Drop for FollowClaim<'_> {
    fn drop(&mut self) {
        streaming_of(self.0).following = false;
    }
}

/// Holds nothing a panic could leave half-written.
fn streaming_of(streaming: &Mutex<Streaming>) -> MutexGuard<'_, Streaming> {
    streaming
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn one_at_a_time() -> CoreError {
    CoreError::Invalid(
        "this working copy is already hydrating, catching up or following; one at a time moves \
         its cursor"
            .into(),
    )
}

/// Where a blob's bytes are held. No trim in this process, through any
/// handle on the store or on any thread, takes them while this is held.
#[derive(Debug)]
pub struct BlobPath {
    path: PathBuf,
    _reading: blob::Reading,
}

impl BlobPath {
    pub fn path(&self) -> &Path {
        &self.path
    }
}

/// The key is held in memory and never written.
#[derive(Clone)]
pub struct Server {
    pub url: String,
    pub key: String,
}

impl std::fmt::Debug for Server {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Server")
            .field("url", &self.url)
            .finish_non_exhaustive()
    }
}

pub struct Core {
    conn: Arc<Mutex<Connection>>,
    http: Option<Arc<http::Http>>,
    cache: Option<blob::Cache>,
    catch_up_idle: Duration,
    /// A relocation callback retains the claim while its read ends, so it
    /// cannot record an origin after another process becomes the writer.
    lock: Arc<lock::WriterLock>,
    /// Hydration, catch-up and follow each move the one cursor, so two at
    /// once could move it backwards, apply an event twice, or apply one to a
    /// copy a hydration has replaced.
    streaming: Mutex<Streaming>,
    /// Two drains at once would each send every unanswered write, so a
    /// second waits for the one under way.
    draining: Mutex<()>,
    /// The one source this store's listeners share (`watch`).
    watch: Arc<watch::Watch>,
    /// Each renewal not yet written down, as the digests of the header it
    /// replaced and of the one that replaced it.
    renewals: Arc<Mutex<Vec<(String, String)>>>,
}

const DEFAULT_CATCH_UP_IDLE: Duration = Duration::from_secs(3);

/// Well past any fetch or copy of a blob's bytes still running.
const INCOMING_GRACE: Duration = Duration::from_secs(3600);

/// The deepest a queued write's body may nest, counting each array or object
/// inside another and no bracket inside a string: the server refuses a request
/// body nested deeper (`items/json-depth`), so the core refuses it first.
pub const MAX_JSON_DEPTH: usize = 64;

/// The tag the server gives a conflicted copy (`versions/copy-written`).
pub const CONFLICTED_COPY_TAG: &str = "conflicted-copy";

/// The edge type linking a conflicted copy, its source, to the original
/// (`versions/copy-link`).
pub const CONFLICTED_COPY_EDGE: &str = "derived-from";

/// An item and the edges at it as the copy held them when a decision about
/// the item was made. Two reads are the same where neither the item's
/// content, state, tags nor edges differ; the times the copy stamps on its
/// rows say nothing about what a file shows.
#[derive(Debug, Clone)]
pub(crate) struct Seen {
    item: Item,
    edges: Vec<Edge>,
}

impl Seen {
    pub(crate) fn item(&self) -> &Item {
        &self.item
    }

    fn of(conn: &Connection, id: &str) -> Result<Option<Seen>> {
        let Some(item) = store::items_by_ids(conn, &[id.to_string()])?.pop() else {
            return Ok(None);
        };
        let mut edges = store::edges_from(conn, id)?;
        for edge in store::edges_to(conn, id)? {
            if !edges.iter().any(|held| held.id == edge.id) {
                edges.push(edge);
            }
        }
        edges.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(Some(Seen { item, edges }))
    }
}

impl PartialEq for Seen {
    fn eq(&self, other: &Seen) -> bool {
        let bare = |item: &Item| Item {
            created_at: String::new(),
            updated_at: String::new(),
            ..item.clone()
        };
        let edges = |seen: &Seen| -> Vec<Edge> {
            seen.edges
                .iter()
                .map(|edge| Edge {
                    created_at: String::new(),
                    updated_at: String::new(),
                    ..edge.clone()
                })
                .collect()
        };
        bare(&self.item) == bare(&other.item) && edges(self) == edges(other)
    }
}

impl Core {
    #[cfg(test)]
    pub(crate) fn open_directory(
        state: &directory::Directory,
        store_label: &Path,
        server: Option<Server>,
    ) -> Result<Core> {
        let lock = Arc::new(Self::claim_directory(state)?);
        Self::open_claimed(state, store_label, server, lock)
    }

    /// The writer lock of the store in `state`, claimed apart from the
    /// store, so a caller can go on holding it after the store closes.
    #[cfg(unix)]
    pub(crate) fn claim_directory(state: &directory::Directory) -> Result<lock::WriterLock> {
        lock::WriterLock::claim_directory(&directory_vfs::DirectoryVfs::new(state.file())?)
    }

    /// Opens the store in `state` under `lock`, which `claim_directory`
    /// claimed there.
    #[cfg(unix)]
    pub(crate) fn open_claimed(
        state: &directory::Directory,
        store_label: &Path,
        server: Option<Server>,
        lock: Arc<lock::WriterLock>,
    ) -> Result<Core> {
        let vfs = directory_vfs::DirectoryVfs::new(state.file())?;
        let writer = lock.handle() == Handle::Writer;
        let cache = blob::Cache::anchored(state, store_label, writer)?;
        Self::from_connection(
            store::open_directory(&vfs, store_label)?,
            server,
            lock,
            Some(cache),
        )
        .map(Core::swept)
    }

    #[cfg(unix)]
    pub(crate) fn read_directory(state: &directory::Directory, store_label: &Path) -> Result<Core> {
        let vfs = directory_vfs::DirectoryVfs::new(state.file())?;
        Self::from_connection(
            store::read_directory(&vfs, store_label)?,
            None,
            Arc::new(lock::WriterLock::reader()),
            Some(blob::Cache::anchored(state, store_label, false)?),
        )
    }

    #[cfg(not(unix))]
    pub(crate) fn claim_directory(_state: &directory::Directory) -> Result<lock::WriterLock> {
        Err(CoreError::Invalid(
            "folder directory capabilities are unavailable on this platform".into(),
        ))
    }

    #[cfg(not(unix))]
    pub(crate) fn open_claimed(
        _state: &directory::Directory,
        _store_label: &Path,
        _server: Option<Server>,
        _lock: Arc<lock::WriterLock>,
    ) -> Result<Core> {
        Err(CoreError::Invalid(
            "folder directory capabilities are unavailable on this platform".into(),
        ))
    }

    #[cfg(not(unix))]
    pub(crate) fn read_directory(
        _state: &directory::Directory,
        _store_label: &Path,
    ) -> Result<Core> {
        Err(CoreError::Invalid(
            "folder directory capabilities are unavailable on this platform".into(),
        ))
    }

    /// Creates the file when absent. A changed origin is confirmed against
    /// the recorded instance before the first request.
    pub fn open(path: impl AsRef<Path>, server: Option<Server>) -> Result<Core> {
        let path = path.as_ref();
        // Claimed before the store is opened: a second opener that read the
        // store first would act as a writer until it found out it was not.
        let lock = lock::WriterLock::claim(Some(path))?;
        let cache = blob::Cache::beside(path);
        if lock.handle() == Handle::Writer {
            owner_only(path)?;
        }
        Self::from_connection(store::open(path)?, server, Arc::new(lock), Some(cache))
            .map(Core::swept)
    }

    /// Takes what a process that ended part way left in the cache, for a
    /// writer, sparing the partial files of attachments.
    fn swept(self) -> Core {
        if self.handle() == Handle::Writer
            && let Some(cache) = &self.cache
        {
            let attachments = self
                .conn()
                .ok()
                .and_then(|conn| store::kept_attachments(&conn).ok());
            cache.sweep_incoming(INCOMING_GRACE, attachments.as_ref());
        }
        self
    }

    /// Replaces a store `open` refuses with `wrong_schema` by an empty one of
    /// this build's shape, and opens it as the writer. Refuses, leaving the
    /// store as it is, while another process holds the writer role, while
    /// the store holds a write the server has not taken or one it cannot
    /// count, and where `open` would not refuse it. The new store is empty,
    /// so what only the old store held, such as pins, is lost: read it
    /// first. The file budget's setting is kept, as far as the old store
    /// gives it: where it holds none, or none that can be read, the new store
    /// has the default. The blob cache is kept: it is addressed by content,
    /// not by the store.
    pub fn replace_refused(path: impl AsRef<Path>, server: Option<Server>) -> Result<Core> {
        let path = path.as_ref();
        // Held from the count to the returned core, so no write can be
        // queued between the count and the replacement.
        let lock = lock::WriterLock::claim(Some(path))?;
        lock.refuse_unless_writer()?;
        // A server `open` would refuse is refused here, before the store goes.
        if let Some(server) = &server {
            http::Http::new(&server.url, &server.key)?;
        }
        if path.symlink_metadata().is_err() {
            return Err(CoreError::Invalid(format!(
                "{} holds no store to replace",
                path.display()
            )));
        }
        match store::refusal(path)? {
            Some(CoreError::WrongSchema {
                unsent: Some(0), ..
            }) => {}
            Some(refused) => return Err(refused),
            None => {
                return Err(CoreError::Invalid(format!(
                    "{} opens as it is, so there is nothing to replace",
                    path.display()
                )));
            }
        }
        let budget = store::refused_file_budget(path);
        let conn = store::replace(path)?;
        // The budget is a setting the new store can do without, so a write
        // that fails leaves the default and does not undo a replacement
        // that is done.
        if let Some(setting) = budget
            && let Some(text) = setting.to_stored()
        {
            let _ = store::meta_set(&conn, file_cache::META_BUDGET, &text);
        }
        let cache = blob::Cache::beside(path);
        Self::from_connection(conn, server, Arc::new(lock), Some(cache)).map(Core::swept)
    }

    /// Removes the store at `path`, of any build's shape: the store file,
    /// its logs, the folder of fetched bytes beside it and its writer lock,
    /// and nothing else. A symbolic link at one of those names is removed,
    /// never what it leads to. `unsent` is the count of writes the server has
    /// not taken that the person agreed to lose, as `WrongSchema` counts
    /// them. Refuses, leaving everything as it is, with `ReadingHandle` while
    /// another process, or another `Core` in this one, holds the writer role,
    /// with `UnsentDiffers` and the store's own count where it holds another
    /// number of such writes or one that cannot be counted, and with
    /// `Invalid` where the store is a folder's, bound or not. A process that
    /// only reads the store does not hold the writer role, so it does not
    /// stop the removal. A path with no store holds
    /// none, so it answers as removed, taking any lock or bytes left there.
    pub fn remove_store(path: impl AsRef<Path>, unsent: u64) -> Result<()> {
        let path = path.as_ref();
        let differs = |held: Option<u64>| {
            if held == Some(unsent) {
                Ok(())
            } else {
                Err(CoreError::UnsentDiffers {
                    path: path.display().to_string(),
                    unsent: held,
                    agreed: unsent,
                })
            }
        };
        let holder = path
            .parent()
            .filter(|holder| !holder.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        if !holder.is_dir() {
            return differs(Some(0));
        }
        // Held from the count until the lock's own name is gone, so no
        // process can queue a write the count missed, or make a store at the
        // path that the removal would then take.
        let lock = lock::WriterLock::claim(Some(path))?;
        lock.refuse_unless_writer()?;
        let held = match path.metadata() {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Some(0),
            _ => store::removal_count(path)?,
        };
        differs(held)?;
        // The store goes after the fetched bytes, so a removal that stops
        // between the two leaves the store, and asking again finishes it. The
        // other order would leave bytes that a new store at the path adopts.
        remove_name(&blob::Cache::dir_beside(path))?;
        store::remove(path)?;
        remove_name(&lock::lock_path(path))?;
        drop(lock);
        Ok(())
    }

    /// Never claims the writer role, so a helper started before the app
    /// cannot lock the app out of its own store, and refuses a path where no
    /// store has been made rather than making one. `data_version` is how it
    /// learns the writer saved.
    pub fn open_reader(path: impl AsRef<Path>) -> Result<Core> {
        let path = path.as_ref();
        Ok(Core {
            conn: Arc::new(Mutex::new(store::open_to_read(path)?)),
            http: None,
            cache: Some(blob::Cache::beside(path)),
            catch_up_idle: DEFAULT_CATCH_UP_IDLE,
            lock: Arc::new(lock::WriterLock::reader()),
            streaming: Mutex::default(),
            draining: Mutex::new(()),
            watch: watch::Watch::new(),
            renewals: Arc::default(),
        })
    }

    pub fn open_in_memory(server: Option<Server>) -> Result<Core> {
        let lock = lock::WriterLock::claim(None)?;
        Self::from_connection(store::open_in_memory()?, server, Arc::new(lock), None)
    }

    pub fn handle(&self) -> Handle {
        self.lock.handle()
    }

    /// Used when the server refuses the credential with a `401`; each
    /// refused call is sent again once.
    pub fn renew_credential_with(&self, renew: http::Renew) {
        if let Some(http) = &self.http {
            http.renew_with(renew);
        }
    }

    pub fn with_catch_up_idle(mut self, idle: Duration) -> Core {
        self.catch_up_idle = idle;
        self
    }

    fn from_connection(
        conn: Connection,
        server: Option<Server>,
        lock: Arc<lock::WriterLock>,
        cache: Option<blob::Cache>,
    ) -> Result<Core> {
        let http = match server {
            Some(server) => Some(Arc::new(http::Http::new(&server.url, &server.key)?)),
            None => None,
        };
        let relocation = if let Some(http) = &http
            && let Some(expected) = store::meta_get(&conn, store::META_SERVER_ORIGIN)?
            && expected != http.origin()
        {
            Some((expected, store::meta_get(&conn, store::META_INSTANCE_ID)?))
        } else {
            None
        };
        // A copy that has never reached a server holds the types Marfa ships,
        // so an app can save before it has connected.
        if lock.handle() == Handle::Writer
            && store::never_synced(&conn)?
            && store::catalog_version(&conn)?.is_none()
        {
            store::hold_local_catalog(&conn)?;
        }
        let conn = Arc::new(Mutex::new(conn));
        let renewals = Arc::new(Mutex::new(Vec::new()));
        if let Some(http) = &http {
            let db = Arc::clone(&conn);
            let pending = Arc::clone(&renewals);
            http.on_renewed(Box::new(move |from, to| {
                pending
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .push((store::credential_digest(from), store::credential_digest(to)));
                // Not waited for: a call can be renewed while its caller
                // holds the connection, and every drain writes it down as
                // it starts and as it ends.
                if let Ok(conn) = db.try_lock() {
                    let _ = write_down_renewals(&conn, &pending);
                }
            }));
        }
        if let Some((expected_origin, expected_instance)) = relocation {
            let http = http.as_ref().expect("relocation has a server");
            let db = Arc::clone(&conn);
            let origin = http.origin();
            let recorded_origin = expected_origin.clone();
            let recorded_instance = expected_instance.clone();
            let claim = Arc::clone(&lock);
            http.relocating(
                expected_origin,
                expected_instance,
                Box::new(move |stopped| {
                    keep_relocated_origin(
                        &db,
                        &claim,
                        &recorded_origin,
                        recorded_instance.as_deref(),
                        &origin,
                        stopped,
                    )
                }),
            );
        }
        Ok(Core {
            conn,
            http,
            cache,
            catch_up_idle: DEFAULT_CATCH_UP_IDLE,
            lock,
            streaming: Mutex::default(),
            draining: Mutex::new(()),
            watch: watch::Watch::new(),
            renewals,
        })
    }

    /// Declares the types the app saves under, each as the JSON a server
    /// lists a type as: its `id`, its `fields`, and whatever else a type
    /// carries. The call is the app's whole set: it replaces every earlier
    /// declaration, so a type the app no longer declares is no longer held to
    /// or registered. A copy that has never reached a server checks what it
    /// queues against these and the types Marfa ships, and a hydration
    /// registers on the instance the ones it does not hold, and replaces each
    /// `app.*` one it holds in another definition, where the key may.
    /// On a copy that holds a server's catalog the set waits for the next
    /// hydration.
    pub fn declare_types(&self, types: &[Value]) -> Result<()> {
        self.lock.refuse_unless_writer()?;
        let mut conn = self.conn()?;
        let tx = conn.transaction()?;
        // The ids of the whole set are known to each other, so a parent may
        // come after its child.
        let declared: Vec<String> = types
            .iter()
            .filter_map(|definition| definition.get("id").and_then(Value::as_str))
            .map(str::to_string)
            .collect();
        let known = |id: &str| {
            declared.iter().any(|held| held == id) || builtin::ships(id).unwrap_or(false)
        };
        let mut rows = Vec::new();
        for definition in types {
            rows.push(catalog::declaration(definition, &known)?);
        }
        store::clear_declared_types(&tx)?;
        for (id, json) in &rows {
            store::declare_type(&tx, id, json)?;
        }
        if store::never_synced(&tx)? {
            store::hold_local_catalog(&tx)?;
        }
        tx.commit()?;
        Ok(())
    }

    /// The types the app declared, by id, with the empty `fields` and the
    /// `version` a registration needs filled in where the app left them out.
    pub fn declared_types(&self) -> Result<Vec<Value>> {
        let conn = self.conn()?;
        store::declared_type_rows(&conn)?
            .into_iter()
            .map(|(id, json)| {
                serde_json::from_str(&json).map_err(|error| {
                    CoreError::Store(format!("the declared type {id} cannot be read: {error}"))
                })
            })
            .collect()
    }

    /// Refused while a catch-up or a follow runs on this handle: a follow
    /// left running across a hydration would apply events read against the
    /// old slice to the new copy. A caller stops its follow first. A watch is
    /// not stopped: the hydration takes its stream, and gives it back.
    ///
    /// `types` is the slice's types. `store::EVERY_TYPE` alone is every type
    /// but `system.*`, hydrated in one pass with no need to read the catalog
    /// and name its types first; beside `system.*` types it adds them, and
    /// beside any other type it is `Invalid`.
    pub fn hydrate(&self, types: &[String], tier: SliceTier) -> Result<HydrateReport> {
        self.hydrate_with(types, tier, &[])
    }

    /// `hydrate_with`, ended with `Canceled` soon after `stop` is raised. The
    /// copy is then unfinished, as after a hydration that failed part way: it
    /// answers lists and searches marked partial and refuses writes; the queue is untouched.
    pub fn hydrate_until(
        &self,
        types: &[String],
        tier: SliceTier,
        edge_types: &[String],
        stop: &AtomicBool,
    ) -> Result<HydrateReport> {
        self.lock.refuse_unless_writer()?;
        let mut taken = self.watch.take()?;
        let _streaming = self.claim_stream(Mover::Hydration)?;
        let report = hydrate::hydrate(self, self.http()?, types, tier, edge_types, stop)?;
        taken.reached();
        self.settle_bodies(stop)?;
        Ok(report)
    }

    /// Holds every edge of `edge_types` the key reads, whichever ends the
    /// copy holds. `types` reads as in [`Core::hydrate`].
    pub fn hydrate_with(
        &self,
        types: &[String],
        tier: SliceTier,
        edge_types: &[String],
    ) -> Result<HydrateReport> {
        self.hydrate_until(types, tier, edge_types, &NEVER_STOPPED)
    }

    /// Refused where neither the server nor the copy holds `id`, and
    /// `NotFound` with `trashed` where the server holds it in the bin. Answers
    /// whether it was pinned already.
    pub fn pin(&self, id: &str) -> Result<bool> {
        self.lock.refuse_unless_writer()?;
        let http = self.http()?;
        let (added, context) = {
            let conn = self.conn()?;
            store::refuse_unless_hydrated(&conn)?;
            let added = store::pin(&conn, id)?;
            (added, reach::Context::capture(&conn)?)
        };
        let mut trashed = false;
        let own_create = |conn: &Connection| -> Result<bool> {
            Ok(store::waiting_writes_for_item(conn, id)?
                .iter()
                .any(|row| row.kind == WriteKind::CreateItem)
                && store::item_held(conn, id)?)
        };
        let held = hydrate::read_with_edges(&context.http(http), id).and_then(|read| {
            // A read by id answers a row in the bin as one that is gone, and
            // the slice may hold such a row.
            if read.is_none() && !own_create(&*self.conn()?)? {
                trashed = context.http(http).trashed_item(id)?.is_some();
            }
            let mut conn = self.conn()?;
            let tx = conn.transaction()?;
            context.check(&tx)?;
            let held = match &read {
                Some((row, edges)) => {
                    let catalog = catalog::Catalog::load(&tx)?;
                    hydrate::hold_row(&tx, &catalog, row, edges)?;
                    true
                }
                None if own_create(&tx)? => true,
                None => {
                    if !trashed {
                        store::evict_item(&tx, id, &store::whole_edge_types(&tx)?)?;
                    }
                    false
                }
            };
            tx.commit()?;
            Ok(held)
        });
        if !matches!(held, Ok(true)) && added {
            let conn = self.conn()?;
            if context.check(&conn).is_ok() {
                store::unpin(&conn, id)?;
            }
        }
        match held.map_err(|error| context.failed(self, error).unwrap_or_else(|error| error))? {
            true => Ok(!added),
            false if trashed => Err(CoreError::NotFound {
                code: "trashed".into(),
                message: format!("{id} is in the bin; restore it to pin it"),
            }),
            false => Err(CoreError::NotFound {
                code: "not_found".into(),
                message: format!("the server holds no item {id} to pin"),
            }),
        }
    }

    /// A row the slice does not take leaves the copy, unless writes to it
    /// still wait. Answers whether it was pinned.
    pub fn unpin(&self, id: &str) -> Result<bool> {
        self.lock.refuse_unless_writer()?;
        let mut conn = self.conn()?;
        let tx = conn.transaction()?;
        let pinned = unpin_held(&tx, id)?;
        tx.commit()?;
        Ok(pinned)
    }

    /// A failure does not say whether the catalog changed before it;
    /// `catch_up_until` does.
    pub fn catch_up(&self) -> Result<CatchUpReport> {
        self.catch_up_until(&NEVER_STOPPED)
            .map_err(|failed| failed.error)
    }

    /// Ended with `Canceled` soon after `stop` is raised, keeping the cursor
    /// of the last event applied.
    pub fn catch_up_until(
        &self,
        stop: &AtomicBool,
    ) -> std::result::Result<CatchUpReport, CatchUpFailed> {
        let op = telemetry::operation!("catch_up", applied, skipped);
        let result = self.catch_up_pass(stop);
        telemetry::ended!(
            op,
            result.as_ref().map_err(|failed| &failed.error),
            |report| {
                outcome = "ok",
                applied = report.applied,
                skipped = report.skipped,
            }
        );
        result
    }

    fn catch_up_pass(
        &self,
        stop: &AtomicBool,
    ) -> std::result::Result<CatchUpReport, CatchUpFailed> {
        self.lock.refuse_unless_writer()?;
        let mut taken = self.watch.take()?;
        let _streaming = self.claim_stream(Mover::CatchUp)?;
        let mut catalog_changed = false;
        catch_up::catch_up(
            self,
            self.http()?,
            self.catch_up_idle,
            stop,
            &mut catalog_changed,
        )
        .and_then(|report| {
            taken.reached();
            self.settle_bodies(stop)?;
            Ok(report)
        })
        .map_err(|error| CatchUpFailed {
            error,
            catalog_changed,
        })
    }

    /// `on_change` is called with no lock on the store held, so it may read
    /// the row it is told about.
    ///
    /// On a copy never hydrated, or whose hydration is under way or was
    /// interrupted, it waits, asking the server nothing, until a hydration
    /// completes and no hydration or catch-up still holds the stream, then
    /// follows. `stop` ends the wait as it ends the follow. An expired copy
    /// is refused at once, as it stands. A second follow is refused at once,
    /// waiting or not.
    ///
    /// `told_unreachable` says the caller was last told `server.unreachable`
    /// by a follow before this one, so this one says `server.reachable` when
    /// it has its first stream (`device/follow-told-reachable`).
    ///
    /// Each time it says `server.reachable` with work queued for a drain,
    /// it drains once, on a thread of its own so the stream is read
    /// meanwhile, and tells `queue.drained` or `queue.not_drained`
    /// (`device/follow-drains-reachable`). That drain waits for one under
    /// way to end, and then does only the work left. That drain watches
    /// `stop` as `drain_until` does, and the follow raises `stop` itself
    /// when it ends, however it ends, so no write goes out after either:
    /// give each follow a flag of its own.
    pub fn follow(
        &self,
        stop: &AtomicBool,
        told_unreachable: bool,
        on_change: impl FnMut(&Change),
    ) -> Result<FollowReport> {
        self.follow_from(
            stop,
            catch_up::FollowAs {
                told_unreachable,
                owes_drain: false,
                drains: true,
                pace: catch_up::PACE,
            },
            on_change,
            || {},
        )
    }

    /// The follow a watch holds. `owes_drain` has it drain once at its first
    /// stream, as it does after the server was lost.
    pub(crate) fn follow_watched(
        &self,
        stop: &AtomicBool,
        owes_drain: bool,
        on_change: impl FnMut(&Change),
        on_contact: impl FnMut(),
    ) -> Result<FollowReport> {
        self.follow_from(
            stop,
            catch_up::FollowAs {
                told_unreachable: false,
                owes_drain,
                drains: true,
                pace: self.watch.follow_pace(),
            },
            on_change,
            on_contact,
        )
    }

    fn follow_from(
        &self,
        stop: &AtomicBool,
        how: catch_up::FollowAs,
        on_change: impl FnMut(&Change),
        on_contact: impl FnMut(),
    ) -> Result<FollowReport> {
        self.lock.refuse_unless_writer()?;
        let http = self.http.clone().ok_or(CoreError::NoServer)?;
        let _following = self.claim_follow()?;
        let Some(streaming) = self.claim_stream_once_hydrated(stop)? else {
            return Ok(FollowReport::default());
        };
        self.follow_claimed(http, streaming, stop, how, on_change, |_| {}, on_contact)
    }

    /// A folder's watch hydrates its copy on the thread that follows it, so
    /// this refuses a copy that is not hydrated rather than wait for a
    /// hydration that thread would never run. It never drains: the watch's
    /// own pass drains, and keeps the folder's books as it does.
    pub(crate) fn follow_observed(
        &self,
        stop: &AtomicBool,
        told_unreachable: bool,
        on_change: impl FnMut(&Change),
        on_live: impl FnMut(bool),
    ) -> Result<FollowReport> {
        self.lock.refuse_unless_writer()?;
        let http = self.http.clone().ok_or(CoreError::NoServer)?;
        let _following = self.claim_follow()?;
        let streaming = self.claim_stream(Mover::Follow)?;
        self.follow_claimed(
            http,
            streaming,
            stop,
            catch_up::FollowAs {
                told_unreachable,
                owes_drain: false,
                drains: false,
                pace: catch_up::PACE,
            },
            on_change,
            on_live,
            || {},
        )
    }

    /// `None` where `stop` was raised while it waited.
    fn claim_stream_once_hydrated(&self, stop: &AtomicBool) -> Result<Option<StreamClaim<'_>>> {
        let mut waited = false;
        loop {
            let mut conn = self.conn()?;
            let answer = catch_up::refuse_unless_current(&mut conn);
            // A refill under way is waited for as a first hydration is; a
            // stale copy no refill has begun is refused.
            let waits = match &answer {
                Err(CoreError::NoCursor | CoreError::HydrationIncomplete) => true,
                Err(CoreError::CopyExpired { reason }) if reason == catch_up::CATCHUP_TOO_OLD => {
                    !store::hydration_complete(&conn)?
                }
                _ => false,
            };
            drop(conn);
            match answer {
                Ok(()) => match self.try_claim_stream(Mover::Follow) {
                    Ok(claim) => return Ok(Some(claim)),
                    // The hydration waited for holds it until it has
                    // settled, and a catch-up may have taken it since.
                    Err(Mover::Hydration | Mover::CatchUp) if waited => {}
                    Err(_) => return Err(one_at_a_time()),
                },
                Err(_) if waits => {
                    #[cfg(debug_assertions)]
                    if !waited {
                        fault::hold(|| "follow-waiting");
                    }
                    waited = true;
                }
                Err(error) => return Err(error),
            }
            if stop.load(Ordering::Relaxed) {
                return Ok(None);
            }
            std::thread::sleep(catch_up::PACE.stop_poll);
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn follow_claimed(
        &self,
        http: Arc<http::Http>,
        _streaming: StreamClaim<'_>,
        stop: &AtomicBool,
        how: catch_up::FollowAs,
        mut on_change: impl FnMut(&Change),
        mut on_live: impl FnMut(bool),
        mut on_contact: impl FnMut(),
    ) -> Result<FollowReport> {
        // A binding says the follow ended when this returns: a fault that
        // unwound past here would end the thread silently, and a caller
        // waiting to be told would wait for good.
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            catch_up::follow(
                self,
                http,
                stop,
                how,
                &mut on_change,
                &mut on_live,
                &mut on_contact,
            )
        }))
        .unwrap_or_else(|fault| Err(CoreError::Invalid(fault_message(fault.as_ref()))))
    }

    /// Moves each time another process saves to this store.
    pub fn data_version(&self) -> Result<i64> {
        #[cfg(debug_assertions)]
        if fault::fails(|| "data-version") {
            return Err(CoreError::Store("the data version cannot be read".into()));
        }
        store::data_version(&*self.conn()?)
    }

    /// Answered part way through a hydration from the rows that have arrived,
    /// marked `Partial`.
    ///
    /// Left unnamed, the order is newest created first, or oldest changed
    /// first where `updated_after` is named, as the server's.
    pub fn list(&self, filters: &ListFilters, sort: impl Into<Option<Sort>>) -> Result<Rows<Item>> {
        let sort = sort.into();
        store::read_marked(&mut *self.conn()?, |conn, completeness| {
            let catalog = catalog::Catalog::load(conn)?;
            Ok(Rows {
                rows: query::list(conn, &catalog, filters, sort.clone())?,
                completeness,
            })
        })
    }

    /// `list`, each item with the title and body it shows (`Catalog::shown`),
    /// all read under one snapshot of the catalog.
    pub fn list_shown(
        &self,
        filters: &ListFilters,
        sort: impl Into<Option<Sort>>,
    ) -> Result<Rows<(Item, Shown)>> {
        self.list_shown_with(filters, sort.into(), &mut store::Unreadable::Refuse)
    }

    /// `list_shown`, but a row whose stored properties cannot be read stays
    /// in the answer with no properties, and its `Shown` says why.
    pub fn list_kept(
        &self,
        filters: &ListFilters,
        sort: impl Into<Option<Sort>>,
    ) -> Result<Rows<(Item, Shown)>> {
        self.list_shown_with(
            filters,
            sort.into(),
            &mut store::Unreadable::Keep(HashMap::new()),
        )
    }

    fn list_shown_with(
        &self,
        filters: &ListFilters,
        sort: Option<Sort>,
        unreadable: &mut store::Unreadable,
    ) -> Result<Rows<(Item, Shown)>> {
        store::read_marked(&mut *self.conn()?, |conn, completeness| {
            let catalog = catalog::Catalog::load(conn)?;
            let items = query::list_with(conn, &catalog, filters, sort.clone(), unreadable)?;
            Ok(Rows {
                rows: items,
                completeness,
            }
            .map(|item| {
                let shown = catalog.shown_unreadable(&item, unreadable);
                (item, shown)
            }))
        })
    }

    /// `None` only where the copy is whole: part way through a hydration, a
    /// row that has not arrived is refused `HydrationIncomplete`.
    pub fn get(&self, id: &str) -> Result<Option<Item>> {
        store::read_marked(&mut *self.conn()?, |conn, completeness| {
            store::held_or_refused(store::item_by_id(conn, id)?, completeness)
        })
    }

    /// `get`, with the title and body the item shows.
    pub fn get_shown(&self, id: &str) -> Result<Option<(Item, Shown)>> {
        self.get_shown_with(id, &mut store::Unreadable::Refuse)
    }

    /// `get_shown`, but a row whose stored properties cannot be read is
    /// answered with no properties, and its `Shown` says why.
    pub fn get_kept(&self, id: &str) -> Result<Option<(Item, Shown)>> {
        self.get_shown_with(id, &mut store::Unreadable::Keep(HashMap::new()))
    }

    fn get_shown_with(
        &self,
        id: &str,
        unreadable: &mut store::Unreadable,
    ) -> Result<Option<(Item, Shown)>> {
        store::read_marked(&mut *self.conn()?, |conn, completeness| {
            let found = store::item_by_id_with(conn, id, unreadable)?;
            let Some(item) = store::held_or_refused(found, completeness)? else {
                return Ok(None);
            };
            let catalog = catalog::Catalog::load(conn)?;
            let shown = catalog.shown_unreadable(&item, unreadable);
            Ok(Some((item, shown)))
        })
    }

    /// An item the copy does not hold is refused `NotFound`, never answered
    /// `None`, and refused `HydrationIncomplete` part way through a
    /// hydration. A held value that is not a data URI (one written before its
    /// type declared the property) is refused `Decoding`, naming the item.
    pub fn thumbnail(&self, id: &str) -> Result<Option<Thumbnail>> {
        let (item, catalog) = store::read_marked(&mut *self.conn()?, |conn, completeness| {
            let found = store::item_by_id(conn, id)?;
            let Some(item) = store::held_or_refused(found, completeness)? else {
                return Err(CoreError::NotFound {
                    code: "not_held".into(),
                    message: format!("{id} is not held in this working copy"),
                });
            };
            Ok((item, catalog::Catalog::load(conn)?))
        })?;
        let Some(field) = catalog.thumbnail_field(&item.r#type) else {
            return Ok(None);
        };
        match item.properties.get(field) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(uri)) => {
                Thumbnail::from_data_uri(uri)
                    .map(Some)
                    .map_err(|error| match error {
                        CoreError::Decoding(reason) => {
                            CoreError::Decoding(format!("{id}: {reason}"))
                        }
                        other => other,
                    })
            }
            Some(other) => {
                let held = match other {
                    Value::Bool(_) => "a boolean",
                    Value::Number(_) => "a number",
                    Value::Array(_) => "an array",
                    _ => "an object",
                };
                Err(CoreError::Decoding(format!(
                    "{id}: its {field} holds {held}, where a thumbnail is a data URI"
                )))
            }
        }
    }

    pub fn edges_from(&self, id: &str) -> Result<Vec<Edge>> {
        let conn = self.conn()?;
        store::refuse_unless_usable(&conn)?;
        store::edges_from(&conn, id)
    }

    pub fn edges_to(&self, id: &str) -> Result<Vec<Edge>> {
        let conn = self.conn()?;
        store::refuse_unless_usable(&conn)?;
        store::edges_to(&conn, id)
    }

    /// Answered or still queued, oldest first.
    pub fn edges_of_type(&self, edge_type: &str) -> Result<Vec<Edge>> {
        let conn = self.conn()?;
        store::refuse_unless_usable(&conn)?;
        store::edges_of_type(&conn, edge_type)
    }

    /// `edges_from`, but an edge whose stored properties cannot be read stays
    /// in the answer with no properties, beside why.
    pub fn edges_from_kept(&self, id: &str) -> Result<Vec<(Edge, Option<String>)>> {
        self.edges_kept("source_id", id)
    }

    /// `edges_to`, keeping an edge whose stored properties cannot be read as
    /// `edges_from_kept` does.
    pub fn edges_to_kept(&self, id: &str) -> Result<Vec<(Edge, Option<String>)>> {
        self.edges_kept("target_id", id)
    }

    /// `edges_of_type`, keeping an edge whose stored properties cannot be
    /// read as `edges_from_kept` does.
    pub fn edges_of_type_kept(&self, edge_type: &str) -> Result<Vec<(Edge, Option<String>)>> {
        self.edges_kept("edge_type", edge_type)
    }

    fn edges_kept(&self, column: &'static str, value: &str) -> Result<Vec<(Edge, Option<String>)>> {
        let conn = self.conn()?;
        store::refuse_unless_usable(&conn)?;
        let mut unreadable = store::Unreadable::Keep(HashMap::new());
        let edges = store::edges_at(&conn, column, value, &mut unreadable)?;
        Ok(edges
            .into_iter()
            .map(|edge| {
                let why = unreadable.why(&edge.id);
                (edge, why)
            })
            .collect())
    }

    /// The id of the item a conflicted copy was made from: the target of its
    /// `derived-from` edge, where `id` is a held row outside the bin tagged
    /// `conflicted-copy`. `None` for any other row, and for one the copy does
    /// not hold. The original itself may be a row the copy does not hold.
    pub fn original_of_conflicted_copy(&self, id: &str) -> Result<Option<String>> {
        let conn = self.conn()?;
        store::refuse_unless_usable(&conn)?;
        let Some(copy) = store::item_by_id(&conn, id)? else {
            return Ok(None);
        };
        if !copy.tags.iter().any(|tag| tag == CONFLICTED_COPY_TAG) {
            return Ok(None);
        }
        Ok(store::edges_from(&conn, id)?
            .into_iter()
            .find(|edge| edge.edge_type == CONFLICTED_COPY_EDGE)
            .map(|edge| edge.target_id))
    }

    /// The held conflicted copies made from `id`, oldest link first: rows
    /// outside the bin tagged `conflicted-copy` whose `derived-from` edge
    /// names it. `id` need not be a row the copy holds.
    pub fn conflicted_copies_of(&self, id: &str) -> Result<Vec<Item>> {
        let conn = self.conn()?;
        store::refuse_unless_usable(&conn)?;
        conflicted_copies_in(&conn, id, &mut store::Unreadable::Refuse)
    }

    /// `conflicted_copies_of`, each copy with the title and body it shows, and
    /// a copy whose stored properties cannot be read kept with no properties,
    /// its `Shown` saying why.
    pub fn conflicted_copies_kept(&self, id: &str) -> Result<Vec<(Item, Shown)>> {
        let conn = self.conn()?;
        store::refuse_unless_usable(&conn)?;
        let mut unreadable = store::Unreadable::Keep(HashMap::new());
        let copies = conflicted_copies_in(&conn, id, &mut unreadable)?;
        let catalog = catalog::Catalog::load(&conn)?;
        Ok(copies
            .into_iter()
            .map(|item| {
                let shown = catalog.shown_unreadable(&item, &unreadable);
                (item, shown)
            })
            .collect())
    }

    /// Best match first. Answered part way through a hydration as `list` is.
    pub fn search(
        &self,
        query: &str,
        filters: &SearchFilters,
        limit: usize,
    ) -> Result<Rows<SearchHit>> {
        self.find(query, filters, limit, &mut store::Unreadable::Refuse)
            .map(|(_, hits)| hits)
    }

    /// The hits for `search` and the catalog they were found under.
    fn find(
        &self,
        query: &str,
        filters: &SearchFilters,
        limit: usize,
        unreadable: &mut store::Unreadable,
    ) -> Result<(catalog::Catalog, Rows<SearchHit>)> {
        let op = telemetry::operation!("search", hits);
        let result = self.find_in_copy(query, filters, limit, unreadable);
        telemetry::ended!(op, result.as_ref(), |found| {
            outcome = "ok",
            hits = found.1.rows.len(),
        });
        result
    }

    fn find_in_copy(
        &self,
        query: &str,
        filters: &SearchFilters,
        limit: usize,
        unreadable: &mut store::Unreadable,
    ) -> Result<(catalog::Catalog, Rows<SearchHit>)> {
        store::read_marked(&mut *self.conn()?, |conn, completeness| {
            let catalog = catalog::Catalog::load(conn)?;
            let rows = search::search(conn, &catalog, query, filters, limit, unreadable)?;
            Ok((catalog, Rows { rows, completeness }))
        })
    }

    /// `search`, each hit's item with the title and body it shows, under one
    /// snapshot of the catalog.
    pub fn search_shown(
        &self,
        query: &str,
        filters: &SearchFilters,
        limit: usize,
    ) -> Result<Rows<(SearchHit, Shown)>> {
        self.search_shown_with(query, filters, limit, &mut store::Unreadable::Refuse)
    }

    /// `search_shown`, but a hit whose item's stored properties cannot be
    /// read stays in the answer with no properties, and its `Shown` says why.
    pub fn search_kept(
        &self,
        query: &str,
        filters: &SearchFilters,
        limit: usize,
    ) -> Result<Rows<(SearchHit, Shown)>> {
        self.search_shown_with(
            query,
            filters,
            limit,
            &mut store::Unreadable::Keep(HashMap::new()),
        )
    }

    fn search_shown_with(
        &self,
        query: &str,
        filters: &SearchFilters,
        limit: usize,
        unreadable: &mut store::Unreadable,
    ) -> Result<Rows<(SearchHit, Shown)>> {
        let (catalog, hits) = self.find(query, filters, limit, unreadable)?;
        Ok(hits.map(|hit| {
            let shown = catalog.shown_unreadable(&hit.item, unreadable);
            (hit, shown)
        }))
    }

    /// Answerable without a hydration, unlike the reads: a caller must be
    /// able to learn what is outstanding before it can hydrate.
    pub fn queue(&self) -> Result<Vec<QueuedWrite>> {
        let conn = self.conn()?;
        store::queued_writes(&conn)
    }

    /// The refused creates whose move onto the row their natural key names
    /// waits for a read that finds it, each with the id of that row. Each
    /// still holds the writes that depend on it, whatever its verdict says,
    /// until it is discarded.
    pub fn pending_landings(&self) -> Result<std::collections::HashMap<String, String>> {
        store::pending_landings(&*self.conn()?)
    }

    /// One pass: every sendable row is attempted once, until the server
    /// cannot be reached. A drain called while another runs on this store
    /// waits for it to end, then sends only what is still unanswered.
    pub fn drain(&self) -> Result<DrainReport> {
        self.drain_until(&NEVER_STOPPED)
    }

    /// Ended with `Canceled` soon after `stop` is raised, without waiting on
    /// an upload in flight, which can take as long as the server takes, or
    /// a write the server answers by its key: that write stays queued as
    /// sent, under its key, and the next drain sends it again; an answer to
    /// it that arrives after the stop is dropped. Any other write in flight
    /// is waited for, and its answer recorded, since sent again it could
    /// overwrite a newer change. Answers already recorded remain in the
    /// queue.
    pub fn drain_until(&self, stop: &AtomicBool) -> Result<DrainReport> {
        let _one = self.wait_to_drain(stop)?;
        let report = drain::drain(self, stop)?;
        if report.answered > 0 {
            self.watch.drained();
        }
        Ok(report)
    }

    /// Waits as `drain_until` does, then drains only where work is left for
    /// a drain: whatever held the queue meanwhile may have done it. `None`
    /// where none is left.
    pub(crate) fn drain_what_remains(&self, stop: &AtomicBool) -> Option<Result<DrainReport>> {
        #[cfg(debug_assertions)]
        fault::hold(|| "recovery-drain-asked");
        let _one = match self.wait_to_drain(stop) {
            Ok(one) => one,
            Err(error) => return Some(Err(error)),
        };
        match drain::would_send(self) {
            Ok(false) => {
                self.owe_drain(false);
                #[cfg(debug_assertions)]
                fault::hold(|| "recovery-drain-found-none");
                None
            }
            Ok(true) => Some(drain::drain(self, stop)),
            Err(error) => Some(Err(error)),
        }
    }

    fn wait_to_drain(&self, stop: &AtomicBool) -> Result<MutexGuard<'_, ()>> {
        loop {
            catch_up::refuse_if_stopped(stop)?;
            match self.draining.try_lock() {
                Ok(guard) => return Ok(guard),
                Err(std::sync::TryLockError::Poisoned(poisoned)) => {
                    return Ok(poisoned.into_inner());
                }
                Err(std::sync::TryLockError::WouldBlock) => {
                    #[cfg(debug_assertions)]
                    fault::hold(|| "drain-waiting");
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
            }
        }
    }

    pub(crate) fn one_drain(&self) -> MutexGuard<'_, ()> {
        // Holds nothing a panic could leave half-written: the queue is in the
        // store.
        self.draining
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// A drain that ends in an error keeps what it settled before it.
    pub(crate) fn drain_held(
        &self,
        _one: &MutexGuard<'_, ()>,
    ) -> std::result::Result<DrainReport, drain::Cut> {
        drain::drain_keeping(self, &NEVER_STOPPED)
    }

    /// Under a fresh idempotency key. Answers `false` for a row that is not
    /// blocked, dead or refused without being sent, for one held behind
    /// another write, and for one refused because what it waited for was
    /// withdrawn.
    pub fn release(&self, id: &str) -> Result<bool> {
        self.lock.refuse_unless_writer()?;
        let mut conn = self.conn()?;
        let tx = conn.transaction()?;
        let released = store::release(&tx, id)?;
        if released {
            hydrate::lay_queue_over(
                &tx,
                &catalog::Catalog::load(&tx)?,
                &store::whole_edge_types(&tx)?,
                self.credential().as_deref(),
            )?;
        }
        tx.commit()?;
        Ok(released)
    }

    pub fn release_reason(&self, reason: BlockedReason) -> Result<usize> {
        self.lock.refuse_unless_writer()?;
        let conn = self.conn()?;
        let ids: Vec<String> = store::queued_writes(&conn)?
            .into_iter()
            .filter(|row| row.blocked_reason() == Some(reason))
            .map(|row| row.id)
            .collect();
        drop(conn);
        let mut conn = self.conn()?;
        let tx = conn.transaction()?;
        let mut released = 0;
        for id in ids {
            if store::release(&tx, &id)? {
                released += 1;
            }
        }
        if released > 0 {
            hydrate::lay_queue_over(
                &tx,
                &catalog::Catalog::load(&tx)?,
                &store::whole_edge_types(&tx)?,
                self.credential().as_deref(),
            )?;
        }
        // One transaction: a release part-way through would leave some rows
        // on a fresh key and some on a spent one.
        tx.commit()?;
        Ok(released)
    }

    /// Answers `false` for any row not blocked `ancestor_unavailable`,
    /// `conflict_unresolved` or `failing_alone`. Everything it puts back is read from the server
    /// before anything changes, so a withdraw that cannot read leaves the
    /// queue and the copy as they were.
    pub fn withdraw(&self, id: &str) -> Result<bool> {
        self.lock.refuse_unless_writer()?;
        let Some(row) = store::queued_write(&*self.conn()?, id)? else {
            return Err(CoreError::NotFound {
                code: "queued_write_not_found".into(),
                message: format!("{id} is not a write this queue holds"),
            });
        };
        if !row.withdrawable() {
            return Ok(false);
        }
        let held = store::held_for(&*self.conn()?, id)?;
        let mut reads = vec![drain::read_back(self, &row)?];
        for dependant in &held {
            reads.push(drain::read_back(self, dependant)?);
        }
        let mut conn = self.conn()?;
        let tx = conn.transaction()?;
        // Another thread may have released or answered a row while the
        // reads were out.
        if store::queued_write(&tx, id)?.as_ref() != Some(&row) || store::held_for(&tx, id)? != held
        {
            return Ok(false);
        }
        drain::withdraw_read_backs(&tx, &row, &held, &reads)?;
        tx.commit()?;
        Ok(true)
    }

    pub(crate) fn rebase_on_held(&self, id: &str) -> Result<bool> {
        self.lock.refuse_unless_writer()?;
        let mut conn = self.conn()?;
        let tx = conn.transaction()?;
        let Some(row) = store::queued_write(&tx, id)? else {
            return Ok(false);
        };
        if row.kind != WriteKind::UpdateItem
            || row.blocked_reason() != Some(BlockedReason::AncestorUnavailable)
        {
            return Ok(false);
        }
        let Some(held) = row
            .item_id
            .as_deref()
            .map(|item| store::item_by_id(&tx, item))
            .transpose()?
            .flatten()
        else {
            return Ok(false);
        };
        if row.base_version.is_none_or(|base| base >= held.version) {
            return Ok(false);
        }
        // With its base gone, nothing tells a property it left out from one
        // added since, so it goes as a merge and clears nothing.
        store::merge_properties(&tx, id)?;
        store::move_edit(&tx, id, held.version, None)?;
        store::release(&tx, id)?;
        hydrate::lay_queue_over(
            &tx,
            &catalog::Catalog::load(&tx)?,
            &store::whole_edge_types(&tx)?,
            self.credential().as_deref(),
        )?;
        tx.commit()?;
        Ok(true)
    }

    /// The links and embeds in the item's body are queued as edges of their
    /// own, after it.
    pub fn create_item(&self, draft: &Draft) -> Result<QueuedWrite> {
        self.lock.refuse_unless_writer()?;
        self.write_create(draft, Body::Read)
    }

    /// What the edit changes of the item's body's links and embeds is
    /// queued as edge writes of their own, after it.
    pub fn update_item(&self, id: &str, edit: &Edit) -> Result<QueuedWrite> {
        self.lock.refuse_unless_writer()?;
        self.write_update(id, edit, Based::OnHeld, Body::Read)
    }

    /// The base may be a version earlier than the one held, which the server
    /// merges against, so another device's write that came in since is kept
    /// rather than overwritten.
    pub fn update_item_as_read(&self, id: &str, edit: &Edit) -> Result<QueuedWrite> {
        self.lock.refuse_unless_writer()?;
        self.write_update(id, edit, Based::AsRead, Body::Read)
    }

    pub(crate) fn write_create(&self, draft: &Draft, body: Body) -> Result<QueuedWrite> {
        self.lock.refuse_unless_writer()?;
        let mut conn = self.conn()?;
        let completeness = store::refuse_unless_writable(&conn)?;
        let tx = conn.transaction()?;
        let catalog = catalog::Catalog::load(&tx)?;
        let queued = queue_create(&tx, &catalog, draft, &[], self.credential().as_deref())?;
        if body == Body::Read
            && let Some(item) = queued
                .item_id
                .as_deref()
                .map(|id| store::item_by_id(&tx, id))
                .transpose()?
                .flatten()
        {
            if completeness == Completeness::Complete {
                body::rule::derive(&tx, &catalog, "", &item, &queued.id)?;
            } else {
                body::rule::derive_on_answer(&tx, &item.id, "", &queued.id)?;
            }
        }
        tx.commit()?;
        Ok(queued)
    }

    /// Destroys a row in the bin on the server at once, and takes it, its edges
    /// and its pin out of the copy once the server accepts it (the device
    /// chapter's section "Purging"). Never queued. Sent at `version`, the
    /// version the caller was shown, or else the version the copy holds;
    /// refused, before anything is sent, `NotFound` with `not_held` for a row
    /// the copy does not hold where no version is named, `Validation` with
    /// `invalid_transition` for one the copy shows outside the bin, and
    /// `Invalid` while a write to it waits; then `NoServer` for a copy with no
    /// server. The root confirms the copy's instance first, which expires the
    /// copy where another answers. Otherwise it is refused with what the server
    /// or the network answered, the copy and the queue as they were:
    /// `version_conflict` for a row that moved since it was read. A `Network`
    /// failure after the request went out may follow a purge the server made,
    /// which its `item.purged` event then shows.
    pub fn purge_item(&self, id: &str, version: Option<i64>) -> Result<()> {
        self.lock.refuse_unless_writer()?;
        let (held, waiting) = {
            let conn = self.conn()?;
            store::refuse_unless_usable(&conn)?;
            (
                store::items_by_ids(&conn, &[id.to_string()])?.pop(),
                store::waiting_writes_for_item(&conn, id)?,
            )
        };
        if let Some(held) = &held
            && held.state != ItemState::Trashed
        {
            return Err(CoreError::Validation {
                code: "invalid_transition".into(),
                message: format!(
                    "{id} is {}, not in the bin, in this working copy; only a row in the bin can be purged",
                    held.state.as_str()
                ),
            });
        }
        if !waiting.is_empty() {
            return Err(CoreError::Invalid(format!(
                "{id} has {} write(s) still waiting to be sent, which would go to a row that is gone; drain, withdraw or discard them before purging it",
                waiting.len()
            )));
        }
        let Some(version) = version.or(held.as_ref().map(|held| held.version)) else {
            return Err(CoreError::NotFound {
                code: "not_held".into(),
                message: format!(
                    "{id} is not held in this working copy; name the version it was read at in the bin to purge it"
                ),
            });
        };
        let http = self.http()?;
        catch_up::refuse_another_instance(self, http)?;
        catch_up::write_naming_instance(self, http, |http| http.purge_item(id, version))?;
        let mut conn = self.conn()?;
        let tx = conn.transaction()?;
        store::purge_item(&tx, id)?;
        tx.commit()?;
        Ok(())
    }

    pub(crate) fn write_update(
        &self,
        id: &str,
        edit: &Edit,
        based: Based,
        body: Body,
    ) -> Result<QueuedWrite> {
        self.lock.refuse_unless_writer()?;
        let mut conn = self.conn()?;
        let completeness = store::refuse_unless_writable(&conn)?;
        let tx = conn.transaction()?;
        let catalog = catalog::Catalog::load(&tx)?;
        let before = store::item_by_id(&tx, id)?;
        if !store::item_held(&tx, id)? {
            store::refuse_unless_held(completeness)?;
        }
        let queued = queue_update(&tx, &catalog, id, edit, &[], based)?;
        if body == Body::Read
            && let Some(before) = before
            && let Some(after) = store::item_by_id(&tx, id)?
        {
            let old = body::rule::body_of(&catalog, &before).to_string();
            if completeness != Completeness::Complete
                || edit.base_version.is_some_and(|base| base < before.version)
            {
                body::rule::derive_on_answer(&tx, id, &old, &queued.id)?;
            } else {
                body::rule::derive(&tx, &catalog, &old, &after, &queued.id)?;
            }
        }
        tx.commit()?;
        Ok(queued)
    }

    /// Each link and embed of a file in the item's body, with the item it
    /// names or why it names none, read from the copy alone.
    pub fn body_links(&self, id: &str) -> Result<BodyLinks> {
        let conn = self.conn()?;
        store::refuse_unless_usable(&conn)?;
        body::rule::read(&conn, id)
    }

    /// The text that embeds the file item `file` in `host`'s body, which
    /// names that file alone; refused where none can.
    pub fn embed_text(&self, host: &str, file: &str) -> Result<String> {
        let conn = self.conn()?;
        store::refuse_unless_usable(&conn)?;
        body::rule::embed_text(&conn, host, file)
    }

    /// Not a purge: the row stays in the copy, trashed.
    pub fn delete_item(&self, id: &str) -> Result<QueuedWrite> {
        self.transition_locally(id, WriteKind::DeleteItem, ItemState::Trashed, "{}")
    }

    /// An item and the edges at it as the copy holds them, for a decision
    /// about the item to be checked against when it is carried out. `None`
    /// where the copy holds no such row.
    pub(crate) fn seen(&self, id: &str) -> Result<Option<Seen>> {
        let conn = self.conn()?;
        store::refuse_unless_usable(&conn)?;
        Seen::of(&conn, id)
    }

    /// The same, only while the copy still holds what `seen` read of the
    /// item, checked under the lock that queues the delete, so a change heard
    /// after the caller decided, a tag or an edge included, is never trashed
    /// with it. `None`, with nothing queued, where the row has moved on or
    /// gone.
    pub(crate) fn delete_item_at(&self, id: &str, seen: &Seen) -> Result<Option<QueuedWrite>> {
        self.lock.refuse_unless_writer()?;
        let conn = self.conn()?;
        store::refuse_unless_usable(&conn)?;
        match Seen::of(&conn, id)? {
            Some(now) if now == *seen => self
                .transition_held(
                    conn,
                    now.item,
                    WriteKind::DeleteItem,
                    ItemState::Trashed,
                    "{}",
                )
                .map(Some),
            _ => Ok(None),
        }
    }

    /// A row the copy does not hold, such as one read from the bin, is
    /// restored by id: queued, shown nowhere until the server answers, and
    /// held once the answer's read or its `item.restored` event brings it
    /// where the slice takes it (`queue-and-verdicts/restore-by-id`, `queue-and-verdicts/restore-not-entered` and `queue-and-verdicts/restore-once`).
    pub fn restore_item(&self, id: &str) -> Result<QueuedWrite> {
        self.lock.refuse_unless_writer()?;
        let mut conn = self.conn()?;
        let completeness = store::refuse_unless_writable(&conn)?;
        // Looked at and queued under one lock, so a row a held stream brings
        // in meanwhile is restored as a held row is.
        let tx = conn.transaction()?;
        if !store::items_by_ids(&tx, &[id.to_string()])?.is_empty() {
            drop(tx);
            drop(conn);
            return self.transition_locally(id, WriteKind::RestoreItem, ItemState::Active, "{}");
        }
        store::refuse_unless_held(completeness)?;
        if store::waiting_writes_for_item(&tx, id)?
            .iter()
            .any(|row| row.kind == WriteKind::RestoreItem)
        {
            return Err(CoreError::Invalid(format!(
                "a restore of {id} already waits to be sent"
            )));
        }
        let queued = store::enqueue(
            &tx,
            &store::NewWrite {
                kind: WriteKind::RestoreItem,
                item_id: Some(id),
                target_id: None,
                edge_id: None,
                namespace: None,
                tag: None,
                blob: None,
                base_version: None,
                payload: "{}",
                depends_on: &[],
            },
        )?;
        tx.commit()?;
        Ok(queued)
    }

    /// A page of the server's bin, newest change first, read online and held
    /// nowhere in the copy (`device/bin-read`, `device/bin-unheld` and `device/bin-offline`). Refused with what was met
    /// where the server cannot be read, and `NoServer` for a copy with none.
    pub fn bin(&self, r#type: Option<&str>, cursor: Option<&str>, limit: u32) -> Result<BinPage> {
        let page = self
            .http()?
            .bin_page(r#type, None, cursor, limit.clamp(1, 100))?;
        let catalog = catalog::Catalog::load(&*self.conn()?)?;
        let mut items = Vec::with_capacity(page.data.len());
        for row in page.data {
            let item = Item::from_wire(row.item, row.metadata.tags)?;
            let shown = catalog.shown(&item);
            items.push((item, shown));
        }
        Ok(BinPage {
            items,
            next_cursor: page.next_cursor,
        })
    }

    /// `revoked` is refused: only the server can reach it.
    pub fn transition_item(&self, id: &str, state: ItemState) -> Result<QueuedWrite> {
        if state == ItemState::Revoked {
            return Err(CoreError::Invalid(format!(
                "a device cannot move {id} to the revoked state; it is reachable only on a reserved type and on the server's authority"
            )));
        }
        let payload = serde_json::to_string(&serde_json::json!({ "state": state.as_str() }))?;
        self.transition_locally(id, WriteKind::TransitionItem, state, &payload)
    }

    fn transition_locally(
        &self,
        id: &str,
        kind: WriteKind,
        state: ItemState,
        payload: &str,
    ) -> Result<QueuedWrite> {
        self.lock.refuse_unless_writer()?;
        let conn = self.conn()?;
        let completeness = store::refuse_unless_writable(&conn)?;
        let Some(held) = store::items_by_ids(&conn, &[id.to_string()])?.pop() else {
            store::refuse_unless_held(completeness)?;
            return Err(CoreError::NotFound {
                code: "item_not_found".into(),
                message: format!("{id} is not a row this copy holds"),
            });
        };
        self.transition_held(conn, held, kind, state, payload)
    }

    /// Under the lock `conn` holds since `held` was read, so the write is
    /// queued against the row as read.
    fn transition_held(
        &self,
        mut conn: MutexGuard<'_, Connection>,
        held: Item,
        kind: WriteKind,
        state: ItemState,
        payload: &str,
    ) -> Result<QueuedWrite> {
        let id = held.id.as_str();
        refuse_system_type(&held.r#type)?;
        let deleting = kind == WriteKind::DeleteItem;
        let versioned = serde_json::json!({ "version": held.version }).to_string();
        let payload = if deleting {
            versioned.as_str()
        } else {
            payload
        };
        // Only the create, for the reason `queue_update` gives.
        let depends_on = store::untaken_creates_for_item(&conn, id)?;
        let tx = conn.transaction()?;
        store::hold_beneath_item(&tx, id)?;
        store::set_item_state(&tx, id, state)?;
        let queued = store::enqueue(
            &tx,
            &store::NewWrite {
                kind,
                item_id: Some(id),
                target_id: None,
                edge_id: None,
                namespace: None,
                tag: None,
                blob: None,
                base_version: deleting.then_some(held.version),
                payload,
                depends_on: &depends_on,
            },
        )?;
        if deleting {
            store::record_read(&tx, &queued.id, &serde_json::to_value(&held)?)?;
        }
        tx.commit()?;
        Ok(queued)
    }

    pub fn create_edge(&self, draft: &EdgeDraft) -> Result<QueuedWrite> {
        self.lock.refuse_unless_writer()?;
        let mut conn = self.conn()?;
        store::refuse_unless_whole(&conn)?;
        let tx = conn.transaction()?;
        let queued = queue_edge(&tx, draft, &[])?;
        tx.commit()?;
        Ok(queued)
    }

    /// A move of an end goes in the same write as the properties, so the
    /// edge is never absent between two writes. An edit that names no
    /// property and moves no end the copy does not already hold queues
    /// nothing and answers `None`: the server would take it, bump the edge's
    /// version and announce a change that never happened
    /// (`queue-and-verdicts/edge-edit-no-change`).
    pub fn update_edge(&self, id: &str, edit: &EdgeEdit) -> Result<Option<QueuedWrite>> {
        self.lock.refuse_unless_writer()?;
        let mut conn = self.conn()?;
        store::refuse_unless_whole(&conn)?;
        let Some(held) = store::edge_by_id(&conn, id)? else {
            return Err(CoreError::NotFound {
                code: "edge_not_found".into(),
                message: format!("{id} is not an edge this copy holds"),
            });
        };
        let Some(base) = edit.base_version else {
            return Err(CoreError::Invalid(format!(
                "an update to edge {id} carries no version; name the version the edit was based on"
            )));
        };
        if base != held.version {
            return Err(CoreError::Invalid(format!(
                "the update to edge {id} is based on version {base} and this copy holds version {}; read it again",
                held.version
            )));
        }
        // The server judges a named end against the edge it holds, which an
        // earlier waiting move may not leave where the copy shows it, so an
        // end the copy holds already is not sent.
        let mut edit = edit.clone();
        if edit.source_id.as_deref() == Some(held.source_id.as_str()) {
            edit.source_id = None;
        }
        if edit.target_id.as_deref() == Some(held.target_id.as_str()) {
            edit.target_id = None;
        }
        let edit = &edit;
        refuse_edge_move(&conn, &held, edit)?;
        integers::refuse_in_value(&edit.properties)?;
        if edit.is_empty() {
            return Ok(None);
        }
        let payload = edit.payload(base)?;
        let mut depends_on = store::untaken_create_for_edge(&conn, id)?;
        let mut next = held.clone();
        for (key, value) in &edit.properties {
            next.properties.insert(key.clone(), value.clone());
        }
        if let Some(source) = &edit.source_id {
            next.source_id = source.clone();
        }
        if let Some(target) = &edit.target_id {
            next.target_id = target.clone();
        }
        // An end moved to is an item the server has to hold first.
        for moved in [&edit.source_id, &edit.target_id].into_iter().flatten() {
            for waited in store::untaken_creates_for_item(&conn, moved)? {
                if !depends_on.contains(&waited) {
                    depends_on.push(waited);
                }
            }
        }
        let tx = conn.transaction()?;
        store::hold_beneath_edge(&tx, id)?;
        store::upsert_edge(&tx, &next.as_wire())?;
        let queued = store::enqueue(
            &tx,
            &store::NewWrite {
                kind: WriteKind::UpdateEdge,
                item_id: Some(&held.source_id),
                target_id: Some(&held.target_id),
                edge_id: Some(id),
                namespace: None,
                tag: None,
                blob: None,
                base_version: Some(base),
                payload: &payload,
                depends_on: &depends_on,
            },
        )?;
        tx.commit()?;
        Ok(Some(queued))
    }

    pub fn delete_edge(&self, id: &str) -> Result<QueuedWrite> {
        self.lock.refuse_unless_writer()?;
        let mut conn = self.conn()?;
        store::refuse_unless_whole(&conn)?;
        let held = held_edge(&conn, id)?;
        let tx = conn.transaction()?;
        let queued = queue_edge_delete(&tx, &held, &[])?;
        tx.commit()?;
        Ok(queued)
    }

    pub fn add_tag(&self, id: &str, tag: &str) -> Result<QueuedWrite> {
        let payload = serde_json::to_string(&serde_json::json!({ "tags": [tag] }))?;
        let tags = [tag.to_string()];
        self.tag_write(id, WriteKind::AddTag, Some(tag), &tags, &payload, |tx| {
            store::add_tags(tx, id, &tags)
        })
    }

    /// A removal is not held to the bound on a tag's name: an archive restore
    /// writes tags as recorded, so a row can hold one the bound refuses and
    /// must still be able to shed it.
    pub fn remove_tag(&self, id: &str, tag: &str) -> Result<QueuedWrite> {
        self.tag_write(id, WriteKind::RemoveTag, Some(tag), &[], "{}", |tx| {
            store::remove_tag(tx, id, tag)
        })
    }

    /// `admitted` are the tags the write adds, each held to the server's
    /// bound before anything is saved or queued.
    fn tag_write(
        &self,
        id: &str,
        kind: WriteKind,
        tag: Option<&str>,
        admitted: &[String],
        payload: &str,
        apply: impl FnOnce(&rusqlite::Transaction<'_>) -> Result<()>,
    ) -> Result<QueuedWrite> {
        self.lock.refuse_unless_writer()?;
        validation::tags(admitted)?;
        let mut conn = self.conn()?;
        let completeness = store::refuse_unless_writable(&conn)?;
        if !store::item_held(&conn, id)? {
            store::refuse_unless_held(completeness)?;
            return Err(CoreError::NotFound {
                code: "item_not_found".into(),
                message: format!("{id} is not a row this copy holds"),
            });
        }
        let depends_on = store::untaken_creates_for_item(&conn, id)?;
        let tx = conn.transaction()?;
        store::hold_beneath_item(&tx, id)?;
        let before = store::tag_count(&tx, id)?;
        apply(&tx)?;
        validation::tag_count(before, store::tag_count(&tx, id)?)?;
        let queued = store::enqueue(
            &tx,
            &store::NewWrite {
                kind,
                item_id: Some(id),
                target_id: None,
                edge_id: None,
                namespace: None,
                tag,
                blob: None,
                base_version: None,
                payload,
                depends_on: &depends_on,
            },
        )?;
        tx.commit()?;
        Ok(queued)
    }

    /// Only the tags land locally; an extension namespace is not part of the
    /// copy and is its own write.
    pub fn replace_metadata(&self, id: &str, write: &MetadataWrite) -> Result<QueuedWrite> {
        let payload = write.payload()?;
        self.tag_write(
            id,
            WriteKind::ReplaceMetadata,
            None,
            &write.tags,
            &payload,
            |tx| store::replace_tags(tx, id, &write.tags),
        )
    }

    /// Queued and not applied: the copy holds no extension namespaces.
    pub fn write_extension(&self, id: &str, namespace: &str, body: &str) -> Result<QueuedWrite> {
        self.extension_write(id, namespace, WriteKind::WriteExtension, body)
    }

    pub fn delete_extension(&self, id: &str, namespace: &str) -> Result<QueuedWrite> {
        self.extension_write(id, namespace, WriteKind::DeleteExtension, "{}")
    }

    fn extension_write(
        &self,
        id: &str,
        namespace: &str,
        kind: WriteKind,
        payload: &str,
    ) -> Result<QueuedWrite> {
        self.lock.refuse_unless_writer()?;
        let mut conn = self.conn()?;
        let completeness = store::refuse_unless_writable(&conn)?;
        if namespace.is_empty() {
            return Err(CoreError::Invalid(
                "an extension write names no namespace, and the namespace is where it goes".into(),
            ));
        }
        if kind == WriteKind::WriteExtension {
            integers::refuse_inexact_integers(payload)?;
        }
        if !store::item_held(&conn, id)? {
            store::refuse_unless_held(completeness)?;
            return Err(CoreError::NotFound {
                code: "item_not_found".into(),
                message: format!("{id} is not a row this copy holds"),
            });
        }
        let depends_on = store::untaken_creates_for_item(&conn, id)?;
        let tx = conn.transaction()?;
        let queued = store::enqueue(
            &tx,
            &store::NewWrite {
                kind,
                item_id: Some(id),
                target_id: None,
                edge_id: None,
                namespace: Some(namespace),
                tag: None,
                blob: None,
                base_version: None,
                payload,
                depends_on: &depends_on,
            },
        )?;
        tx.commit()?;
        Ok(queued)
    }

    /// The bytes are copied beside the working copy under their hash, and
    /// the queue holds only the hash: every write reads the queue whole to
    /// find what it depends on.
    pub fn put_blob(&self, path: &Path, mime_type: Option<&str>) -> Result<QueuedWrite> {
        self.with_upload(
            path,
            &blob::mime_type_for(path, mime_type),
            |_, _, upload, _| Ok(upload.clone()),
        )
    }

    #[cfg(test)]
    pub(crate) fn create_file_item(&self, path: &Path, draft: &Draft) -> Result<QueuedWrite> {
        self.lock.refuse_unless_writer()?;
        refuse_invalid_names(&draft.tags, &draft.properties)?;
        self.refuse_unwritable_type(&draft.r#type)?;
        store::refuse_unless_writable(&*self.conn()?)?;
        let file = std::fs::File::open(path).map_err(|error| {
            CoreError::Invalid(format!("{} cannot be read: {error}", path.display()))
        })?;
        self.create_file_item_from(path, file, draft)
    }

    pub(crate) fn create_file_item_from(
        &self,
        path: &Path,
        reader: impl std::io::Read,
        draft: &Draft,
    ) -> Result<QueuedWrite> {
        refuse_invalid_names(&draft.tags, &draft.properties)?;
        self.refuse_unwritable_type(&draft.r#type)?;
        let mime_type = blob::mime_type_for(path, None);
        let credential = self.credential();
        self.with_upload_reader(path, reader, &mime_type, |tx, catalog, upload, taken| {
            let mut draft = draft.clone();
            name_bytes(
                &mut draft.properties,
                catalog,
                &draft.r#type,
                taken,
                &mime_type,
            );
            queue_create(
                tx,
                catalog,
                &draft,
                std::slice::from_ref(&upload.id),
                credential.as_deref(),
            )
        })
    }

    #[cfg(test)]
    pub(crate) fn update_file_item(
        &self,
        id: &str,
        path: &Path,
        edit: &Edit,
        based: Based,
    ) -> Result<QueuedWrite> {
        self.lock.refuse_unless_writer()?;
        refuse_invalid_names(&[], &edit.properties)?;
        store::refuse_unless_writable(&*self.conn()?)?;
        let file = std::fs::File::open(path).map_err(|error| {
            CoreError::Invalid(format!("{} cannot be read: {error}", path.display()))
        })?;
        self.update_file_item_from(id, path, file, edit, based)
    }

    pub(crate) fn update_file_item_from(
        &self,
        id: &str,
        path: &Path,
        reader: impl std::io::Read,
        edit: &Edit,
        based: Based,
    ) -> Result<QueuedWrite> {
        refuse_invalid_names(&[], &edit.properties)?;
        // Before any bytes are taken in, as `refuse_unwritable_type` is.
        {
            let conn = self.conn()?;
            let completeness = store::refuse_unless_writable(&conn)?;
            if !store::item_held(&conn, id)? {
                store::refuse_unless_held(completeness)?;
            }
            if let Some(held) = store::item_by_id(&conn, id)? {
                refuse_system_type(&held.r#type)?;
            }
        }
        if let Some(r#type) = &edit.r#type {
            refuse_system_type(r#type)?;
        }
        let mime_type = blob::mime_type_for(path, None);
        self.with_upload_reader(path, reader, &mime_type, |tx, catalog, upload, taken| {
            let mut edit = edit.clone();
            let r#type = match &edit.r#type {
                Some(r#type) => Some(r#type.clone()),
                None => store::item_by_id(tx, id)?.map(|held| held.r#type),
            };
            if let Some(r#type) = r#type {
                name_bytes(&mut edit.properties, catalog, &r#type, taken, &mime_type);
            }
            queue_update(
                tx,
                catalog,
                id,
                &edit,
                std::slice::from_ref(&upload.id),
                based,
            )
        })
    }

    /// Checked before any bytes are taken in, so a refused create leaves no
    /// bytes behind that nothing names.
    fn refuse_unwritable_type(&self, r#type: &str) -> Result<()> {
        refuse_system_type(r#type)?;
        let conn = self.conn()?;
        if catalog::Catalog::load(&conn)?.known(r#type) {
            return Ok(());
        }
        Err(CoreError::UnknownType {
            message: format!("{type} is not a type this copy holds", type = r#type),
        })
    }

    /// One transaction: a write queued without the upload it names would
    /// name bytes the server is never sent.
    fn with_upload<T>(
        &self,
        path: &Path,
        mime_type: &str,
        then: impl FnOnce(&Connection, &catalog::Catalog, &QueuedWrite, &blob::Taken) -> Result<T>,
    ) -> Result<T> {
        self.lock.refuse_unless_writer()?;
        store::refuse_unless_writable(&*self.conn()?)?;
        let file = std::fs::File::open(path).map_err(|error| {
            CoreError::Invalid(format!("{} cannot be read: {error}", path.display()))
        })?;
        self.with_upload_reader(path, file, mime_type, then)
    }

    fn with_upload_reader<T>(
        &self,
        path: &Path,
        file: impl std::io::Read,
        mime_type: &str,
        then: impl FnOnce(&Connection, &catalog::Catalog, &QueuedWrite, &blob::Taken) -> Result<T>,
    ) -> Result<T> {
        self.lock.refuse_unless_writer()?;
        store::refuse_unless_writable(&*self.conn()?)?;
        let cache = self.cache()?;
        let queued = {
            // Until the upload is queued, nothing but this hold keeps its
            // bytes from a trim.
            let _held = cache.hold();
            let taken = cache.take_reader(path, file)?;
            let mut conn = self.conn()?;
            let catalog = catalog::Catalog::load(&conn)?;
            let tx = conn.transaction()?;
            let upload = queue_upload(&tx, &taken.hash, mime_type)?;
            let queued = then(&tx, &catalog, &upload, &taken)?;
            tx.commit()?;
            queued
        };
        self.trim_blobs();
        Ok(queued)
    }

    /// Three writes, each with its own verdict, each waiting on the one
    /// before it: the upload, a file item naming the bytes, and an
    /// `attached-to` edge from the file to the item. Answers the text that
    /// embeds the file in the item's body, which reads back as that edge.
    pub fn attach(&self, target: &str, path: &Path, attachment: &Attachment) -> Result<Attached> {
        self.lock.refuse_unless_writer()?;
        {
            let conn = self.conn()?;
            let completeness = store::refuse_unless_writable(&conn)?;
            if !store::item_held(&conn, target)? {
                store::refuse_unless_held(completeness)?;
            }
            // A row in the bin reads as absent, and a file attached to it
            // would be linked to something nobody can open.
            if store::item_by_id(&conn, target)?.is_none() {
                return Err(CoreError::NotFound {
                    code: "item_not_found".into(),
                    message: format!("{target} is not a row this copy holds"),
                });
            }
        }
        let (mime_type, mut draft) = file_draft(path, attachment, &[]);
        self.refuse_unwritable_type(&draft.r#type)?;
        let credential = self.credential();
        self.with_upload(path, &mime_type, |tx, catalog, upload, taken| {
            name_bytes(
                &mut draft.properties,
                catalog,
                &draft.r#type,
                taken,
                &mime_type,
            );
            // A name another attachment has would make an embed of this one
            // name two files; a title the caller chose is theirs.
            if attachment.title.is_none()
                && let Some(Value::String(title)) = draft.properties.get("title").cloned()
            {
                let title = body::rule::unique_title(tx, catalog, target, &title)?;
                draft.properties.insert("title".into(), title.into());
            }
            let item = queue_create(
                tx,
                catalog,
                &draft,
                std::slice::from_ref(&upload.id),
                credential.as_deref(),
            )?;
            let file = item.item_id.clone().unwrap_or_default();
            let edge = queue_edge(
                tx,
                &EdgeDraft {
                    source_id: file.clone(),
                    target_id: target.to_string(),
                    edge_type: body::rule::ATTACHMENT_EDGE.into(),
                    ..Default::default()
                },
                &[],
            )?;
            Ok(Attached {
                upload: upload.clone(),
                item,
                edge,
                embed: body::rule::embed_text(tx, target, &file).ok(),
            })
        })
    }

    pub fn add_file(&self, path: &Path, attachment: &Attachment, tags: &[String]) -> Result<Added> {
        self.lock.refuse_unless_writer()?;
        store::refuse_unless_writable(&*self.conn()?)?;
        let (mime_type, mut draft) = file_draft(path, attachment, tags);
        refuse_invalid_names(&draft.tags, &draft.properties)?;
        self.refuse_unwritable_type(&draft.r#type)?;
        let credential = self.credential();
        self.with_upload(path, &mime_type, |tx, catalog, upload, taken| {
            name_bytes(
                &mut draft.properties,
                catalog,
                &draft.r#type,
                taken,
                &mime_type,
            );
            let item = queue_create(
                tx,
                catalog,
                &draft,
                std::slice::from_ref(&upload.id),
                credential.as_deref(),
            )?;
            Ok(Added {
                upload: upload.clone(),
                item,
            })
        })
    }

    /// Fetched and held when not held already. With no way to fetch, the
    /// refusal is `BytesAbsent`.
    ///
    /// No trim in this process, through any handle on the store or on any
    /// thread, takes the bytes from when this is called until the answer is
    /// dropped, so a binding that hands the path on later holds the answer
    /// until it has. After that, or for a trim in another process, the bytes
    /// are the ones read most recently, so they are the last a trim takes
    /// unless they are larger than the file budget, when they are the first. A caller opens the path at once and reads
    /// through the handle.
    pub fn blob(&self, hash: &str) -> Result<BlobPath> {
        let hash = blob::named(hash)?;
        let cache = self.cache()?;
        if cache.requires_descriptor() {
            return Err(CoreError::Invalid("folder bytes are read through directory capabilities; this store cannot provide a pathname to reopen".into()));
        }
        let reading = cache.reading(&hash)?;
        if let Some(path) = cache.held(&hash)? {
            if self.handle() == Handle::Writer {
                cache.touch(&path);
            }
            #[cfg(debug_assertions)]
            crate::fault::hold(|| format!("blob-answered:{hash}"));
            return Ok(BlobPath {
                path,
                _reading: reading,
            });
        }
        let Some(http) = self.http.as_deref() else {
            let reason = match self.handle() {
                Handle::Reader => "a reading handle fetches nothing; the writer fetches them",
                Handle::Writer => "this working copy was opened with no server to fetch them from",
            };
            return Err(CoreError::BytesAbsent {
                hash,
                reason: reason.into(),
            });
        };
        let stated = self
            .conn()
            .ok()
            .and_then(|conn| store::stated_size(&conn, &hash).ok().flatten());
        let fetched = self.fetch_blob(cache, http, &hash, stated)?;
        self.trim_blobs();
        #[cfg(debug_assertions)]
        crate::fault::hold(|| format!("blob-answered:{hash}"));
        Ok(BlobPath {
            path: fetched.path,
            _reading: reading,
        })
    }

    /// No trim in this process, through any handle on the store or on any
    /// thread, takes the bytes from when this is called until the handle is
    /// answered; an open handle reads them after that whatever takes them.
    pub(crate) fn blob_file(&self, hash: &str) -> Result<std::fs::File> {
        let hash = blob::named(hash)?;
        let cache = self.cache()?;
        let _reading = cache.reading(&hash)?;
        match cache.open_held(&hash) {
            Ok(file) => {
                if self.handle() == Handle::Writer {
                    let _ = file.set_modified(std::time::SystemTime::now());
                }
                return Ok(file);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(CoreError::Store(format!("cannot read held bytes: {error}"))),
        }
        let Some(http) = self.http.as_deref() else {
            return Err(CoreError::BytesAbsent {
                hash,
                reason: "this handle cannot fetch bytes".into(),
            });
        };
        let stated = self
            .conn()
            .ok()
            .and_then(|conn| store::stated_size(&conn, &hash).ok().flatten());
        self.fetch_blob(cache, http, &hash, stated)?;
        let file = cache
            .open_held(&hash)
            .map_err(|error| CoreError::Store(format!("cannot read fetched bytes: {error}")))?;
        self.trim_blobs();
        Ok(file)
    }

    /// Fetches the bytes, and writes down how the partial file and the file
    /// kept were marked out of backups, whether or not the fetch finished.
    fn fetch_blob(
        &self,
        cache: &blob::Cache,
        http: &http::Http,
        hash: &str,
        stated: Option<u64>,
    ) -> Result<blob::Fetched> {
        let fetched = blob::fetch(
            cache,
            http,
            hash,
            stated,
            || self.kept_blobs(),
            || self.attachments_held(),
        );
        if let Some(mark) = cache.staged_mark() {
            self.write_down_backup_mark(&mark);
        }
        if let Ok(hex) = blob::hex_of(hash)
            && let Some(miss) = match &fetched {
                Ok(_) => Some(None),
                Err(error) => kept_miss(error).map(|(why, _)| Some(why)),
            }
            && let Ok(conn) = self.conn()
        {
            let _ =
                store::set_attachment_miss(&conn, hex, miss.map(file_cache::NotHeldReason::as_str));
        }
        let fetched = fetched?;
        self.write_down_backup_mark(&fetched.mark);
        Ok(fetched)
    }

    /// Keeps in the store why the last bytes fetched could not be kept out
    /// of backups, or clears it once they could, so every process's state
    /// report says so. Best effort: a store that cannot be written loses the
    /// note, never the bytes.
    fn write_down_backup_mark(&self, mark: &blob::Mark) {
        let unmarked = match mark {
            blob::Mark::Excluded => None,
            blob::Mark::Refused(reason) => Some(reason.as_str()),
            blob::Mark::Kept => return,
        };
        let Ok(conn) = self.conn() else {
            return;
        };
        let held = store::meta_get(&conn, file_cache::META_BACKUP_UNMARKED)
            .ok()
            .flatten();
        if held.as_deref() == unmarked {
            return;
        }
        let _ = match unmarked {
            Some(reason) => store::meta_set(&conn, file_cache::META_BACKUP_UNMARKED, reason),
            None => store::meta_delete(&conn, file_cache::META_BACKUP_UNMARKED),
        };
    }

    /// Takes bytes larger than the budget, then the bytes read longest ago,
    /// until the cache fits its budget, and
    /// answers how many it took. Bytes an upload still names are never
    /// taken, nor bytes a caller is reading. A trim that cannot read the
    /// queue or the setting takes nothing.
    fn trim_blobs(&self) -> u64 {
        if self.handle() != Handle::Writer {
            return 0;
        }
        let Ok(cache) = self.cache() else {
            return 0;
        };
        let _held = cache.hold();
        let Ok(setting) = self.file_budget() else {
            return 0;
        };
        self.trim_blobs_under(cache, setting)
    }

    /// `trim_blobs` to a setting the caller has just stored under the
    /// settling lock, which it still holds.
    fn trim_blobs_to(&self, setting: FileBudget) -> u64 {
        if self.handle() != Handle::Writer {
            return 0;
        }
        let Ok(cache) = self.cache() else {
            return 0;
        };
        self.trim_blobs_under(cache, setting)
    }

    fn trim_blobs_under(&self, cache: &blob::Cache, setting: FileBudget) -> u64 {
        let Some(kept) = self.kept_blobs() else {
            return 0;
        };
        // Held until the trim ends, so no attachment is made between the
        // read of the bytes attachments keep and the trim that spares them.
        let Some((_conn, attachments)) = self.attachments_held() else {
            return 0;
        };
        #[cfg(debug_assertions)]
        crate::fault::hold(|| format!("attachments-read:{:p}", self));
        cache.trim(&kept, &attachments, |held| {
            let volume = (setting == FileBudget::Default)
                .then(|| cache.volume())
                .flatten();
            file_cache::in_force(setting, volume, held).bytes
        })
    }

    pub(crate) fn let_go_blob(&self, hash: &str) {
        if self.handle() != Handle::Writer {
            return;
        }
        let Ok(cache) = self.cache() else {
            return;
        };
        if !cache.held(hash).is_ok_and(|held| held.is_some()) {
            return;
        }
        let _held = cache.hold();
        if let Some(kept) = self.kept_blobs() {
            cache.let_go(hash, &kept);
        }
    }

    pub(crate) fn write_down_renewals(&self, conn: &Connection) -> Result<()> {
        write_down_renewals(conn, &self.renewals)
    }

    fn kept_blobs(&self) -> Option<HashSet<String>> {
        let conn = self.conn().ok()?;
        let hashes = store::kept_uploads(&conn).ok()?;
        Some(
            hashes
                .iter()
                .filter_map(|hash| blob::hex_of(hash).ok().map(str::to_string))
                .collect(),
        )
    }

    /// The bytes attachments keep, by the hex of their hash, with the
    /// connection that read them, which no attachment is made or ended
    /// through while it is held. `None` where the copy cannot be read.
    fn attachments_held(&self) -> Option<(MutexGuard<'_, Connection>, HashSet<String>)> {
        let conn = self.conn().ok()?;
        let kept = store::kept_attachments(&conn).ok()?;
        Some((conn, kept))
    }

    /// Fetches the bytes of every file attached to an item the copy holds
    /// that the cache does not hold whole, smallest first, resuming any a
    /// fetch left part way. Stops at the first the volume has no room for,
    /// once the server cannot be reached, and once it asks for a wait longer
    /// than `RATE_LIMIT_WAITED`; a shorter one is waited out. A file that
    /// fails otherwise is passed over. Writes down why each not fetched is
    /// not held, which the state report gives. Ended with `Canceled` soon
    /// after `stop` is raised, between two files or during a wait. Refused
    /// to a reading handle and with no server.
    pub fn fetch_kept_until(&self, stop: &AtomicBool) -> Result<KeptFetch> {
        use file_cache::NotHeldReason as Why;
        self.lock.refuse_unless_writer()?;
        let cache = self.cache()?;
        if cache.requires_descriptor() {
            return Err(CoreError::Invalid(
                "a folder holds the files of its items in the folder itself, and keeps no attachments in a cache".into(),
            ));
        }
        let http = self.http()?;
        let groups = file_cache::by_bytes(&store::attachments(&*self.conn()?)?);
        // Written in one transaction once the fetch ends, however it ends.
        let mut notes = Vec::new();
        let mut readable = Vec::new();
        let mut wanted = Vec::new();
        for (hex, group) in groups {
            match cache.held(&hex) {
                Ok(Some(_)) => readable.push(hex),
                Ok(None) => wanted.push((hex, group.stated)),
                Err(_) => notes.push((hex, Why::Failed)),
            }
        }
        wanted.sort_by(|(a, a_size), (b, b_size)| {
            (a_size.is_none(), a_size, a).cmp(&(b_size.is_none(), b_size, b))
        });
        let mut report = KeptFetch {
            fetched: 0,
            fetched_bytes: 0,
            attachments: None,
        };
        let ended = self.fetch_wanted(cache, http, &wanted, stop, &mut report, &mut notes);
        {
            let mut conn = self.conn()?;
            let tx = conn.transaction()?;
            for hex in &readable {
                store::set_attachment_miss(&tx, hex, None)?;
            }
            for (hex, why) in &notes {
                store::set_attachment_miss(&tx, hex, Some(why.as_str()))?;
            }
            tx.commit()?;
        }
        ended?;
        report.attachments = self.file_cache()?.attachments;
        Ok(report)
    }

    /// The loop of `fetch_kept_until`, which adds to `notes` the files a
    /// stop leaves unfetched.
    fn fetch_wanted(
        &self,
        cache: &blob::Cache,
        http: &http::Http,
        wanted: &[(String, Option<u64>)],
        stop: &AtomicBool,
        report: &mut KeptFetch,
        notes: &mut Vec<(String, file_cache::NotHeldReason)>,
    ) -> Result<()> {
        use file_cache::NotHeldReason as Why;
        let mut waits = 0;
        let mut at = 0;
        while let Some((hex, stated)) = wanted.get(at) {
            catch_up::refuse_if_stopped(stop)?;
            let hash = format!("{}{hex}", blob::PREFIX);
            let error = match self.fetch_blob(cache, http, &hash, *stated) {
                Ok(fetched) => {
                    report.fetched += 1;
                    report.fetched_bytes +=
                        std::fs::metadata(&fetched.path).map_or(0, |held| held.len());
                    at += 1;
                    continue;
                }
                Err(error) => error,
            };
            let Some((why, stops)) = kept_miss(&error) else {
                return Err(error);
            };
            if why == Why::RateLimited
                && waits < RATE_LIMIT_WAITS
                && let Some(wait) = error
                    .retry_after()
                    .filter(|wait| *wait <= RATE_LIMIT_WAITED)
            {
                waits += 1;
                wait_unless_stopped(wait, stop)?;
                continue;
            }
            at += 1;
            if stops {
                notes.extend(wanted[at..].iter().map(|(hex, _)| (hex.clone(), why)));
                break;
            }
        }
        Ok(())
    }

    pub fn blob_held(&self, hash: &str) -> Result<bool> {
        Ok(self.cache()?.held(&blob::named(hash)?)?.is_some())
    }

    /// Only terminal verdicts go: a `blocked` or a `dead` row is one a
    /// caller may still release, and a refused write that carried content
    /// stays until it is discarded.
    pub fn forget_answered(&self) -> Result<usize> {
        self.lock.refuse_unless_writer()?;
        let mut conn = self.conn()?;
        // Read before the answers it reads go.
        body::rule::after_answers(&mut conn)?;
        store::forget_answered(&conn)
    }

    /// `forget_answered`, for the named writes alone, under the same rules:
    /// every other answered write stays, so an app that has read only some
    /// answers forgets only those. An id that names no write, or one not
    /// answered, is ignored.
    pub fn forget_answered_ids(&self, ids: &[String]) -> Result<usize> {
        self.lock.refuse_unless_writer()?;
        if ids.is_empty() {
            return Ok(0);
        }
        let mut conn = self.conn()?;
        body::rule::after_answers_of(&mut conn, Some(ids))?;
        store::forget_answered_ids(&conn, ids)
    }

    /// Asks again about the names bodies written here carry and no edge says
    /// yet. Best effort: a failure leaves them for the next pass, but for a
    /// store that can no longer be written.
    pub(crate) fn settle_bodies(&self, stop: &AtomicBool) -> Result<()> {
        match body::rule::settle(self, stop) {
            Err(error @ (CoreError::StorageFull(_) | CoreError::Store(_))) => Err(error),
            _ => Ok(()),
        }
    }

    /// Takes a refused write out of the queue, with what it carried. Answers
    /// `false` for a row that is not refused, or one a write still waits on,
    /// unless it is a create refused onto a row no read has found: the writes
    /// waiting on that one are refused unsent. A create's discard first waits
    /// for a drain already running to end.
    pub fn discard(&self, id: &str) -> Result<bool> {
        self.lock.refuse_unless_writer()?;
        // Only a create's discard refuses other writes, and a running drain
        // can make any create one whose landing waits for a read, so each
        // waits for the drain to end. The kind is all that cannot change.
        let create = store::queued_write(&*self.conn()?, id)?
            .is_some_and(|row| row.kind == WriteKind::CreateItem);
        let _one = create.then(|| self.one_drain());
        let mut conn = self.conn()?;
        let tx = conn.transaction()?;
        let discarded = store::discard(&tx, id)?;
        tx.commit()?;
        Ok(discarded)
    }

    pub fn status(&self) -> Result<Status> {
        // One snapshot: a hydration another handle completes between two
        // reads would pair `in_progress` with counts it has already cleared.
        let mut conn = self.conn()?;
        let tx = conn.transaction()?;
        let slice_types = match store::meta_get(&tx, store::META_SLICE_TYPES)? {
            Some(json) => serde_json::from_str(&json)?,
            None => Vec::new(),
        };
        let slice_tier = match store::meta_get(&tx, store::META_SLICE_TIER)? {
            Some(text) => Some(store::slice_tier(&text)?),
            None => None,
        };
        let event_cursor = store::meta_get(&tx, store::META_EVENT_CURSOR)?;
        let hydration = if store::refilling(&tx)? {
            Hydration::Stale
        } else if !store::hydration_complete(&tx)? {
            Hydration::InProgress
        } else if store::hydrated(&tx)? {
            Hydration::Complete
        } else if store::holds_slice(&tx)? {
            // A slice and no cursor, reach or instance, and no refill owed.
            Hydration::Expired
        } else {
            Hydration::Never
        };
        let filling = |key| -> Result<Option<u64>> {
            Ok(match hydration {
                // A stale copy holds these only while its refill runs or
                // was interrupted.
                Hydration::InProgress | Hydration::Stale => {
                    store::meta_get(&tx, key)?.and_then(|count| count.parse().ok())
                }
                _ => None,
            })
        };
        let status = Status {
            server_origin: store::meta_get(&tx, store::META_SERVER_ORIGIN)?,
            instance_id: store::meta_get(&tx, store::META_INSTANCE_ID)?,
            slice_types,
            slice_tier,
            slice_edge_types: store::whole_edge_types(&tx)?,
            pinned: store::pins(&tx)?,
            event_cursor,
            hydration,
            items: store::count(&tx, "items")?,
            items_expected: filling(store::META_ITEMS_EXPECTED)?,
            items_listed: filling(store::META_ITEMS_LISTED)?,
            edges: store::count(&tx, "edges")?,
            catalog_version: store::catalog_version(&tx)?,
            file_cache: self.file_cache_with(&tx)?,
        };
        tx.commit()?;
        Ok(status)
    }

    /// How the file cache's budget is chosen. A reading handle sees the
    /// writer's choice, since it lives in the store.
    pub fn file_budget(&self) -> Result<FileBudget> {
        Ok(FileBudget::stored(
            store::meta_get(&*self.conn()?, file_cache::META_BUDGET)?.as_deref(),
        ))
    }

    /// The cache's budget in force and the bytes it holds.
    pub fn file_cache(&self) -> Result<FileCache> {
        self.file_cache_with(&*self.conn()?)
    }

    fn file_cache_with(&self, conn: &Connection) -> Result<FileCache> {
        let setting =
            FileBudget::stored(store::meta_get(conn, file_cache::META_BUDGET)?.as_deref());
        let (sizes, volume) = match &self.cache {
            Some(cache) => (
                cache.sizes(),
                (setting == FileBudget::Default)
                    .then(|| cache.volume())
                    .flatten(),
            ),
            None => (Ok(HashMap::new()), None),
        };
        let held = sizes.as_ref().map(|sizes| sizes.values().sum::<u64>());
        // A folder holds its files in the folder, so its cache says nothing
        // of which attachments the device holds.
        let in_folder = self
            .cache
            .as_ref()
            .is_some_and(blob::Cache::requires_descriptor);
        let attachments = match &sizes {
            Ok(sizes) if !in_folder && !store::attachments_growing(conn)? => {
                Some(file_cache::attachments_of(
                    &store::attachments(conn)?,
                    store::attachments_not_in_copy(conn)?,
                    sizes,
                    &store::attachment_misses(conn)?,
                ))
            }
            _ => None,
        };
        // The bytes attachments keep are not counted against the budget, as
        // a trim counts them, so the default is worked from the rest. An
        // unknown count is worked from as none held, which is the smaller
        // default budget.
        let kept = store::kept_attachments(conn)?;
        let counted = sizes.as_ref().map_or(0, |sizes| {
            sizes
                .iter()
                .filter(|(name, _)| !blob::names_kept(&kept, name))
                .map(|(_, size)| size)
                .sum()
        });
        let in_force = file_cache::in_force(setting, volume, counted);
        Ok(FileCache {
            setting,
            budget: in_force.bytes,
            held: held.as_ref().ok().copied(),
            held_unreadable: held.err().cloned(),
            volume_unreadable: in_force.volume_unreadable,
            backup_mark_failure: store::meta_get(conn, file_cache::META_BACKUP_UNMARKED)?,
            attachments,
        })
    }

    /// Chooses how the cache's budget is set, and trims to it at once, so a
    /// lowered budget gives the space back without waiting for a fetch.
    /// Answers how many bytes the trim took. Refused to a reading handle.
    pub fn set_file_budget(&self, setting: FileBudget) -> Result<u64> {
        self.lock.refuse_unless_writer()?;
        // The setting and the trim to it are one step: under the cache's
        // settling lock, another call's setting cannot land between them.
        let _held = self.cache.as_ref().map(blob::Cache::hold);
        {
            let conn = self.conn()?;
            match setting.to_stored() {
                Some(text) => store::meta_set(&conn, file_cache::META_BUDGET, &text)?,
                None => store::meta_delete(&conn, file_cache::META_BUDGET)?,
            }
        }
        #[cfg(debug_assertions)]
        crate::fault::hold(|| format!("budget-stored:{:p}", self));
        Ok(self.trim_blobs_to(setting))
    }

    /// Trims the cache to its budget now, and answers how many bytes it
    /// took. Refused to a reading handle.
    pub fn trim_files(&self) -> Result<u64> {
        self.lock.refuse_unless_writer()?;
        Ok(self.trim_blobs())
    }

    /// Every item type the copy holds, by id, read from the copy alone.
    /// Refused `NoCatalog` where the copy has never held a catalog.
    pub fn item_types(&self) -> Result<Vec<ItemType>> {
        catalog::item_types(&*self.conn()?)
    }

    /// Refused `NotFound` where the catalog holds no such type.
    pub fn item_type(&self, id: &str) -> Result<ItemType> {
        catalog::item_type(&*self.conn()?, id)
    }

    /// Every edge type the copy holds, by id, read from the copy alone.
    pub fn edge_types(&self) -> Result<Vec<EdgeType>> {
        catalog::edge_types(&*self.conn()?)
    }

    /// Refused `NotFound` where the catalog holds no such edge type.
    pub fn edge_type(&self, id: &str) -> Result<EdgeType> {
        catalog::edge_type(&*self.conn()?, id)
    }

    /// The server's item types and edge types, read from it now, so a caller
    /// can choose a slice before a first hydration. Does not hydrate the
    /// copy. Refused `NoServer` for a copy with no server, and ended with
    /// `Canceled` as soon as `stop` is raised.
    pub fn server_catalog_until(&self, stop: &AtomicBool) -> Result<ServerCatalog> {
        let listed = catch_up::ask_unless_stopped(stop, self.http()?, http::Http::catalog)?;
        catalog::served(&listed)
    }

    /// A digest of the credential this copy sends with, where it has one.
    fn credential(&self) -> Option<String> {
        self.http()
            .ok()
            .map(|http| store::credential_digest(&http.authorization()))
    }

    fn http(&self) -> Result<&http::Http> {
        self.http.as_deref().ok_or(CoreError::NoServer)
    }

    fn claim_stream(&self, mover: Mover) -> Result<StreamClaim<'_>> {
        self.try_claim_stream(mover).map_err(|_| one_at_a_time())
    }

    /// Refused with what holds the stream.
    fn try_claim_stream(&self, mover: Mover) -> std::result::Result<StreamClaim<'_>, Mover> {
        let mut streaming = streaming_of(&self.streaming);
        if let Some(holder) = streaming.holder {
            return Err(holder);
        }
        streaming.holder = Some(mover);
        Ok(StreamClaim(&self.streaming))
    }

    fn claim_follow(&self) -> Result<FollowClaim<'_>> {
        let mut streaming = streaming_of(&self.streaming);
        if streaming.following {
            return Err(one_at_a_time());
        }
        streaming.following = true;
        Ok(FollowClaim(&self.streaming))
    }

    pub(crate) fn cache(&self) -> Result<&blob::Cache> {
        self.cache.as_ref().ok_or_else(|| {
            CoreError::Invalid("a store held in memory has nowhere to hold a blob's bytes".into())
        })
    }

    pub(crate) fn conn(&self) -> Result<MutexGuard<'_, Connection>> {
        let mut conn = self.conn.lock().map_err(|_| {
            CoreError::Store("the connection was poisoned by an earlier panic".into())
        })?;
        if self.handle() == Handle::Writer
            && store::hydration_complete(&conn)?
            && store::holds_slice(&conn)?
            && store::meta_get(&conn, store::META_EVENT_CURSOR)?.is_some()
            && !store::hydrated(&conn)?
        {
            let tx = conn.transaction()?;
            reach::expire(&tx)?;
            tx.commit()?;
        }
        Ok(conn)
    }
}

/// A renewal changes the bearer, not the credential, so each upload
/// recorded as sent with the replaced header is now recorded as sent with
/// the new one (`store::move_uploads_sent_as`).
/// The longest wait a server asks for that a fetch of attachments waits out,
/// and how many such waits it makes in a row, so a server that keeps asking
/// does not hold it for good.
const RATE_LIMIT_WAITED: Duration = Duration::from_secs(60);
const RATE_LIMIT_WAITS: u32 = 3;

/// Why a fetch that failed with `error` leaves an attachment's bytes unheld,
/// and whether a fetch of other bytes from the same server would fare the
/// same; `None` where the failure is not one file's, such as a key the
/// server refuses, which ends a fetch of attachments.
fn kept_miss(error: &CoreError) -> Option<(file_cache::NotHeldReason, bool)> {
    use file_cache::NotHeldReason as Why;
    Some(match error {
        CoreError::NoRoom { .. } | CoreError::StorageFull(_) => (Why::NoRoom, true),
        CoreError::BytesAbsent { reason, .. } => blob::why_absent(reason),
        CoreError::RateLimited { .. } | CoreError::Unnamed { status: 429, .. } => {
            (Why::RateLimited, true)
        }
        CoreError::Server { status: 500.., .. }
        | CoreError::Unnamed { .. }
        | CoreError::Network(_) => (Why::Unreachable, true),
        CoreError::Decoding(_)
        | CoreError::Server { .. }
        | CoreError::NotFound { .. }
        | CoreError::Validation { .. }
        | CoreError::Redirected { .. }
        | CoreError::Io(_)
        | CoreError::Store(_)
        | CoreError::Invalid(_) => (Why::Failed, false),
        _ => return None,
    })
}

/// Sleeps for `wait`, or until `stop` is raised, which ends it `Canceled`.
fn wait_unless_stopped(wait: Duration, stop: &AtomicBool) -> Result<()> {
    let until = std::time::Instant::now() + wait;
    loop {
        catch_up::refuse_if_stopped(stop)?;
        let left = until.saturating_duration_since(std::time::Instant::now());
        if left.is_zero() {
            return Ok(());
        }
        std::thread::sleep(left.min(Duration::from_millis(50)));
    }
}

fn write_down_renewals(conn: &Connection, pending: &Mutex<Vec<(String, String)>>) -> Result<()> {
    let renewals = std::mem::take(
        &mut *pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner),
    );
    for (from, to) in renewals {
        store::move_uploads_sent_as(conn, &from, &to)?;
    }
    Ok(())
}

fn keep_relocated_origin(
    conn: &Mutex<Connection>,
    claim: &lock::WriterLock,
    recorded_origin: &str,
    recorded_instance: Option<&str>,
    origin: &str,
    stopped: &AtomicBool,
) -> Result<()> {
    claim.refuse_unless_writer()?;
    let mut conn = loop {
        if stopped.load(Ordering::SeqCst) {
            return Err(CoreError::Canceled);
        }
        match conn.try_lock() {
            Ok(conn) => break conn,
            Err(std::sync::TryLockError::WouldBlock) => {
                std::thread::sleep(Duration::from_millis(5))
            }
            Err(std::sync::TryLockError::Poisoned(_)) => {
                return Err(CoreError::Store(
                    "the connection was poisoned by an earlier panic".into(),
                ));
            }
        }
    };
    let tx = conn.transaction()?;
    if stopped.load(Ordering::SeqCst) {
        return Err(CoreError::Canceled);
    }
    if store::meta_get(&tx, store::META_SERVER_ORIGIN)?.as_deref() != Some(recorded_origin)
        || store::meta_get(&tx, store::META_INSTANCE_ID)?.as_deref() != recorded_instance
    {
        return Err(CoreError::WrongServer {
            expected: recorded_origin.into(),
            got: origin.into(),
        });
    }
    store::meta_set(&tx, store::META_SERVER_ORIGIN, origin)?;
    tx.commit()?;
    Ok(())
}

/// Lets go of a pin, and of the row where the slice does not take it.
fn unpin_held(tx: &Connection, id: &str) -> Result<bool> {
    let pinned = store::unpin(tx, id)?;
    if pinned
        && store::waiting_writes_for_item(tx, id)?.is_empty()
        && let Some((types, tier)) = store::slice(tx)?
        && let Some(held) = store::items_by_ids(tx, &[id.to_string()])?.pop()
    {
        let catalog = catalog::Catalog::load(tx)?;
        if !reach::listed(tx, id)?
            || !store::slice_takes(&catalog, &types, tier, &held.r#type, held.tier)
        {
            store::evict_item(tx, id, &store::whole_edge_types(tx)?)?;
        }
    }
    Ok(pinned)
}

/// The names a write carries held to the server's bounds before anything is
/// saved or queued, so the server's refusal is never the first anyone hears
/// of an empty tag, an unnamed property or a whole number a float would
/// change.
fn refuse_invalid_names(
    tags: &[String],
    properties: &serde_json::Map<String, Value>,
) -> Result<()> {
    validation::tags(tags)?;
    validation::property_names(properties)?;
    integers::refuse_in_value(properties)
}

/// The server refuses a `system.*` write through the item operations to every
/// key (`items/system-types`), so one queued would show a change that never
/// lands until a drain says so.
fn refuse_system_type(r#type: &str) -> Result<()> {
    if !store::is_system(r#type) {
        return Ok(());
    }
    let door = if r#type == FOLDER_TYPE {
        ": a folder is written through the folder operations, `device folders create`, `change` and `revoke` on the command line"
    } else {
        ""
    };
    Err(CoreError::Forbidden {
        code: "type_not_permitted".into(),
        message: format!(
            "{type} is written only through its own operation, never as an item{door}"
        ),
    })
}

/// Whether the copy would take a new item made from `draft`, answered as
/// `write_create` would refuse it, with nothing queued or saved. A draft
/// naming a natural key is judged by the server, so it is not judged here.
/// Judged against the `catalog` the caller loaded, so a caller judging
/// many drafts keeps them to one revision.
pub(crate) fn check_create(catalog: &catalog::Catalog, draft: &Draft) -> Result<()> {
    refuse_unmakeable_create(catalog, draft)?;
    if draft.source_id.is_none() {
        catalog.validate_properties(&draft.r#type, &draft.properties, true)?;
    }
    Ok(())
}

/// What no copy could make an item of, whatever it holds: a name the server
/// would refuse, an id that is no id, a system type, or a type it does not hold.
fn refuse_unmakeable_create(catalog: &catalog::Catalog, draft: &Draft) -> Result<()> {
    refuse_invalid_names(&draft.tags, &draft.properties)?;
    if let Some(id) = &draft.id {
        validation::id("id", id)?;
    }
    refuse_system_type(&draft.r#type)?;
    if !catalog.known(&draft.r#type) {
        return Err(CoreError::UnknownType {
            message: format!("{} is not a type this copy holds", draft.r#type),
        });
    }
    // The states a type's lifecycle reaches from `active`: a `system.*` type
    // is refused above, and the rest reach every state but `revoked`
    // (`items/initial-state-refused`).
    if draft.state == Some(ItemState::Revoked) {
        return Err(CoreError::Validation {
            code: "validation_error".into(),
            message: format!(
                "{} cannot start in the revoked state; use active, archived or trashed",
                draft.r#type
            ),
        });
    }
    for (name, value) in [
        ("capture_latitude", draft.capture_latitude),
        ("capture_longitude", draft.capture_longitude),
    ] {
        if value.is_some_and(|value| !value.is_finite()) {
            return Err(CoreError::Validation {
                code: "validation_error".into(),
                message: format!("{name} must be a number"),
            });
        }
    }
    for (edge_type, targets) in &draft.edges {
        if edge_type.is_empty() {
            return Err(CoreError::NotFound {
                code: "edge_type_not_found".into(),
                message: "edges names an edge type with an empty id, which no edge type has".into(),
            });
        }
        for target in targets {
            validation::id("edges", target)?;
            if draft.id.as_deref() == Some(target.as_str()) {
                refuse_self_loop(target, target)?;
            }
        }
    }
    Ok(())
}

/// An id is minted here, where the draft names none, so a queued row is
/// readable locally before the server answers.
fn queue_create(
    tx: &Connection,
    catalog: &catalog::Catalog,
    draft: &Draft,
    after: &[String],
    credential: Option<&str>,
) -> Result<QueuedWrite> {
    refuse_unmakeable_create(catalog, draft)?;
    // A key naming no source is under the credential's own
    // (`items/source-own`), as learned for the credential in use; where it
    // is not known, the tier is chosen here and the drain asks.
    let key_source = match &draft.source_id {
        Some(_) => store::source_of(tx, draft.source.as_deref(), credential)?,
        None => None,
    };
    let target = match (&key_source, &draft.source_id) {
        (Some(source), Some(source_id)) => store::item_under_key(tx, source, source_id)?,
        _ => None,
    };
    let unresolved = target
        .as_ref()
        .map(|held| store::unanswered_keyed_create(tx, held))
        .transpose()?
        .unwrap_or(false);
    let current = target.as_ref().filter(|held| {
        !unresolved
            && held.r#type == draft.r#type
            && draft.base_version.is_none_or(|base| base == held.version)
    });
    let properties = if let Some(held) = current {
        let mut properties = held.properties.clone();
        properties.extend(catalog.projected_properties(&draft.r#type, &draft.properties, false));
        properties
    } else {
        draft.properties.clone()
    };
    // A natural key may name a row outside this slice. Its required fields
    // and a stale upsert's merged result can only be judged by the server.
    catalog.validate_properties(
        &draft.r#type,
        &properties,
        current.is_some() || draft.source_id.is_none(),
    )?;
    // A tier is chosen where none is named: left out, the server gives a new
    // row the key's default, and a row shown at one tier would come back at
    // another. Held and sent in the order the server answers, so the copy
    // shows one order before the answer and after it.
    let mut draft = draft.clone();
    draft.properties = catalog.in_answer_order(
        &draft.r#type,
        &catalog.created_properties(
            &draft.r#type,
            &catalog.coerced_properties(&draft.r#type, &draft.properties),
        ),
    );
    // A key naming a row the server answered sends no tier, since the server
    // leaves that row's tier as it stands (`items/tier-upsert`) and one sent
    // would move it. A key naming a create still waiting takes that create's
    // tier: if the create is refused, this one makes the row, and left out the
    // tier would be the credential's default. A key naming no row the copy
    // holds from the server may name one at a tier the slice leaves out, so
    // the drain asks the server before it sends the tier chosen here
    // (`queue-and-verdicts/keyed-create-lookup`).
    let keyed_tier = target.as_ref().and_then(|held| held.tier);
    let mut chosen = None;
    if draft.tier.is_none() && unresolved {
        draft.tier = keyed_tier;
        chosen = keyed_tier;
    }
    if draft.tier.is_none() && (unresolved || keyed_tier.is_none()) {
        let tier = match store::slice(tx)? {
            Some((_, tier)) => tier.create_tier(),
            // Nothing has named a tier yet, so the copy saves at the one an
            // app is reading unless it says otherwise.
            None if store::never_synced(tx)? => Tier::Library,
            None => return Err(CoreError::HydrationIncomplete),
        };
        draft.tier = Some(tier);
        chosen = Some(tier);
    }
    let chosen = chosen.filter(|_| draft.source_id.is_some());
    let draft = &draft;
    let shown_tier = draft.tier.or(keyed_tier);
    let id = draft
        .id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::now_v7().to_string());
    let payload = draft.payload(&id)?;
    let mut row = draft.wire(&id);
    row.tier = shown_tier.map(|tier| tier.as_str().into());
    store::upsert_item(
        tx,
        &row,
        Some(&draft.tags),
        &catalog.indexing(&draft.r#type),
    )?;
    // Shown at once, as the edges of a write that waits, until the answer
    // brings the server's. The server makes the item and every edge or
    // none, so a refusal takes them out with the item.
    for edge in draft.projected_edges(&id, &row.updated_at) {
        store::upsert_edge(tx, &edge)?;
    }
    // The server needs each target before it can draw an edge to it.
    let mut depends_on = after.to_vec();
    for targets in draft.edges.values() {
        for target in targets {
            for waited in store::untaken_creates_for_item(tx, target)? {
                if !depends_on.contains(&waited) {
                    depends_on.push(waited);
                }
            }
        }
    }
    // The answer's echo would otherwise let go of a row the slice does not
    // hold, and a create shown as saved would vanish with nothing said.
    let declared = store::slice(tx)?.is_some_and(|(types, tier)| {
        store::slice_takes(catalog, &types, tier, &row.r#type, shown_tier)
    });
    if !declared {
        store::pin(tx, &id)?;
    }
    let queued = store::enqueue(
        tx,
        &store::NewWrite {
            kind: WriteKind::CreateItem,
            item_id: Some(&id),
            target_id: None,
            edge_id: None,
            namespace: None,
            tag: None,
            blob: None,
            base_version: draft.base_version,
            payload: &payload,
            depends_on: &depends_on,
        },
    )?;
    if let Some(tier) = chosen {
        store::choose_tier(tx, &queued.id, tier)?;
    }
    if let (Some(source), Some(source_id)) = (&key_source, &draft.source_id) {
        store::follow_row_under_key(tx, &queued, source, source_id)?;
    }
    // Queued in the same transaction, so a create never drops its tags.
    for tag in &draft.tags {
        let body = serde_json::to_string(&serde_json::json!({ "tags": [tag] }))?;
        store::enqueue(
            tx,
            &store::NewWrite {
                kind: WriteKind::AddTag,
                item_id: Some(&id),
                target_id: None,
                edge_id: None,
                namespace: None,
                tag: Some(tag),
                blob: None,
                base_version: None,
                payload: &body,
                depends_on: std::slice::from_ref(&queued.id),
            },
        )?;
    }
    Ok(queued)
}

/// Whether a write reads the item's body as edges. A folder reads its own
/// files' bodies, and keeps its own record of what each showed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Body {
    Read,
    Folder,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Based {
    OnHeld,
    /// The held version or an earlier one, which the server merges against.
    AsRead,
}

fn queue_update(
    tx: &Connection,
    catalog: &catalog::Catalog,
    id: &str,
    edit: &Edit,
    after: &[String],
    based: Based,
) -> Result<QueuedWrite> {
    refuse_invalid_names(&[], &edit.properties)?;
    let Some(held) = store::item_by_id(tx, id)? else {
        return Err(CoreError::NotFound {
            code: "item_not_found".into(),
            message: format!("{id} is not a row this copy holds"),
        });
    };
    refuse_system_type(&held.r#type)?;
    if let Some(r#type) = &edit.r#type {
        refuse_system_type(r#type)?;
    }
    let Some(base) = edit.base_version else {
        return Err(CoreError::Invalid(format!(
            "an update to {id} carries no version; name the version the edit was based on"
        )));
    };
    if edit.clear_occurred_at && edit.occurred_at.is_some() {
        return Err(CoreError::Invalid(
            "an edit sets the item's time or clears it, not both".into(),
        ));
    }
    // The server sets a row's creation time when its create lands, so while
    // the create is unsent the time is cleared by sending none: not in the
    // create, nor in an edit queued behind it, all in this transaction.
    let mut unsent_create = None;
    if edit.clear_occurred_at {
        let waiting = store::untaken_creates_for_item(tx, id)?;
        if let [create] = waiting.as_slice()
            && store::unsent(tx, create)?
        {
            unsent_create = store::queued_write(tx, create)?;
        }
    }
    if unsent_create.is_some() {
        for row in store::waiting_writes_for_item(tx, id)? {
            if !matches!(row.kind, WriteKind::CreateItem | WriteKind::UpdateItem)
                || !store::unsent(tx, &row.id)?
            {
                continue;
            }
            let mut body: Value = serde_json::from_str(&store::payload_of(tx, &row.id)?)?;
            if body
                .as_object_mut()
                .and_then(|body| body.remove("occurred_at"))
                .is_some()
            {
                store::set_unsent_payload(tx, &row.id, &body.to_string())?;
            }
        }
    }
    // An unchanged type or tier is not sent: the drain reads one in a sent
    // edit as a move, and lets the row go where its answer is outside the
    // slice.
    let edit = &Edit {
        r#type: edit.r#type.clone().filter(|r#type| *r#type != held.r#type),
        tier: edit.tier.filter(|tier| Some(*tier) != held.tier),
        properties: catalog.coerced_properties(
            edit.r#type.as_deref().unwrap_or(&held.r#type),
            &edit.properties,
        ),
        // The server holds no empty time: an item with none of its own
        // takes its creation time, which no write changes.
        occurred_at: match (edit.clear_occurred_at, &unsent_create) {
            (true, Some(_)) => None,
            (true, None) => Some(held.created_at.clone()),
            (false, _) => edit.occurred_at.clone(),
        },
        clear_occurred_at: false,
        ..edit.clone()
    };
    if let Some(r#type) = edit.r#type.as_ref().filter(|r#type| !catalog.known(r#type)) {
        return Err(CoreError::UnknownType {
            message: format!("{type} is not a type this copy holds, so {id} cannot move to it"),
        });
    }
    let read_earlier = based == Based::AsRead && base > 0 && base <= held.version;
    if base != held.version && !read_earlier {
        return Err(CoreError::Invalid(format!(
            "the update to {id} is based on version {base} and this copy holds version {}; read it again",
            held.version
        )));
    }
    let payload = edit.payload(base)?;
    let projected = catalog.projected_properties(
        edit.r#type.as_deref().unwrap_or(&held.r#type),
        &edit.properties,
        edit.replace_properties,
    );
    // Recorded only where based on the held version: an edit based on an
    // earlier one was not made against the copy's row. A whole-properties
    // edit also changes every property it leaves out.
    let read = (base == held.version).then(|| {
        let cleared = held.properties.keys().filter(|_| edit.replace_properties);
        serde_json::json!({
            "properties": projected
                .keys()
                .chain(cleared)
                .map(|key| (key.clone(), held.properties.get(key).cloned().unwrap_or(Value::Null)))
                .collect::<serde_json::Map<String, Value>>(),
        })
    });
    let mut next = held.clone();
    // Only an edit that read the copy knows which properties it cleared.
    if edit.replace_properties && read.is_some() {
        next.properties = projected.clone();
    } else {
        for (key, value) in &projected {
            next.properties.insert(key.clone(), value.clone());
        }
    }
    // The natural key moves on the copy too: the folder reads the copy to
    // answer "who holds this name", and the next file to take the old name
    // would otherwise base its create on this row, which the server resolves
    // as an upsert onto it.
    if let Some(source_id) = &edit.source_id {
        next.source_id = Some(source_id.clone());
    }
    if let Some(r#type) = &edit.r#type {
        next.r#type = r#type.clone();
    }
    if let Some(tier) = edit.tier {
        next.tier = Some(tier);
    }
    if let Some(occurred_at) = &edit.occurred_at {
        next.occurred_at = time::projected(occurred_at);
    }
    // Shown as a create naming no time is shown until its answer.
    if let Some(create) = &unsent_create {
        next.occurred_at.clone_from(&create.queued_at);
        next.created_at.clone_from(&create.queued_at);
    }
    // Required nulls remain invalid even where replace projection drops
    // them. Stale edits cannot prove the server's eventual merged result.
    catalog.validate_properties(&next.r#type, &edit.properties, false)?;
    if base == held.version && !store::unanswered_keyed_create(tx, &held)? {
        catalog.validate_properties(&next.r#type, &next.properties, true)?;
    }
    store::hold_beneath_item(tx, id)?;
    store::upsert_item(tx, &next.as_wire(), None, &catalog.indexing(&next.r#type))?;
    // Only the row's untaken create, besides what the caller names: a write
    // held on every unanswered row would be refused with a sibling that
    // failed for its own reasons. Ordering behind earlier writes to the row
    // is recorded apart, by the queue.
    let mut depends_on = store::untaken_creates_for_item(tx, id)?;
    for waited in after {
        if !depends_on.contains(waited) {
            depends_on.push(waited.clone());
        }
    }
    let queued = store::enqueue(
        tx,
        &store::NewWrite {
            kind: WriteKind::UpdateItem,
            item_id: Some(id),
            target_id: None,
            edge_id: None,
            namespace: None,
            tag: None,
            blob: None,
            base_version: Some(base),
            payload: &payload,
            depends_on: &depends_on,
        },
    )?;
    if let Some(read) = &read {
        store::record_read(tx, &queued.id, read)?;
    }
    Ok(queued)
}

fn refuse_self_loop(source_id: &str, target_id: &str) -> Result<()> {
    if source_id == target_id {
        return Err(CoreError::Validation {
            code: "edge_cycle".into(),
            message: format!("an edge from {source_id} to itself closes a cycle"),
        });
    }
    Ok(())
}

/// Refuses what the server refuses of every such move whatever the rows
/// hold, judged against the edge as the copy shows it. The type is judged
/// from the catalog the copy holds; one it does not hold is left to the
/// server.
fn refuse_edge_move(conn: &Connection, held: &model::Edge, edit: &EdgeEdit) -> Result<()> {
    let (moved, source_id, target_id) = match (edit.source_id.as_deref(), edit.target_id.as_deref())
    {
        (None, None) => return Ok(()),
        (Some(_), Some(_)) => {
            return Err(CoreError::Validation {
                code: "validation_error".into(),
                message: format!(
                    "an update moves one end of edge {} at a time; delete it and create the edge wanted",
                    held.id
                ),
            });
        }
        (Some(source), None) => (catalog::End::Source, source, held.target_id.as_str()),
        (None, Some(target)) => (catalog::End::Target, held.source_id.as_str(), target),
    };
    match catalog::edge_type(conn, &held.edge_type) {
        Ok(edge_type) if !edge_type.one_at(moved.other()) => {
            return Err(CoreError::Validation {
                code: "validation_error".into(),
                message: format!(
                    "{} is {}, so the end that stays can hold more than this edge and there is none to replace; create the edge wanted and delete this one",
                    held.edge_type, edge_type.cardinality
                ),
            });
        }
        Ok(_) | Err(CoreError::NotFound { .. } | CoreError::NoCatalog) => {}
        Err(error) => return Err(error),
    }
    refuse_self_loop(source_id, target_id)
}

/// An edge the copy could not take is refused: no event about it would
/// reach the copy, so it would sit there as written for good. It waits on
/// its ends' creates and on `after`.
fn queue_edge(tx: &Connection, draft: &EdgeDraft, after: &[String]) -> Result<QueuedWrite> {
    if let Some(id) = &draft.id {
        validation::id("id", id)?;
    }
    refuse_self_loop(&draft.source_id, &draft.target_id)?;
    integers::refuse_in_value(&draft.properties)?;
    if !store::takes_edge(
        tx,
        &draft.source_id,
        &draft.edge_type,
        &store::whole_edge_types(tx)?,
    )? {
        return Err(CoreError::Invalid(format!(
            "{source} is not a row this copy holds, and {edge_type} is not an edge type its slice holds whole, so the copy cannot hold an edge from it",
            source = draft.source_id,
            edge_type = draft.edge_type,
        )));
    }
    let id = draft
        .id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::now_v7().to_string());
    let payload = draft.payload(&id)?;
    let mut depends_on: Vec<String> = after.to_vec();
    for endpoint in [&draft.source_id, &draft.target_id] {
        for id in store::untaken_creates_for_item(tx, endpoint)? {
            if !depends_on.contains(&id) {
                depends_on.push(id);
            }
        }
    }
    store::upsert_edge(tx, &draft.wire(&id))?;
    store::enqueue(
        tx,
        &store::NewWrite {
            kind: WriteKind::CreateEdge,
            item_id: Some(&draft.source_id),
            target_id: Some(&draft.target_id),
            edge_id: Some(&id),
            namespace: None,
            tag: None,
            blob: None,
            base_version: None,
            payload: &payload,
            depends_on: &depends_on,
        },
    )
}

fn conflicted_copies_in(
    conn: &Connection,
    id: &str,
    unreadable: &mut store::Unreadable,
) -> Result<Vec<Item>> {
    let sources: Vec<String> = store::edges_at(conn, "target_id", id, unreadable)?
        .into_iter()
        .filter(|edge| edge.edge_type == CONFLICTED_COPY_EDGE)
        .map(|edge| edge.source_id)
        .collect();
    Ok(store::items_by_ids_with(conn, &sources, unreadable)?
        .into_iter()
        .filter(|item| {
            item.state != ItemState::Trashed
                && item.tags.iter().any(|tag| tag == CONFLICTED_COPY_TAG)
        })
        .collect())
}

fn held_edge(conn: &Connection, id: &str) -> Result<model::Edge> {
    store::edge_by_id(conn, id)?.ok_or_else(|| CoreError::NotFound {
        code: "edge_not_found".into(),
        message: format!("{id} is not an edge this copy holds"),
    })
}

fn queue_edge_delete(tx: &Connection, held: &model::Edge, after: &[String]) -> Result<QueuedWrite> {
    let mut depends_on = store::untaken_create_for_edge(tx, &held.id)?;
    for waited in after {
        if !depends_on.contains(waited) {
            depends_on.push(waited.clone());
        }
    }
    // A refused delete is reconciled by reading edges by type, and the row
    // is gone from the copy by then.
    let payload = serde_json::json!({ "edge_type": held.edge_type }).to_string();
    store::hold_beneath_edge(tx, &held.id)?;
    store::delete_edge(tx, &held.id)?;
    store::enqueue(
        tx,
        &store::NewWrite {
            kind: WriteKind::DeleteEdge,
            item_id: Some(&held.source_id),
            target_id: Some(&held.target_id),
            edge_id: Some(&held.id),
            namespace: None,
            tag: None,
            blob: None,
            base_version: None,
            payload: &payload,
            depends_on: &depends_on,
        },
    )
}

fn file_draft(path: &Path, attachment: &Attachment, tags: &[String]) -> (String, Draft) {
    let mime_type = blob::mime_type_for(path, attachment.mime_type.as_deref());
    let title = attachment.title.clone().unwrap_or_else(|| {
        path.file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "file".into())
    });
    let mut properties = serde_json::Map::new();
    properties.insert("title".into(), title.into());
    let draft = Draft {
        r#type: blob::file_type_for(&mime_type, attachment.r#type.as_deref()),
        properties,
        tags: tags.to_vec(),
        tier: attachment.tier,
        ..Default::default()
    };
    (mime_type, draft)
}

/// The length goes only on a file, the one family that declares it. The
/// server sets it from the bytes it holds, so this is what the copy shows
/// until the server answers.
fn name_bytes(
    properties: &mut serde_json::Map<String, Value>,
    catalog: &catalog::Catalog,
    r#type: &str,
    taken: &blob::Taken,
    mime_type: &str,
) {
    properties.insert("blob_ref".into(), taken.hash.clone().into());
    properties.insert("mime_type".into(), mime_type.into());
    if catalog.matches("core.file", r#type) {
        properties.insert("size_bytes".into(), taken.size.into());
    }
}

fn queue_upload(conn: &Connection, hash: &str, mime_type: &str) -> Result<QueuedWrite> {
    let payload = serde_json::json!({ "hash": hash, "mime_type": mime_type }).to_string();
    store::enqueue(
        conn,
        &store::NewWrite {
            kind: WriteKind::UploadBlob,
            item_id: None,
            target_id: None,
            edge_id: None,
            namespace: None,
            tag: None,
            blob: Some(hash),
            base_version: None,
            payload: &payload,
            depends_on: &[],
        },
    )
}

fn fault_message(fault: &(dyn std::any::Any + Send)) -> String {
    format!(
        "the follow stopped on a fault in the core: {}",
        fault_said(fault)
    )
}

pub(crate) fn fault_said(fault: &(dyn std::any::Any + Send)) -> String {
    fault
        .downcast_ref::<&str>()
        .map(|said| (*said).to_string())
        .or_else(|| fault.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "no message".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::validation::MAX_TAG_LENGTH;

    #[test]
    fn a_server_debug_shows_its_url_and_never_its_key() {
        let server = Server {
            url: "https://marfa.example".into(),
            key: "marfa_k1_debug_witness".into(),
        };
        let shown = format!("{server:?} {server:#?}");
        assert!(shown.contains("https://marfa.example"), "{shown}");
        assert!(!shown.contains("marfa_k1_debug_witness"), "{shown}");
    }

    fn server_held_item(core: &Core, type_id: &str, properties: Value) -> String {
        let id = uuid::Uuid::now_v7().to_string();
        let mut row = store::testing::note(&id, "held", "body", "2026-01-01T00:00:00Z");
        row.r#type = type_id.into();
        row.properties = properties.as_object().unwrap().clone();
        store::put_server_item(
            &core.conn().unwrap(),
            &row,
            None,
            &crate::catalog::Catalog::empty(),
        )
        .unwrap();
        id
    }

    fn validation_copy() -> Core {
        let core = held_copy();
        let mut parent = store::testing::wire_type("acme.parent", None, Some("title"));
        parent.rest.insert(
            "fields".into(),
            serde_json::json!({
                "title": {"type": "string", "required": true, "maxLength": 4},
                "read": {"type": "boolean"},
                "choice": {"type": "enum", "enum_values": ["yes", "no"]},
                "count": {"type": "integer"},
                "list": {"type": "array", "maxItems": 2, "items": {"type": "string"}},
                "date": {"type": "date"}, "time": {"type": "datetime"},
                "email": {"type": "email"}, "url": {"type": "url"},
                "image": {"type": "thumbnail"}, "object": {"type": "object"},
                "annotated": {"type": "string", "format": "email"}
            }),
        );
        let mut child = store::testing::wire_type("acme.child", Some("acme.parent"), None);
        child.rest.insert(
            "fields".into(),
            serde_json::json!({
                "title": {"type": "string", "required": true, "maxLength": 5}
            }),
        );
        store::replace_types(&core.conn().unwrap(), &[parent, child]).unwrap();
        core
    }

    fn validation_draft(properties: Value) -> Draft {
        Draft {
            r#type: "acme.child".into(),
            properties: properties.as_object().unwrap().clone(),
            ..Default::default()
        }
    }

    #[cfg(unix)]
    #[test]
    fn captured_binary_upload_does_not_reopen_the_replacement_path() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap().join("owned");
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(root.join(".marfa")).unwrap();
        let admitted = directory::Directory::open(&root).unwrap();
        let state = admitted.child(Path::new(".marfa"), false).unwrap();
        let core = Core::open_directory(&state, &root.join(".marfa/core.sqlite"), None).unwrap();
        store::replace_types(
            &core.conn().unwrap(),
            &[store::testing::wire_type("core.file", None, Some("title"))],
        )
        .unwrap();
        let path = root.join("source.bin");
        std::fs::write(&path, b"original binary").unwrap();
        let mut file = admitted.capture_file(Path::new("source.bin")).unwrap();
        let size = file.metadata().unwrap().len();
        let mut captured = Vec::new();
        std::io::Read::read_to_end(&mut file, &mut captured).unwrap();
        assert_eq!(captured.len() as u64, size);
        let draft = Draft {
            r#type: "core.file".into(),
            ..Default::default()
        };
        let witness = core
            .create_file_item_from(&path, &captured[..], &draft)
            .unwrap()
            .item_id
            .unwrap();
        assert_eq!(
            core.get(&witness).unwrap().unwrap().properties["blob_ref"],
            blob::name_of(&captured)
        );
        std::fs::rename(&root, temp.path().join("original")).unwrap();
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(root.join(".marfa")).unwrap();
        std::fs::write(root.join(".marfa/core.sqlite"), b"foreign database").unwrap();
        std::fs::write(&path, b"foreign replacement").unwrap();
        let queued = core
            .create_file_item_from(&path, &captured[..], &draft)
            .unwrap()
            .item_id
            .unwrap();
        assert_eq!(
            core.get(&queued).unwrap().unwrap().properties["blob_ref"],
            blob::name_of(&captured)
        );
        core.update_file_item_from(
            &queued,
            &path,
            &b"captured update"[..],
            &Edit {
                base_version: Some(core.get(&queued).unwrap().unwrap().version),
                ..Edit::default()
            },
            Based::OnHeld,
        )
        .unwrap();
        assert_eq!(
            core.get(&queued).unwrap().unwrap().properties["blob_ref"],
            blob::name_of(b"captured update")
        );
        assert_eq!(std::fs::read(&path).unwrap(), b"foreign replacement");
        assert_eq!(
            std::fs::read(root.join(".marfa/core.sqlite")).unwrap(),
            b"foreign database"
        );
        assert_eq!(std::fs::read_dir(root.join(".marfa")).unwrap().count(), 1);
    }

    #[test]
    fn local_fields_distinguish_an_absent_type_from_a_known_empty_type() {
        let core = held_copy();
        assert!(
            core.update_item(
                "row",
                &Edit {
                    base_version: Some(3),
                    properties: serde_json::json!({"custom": 1})
                        .as_object()
                        .unwrap()
                        .clone(),
                    ..Default::default()
                }
            )
            .is_ok()
        );
        store::replace_types(&core.conn().unwrap(), &[]).unwrap();
        let before = core.queue().unwrap();
        assert!(matches!(
            core.update_item(
                "row",
                &Edit {
                    base_version: Some(3),
                    ..Default::default()
                }
            ),
            Err(CoreError::UnknownType { .. })
        ));
        assert_eq!(core.queue().unwrap(), before);
        assert!(core.add_tag("row", "after-type-deletion").is_ok());
    }

    #[test]
    fn local_fields_refuse_before_the_copy_or_queue_changes() {
        let core = validation_copy();
        let witness = core
            .create_item(&validation_draft(serde_json::json!({
                "title": "😀abc", "read": null, "choice": "yes", "count": 2.0,
                "list": [false, {}], "date": "2000-02-29", "time": "2026-01-01T23:59+23:59",
                "email": "reader+tag@example.test", "url": "mailto:reader@example.test",
                "image": "data:image/png;base64,iVBORw0KGgo=", "object": {},
                "annotated": "not an email", "custom": {"anything": null}
            })))
            .unwrap();
        let before = core.queue().unwrap();
        let rows = core
            .list(&ListFilters::default(), Sort::default())
            .unwrap()
            .rows;
        for (field, value) in [
            ("title", Value::Null),
            ("title", serde_json::json!("😀abcd")),
            ("title", serde_json::json!("a\u{0000}b")),
            ("read", serde_json::json!("yes")),
            ("choice", serde_json::json!("maybe")),
            ("count", serde_json::json!(2.5)),
            ("list", serde_json::json!([1, 2, 3])),
            ("date", serde_json::json!("1900-02-29")),
            ("time", serde_json::json!("2026-01-01T00:00:00")),
            ("email", serde_json::json!("a..b@example.test")),
            ("url", serde_json::json!("relative")),
            (
                "image",
                serde_json::json!("data:image/png;base64,iVBORw0KGgp="),
            ),
            ("object", serde_json::json!([])),
        ] {
            let mut draft = validation_draft(serde_json::json!({"title": "valid"}));
            draft.properties.insert(field.into(), value);
            let failure = core.create_item(&draft).unwrap_err();
            assert!(
                matches!(&failure, CoreError::Validation {code, message} if code == "invalid_properties" && message.contains(field)),
                "{failure:?}"
            );
            assert_eq!(core.queue().unwrap(), before);
            assert_eq!(
                core.list(&ListFilters::default(), Sort::default())
                    .unwrap()
                    .rows,
                rows
            );
        }
        assert!(
            core.create_item(&validation_draft(serde_json::json!({})))
                .is_err()
        );
        assert!(
            core.get(witness.item_id.as_deref().unwrap())
                .unwrap()
                .is_some()
        );
    }

    /// What the server refuses as a tag, beside what it takes at the bound.
    fn refused_tags() -> Vec<(String, &'static str)> {
        vec![
            (String::new(), "empty"),
            ("   ".into(), "blank"),
            ("\t\u{a0}\u{2003}\u{feff}".into(), "blank"),
            (".".into(), "URL path"),
            ("..".into(), "URL path"),
            ("a".repeat(MAX_TAG_LENGTH + 1), "at most"),
            ("😀".repeat(MAX_TAG_LENGTH / 2 + 1), "at most"),
        ]
    }

    fn accepted_tags() -> Vec<String> {
        vec![
            "a".repeat(MAX_TAG_LENGTH),
            "😀".repeat(MAX_TAG_LENGTH / 2),
            // JavaScript's trim does not strip it, so the server holds it.
            "\u{85}".into(),
            " padded ".into(),
        ]
    }

    #[test]
    fn a_tag_the_server_refuses_is_refused_before_the_copy_or_queue_changes() {
        let core = held_copy();
        for tag in accepted_tags() {
            assert!(core.add_tag("row", &tag).is_ok(), "{tag:?} was refused");
        }
        let before = core.queue().unwrap();
        let held = core.get("row").unwrap().unwrap();
        let unchanged = |what: &str| {
            assert_eq!(core.queue().unwrap(), before, "{what} queued a write");
            assert_eq!(core.get("row").unwrap().unwrap(), held, "{what} saved");
        };
        for (tag, reason) in refused_tags() {
            let named = format!("{tag:?}");
            let failures = [
                ("add_tag", core.add_tag("row", &tag).unwrap_err()),
                (
                    "replace",
                    core.replace_metadata(
                        "row",
                        &MetadataWrite {
                            tags: vec![tag.clone()],
                        },
                    )
                    .unwrap_err(),
                ),
                (
                    "create",
                    core.create_item(&Draft {
                        r#type: "core.note".into(),
                        tags: vec![tag.clone()],
                        ..Default::default()
                    })
                    .unwrap_err(),
                ),
            ];
            for (door, failure) in failures {
                assert!(
                    matches!(&failure, CoreError::Validation { code, message }
                        if code == "validation_error" && message.contains(reason)),
                    "{door} with {named}: {failure:?}"
                );
                unchanged(door);
            }
        }
        // Replacing with no tags clears them, and a removal is not held to
        // the bound: a row restored from an archive can hold a tag the bound
        // refuses and must be able to shed it.
        assert!(
            core.replace_metadata("row", &MetadataWrite { tags: vec![] })
                .is_ok()
        );
        store::add_tags(&core.conn().unwrap(), "row", &[String::new()]).unwrap();
        assert!(core.remove_tag("row", "").is_ok());
        // A dot tag held from before the bound is shed by a replace, whose
        // request does not name it in a URL path.
        let dots = vec![".".to_string(), "..".to_string()];
        store::add_tags(&core.conn().unwrap(), "row", &dots).unwrap();
        assert_eq!(core.get("row").unwrap().unwrap().tags, dots);
        assert!(
            core.replace_metadata(
                "row",
                &MetadataWrite {
                    tags: vec!["fine".into()],
                }
            )
            .is_ok()
        );
        assert_eq!(core.get("row").unwrap().unwrap().tags, vec!["fine"]);
    }

    #[test]
    fn a_property_with_no_name_is_refused_before_the_copy_or_queue_changes() {
        let core = held_copy();
        let named = |name: &str| {
            serde_json::json!({ "title": "t", name: 1 })
                .as_object()
                .unwrap()
                .clone()
        };
        let edit = |name: &str, replace| Edit {
            base_version: Some(3),
            properties: named(name),
            replace_properties: replace,
            ..Default::default()
        };
        let draft = |name: &str| Draft {
            r#type: "core.note".into(),
            properties: named(name),
            ..Default::default()
        };
        // The witness: the same writes with a name are taken.
        assert!(core.create_item(&draft("named")).is_ok());
        assert!(core.update_item("row", &edit("named", false)).is_ok());
        assert!(
            core.update_item_as_read("row", &edit("other", false))
                .is_ok()
        );
        let before = core.queue().unwrap();
        let held = core.get("row").unwrap().unwrap();
        for failure in [
            core.create_item(&draft("")).unwrap_err(),
            core.update_item("row", &edit("", false)).unwrap_err(),
            core.update_item("row", &edit("", true)).unwrap_err(),
            core.update_item_as_read("row", &edit("", false))
                .unwrap_err(),
        ] {
            assert!(
                matches!(&failure, CoreError::Validation { code, message }
                    if code == "validation_error" && message.contains("property name")),
                "{failure:?}"
            );
            assert_eq!(core.queue().unwrap(), before);
            assert_eq!(core.get("row").unwrap().unwrap(), held);
        }
    }

    #[test]
    fn a_file_added_with_a_tag_the_server_refuses_takes_in_no_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let core = Core::open(dir.path().join("core.sqlite"), None).unwrap();
        let file = dir.path().join("note.txt");
        std::fs::write(&file, b"bytes to hold").unwrap();
        let hash = blob::name_of(b"bytes to hold");
        let bad = ["".to_string()];
        let failure = core
            .add_file(&file, &Attachment::default(), &bad)
            .unwrap_err();
        assert!(
            matches!(failure, CoreError::Validation { .. }),
            "{failure:?}"
        );
        assert!(core.queue().unwrap().is_empty());
        assert!(
            !core.blob_held(&hash).unwrap(),
            "a refused file left its bytes behind"
        );
        let good = ["a".repeat(MAX_TAG_LENGTH)];
        assert!(core.add_file(&file, &Attachment::default(), &good).is_ok());
        assert!(core.blob_held(&hash).unwrap());
    }

    #[test]
    fn a_file_taken_in_shows_the_length_of_its_bytes_before_any_server_answers() {
        let dir = tempfile::tempdir().unwrap();
        let core = Core::open(dir.path().join("core.sqlite"), None).unwrap();
        store::replace_types(
            &core.conn().unwrap(),
            &[
                store::testing::wire_type("core.note", None, Some("title")),
                store::testing::wire_type("core.file", None, Some("title")),
                store::testing::wire_type("core.file.image", Some("core.file"), Some("title")),
                store::testing::wire_type("acme.scan", None, Some("title")),
            ],
        )
        .unwrap();
        let photo = dir.path().join("photo.png");
        std::fs::write(&photo, b"twelve bytes").unwrap();
        let longer = dir.path().join("longer.png");
        std::fs::write(&longer, b"fifteen bytes!!").unwrap();
        let size_of = |id: &str| {
            core.get(id)
                .unwrap()
                .unwrap()
                .properties
                .get("size_bytes")
                .cloned()
        };

        let added = core.add_file(&photo, &Attachment::default(), &[]).unwrap();
        let added = added.item.item_id.unwrap();
        assert_eq!(core.get(&added).unwrap().unwrap().r#type, "core.file.image");
        assert_eq!(size_of(&added), Some(12.into()));

        let note = core
            .create_item(&Draft {
                r#type: "core.note".into(),
                properties: serde_json::json!({ "title": "holder" })
                    .as_object()
                    .unwrap()
                    .clone(),
                ..Default::default()
            })
            .unwrap()
            .item_id
            .unwrap();
        let attached = core.attach(&note, &longer, &Attachment::default()).unwrap();
        assert_eq!(size_of(&attached.item.item_id.unwrap()), Some(15.into()));

        let draft = Draft {
            r#type: "core.file.image".into(),
            properties: serde_json::json!({ "title": "photo.png" })
                .as_object()
                .unwrap()
                .clone(),
            ..Default::default()
        };
        let created = core
            .create_file_item(&photo, &draft)
            .unwrap()
            .item_id
            .unwrap();
        assert_eq!(size_of(&created), Some(12.into()));
        let held = core.get(&created).unwrap().unwrap();
        let edit = Edit {
            base_version: Some(held.version),
            ..Edit::default()
        };
        core.update_file_item(&created, &longer, &edit, Based::OnHeld)
            .unwrap();
        assert_eq!(size_of(&created), Some(15.into()));

        let scan = Attachment {
            r#type: Some("acme.scan".into()),
            ..Attachment::default()
        };
        let other = core
            .add_file(&photo, &scan, &[])
            .unwrap()
            .item
            .item_id
            .unwrap();
        let other = core.get(&other).unwrap().unwrap();
        assert_eq!(
            other.properties.get("blob_ref"),
            Some(&blob::name_of(b"twelve bytes").into())
        );
        assert_eq!(
            other.properties.get("size_bytes"),
            None,
            "a type outside the file family took a size"
        );
    }

    #[test]
    fn local_fields_judge_current_whole_edits_but_only_stale_supplied_values() {
        let core = validation_copy();
        let mut row = store::testing::note("typed", "valid", "body", "2026-01-01T00:00:00Z");
        row.r#type = "acme.child".into();
        row.version = 3;
        store::put_server_item(
            &core.conn().unwrap(),
            &row,
            None,
            &crate::catalog::Catalog::empty(),
        )
        .unwrap();
        let edit = |base, properties: Value, replace| Edit {
            base_version: Some(base),
            properties: properties.as_object().unwrap().clone(),
            replace_properties: replace,
            ..Default::default()
        };
        let before = core.get("typed").unwrap();
        for bad in [
            edit(3, serde_json::json!({}), true),
            edit(3, serde_json::json!({"title": null}), false),
        ] {
            assert!(matches!(
                core.update_item("typed", &bad),
                Err(CoreError::Validation { .. })
            ));
            assert_eq!(core.get("typed").unwrap(), before);
            assert!(core.queue().unwrap().is_empty());
        }
        assert!(
            core.update_item("typed", &edit(3, serde_json::json!({"read": null}), false))
                .is_ok()
        );
        assert!(
            core.update_item_as_read("typed", &edit(1, serde_json::json!({"read": false}), true))
                .is_ok()
        );
        assert!(matches!(
            core.update_item_as_read("typed", &edit(1, serde_json::json!({"read": "yes"}), true)),
            Err(CoreError::Validation { .. })
        ));
        let created = core
            .create_item(&validation_draft(serde_json::json!({"title": "draft"})))
            .unwrap()
            .item_id
            .unwrap();
        assert!(matches!(
            core.update_item(&created, &edit(0, serde_json::json!({}), true)),
            Err(CoreError::Validation { .. })
        ));
        let retype = Edit {
            r#type: Some("acme.parent".into()),
            ..edit(3, serde_json::json!({}), false)
        };
        assert!(matches!(
            core.update_item("typed", &retype),
            Err(CoreError::Validation { .. })
        ));
    }

    #[test]
    fn local_fields_keep_unanswered_keyed_placeholders_unresolved() {
        let core = validation_copy();
        let keyed = |value: Value| Draft {
            source: Some("fixture".into()),
            source_id: Some("unseen".into()),
            ..validation_draft(value)
        };
        let first = core
            .create_item(&keyed(serde_json::json!({"read": true})))
            .unwrap();
        let id = first.item_id.unwrap();
        assert!(
            core.create_item(&keyed(serde_json::json!({"read": false})))
                .is_ok()
        );
        let edit = |value: Value| Edit {
            base_version: Some(0),
            properties: value.as_object().unwrap().clone(),
            replace_properties: true,
            ..Default::default()
        };
        assert!(
            core.update_item(&id, &edit(serde_json::json!({"read": false})))
                .is_ok()
        );
        let before = core.queue().unwrap();
        assert!(matches!(
            core.create_item(&keyed(serde_json::json!({"read": "yes"}))),
            Err(CoreError::Validation { .. })
        ));
        assert!(matches!(
            core.update_item(&id, &edit(serde_json::json!({"read": "yes"}))),
            Err(CoreError::Validation { .. })
        ));
        assert_eq!(core.queue().unwrap(), before);
        let ordinary = core
            .create_item(&validation_draft(serde_json::json!({"title": "valid"})))
            .unwrap()
            .item_id
            .unwrap();
        core.update_item(
            &ordinary,
            &Edit {
                source_id: Some("later-key".into()),
                ..edit(serde_json::json!({"title": "valid"}))
            },
        )
        .unwrap();
        assert!(matches!(
            core.update_item(&ordinary, &edit(serde_json::json!({}))),
            Err(CoreError::Validation { .. })
        ));
    }

    #[test]
    fn local_fields_judge_a_known_upsert_and_defer_an_unknown_targets_missing_fields() {
        let core = validation_copy();
        let mut row = store::testing::note("keyed", "valid", "body", "2026-01-01T00:00:00Z");
        row.r#type = "acme.child".into();
        row.source = "fixture".into();
        row.source_id = Some("known".into());
        row.version = 3;
        store::put_server_item(
            &core.conn().unwrap(),
            &row,
            None,
            &crate::catalog::Catalog::empty(),
        )
        .unwrap();
        let keyed = |key: &str, properties: Value| Draft {
            source: Some("fixture".into()),
            source_id: Some(key.into()),
            ..validation_draft(properties)
        };
        assert!(
            core.create_item(&keyed("known", serde_json::json!({"read": true})))
                .is_ok()
        );
        assert!(matches!(
            core.create_item(&keyed("known", serde_json::json!({"title": null}))),
            Err(CoreError::Validation { .. })
        ));
        assert!(
            core.create_item(&keyed("unknown", serde_json::json!({"read": false})))
                .is_ok()
        );
        assert!(matches!(
            core.create_item(&keyed("unknown", serde_json::json!({"read": "yes"}))),
            Err(CoreError::Validation { .. })
        ));
    }

    fn unreachable_server(url: &str) -> Option<Server> {
        Some(Server {
            url: url.into(),
            key: "marfa_k1_test".into(),
        })
    }

    #[test]
    fn an_edit_records_what_it_read_only_on_the_version_held() {
        let conn = store::open_in_memory().unwrap();
        let mut row = store::testing::note("row", "title", "held", "2026-01-01T00:00:00Z");
        row.version = 5;
        store::upsert_item(&conn, &row, None, &catalog::Indexing::default()).unwrap();
        store::replace_types(
            &conn,
            &[store::testing::wire_type("core.note", None, Some("title"))],
        )
        .unwrap();
        let catalog = catalog::Catalog::load(&conn).unwrap();
        let edit = |base| Edit {
            properties: serde_json::json!({ "body": "edited", "notes": "new" })
                .as_object()
                .unwrap()
                .clone(),
            base_version: Some(base),
            source_id: None,
            ..Edit::default()
        };
        let held = queue_update(&conn, &catalog, "row", &edit(5), &[], Based::OnHeld).unwrap();
        let read: Value =
            serde_json::from_str(&store::read_of(&conn, &held.id).unwrap().unwrap()).unwrap();
        assert_eq!(
            read,
            serde_json::json!({ "properties": { "body": "held", "notes": null } })
        );
        let earlier = queue_update(&conn, &catalog, "row", &edit(3), &[], Based::AsRead).unwrap();
        assert_eq!(store::read_of(&conn, &earlier.id).unwrap(), None);
    }

    fn held_copy() -> Core {
        let core = Core::open_in_memory(None).unwrap();
        {
            let conn = core.conn().unwrap();
            store::replace_types(
                &conn,
                &[store::testing::wire_type("core.note", None, Some("title"))],
            )
            .unwrap();
            store::meta_set(&conn, store::META_EVENT_CURSOR, "10").unwrap();
            store::meta_set(&conn, reach::FENCE, crate::scripted::FENCE).unwrap();
            store::meta_set(&conn, store::META_INSTANCE_ID, crate::scripted::INSTANCE).unwrap();
            store::meta_set(&conn, store::META_SLICE_TYPES, "[\"core.note\"]").unwrap();
            store::meta_set(&conn, store::META_SLICE_TIER, "library").unwrap();
            let mut row = store::testing::note("row", "server", "body", "2026-01-01T00:00:00Z");
            row.version = 3;
            store::put_server_item(
                &conn,
                &row,
                Some(&["a".into()]),
                &crate::catalog::Catalog::empty(),
            )
            .unwrap();
            store::put_server_edge(
                &conn,
                &store::testing::wire_edge("link", "row", "row", "references"),
            )
            .unwrap();
        }
        core
    }

    fn properties(value: serde_json::Value) -> serde_json::Map<String, Value> {
        value.as_object().unwrap().clone()
    }

    /// `{"deep": [[...]]}` with `arrays` arrays inside the one object.
    fn nested(arrays: usize) -> serde_json::Map<String, Value> {
        let mut inner = Value::Null;
        for _ in 0..arrays {
            inner = Value::Array(vec![inner]);
        }
        properties(serde_json::json!({ "deep": inner }))
    }

    #[test]
    fn a_write_nested_past_what_the_server_reads_is_refused_before_it_is_queued() {
        // The server refuses a request body nested more than `MAX_JSON_DEPTH`
        // levels (`items/json-depth`), so the largest `deep` is the one that
        // leaves the body, with its wrapper, at the limit: an item's and an
        // edge's properties sit one level down, an extension's body is the
        // object itself.
        let at = MAX_JSON_DEPTH - 2;
        let core = held_copy();
        store::put_server_item(
            &core.conn().unwrap(),
            &store::testing::note("other", "other", "body", "2026-01-01T00:00:00Z"),
            Some(&[]),
            &crate::catalog::Catalog::empty(),
        )
        .unwrap();
        let version = core.get("row").unwrap().unwrap().version;
        let queued = |core: &Core| core.queue().unwrap().len();
        let edit = |arrays: usize| Edit {
            properties: nested(arrays),
            base_version: Some(version),
            ..Edit::default()
        };
        let draft = |arrays: usize| Draft {
            r#type: "core.note".into(),
            properties: nested(arrays),
            ..Default::default()
        };
        let edge = |arrays: usize| EdgeDraft {
            source_id: "row".into(),
            target_id: "other".into(),
            edge_type: "references".into(),
            properties: nested(arrays),
            ..Default::default()
        };
        let edge_edit = |arrays: usize| EdgeEdit {
            properties: nested(arrays),
            base_version: Some(1),
            ..EdgeEdit::default()
        };
        let extension =
            |arrays: usize| serde_json::to_string(&Value::Object(nested(arrays))).unwrap();
        for (what, refused) in [
            ("create", core.create_item(&draft(at + 1)).map(|_| ())),
            ("update", core.update_item("row", &edit(at + 1)).map(|_| ())),
            ("edge", core.create_edge(&edge(at + 1)).map(|_| ())),
            (
                "edge update",
                core.update_edge("link", &edge_edit(at + 1)).map(|_| ()),
            ),
            (
                "extension",
                core.write_extension("row", "acme.x", &extension(at + 2))
                    .map(|_| ()),
            ),
        ] {
            assert!(
                matches!(refused, Err(CoreError::Invalid(_))),
                "{what}: {refused:?}"
            );
        }
        assert_eq!(queued(&core), 0, "a refused write was queued");
        // The witnesses: one level less is taken, and so is the limit itself.
        assert!(core.create_item(&draft(at)).is_ok());
        assert!(core.create_item(&draft(at - 1)).is_ok());
        assert!(core.update_item("row", &edit(at)).is_ok());
        assert!(core.create_edge(&edge(at)).is_ok());
        assert!(core.update_edge("link", &edge_edit(at)).is_ok());
        assert!(
            core.write_extension("row", "acme.x", &extension(at + 1))
                .is_ok()
        );
        assert_eq!(queued(&core), 6);
        // What was queued reads back, so no later read of the queue fails.
        assert_eq!(core.queue().unwrap().len(), 6);
    }

    #[test]
    fn a_create_with_state_location_and_edges_is_one_write_the_copy_already_shows() {
        let core = held_copy();
        let target = server_held_item(&core, "core.note", serde_json::json!({}));
        let draft = Draft {
            r#type: "core.note".into(),
            properties: serde_json::json!({ "title": "Pinned" })
                .as_object()
                .unwrap()
                .clone(),
            state: Some(ItemState::Archived),
            capture_latitude: Some(51.5),
            capture_longitude: Some(-0.25),
            edges: [("references".to_string(), vec![target.clone()])].into(),
            ..Default::default()
        };
        let queued = core.create_item(&draft).unwrap();
        let id = queued.item_id.clone().unwrap();
        // One write carries all three, as the server takes them.
        let writes = core.queue().unwrap();
        assert_eq!(writes.len(), 1);
        let body: Value =
            serde_json::from_str(&store::payload_of(&core.conn().unwrap(), &queued.id).unwrap())
                .unwrap();
        assert_eq!(body["state"], "archived");
        assert_eq!(body["capture_latitude"], 51.5);
        assert_eq!(body["edges"], serde_json::json!({ "references": [target] }));
        let shown = core.get(&id).unwrap().unwrap();
        assert_eq!(shown.state, ItemState::Archived);
        assert_eq!(
            (shown.capture_latitude, shown.capture_longitude),
            (Some(51.5), Some(-0.25))
        );
        let edges = core.edges_from(&id).unwrap();
        assert_eq!(edges.len(), 1);
        assert_eq!(
            (edges[0].target_id.as_str(), edges[0].edge_type.as_str()),
            (target.as_str(), "references")
        );
    }

    #[test]
    fn a_create_the_server_would_refuse_for_its_state_location_or_edges_is_refused_before_it_is_queued()
     {
        let core = held_copy();
        let base = || Draft {
            r#type: "core.note".into(),
            ..Default::default()
        };
        let bad = [
            Draft {
                state: Some(ItemState::Revoked),
                ..base()
            },
            Draft {
                capture_latitude: Some(f64::NAN),
                ..base()
            },
            Draft {
                edges: [(String::new(), vec![uuid::Uuid::now_v7().to_string()])].into(),
                ..base()
            },
            Draft {
                edges: [("references".to_string(), vec![String::new()])].into(),
                ..base()
            },
        ];
        for (n, draft) in bad.iter().enumerate() {
            let refused = core.create_item(draft);
            // The server answers an empty edge type `edge_type_not_found`.
            let as_served = if n == 2 {
                matches!(&refused, Err(CoreError::NotFound { code, .. }) if code == "edge_type_not_found")
            } else {
                matches!(&refused, Err(CoreError::Validation { .. }))
            };
            assert!(as_served, "{draft:?}: {refused:?}");
        }
        assert!(core.queue().unwrap().is_empty());
    }

    #[test]
    fn an_edit_sets_the_items_own_time_and_clearing_it_returns_the_creation_time() {
        let core = held_copy();
        let edit = |change: Edit| {
            let version = core.get("row").unwrap().unwrap().version;
            core.update_item(
                "row",
                &Edit {
                    base_version: Some(version),
                    ..change
                },
            )
        };
        edit(Edit {
            occurred_at: Some("2025-06-01T12:00:00Z".into()),
            ..Default::default()
        })
        .unwrap();
        let held = core.get("row").unwrap().unwrap();
        assert_eq!(held.occurred_at, "2025-06-01T12:00:00.000Z");
        edit(Edit {
            clear_occurred_at: true,
            ..Default::default()
        })
        .unwrap();
        let cleared = core.get("row").unwrap().unwrap();
        assert_eq!(cleared.occurred_at, "2026-01-01T00:00:00.000Z");
        assert!(matches!(
            edit(Edit {
                occurred_at: Some("2025-06-01T12:00:00Z".into()),
                clear_occurred_at: true,
                ..Default::default()
            }),
            Err(CoreError::Invalid(_))
        ));
    }

    #[test]
    fn a_whole_number_a_float_would_change_is_refused_in_an_edge_and_an_extension() {
        let core = held_copy();
        store::put_server_item(
            &core.conn().unwrap(),
            &store::testing::note("other", "other", "body", "2026-01-01T00:00:00Z"),
            Some(&[]),
            &crate::catalog::Catalog::empty(),
        )
        .unwrap();
        let edge = |properties: serde_json::Value| EdgeDraft {
            source_id: "row".into(),
            target_id: "other".into(),
            edge_type: "references".into(),
            properties: properties.as_object().unwrap().clone(),
            ..Default::default()
        };
        let edge_edit = |properties: serde_json::Value| EdgeEdit {
            properties: properties.as_object().unwrap().clone(),
            base_version: Some(1),
            ..EdgeEdit::default()
        };
        let refused = |result: Result<()>, where_: &str| match result {
            Err(CoreError::Validation { code, message }) => {
                assert_eq!(code, "invalid_properties", "{where_}");
                assert!(
                    message.contains("Must be a whole number that Marfa serves back"),
                    "{where_}: {message}"
                );
            }
            other => panic!("{where_} was not refused: {other:?}"),
        };
        refused(
            core.create_edge(&edge(
                serde_json::json!({ "weight": 9_999_999_999_999_999_999_u64 }),
            ))
            .map(|_| ()),
            "a new edge",
        );
        refused(
            core.create_edge(&edge(
                serde_json::json!({ "n": { "list": [1_152_921_504_606_846_976_i64] } }),
            ))
            .map(|_| ()),
            "a new edge, nested",
        );
        refused(
            core.update_edge(
                "link",
                &edge_edit(serde_json::json!({ "weight": 1_152_921_504_606_846_976_i64 })),
            )
            .map(|_| ()),
            "an edge edit",
        );
        for body in [
            r#"{"weight":9999999999999999999}"#,
            r#"{"a":{"b":[1152921504606846976]}}"#,
            r#"{"a":[1,{"b":-0}]}"#,
        ] {
            refused(
                core.write_extension("row", "acme.x", body).map(|_| ()),
                "an extension",
            );
        }
        assert_eq!(core.queue().unwrap().len(), 0, "a refused write was queued");

        // The witnesses: a number a float keeps, and a string of the digits.
        core.create_edge(&edge(
            serde_json::json!({ "weight": 1_152_921_504_606_847_000_i64 }),
        ))
        .unwrap();
        core.update_edge(
            "link",
            &edge_edit(serde_json::json!({ "weight": "9999999999999999999" })),
        )
        .unwrap();
        core.write_extension(
            "row",
            "acme.x",
            r#"{"weight":1152921504606847000,"s":"9999999999999999999","zero":-0.0,"minus":-1}"#,
        )
        .unwrap();
        assert_eq!(core.queue().unwrap().len(), 3);
    }

    #[test]
    fn a_damaged_edge_is_not_edited_or_deleted_over_and_a_server_copy_repairs_it() {
        let core = held_copy();
        let damaged = r#"{"position":1,"note":"#;
        let stored = |core: &Core| -> String {
            core.conn()
                .unwrap()
                .query_row(
                    "SELECT properties FROM edges WHERE id = 'link'",
                    [],
                    |row| row.get(0),
                )
                .unwrap()
        };
        core.conn()
            .unwrap()
            .execute(
                "UPDATE edges SET properties = ?1 WHERE id = 'link'",
                [damaged],
            )
            .unwrap();
        let version = core.edges_from_kept("row").unwrap()[0].0.version;
        let edit = EdgeEdit {
            properties: properties(serde_json::json!({ "position": 2 })),
            base_version: Some(version),
            ..EdgeEdit::default()
        };
        // The witness: the same edit on a readable edge is queued.
        let sound = held_copy();
        assert!(sound.update_edge("link", &edit).unwrap().is_some());

        assert!(core.update_edge("link", &edit).is_err());
        assert!(core.delete_edge("link").is_err());
        assert_eq!(stored(&core), damaged, "the damaged text was written over");
        assert_eq!(core.queue().unwrap().len(), 0);
        let conn = core.conn().unwrap();
        let beneath: i64 = conn
            .query_row("SELECT COUNT(*) FROM beneath", [], |row| row.get(0))
            .unwrap();
        assert_eq!(beneath, 0, "a row of empty properties was held beneath");
        // What needs only an edge's ends and type still finds a damaged one.
        assert!(store::edge_ends(&conn, "link").unwrap().is_some());
        drop(conn);

        // The server's copy replaces it.
        let conn = core.conn().unwrap();
        store::put_server_edge(
            &conn,
            &store::testing::wire_edge("link", "row", "row", "references"),
        )
        .unwrap();
        drop(conn);
        assert_eq!(core.edges_from("row").unwrap().len(), 1);
    }

    #[test]
    fn a_row_with_unreadable_properties_stays_in_a_kept_read_and_fails_a_refusing_one() {
        let core = held_copy();
        {
            let conn = core.conn().unwrap();
            for id in ["torn", "bare", "calm"] {
                let row = store::testing::note(id, id, "zebra", "2026-01-01T00:00:00Z");
                store::put_server_item(&conn, &row, Some(&[]), &crate::catalog::Catalog::empty())
                    .unwrap();
            }
            // A conflicted copy of "row", whose properties are among the damaged.
            let copy = store::testing::note("copy", "copy", "kept", "2026-01-01T00:00:00Z");
            store::put_server_item(
                &conn,
                &copy,
                Some(&[CONFLICTED_COPY_TAG.to_string()]),
                &crate::catalog::Catalog::empty(),
            )
            .unwrap();
            store::put_server_edge(
                &conn,
                &store::testing::wire_edge("derived", "copy", "row", CONFLICTED_COPY_EDGE),
            )
            .unwrap();
            conn.execute("UPDATE items SET properties = '' WHERE id = 'copy'", [])
                .unwrap();
            let unreadable = |table: &str, id: &str, text: &str| {
                conn.execute(
                    &format!("UPDATE {table} SET properties = ?1 WHERE id = ?2"),
                    [text, id],
                )
                .unwrap();
            };
            // Text that is not JSON, and JSON that is not an object.
            unreadable("items", "torn", r#"{"title":"#);
            unreadable("items", "bare", "[1]");
            unreadable("edges", "link", "{");
        }
        let filters = ListFilters::default();
        let search = SearchFilters::default();

        // The witness: each refusing read fails whole on the same store.
        assert!(matches!(
            core.list_shown(&filters, Sort::default()),
            Err(CoreError::Store(message)) if message.contains("torn") || message.contains("bare")
        ));
        assert!(core.search_shown("zebra", &search, 10).is_err());
        assert!(core.get_shown("torn").is_err());
        assert!(core.edges_from("row").is_err());

        let kept = core.list_kept(&filters, Sort::default()).unwrap().rows;
        let ids: Vec<&str> = kept.iter().map(|(item, _)| item.id.as_str()).collect();
        assert_eq!(ids.len(), 5, "{ids:?}");
        for (item, shown) in &kept {
            match item.id.as_str() {
                "row" | "calm" => assert_eq!(shown.unreadable_properties, None),
                id => {
                    assert!(item.properties.is_empty(), "{id}");
                    assert!(shown.unreadable_properties.is_some(), "{id}");
                    assert_eq!(shown.title, None);
                }
            }
        }
        let torn = &kept.iter().find(|(item, _)| item.id == "torn").unwrap().1;
        let reason = torn.unreadable_properties.as_deref().unwrap();
        assert!(reason.contains("not JSON"), "{reason}");
        assert!(
            !reason.contains("title"),
            "the stored text is not echoed: {reason}"
        );
        let bare = &kept.iter().find(|(item, _)| item.id == "bare").unwrap().1;
        assert!(
            bare.unreadable_properties
                .as_deref()
                .unwrap()
                .contains("not a JSON object")
        );

        // A damaged row matches no property condition, so a filtered list and
        // a filtered search leave it out and still answer.
        let titled = |title: &str| format!(r#"properties.title eq "{title}""#);
        let only_calm = core
            .list_kept(
                &ListFilters {
                    filter: Some(titled("calm")),
                    ..ListFilters::default()
                },
                Sort::default(),
            )
            .unwrap()
            .rows;
        assert_eq!(
            only_calm
                .iter()
                .map(|(item, _)| item.id.as_str())
                .collect::<Vec<_>>(),
            ["calm"]
        );
        let found = core
            .search_kept(
                "zebra",
                &SearchFilters {
                    filter: Some(titled("calm")),
                    ..SearchFilters::default()
                },
                10,
            )
            .unwrap()
            .rows;
        assert_eq!(
            found
                .iter()
                .map(|(hit, _)| hit.item.id.as_str())
                .collect::<Vec<_>>(),
            ["calm"]
        );

        let hits = core.search_kept("zebra", &search, 10).unwrap().rows;
        assert_eq!(hits.len(), 3);
        assert_eq!(
            hits.iter()
                .filter(|(hit, shown)| hit.item.properties.is_empty()
                    && shown.unreadable_properties.is_some())
                .count(),
            2
        );
        let (item, shown) = core.get_kept("torn").unwrap().unwrap();
        assert!(item.properties.is_empty() && shown.unreadable_properties.is_some());
        assert_eq!(
            core.get_kept("row")
                .unwrap()
                .unwrap()
                .1
                .unreadable_properties,
            None
        );

        assert!(core.conflicted_copies_of("row").is_err());
        let copies = core.conflicted_copies_kept("row").unwrap();
        assert_eq!(copies.len(), 1);
        assert_eq!(copies[0].0.id, "copy");
        assert!(copies[0].0.properties.is_empty() && copies[0].1.unreadable_properties.is_some());

        let edges = core.edges_from_kept("row").unwrap();
        assert_eq!(edges.len(), 1);
        assert!(edges[0].0.properties.is_empty() && edges[0].1.is_some());
        assert_eq!(core.edges_to_kept("row").unwrap().len(), 2);
        assert_eq!(core.edges_of_type_kept("references").unwrap().len(), 1);

        // Contained to the row: a write to a readable row still queues.
        core.update_item(
            "calm",
            &Edit {
                properties: properties(serde_json::json!({ "body": "next" })),
                base_version: Some(1),
                ..Edit::default()
            },
        )
        .unwrap();
        assert!(
            core.update_item(
                "torn",
                &Edit {
                    properties: properties(serde_json::json!({ "body": "next" })),
                    base_version: Some(1),
                    ..Edit::default()
                },
            )
            .is_err()
        );
    }

    #[test]
    fn a_keyed_create_naming_no_tier_leaves_the_held_rows_tier_and_sends_none() {
        for slice in ["all", "feed"] {
            let core = held_copy();
            {
                let conn = core.conn().unwrap();
                store::meta_set(&conn, store::META_SLICE_TIER, slice).unwrap();
                let mut inbox =
                    store::testing::note("inbox", "server", "body", "2026-01-01T00:00:00Z");
                inbox.tier = Some("feed".into());
                inbox.source = "reader".into();
                inbox.source_id = Some("article-1".into());
                store::put_server_item(&conn, &inbox, Some(&[]), &crate::catalog::Catalog::empty())
                    .unwrap();
            }
            let keyed = |source_id: &str| Draft {
                r#type: "core.note".into(),
                properties: properties(serde_json::json!({ "title": "Synced", "body": "again" })),
                source: Some("reader".into()),
                source_id: Some(source_id.into()),
                ..Default::default()
            };
            let resynced = core.create_item(&keyed("article-1")).unwrap();
            // The witness: a key naming no held row is queued at the slice's
            // tier, which the drain sends where a lookup finds no row.
            let fresh = core.create_item(&keyed("article-2")).unwrap();
            // A key naming a create still waiting is queued at that create's tier,
            // which it lands at whether or not the first is refused.
            let again = core.create_item(&keyed("article-2")).unwrap();
            let shown = |write: &QueuedWrite| {
                core.get(write.item_id.as_deref().unwrap())
                    .unwrap()
                    .unwrap()
                    .tier
            };
            assert_eq!(shown(&resynced), Some(Tier::Feed), "{slice}");
            let conn = core.conn().unwrap();
            let sent = |write: &QueuedWrite| {
                serde_json::from_str::<Value>(&store::payload_of(&conn, &write.id).unwrap())
                    .unwrap()
                    .get("tier")
                    .cloned()
            };
            assert_eq!(
                sent(&resynced),
                None,
                "a resync from a slice at {slice} moved the row"
            );
            let slice_tier: SliceTier = slice.parse().unwrap();
            assert_eq!(
                sent(&fresh),
                Some(Value::String(slice_tier.create_tier().as_str().into())),
                "{slice}"
            );
            assert_eq!(sent(&again), sent(&fresh), "{slice}");
            assert!(!store::pinned(&conn, resynced.item_id.as_deref().unwrap()).unwrap());

            // Laid back over a copy hydrated again, the re-save shows the tier
            // of the row its key names.
            let resynced_id = resynced.item_id.clone().unwrap();
            store::clear_slice(&conn).unwrap();
            let mut inbox = store::testing::note("inbox", "server", "body", "2026-01-01T00:00:00Z");
            inbox.tier = Some("feed".into());
            inbox.source = "reader".into();
            inbox.source_id = Some("article-1".into());
            store::put_server_item(&conn, &inbox, Some(&[]), &crate::catalog::Catalog::empty())
                .unwrap();
            assert!(!store::item_held(&conn, &resynced_id).unwrap());
            let catalog = catalog::Catalog::load(&conn).unwrap();
            hydrate::lay_queue_over(&conn, &catalog, &[], None).unwrap();
            assert_eq!(
                store::items_by_ids(&conn, std::slice::from_ref(&resynced_id))
                    .unwrap()
                    .pop()
                    .and_then(|item| item.tier),
                Some(Tier::Feed),
                "{slice}"
            );
        }
    }

    #[test]
    fn a_create_naming_no_tier_takes_the_slices_and_library_in_a_slice_of_both() {
        for (slice, named, sent, pinned) in [
            ("all", None, Tier::Library, false),
            ("all", Some(Tier::Feed), Tier::Feed, false),
            ("feed", None, Tier::Feed, false),
            ("library", None, Tier::Library, false),
            // The witness that a create the slice does not hold is told apart.
            ("library", Some(Tier::Feed), Tier::Feed, true),
        ] {
            let core = held_copy();
            store::meta_set(&core.conn().unwrap(), store::META_SLICE_TIER, slice).unwrap();
            let queued = core
                .create_item(&Draft {
                    r#type: "core.note".into(),
                    properties: properties(serde_json::json!({ "title": "Inbox" })),
                    tier: named,
                    ..Default::default()
                })
                .unwrap();
            let id = queued.item_id.clone().unwrap();
            assert_eq!(
                core.get(&id).unwrap().unwrap().tier,
                Some(sent),
                "shown from a slice at {slice}"
            );
            let conn = core.conn().unwrap();
            let body: Value =
                serde_json::from_str(&store::payload_of(&conn, &queued.id).unwrap()).unwrap();
            assert_eq!(body["tier"], sent.as_str(), "sent from a slice at {slice}");
            assert_eq!(
                store::pinned(&conn, &id).unwrap(),
                pinned,
                "pinned from a slice at {slice}"
            );
        }
    }

    #[test]
    fn an_item_write_to_a_system_row_is_refused_before_anything_is_saved_or_queued() {
        let core = held_copy();
        {
            let conn = core.conn().unwrap();
            store::replace_types(
                &conn,
                &[
                    store::testing::wire_type("core.note", None, Some("title")),
                    store::testing::wire_type(FOLDER_TYPE, None, Some("title")),
                ],
            )
            .unwrap();
            let folder = store::testing::wire_item(
                "folder",
                FOLDER_TYPE,
                "active",
                "2026-01-01T00:00:00Z",
                serde_json::json!({ "title": "Inbox" }),
            );
            store::put_server_item(&conn, &folder, Some(&[]), &crate::catalog::Catalog::empty())
                .unwrap();
        }
        let before = core.get("folder").unwrap();
        let held = store::count(&core.conn().unwrap(), "items").unwrap();
        let refused = |result: Result<QueuedWrite>, what: &str| match result {
            Err(CoreError::Forbidden { code, message }) => {
                assert_eq!(code, "type_not_permitted", "{what}");
                assert!(message.contains("folders create"), "{what}: {message}");
            }
            other => panic!("{what} was not refused type_not_permitted: {other:?}"),
        };
        refused(
            core.create_item(&Draft {
                r#type: FOLDER_TYPE.into(),
                properties: properties(serde_json::json!({ "title": "New" })),
                ..Default::default()
            }),
            "a create",
        );
        let edit = |r#type: Option<&str>| Edit {
            properties: properties(serde_json::json!({ "title": "Renamed" })),
            base_version: Some(1),
            r#type: r#type.map(str::to_string),
            ..Edit::default()
        };
        refused(core.update_item("folder", &edit(None)), "an edit");
        refused(
            core.update_item("folder", &edit(Some("core.note"))),
            "a retype from",
        );
        refused(core.delete_item("folder"), "a delete");
        refused(
            core.transition_item("folder", ItemState::Archived),
            "a transition",
        );
        refused(core.restore_item("folder"), "a restore");
        let retyped = Edit {
            base_version: Some(3),
            ..edit(Some(FOLDER_TYPE))
        };
        refused(core.update_item("row", &retyped), "a retype to");
        assert!(core.queue().unwrap().is_empty());
        assert_eq!(core.get("folder").unwrap(), before);
        assert_eq!(core.get("row").unwrap().unwrap().r#type, "core.note");
        assert_eq!(store::count(&core.conn().unwrap(), "items").unwrap(), held);

        // The witness: the same doors queue a write of a row that is not.
        core.update_item(
            "row",
            &Edit {
                base_version: Some(3),
                ..edit(None)
            },
        )
        .unwrap();
        core.transition_item("row", ItemState::Archived).unwrap();
        core.create_item(&Draft {
            r#type: "core.note".into(),
            properties: properties(serde_json::json!({ "title": "New" })),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(core.queue().unwrap().len(), 3);
    }

    #[test]
    fn a_copy_that_has_never_reached_a_server_saves_against_the_types_marfa_ships() {
        let core = Core::open_in_memory(None).unwrap();
        let note = core
            .create_item(&Draft {
                r#type: "core.note".into(),
                properties: properties(
                    serde_json::json!({ "title": "First", "body": "Saved offline" }),
                ),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(note.kind, WriteKind::CreateItem);
        assert_eq!(note.outcome().unwrap(), None);
        // Held, read and found, at the tier an app reads unless it says.
        let id = note.item_id.clone().unwrap();
        let held = core.get(&id).unwrap().unwrap();
        assert_eq!(held.tier, Some(Tier::Library));
        assert_eq!(
            core.list(&ListFilters::default(), Sort::default())
                .unwrap()
                .rows
                .len(),
            1
        );
        assert_eq!(
            core.search("offline", &SearchFilters::default(), 10)
                .unwrap()
                .rows
                .len(),
            1
        );
        assert_eq!(core.queue().unwrap().len(), 1);
        assert_eq!(core.status().unwrap().hydration, Hydration::Never);
        // The catalog is Marfa's own, and the server's is not held.
        assert!(
            core.item_types()
                .unwrap()
                .iter()
                .any(|held| held.id == "core.note")
        );
        assert!(!core.edge_types().unwrap().is_empty());
        assert_eq!(core.status().unwrap().catalog_version, None);
        // What the type refuses is refused here, before anything is queued.
        assert!(matches!(
            core.create_item(&Draft {
                r#type: "core.note".into(),
                properties: properties(serde_json::json!({ "title": 7 })),
                ..Default::default()
            }),
            Err(CoreError::Validation { .. })
        ));
        assert!(matches!(
            core.create_item(&Draft {
                r#type: "app.unheard-of.entry".into(),
                ..Default::default()
            }),
            Err(CoreError::UnknownType { .. })
        ));
        assert_eq!(core.queue().unwrap().len(), 1);
        // Nothing here can send it: a drain waits for a server and a copy.
        assert!(core.drain().is_err());
    }

    #[test]
    fn a_copy_checks_what_it_queues_against_the_types_the_app_declares() {
        let core = Core::open_in_memory(None).unwrap();
        let recipe = serde_json::json!({
            "id": "app.recipe.entry",
            "fields": {
                "title": { "type": "string", "required": true },
                "servings": { "type": "number" },
            },
        });
        let create = |value: serde_json::Value| {
            core.create_item(&Draft {
                r#type: "app.recipe.entry".into(),
                properties: properties(value),
                ..Default::default()
            })
        };
        // The witness: the type is refused until it is declared.
        assert!(matches!(
            create(serde_json::json!({ "title": "Soup" })),
            Err(CoreError::UnknownType { .. })
        ));
        core.declare_types(std::slice::from_ref(&recipe)).unwrap();
        assert!(create(serde_json::json!({ "title": "Soup", "servings": 4 })).is_ok());
        assert!(matches!(
            create(serde_json::json!({ "servings": 4 })),
            Err(CoreError::Validation { .. })
        ));
        assert!(matches!(
            create(serde_json::json!({ "title": "Soup", "servings": "four" })),
            Err(CoreError::Validation { .. })
        ));
        // Declared again, it is the new declaration; declared types survive a
        // reopen, which is how an app that declares at launch finds them.
        let renumbered = serde_json::json!({
            "id": "app.recipe.entry",
            "fields": { "title": { "type": "number", "required": true } },
        });
        core.declare_types(&[renumbered]).unwrap();
        assert!(matches!(
            create(serde_json::json!({ "title": "Soup" })),
            Err(CoreError::Validation { .. })
        ));
        assert!(create(serde_json::json!({ "title": 3 })).is_ok());
        assert_eq!(core.declared_types().unwrap().len(), 1);
        assert_eq!(core.declared_types().unwrap()[0]["version"], 0);
    }

    #[test]
    fn a_declaration_is_the_whole_set_the_app_holds() {
        let core = Core::open_in_memory(None).unwrap();
        let draft = |kind: &str| Draft {
            r#type: kind.into(),
            properties: serde_json::json!({ "title": "t" })
                .as_object()
                .unwrap()
                .clone(),
            ..Default::default()
        };
        core.declare_types(&[serde_json::json!({ "id": "app.recipe.entry", "fields": {} })])
            .unwrap();
        assert!(core.create_item(&draft("app.recipe.entry")).is_ok());
        // The app renames its type: the old one is no longer one it holds a
        // write to, and no longer one a hydration would register.
        core.declare_types(&[serde_json::json!({ "id": "app.dish.entry", "fields": {} })])
            .unwrap();
        assert!(matches!(
            core.create_item(&draft("app.recipe.entry")),
            Err(CoreError::UnknownType { .. })
        ));
        assert!(core.create_item(&draft("app.dish.entry")).is_ok());
        let held: Vec<String> = core
            .declared_types()
            .unwrap()
            .iter()
            .filter_map(|held| held["id"].as_str().map(str::to_string))
            .collect();
        assert_eq!(held, ["app.dish.entry"]);
    }

    #[test]
    fn a_declaration_refuses_app_names_without_exactly_three_segments() {
        let core = Core::open_in_memory(None).unwrap();
        for id in ["app.recipe", "app.recipe.entry.child"] {
            assert!(
                matches!(
                    core.declare_types(&[serde_json::json!({ "id": id, "fields": {} })]),
                    Err(CoreError::Invalid(_))
                ),
                "{id} cannot register but was declared"
            );
        }
        assert!(core.declared_types().unwrap().is_empty());
        core.declare_types(&[serde_json::json!({ "id": "app.recipe.entry", "fields": {} })])
            .unwrap();
    }

    #[test]
    fn a_declaration_refuses_reserved_type_roots() {
        let core = Core::open_in_memory(None).unwrap();
        let mut taken = Vec::new();
        for root in [
            "schema", "keys", "items", "webhooks", "config", "audit", "grants", "content",
            "metadata", "edge", "profile", "space", "marfa",
        ] {
            let id = format!("{root}.entry");
            if !matches!(
                core.declare_types(&[serde_json::json!({ "id": id, "fields": {} })]),
                Err(CoreError::Invalid(_))
            ) {
                taken.push(id);
            }
        }
        assert!(
            taken.is_empty(),
            "unregisterable roots were declared: {taken:?}"
        );
        assert!(core.declared_types().unwrap().is_empty());
    }

    #[test]
    fn a_declaration_accepts_publisher_prefixes_depth_and_the_identifier_boundary() {
        let core = Core::open_in_memory(None).unwrap();
        let boundary = format!("acme.{}", "a".repeat(123));
        let ids = [
            "app.recipe.entry",
            "user.recipe.entry",
            "acme-publisher.recipe",
            "acme.calendar.event",
            "keys-publisher.entry",
            "schema_tools.entry",
            boundary.as_str(),
        ];
        let definitions: Vec<_> = ids
            .iter()
            .map(|id| serde_json::json!({ "id": id, "fields": {} }))
            .collect();
        core.declare_types(&definitions).unwrap();
        let before = core.declared_types().unwrap();
        assert_eq!(before.len(), ids.len());
        for id in [
            format!("{boundary}a"),
            "app.recipe".into(),
            "keys.entry".into(),
        ] {
            assert!(
                matches!(
                    core.declare_types(&[
                        definitions[0].clone(),
                        serde_json::json!({ "id": id, "fields": {} })
                    ]),
                    Err(CoreError::Invalid(_))
                ),
                "{id} was declared"
            );
            assert_eq!(core.declared_types().unwrap(), before);
        }
    }

    #[test]
    fn a_declaration_is_refused_when_it_names_marfas_types_or_breaks_the_rules() {
        let core = Core::open_in_memory(None).unwrap();
        for (declaration, said) in [
            (serde_json::json!("app.x.entry"), "an object"),
            (serde_json::json!({ "fields": {} }), "names its id"),
            (
                serde_json::json!({ "id": "recipe" }),
                "not a type to declare",
            ),
            (
                serde_json::json!({ "id": "app.*" }),
                "not a type to declare",
            ),
            (serde_json::json!({ "id": "core.note" }), "Marfa's"),
            (serde_json::json!({ "id": "core.mine" }), "Marfa's"),
            (serde_json::json!({ "id": "system.mine" }), "Marfa's"),
            (
                serde_json::json!({ "id": "app.x.entry", "fields": [] }),
                "an object by name",
            ),
            (
                serde_json::json!({ "id": "app.x.entry", "fields": { "a": { "required": true } } }),
                "no type",
            ),
            (
                serde_json::json!({ "id": "app.x.entry", "fields": { "a": { "type": "nonsense" } } }),
                "not a field type",
            ),
            (
                serde_json::json!({ "id": "app.x.entry", "parent": "app.absent.entry" }),
                "neither a type Marfa ships nor one declared",
            ),
        ] {
            match core.declare_types(std::slice::from_ref(&declaration)) {
                Err(CoreError::Invalid(message)) => {
                    assert!(message.contains(said), "{declaration}: {message}")
                }
                other => panic!("{declaration} was taken: {other:?}"),
            }
        }
        assert!(core.declared_types().unwrap().is_empty());
        // A parent may be declared in the same call, after its child, or be one
        // Marfa ships.
        core.declare_types(&[
            serde_json::json!({ "id": "app.child.entry", "parent": "app.parent.entry" }),
            serde_json::json!({ "id": "app.parent.entry", "parent": "core.note" }),
        ])
        .unwrap();
        assert_eq!(core.declared_types().unwrap().len(), 2);
    }

    #[test]
    fn a_hydration_in_progress_or_expired_still_refuses_what_it_holds_and_what_is_saved() {
        let core = Core::open_in_memory(None).unwrap();
        {
            let conn = core.conn().unwrap();
            store::meta_set(&conn, store::META_SLICE_TYPES, "[\"core.note\"]").unwrap();
            store::meta_set(&conn, store::META_SLICE_TIER, "library").unwrap();
        }
        // A slice and no cursor is a copy that cannot be kept current.
        for refusal in [
            core.create_item(&Draft {
                r#type: "core.note".into(),
                ..Default::default()
            })
            .map(|_| ())
            .unwrap_err(),
            core.get("x").map(|_| ()).unwrap_err(),
        ] {
            assert_eq!(refusal, CoreError::HydrationIncomplete);
        }
    }

    #[test]
    fn a_full_store_refuses_a_local_edit_without_losing_the_queue() {
        let core = held_copy();
        let before = core.queue().unwrap();
        {
            let conn = core.conn().unwrap();
            let pages: i64 = conn
                .query_row("PRAGMA page_count", [], |row| row.get(0))
                .unwrap();
            conn.pragma_update(None, "max_page_count", pages).unwrap();
        }
        let edit = Edit {
            base_version: Some(3),
            properties: serde_json::json!({ "body": "x".repeat(1024 * 1024) })
                .as_object()
                .unwrap()
                .clone(),
            ..Default::default()
        };
        let failure = core.update_item("row", &edit);
        assert!(
            matches!(failure, Err(CoreError::StorageFull(_))),
            "{failure:?}"
        );
        assert_eq!(core.queue().unwrap(), before);
        core.conn()
            .unwrap()
            .pragma_update(None, "max_page_count", 10000)
            .unwrap();
        assert!(core.update_item("row", &edit).is_ok());
    }

    fn refuse(core: &Core, write: &QueuedWrite) {
        let conn = core.conn().unwrap();
        store::mark_sent(&conn, &write.id).unwrap();
        let row = store::queued_write(&conn, &write.id).unwrap().unwrap();
        store::record_refusal(&conn, &row, "type_not_permitted", None, false).unwrap();
    }

    #[test]
    fn a_refusal_puts_back_what_was_beneath_the_write_and_keeps_what_still_waits() {
        let core = held_copy();
        let tagged = core.add_tag("row", "b").unwrap();
        let edited = core
            .update_item(
                "row",
                &Edit {
                    properties: serde_json::json!({ "title": "mine" })
                        .as_object()
                        .unwrap()
                        .clone(),
                    base_version: Some(3),
                    ..Edit::default()
                },
            )
            .unwrap();
        let archived = core.transition_item("row", ItemState::Archived).unwrap();
        let unlinked = core.delete_edge("link").unwrap();
        let held = || core.get("row").unwrap().unwrap();
        assert_eq!(held().properties["title"], "mine");

        // The tag lands with an answer carrying no row, so the row beneath
        // the writes still waiting holds it too.
        {
            let conn = core.conn().unwrap();
            store::record_verdict(
                &conn,
                &tagged.id,
                &store::Answered {
                    verdict: Verdict::Accepted,
                    reason: None,
                    answer: None,
                    conflicted_copy_id: None,
                },
            )
            .unwrap();
            let mut baseline =
                store::testing::note("row", "server", "body", "2026-01-01T00:00:00Z");
            baseline.version = 3;
            store::put_server_item(
                &conn,
                &baseline,
                Some(&["a".into(), "b".into()]),
                &crate::catalog::Catalog::empty(),
            )
            .unwrap();
            store::lay_waiting_writes_over(&conn, "row", &|_| catalog::Indexing::default())
                .unwrap();
        }
        refuse(&core, &edited);
        assert_eq!(
            held().properties["title"],
            "server",
            "the copy went on showing an edit the server refused"
        );
        assert_eq!(
            held().state,
            ItemState::Archived,
            "a write still waiting was undone with the refused one"
        );
        assert_eq!(
            held().tags,
            ["a", "b"],
            "a tag the server took was undone by a refusal behind it"
        );
        assert_eq!(held().version, 3);

        refuse(&core, &archived);
        assert_eq!(held().state, ItemState::Active);
        assert_eq!(held().tags, ["a", "b"]);

        assert!(core.edges_from("row").unwrap().is_empty());
        refuse(&core, &unlinked);
        assert_eq!(
            core.edges_from("row").unwrap().len(),
            1,
            "a refused delete of an edge left the edge gone from the copy"
        );
        let conn = core.conn().unwrap();
        assert_eq!(
            store::beneath_item(&conn, "row").unwrap(),
            None,
            "a row with nothing waiting on it kept a row beneath"
        );
    }

    #[test]
    fn a_refused_edge_write_never_brings_back_an_edge_the_copy_let_go_of() {
        let core = held_copy();
        let unlinked = core.delete_edge("link").unwrap();
        {
            let conn = core.conn().unwrap();
            // The witness: while its source is held, a refusal puts it back.
            assert!(store::beneath_edge(&conn, "link").unwrap().is_some());
            store::evict_item(&conn, "row", &[]).unwrap();
        }
        refuse(&core, &unlinked);
        let conn = core.conn().unwrap();
        assert_eq!(
            store::edge_by_id(&conn, "link").unwrap(),
            None,
            "a refused delete put back an edge whose source left the copy"
        );
        assert_eq!(store::beneath_edge(&conn, "link").unwrap(), None);
    }

    #[test]
    fn a_refused_edge_delete_never_brings_back_an_edge_to_a_purged_row() {
        let core = held_copy();
        {
            let conn = core.conn().unwrap();
            let other = store::testing::note("other", "other", "body", "2026-01-01T00:00:00Z");
            store::put_server_item(&conn, &other, None, &crate::catalog::Catalog::empty()).unwrap();
            store::put_server_edge(
                &conn,
                &store::testing::wire_edge("link2", "row", "other", "references"),
            )
            .unwrap();
        }
        let unlinked = core.delete_edge("link2").unwrap();
        {
            let conn = core.conn().unwrap();
            assert!(store::beneath_edge(&conn, "link2").unwrap().is_some());
            store::purge_item(&conn, "other").unwrap();
        }
        refuse(&core, &unlinked);
        let conn = core.conn().unwrap();
        assert_eq!(
            store::edge_by_id(&conn, "link2").unwrap(),
            None,
            "a refused delete put back an edge to a row the server purged"
        );
    }

    #[test]
    fn a_refused_edge_delete_never_brings_back_an_edge_of_a_type_held_whole_from_a_purged_row() {
        let core = held_copy();
        {
            let conn = core.conn().unwrap();
            store::meta_set(&conn, store::META_SLICE_EDGE_TYPES, "[\"references\"]").unwrap();
        }
        let unlinked = core.delete_edge("link").unwrap();
        {
            let conn = core.conn().unwrap();
            store::purge_item(&conn, "row").unwrap();
        }
        refuse(&core, &unlinked);
        let conn = core.conn().unwrap();
        assert_eq!(
            store::edge_by_id(&conn, "link").unwrap(),
            None,
            "a refused delete put back an edge from a row the server purged"
        );
    }

    /// The server moved `link` to start at `elsewhere`, a row the copy does
    /// not hold, while a write of this device's to it waited.
    fn moved_off_the_slice(core: &Core) {
        let conn = core.conn().unwrap();
        let mut moved = store::testing::wire_edge("link", "elsewhere", "row", "references");
        moved.version = 2;
        store::put_server_edge(&conn, &moved).unwrap();
        store::lay_waiting_edge_writes_over(&conn, "link").unwrap();
    }

    #[test]
    fn a_row_leaving_keeps_an_edge_a_waiting_write_moved_off_it() {
        let core = movable_link();
        core.update_edge(
            "link",
            &EdgeEdit {
                base_version: Some(1),
                source_id: Some("other".into()),
                ..EdgeEdit::default()
            },
        )
        .unwrap();
        let conn = core.conn().unwrap();
        store::evict_item(&conn, "row", &[]).unwrap();
        assert_eq!(
            store::edge_by_id(&conn, "link")
                .unwrap()
                .map(|edge| edge.source_id),
            Some("other".to_string()),
            "a row leaving took an edge a waiting write moved to a row the copy holds"
        );
        assert!(store::beneath_edge(&conn, "link").unwrap().is_some());
    }

    /// `link` as a `supersedes` edge from `row` to `older`, so its source can
    /// move, and `other`, a row it can move to.
    fn movable_link() -> Core {
        let core = held_copy();
        {
            let conn = core.conn().unwrap();
            let other = store::testing::note("other", "other", "body", "2026-01-01T00:00:00Z");
            store::put_server_item(&conn, &other, None, &crate::catalog::Catalog::empty()).unwrap();
            store::put_server_edge(
                &conn,
                &store::testing::wire_edge("link", "row", "older", "supersedes"),
            )
            .unwrap();
        }
        core
    }

    fn moving(source_id: Option<&str>, target_id: Option<&str>) -> EdgeEdit {
        EdgeEdit {
            base_version: Some(1),
            source_id: source_id.map(str::to_string),
            target_id: target_id.map(str::to_string),
            ..EdgeEdit::default()
        }
    }

    #[test]
    fn an_edge_move_the_server_always_refuses_is_refused_before_it_is_queued() {
        let core = movable_link();
        {
            let conn = core.conn().unwrap();
            store::put_server_edge(
                &conn,
                &store::testing::wire_edge("many", "row", "other", "references"),
            )
            .unwrap();
        }
        let before = core.queue().unwrap();
        for (id, edit, code) in [
            (
                "link",
                moving(Some("other"), Some("row")),
                "validation_error",
            ),
            ("many", moving(Some("other"), None), "validation_error"),
            ("many", moving(None, Some("older")), "validation_error"),
            ("link", moving(Some("older"), None), "edge_cycle"),
            ("link", moving(None, Some("row")), "edge_cycle"),
        ] {
            let failure = core.update_edge(id, &edit).unwrap_err();
            assert!(
                matches!(&failure, CoreError::Validation { code: refused, .. } if refused == code),
                "{id} {edit:?}: {failure:?}"
            );
        }
        let failure = core
            .create_edge(&EdgeDraft {
                source_id: "row".into(),
                target_id: "row".into(),
                edge_type: "references".into(),
                ..EdgeDraft::default()
            })
            .unwrap_err();
        assert!(
            matches!(&failure, CoreError::Validation { code, .. } if code == "edge_cycle"),
            "{failure:?}"
        );
        assert_eq!(core.queue().unwrap(), before, "a refused move was queued");
        let conn = core.conn().unwrap();
        let link = store::edge_by_id(&conn, "link").unwrap().unwrap();
        assert_eq!(
            (link.source_id.as_str(), link.target_id.as_str()),
            ("row", "older")
        );

        // The witness: the same edge moves where the server would take it.
        drop(conn);
        let moved = core
            .update_edge("link", &moving(Some("other"), None))
            .unwrap()
            .unwrap();
        assert_eq!(moved.body["source_id"], "other");
    }

    #[test]
    fn an_edge_move_naming_the_end_that_stays_as_it_is_moves_the_other_one() {
        let core = movable_link();
        let edit = core
            .update_edge("link", &moving(Some("row"), Some("other")))
            .unwrap()
            .unwrap();
        assert_eq!(edit.body.get("source_id"), None, "{}", edit.body);
        assert_eq!(edit.body["target_id"], "other");
        let conn = core.conn().unwrap();
        let link = store::edge_by_id(&conn, "link").unwrap().unwrap();
        assert_eq!(
            (link.source_id.as_str(), link.target_id.as_str()),
            ("row", "other")
        );
    }

    #[test]
    fn an_edge_edit_that_changes_nothing_queues_nothing() {
        let core = movable_link();
        let before = core.queue().unwrap();
        for (what, edit) in [
            ("a move to the source it holds", moving(Some("row"), None)),
            ("a move to the target it holds", moving(None, Some("older"))),
            (
                "a move to both ends it holds",
                moving(Some("row"), Some("older")),
            ),
            ("no property and no move", moving(None, None)),
        ] {
            let queued = core.update_edge("link", &edit).unwrap();
            assert_eq!(queued, None, "{what} was queued");
        }
        assert_eq!(core.queue().unwrap(), before, "a no-op edit was queued");
        let conn = core.conn().unwrap();
        assert_eq!(
            store::beneath_edge(&conn, "link").unwrap(),
            None,
            "a no-op edit held the edge beneath a write that does not exist"
        );
        drop(conn);

        // The witness: the same edge, edited to something, is queued.
        let moved = core
            .update_edge("link", &moving(Some("other"), None))
            .unwrap();
        assert!(moved.is_some(), "an edit that moves an end was not queued");
    }

    #[test]
    fn a_no_op_edge_edit_is_still_refused_where_it_names_no_version_or_a_stale_one() {
        let core = movable_link();
        let unversioned = EdgeEdit {
            base_version: None,
            ..moving(Some("row"), None)
        };
        let stale = EdgeEdit {
            base_version: Some(7),
            ..moving(Some("row"), None)
        };
        for edit in [unversioned, stale] {
            let failure = core.update_edge("link", &edit).unwrap_err();
            assert!(matches!(failure, CoreError::Invalid(_)), "{failure:?}");
        }
        let failure = core.update_edge("absent", &moving(None, None)).unwrap_err();
        assert!(matches!(failure, CoreError::NotFound { .. }), "{failure:?}");
    }

    #[test]
    fn an_edge_edit_naming_the_end_it_holds_and_a_property_sends_only_the_property() {
        let core = movable_link();
        let edit = EdgeEdit {
            properties: serde_json::json!({ "note": "mine" })
                .as_object()
                .unwrap()
                .clone(),
            ..moving(Some("row"), Some("older"))
        };
        let queued = core
            .update_edge("link", &edit)
            .unwrap()
            .expect("an edit that changes a property was not queued");
        assert_eq!(
            queued.body,
            serde_json::json!({ "properties": { "note": "mine" }, "version": 1 })
        );
    }

    #[test]
    fn an_edge_move_waits_on_its_new_end_and_follows_that_create_to_its_answered_id() {
        let core = movable_link();
        let created = core
            .create_item(&Draft {
                r#type: "core.note".into(),
                properties: serde_json::json!({ "title": "new" })
                    .as_object()
                    .unwrap()
                    .clone(),
                ..Default::default()
            })
            .unwrap();
        let local = created.item_id.clone().unwrap();
        let moved = core
            .update_edge("link", &moving(Some(&local), None))
            .unwrap()
            .unwrap();
        assert_eq!(moved.depends_on, vec![created.id.clone()]);
        assert_eq!(
            core.edges_from(&local).unwrap().len(),
            1,
            "the move is not shown at once"
        );

        let conn = core.conn().unwrap();
        store::adopt_answered_id(&conn, &local, "answered").unwrap();
        let row = store::queued_write(&conn, &moved.id).unwrap().unwrap();
        let body = &row.body;
        assert_eq!(body["source_id"], "answered");
        assert_eq!(
            store::edge_by_id(&conn, "link").unwrap().unwrap().source_id,
            "answered"
        );
    }

    #[test]
    fn an_edge_move_onto_a_create_that_lands_on_a_held_row_goes_to_that_row() {
        let core = movable_link();
        let created = core
            .create_item(&Draft {
                r#type: "core.note".into(),
                properties: serde_json::json!({ "title": "new" })
                    .as_object()
                    .unwrap()
                    .clone(),
                ..Default::default()
            })
            .unwrap();
        let local = created.item_id.clone().unwrap();
        let moved = core
            .update_edge("link", &moving(Some(&local), None))
            .unwrap()
            .unwrap();
        let conn = core.conn().unwrap();
        let refused = store::land_on_held_row(&conn, &created, "other").unwrap();
        assert!(refused.is_empty(), "{refused:?}");
        let row = store::queued_write(&conn, &moved.id).unwrap().unwrap();
        assert_eq!(row.verdict, None);
        assert!(row.depends_on.is_empty());
        let body = &row.body;
        assert_eq!(body["source_id"], "other");
    }

    #[test]
    fn a_refused_edge_delete_never_brings_back_an_edge_moved_off_the_slice() {
        let core = held_copy();
        let unlinked = core.delete_edge("link").unwrap();
        moved_off_the_slice(&core);
        refuse(&core, &unlinked);
        let conn = core.conn().unwrap();
        assert_eq!(
            store::edge_by_id(&conn, "link").unwrap(),
            None,
            "a refused delete put back an edge whose source the copy does not hold"
        );
    }

    #[test]
    fn a_refused_edge_edit_lets_go_of_an_edge_moved_off_the_slice() {
        let core = held_copy();
        let edited = core
            .update_edge(
                "link",
                &EdgeEdit {
                    properties: serde_json::json!({ "note": "mine" })
                        .as_object()
                        .unwrap()
                        .clone(),
                    base_version: Some(1),
                    ..EdgeEdit::default()
                },
            )
            .unwrap()
            .unwrap();
        moved_off_the_slice(&core);
        assert!(core.edges_from("elsewhere").unwrap().len() == 1);
        refuse(&core, &edited);
        let conn = core.conn().unwrap();
        assert_eq!(
            store::edge_by_id(&conn, "link").unwrap(),
            None,
            "a refused edit left an edge whose source the copy does not hold"
        );
    }

    #[test]
    fn a_refused_write_with_content_stays_through_a_clearing_until_it_is_discarded() {
        let core = held_copy();
        let edited = core
            .update_item(
                "row",
                &Edit {
                    properties: serde_json::json!({ "title": "the words" })
                        .as_object()
                        .unwrap()
                        .clone(),
                    base_version: Some(3),
                    ..Edit::default()
                },
            )
            .unwrap();
        let tagged = core.add_tag("row", "b").unwrap();
        refuse(&core, &edited);
        refuse(&core, &tagged);
        assert_eq!(
            core.forget_answered().unwrap(),
            1,
            "the clearing took the refused edit, or kept the refused tag"
        );
        let queue = core.queue().unwrap();
        assert_eq!(queue.len(), 1);
        assert_eq!(queue[0].body["properties"]["title"], "the words");
        assert!(matches!(
            queue[0].outcome().unwrap(),
            Some(Outcome::Refused(Refusal { ref reason, .. })) if reason == "type_not_permitted"
        ));
        assert!(!core.discard(&tagged.id).is_ok_and(|taken| taken));
        assert!(core.discard(&edited.id).unwrap());
        assert!(core.queue().unwrap().is_empty());
    }

    #[test]
    fn forgetting_named_answered_writes_keeps_every_other_answer() {
        let core = held_copy();
        let first = core.add_tag("row", "b").unwrap();
        let second = core.add_tag("row", "c").unwrap();
        let unanswered = core.add_tag("row", "d").unwrap();
        for write in [&first, &second] {
            let mut conn = core.conn().unwrap();
            store::mark_sent(&conn, &write.id).unwrap();
            store::record_verdict(
                &conn,
                &write.id,
                &store::Answered {
                    verdict: Verdict::Accepted,
                    reason: None,
                    answer: None,
                    conflicted_copy_id: None,
                },
            )
            .unwrap();
            body::rule::after_answers(&mut conn).unwrap();
        }
        let ids = |core: &Core| {
            core.queue()
                .unwrap()
                .into_iter()
                .map(|write| write.id)
                .collect::<Vec<_>>()
        };
        assert_eq!(
            core.forget_answered_ids(&[
                first.id.clone(),
                unanswered.id.clone(),
                "no-such-write".into()
            ])
            .unwrap(),
            1,
            "the named answered write was kept, or one not answered or not held was counted"
        );
        assert_eq!(
            ids(&core),
            vec![second.id.clone(), unanswered.id.clone()],
            "an answer nobody named was forgotten with the one that was, so an app never reads it"
        );
        // The witness: an unrestricted clearing takes the answer kept above.
        assert_eq!(core.forget_answered().unwrap(), 1);
        assert_eq!(ids(&core), vec![unanswered.id.clone()]);
    }

    #[test]
    fn every_edge_of_one_type_is_read_at_once() {
        let core = Core::open_in_memory(None).unwrap();
        // A copy that has never reached a server answers from what it holds,
        // which is nothing yet.
        assert_eq!(core.edges_of_type("in-thread"), Ok(Vec::new()));
        {
            let conn = core.conn().unwrap();
            store::meta_set(&conn, store::META_HYDRATE_STATE, store::HYDRATE_IN_PROGRESS).unwrap();
        }
        assert_eq!(
            core.edges_of_type("in-thread"),
            Err(CoreError::HydrationIncomplete)
        );
        {
            let conn = core.conn().unwrap();
            store::meta_delete(&conn, store::META_HYDRATE_STATE).unwrap();
        }
        {
            let conn = core.conn().unwrap();
            store::meta_set(&conn, store::META_EVENT_CURSOR, "10").unwrap();
            store::meta_set(&conn, reach::FENCE, crate::scripted::FENCE).unwrap();
            store::meta_set(&conn, store::META_INSTANCE_ID, crate::scripted::INSTANCE).unwrap();
            store::meta_set(&conn, store::META_SLICE_TYPES, "[\"core.note\"]").unwrap();
            store::meta_set(&conn, store::META_SLICE_TIER, "library").unwrap();
            for id in ["root", "first", "second"] {
                let row = store::testing::note(id, id, id, "2026-01-01T00:00:00Z");
                store::upsert_item(&conn, &row, None, &catalog::Indexing::default()).unwrap();
            }
            for (id, source, target, edge_type) in [
                ("reply-first", "first", "root", "in-thread"),
                ("cites", "first", "second", "references"),
                ("reply-second", "second", "root", "in-thread"),
            ] {
                store::upsert_edge(
                    &conn,
                    &store::testing::wire_edge(id, source, target, edge_type),
                )
                .unwrap();
            }
        }
        let queued = core
            .create_edge(&EdgeDraft {
                source_id: "second".into(),
                target_id: "first".into(),
                edge_type: "in-thread".into(),
                ..Default::default()
            })
            .unwrap();
        let ids = |edge_type: &str| -> Vec<String> {
            core.edges_of_type(edge_type)
                .unwrap()
                .into_iter()
                .map(|edge| edge.id)
                .collect()
        };
        assert_eq!(
            ids("in-thread"),
            vec![
                "reply-first".to_string(),
                "reply-second".to_string(),
                queued.edge_id.unwrap(),
            ],
            "the read is not every edge of the type the copy holds, the unanswered one with them"
        );
        assert_eq!(ids("references"), vec!["cites".to_string()]);
        assert!(ids("attached-to").is_empty());
    }

    #[test]
    fn server_calls_need_a_server_and_catch_up_needs_a_cursor() {
        let offline = Core::open_in_memory(None).unwrap();
        assert_eq!(
            offline.hydrate(&["core.note".into()], SliceTier::Library),
            Err(CoreError::NoServer)
        );
        assert_eq!(offline.catch_up(), Err(CoreError::NoServer));
        let fresh = Core::open_in_memory(unreachable_server("http://127.0.0.1:9")).unwrap();
        assert_eq!(fresh.catch_up(), Err(CoreError::NoCursor));
        assert!(matches!(
            fresh.hydrate(&[], SliceTier::Library),
            Err(CoreError::Invalid(_))
        ));
        assert!(matches!(
            fresh.hydrate(&["*".into(), "core.note".into()], SliceTier::Library),
            Err(CoreError::Invalid(_))
        ));
    }

    #[test]
    fn a_thumbnail_is_read_from_the_held_row_and_never_searched() {
        use base64::Engine;
        let dir = tempfile::tempdir().unwrap();
        let server = crate::scripted::Scripted::start();
        let core = Core::open(
            dir.path().join("core.sqlite"),
            Some(Server {
                url: server.url(),
                key: "k".into(),
            }),
        )
        .unwrap();
        {
            let conn = core.conn().unwrap();
            store::meta_set(&conn, store::META_EVENT_CURSOR, "10").unwrap();
            store::meta_set(&conn, reach::FENCE, crate::scripted::FENCE).unwrap();
            store::meta_set(&conn, store::META_INSTANCE_ID, crate::scripted::INSTANCE).unwrap();
            store::meta_set(
                &conn,
                store::META_SLICE_TYPES,
                "[\"core.note\",\"acme.photo\"]",
            )
            .unwrap();
            store::meta_set(&conn, store::META_SLICE_TIER, "library").unwrap();
            let mut photo = store::testing::wire_type("acme.photo", None, Some("title"));
            photo.rest.insert(
                "fields".into(),
                serde_json::json!({ "thumbnail": { "type": "thumbnail" } }),
            );
            store::replace_types(
                &conn,
                &[
                    store::testing::wire_type("core.note", None, Some("title")),
                    photo,
                    store::testing::wire_type("acme.photo.raw", Some("acme.photo"), None),
                ],
            )
            .unwrap();
        }
        // A PNG's signature, then base64 that spells a word a search could
        // find: `/` splits it into a token of its own.
        let data = "iVBORw0KGgoA/unicornsXYZ";
        let thumbnail = format!("data:image/png;base64,{data}");
        let create = |r#type: &str, properties: Value| {
            core.create_item(&Draft {
                r#type: r#type.into(),
                properties: properties.as_object().unwrap().clone(),
                ..Default::default()
            })
            .unwrap()
            .item_id
            .unwrap()
        };
        let photo = create(
            "acme.photo",
            serde_json::json!({ "title": "Holiday", "thumbnail": thumbnail }),
        );
        let raw = create(
            "acme.photo.raw",
            serde_json::json!({ "title": "Raw", "thumbnail": thumbnail }),
        );
        let note = create(
            "core.note",
            serde_json::json!({ "title": "Plain", "body": "b" }),
        );

        let held = core
            .thumbnail(&photo)
            .unwrap()
            .expect("the photo's thumbnail");
        assert_eq!(held.mime_type, "image/png");
        assert_eq!(
            held.bytes,
            base64::engine::general_purpose::STANDARD
                .decode(data)
                .unwrap()
        );
        assert_eq!(
            core.thumbnail(&raw).unwrap().map(|found| found.bytes),
            Some(held.bytes.clone()),
            "a subtype's item lost the thumbnail its parent declares"
        );
        assert_eq!(core.thumbnail(&note).unwrap(), None);
        assert!(
            matches!(core.thumbnail("not-held"), Err(CoreError::NotFound { code, .. }) if code == "not_held"),
            "an item the copy does not hold read as one that carries no thumbnail"
        );
        let bare = create("acme.photo", serde_json::json!({ "title": "Bare" }));
        assert_eq!(core.thumbnail(&bare).unwrap(), None);
        let broken = server_held_item(
            &core,
            "acme.photo",
            serde_json::json!({ "title": "Broken", "thumbnail": "data:image/png;base64,***" }),
        );
        assert!(matches!(
            core.thumbnail(&broken),
            Err(CoreError::Decoding(_))
        ));
        assert_eq!(
            server.asked(),
            0,
            "a thumbnail was asked of the server rather than read from the row the copy holds"
        );

        let found = |query: &str| {
            core.search(query, &SearchFilters::default(), 10)
                .unwrap()
                .rows
                .into_iter()
                .map(|hit| hit.item.id)
                .collect::<Vec<_>>()
        };
        let witness = create(
            "core.note",
            serde_json::json!({ "title": "Beside", "body": "unicornsXYZ" }),
        );
        assert_eq!(found("unicornsXYZ"), vec![witness]);
        assert_eq!(found("Holiday"), vec![photo]);

        assert_eq!(
            server.asked(),
            0,
            "a read or a search asked the server rather than the copy"
        );
        let _ = core.drain();
        assert!(
            server.asked() > 0,
            "the drain reached no server, so the silence above is the transport's"
        );
    }

    #[test]
    fn a_field_leaves_the_index_when_the_catalog_stops_declaring_it_a_string() {
        let dir = tempfile::tempdir().unwrap();
        let core = Core::open(dir.path().join("core.sqlite"), None).unwrap();
        let photo = |cover: &str| {
            let mut wire = store::testing::wire_type("acme.photo", None, Some("title"));
            wire.rest.insert(
                "fields".into(),
                serde_json::json!({ "cover": { "type": cover } }),
            );
            wire
        };
        {
            let conn = core.conn().unwrap();
            store::meta_set(&conn, store::META_EVENT_CURSOR, "10").unwrap();
            store::meta_set(&conn, reach::FENCE, crate::scripted::FENCE).unwrap();
            store::meta_set(&conn, store::META_INSTANCE_ID, crate::scripted::INSTANCE).unwrap();
            store::meta_set(&conn, store::META_SLICE_TYPES, "[\"acme.photo\"]").unwrap();
            store::meta_set(&conn, store::META_SLICE_TIER, "library").unwrap();
            store::replace_types(&conn, &[photo("string")]).unwrap();
        }
        let id = core
            .create_item(&Draft {
                r#type: "acme.photo".into(),
                properties: serde_json::json!({
                    "title": "Holiday",
                    "cover": "unicornsXYZ",
                    "undeclared": "narwhalsABC",
                })
                .as_object()
                .unwrap()
                .clone(),
                ..Default::default()
            })
            .unwrap()
            .item_id
            .unwrap();
        let found = |query: &str| {
            core.search(query, &SearchFilters::default(), 10)
                .unwrap()
                .rows
                .into_iter()
                .map(|hit| hit.item.id)
                .collect::<Vec<_>>()
        };
        assert_eq!(found("unicornsXYZ"), vec![id.clone()]);
        assert!(
            found("narwhalsABC").is_empty(),
            "a property the type does not declare was indexed"
        );
        let adopt = |wire| {
            let conn = core.conn().unwrap();
            store::replace_types(&conn, &[wire]).unwrap();
        };
        adopt(photo("thumbnail"));
        assert!(
            found("unicornsXYZ").is_empty(),
            "the catalog made the field a thumbnail and the row's index entry still holds its text"
        );
        assert_eq!(found("Holiday"), vec![id.clone()]);
        adopt(photo("string"));
        assert_eq!(found("unicornsXYZ"), vec![id.clone()]);
    }

    #[test]
    fn an_unreadable_thumbnail_is_refused_naming_its_item() {
        let dir = tempfile::tempdir().unwrap();
        let core = Core::open(dir.path().join("core.sqlite"), None).unwrap();
        let mut photo = store::testing::wire_type("acme.photo", None, Some("title"));
        photo.rest.insert(
            "fields".into(),
            serde_json::json!({ "thumbnail": { "type": "thumbnail" } }),
        );
        {
            let conn = core.conn().unwrap();
            store::meta_set(&conn, store::META_EVENT_CURSOR, "10").unwrap();
            store::meta_set(&conn, reach::FENCE, crate::scripted::FENCE).unwrap();
            store::meta_set(&conn, store::META_INSTANCE_ID, crate::scripted::INSTANCE).unwrap();
            store::meta_set(&conn, store::META_SLICE_TYPES, "[\"acme.photo\"]").unwrap();
            store::meta_set(&conn, store::META_SLICE_TIER, "library").unwrap();
            store::replace_types(&conn, &[photo]).unwrap();
        }
        let id = server_held_item(
            &core,
            "acme.photo",
            serde_json::json!({"title": "Old", "thumbnail": "hello"}),
        );
        match core.thumbnail(&id) {
            Err(CoreError::Decoding(reason)) => assert!(reason.starts_with(&id), "{reason}"),
            other => panic!("an unreadable thumbnail read as {other:?}"),
        }
    }

    #[test]
    fn a_thumbnail_that_is_not_text_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let core = Core::open(dir.path().join("core.sqlite"), None).unwrap();
        let mut photo = store::testing::wire_type("acme.photo", None, Some("title"));
        photo.rest.insert(
            "fields".into(),
            serde_json::json!({ "thumbnail": { "type": "thumbnail" } }),
        );
        {
            let conn = core.conn().unwrap();
            store::meta_set(&conn, store::META_EVENT_CURSOR, "10").unwrap();
            store::meta_set(&conn, reach::FENCE, crate::scripted::FENCE).unwrap();
            store::meta_set(&conn, store::META_INSTANCE_ID, crate::scripted::INSTANCE).unwrap();
            store::meta_set(&conn, store::META_SLICE_TYPES, "[\"acme.photo\"]").unwrap();
            store::meta_set(&conn, store::META_SLICE_TIER, "library").unwrap();
            store::replace_types(&conn, &[photo]).unwrap();
        }
        let holding = |value: Value| {
            server_held_item(
                &core,
                "acme.photo",
                serde_json::json!({"title": "Held", "thumbnail": value}),
            )
        };
        assert_eq!(core.thumbnail(&holding(Value::Null)).unwrap(), None);
        for value in [
            serde_json::json!(42),
            serde_json::json!(true),
            serde_json::json!(["data:image/png;base64,iVBORw0KGgo="]),
            serde_json::json!({ "data": "iVBORw0KGgo=" }),
        ] {
            let id = holding(value.clone());
            match core.thumbnail(&id) {
                Err(CoreError::Decoding(reason)) => assert!(reason.starts_with(&id), "{reason}"),
                other => panic!("a thumbnail held as {value} read as {other:?}"),
            }
        }
    }

    /// A new door reaching the guard only through a helper is the one case
    /// this does not see.
    #[test]
    fn a_reading_handle_is_refused_at_every_write_door() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("core.sqlite");

        let writer = Core::open(&path, None).unwrap();
        {
            // Hydrated by hand: an unhydrated store refuses every write anyway,
            // and a case that leaned on that would pass with no lock at all.
            let conn = writer.conn().unwrap();
            store::meta_set(&conn, store::META_EVENT_CURSOR, "10").unwrap();
            store::meta_set(&conn, reach::FENCE, crate::scripted::FENCE).unwrap();
            store::meta_set(&conn, store::META_INSTANCE_ID, crate::scripted::INSTANCE).unwrap();
            store::meta_set(&conn, store::META_SLICE_TYPES, "[\"core.note\"]").unwrap();
            store::meta_set(&conn, store::META_SLICE_TIER, "library").unwrap();
            store::replace_types(
                &conn,
                &[store::testing::wire_type("core.note", None, Some("title"))],
            )
            .unwrap();
        }

        {
            let conn = writer.conn().unwrap();
            for (id, verdict, reason) in [
                ("answered", "accepted", None),
                ("blocked", "blocked", Some("key_spent")),
                ("dead", "dead", None),
            ] {
                conn.execute(
                    "INSERT INTO queue (id, kind, idempotency_key, payload, verdict, reason, sent, queued_at)
                     VALUES (?1, 'update_item', ?1, '{}', ?2, ?3, 1, '2026-01-01T00:00:00Z')",
                    rusqlite::params![id, verdict, reason],
                )
                .unwrap();
            }
        }
        let held = || {
            let conn = writer.conn().unwrap();
            let queue: Vec<String> = conn
                .prepare("SELECT id, verdict, reason, idempotency_key FROM queue ORDER BY seq")
                .unwrap()
                .query_map([], |row| {
                    Ok(format!(
                        "{}:{:?}:{:?}:{}",
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, String>(3)?
                    ))
                })
                .unwrap()
                .collect::<std::result::Result<_, _>>()
                .unwrap();
            let items: i64 = conn
                .query_row("SELECT count(*) FROM items", [], |row| row.get(0))
                .unwrap();
            (queue, items)
        };
        let before = held();

        let reader = Core::open(&path, None).unwrap();
        assert_eq!(reader.handle(), Handle::Reader);
        assert_eq!(writer.handle(), Handle::Writer);

        let draft = Draft {
            r#type: "core.note".into(),
            ..Default::default()
        };
        let edit = Edit {
            base_version: Some(1),
            ..Default::default()
        };
        let folder_changes = serde_json::json!({ "title": "Renamed" })
            .as_object()
            .unwrap()
            .clone();
        let refusals: Vec<(&str, CoreError)> = vec![
            ("create_item", reader.create_item(&draft).unwrap_err()),
            ("update_item", reader.update_item("x", &edit).unwrap_err()),
            (
                "update_item_as_read",
                reader.update_item_as_read("x", &edit).unwrap_err(),
            ),
            ("delete_item", reader.delete_item("x").unwrap_err()),
            (
                "delete_item_at",
                reader
                    .delete_item_at(
                        "x",
                        &Seen {
                            item: Item::from_wire(
                                crate::store::testing::wire_item(
                                    "x",
                                    "core.note",
                                    "active",
                                    "2026-01-01T00:00:00Z",
                                    serde_json::json!({}),
                                ),
                                Vec::new(),
                            )
                            .unwrap(),
                            edges: Vec::new(),
                        },
                    )
                    .unwrap_err(),
            ),
            ("restore_item", reader.restore_item("x").unwrap_err()),
            ("purge_item", reader.purge_item("x", None).unwrap_err()),
            (
                "transition_item",
                reader
                    .transition_item("x", ItemState::Archived)
                    .unwrap_err(),
            ),
            (
                "create_edge",
                reader.create_edge(&EdgeDraft::default()).unwrap_err(),
            ),
            (
                "update_edge",
                reader.update_edge("x", &EdgeEdit::default()).unwrap_err(),
            ),
            ("delete_edge", reader.delete_edge("x").unwrap_err()),
            ("add_tag", reader.add_tag("x", "t").unwrap_err()),
            ("remove_tag", reader.remove_tag("x", "t").unwrap_err()),
            (
                "replace_metadata",
                reader
                    .replace_metadata("x", &MetadataWrite::default())
                    .unwrap_err(),
            ),
            (
                "write_extension",
                reader.write_extension("x", "ns", "{}").unwrap_err(),
            ),
            (
                "delete_extension",
                reader.delete_extension("x", "ns").unwrap_err(),
            ),
            ("release", reader.release("blocked").unwrap_err()),
            (
                "release_reason",
                reader.release_reason(BlockedReason::KeySpent).unwrap_err(),
            ),
            (
                "rebase_on_held",
                reader.rebase_on_held("blocked").unwrap_err(),
            ),
            ("withdraw", reader.withdraw("blocked").unwrap_err()),
            // Refused at the handle before the missing server, so not `NoServer`.
            ("drain", reader.drain().unwrap_err()),
            ("forget_answered", reader.forget_answered().unwrap_err()),
            (
                "forget_answered_ids",
                reader.forget_answered_ids(&[]).unwrap_err(),
            ),
            ("discard", reader.discard("refused").unwrap_err()),
            (
                "put_blob",
                reader
                    .put_blob(Path::new("no-such-file.png"), None)
                    .unwrap_err(),
            ),
            (
                "set_file_budget",
                reader.set_file_budget(FileBudget::KeepAll).unwrap_err(),
            ),
            ("trim_files", reader.trim_files().unwrap_err()),
            (
                "fetch_kept_until",
                reader
                    .fetch_kept_until(&std::sync::atomic::AtomicBool::new(false))
                    .unwrap_err(),
            ),
            (
                "attach",
                reader
                    .attach("x", Path::new("no-such-file.png"), &Attachment::default())
                    .unwrap_err(),
            ),
            (
                "add_file",
                reader
                    .add_file(Path::new("no-such-file.png"), &Attachment::default(), &[])
                    .unwrap_err(),
            ),
            (
                "create_file_item",
                reader
                    .create_file_item(Path::new("no-such-file.png"), &draft)
                    .unwrap_err(),
            ),
            (
                "update_file_item",
                reader
                    .update_file_item("x", Path::new("no-such-file.png"), &edit, Based::OnHeld)
                    .unwrap_err(),
            ),
            (
                "hydrate",
                reader
                    .hydrate(&["core.note".into()], SliceTier::Library)
                    .unwrap_err(),
            ),
            (
                "hydrate_with",
                reader
                    .hydrate_with(
                        &["core.note".into()],
                        SliceTier::Library,
                        &["parent-of".into()],
                    )
                    .unwrap_err(),
            ),
            ("catch_up", reader.catch_up().unwrap_err()),
            (
                "catch_up_until",
                reader
                    .catch_up_until(&std::sync::atomic::AtomicBool::new(false))
                    .unwrap_err()
                    .error,
            ),
            (
                "hydrate_until",
                reader
                    .hydrate_until(
                        &["core.note".into()],
                        SliceTier::Library,
                        &[],
                        &std::sync::atomic::AtomicBool::new(false),
                    )
                    .unwrap_err(),
            ),
            (
                "drain_until",
                reader
                    .drain_until(&std::sync::atomic::AtomicBool::new(false))
                    .unwrap_err(),
            ),
            (
                "follow_observed",
                reader
                    .follow_observed(
                        &std::sync::atomic::AtomicBool::new(true),
                        false,
                        |_| {},
                        |_| {},
                    )
                    .unwrap_err(),
            ),
            (
                "create_folder",
                reader
                    .create_folder(&serde_json::Map::new(), None)
                    .unwrap_err(),
            ),
            (
                "change_folder",
                reader
                    .change_folder("x", &folder_changes, 1, None)
                    .unwrap_err(),
            ),
            (
                "revoke_folder",
                reader.revoke_folder("x", None).unwrap_err(),
            ),
            ("declare_types", reader.declare_types(&[]).unwrap_err()),
            (
                "create_view",
                reader
                    .create_view(&serde_json::Map::new(), None)
                    .unwrap_err(),
            ),
            (
                "change_view",
                reader
                    .change_view("x", &folder_changes, 1, None)
                    .unwrap_err(),
            ),
            ("delete_view", reader.delete_view("x", None).unwrap_err()),
            ("pin", reader.pin("x").unwrap_err()),
            ("unpin", reader.unpin("x").unwrap_err()),
            (
                "follow",
                reader
                    .follow(&std::sync::atomic::AtomicBool::new(true), false, |_| {})
                    .unwrap_err(),
            ),
        ];
        for (door, refusal) in &refusals {
            assert_eq!(
                refusal,
                &CoreError::ReadingHandle,
                "the {door} door let a second opener through, so two processes \
                 queue into one file and neither sees the other's rows"
            );
        }
        assert_eq!(
            held(),
            before,
            "a door refused a reading handle only after it had written"
        );
        assert_eq!(
            refusals.len(),
            49,
            "an entry has gone from the list above, and a door dropped from \
             it is a door nothing here covers"
        );

        let listed: Vec<&str> = refusals.iter().map(|(door, _)| *door).collect();
        let mut guarded = Vec::new();
        let others: &[&str] = &[];
        for (source, helpers) in [
            (include_str!("blob.rs"), others),
            (include_str!("catalog.rs"), others),
            (include_str!("catch_up.rs"), others),
            (include_str!("contract.rs"), others),
            (include_str!("error.rs"), others),
            (include_str!("lock.rs"), others),
            (include_str!("http.rs"), others),
            (include_str!("hydrate.rs"), others),
            (include_str!("model.rs"), others),
            (include_str!("query.rs"), others),
            (include_str!("search.rs"), others),
            (include_str!("sse.rs"), others),
            (include_str!("store.rs"), others),
            (include_str!("wire.rs"), others),
            (include_str!("view_writes.rs"), &["send_to_view_door"][..]),
            (
                include_str!("folder_settings.rs"),
                &["send_to_folder_door"][..],
            ),
            (include_str!("folder/mod.rs"), &["working"][..]),
            (include_str!("folder/document.rs"), others),
            (include_str!("folder/identity.rs"), others),
            (include_str!("folder/pull.rs"), others),
            (include_str!("folder/push.rs"), others),
            (include_str!("folder/scan.rs"), others),
            (include_str!("folder/settings.rs"), others),
            (include_str!("folder/state.rs"), others),
            (
                include_str!("lib.rs"),
                &[
                    "keep_relocated_origin",
                    "transition_locally",
                    "tag_write",
                    "extension_write",
                    "with_upload",
                    "with_upload_reader",
                    "write_create",
                    "write_update",
                    "catch_up_pass",
                    "follow_from",
                    // Makes a core rather than taking one, so no reading
                    // handle can reach it; `replace_tests` claims the role
                    // first and is refused.
                    "replace_refused",
                    // Takes no core either; `remove_tests` holds the role
                    // from another core and is refused.
                    "remove_store",
                ][..],
            ),
            (include_str!("drain.rs"), &["drain_checked"][..]),
        ] {
            let mut current: Option<&str> = None;
            let mut in_tests = false;
            for line in source.lines() {
                // A test module, top level and closed at column 0, is
                // passed over; anything after it is read again.
                if line.starts_with("mod tests") {
                    in_tests = true;
                }
                if in_tests {
                    in_tests = line != "}";
                    continue;
                }
                let declared = line.trim_start();
                let declared = declared
                    .strip_prefix("pub(crate) ")
                    .or_else(|| declared.strip_prefix("pub(super) "))
                    .or_else(|| declared.strip_prefix("pub "))
                    .unwrap_or(declared);
                if let Some(name) = declared.strip_prefix("fn ") {
                    let end = name
                        .find(|glyph: char| !(glyph.is_alphanumeric() || glyph == '_'))
                        .unwrap_or(name.len());
                    current = Some(&name[..end]);
                }
                if line.contains("refuse_unless_writer()")
                    && let Some(name) = current
                {
                    guarded.push((name, helpers));
                }
            }
        }
        assert!(
            guarded.iter().any(|(name, _)| *name == "create_item"),
            "the scan did not find `create_item`, so it is reading the wrong \
             source and the check below passes on nothing"
        );
        for (name, helpers) in guarded {
            assert!(
                listed.contains(&name) || helpers.contains(&name),
                "{name} calls `refuse_unless_writer` and is not in the list \
                 above, so a reading handle reaching it is never tried"
            );
        }

        let queued = writer.create_item(&draft).unwrap();
        assert_eq!(queued.kind, WriteKind::CreateItem);

        assert!(
            reader
                .list(&ListFilters::default(), Sort::default())
                .is_ok()
        );
    }

    #[test]
    fn a_release_by_reason_releases_that_reason_and_no_other() {
        let core = Core::open_in_memory(None).unwrap();
        {
            let conn = core.conn().unwrap();
            for reason in [BlockedReason::KeySpent, BlockedReason::ConflictUnresolved] {
                conn.execute(
                    "INSERT INTO queue (id, kind, idempotency_key, payload, verdict, reason, sent, queued_at)
                     VALUES (?1, 'update_item', ?1, '{}', 'blocked', ?1, 1, '2026-01-01T00:00:00Z')",
                    [reason.as_str()],
                )
                .unwrap();
            }
            // A dead row carrying the reason's own text, so a release that
            // read the reason column without the verdict would take it too.
            conn.execute(
                "INSERT INTO queue (id, kind, idempotency_key, payload, verdict, reason, sent, queued_at)
                 VALUES ('dead', 'update_item', 'dead', '{}', 'dead', 'key_spent', 1, '2026-01-01T00:00:00Z')",
                [],
            )
            .unwrap();
        }
        assert_eq!(core.release_reason(BlockedReason::KeySpent).unwrap(), 1);
        let rows = core.queue().unwrap();
        let still = |id: &str| rows.iter().find(|row| row.id == id).unwrap().verdict;
        assert_eq!(still("key_spent"), None);
        assert_eq!(
            still("conflict_unresolved"),
            Some(Verdict::Blocked),
            "a release by one reason released a row blocked for another"
        );
        assert_eq!(
            still("dead"),
            Some(Verdict::Dead),
            "a release by reason released a dead write, which is released one id at a time"
        );
        assert!(core.release("dead").unwrap());
        assert_eq!(
            core.queue()
                .unwrap()
                .iter()
                .find(|row| row.id == "dead")
                .unwrap()
                .verdict,
            None
        );
    }

    #[test]
    fn the_writer_sweeps_old_half_written_copies_when_it_opens() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("core.sqlite");
        let blobs = dir.path().join("core.sqlite.blobs");
        std::fs::create_dir_all(&blobs).unwrap();
        let old = blobs.join(".incoming-old");
        let young = blobs.join(".incoming-young");
        std::fs::write(&old, b"half").unwrap();
        std::fs::write(&young, b"half").unwrap();
        std::fs::File::options()
            .write(true)
            .open(&old)
            .unwrap()
            .set_modified(std::time::SystemTime::now() - 2 * INCOMING_GRACE)
            .unwrap();
        let _writer = Core::open(&path, None).unwrap();
        assert!(
            !old.exists(),
            "a half-written copy older than the grace survived the writer's open"
        );
        assert!(
            young.exists(),
            "a copy something may still be writing was taken"
        );
    }

    #[test]
    fn with_no_server_held_bytes_are_answered_and_the_rest_are_absent() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("core.sqlite");
        let core = Core::open(&path, None).unwrap();
        let file = dir.path().join("note.txt");
        std::fs::write(&file, b"held here").unwrap();
        let hash = core
            .cache()
            .unwrap()
            .take_reader(&file, std::fs::File::open(&file).unwrap())
            .unwrap()
            .hash;
        let held = core.blob(&hash).unwrap();
        assert_eq!(std::fs::read(held.path()).unwrap(), b"held here");
        let other = blob::name_of(b"never held");
        assert!(matches!(
            core.blob(&other),
            Err(CoreError::BytesAbsent { hash, .. }) if hash == other
        ));
    }

    /// Two readers on one shared handle under a budget of zero: the second
    /// reader's trim must not take the bytes the first has fetched and not
    /// yet answered.
    #[test]
    fn a_trim_on_another_thread_keeps_the_bytes_a_caller_is_reading() {
        let server = crate::scripted::Scripted::start();
        let dir = tempfile::tempdir().unwrap();
        let core = crate::stop_tests::copy_in_keyed(&server, dir.path(), "k");
        core.set_file_budget(FileBudget::Bytes(0)).unwrap();
        let serve = |bytes: &[u8]| {
            let hash = blob::name_of(bytes);
            let link = blob::tests::linking(bytes.to_vec(), false);
            server.on(
                &format!("/blobs/{hash}/url"),
                vec![crate::scripted::json(
                    200,
                    &format!(r#"{{"url":"{link}"}}"#),
                )],
            );
            hash
        };
        let first = serve(b"read on the first thread");
        let second = serve(b"read on the second thread");
        let point = format!("blob-answered:{first}");
        crate::fault::arm(&point);
        std::thread::scope(|scope| {
            let reading = scope.spawn(|| core.blob(&first));
            let waited = std::time::Instant::now();
            while crate::fault::waiting(&point) == 0 {
                assert!(
                    waited.elapsed() < std::time::Duration::from_secs(10),
                    "the first reader never reached its answer"
                );
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
            let other = core.blob(&second);
            crate::fault::release(&point);
            assert_eq!(
                std::fs::read(other.unwrap().path()).unwrap(),
                b"read on the second thread"
            );
            let path = reading.join().unwrap().unwrap();
            assert_eq!(
                std::fs::read(path.path()).ok().as_deref(),
                Some(&b"read on the first thread"[..]),
                "another thread's trim took the bytes a caller was about to read"
            );
        });
        // The witness: once both are answered, the next trim takes them.
        assert_eq!(core.trim_files().unwrap(), 24 + 25);
        assert!(!core.blob_held(&first).unwrap());
        assert!(!core.blob_held(&second).unwrap());
    }

    #[test]
    fn a_trim_through_the_writer_keeps_the_bytes_a_reading_handle_is_reading() {
        let server = crate::scripted::Scripted::start();
        let dir = tempfile::tempdir().unwrap();
        let core = crate::stop_tests::copy_in_keyed(&server, dir.path(), "k");
        core.set_file_budget(FileBudget::KeepAll).unwrap();
        let bytes = b"read through the reading handle";
        let hash = blob::name_of(bytes);
        let link = blob::tests::linking(bytes.to_vec(), false);
        server.on(
            &format!("/blobs/{hash}/url"),
            vec![crate::scripted::json(
                200,
                &format!(r#"{{"url":"{link}"}}"#),
            )],
        );
        core.blob(&hash).unwrap();
        let reader = Core::open_reader(dir.path().join("core.sqlite")).unwrap();
        let point = format!("blob-answered:{hash}");
        crate::fault::arm(&point);
        std::thread::scope(|scope| {
            let reading = scope.spawn(|| reader.blob(&hash));
            let waited = std::time::Instant::now();
            while crate::fault::waiting(&point) == 0 {
                assert!(
                    waited.elapsed() < std::time::Duration::from_secs(10),
                    "the reading handle never reached its answer"
                );
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
            let taken = core.set_file_budget(FileBudget::Bytes(0));
            crate::fault::release(&point);
            assert_eq!(taken.unwrap(), 0);
            let path = reading.join().unwrap().unwrap();
            assert_eq!(
                std::fs::read(path.path()).ok().as_deref(),
                Some(&bytes[..]),
                "the writer's trim took the bytes a reading handle was about to read"
            );
        });
        // The witness: once the reading handle is answered, a trim takes them.
        assert_eq!(core.trim_files().unwrap(), bytes.len() as u64);
        assert!(!core.blob_held(&hash).unwrap());
    }

    /// Bytes an upload names are the only copy until the server has them,
    /// whether the upload is queued after they were fetched or while a fetch
    /// of them is arriving.
    #[cfg(target_os = "macos")]
    #[test]
    fn bytes_an_upload_names_stay_in_backups_whichever_comes_first() {
        use crate::file_cache::tests::excluded;
        // The system excludes its own temporary folders, so the witness has to
        // sit under the home folder.
        let home = std::env::var_os("HOME").expect("HOME");
        let area = tempfile::Builder::new()
            .prefix(".marfa-backup-test-")
            .tempdir_in(home)
            .unwrap();
        let server = crate::scripted::Scripted::start();
        let core = crate::stop_tests::copy_in_keyed(&server, area.path(), "k");
        core.set_file_budget(FileBudget::KeepAll).unwrap();
        let serve = |bytes: &[u8]| {
            let hash = blob::name_of(bytes);
            let link = blob::tests::linking(bytes.to_vec(), false);
            server.on(
                &format!("/blobs/{hash}/url"),
                vec![crate::scripted::json(
                    200,
                    &format!(r#"{{"url":"{link}"}}"#),
                )],
            );
            hash
        };
        let upload = |name: &str, bytes: &[u8]| {
            let path = area.path().join(name);
            std::fs::write(&path, bytes).unwrap();
            core.put_blob(&path, Some("text/plain")).unwrap();
        };

        let fetched_first = b"fetched, then queued as an upload";
        let hash = serve(fetched_first);
        let path = core.blob(&hash).unwrap().path().to_path_buf();
        assert!(
            excluded(&path),
            "fetched bytes were not left out of backups"
        );
        upload("fetched-first.txt", fetched_first);
        assert!(
            !excluded(&path),
            "bytes fetched and then queued as an upload stayed out of backups"
        );

        let queued_first = b"queued while a fetch of it arrived";
        let hash = serve(queued_first);
        let point = format!("blob-arrived:{hash}");
        crate::fault::arm(&point);
        std::thread::scope(|scope| {
            let fetching = scope.spawn(|| core.blob(&hash).map(|held| held.path().to_path_buf()));
            let waited = std::time::Instant::now();
            while crate::fault::waiting(&point) == 0 {
                assert!(
                    waited.elapsed() < std::time::Duration::from_secs(10),
                    "the fetch never arrived"
                );
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
            upload("queued-first.txt", queued_first);
            crate::fault::release(&point);
            let path = fetching.join().unwrap().unwrap();
            assert!(
                !excluded(&path),
                "a fetch that settled after an upload of its bytes was queued left them out of backups"
            );
        });
        assert_eq!(core.file_cache().unwrap().backup_mark_failure, None);
    }

    #[test]
    fn two_budgets_set_at_once_each_trim_to_the_one_they_stored() {
        let dir = tempfile::tempdir().unwrap();
        let core = Core::open(dir.path().join("core.sqlite"), None).unwrap();
        let path = dir.path().join("kept.txt");
        std::fs::write(&path, b"fetched once").unwrap();
        let hash = core
            .cache()
            .unwrap()
            .take_reader(&path, std::fs::File::open(&path).unwrap())
            .unwrap()
            .hash;
        core.set_file_budget(FileBudget::KeepAll).unwrap();
        let point = &format!("budget-stored:{:p}", &core);
        crate::fault::arm(point);
        std::thread::scope(|scope| {
            let zero = scope.spawn(|| core.set_file_budget(FileBudget::Bytes(0)));
            let waited = std::time::Instant::now();
            while crate::fault::waiting(point) == 0 {
                assert!(
                    waited.elapsed() < std::time::Duration::from_secs(10),
                    "the first call never stored its budget"
                );
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
            let keep_all = scope.spawn(|| core.set_file_budget(FileBudget::KeepAll));
            // Long enough for a second call that is not held back to store
            // its budget over the first one's.
            std::thread::sleep(std::time::Duration::from_millis(200));
            crate::fault::release(point);
            assert_eq!(
                zero.join().unwrap().unwrap(),
                12,
                "a budget of zero was stored and then never enforced"
            );
            assert_eq!(keep_all.join().unwrap().unwrap(), 0);
        });
        assert!(!core.blob_held(&hash).unwrap());
        assert_eq!(core.file_budget().unwrap(), FileBudget::KeepAll);
    }

    #[cfg(unix)]
    #[test]
    fn the_state_report_says_held_bytes_are_unknown_where_the_cache_cannot_be_read() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let core = Core::open(dir.path().join("core.sqlite"), None).unwrap();
        let absent = core.file_cache().unwrap();
        assert_eq!((absent.held, absent.held_unreadable), (Some(0), None));
        let path = dir.path().join("kept.txt");
        std::fs::write(&path, b"fetched once").unwrap();
        let hash = core
            .cache()
            .unwrap()
            .take_reader(&path, std::fs::File::open(&path).unwrap())
            .unwrap()
            .hash;
        assert_eq!(core.file_cache().unwrap().held, Some(12));
        let folder = dir.path().join("core.sqlite.blobs");
        std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o000)).unwrap();
        let sealed = std::fs::read_dir(&folder).is_err();
        let report = core.file_cache();
        let taken = core.set_file_budget(FileBudget::Bytes(0));
        std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(sealed, "the folder could still be read");
        let report = report.unwrap();
        assert_eq!(
            report.held, None,
            "an incomplete count was reported as exact"
        );
        assert!(report.held_unreadable.is_some());
        assert_eq!(taken.unwrap(), 0);
        assert!(
            core.blob_held(&hash).unwrap(),
            "a trim took bytes it could not count"
        );
    }

    #[test]
    fn a_trim_keeps_the_bytes_an_upload_still_names() {
        let dir = tempfile::tempdir().unwrap();
        let core = Core::open(dir.path().join("core.sqlite"), None).unwrap();
        let file = |name: &str, bytes: &[u8]| {
            let path = dir.path().join(name);
            std::fs::write(&path, bytes).unwrap();
            core.cache()
                .unwrap()
                .take_reader(&path, std::fs::File::open(&path).unwrap())
                .unwrap()
                .hash
        };
        let waiting = file("waiting.txt", b"to be sent");
        let read = file("read.txt", b"fetched once");
        let upload = queue_upload(&core.conn().unwrap(), &waiting, "text/plain").unwrap();

        core.set_file_budget(FileBudget::Bytes(0)).unwrap();
        assert!(
            core.blob_held(&waiting).unwrap(),
            "the cap took bytes an upload still names, so it can never be sent"
        );
        assert!(!core.blob_held(&read).unwrap(), "nothing was trimmed");

        store::record_verdict(
            &core.conn().unwrap(),
            &upload.id,
            &store::Answered {
                verdict: Verdict::Accepted,
                reason: None,
                answer: None,
                conflicted_copy_id: None,
            },
        )
        .unwrap();
        core.set_file_budget(FileBudget::Bytes(0)).unwrap();
        assert!(
            !core.blob_held(&waiting).unwrap(),
            "bytes the server has taken were kept past the cap"
        );
    }

    #[test]
    fn an_unchanged_type_catalog_is_not_written_again() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("core.sqlite");
        let writer = Core::open(&path, None).unwrap();
        let reader = Core::open_reader(&path).unwrap();
        let catalog = [store::testing::wire_type("core.note", None, Some("title"))];
        let replace = |types: &[crate::wire::WireType]| {
            let mut conn = writer.conn().unwrap();
            let tx = conn.transaction().unwrap();
            store::replace_types(&tx, types).unwrap();
            tx.commit().unwrap();
        };
        replace(&catalog);
        let before = reader.data_version().unwrap();
        replace(&catalog);
        assert_eq!(
            reader.data_version().unwrap(),
            before,
            "the same catalog was written again, and a reader was told of a save that changed nothing"
        );
        // The same catalog in another order is the same catalog.
        let two = [
            store::testing::wire_type("core.note", None, Some("title")),
            store::testing::wire_type("user.recipe", None, Some("title")),
        ];
        replace(&two);
        let before = reader.data_version().unwrap();
        replace(&[two[1].clone(), two[0].clone()]);
        assert_eq!(
            reader.data_version().unwrap(),
            before,
            "the same catalog in another order was written again"
        );
        replace(&[store::testing::wire_type("core.note", None, Some("body"))]);
        assert_ne!(reader.data_version().unwrap(), before);
    }

    #[test]
    fn one_stream_at_a_time_moves_the_cursor() {
        let dir = tempfile::tempdir().unwrap();
        // Nothing answers here, so the follow asks again until it is stopped.
        let core = Core::open(
            dir.path().join("core.sqlite"),
            Some(Server {
                url: "http://127.0.0.1:9".into(),
                key: "k".into(),
            }),
        )
        .unwrap();
        {
            let conn = core.conn().unwrap();
            store::meta_set(&conn, store::META_EVENT_CURSOR, "10").unwrap();
            store::meta_set(&conn, reach::FENCE, crate::scripted::FENCE).unwrap();
            store::meta_set(&conn, store::META_INSTANCE_ID, crate::scripted::INSTANCE).unwrap();
            store::meta_set(&conn, store::META_SLICE_TYPES, "[\"core.note\"]").unwrap();
            store::meta_set(&conn, store::META_SLICE_TIER, "library").unwrap();
        }
        let stop = AtomicBool::new(false);
        std::thread::scope(|scope| {
            let following = scope.spawn(|| core.follow(&stop, false, |_| {}));
            std::thread::sleep(Duration::from_millis(300));
            let second = core.catch_up();
            let hydrating = core.hydrate(&["core.note".into()], SliceTier::Library);
            stop.store(true, Ordering::Relaxed);
            let report = following.join().unwrap().unwrap();
            assert!(
                matches!(&second, Err(CoreError::Invalid(message)) if message.contains("already")),
                "a catch-up ran beside a follow on one handle: {second:?}"
            );
            assert!(
                matches!(&hydrating, Err(CoreError::Invalid(message)) if message.contains("already")),
                "a hydration ran under a follow, which goes on applying events to the copy it replaces: {hydrating:?}"
            );
            assert!(report.failed_opens >= 1, "{report:?}");
        });
        assert!(!matches!(core.catch_up(), Err(CoreError::Invalid(_))));
    }

    #[test]
    fn no_stream_runs_across_a_hydration() {
        let server = crate::scripted::Scripted::start();
        // The hydration's first read, the log's head, is never answered.
        server.on("/events", vec![scripted::Answer::Stall]);
        let dir = tempfile::tempdir().unwrap();
        let core = Core::open(
            dir.path().join("core.sqlite"),
            Some(Server {
                url: server.url(),
                key: "k".into(),
            }),
        )
        .unwrap();
        {
            let conn = core.conn().unwrap();
            store::meta_set(&conn, store::META_EVENT_CURSOR, "10").unwrap();
            store::meta_set(&conn, reach::FENCE, crate::scripted::FENCE).unwrap();
            store::meta_set(&conn, store::META_INSTANCE_ID, crate::scripted::INSTANCE).unwrap();
            store::meta_set(&conn, store::META_SLICE_TYPES, "[\"core.note\"]").unwrap();
            store::meta_set(&conn, store::META_SLICE_TIER, "library").unwrap();
        }
        std::thread::scope(|scope| {
            let hydrating = scope.spawn(|| core.hydrate(&["core.note".into()], SliceTier::Library));
            server.wait_for("/events", 1, Duration::from_secs(5));
            let caught = core.catch_up();
            let followed = core.follow(&AtomicBool::new(false), false, |_| {});
            for (what, refused) in [("catch-up", caught.err()), ("follow", followed.err())] {
                assert!(
                    matches!(&refused, Some(CoreError::Invalid(message)) if message.contains("already")),
                    "a {what} ran across a hydration: {refused:?}"
                );
            }
            drop(server);
            assert!(hydrating.join().unwrap().is_err());
        });
        assert!(!matches!(core.catch_up(), Err(CoreError::Invalid(_))));
    }

    #[test]
    fn a_store_opened_to_read_never_claims_the_writer_and_is_told_of_saves() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("core.sqlite");
        assert!(
            Core::open_reader(&path).is_err(),
            "a reading open answered for a path where no store was made"
        );
        assert!(
            !path.exists(),
            "a reading open made a store it was only meant to read"
        );
        drop(Core::open(&path, None).unwrap());
        let reader = Core::open_reader(&path).unwrap();
        assert_eq!(reader.handle(), Handle::Reader);
        let writer = Core::open(&path, None).unwrap();
        assert_eq!(
            writer.handle(),
            Handle::Writer,
            "a reader opened first took the writer role, so the app is locked out of its own store"
        );

        let before = reader.data_version().unwrap();
        assert_eq!(
            reader.data_version().unwrap(),
            before,
            "the signal moved with no save, so a reader cannot tell a save from nothing"
        );
        {
            let conn = writer.conn().unwrap();
            store::meta_set(&conn, "saved", "yes").unwrap();
        }
        assert_ne!(
            reader.data_version().unwrap(),
            before,
            "the writer saved and the reader's signal did not move"
        );
    }

    #[test]
    fn a_reading_open_names_what_is_wrong_with_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let at = |name: &str| dir.path().join(name);
        let made = |name: &str, sql: &str| {
            let path = at(name);
            Connection::open(&path).unwrap().execute_batch(sql).unwrap();
            path
        };
        let refusal = |path: &Path| match Core::open_reader(path) {
            Err(error) => error,
            Ok(_) => panic!("{} opened to read", path.display()),
        };
        let not_a_store = |path: &Path| match refusal(path) {
            CoreError::Invalid(message) => message,
            other => panic!("{} was refused as {other:?}", path.display()),
        };

        let absent = at("absent.sqlite");
        assert!(not_a_store(&absent).contains("never makes one"));
        assert!(!absent.exists());
        let tableless = made("tableless.sqlite", "CREATE TABLE other (x);");
        assert!(not_a_store(&tableless).contains("has no schema to read"));
        let words = at("words.sqlite");
        std::fs::write(&words, "words, not a database. ".repeat(40)).unwrap();
        assert!(not_a_store(&words).contains("has no schema to read"));

        let odd = made("odd.sqlite", "CREATE TABLE meta (key TEXT);");
        assert!(
            matches!(refusal(&odd), CoreError::WrongSchema { reason, .. } if reason.contains("meta")),
            "a store of another shape was not refused by name"
        );

        let meta = "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);";
        let older = made(
            "older.sqlite",
            &format!("{meta} INSERT INTO meta VALUES ('schema_version', '1');"),
        );
        let unversioned = made("unversioned.sqlite", meta);
        for (path, found) in [(&older, "schema 1"), (&unversioned, "no schema version")] {
            match refusal(path) {
                CoreError::WrongSchema {
                    path: named,
                    reason,
                    unsent,
                    folder,
                } => {
                    assert!(folder.is_none(), "a device store was refused as a folder's");
                    assert_eq!(named, path.display().to_string());
                    assert!(reason.contains(found), "{reason}");
                    assert_eq!(unsent, None, "a store with no queue was counted");
                }
                other => panic!("{} was refused as {other:?}", path.display()),
            }
        }
        drop(Core::open(at("store.sqlite"), None).unwrap());
        assert!(Core::open_reader(at("store.sqlite")).is_ok());
    }

    #[test]
    fn a_reading_open_answers_held_bytes_and_says_why_it_fetches_no_others() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("core.sqlite");
        let writer = Core::open(&path, None).unwrap();
        let file = dir.path().join("note.txt");
        std::fs::write(&file, b"held here").unwrap();
        let hash = writer
            .cache()
            .unwrap()
            .take_reader(&file, std::fs::File::open(&file).unwrap())
            .unwrap()
            .hash;

        let reader = Core::open_reader(&path).unwrap();
        let held = reader.blob(&hash).unwrap();
        assert_eq!(std::fs::read(held.path()).unwrap(), b"held here");
        let other = blob::name_of(b"never held");
        let reason = |core: &Core| match core.blob(&other) {
            Err(CoreError::BytesAbsent { reason, .. }) => reason,
            answer => panic!("{answer:?}"),
        };
        assert!(reason(&reader).contains("reading handle"));
        assert!(!reason(&writer).contains("reading handle"));
    }

    #[test]
    fn claims_made_at_once_never_both_win() {
        use std::sync::atomic::AtomicUsize;
        let core = Core::open_in_memory(None).unwrap();
        let holding = AtomicUsize::new(0);
        let (won, overlapped) = (AtomicUsize::new(0), AtomicBool::new(false));
        for _ in 0..300 {
            let go = AtomicBool::new(false);
            std::thread::scope(|scope| {
                for _ in 0..8 {
                    scope.spawn(|| {
                        while !go.load(Ordering::Acquire) {
                            std::hint::spin_loop();
                        }
                        if let Ok(claim) = core.claim_stream(Mover::CatchUp) {
                            won.fetch_add(1, Ordering::SeqCst);
                            if holding.fetch_add(1, Ordering::SeqCst) > 0 {
                                overlapped.store(true, Ordering::SeqCst);
                            }
                            std::thread::yield_now();
                            holding.fetch_sub(1, Ordering::SeqCst);
                            drop(claim);
                        }
                    });
                }
                go.store(true, Ordering::Release);
            });
        }
        assert!(won.load(Ordering::SeqCst) >= 300);
        assert!(
            !overlapped.load(Ordering::SeqCst),
            "two claims were held at once, so two streams could move one cursor"
        );
    }

    #[test]
    fn an_origin_only_copy_opens_offline_but_refuses_to_send_to_another_origin() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("core.sqlite");
        {
            let core = Core::open(&path, unreachable_server("http://one.test:8600/")).unwrap();
            let conn = core.conn().unwrap();
            store::meta_set(&conn, store::META_SERVER_ORIGIN, "http://one.test:8600").unwrap();
        }
        assert!(Core::open(&path, unreachable_server("HTTP://ONE.test:8600")).is_ok());
        assert!(Core::open(&path, None).is_ok());
        assert_eq!(
            Core::open(&path, unreachable_server("http://two.test:8600"))
                .unwrap()
                .http()
                .unwrap()
                .types()
                .err(),
            Some(CoreError::WrongServer {
                expected: "http://one.test:8600".into(),
                got: "http://two.test:8600".into()
            })
        );
    }
}

#[cfg(test)]
mod forgetting_named_tests {
    use super::*;

    fn answered(conn: &Connection, id: &str) {
        conn.execute("INSERT INTO queue (id, kind, idempotency_key, payload, verdict, sent, depends_on, queued_at) VALUES (?1, 'add_tag', ?1, '{}', 'accepted', 1, '[]', '2026-01-01T00:00:00Z')", [id]).unwrap();
    }

    /// A body's edge create the server refused as a duplicate: the body rule
    /// reads that answer and discards the row.
    fn pending_body_duplicate() -> (Core, String) {
        let core = Core::open_in_memory(None).unwrap();
        let note = |title: &str, body: String| {
            core.create_item(&Draft {
                r#type: "core.note".into(),
                properties: serde_json::json!({"title": title, "body": body})
                    .as_object()
                    .unwrap()
                    .clone(),
                ..Default::default()
            })
            .unwrap()
        };
        let target = note("Target", "".into());
        note("Host", format!("[[{}]]", target.item_id.unwrap()));
        let edge = core
            .queue()
            .unwrap()
            .into_iter()
            .find(|row| row.kind == WriteKind::CreateEdge)
            .expect("body link queued its edge")
            .id;
        {
            let conn = core.conn().unwrap();
            conn.execute(
                "UPDATE queue SET verdict='accepted', sent=1 WHERE kind='create_item'",
                [],
            )
            .unwrap();
            conn.execute(
                "UPDATE queue SET verdict='refused', sent=1, answer=?2 WHERE id=?1",
                rusqlite::params![edge, r#"{"error":{"details":{"constraint":"duplicate"}}}"#],
            )
            .unwrap();
            answered(&conn, "consumed");
            assert!(store::queued_write(&conn, &edge).unwrap().is_some());
            assert_eq!(
                conn.query_row(
                    "SELECT COUNT(*) FROM body_edges WHERE write_id=?1",
                    [&edge],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
                1
            );
        }
        (core, edge)
    }

    #[test]
    fn forgetting_named_writes_leaves_a_body_answer_nobody_named() {
        let (core, edge) = pending_body_duplicate();
        assert_eq!(core.forget_answered_ids(&["consumed".into()]).unwrap(), 1);
        assert!(
            core.queue().unwrap().iter().any(|row| row.id == edge),
            "the body rule discarded a refused edge create nobody named"
        );
        // The witness, and the later call that does take it: the body rule
        // still reads the answer, so clearing everything discards it.
        core.forget_answered().unwrap();
        assert!(
            core.queue().unwrap().iter().all(|row| row.id != edge),
            "the body rule did not read the answer it was left"
        );
    }

    #[test]
    fn forgetting_the_body_answer_by_name_takes_it() {
        let (core, edge) = pending_body_duplicate();
        core.forget_answered_ids(std::slice::from_ref(&edge))
            .unwrap();
        let left = core.queue().unwrap();
        assert!(
            left.iter().all(|row| row.id != edge),
            "a refused edge create that was named stayed"
        );
        assert!(left.iter().any(|row| row.id == "consumed"));
    }

    #[test]
    fn forgetting_no_names_changes_nothing() {
        let (core, edge) = pending_body_duplicate();
        let before = core.queue().unwrap();
        assert_eq!(core.forget_answered_ids(&[]).unwrap(), 0);
        assert_eq!(
            core.queue().unwrap(),
            before,
            "an empty list changed the queue while returning zero"
        );
        assert!(before.iter().any(|row| row.id == edge));
    }

    #[test]
    fn a_long_list_of_odd_ids_names_only_what_it_says() {
        let core = Core::open_in_memory(None).unwrap();
        let conn = core.conn().unwrap();
        answered(&conn, "kept");
        answered(&conn, "selected");
        let mut ids: Vec<String> = (0..40_000).map(|i| format!("unknown-{i}")).collect();
        ids.extend([
            "selected".into(),
            "selected".into(),
            "quote\"slash\\".into(),
            "nul\0id".into(),
        ]);
        assert_eq!(store::forget_answered_ids(&conn, &ids).unwrap(), 1);
        assert!(store::queued_write(&conn, "kept").unwrap().is_some());
    }

    #[test]
    fn another_core_on_the_file_cannot_forget() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("core.db");
        let writer = Core::open(&path, None).unwrap();
        let other = Core::open(&path, None).unwrap();
        answered(&writer.conn().unwrap(), "selected");
        assert_eq!(
            other.forget_answered_ids(&["selected".into()]),
            Err(CoreError::ReadingHandle)
        );
        assert_eq!(writer.forget_answered_ids(&["selected".into()]).unwrap(), 1);
    }

    #[test]
    fn forgetting_a_named_leftover_behind_a_withdrawn_write_takes_it() {
        let core = Core::open_in_memory(None).unwrap();
        {
            let conn = core.conn().unwrap();
            conn.execute("INSERT INTO queue (id, kind, idempotency_key, payload, verdict, sent, depends_on, queued_at) VALUES ('leftover', 'delete_item', 'leftover', '{}', 'refused', 0, '[\"withdrawn\"]', '2026-01-01T00:00:00Z')", []).unwrap();
            answered(&conn, "other");
        }
        assert_eq!(core.forget_answered_ids(&["leftover".into()]).unwrap(), 1);
        let left: Vec<_> = core.queue().unwrap().into_iter().map(|w| w.id).collect();
        assert_eq!(left, vec!["other".to_string()]);
    }
}
