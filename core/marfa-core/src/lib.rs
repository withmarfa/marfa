//! A local working copy of a declared slice of one Marfa server: hydrated
//! over HTTP, kept current from the event log, read locally, and written to
//! through a queue that holds every write until the server answers it.

mod blob;
mod catalog;
mod catch_up;
pub mod contract;
mod drain;
mod error;
mod filter;
pub mod folder;
/// The working copy's transport, public for the call shapes it shares with
/// the binary's own transport.
pub mod http;
mod hydrate;
mod js;
mod lock;
mod model;
mod query;
#[cfg(test)]
mod scripted;
mod search;
mod sse;
mod store;
mod wire;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use rusqlite::Connection;
use serde_json::Value;

pub use blob::{file_type_for, mime_type_for};
pub use catch_up::{Change, FollowReport};
pub use drain::{DrainReport, DrainVerdict};
pub use error::CoreError;
pub use folder::{
    Drained, FOLDER_TYPE, Folder, PullReport, ScanReport, Settings, SettingsFileReport,
};
pub use lock::Handle;
pub use model::{
    Attached, Attachment, BlockedReason, CatchUpReport, Draft, Edge, EdgeDraft, EdgeEdit, Edit,
    HydrateReport, Hydration, Item, ItemState, ListFilters, MetadataWrite, Outcome, QueuedWrite,
    SearchFilters, SearchHit, Sort, SortDirection, SortField, Status, Thumbnail, Tier, Verdict,
    WriteKind,
};
pub use store::CEILING;

pub type Result<T> = std::result::Result<T, CoreError>;

struct StreamClaim<'a>(&'a AtomicBool);

impl Drop for StreamClaim<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

/// Where the slice comes from. The key is held in memory and never written.
#[derive(Debug, Clone)]
pub struct Server {
    pub url: String,
    pub key: String,
}

pub struct Core {
    conn: Mutex<Connection>,
    /// Shared so a held stream can ask for its next stream on a thread that
    /// holds the transport and nothing of the store.
    http: Option<Arc<http::Http>>,
    /// Where blobs' bytes are held: beside the working copy's file, and nowhere for a
    /// store held in memory.
    cache: Option<blob::Cache>,
    catch_up_idle: Duration,
    /// Held for as long as the `Core` lives, which is what makes it the
    /// claim rather than a record of one (`device.md` 3).
    lock: lock::WriterLock,
    /// Set while a hydration, a catch-up or a follow runs. Each moves the
    /// one cursor, so two at once could move it backwards, apply an event
    /// twice, or apply one to a copy a hydration has replaced.
    streaming: AtomicBool,
}

const DEFAULT_CATCH_UP_IDLE: Duration = Duration::from_secs(3);

/// How old a half-written copy of a blob's bytes must be before the writer
/// takes it away on open: well past any fetch or copy still running.
const INCOMING_GRACE: Duration = Duration::from_secs(3600);

impl Core {
    /// Opens the file at `path`, creating it and its schema when absent. A
    /// file bound to a different server than `server` is refused.
    pub fn open(path: impl AsRef<Path>, server: Option<Server>) -> Result<Core> {
        let path = path.as_ref();
        // Claimed before the store is opened. A second opener that read the
        // store first would have done so as a writer for as long as it took
        // to find out it was not one.
        let lock = lock::WriterLock::claim(Some(path))?;
        let cache = blob::Cache::beside(path);
        if lock.handle() == Handle::Writer {
            cache.sweep_incoming(INCOMING_GRACE);
        }
        Self::from_connection(store::open(path)?, server, lock, Some(cache))
    }

    /// Opens a store another process writes, to read it and nothing else
    /// (`device.md` 41).
    ///
    /// It never claims the writer role, so a helper started before the app
    /// cannot lock the app out of its own store, and it never writes, so it
    /// refuses a path where no store has been made rather than making one.
    /// `data_version` is how it learns the writer saved.
    pub fn open_reader(path: impl AsRef<Path>) -> Result<Core> {
        let path = path.as_ref();
        Ok(Core {
            conn: Mutex::new(store::open_to_read(path)?),
            http: None,
            cache: Some(blob::Cache::beside(path)),
            catch_up_idle: DEFAULT_CATCH_UP_IDLE,
            lock: lock::WriterLock::reader(),
            streaming: AtomicBool::new(false),
        })
    }

    pub fn open_in_memory(server: Option<Server>) -> Result<Core> {
        let lock = lock::WriterLock::claim(None)?;
        Self::from_connection(store::open_in_memory()?, server, lock, None)
    }

    /// Which handle this process holds: the one that may write, or a second
    /// opener that reads and refuses every write.
    pub fn handle(&self) -> Handle {
        self.lock.handle()
    }

    /// How long a silent event stream is read before catch-up decides it has
    /// nothing more to replay.
    pub fn with_catch_up_idle(mut self, idle: Duration) -> Core {
        self.catch_up_idle = idle;
        self
    }

    fn from_connection(
        conn: Connection,
        server: Option<Server>,
        lock: lock::WriterLock,
        cache: Option<blob::Cache>,
    ) -> Result<Core> {
        let http = match server {
            Some(server) => Some(Arc::new(http::Http::new(&server.url, &server.key)?)),
            None => None,
        };
        if let Some(http) = &http
            && let Some(expected) = store::meta_get(&conn, store::META_SERVER_ORIGIN)?
            && expected != http.origin()
        {
            return Err(CoreError::WrongServer {
                expected,
                got: http.origin(),
            });
        }
        Ok(Core {
            conn: Mutex::new(conn),
            http,
            cache,
            catch_up_idle: DEFAULT_CATCH_UP_IDLE,
            lock,
            streaming: AtomicBool::new(false),
        })
    }

    /// Replaces the local copy with every item of the declared `types` at
    /// `tier`, with their tags and outbound edges, and stores the event
    /// cursor to catch up from. The pinned rows are read again; no edge type
    /// is held whole.
    ///
    /// Refused while a catch-up or a follow runs on this handle, as they are
    /// while it runs: a follow left running across a hydration would apply
    /// events read against the old slice to the new copy and move the cursor
    /// the hydration stored. A caller stops its follow first.
    pub fn hydrate(&self, types: &[String], tier: Tier) -> Result<HydrateReport> {
        self.hydrate_with(types, tier, &[])
    }

    /// A hydration that also holds every edge of `edge_types` the key reads,
    /// whichever ends the copy holds (`device.md` 1, 14).
    pub fn hydrate_with(
        &self,
        types: &[String],
        tier: Tier,
        edge_types: &[String],
    ) -> Result<HydrateReport> {
        // A hydration replaces the copy, which is a write to the store like
        // any other (`device.md` 26).
        self.lock.refuse_unless_writer()?;
        let _streaming = self.claim_stream()?;
        hydrate::hydrate(self, self.http()?, types, tier, edge_types, false)
    }

    /// A folder's hydration, where no types is every type the key reads
    /// (`folders.md` 2), held as `store::EVERY_TYPE`.
    pub(crate) fn hydrate_every_type_or(
        &self,
        types: &[String],
        tier: Tier,
        edge_types: &[String],
    ) -> Result<HydrateReport> {
        self.lock.refuse_unless_writer()?;
        let _streaming = self.claim_stream()?;
        hydrate::hydrate(self, self.http()?, types, tier, edge_types, true)
    }

