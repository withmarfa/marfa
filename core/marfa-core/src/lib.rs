#[cfg(test)]
mod attachment_tests;
mod blob;
mod body;
mod busy;
mod catalog;
mod catch_up;
/// Public so a debug build's binding can move the clock it waits by.
pub mod clock;
mod counts;
mod damage;
#[cfg(test)]
mod damage_tests;
#[cfg(test)]
mod deleted_stays_gone_tests;
mod directory;
#[cfg(unix)]
mod directory_vfs;
#[cfg(not(unix))]
#[path = "directory_vfs_unsupported.rs"]
mod directory_vfs;
mod drain;
#[cfg(test)]
mod durable_tests;
mod edge_rules;
mod edge_writes;
mod error;
/// Public so the binary can name a fault of its own.
pub mod fault;
mod file_cache;
mod files;
mod filter;
pub mod folder;
mod folder_settings;
#[cfg(test)]
mod forgetting_named_tests;
mod holds;
/// Public for the call shapes it shares with the binary's own transport.
pub mod http;
mod hydrate;
#[cfg(test)]
mod hydrate_refill_tests;
#[cfg(test)]
mod hydrate_resume_tests;
mod instance;
mod item_reads;
mod lock;
mod model;
#[cfg(test)]
mod oldest_server_tests;
mod open;
#[cfg(test)]
mod part_names_tests;
#[cfg(test)]
mod plain_path_tests;
pub mod priority;
mod query;
mod reach;
#[cfg(test)]
mod read_bench_tests;
mod read_only;
#[cfg(test)]
mod read_only_tests;
mod reads;
#[cfg(test)]
mod reads_tests;
mod reclaim;
#[cfg(test)]
mod reclaim_tests;
#[cfg(test)]
mod refusal_tests;
#[cfg(test)]
mod relocation_tests;
mod removal;
#[cfg(test)]
mod remove_tests;
#[cfg(test)]
mod replace_tests;
#[cfg(test)]
mod request_limit_tests;
#[cfg(test)]
mod resend_tests;
mod row_writes;
mod scaffold;
#[cfg(test)]
mod scripted;
mod search;
mod sending;
#[cfg(test)]
mod server_reads_tests;
mod slice;
#[cfg(test)]
mod slice_query_tests;
mod sse;
#[cfg(test)]
mod stop_tests;
mod store;
mod streams;
mod tables;
mod telemetry;
#[cfg(all(test, feature = "telemetry"))]
mod telemetry_tests;
#[cfg(test)]
mod test_folders;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod tier_tests;
mod trash;
#[cfg(test)]
mod trash_tests;
#[cfg(test)]
mod trashed_at_tests;
mod types;
#[cfg(test)]
mod upload_again_tests;
#[cfg(test)]
mod upload_credential_tests;
mod view_writes;
mod views;
mod watch;
#[cfg(test)]
mod watch_tests;
mod wire;
mod write;

use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use rusqlite::Connection;

pub use blob::{file_type_for, mime_type_for};
pub use body::{
    BodyLinks, BodyName, BodyTarget, LinkCandidates, LinkPart, LinkParts, LinkState, link_parts,
};
pub use catalog::ServerCatalog;
pub use catch_up::{Change, ChangeEvent, FollowReport};
pub use counts::{Counted, ItemCount, MOST_IDS, StatusGroups};
pub use damage::SetAside;
pub use drain::{DrainReport, DrainVerdict};
pub use error::{
    CODES as ERROR_CODES, ContractRefusal, CoreError, CoreErrorKind, FolderStore, NOT_HELD,
    RenewalFailure, ServerAnswer, UNREAD_CODE, environmental_status,
};
pub use file_cache::{
    Attachments, DEFAULT_FLOOR as FILE_BUDGET_FLOOR, FileBudget, FileCache, KeptFetch, NotHeld,
    NotHeldReason,
};
pub use marfa_rules::catalog::{EdgeType, End, ItemType, TypeField, WrittenFrom};
pub use marfa_rules::contract;
pub use marfa_rules::display::ItemDisplay;
pub use marfa_rules::thumbnail::Thumbnail;
pub use tables::{
    BYTE_CAP as TABLE_BYTE_CAP, ChangedTable, FillReport, HeldTable, HeldTables,
    ROW_CAP as TABLE_ROW_CAP, RowsAsked, TableChoice, TableHold,
};
/// Refuses the first whole number in `text`, a JSON object of properties,
/// that a float would change, read as written.
pub fn refuse_inexact_integers(text: &str) -> Result<()> {
    Ok(marfa_rules::integers::refuse_inexact_integers(text)?)
}
pub use filter::{
    EdgeDirection, FilterCondition, FilterExpression, FilterField, FilterJoin, FilterOperator,
    FilterValue, SystemField,
};
pub use folder::{
    CaughtUp, Confirmed, Drained, FOLDER_TYPE, FileStatus, FirstSync, Folder, Paused, PullReport,
    Removal, Restored, ScanReport, SendReport, Settings, SettingsFileReport, StatusReport,
    StorageCause, SyncReport, Synced, Unmatched, UnmatchedRemoved, WatchEnd, WatchError,
    WatchEvent, WatchPass,
};
pub use folder_settings::FolderRow;
pub use instance::{InstanceDescription, instance_description};
pub use lock::Handle;
pub use model::{
    Added, Attached, Attachment, BinPage, BlockedReason, CatchUpFailed, CatchUpReport,
    Completeness, Draft, Edge, EdgeDraft, EdgeEdit, EdgeOp, Edit, FieldRefusal, GrantKind,
    GrantLevel, HydrateReport, HydrateRestart, Hydration, Item, ItemState, LastFailure,
    ListFilters, MissingGrant, Outcome, QueuedWrite, Refusal, RowConflict, Rows, SearchFilters,
    SearchHit, Shown, SliceTier, Sort, SortDirection, SortField, Status, TagsWrite, Tier,
    UnregisteredType, UnsentWrite, UnsentWrites, Verdict, WriteKind,
};
pub use reads::CopyChanges;
pub use scaffold::{ScaffoldField, scaffold_type};
pub use slice::SliceQuery;
pub use store::CEILING;
pub use trash::{TrashPreview, TrashPreviewItem, TrashReport, TrashTaken};
pub use views::{VIEW_TYPE, ViewGroup, ViewRow};
pub use watch::{Listening, WatchListener};
#[cfg(debug_assertions)]
pub use watch::{ReentryAnswers, ReentryProbe};

