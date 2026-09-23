//! A local working copy of a declared slice of one Marfa server: hydrated
//! over HTTP, kept current from the event log, read locally, and written to
//! through a queue that holds every write until the server answers it.

mod blob;
mod catalog;
mod catch_up;
mod drain;
mod error;
pub mod folder;
/// The working copy's transport, public for the call shapes it shares with
/// the binary's own transport.
pub mod http;
mod hydrate;
mod lock;
mod model;
mod query;
mod search;
mod sse;
mod store;
mod wire;

use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use rusqlite::Connection;
use serde_json::Value;

pub use blob::{file_type_for, mime_type_for};
pub use catch_up::{Change, FollowReport};
pub use drain::{DrainReport, DrainVerdict};
pub use error::CoreError;
pub use folder::{Folder, PullReport, ScanReport, Slice};
pub use lock::Handle;
pub use model::{
    Attached, Attachment, BlockedReason, CatchUpReport, Draft, Edge, EdgeDraft, EdgeEdit, Edit,
    HydrateReport, Hydration, Item, ItemState, ListFilters, MetadataWrite, Outcome, QueuedWrite,
    SearchFilters, SearchHit, Sort, SortDirection, SortField, Status, Tier, Verdict, WriteKind,
};
pub use store::CEILING;

pub type Result<T> = std::result::Result<T, CoreError>;

/// Where the slice comes from. The key is held in memory and never written.
#[derive(Debug, Clone)]
pub struct Server {
    pub url: String,
    pub key: String,
}