    /// Holds `id` whatever the slice says of it (`device.md` 1), read now; one
    /// neither the server nor the copy holds is refused. Answers whether it
    /// was pinned already.
    pub fn pin(&self, id: &str) -> Result<bool> {
        self.lock.refuse_unless_writer()?;
        let http = self.http()?;
        // Pinned before the read, so an event a follow applies meanwhile is kept.
        let added = {
            let conn = self.conn()?;
            store::refuse_unless_hydrated(&conn)?;
            store::pin(&conn, id)?
        };
        let held = hydrate::read_with_edges(http, id).and_then(|read| {
            let mut conn = self.conn()?;
            let tx = conn.transaction()?;
            let held = match &read {
                Some((row, edges)) => {
                    let catalog = catalog::Catalog::load(&tx)?;
                    hydrate::hold_row(&tx, &catalog, row, edges)?;
                    true
                }
                None => store::item_held(&tx, id)?,
            };
            tx.commit()?;
            Ok(held)
        });
        if !matches!(held, Ok(true)) && added {
            store::unpin(&*self.conn()?, id)?;
        }
        match held? {
            true => Ok(!added),
            false => Err(CoreError::NotFound {
                code: "not_found".into(),
                message: format!("the server holds no item {id} to pin"),
            }),
        }
    }

    /// Stops holding `id` by id; a row the slice does not take goes, unless
    /// writes to it still wait. Answers whether it was pinned.
    pub fn unpin(&self, id: &str) -> Result<bool> {
        self.lock.refuse_unless_writer()?;
        let mut conn = self.conn()?;
        let tx = conn.transaction()?;
        let pinned = store::unpin(&tx, id)?;
        if pinned
            && store::waiting_writes_for_item(&tx, id)?.is_empty()
            && let Some((types, tier)) = store::slice(&tx)?
            && let Some(held) = store::items_by_ids(&tx, &[id.to_string()])?.pop()
        {
            let catalog = catalog::Catalog::load(&tx)?;
            if !store::slice_takes(&catalog, &types, tier, &held.r#type, held.tier) {
                store::evict_item(&tx, id, &store::whole_edge_types(&tx)?)?;
            }
        }
        tx.commit()?;
        Ok(pinned)
    }

    /// Applies every event since the stored cursor and advances it.
    pub fn catch_up(&self) -> Result<CatchUpReport> {
        self.lock.refuse_unless_writer()?;
        let _streaming = self.claim_stream()?;
        catch_up::catch_up(self, self.http()?, self.catch_up_idle)
    }