pub(crate) use edge_writes::{queue_edge, queue_edge_delete};
#[cfg(test)]
pub(crate) use files::queue_upload;
pub(crate) use files::{name_bytes, unpin_held};
#[cfg(test)]
pub(crate) use holds::pin_pass_ends;
pub(crate) use streams::{Mover, Streaming, one_at_a_time, streaming_of};
pub(crate) use write::{Based, Body, check_create, queue_create, queue_update};

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
            Err(error) => return Err(not_made(path, &error)),
        }
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

/// A file that cannot be made is a full volume where the volume has no room
/// for it, and a store failure otherwise.
#[cfg(unix)]
fn not_made(path: &Path, error: &std::io::Error) -> CoreError {
    let message = format!("{} cannot be made: {error}", path.display());
    if matches!(
        error.kind(),
        std::io::ErrorKind::StorageFull | std::io::ErrorKind::QuotaExceeded
    ) {
        CoreError::StorageFull(message)
    } else {
        CoreError::Store(message)
    }
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
    /// A relocation callback holds the claim while it commits, so it cannot
    /// record an origin after another process becomes the writer. A transport
    /// made to be let go does not keep it, so dropping the core frees it.
    lock: Arc<lock::WriterLock>,
    /// Hydration, catch-up and follow each move the one cursor, so two at
    /// once could move it backwards, apply an event twice, or apply one to a
    /// copy a hydration has replaced.
    streaming: Mutex<Streaming>,
    /// Two drains at once would each send every unanswered write, so a
    /// second waits for the one under way.
    draining: Mutex<()>,
    /// What each trash or purge out at the server holds, read by the
    /// connection's writes to the queue.
    removing: Arc<store::Removals>,
    /// The one source this store's listeners share (`watch`).
    watch: Arc<watch::Watch>,
    /// Each renewal not yet written down, as the digests of the header it
    /// replaced and of the one that replaced it.
    renewals: Arc<Mutex<Vec<(String, String)>>>,
    /// Before when a `VACUUM` that was refused or failed is not tried again.
    reclaim_held_until: Mutex<Option<std::time::Instant>>,
    /// Raised by a table held while another call held the stream; a follow
    /// looks at it each time it waits for a frame.
    tables_owed: AtomicBool,
    /// `damage::seen` as the core opened, so its close keeps the
    /// write-ahead log of a store found damaged since.
    damage_seen: u64,
}

impl Drop for Core {
    fn drop(&mut self) {
        if let Ok(conn) = self.conn.lock() {
            damage::keep_log_if_met(&conn, self.damage_seen);
        }
    }
}

const DEFAULT_CATCH_UP_IDLE: Duration = Duration::from_secs(3);

/// Well past any fetch or copy of a blob's bytes still running.
const INCOMING_GRACE: Duration = Duration::from_secs(3600);

/// The deepest a queued write's body may nest, counting each array or object
/// inside another and no bracket inside a string: the server refuses a request
/// body nested deeper (`items/json-depth`), so the core refuses it first. A
/// row whose stored properties nest deeper reads as unreadable.
pub const MAX_JSON_DEPTH: usize = 64;

/// The tag the server gives a conflicted copy (`versions/copy-written`).
pub const CONFLICTED_COPY_TAG: &str = "conflicted-copy";

/// The edge type from a conflicted copy to the original
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
    /// A digest of the credential this copy sends with, where it has one.
    fn credential(&self) -> Option<String> {
        self.http()
            .ok()
            .map(|http| store::credential_digest(&http.authorization()))
    }

    fn http(&self) -> Result<&http::Http> {
        self.http.as_deref().ok_or(CoreError::NoServer)
    }

    pub(crate) fn cache(&self) -> Result<&blob::Cache> {
        self.cache.as_ref().ok_or_else(|| {
            CoreError::Invalid("a store held in memory has nowhere to hold a blob's bytes".into())
        })
    }

    /// Frees the connection's page cache, which a pass over a large folder fills.
    pub(crate) fn release_cache(&self) {
        if let Ok(conn) = self.conn.lock() {
            let _ = conn.release_memory();
        }
    }

    pub(crate) fn conn(&self) -> Result<MutexGuard<'_, Connection>> {
        let mut conn = self.conn.lock().map_err(|_| CoreError::poisoned())?;
        if self.handle() == Handle::Writer && store::lapsed(&conn)? {
            let tx = conn.transaction()?;
            reach::expire(&tx)?;
            tx.commit()?;
        }
        Ok(conn)
    }
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
