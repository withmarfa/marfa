//! A local, read-only working copy of a declared slice of one Marfa server:
//! hydrated over HTTP, kept current from the event log, queried locally.

mod catalog;
mod catch_up;
mod drain;
mod error;
pub mod folder;
mod http;
mod hydrate;
mod lock;
mod model;
mod query;
mod search;
mod sse;
mod store;
mod wire;

use std::path::Path;
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use rusqlite::Connection;

pub use drain::{DrainReport, DrainVerdict};
pub use error::CoreError;
pub use folder::{Folder, ScanReport, Slice};
pub use lock::Handle;
pub use model::{
    CatchUpReport, Draft, Edge, EdgeDraft, EdgeEdit, Edit, HydrateReport, Hydration, Item,
    ItemState, ListFilters, MetadataWrite, QueuedWrite, SearchFilters, SearchHit, Sort,
    SortDirection, SortField, Status, Tier,
};
pub use store::{BLOCKED_REASONS, CEILING, VERDICTS, WRITE_KINDS};

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
    catch_up_idle: Duration,
    /// Held for as long as the `Core` lives, which is what makes it the
    /// claim rather than a record of one (`device.md` 3).
    lock: lock::WriterLock,
}

const DEFAULT_CATCH_UP_IDLE: Duration = Duration::from_secs(3);

impl Core {
    /// Opens the file at `path`, creating it and its schema when absent. A
    /// file bound to a different server than `server` is refused.
    pub fn open(path: impl AsRef<Path>, server: Option<Server>) -> Result<Core> {
        let path = path.as_ref();
        // Claimed before the store is opened. A second opener that read the
        // store first would have done so as a writer for as long as it took
        // to find out it was not one.
        let lock = lock::WriterLock::claim(Some(path))?;
        Self::from_connection(store::open(path)?, server, lock)
    }