    /// Holds the event stream open and applies each event as it arrives,
    /// telling `on_change` of each one that changed the copy, until `stop` is
    /// set (`device.md` 40).
    ///
    /// `on_change` is called with no lock on the store held, so it may read
    /// the row it is told about.
    pub fn follow(
        &self,
        stop: &AtomicBool,
        mut on_change: impl FnMut(&Change),
    ) -> Result<FollowReport> {
        self.lock.refuse_unless_writer()?;
        let http = self.http.clone().ok_or(CoreError::NoServer)?;
        let _streaming = self.claim_stream()?;
        // A follow runs on a thread of its own, and a binding says it ended
        // when this returns: a fault that unwound past here would end the
        // thread with nothing said, and a caller waiting to be told would
        // wait for good.
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            catch_up::follow(self, http, stop, &mut on_change)
        }))
        .unwrap_or_else(|fault| Err(CoreError::Invalid(fault_message(fault.as_ref()))))
    }

    /// A number that moves each time another process saves to this store:
    /// a reader polls it and reads again when it moves (`device.md` 41).
    pub fn data_version(&self) -> Result<i64> {
        store::data_version(&*self.conn()?)
    }

    pub fn list(&self, filters: &ListFilters, sort: Sort) -> Result<Vec<Item>> {
        let conn = self.conn()?;
        store::refuse_unless_hydrated(&conn)?;
        let catalog = catalog::Catalog::load(&conn)?;
        query::list(&conn, &catalog, filters, sort)
    }

    pub fn get(&self, id: &str) -> Result<Option<Item>> {
        let conn = self.conn()?;
        store::refuse_unless_hydrated(&conn)?;
        store::item_by_id(&conn, id)
    }

    /// The thumbnail an item carries, from the held row with no request.
    /// `None` when its type declares no thumbnail or it carries none, which
    /// is no value or null; an item the copy does not hold is refused, so the
    /// two are never confused. A held value that is not a thumbnail's (one
    /// written before its type declared the property, text or not) is
    /// refused `Decoding`, naming the item.
    pub fn thumbnail(&self, id: &str) -> Result<Option<Thumbnail>> {
        let conn = self.conn()?;
        store::refuse_unless_hydrated(&conn)?;
        let Some(item) = store::item_by_id(&conn, id)? else {
            return Err(CoreError::NotFound {
                code: "not_held".into(),
                message: format!("{id} is not held in this working copy"),
            });
        };
        let catalog = catalog::Catalog::load(&conn)?;
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
        store::refuse_unless_hydrated(&conn)?;
        store::edges_from(&conn, id)
    }

    /// The edges the copy holds that point at `id`: the replies in a thread,
    /// the files attached to an item.
    pub fn edges_to(&self, id: &str) -> Result<Vec<Edge>> {
        let conn = self.conn()?;
        store::refuse_unless_hydrated(&conn)?;
        store::edges_to(&conn, id)
    }

    /// Full-text search over titles, bodies and tags, best match first,
    /// narrowed as `SearchFilters` says.
    pub fn search(
        &self,
        query: &str,
        filters: &SearchFilters,
        limit: usize,
    ) -> Result<Vec<SearchHit>> {
        let conn = self.conn()?;
        store::refuse_unless_hydrated(&conn)?;
        let catalog = catalog::Catalog::load(&conn)?;
        search::search(&conn, &catalog, query, filters, limit)
    }

    /// Every queued write and what became of it.
    ///
    /// Answerable without a hydration: a queue is a record of what a caller
    /// asked for, and a caller who has to hydrate before they can be told
    /// what is outstanding has been told nothing at the moment they most
    /// need it (`queue-and-verdicts.md` 6).
    ///
    /// A store this build cannot read is a different matter and refuses at
    /// open, queue and all: the file's shape is what is in question there,
    /// not whether a slice has been pulled into it.
    pub fn queue(&self) -> Result<Vec<QueuedWrite>> {
        let conn = self.conn()?;
        store::queued_writes(&conn)
    }

    /// Sends what the queue holds and records the verdict of each write.
    ///
    /// One pass. Every sendable row is attempted once and the drain returns;
    /// a row that met an environmental failure is left unanswered and
    /// uncounted for the next pass (`queue-and-verdicts.md` 17). An answer on
    /// another contract ends the pass with `ContractMismatch` instead, and
    /// the rows answered before it hold their verdicts in the queue
    /// (`device.md` 42).
    pub fn drain(&self) -> Result<DrainReport> {
        // The handle before the server. A second opener with no server
        // configured is still a second opener, and refusing it for the
        // missing server would tell it the wrong thing about why it may
        // not write.
        self.lock.refuse_unless_writer()?;
        drain::drain(self, self.http()?)
    }

    /// Sends a blocked or dead row again, under a fresh idempotency key
    /// (`queue-and-verdicts.md` 27).
    ///
    /// Answers `false` where the row is not one a release applies to: an
    /// unanswered row is already going out, and an accepted one has been
    /// written. Re-sending either would be this door writing twice.
    pub fn release(&self, id: &str) -> Result<bool> {
        self.lock.refuse_unless_writer()?;
        let conn = self.conn()?;
        store::release(&conn, id)
    }

    /// Releases every row blocked for one reason.
    ///
    /// The other half of statement 27: a caller releases "one row or one
    /// reason at a time", and a single refused credential parks a whole
    /// queue, so releasing them one id at a time would be the caller doing
    /// the queue's bookkeeping by hand.
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
        // One transaction, because a release part-way through is a queue
        // where some rows carry a fresh key and some still carry a spent
        // one, and the count that came back described neither.
        tx.commit()?;
        Ok(released)
    }

    /// Moves an edit blocked `ancestor_unavailable` onto the version the copy
    /// holds, to go again under a fresh key (`queue-and-verdicts.md` 22).
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
        tx.commit()?;
        Ok(true)
    }

    /// Queues a create, and holds the row locally until it is answered
    /// (`queue_create` says how).
    pub fn create_item(&self, draft: &Draft) -> Result<QueuedWrite> {
        self.lock.refuse_unless_writer()?;
        let mut conn = self.conn()?;
        store::refuse_unless_hydrated(&conn)?;
        let catalog = catalog::Catalog::load(&conn)?;
        let tx = conn.transaction()?;
        let queued = queue_create(&tx, &catalog, draft, &[])?;
        tx.commit()?;
        Ok(queued)
    }

    /// Queues an update, and applies it to the working copy
    /// (`queue_update` says what it requires).
    pub fn update_item(&self, id: &str, edit: &Edit) -> Result<QueuedWrite> {
        self.lock.refuse_unless_writer()?;
        let mut conn = self.conn()?;
        store::refuse_unless_hydrated(&conn)?;
        let catalog = catalog::Catalog::load(&conn)?;
        let tx = conn.transaction()?;
        let queued = queue_update(&tx, &catalog, id, edit, &[], Based::OnHeld)?;
        tx.commit()?;
        Ok(queued)
    }

    /// Queues an update based on a version the copy read before the one it
    /// holds now, which the server merges against what was read
    /// (`queue-and-verdicts.md` 43). An editor holding a row while the copy
    /// catches up bases its save on what its person read, not on what came
    /// in since, so another device's write is merged rather than overwritten.
    pub fn update_item_as_read(&self, id: &str, edit: &Edit) -> Result<QueuedWrite> {
        self.lock.refuse_unless_writer()?;
        let mut conn = self.conn()?;
        store::refuse_unless_hydrated(&conn)?;
        let catalog = catalog::Catalog::load(&conn)?;
        let tx = conn.transaction()?;
        let queued = queue_update(&tx, &catalog, id, edit, &[], Based::AsRead)?;
        tx.commit()?;
        Ok(queued)
    }

    /// Queues a delete, and moves the row to the bin locally.
    ///
    /// Not a purge (`device.md` 25). The row stays in the copy under the
    /// state the server would give it, so a caller reading it sees what the
    /// server will hold rather than a row that has already vanished.
    pub fn delete_item(&self, id: &str) -> Result<QueuedWrite> {
        self.transition_locally(id, WriteKind::DeleteItem, ItemState::Trashed, "{}")
    }

    /// Queues a restore, and takes the row out of the bin locally.
    pub fn restore_item(&self, id: &str) -> Result<QueuedWrite> {
        self.transition_locally(id, WriteKind::RestoreItem, ItemState::Active, "{}")
    }

    /// Queues a move to another lifecycle state.
    ///
    /// `revoked` is refused: it is reachable only on a reserved type and on
    /// the server's own authority, so a device asking for it is asking for
    /// something no key of its can be granted.
    pub fn transition_item(&self, id: &str, state: ItemState) -> Result<QueuedWrite> {
        if state == ItemState::Revoked {
            return Err(CoreError::Invalid(format!(
                "a device cannot move {id} to the revoked state; it is reachable only on a reserved type and on the server's authority"
            )));
        }
        let payload = serde_json::to_string(&serde_json::json!({ "state": state.as_str() }))?;
        self.transition_locally(id, WriteKind::TransitionItem, state, &payload)
    }

    /// The three item writes that move a row's state and leave its fields
    /// and its version alone.
    fn transition_locally(
        &self,
        id: &str,
        kind: WriteKind,
        state: ItemState,
        payload: &str,
    ) -> Result<QueuedWrite> {
        self.lock.refuse_unless_writer()?;
        let mut conn = self.conn()?;
        store::refuse_unless_hydrated(&conn)?;
        if !store::item_held(&conn, id)? {
            return Err(CoreError::NotFound {
                code: "item_not_found".into(),
                message: format!("{id} is not a row this copy holds"),
            });
        }
        // The create and nothing else, for the reason `update_item` gives.
        let depends_on = store::untaken_creates_for_item(&conn, id)?;
        let tx = conn.transaction()?;
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
                base_version: None,
                payload,
                depends_on: &depends_on,
            },
        )?;
        tx.commit()?;
        Ok(queued)
    }

    /// Queues an edge, and holds it locally until it is answered
    /// (`queue_edge` says what it waits for).
    pub fn create_edge(&self, draft: &EdgeDraft) -> Result<QueuedWrite> {
        self.lock.refuse_unless_writer()?;
        let mut conn = self.conn()?;
        store::refuse_unless_hydrated(&conn)?;
        let tx = conn.transaction()?;
        let queued = queue_edge(&tx, draft)?;
        tx.commit()?;
        Ok(queued)
    }

    /// A move of an end goes in the same write as the properties, so the edge is
    /// never absent between two; the version is required, as an item's is.
    pub fn update_edge(&self, id: &str, edit: &EdgeEdit) -> Result<QueuedWrite> {
        self.lock.refuse_unless_writer()?;
        let mut conn = self.conn()?;
        store::refuse_unless_hydrated(&conn)?;
        let Some(held) = store::edge_by_id(&conn, id)? else {
            return Err(CoreError::NotFound {
                code: "edge_not_found".into(),
                message: format!("{id} is not an edge this copy holds"),
            });
        };
        let Some(base) = edit.base_version else {
            return Err(CoreError::Invalid(format!(
                "an update to edge {id} carries no version; a write that names no version overwrites whatever it finds"
            )));
        };
        if base != held.version {
            return Err(CoreError::Invalid(format!(
                "the update to edge {id} is based on version {base} and this copy holds version {}; read it again",
                held.version
            )));
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
        next.updated_at = store::now_iso();
        let tx = conn.transaction()?;
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
        Ok(queued)
    }

    /// Queues an edge delete, and drops it from the copy.
    pub fn delete_edge(&self, id: &str) -> Result<QueuedWrite> {
        self.lock.refuse_unless_writer()?;
        let mut conn = self.conn()?;
        store::refuse_unless_hydrated(&conn)?;
        let held = held_edge(&conn, id)?;
        let tx = conn.transaction()?;
        let queued = queue_edge_delete(&tx, &held)?;
        tx.commit()?;
        Ok(queued)
    }

    /// Queues one tag onto a row, as its own write.
    pub fn add_tag(&self, id: &str, tag: &str) -> Result<QueuedWrite> {
        let payload = serde_json::to_string(&serde_json::json!({ "tags": [tag] }))?;
        self.tag_write(id, WriteKind::AddTag, Some(tag), &payload, |tx| {
            store::add_tags(tx, id, std::slice::from_ref(&tag.to_string()))
        })
    }

    /// Queues the removal of one tag, as its own write.
    pub fn remove_tag(&self, id: &str, tag: &str) -> Result<QueuedWrite> {
        self.tag_write(id, WriteKind::RemoveTag, Some(tag), "{}", |tx| {
            store::remove_tag(tx, id, tag)
        })
    }

    /// The writes that change what a row is tagged with: one tag at a time,
    /// or the set whole.
    fn tag_write(
        &self,
        id: &str,
        kind: WriteKind,
        tag: Option<&str>,
        payload: &str,
        apply: impl FnOnce(&rusqlite::Transaction<'_>) -> Result<()>,
    ) -> Result<QueuedWrite> {
        self.lock.refuse_unless_writer()?;
        let mut conn = self.conn()?;
        store::refuse_unless_hydrated(&conn)?;
        if !store::item_held(&conn, id)? {
            return Err(CoreError::NotFound {
                code: "item_not_found".into(),
                message: format!("{id} is not a row this copy holds"),
            });
        }
        let depends_on = store::untaken_creates_for_item(&conn, id)?;
        let tx = conn.transaction()?;
        apply(&tx)?;
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

    /// Queues a metadata write: the tags whole, or merged into what is there.
    ///
    /// The tags are the half a working copy holds, so they land locally. An
    /// extension namespace is not part of the copy and is its own write.
    pub fn write_metadata(
        &self,
        id: &str,
        write: &MetadataWrite,
        replace: bool,
    ) -> Result<QueuedWrite> {
        let payload = write.payload()?;
        let kind = if replace {
            WriteKind::ReplaceMetadata
        } else {
            WriteKind::MergeMetadata
        };
        // No tag named: the column says which tag a write is about, and a
        // metadata write is about all of them at once.
        self.tag_write(id, kind, None, &payload, |tx| {
            if replace {
                store::replace_tags(tx, id, &write.tags)
            } else {
                store::add_tags(tx, id, &write.tags)
            }
        })
    }

    /// Queues a write to one extension namespace.
    ///
    /// Queued and not applied: a working copy holds items, edges and tags,
    /// and an extension namespace is none of those. The write is answered
    /// like any other and the copy has nothing to change.
    pub fn write_extension(&self, id: &str, namespace: &str, body: &str) -> Result<QueuedWrite> {
        self.extension_write(id, namespace, WriteKind::WriteExtension, body)
    }

    /// Queues the removal of one extension namespace.
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
        store::refuse_unless_hydrated(&conn)?;
        if namespace.is_empty() {
            return Err(CoreError::Invalid(
                "an extension write names no namespace, and the namespace is where it goes".into(),
            ));
        }
        if !store::item_held(&conn, id)? {
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

    /// Queues an upload (`device.md` 38).
    ///
    /// The bytes are copied beside the working copy under their hash, and
    /// the queue holds that name and never the bytes: a queue is read whole
    /// by every write that looks for what it depends on.
    pub fn put_blob(&self, path: &Path, mime_type: Option<&str>) -> Result<QueuedWrite> {
        self.with_upload(
            path,
            &blob::mime_type_for(path, mime_type),
            |_, _, upload, _| Ok(upload.clone()),
        )
    }

    /// Queues a file item for a file: its upload, and the create waiting on
    /// it, naming the bytes and their MIME type.
    pub(crate) fn create_file_item(&self, path: &Path, draft: &Draft) -> Result<QueuedWrite> {
        self.refuse_unknown_type(&draft.r#type)?;
        let mime_type = blob::mime_type_for(path, None);
        self.with_upload(path, &mime_type, |tx, catalog, upload, hash| {
            let mut draft = draft.clone();
            name_bytes(&mut draft.properties, hash, &mime_type);
            queue_create(tx, catalog, &draft, std::slice::from_ref(&upload.id))
        })
    }

    /// Queues new bytes for a file item: their upload, and the update waiting
    /// on it that names them.
    pub(crate) fn update_file_item(
        &self,
        id: &str,
        path: &Path,
        edit: &Edit,
        based: Based,
    ) -> Result<QueuedWrite> {
        let mime_type = blob::mime_type_for(path, None);
        self.with_upload(path, &mime_type, |tx, catalog, upload, hash| {
            let mut edit = edit.clone();
            name_bytes(&mut edit.properties, hash, &mime_type);
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

    /// Refuses a type the copy does not hold before any bytes are taken in,
    /// so a create the type would refuse leaves no bytes behind that nothing
    /// names.
    fn refuse_unknown_type(&self, r#type: &str) -> Result<()> {
        let conn = self.conn()?;
        if catalog::Catalog::load(&conn)?.known(r#type) {
            return Ok(());
        }
        Err(CoreError::UnknownType {
            message: format!("{type} is not a type this copy holds", type = r#type),
        })
    }

    /// Takes a file's bytes in beside the working copy, then queues their
    /// upload and whatever waits on it in one transaction: a write queued
    /// without the upload it names would name bytes the server is never
    /// sent.
    fn with_upload<T>(
        &self,
        path: &Path,
        mime_type: &str,
        then: impl FnOnce(&Connection, &catalog::Catalog, &QueuedWrite, &str) -> Result<T>,
    ) -> Result<T> {
        self.lock.refuse_unless_writer()?;
        store::refuse_unless_hydrated(&*self.conn()?)?;
        let hash = self.cache()?.take(path)?;
        let mut conn = self.conn()?;
        let catalog = catalog::Catalog::load(&conn)?;
        let tx = conn.transaction()?;
        let upload = queue_upload(&tx, &hash, mime_type)?;
        let queued = then(&tx, &catalog, &upload, &hash)?;
        tx.commit()?;
        Ok(queued)
    }

    /// Attaches a file to an item (`device.md` 38): its upload, a file item
    /// naming the bytes, and an `attached-to` edge from the file to the item.
    ///
    /// Three writes, each with its own verdict, each waiting on the one
    /// before it, queued in one transaction: a file item queued without its
    /// upload names bytes the server never receives, and an edge queued
    /// without its file item links nothing.
    pub fn attach(&self, target: &str, path: &Path, attachment: &Attachment) -> Result<Attached> {
        self.lock.refuse_unless_writer()?;
        {
            let conn = self.conn()?;
            store::refuse_unless_hydrated(&conn)?;
            // A row in the bin reads as absent (`device.md` 32), and a file
            // attached to it would be linked to something nobody can open.
            if store::item_by_id(&conn, target)?.is_none() {
                return Err(CoreError::NotFound {
                    code: "item_not_found".into(),
                    message: format!("{target} is not a row this copy holds"),
                });
            }
        }
        let mime_type = blob::mime_type_for(path, attachment.mime_type.as_deref());
        let title = attachment.title.clone().unwrap_or_else(|| {
            path.file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| "file".into())
        });
        let mut properties = serde_json::Map::new();
        properties.insert("title".into(), title.into());
        let mut draft = Draft {
            r#type: blob::file_type_for(&mime_type, attachment.r#type.as_deref()),
            properties,
            tier: attachment.tier,
            ..Default::default()
        };
        self.refuse_unknown_type(&draft.r#type)?;
        self.with_upload(path, &mime_type, |tx, catalog, upload, hash| {
            name_bytes(&mut draft.properties, hash, &mime_type);
            let item = queue_create(tx, catalog, &draft, std::slice::from_ref(&upload.id))?;
            let edge = queue_edge(
                tx,
                &EdgeDraft {
                    source_id: item.item_id.clone().unwrap_or_default(),
                    target_id: target.to_string(),
                    edge_type: "attached-to".into(),
                    ..Default::default()
                },
            )?;
            Ok(Attached {
                upload: upload.clone(),
                item,
                edge,
            })
        })
    }

    /// A blob's bytes, as a file beside the working copy (`device.md` 30,
    /// 37).
    ///
    /// Answered from what is held there when the bytes are held, and
    /// otherwise fetched through the link the server gives and held for
    /// next time. Where there are no bytes and no way to fetch them, the
    /// refusal is `bytes_absent` naming the hash: the item that names them
    /// is whole.
    pub fn blob(&self, hash: &str) -> Result<PathBuf> {
        let hash = blob::named(hash)?;
        let cache = self.cache()?;
        if let Some(path) = cache.held(&hash)? {
            return Ok(path);
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
        blob::fetch(cache, http, &hash)
    }

    /// Whether a blob's bytes are held beside the working copy, with no
    /// request.
    pub fn blob_held(&self, hash: &str) -> Result<bool> {
        Ok(self.cache()?.held(&blob::named(hash)?)?.is_some())
    }

    /// Clears the rows the server has answered, and says how many went.
    ///
    /// A queue nobody empties makes every later write slower, because each
    /// one reads the whole queue to find what it depends on. Only the
    /// terminal verdicts go: a `blocked` or a `dead` row is one a caller may
    /// still release.
    pub fn forget_answered(&self) -> Result<usize> {
        self.lock.refuse_unless_writer()?;
        let conn = self.conn()?;
        store::forget_answered(&conn)
    }

    pub fn status(&self) -> Result<Status> {
        let conn = self.conn()?;
        let slice_types = match store::meta_get(&conn, store::META_SLICE_TYPES)? {
            Some(json) => serde_json::from_str(&json)?,
            None => Vec::new(),
        };
        let slice_tier = match store::meta_get(&conn, store::META_SLICE_TIER)? {
            Some(text) => Some(text.parse()?),
            None => None,
        };
        let event_cursor = store::meta_get(&conn, store::META_EVENT_CURSOR)?;
        let hydration = if !store::hydration_complete(&conn)? {
            Hydration::InProgress
        } else if store::hydrated(&conn)? {
            Hydration::Complete
        } else if store::holds_slice(&conn)? {
            // A slice and no cursor: hydrated once, and the log has moved
            // past where it left off.
            Hydration::Expired
        } else {
            Hydration::Never
        };
        Ok(Status {
            server_origin: store::meta_get(&conn, store::META_SERVER_ORIGIN)?,
            slice_types,
            slice_tier,
            slice_edge_types: store::whole_edge_types(&conn)?,
            pinned: store::pins(&conn)?,
            event_cursor,
            hydration,
            items: store::count(&conn, "items")?,
            edges: store::count(&conn, "edges")?,
        })
    }

    fn http(&self) -> Result<&http::Http> {
        self.http.as_deref().ok_or(CoreError::NoServer)
    }

    fn claim_stream(&self) -> Result<StreamClaim<'_>> {
        self.streaming
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| {
                CoreError::Invalid(
                    "this working copy is already hydrating, catching up or following; one \
                     at a time moves its cursor"
                        .into(),
                )
            })?;
        Ok(StreamClaim(&self.streaming))
    }

    pub(crate) fn cache(&self) -> Result<&blob::Cache> {
        self.cache.as_ref().ok_or_else(|| {
            CoreError::Invalid("a store held in memory has nowhere to hold a blob's bytes".into())
        })
    }

    pub(crate) fn http_ref(&self) -> Result<&http::Http> {
        self.http()
    }

    pub(crate) fn lock_ref(&self) -> &lock::WriterLock {
        &self.lock
    }

    pub(crate) fn conn(&self) -> Result<MutexGuard<'_, Connection>> {
        self.conn
            .lock()
            .map_err(|_| CoreError::Store("the connection was poisoned by an earlier panic".into()))
    }
}

/// A create, held locally and queued in the caller's transaction, waiting
/// on `after` as well as on anything the row itself waits for.
///
/// The row lands locally and the write is queued together. Either would be
/// wrong alone: a queued write with no local row is a change a caller cannot
/// see, and a local row with no queued write is a change the server will
/// never hear about.
///
/// The id is minted here rather than left to the server, because a row a
/// caller has been told was queued has to be readable locally before anyone
/// has answered for it (`queue-and-verdicts.md` 31), and a row with no id
/// cannot be read by one. It is sent only on a create carrying no natural
/// key: one carrying a `source_id` goes without it and the server names the
/// row, and the copy moves onto that name when the answer comes (38).
///
/// The version is optional on a create and carried when given
/// (`queue-and-verdicts.md` 2): where the natural key resolves a live row the
/// server answers it exactly as it answers an update.
fn queue_create(
    tx: &Connection,
    catalog: &catalog::Catalog,
    draft: &Draft,
    after: &[String],
) -> Result<QueuedWrite> {
    if !catalog.known(&draft.r#type) {
        return Err(CoreError::UnknownType {
            message: format!("{} is not a type this copy holds", draft.r#type),
        });
    }
    let id = draft
        .id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::now_v7().to_string());
    let payload = draft.payload(&id)?;
    store::upsert_item(
        tx,
        &draft.wire(&id),
        Some(&draft.tags),
        &catalog.indexing(&draft.r#type),
    )?;
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
            depends_on: after,
        },
    )?;
    if let (Some(source), Some(source_id)) = (&draft.source, &draft.source_id) {
        store::follow_row_under_key(tx, &queued, source, source_id)?;
    }
    // One write per tag, each waiting on the create
    // (`queue-and-verdicts.md` 33, `device.md` 22), queued with it: a create
    // that landed with its tags queued separately and then failed to queue
    // them would be a create that dropped what it was asked for, which is
    // exactly what 22 forbids.
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

/// Which version an update may be based on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Based {
    /// The version the copy holds now.
    OnHeld,
    /// That version or an earlier one the caller read, which the server
    /// merges the write against.
    AsRead,
}

/// An update, applied to the copy and queued in the caller's transaction,
/// waiting on `after` as well as on the row's own create while the server has
/// not taken it.
///
/// **The version is required** (`queue-and-verdicts.md` 2). An update with
/// none is refused here rather than sent, because a version-less update is a
/// write that overwrites whatever it finds, which is the defect the folder
/// rules were written against.
///
/// The fields are the caller's, whole (`queue-and-verdicts.md` 34). A device
/// does not merge inside a field and does not assume the server will, so
/// what it sends is what it was handed.
fn queue_update(
    tx: &Connection,
    catalog: &catalog::Catalog,
    id: &str,
    edit: &Edit,
    after: &[String],
    based: Based,
) -> Result<QueuedWrite> {
    let Some(held) = store::item_by_id(tx, id)? else {
        return Err(CoreError::NotFound {
            code: "item_not_found".into(),
            message: format!("{id} is not a row this copy holds"),
        });
    };
    let Some(base) = edit.base_version else {
        return Err(CoreError::Invalid(format!(
            "an update to {id} carries no version; a write that names no version overwrites whatever it finds"
        )));
    };
    // A type or tier naming the one the row shows already moves nothing, and
    // is not sent: the drain reads a type or tier in a sent edit as a move,
    // and lets the row go where its answer is outside the slice.
    let edit = &Edit {
        r#type: edit.r#type.clone().filter(|r#type| *r#type != held.r#type),
        tier: edit.tier.filter(|tier| Some(*tier) != held.tier),
        ..edit.clone()
    };
    if let Some(r#type) = edit.r#type.as_ref().filter(|r#type| !catalog.known(r#type)) {
        return Err(CoreError::UnknownType {
            message: format!("{type} is not a type this copy holds, so {id} cannot move to it"),
        });
    }
    // The version the caller read, against the row as it stands. A caller
    // editing a row the copy has since replaced is editing something they
    // have not seen, and sending it would be a write based on a version that
    // was never theirs. A caller saying which earlier version it read is the
    // exception: the server merges its write against that version, so what
    // came in since is kept rather than overwritten.
    let read_earlier = based == Based::AsRead && base > 0 && base <= held.version;
    if base != held.version && !read_earlier {
        return Err(CoreError::Invalid(format!(
            "the update to {id} is based on version {base} and this copy holds version {}; read it again",
            held.version
        )));
    }
    let payload = edit.payload(base)?;
    // What this edit is made against, before it is laid over the copy: the
    // copy's row, where the edit is based on the version the copy holds. One
    // based on a version it read earlier was made against that version, not
    // against what the copy has taken in since, and nothing records it.
    // A whole-properties edit also changes every property it leaves out.
    let read = (base == held.version).then(|| {
        let cleared = held.properties.keys().filter(|_| edit.replace_properties);
        serde_json::json!({
            "properties": edit
                .properties
                .keys()
                .chain(cleared)
                .map(|key| (key.clone(), held.properties.get(key).cloned().unwrap_or(Value::Null)))
                .collect::<serde_json::Map<String, Value>>(),
        })
    });
    let mut next = held.clone();
    // As the lay-over does: only an edit that read the copy knows which
    // properties it cleared.
    if edit.replace_properties && read.is_some() {
        next.properties = edit.properties.clone();
    } else {
        for (key, value) in &edit.properties {
            next.properties.insert(key.clone(), value.clone());
        }
    }
    // **The natural key moves on the copy too, not only on the wire.**
    //
    // The copy is what the folder reads to answer "who holds this name".
    // Leaving the old key on it means an item that has asked to be renamed
    // still answers to the name it is leaving, and the next file to take that
    // name bases its create on this row, which the server resolves as an
    // upsert onto it. The name is applied for the same reason the properties
    // are: a refusal reconciles the row back.
    if let Some(source_id) = &edit.source_id {
        next.source_id = Some(source_id.clone());
    }
    if let Some(r#type) = &edit.r#type {
        next.r#type = r#type.clone();
    }
    if let Some(tier) = edit.tier {
        next.tier = Some(tier);
    }
    next.updated_at = store::now_iso();
    store::upsert_item(tx, &next.as_wire(), None, &catalog.indexing(&next.r#type))?;
    // The create and nothing else (`queue-and-verdicts.md` 4), besides what
    // the caller names. A write held for every unanswered row is a write a
    // refused tag can refuse, and statement 16 is about a row the server
    // never accepted, not about a sibling write that failed for its own
    // reasons. Ordering is a different thing and is recorded apart from
    // this: the queue notes the write ahead of this one to the same row,
    // which holds it without refusing it (`queue-and-verdicts.md` 42).
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

/// An edge, held locally and queued in the caller's transaction.
///
/// It waits for both of its endpoints' creates (`queue-and-verdicts.md` 4):
/// an edge naming a row whose create has not landed is an edge the server
/// has nowhere to put, and either end can be the one that has not.
fn queue_edge(tx: &Connection, draft: &EdgeDraft) -> Result<QueuedWrite> {
    let id = draft
        .id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::now_v7().to_string());
    let payload = draft.payload(&id)?;
    let mut depends_on: Vec<String> = Vec::new();
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

/// The edge the copy holds under `id`, or the refusal naming it.
fn held_edge(conn: &Connection, id: &str) -> Result<model::Edge> {
    store::edge_by_id(conn, id)?.ok_or_else(|| CoreError::NotFound {
        code: "edge_not_found".into(),
        message: format!("{id} is not an edge this copy holds"),
    })
}

/// An edge's delete, queued in the caller's transaction and dropped from the
/// copy.
fn queue_edge_delete(tx: &Connection, held: &model::Edge) -> Result<QueuedWrite> {
    let depends_on = store::untaken_create_for_edge(tx, &held.id)?;
    // A refused delete is reconciled by reading edges by type, and the row
    // is gone from the copy by then.
    let payload = serde_json::json!({ "edge_type": held.edge_type }).to_string();
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

/// A file item's two properties that name its bytes: their hash, and the
/// MIME type they are sent under.
fn name_bytes(properties: &mut serde_json::Map<String, Value>, hash: &str, mime_type: &str) {
    properties.insert("blob_ref".into(), hash.into());
    properties.insert("mime_type".into(), mime_type.into());
}

/// An upload, queued under the hash of bytes already held beside the working
/// copy. The hash rides in the payload beside its own column, as a tag's
/// does, and the MIME type is what the drain sends the bytes under.
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

/// What a fault on a follow's thread said, as the refusal it ends with.
fn fault_message(fault: &(dyn std::any::Any + Send)) -> String {
    let said = fault
        .downcast_ref::<&str>()
        .map(|said| (*said).to_string())
        .or_else(|| fault.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "no message".into());
    format!("the follow stopped on a fault in the core: {said}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unreachable_server(url: &str) -> Option<Server> {
        Some(Server {
            url: url.into(),
            key: "marfa_k1_test".into(),
        })
    }

    /// An edit records what it was made against only where it is based on
    /// the version the copy holds, since only then is the copy's row what it
    /// was made against; one based on a version read earlier records nothing
    /// and is never moved over a merge (`queue-and-verdicts.md` 42).
    #[test]
    fn an_edit_records_what_it_read_only_on_the_version_held() {
        let conn = store::open_in_memory().unwrap();
        let mut row = store::testing::note("row", "title", "held", "2026-01-01T00:00:00Z");
        row.version = 5;
        store::upsert_item(&conn, &row, None, &catalog::Indexing::default()).unwrap();
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

    #[test]
    fn reads_refuse_while_a_hydration_is_in_progress() {
        let core = Core::open_in_memory(None).unwrap();
        // A store that has never hydrated refuses rather than answering an
        // empty page, because the two read the same and only one of them is
        // a copy of anything.
        assert_eq!(
            core.list(&ListFilters::default(), Sort::default()),
            Err(CoreError::HydrationIncomplete)
        );
        assert_eq!(core.status().unwrap().hydration, Hydration::Never);
        {
            let conn = core.conn().unwrap();
            store::meta_set(&conn, store::META_EVENT_CURSOR, "10").unwrap();
            store::meta_set(&conn, store::META_SLICE_TYPES, "[\"core.note\"]").unwrap();
            store::meta_set(&conn, store::META_SLICE_TIER, "library").unwrap();
        }
        assert!(
            core.list(&ListFilters::default(), Sort::default())
                .unwrap()
                .is_empty()
        );
        {
            let conn = core.conn().unwrap();
            store::meta_set(&conn, store::META_HYDRATE_STATE, store::HYDRATE_IN_PROGRESS).unwrap();
        }
        assert_eq!(
            core.list(&ListFilters::default(), Sort::default()),
            Err(CoreError::HydrationIncomplete)
        );
        assert_eq!(
            core.search("x", &SearchFilters::default(), 5),
            Err(CoreError::HydrationIncomplete)
        );
        assert_eq!(core.status().unwrap().hydration, Hydration::InProgress);
        {
            let conn = core.conn().unwrap();
            store::meta_delete(&conn, store::META_HYDRATE_STATE).unwrap();
        }
        assert_eq!(core.status().unwrap().hydration, Hydration::Complete);
        // And the fourth value: catch-up deletes the cursor when the log has
        // aged past it, leaving the slice and the rows in place. A store in
        // that state has its reads refused, exactly as a store that never
        // hydrated does, and says a different thing about itself, because it
        // holds a copy and the other does not.
        {
            let conn = core.conn().unwrap();
            store::meta_delete(&conn, store::META_EVENT_CURSOR).unwrap();
        }
        assert_eq!(core.status().unwrap().hydration, Hydration::Expired);
        assert_eq!(
            core.list(&ListFilters::default(), Sort::default()),
            Err(CoreError::HydrationIncomplete)
        );
        // The witness for the word rather than for the refusal: with the
        // slice gone too, the same store is back to never having hydrated,
        // so `Expired` is a reading of what is there and not a flag the
        // aging set.
        {
            let conn = core.conn().unwrap();
            store::meta_delete(&conn, store::META_SLICE_TYPES).unwrap();
        }
        assert_eq!(core.status().unwrap().hydration, Hydration::Never);
    }

    #[test]
    fn server_calls_need_a_server_and_catch_up_needs_a_cursor() {
        let offline = Core::open_in_memory(None).unwrap();
        assert_eq!(
            offline.hydrate(&["core.note".into()], Tier::Library),
            Err(CoreError::NoServer)
        );
        assert_eq!(offline.catch_up(), Err(CoreError::NoServer));
        let fresh = Core::open_in_memory(unreachable_server("http://127.0.0.1:9")).unwrap();
        assert_eq!(fresh.catch_up(), Err(CoreError::NoCursor));
        assert!(matches!(
            fresh.hydrate(&[], Tier::Library),
            Err(CoreError::Invalid(_))
        ));
        assert!(matches!(
            fresh.hydrate(&["*".into()], Tier::Library),
            Err(CoreError::Invalid(_))
        ));
    }

    /// A thumbnail is read from the held row with no request, through the
    /// type that declares it or a parent that does, and the local index
    /// leaves its base64 out as the server's own index does.
    ///
    /// The copy is bound to a server that records every request, so "no
    /// request" is asserted against a transport the core could have used.
    #[test]
    fn a_thumbnail_is_read_from_the_held_row_and_never_searched() {
        use base64::Engine;
        let dir = tempfile::tempdir().unwrap();
        let server = scripted::Scripted::start();
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
        // A photo that carries none, and one whose image does not decode:
        // each is answered from the row, as the others are.
        let bare = create("acme.photo", serde_json::json!({ "title": "Bare" }));
        assert_eq!(core.thumbnail(&bare).unwrap(), None);
        let broken = create(
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
                .into_iter()
                .map(|hit| hit.item.id)
                .collect::<Vec<_>>()
        };
        // The witness: the same token in a body is found.
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
        // The witness: this copy does reach the server over that transport,
        // and the server records it.
        let _ = core.drain();
        assert!(
            server.asked() > 0,
            "the drain reached no server, so the silence above is the transport's"
        );
    }

    /// What the local index holds follows the catalog: a thumbnail the
    /// catalog learns after its rows were written leaves the index when it
    /// does, and a title field naming the thumbnail indexes nothing.
    #[test]
    fn a_thumbnail_leaves_the_index_when_the_catalog_learns_it() {
        let dir = tempfile::tempdir().unwrap();
        let core = Core::open(dir.path().join("core.sqlite"), None).unwrap();
        let photo = |thumbnail: bool, title_field: &str| {
            let mut wire = store::testing::wire_type("acme.photo", None, Some(title_field));
            if thumbnail {
                wire.rest.insert(
                    "fields".into(),
                    serde_json::json!({ "thumbnail": { "type": "thumbnail" } }),
                );
            }
            wire
        };
        {
            let conn = core.conn().unwrap();
            store::meta_set(&conn, store::META_EVENT_CURSOR, "10").unwrap();
            store::meta_set(&conn, store::META_SLICE_TYPES, "[\"acme.photo\"]").unwrap();
            store::meta_set(&conn, store::META_SLICE_TIER, "library").unwrap();
            store::replace_types(&conn, &[photo(false, "title")]).unwrap();
        }
        let id = core
            .create_item(&Draft {
                r#type: "acme.photo".into(),
                properties: serde_json::json!({
                    "title": "Holiday",
                    "thumbnail": "data:image/png;base64,iVBORw0KGgoA/unicornsXYZ",
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
                .into_iter()
                .map(|hit| hit.item.id)
                .collect::<Vec<_>>()
        };
        // The witness: before the catalog knows the field, the base64 is a
        // string property like any other, and found.
        assert_eq!(found("unicornsXYZ"), vec![id.clone()]);
        let adopt = |wire| {
            let conn = core.conn().unwrap();
            store::replace_types(&conn, &[wire]).unwrap();
        };
        adopt(photo(true, "title"));
        assert!(
            found("unicornsXYZ").is_empty(),
            "the catalog learned the thumbnail and the row's index entry still holds its base64"
        );
        assert_eq!(found("Holiday"), vec![id.clone()]);
        // The witness: a title field naming a property no thumbnail is
        // declared under indexes its base64 as the title it then is.
        adopt(photo(false, "thumbnail"));
        assert_eq!(found("unicornsXYZ"), vec![id.clone()]);
        adopt(photo(true, "thumbnail"));
        assert!(
            found("unicornsXYZ").is_empty(),
            "a title field naming the thumbnail put its base64 in the index"
        );
    }

    /// A value held under a property before its type declared it a thumbnail
    /// is not one, and reading it says which item it came from.
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
            store::meta_set(&conn, store::META_SLICE_TYPES, "[\"acme.photo\"]").unwrap();
            store::meta_set(&conn, store::META_SLICE_TIER, "library").unwrap();
            store::replace_types(&conn, &[photo]).unwrap();
        }
        let id = core
            .create_item(&Draft {
                r#type: "acme.photo".into(),
                properties: serde_json::json!({ "title": "Old", "thumbnail": "hello" })
                    .as_object()
                    .unwrap()
                    .clone(),
                ..Default::default()
            })
            .unwrap()
            .item_id
            .unwrap();
        match core.thumbnail(&id) {
            Err(CoreError::Decoding(reason)) => assert!(reason.starts_with(&id), "{reason}"),
            other => panic!("an unreadable thumbnail read as {other:?}"),
        }
    }

    /// A value under the thumbnail property that is not text is not a
    /// thumbnail either, and is refused as one rather than read as an item
    /// carrying none. Null is the one value that is none.
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
            store::meta_set(&conn, store::META_SLICE_TYPES, "[\"acme.photo\"]").unwrap();
            store::meta_set(&conn, store::META_SLICE_TIER, "library").unwrap();
            store::replace_types(&conn, &[photo]).unwrap();
        }
        let holding = |value: Value| {
            core.create_item(&Draft {
                r#type: "acme.photo".into(),
                properties: serde_json::json!({ "title": "Held", "thumbnail": value })
                    .as_object()
                    .unwrap()
                    .clone(),
                ..Default::default()
            })
            .unwrap()
            .item_id
            .unwrap()
        };
        // The witness: null reads as no thumbnail.
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

    /// A second opener is refused at the doors, not merely by the predicate.
    ///
    /// `lock.rs` asserts that `refuse_unless_writer` returns the refusal,
    /// which is the guard's configuration. This asserts its effect, in two
    /// halves. Every door listed refuses a reading handle with
    /// `ReadingHandle`, so deleting the call from any of them reddens it.
    /// And every function in the crate's sources that calls the guard is
    /// either listed or one of the helpers whose callers are, so a door that
    /// calls the guard itself and is left off the list reddens it too. The
    /// queue and the items are compared before and after, so a door whose
    /// guard comes after its write reddens it as well. A new door reaching
    /// the guard only through a helper is the one case none of it sees.
    #[test]
    fn a_reading_handle_is_refused_at_every_write_door() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("core.sqlite");

        let writer = Core::open(&path, None).unwrap();
        {
            // Hydrated by hand, because the refusal must be the handle rather
            // than the slice: an unhydrated store refuses every write anyway,
            // and a case that leaned on that would pass with no lock at all.
            let conn = writer.conn().unwrap();
            store::meta_set(&conn, store::META_EVENT_CURSOR, "10").unwrap();
            store::meta_set(&conn, store::META_SLICE_TYPES, "[\"core.note\"]").unwrap();
            store::meta_set(&conn, store::META_SLICE_TIER, "library").unwrap();
            store::replace_types(
                &conn,
                &[store::testing::wire_type("core.note", None, Some("title"))],
            )
            .unwrap();
        }

        // Something for a door that ran before its guard to change: a row
        // answered, one blocked and one dead, which forgetting and the
        // releases would clear, and the queue and the items as they stand.
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
        // **Every door, not the two that are easy to reach.** The comment
        // above claims the guard is consulted by all of them, and a test
        // covering two of them proves it for two: the call could go missing
        // from any of the others with nothing red.
        let refusals: Vec<(&str, CoreError)> = vec![
            ("create_item", reader.create_item(&draft).unwrap_err()),
            ("update_item", reader.update_item("x", &edit).unwrap_err()),
            (
                "update_item_as_read",
                reader.update_item_as_read("x", &edit).unwrap_err(),
            ),
            ("delete_item", reader.delete_item("x").unwrap_err()),
            ("restore_item", reader.restore_item("x").unwrap_err()),
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
                "write_metadata",
                reader
                    .write_metadata("x", &MetadataWrite::default(), true)
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
            // A drain writes verdicts and adopts rows, so it is a write door
            // like the rest. It refuses at the handle before it reaches the
            // missing server, which is why this is a `ReadingHandle` and not
            // a `NoServer`.
            ("drain", reader.drain().unwrap_err()),
            // Clearing answered rows is a write to the queue like any
            // other.
            ("forget_answered", reader.forget_answered().unwrap_err()),
            // Refused before the file is read, so a reader copies nothing in.
            (
                "put_blob",
                reader
                    .put_blob(Path::new("no-such-file.png"), None)
                    .unwrap_err(),
            ),
            (
                "attach",
                reader
                    .attach("x", Path::new("no-such-file.png"), &Attachment::default())
                    .unwrap_err(),
            ),
            // The two a folder queues a file through.
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
            // The four that write the copy from the server's side. Each is
            // refused at the handle before it reaches the missing server.
            (
                "hydrate",
                reader
                    .hydrate(&["core.note".into()], Tier::Library)
                    .unwrap_err(),
            ),
            (
                "hydrate_with",
                reader
                    .hydrate_with(&["core.note".into()], Tier::Library, &["parent-of".into()])
                    .unwrap_err(),
            ),
            (
                "hydrate_every_type_or",
                reader
                    .hydrate_every_type_or(&[], Tier::Library, &[])
                    .unwrap_err(),
            ),
            ("catch_up", reader.catch_up().unwrap_err()),
            // A pin reads a row into the copy and an unpin can take one out.
            ("pin", reader.pin("x").unwrap_err()),
            ("unpin", reader.unpin("x").unwrap_err()),
            (
                "follow",
                reader
                    .follow(&std::sync::atomic::AtomicBool::new(true), |_| {})
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
            30,
            "an entry has gone from the list above, and a door dropped from \
             it is a door nothing here covers"
        );

        // The functions that call the guard themselves, read from the
        // source. A helper is covered by the doors that reach it, which are
        // listed above.
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
            (include_str!("folder/mod.rs"), others),
            (include_str!("folder/document.rs"), others),
            (include_str!("folder/identity.rs"), others),
            (include_str!("folder/settings.rs"), others),
            (include_str!("folder/state.rs"), others),
            (
                include_str!("lib.rs"),
                &[
                    "transition_locally",
                    "tag_write",
                    "extension_write",
                    "with_upload",
                ][..],
            ),
            // `drain::drain`, which `Core::drain` reaches.
            (include_str!("drain.rs"), &["drain"][..]),
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
        // The witness that the scan reads the doors at all.
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

        // The control: the writer is not refused, so the refusals above are
        // the handle rather than a store that refuses everybody.
        let queued = writer.create_item(&draft).unwrap();
        assert_eq!(queued.kind, WriteKind::CreateItem);

        // And a reading handle still reads, which is the whole point of it
        // being a handle rather than a refusal to open.
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
        // The witness: the dead row is one a release takes, by its id.
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

    /// Bytes held beside the working copy are answered with no server at
    /// all, and bytes not held are absent rather than a missing server.
    #[test]
    fn with_no_server_held_bytes_are_answered_and_the_rest_are_absent() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("core.sqlite");
        let core = Core::open(&path, None).unwrap();
        let file = dir.path().join("note.txt");
        std::fs::write(&file, b"held here").unwrap();
        let hash = core.cache().unwrap().take(&file).unwrap();
        let held = core.blob(&hash).unwrap();
        assert_eq!(std::fs::read(held).unwrap(), b"held here");
        let other = blob::name_of(b"never held");
        assert!(matches!(
            core.blob(&other),
            Err(CoreError::BytesAbsent { hash, .. }) if hash == other
        ));
    }

    /// The type catalog a follow asks for on every stream is written only
    /// where it changed, so a reader told of each save is not told of a
    /// catalog nobody changed.
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
        // The server's order is not the store's, and the same catalog in
        // another order is the same catalog.
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
        // The witness: a catalog that differs is written.
        replace(&[store::testing::wire_type("core.note", None, Some("body"))]);
        assert_ne!(reader.data_version().unwrap(), before);
    }

    /// Two streams on one handle would each move the one cursor.
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
            store::meta_set(&conn, store::META_SLICE_TYPES, "[\"core.note\"]").unwrap();
            store::meta_set(&conn, store::META_SLICE_TIER, "library").unwrap();
        }
        let stop = AtomicBool::new(false);
        std::thread::scope(|scope| {
            let following = scope.spawn(|| core.follow(&stop, |_| {}));
            std::thread::sleep(Duration::from_millis(300));
            let second = core.catch_up();
            let hydrating = core.hydrate(&["core.note".into()], Tier::Library);
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
            // The witness: the follow was running, asking for a stream.
            assert!(report.failed_opens >= 1, "{report:?}");
        });
        // And once it ended, the handle takes the next one.
        assert!(!matches!(core.catch_up(), Err(CoreError::Invalid(_))));
    }

    /// A hydration holds the claim for as long as it runs, so no follow or
    /// catch-up moves the cursor under it.
    #[test]
    fn no_stream_runs_across_a_hydration() {
        let server = scripted::Scripted::start();
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
            store::meta_set(&conn, store::META_SLICE_TYPES, "[\"core.note\"]").unwrap();
            store::meta_set(&conn, store::META_SLICE_TIER, "library").unwrap();
        }
        std::thread::scope(|scope| {
            let hydrating = scope.spawn(|| core.hydrate(&["core.note".into()], Tier::Library));
            // The witness: the hydration is under way.
            server.wait_for("/events", 1, Duration::from_secs(5));
            let caught = core.catch_up();
            let followed = core.follow(&AtomicBool::new(false), |_| {});
            for (what, refused) in [("catch-up", caught.err()), ("follow", followed.err())] {
                assert!(
                    matches!(&refused, Some(CoreError::Invalid(message)) if message.contains("already")),
                    "a {what} ran across a hydration: {refused:?}"
                );
            }
            drop(server);
            assert!(hydrating.join().unwrap().is_err());
        });
        // And once it ended, the handle takes the next one.
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
        // The witness: the same open once a writer has made the store.
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

    /// A reading open says what is wrong with a file it cannot read, and
    /// hands on what it cannot name.
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

        // An error it has no name for is handed on as the store's own.
        let odd = made("odd.sqlite", "CREATE TABLE meta (key TEXT);");
        assert!(
            matches!(refusal(&odd), CoreError::Store(message) if message.contains("no such column")),
            "an error the reading open cannot name was called something it is not"
        );

        // A store another build made, or one that never said which it is.
        let meta = "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);";
        let older = made(
            "older.sqlite",
            &format!("{meta} INSERT INTO meta VALUES ('schema_version', '1');"),
        );
        let unversioned = made("unversioned.sqlite", meta);
        for (path, found) in [(&older, "1"), (&unversioned, "none")] {
            assert_eq!(
                refusal(path),
                CoreError::WrongSchema {
                    expected: store::SCHEMA_VERSION.into(),
                    found: found.into(),
                    path: path.display().to_string(),
                }
            );
        }
        // The witness: a store this build made opens.
        drop(Core::open(at("store.sqlite"), None).unwrap());
        assert!(Core::open_reader(at("store.sqlite")).is_ok());
    }

    /// A reading open answers bytes held beside the store and fetches none,
    /// and says that is why.
    #[test]
    fn a_reading_open_answers_held_bytes_and_says_why_it_fetches_no_others() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("core.sqlite");
        let writer = Core::open(&path, None).unwrap();
        let file = dir.path().join("note.txt");
        std::fs::write(&file, b"held here").unwrap();
        let hash = writer.cache().unwrap().take(&file).unwrap();

        let reader = Core::open_reader(&path).unwrap();
        let held = reader.blob(&hash).unwrap();
        assert_eq!(std::fs::read(held).unwrap(), b"held here");
        let other = blob::name_of(b"never held");
        let reason = |core: &Core| match core.blob(&other) {
            Err(CoreError::BytesAbsent { reason, .. }) => reason,
            answer => panic!("{answer:?}"),
        };
        assert!(reason(&reader).contains("reading handle"));
        // The witness: the writer, with no server either, says otherwise.
        assert!(!reason(&writer).contains("reading handle"));
    }

    /// Claims made at the same instant: one wins, and the rest are refused
    /// until it lets go.
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
                        if let Ok(claim) = core.claim_stream() {
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
        // The witness: claims were won.
        assert!(won.load(Ordering::SeqCst) >= 300);
        assert!(
            !overlapped.load(Ordering::SeqCst),
            "two claims were held at once, so two streams could move one cursor"
        );
    }

    #[test]
    fn a_file_bound_to_one_server_refuses_another() {
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
            Core::open(&path, unreachable_server("http://two.test:8600")).err(),
            Some(CoreError::WrongServer {
                expected: "http://one.test:8600".into(),
                got: "http://two.test:8600".into()
            })
        );
    }
}