pub struct Core {
    conn: Mutex<Connection>,
    http: Option<http::Http>,
    /// Where blobs' bytes are held: beside the working copy's file, and nowhere for a
    /// store held in memory.
    cache: Option<blob::Cache>,
    catch_up_idle: Duration,
    /// Held for as long as the `Core` lives, which is what makes it the
    /// claim rather than a record of one (`device.md` 3).
    lock: lock::WriterLock,
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
    /// (`device.md` 40).
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
            Some(server) => Some(http::Http::new(&server.url, &server.key)?),
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
        })
    }

    /// Replaces the local copy with every item of the declared `types` at
    /// `tier`, with their tags and outbound edges, and stores the event
    /// cursor to catch up from.
    pub fn hydrate(&self, types: &[String], tier: Tier) -> Result<HydrateReport> {
        // A hydration replaces the copy, which is a write to the store like
        // any other (`device.md` 26).
        self.lock.refuse_unless_writer()?;
        hydrate::hydrate(self, self.http()?, types, tier)
    }

    /// Applies every event since the stored cursor and advances it.
    pub fn catch_up(&self) -> Result<CatchUpReport> {
        self.lock.refuse_unless_writer()?;
        catch_up::catch_up(self, self.http()?, self.catch_up_idle)
    }

    /// Holds the event stream open and applies each event as it arrives,
    /// telling `on_change` of each one that changed the copy, until `stop` is
    /// set (`device.md` 39).
    ///
    /// `on_change` is called with no lock on the store held, so it may read
    /// the row it is told about.
    pub fn follow(
        &self,
        stop: &AtomicBool,
        mut on_change: impl FnMut(&Change),
    ) -> Result<FollowReport> {
        self.lock.refuse_unless_writer()?;
        catch_up::follow(self, self.http()?, stop, &mut on_change)
    }

    /// A number that moves each time another process saves to this store:
    /// a reader polls it and reads again when it moves (`device.md` 40).
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

    pub fn edges_from(&self, id: &str) -> Result<Vec<Edge>> {
        let conn = self.conn()?;
        store::refuse_unless_hydrated(&conn)?;
        store::edges_from(&conn, id)
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
    /// uncounted for the next pass (`queue-and-verdicts.md` 17).
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
        let queued = queue_update(&tx, &catalog, id, edit, &[])?;
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
        let depends_on = store::unanswered_creates_for_item(&conn, id)?;
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

    /// Queues a change to an edge's properties. The version is required, for
    /// the reason an item's is.
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
        let depends_on = store::unanswered_for_edge(&conn, id)?;
        let mut next = held.clone();
        for (key, value) in &edit.properties {
            next.properties.insert(key.clone(), value.clone());
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
        let Some(held) = store::edge_by_id(&conn, id)? else {
            return Err(CoreError::NotFound {
                code: "edge_not_found".into(),
                message: format!("{id} is not an edge this copy holds"),
            });
        };
        let depends_on = store::unanswered_for_edge(&conn, id)?;
        // **The type travels with the write.** Reconciling a refused delete
        // means reading the server's edges for this source, and that read is
        // by type — but the local row is gone by then, because a delete
        // empties the copy at queue time. The one moment the type is knowable
        // is this one, before the delete.
        //
        // It rides in the payload, which is the body the drain sends, so the
        // field does go out on a `DELETE /edges/{id}` that declares no body.
        // The door ignores it. A field the device needs and the door does not
        // read is the cost of keeping it beside the write rather than in a
        // column of its own.
        let payload = serde_json::json!({ "edge_type": held.edge_type }).to_string();
        let tx = conn.transaction()?;
        store::delete_edge(&tx, id)?;
        let queued = store::enqueue(
            &tx,
            &store::NewWrite {
                kind: WriteKind::DeleteEdge,
                item_id: Some(&held.source_id),
                target_id: Some(&held.target_id),
                edge_id: Some(id),
                namespace: None,
                tag: None,
                blob: None,
                base_version: None,
                payload: &payload,
                depends_on: &depends_on,
            },
        )?;
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
        let depends_on = store::unanswered_creates_for_item(&conn, id)?;
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
        let depends_on = store::unanswered_creates_for_item(&conn, id)?;
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
    ) -> Result<QueuedWrite> {
        let mime_type = blob::mime_type_for(path, None);
        self.with_upload(path, &mime_type, |tx, catalog, upload, hash| {
            let mut edit = edit.clone();
            name_bytes(&mut edit.properties, hash, &mime_type);
            queue_update(tx, catalog, id, &edit, std::slice::from_ref(&upload.id))
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
        let Some(http) = self.http.as_ref() else {
            return Err(CoreError::BytesAbsent {
                hash,
                reason: "this working copy was opened with no server to fetch them from".into(),
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
            event_cursor,
            hydration,
            items: store::count(&conn, "items")?,
            edges: store::count(&conn, "edges")?,
        })
    }

    fn http(&self) -> Result<&http::Http> {
        self.http.as_ref().ok_or(CoreError::NoServer)
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
/// cannot be read by one.
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
        catalog.title_field(&draft.r#type),
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

/// An update, applied to the copy and queued in the caller's transaction,
/// waiting on `after` as well as on the row's own unanswered create.
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
    // The version the caller read, against the row as it stands. A caller
    // editing a row the copy has since replaced is editing something they
    // have not seen, and sending it would be a write based on a version that
    // was never theirs.
    if base != held.version {
        return Err(CoreError::Invalid(format!(
            "the update to {id} is based on version {base} and this copy holds version {}; read it again",
            held.version
        )));
    }
    let payload = edit.payload(base)?;
    let mut next = held.clone();
    for (key, value) in &edit.properties {
        next.properties.insert(key.clone(), value.clone());
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
    next.updated_at = store::now_iso();
    store::upsert_item(tx, &next.as_wire(), None, catalog.title_field(&next.r#type))?;
    // The create and nothing else (`queue-and-verdicts.md` 4), besides what
    // the caller names. A write held for every unanswered row is a write a
    // refused tag can refuse, and statement 16 is about a row the server
    // never accepted, not about a sibling write that failed for its own
    // reasons. The queue drains in order, so ordering needs no dependency
    // to hold it.
    let mut depends_on = store::unanswered_creates_for_item(tx, id)?;
    for waited in after {
        if !depends_on.contains(waited) {
            depends_on.push(waited.clone());
        }
    }
    store::enqueue(
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
    )
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
        for id in store::unanswered_creates_for_item(tx, endpoint)? {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn unreachable_server(url: &str) -> Option<Server> {
        Some(Server {
            url: url.into(),
            key: "marfa_k1_test".into(),
        })
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

    /// A second opener is refused at the doors, not merely by the predicate.
    ///
    /// `lock.rs` asserts that `refuse_unless_writer` returns the refusal,
    /// which is the guard's configuration. This asserts its effect: that
    /// every write door calls it. Delete the call from `create_item` and the
    /// lock test still passes and this one does not, which is the difference
    /// between testing a guard and testing that the guard is consulted.
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
        // covering two of seventeen proves it for two: the call could go
        // missing from any of the other fifteen with nothing red.
        let refusals: Vec<(&str, CoreError)> = vec![
            ("create_item", reader.create_item(&draft).unwrap_err()),
            ("update_item", reader.update_item("x", &edit).unwrap_err()),
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
            ("release", reader.release("x").unwrap_err()),
            (
                "release_reason",
                reader.release_reason(BlockedReason::KeySpent).unwrap_err(),
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
            // The three that write the copy from the server's side. Each is
            // refused at the handle before it reaches the missing server.
            (
                "hydrate",
                reader
                    .hydrate(&["core.note".into()], Tier::Library)
                    .unwrap_err(),
            ),
            ("catch_up", reader.catch_up().unwrap_err()),
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
        // A plain count, deliberately, and it is worth being exact about
        // what it catches. There is no expression in Rust that enumerates
        // the methods calling a guard, so this is a tripwire rather than a
        // derivation, and it fires in one direction only: an entry removed
        // from the list above reddens it, a door added to `Core` and never
        // listed does not. The list is the coverage; this only keeps the
        // list from quietly shrinking.
        assert_eq!(
            refusals.len(),
            22,
            "an entry has gone from the list above. Every method on `Core` \
             that calls `refuse_unless_writer` belongs in it, and a door \
             dropped from it is a door nothing here covers."
        );

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