    pub fn open_in_memory(server: Option<Server>) -> Result<Core> {
        let lock = lock::WriterLock::claim(None)?;
        Self::from_connection(store::open_in_memory()?, server, lock)
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
            catch_up_idle: DEFAULT_CATCH_UP_IDLE,
            lock,
        })
    }

    /// Replaces the local copy with every item of the declared `types` at
    /// `tier`, with their tags and outbound edges, and stores the event
    /// cursor to catch up from.
    pub fn hydrate(&self, types: &[String], tier: Tier) -> Result<HydrateReport> {
        hydrate::hydrate(self, self.http()?, types, tier)
    }

    /// Applies every event since the stored cursor and advances it.
    pub fn catch_up(&self) -> Result<CatchUpReport> {
        catch_up::catch_up(self, self.http()?, self.catch_up_idle)
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

    /// Full-text search over titles, bodies and tags, best match first.
    pub fn search(
        &self,
        query: &str,
        filters: &SearchFilters,
        limit: usize,
    ) -> Result<Vec<SearchHit>> {
        let conn = self.conn()?;
        store::refuse_unless_hydrated(&conn)?;
        search::search(&conn, query, filters, limit)
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
        // missing server tells it the wrong thing about why it may not
        // write — which is what the argument order used to do.
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
    pub fn release_reason(&self, reason: &str) -> Result<usize> {
        self.lock.refuse_unless_writer()?;
        let conn = self.conn()?;
        let ids: Vec<String> = store::queued_writes(&conn)?
            .into_iter()
            .filter(|row| {
                matches!(row.verdict.as_deref(), Some("blocked") | Some("dead"))
                    && row.reason.as_deref() == Some(reason)
            })
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

    /// Queues a create, and holds the row locally until it is answered.
    ///
    /// The id is minted here rather than left to the server, because a row a
    /// caller has been told was queued has to be readable locally before
    /// anyone has answered for it (`queue-and-verdicts.md` 31), and a row
    /// with no id cannot be read by one.
    ///
    /// The version is optional on a create and carried when given
    /// (`queue-and-verdicts.md` 2): where the natural key resolves a live
    /// row the server answers it exactly as it answers an update.
    pub fn create_item(&self, draft: &Draft) -> Result<QueuedWrite> {
        self.lock.refuse_unless_writer()?;
        let mut conn = self.conn()?;
        store::refuse_unless_hydrated(&conn)?;
        let catalog = catalog::Catalog::load(&conn)?;
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
        let tx = conn.transaction()?;
        // The row lands locally and the write is queued in one transaction.
        // Either would be wrong alone: a queued write with no local row is a
        // change a caller cannot see, and a local row with no queued write is
        // a change the server will never hear about.
        store::upsert_item(
            &tx,
            &draft.wire(&id),
            Some(&draft.tags),
            catalog.title_field(&draft.r#type),
        )?;
        let queued = store::enqueue(
            &tx,
            &store::NewWrite {
                kind: "create_item",
                item_id: Some(&id),
                target_id: None,
                edge_id: None,
                namespace: None,
                tag: None,
                base_version: draft.base_version,
                payload: &payload,
                depends_on: &[],
            },
        )?;
        // One write per tag, each waiting on the create
        // (`queue-and-verdicts.md` 33, `device.md` 22). Queued in the same
        // transaction as the create: a create that landed with its tags
        // queued separately and then failed to queue them would be a create
        // that dropped what it was asked for, which is exactly what 22
        // forbids.
        for tag in &draft.tags {
            let body = serde_json::to_string(&serde_json::json!({ "tags": [tag] }))?;
            store::enqueue(
                &tx,
                &store::NewWrite {
                    kind: "add_tag",
                    item_id: Some(&id),
                    target_id: None,
                    edge_id: None,
                    namespace: None,
                    tag: Some(tag),
                    base_version: None,
                    payload: &body,
                    depends_on: std::slice::from_ref(&queued.id),
                },
            )?;
        }
        tx.commit()?;
        Ok(queued)
    }

    /// Queues an update, and applies it to the working copy.
    ///
    /// **The version is required** (`queue-and-verdicts.md` 2). An update
    /// with none is refused here rather than sent, because a version-less
    /// update is a write that overwrites whatever it finds — which is the
    /// defect the folder rules were written against.
    ///
    /// The fields are the caller's, whole (`queue-and-verdicts.md` 34). A
    /// device does not merge inside a field and does not assume the server
    /// will, so what it sends is what it was handed.
    pub fn update_item(&self, id: &str, edit: &Edit) -> Result<QueuedWrite> {
        self.lock.refuse_unless_writer()?;
        let mut conn = self.conn()?;
        store::refuse_unless_hydrated(&conn)?;

        let Some(held) = store::item_by_id(&conn, id)? else {
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
        // The version the caller read, against the row as it stands. A
        // caller editing a row the copy has since replaced is editing
        // something they have not seen, and sending it would be a write
        // based on a version that was never theirs.
        if base != held.version {
            return Err(CoreError::Invalid(format!(
                "the update to {id} is based on version {base} and this copy holds version {}; read it again",
                held.version
            )));
        }

        let catalog = catalog::Catalog::load(&conn)?;
        let payload = edit.payload(base)?;
        let mut next = held.clone();
        for (key, value) in &edit.properties {
            next.properties.insert(key.clone(), value.clone());
        }
        next.updated_at = store::now_iso();

        let tx = conn.transaction()?;
        store::upsert_item(
            &tx,
            &next.as_wire(),
            None,
            catalog.title_field(&next.r#type),
        )?;
        let queued = store::enqueue(
            &tx,
            &store::NewWrite {
                kind: "update_item",
                item_id: Some(id),
                target_id: None,
                edge_id: None,
                namespace: None,
                tag: None,
                base_version: Some(base),
                payload: &payload,
                // The create and nothing else (`queue-and-verdicts.md` 4).
                // A write held for every unanswered row is a write a
                // refused tag can refuse, and statement 16 is about a row
                // the server never accepted — not about a sibling write
                // that failed for its own reasons. The queue drains in
                // order, so ordering needs no dependency to hold it.
                depends_on: &store::unanswered_creates_for_item(&tx, id)?,
            },
        )?;
        tx.commit()?;
        Ok(queued)
    }

    /// Queues a delete, and moves the row to the bin locally.
    ///
    /// Not a purge (`device.md` 25). The row stays in the copy under the
    /// state the server would give it, so a caller reading it sees what the
    /// server will hold rather than a row that has already vanished.
    pub fn delete_item(&self, id: &str) -> Result<QueuedWrite> {
        self.transition_locally(id, "delete_item", ItemState::Trashed, "{}")
    }

    /// Queues a restore, and takes the row out of the bin locally.
    pub fn restore_item(&self, id: &str) -> Result<QueuedWrite> {
        self.transition_locally(id, "restore_item", ItemState::Active, "{}")
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
        self.transition_locally(id, "transition_item", state, &payload)
    }

    /// The three item writes that move a row's state and leave its fields
    /// and its version alone.
    fn transition_locally(
        &self,
        id: &str,
        kind: &str,
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
                base_version: None,
                payload,
                depends_on: &depends_on,
            },
        )?;
        tx.commit()?;
        Ok(queued)
    }

    /// Queues an edge, and holds it locally until it is answered.
    ///
    /// It waits for both of its endpoints (`queue-and-verdicts.md` 4): an
    /// edge naming a row whose create has not landed is an edge the server
    /// has nowhere to put, and either end can be the one that has not.
    pub fn create_edge(&self, draft: &EdgeDraft) -> Result<QueuedWrite> {
        self.lock.refuse_unless_writer()?;
        let mut conn = self.conn()?;
        store::refuse_unless_hydrated(&conn)?;
        let id = draft
            .id
            .clone()
            .unwrap_or_else(|| uuid::Uuid::now_v7().to_string());
        let payload = draft.payload(&id)?;
        // Both endpoints' creates: an edge naming a row whose create has
        // not landed is an edge the server has nowhere to put, and either
        // end can be the one that has not.
        let mut depends_on: Vec<String> = Vec::new();
        for endpoint in [&draft.source_id, &draft.target_id] {
            for id in store::unanswered_creates_for_item(&conn, endpoint)? {
                if !depends_on.contains(&id) {
                    depends_on.push(id);
                }
            }
        }
        let tx = conn.transaction()?;
        store::upsert_edge(&tx, &draft.wire(&id))?;
        let queued = store::enqueue(
            &tx,
            &store::NewWrite {
                kind: "create_edge",
                item_id: Some(&draft.source_id),
                target_id: Some(&draft.target_id),
                edge_id: Some(&id),
                namespace: None,
                tag: None,
                base_version: None,
                payload: &payload,
                depends_on: &depends_on,
            },
        )?;
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
        let tx = conn.transaction()?;
        store::upsert_edge(&tx, &next.as_wire())?;
        let queued = store::enqueue(
            &tx,
            &store::NewWrite {
                kind: "update_edge",
                item_id: Some(&held.source_id),
                target_id: Some(&held.target_id),
                edge_id: Some(id),
                namespace: None,
                tag: None,
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
        let tx = conn.transaction()?;
        store::delete_edge(&tx, id)?;
        let queued = store::enqueue(
            &tx,
            &store::NewWrite {
                kind: "delete_edge",
                item_id: Some(&held.source_id),
                target_id: Some(&held.target_id),
                edge_id: Some(id),
                namespace: None,
                tag: None,
                base_version: None,
                payload: "{}",
                depends_on: &depends_on,
            },
        )?;
        tx.commit()?;
        Ok(queued)
    }

    /// Queues one tag onto a row, as its own write.
    pub fn add_tag(&self, id: &str, tag: &str) -> Result<QueuedWrite> {
        let payload = serde_json::to_string(&serde_json::json!({ "tags": [tag] }))?;
        self.tag_write(id, "add_tag", Some(tag), &payload, |tx| {
            store::add_tags(tx, id, std::slice::from_ref(&tag.to_string()))
        })
    }

    /// Queues the removal of one tag, as its own write.
    pub fn remove_tag(&self, id: &str, tag: &str) -> Result<QueuedWrite> {
        self.tag_write(id, "remove_tag", Some(tag), "{}", |tx| {
            store::remove_tag(tx, id, tag)
        })
    }

    /// The writes that change what a row is tagged with: one tag at a time,
    /// or the set whole.
    fn tag_write(
        &self,
        id: &str,
        kind: &str,
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
            "replace_metadata"
        } else {
            "merge_metadata"
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
        self.extension_write(id, namespace, "write_extension", body)
    }

    /// Queues the removal of one extension namespace.
    pub fn delete_extension(&self, id: &str, namespace: &str) -> Result<QueuedWrite> {
        self.extension_write(id, namespace, "delete_extension", "{}")
    }

    fn extension_write(
        &self,
        id: &str,
        namespace: &str,
        kind: &str,
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
                base_version: None,
                payload,
                depends_on: &depends_on,
            },
        )?;
        tx.commit()?;
        Ok(queued)
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
        // **Every door, not the two that were easy to reach.** The comment
        // above claims the guard is consulted by all of them, and a test
        // covering two of fifteen proves that for two: delete the call from
        // any of the other thirteen and nothing was red.
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
                reader.release_reason("key_spent").unwrap_err(),
            ),
            // A drain writes verdicts and adopts rows, so it is a write door
            // like the rest. It refuses at the handle before it reaches the
            // missing server, which is why this is a `ReadingHandle` and not
            // a `NoServer`.
            ("drain", reader.drain().unwrap_err()),
        ];
        for (door, refusal) in &refusals {
            assert_eq!(
                refusal,
                &CoreError::ReadingHandle,
                "the {door} door let a second opener through, so two processes \
                 queue into one file and neither sees the other's rows"
            );
        }
        // A plain count, deliberately. There is no expression in Rust that
        // enumerates the methods calling a guard, so this is a tripwire
        // rather than a derivation: a door added to `Core` and not listed
        // above is a door nothing here covers, and this is what says so.
        assert_eq!(
            refusals.len(),
            16,
            "the write surface has changed. Every method on `Core` that calls \
             `refuse_unless_writer` belongs in the list above, and this count \
             is what notices when one does not."
        );

        // The control: the writer is not refused, so the two above are the
        // handle rather than a store that refuses everybody.
        let queued = writer.create_item(&draft).unwrap();
        assert_eq!(queued.kind, "create_item");

        // And a reading handle still reads, which is the whole point of it
        // being a handle rather than a refusal to open.
        assert!(
            reader
                .list(&ListFilters::default(), Sort::default())
                .is_ok()
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
