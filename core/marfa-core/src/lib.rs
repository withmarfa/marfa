mod blob;
mod catalog;
mod catch_up;
pub mod contract;
mod drain;
mod error;
mod filter;
pub mod folder;
/// Public for the call shapes it shares with the binary's own transport.
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

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use rusqlite::Connection;
use serde_json::Value;

pub use blob::{file_type_for, mime_type_for};
pub use catalog::{EdgeType, End, ItemType, TypeField};
pub use catch_up::{Change, FollowReport};
pub use drain::{DrainReport, DrainVerdict};
pub use error::CoreError;
pub use folder::{
    Confirmed, Drained, FOLDER_TYPE, FileStatus, Folder, Paused, PullReport, Restored, ScanReport,
    Settings, SettingsFileReport, StatusReport,
};
pub use lock::Handle;
pub use model::{
    Added, Attached, Attachment, BlockedReason, CatchUpReport, Draft, Edge, EdgeDraft, EdgeEdit,
    Edit, FieldRefusal, GrantKind, GrantLevel, HydrateReport, Hydration, Item, ItemState,
    ListFilters, MetadataWrite, MissingGrant, Outcome, QueuedWrite, Refusal, SearchFilters,
    SearchHit, Sort, SortDirection, SortField, Status, Thumbnail, Tier, Verdict, WriteKind,
};
pub use store::CEILING;

pub type Result<T> = std::result::Result<T, CoreError>;

struct StreamClaim<'a>(&'a AtomicBool);

impl Drop for StreamClaim<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

/// The key is held in memory and never written.
#[derive(Debug, Clone)]
pub struct Server {
    pub url: String,
    pub key: String,
}

pub struct Core {
    conn: Mutex<Connection>,
    http: Option<Arc<http::Http>>,
    cache: Option<blob::Cache>,
    catch_up_idle: Duration,
    /// Held for as long as the `Core` lives: holding it is the claim.
    lock: lock::WriterLock,
    /// Hydration, catch-up and follow each move the one cursor, so two at
    /// once could move it backwards, apply an event twice, or apply one to a
    /// copy a hydration has replaced.
    streaming: AtomicBool,
}

const DEFAULT_CATCH_UP_IDLE: Duration = Duration::from_secs(3);

/// Well past any fetch or copy of a blob's bytes still running.
const INCOMING_GRACE: Duration = Duration::from_secs(3600);

impl Core {
    /// Creates the file when absent. A file bound to a different server is
    /// refused.
    pub fn open(path: impl AsRef<Path>, server: Option<Server>) -> Result<Core> {
        let path = path.as_ref();
        // Claimed before the store is opened: a second opener that read the
        // store first would act as a writer until it found out it was not.
        let lock = lock::WriterLock::claim(Some(path))?;
        let cache = blob::Cache::beside(path);
        if lock.handle() == Handle::Writer {
            cache.sweep_incoming(INCOMING_GRACE);
        }
        Self::from_connection(store::open(path)?, server, lock, Some(cache))
    }

    /// Never claims the writer role, so a helper started before the app
    /// cannot lock the app out of its own store, and refuses a path where no
    /// store has been made rather than making one. `data_version` is how it
    /// learns the writer saved.
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

    /// Refused while a catch-up or a follow runs on this handle: a follow
    /// left running across a hydration would apply events read against the
    /// old slice to the new copy. A caller stops its follow first.
    pub fn hydrate(&self, types: &[String], tier: Tier) -> Result<HydrateReport> {
        self.hydrate_with(types, tier, &[])
    }

    /// Holds every edge of `edge_types` the key reads, whichever ends the
    /// copy holds.
    pub fn hydrate_with(
        &self,
        types: &[String],
        tier: Tier,
        edge_types: &[String],
    ) -> Result<HydrateReport> {
        self.lock.refuse_unless_writer()?;
        let _streaming = self.claim_stream()?;
        hydrate::hydrate(self, self.http()?, types, tier, edge_types, false)
    }

    /// No types is every type the key reads, held as `store::EVERY_TYPE`.
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

    /// Refused where neither the server nor the copy holds `id`. Answers
    /// whether it was pinned already.
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

    /// A row the slice does not take leaves the copy, unless writes to it
    /// still wait. Answers whether it was pinned.
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

    pub fn catch_up(&self) -> Result<CatchUpReport> {
        self.lock.refuse_unless_writer()?;
        let _streaming = self.claim_stream()?;
        catch_up::catch_up(self, self.http()?, self.catch_up_idle)
    }

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
        // A binding says the follow ended when this returns: a fault that
        // unwound past here would end the thread silently, and a caller
        // waiting to be told would wait for good.
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            catch_up::follow(self, http, stop, &mut on_change)
        }))
        .unwrap_or_else(|fault| Err(CoreError::Invalid(fault_message(fault.as_ref()))))
    }

    /// Moves each time another process saves to this store.
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

    /// An item the copy does not hold is refused `NotFound`, never answered
    /// `None`. A held value that is not a data URI (one written before its
    /// type declared the property) is refused `Decoding`, naming the item.
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

    pub fn edges_to(&self, id: &str) -> Result<Vec<Edge>> {
        let conn = self.conn()?;
        store::refuse_unless_hydrated(&conn)?;
        store::edges_to(&conn, id)
    }

    /// Answered or still queued, oldest first.
    pub fn edges_of_type(&self, edge_type: &str) -> Result<Vec<Edge>> {
        let conn = self.conn()?;
        store::refuse_unless_hydrated(&conn)?;
        store::edges_of_type(&conn, edge_type)
    }

    /// Best match first.
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

    /// Answerable without a hydration, unlike the reads: a caller must be
    /// able to learn what is outstanding before it can hydrate.
    pub fn queue(&self) -> Result<Vec<QueuedWrite>> {
        let conn = self.conn()?;
        store::queued_writes(&conn)
    }

    /// One pass: every sendable row is attempted once.
    pub fn drain(&self) -> Result<DrainReport> {
        // The handle before the server, so a second opener with no server
        // is told the real reason it may not write.
        self.lock.refuse_unless_writer()?;
        drain::drain(self, self.http()?)
    }

    /// Under a fresh idempotency key. Answers `false` for a row that is not
    /// blocked or dead.
    pub fn release(&self, id: &str) -> Result<bool> {
        self.lock.refuse_unless_writer()?;
        let conn = self.conn()?;
        store::release(&conn, id)
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
        // One transaction: a release part-way through would leave some rows
        // on a fresh key and some on a spent one.
        tx.commit()?;
        Ok(released)
    }

    /// Answers `false` for any row not blocked `ancestor_unavailable` or
    /// `conflict_unresolved`. Everything it puts back is read from the server
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
        store::withdraw(&tx, &row, &held)?;
        // A row a follow brought while the reads were out is later than what
        // they read, and is kept.
        for read in &reads {
            drain::apply_read_back(&tx, read)?;
        }
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
        tx.commit()?;
        Ok(true)
    }

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

    /// The base may be a version earlier than the one held, which the server
    /// merges against, so another device's write that came in since is kept
    /// rather than overwritten.
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

    /// Not a purge: the row stays in the copy, trashed.
    pub fn delete_item(&self, id: &str) -> Result<QueuedWrite> {
        self.transition_locally(id, WriteKind::DeleteItem, ItemState::Trashed, "{}")
    }

    pub fn restore_item(&self, id: &str) -> Result<QueuedWrite> {
        self.transition_locally(id, WriteKind::RestoreItem, ItemState::Active, "{}")
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
        let mut conn = self.conn()?;
        store::refuse_unless_hydrated(&conn)?;
        if !store::item_held(&conn, id)? {
            return Err(CoreError::NotFound {
                code: "item_not_found".into(),
                message: format!("{id} is not a row this copy holds"),
            });
        }
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
                base_version: None,
                payload,
                depends_on: &depends_on,
            },
        )?;
        tx.commit()?;
        Ok(queued)
    }

    pub fn create_edge(&self, draft: &EdgeDraft) -> Result<QueuedWrite> {
        self.lock.refuse_unless_writer()?;
        let mut conn = self.conn()?;
        store::refuse_unless_hydrated(&conn)?;
        let tx = conn.transaction()?;
        let queued = queue_edge(&tx, draft)?;
        tx.commit()?;
        Ok(queued)
    }

    /// A move of an end goes in the same write as the properties, so the
    /// edge is never absent between two writes.
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
        Ok(queued)
    }

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

    pub fn add_tag(&self, id: &str, tag: &str) -> Result<QueuedWrite> {
        let payload = serde_json::to_string(&serde_json::json!({ "tags": [tag] }))?;
        self.tag_write(id, WriteKind::AddTag, Some(tag), &payload, |tx| {
            store::add_tags(tx, id, std::slice::from_ref(&tag.to_string()))
        })
    }

    pub fn remove_tag(&self, id: &str, tag: &str) -> Result<QueuedWrite> {
        self.tag_write(id, WriteKind::RemoveTag, Some(tag), "{}", |tx| {
            store::remove_tag(tx, id, tag)
        })
    }

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
        store::hold_beneath_item(&tx, id)?;
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

    /// Only the tags land locally; an extension namespace is not part of the
    /// copy and is its own write.
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
        self.tag_write(id, kind, None, &payload, |tx| {
            if replace {
                store::replace_tags(tx, id, &write.tags)
            } else {
                store::add_tags(tx, id, &write.tags)
            }
        })
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

    pub(crate) fn create_file_item(&self, path: &Path, draft: &Draft) -> Result<QueuedWrite> {
        self.refuse_unknown_type(&draft.r#type)?;
        let mime_type = blob::mime_type_for(path, None);
        self.with_upload(path, &mime_type, |tx, catalog, upload, hash| {
            let mut draft = draft.clone();
            name_bytes(&mut draft.properties, hash, &mime_type);
            queue_create(tx, catalog, &draft, std::slice::from_ref(&upload.id))
        })
    }

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

    /// Checked before any bytes are taken in, so a refused create leaves no
    /// bytes behind that nothing names.
    fn refuse_unknown_type(&self, r#type: &str) -> Result<()> {
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
        then: impl FnOnce(&Connection, &catalog::Catalog, &QueuedWrite, &str) -> Result<T>,
    ) -> Result<T> {
        self.lock.refuse_unless_writer()?;
        store::refuse_unless_hydrated(&*self.conn()?)?;
        let cache = self.cache()?;
        let queued = {
            // Until the upload is queued, nothing but this hold keeps its
            // bytes from a trim.
            let _held = cache.hold();
            let hash = cache.take(path)?;
            let mut conn = self.conn()?;
            let catalog = catalog::Catalog::load(&conn)?;
            let tx = conn.transaction()?;
            let upload = queue_upload(&tx, &hash, mime_type)?;
            let queued = then(&tx, &catalog, &upload, &hash)?;
            tx.commit()?;
            queued
        };
        self.trim_blobs(None, blob::CACHE_MOST);
        Ok(queued)
    }

    /// Three writes, each with its own verdict, each waiting on the one
    /// before it: the upload, a file item naming the bytes, and an
    /// `attached-to` edge from the file to the item.
    pub fn attach(&self, target: &str, path: &Path, attachment: &Attachment) -> Result<Attached> {
        self.lock.refuse_unless_writer()?;
        {
            let conn = self.conn()?;
            store::refuse_unless_hydrated(&conn)?;
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

    pub fn add_file(&self, path: &Path, attachment: &Attachment, tags: &[String]) -> Result<Added> {
        self.lock.refuse_unless_writer()?;
        store::refuse_unless_hydrated(&*self.conn()?)?;
        let (mime_type, mut draft) = file_draft(path, attachment, tags);
        self.refuse_unknown_type(&draft.r#type)?;
        self.with_upload(path, &mime_type, |tx, catalog, upload, hash| {
            name_bytes(&mut draft.properties, hash, &mime_type);
            let item = queue_create(tx, catalog, &draft, std::slice::from_ref(&upload.id))?;
            Ok(Added {
                upload: upload.clone(),
                item,
            })
        })
    }

    /// Fetched and held when not held already. With no way to fetch, the
    /// refusal is `BytesAbsent`.
    pub fn blob(&self, hash: &str) -> Result<PathBuf> {
        let hash = blob::named(hash)?;
        let cache = self.cache()?;
        if let Some(path) = cache.held(&hash)? {
            if self.handle() == Handle::Writer {
                cache.touch(&path);
            }
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
        let path = blob::fetch(cache, http, &hash)?;
        self.trim_blobs(Some(&hash), blob::CACHE_MOST);
        Ok(path)
    }

    /// Bytes an upload still names are never taken, nor `fetched`, which a
    /// caller is about to read. A trim that cannot read the queue takes
    /// nothing.
    fn trim_blobs(&self, fetched: Option<&str>, most: u64) {
        if self.handle() != Handle::Writer {
            return;
        }
        let Ok(cache) = self.cache() else {
            return;
        };
        let _held = cache.hold();
        if let Some(mut kept) = self.unsent_blobs() {
            kept.extend(fetched.and_then(|hash| blob::hex_of(hash).ok().map(str::to_string)));
            cache.trim(most, &kept);
        }
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
        if let Some(kept) = self.unsent_blobs() {
            cache.let_go(hash, &kept);
        }
    }

    fn unsent_blobs(&self) -> Option<HashSet<String>> {
        let conn = self.conn().ok()?;
        let hashes = store::unsent_uploads(&conn).ok()?;
        Some(
            hashes
                .iter()
                .filter_map(|hash| blob::hex_of(hash).ok().map(str::to_string))
                .collect(),
        )
    }

    pub fn blob_held(&self, hash: &str) -> Result<bool> {
        Ok(self.cache()?.held(&blob::named(hash)?)?.is_some())
    }

    /// Only terminal verdicts go: a `blocked` or a `dead` row is one a
    /// caller may still release, and a refused write that carried content
    /// stays until it is discarded.
    pub fn forget_answered(&self) -> Result<usize> {
        self.lock.refuse_unless_writer()?;
        let conn = self.conn()?;
        store::forget_answered(&conn)
    }

    /// Takes a refused write out of the queue, with what it carried. Answers
    /// `false` for a row that is not refused, or one a write still waits on.
    pub fn discard(&self, id: &str) -> Result<bool> {
        self.lock.refuse_unless_writer()?;
        let conn = self.conn()?;
        store::discard(&conn, id)
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
            // A slice and no cursor: the log aged past the cursor.
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
            catalog_version: store::catalog_version(&conn)?,
        })
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

    pub(crate) fn conn(&self) -> Result<MutexGuard<'_, Connection>> {
        self.conn
            .lock()
            .map_err(|_| CoreError::Store("the connection was poisoned by an earlier panic".into()))
    }
}

/// An id is minted here, where the draft names none, so a queued row is
/// readable locally before the server answers.
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
    // An unchanged type or tier is not sent: the drain reads one in a sent
    // edit as a move, and lets the row go where its answer is outside the
    // slice.
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
    let read_earlier = based == Based::AsRead && base > 0 && base <= held.version;
    if base != held.version && !read_earlier {
        return Err(CoreError::Invalid(format!(
            "the update to {id} is based on version {base} and this copy holds version {}; read it again",
            held.version
        )));
    }
    let payload = edit.payload(base)?;
    // Recorded only where based on the held version: an edit based on an
    // earlier one was not made against the copy's row. A whole-properties
    // edit also changes every property it leaves out.
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
    // Only an edit that read the copy knows which properties it cleared.
    if edit.replace_properties && read.is_some() {
        next.properties = edit.properties.clone();
    } else {
        for (key, value) in &edit.properties {
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

/// An edge the copy could not take is refused: no event about it would
/// reach the copy, so it would sit there as written for good.
fn queue_edge(tx: &Connection, draft: &EdgeDraft) -> Result<QueuedWrite> {
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

fn held_edge(conn: &Connection, id: &str) -> Result<model::Edge> {
    store::edge_by_id(conn, id)?.ok_or_else(|| CoreError::NotFound {
        code: "edge_not_found".into(),
        message: format!("{id} is not an edge this copy holds"),
    })
}

fn queue_edge_delete(tx: &Connection, held: &model::Edge) -> Result<QueuedWrite> {
    let depends_on = store::untaken_create_for_edge(tx, &held.id)?;
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

fn name_bytes(properties: &mut serde_json::Map<String, Value>, hash: &str, mime_type: &str) {
    properties.insert("blob_ref".into(), hash.into());
    properties.insert("mime_type".into(), mime_type.into());
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

    fn held_copy() -> Core {
        let core = Core::open_in_memory(None).unwrap();
        {
            let conn = core.conn().unwrap();
            store::meta_set(&conn, store::META_EVENT_CURSOR, "10").unwrap();
            store::meta_set(&conn, store::META_SLICE_TYPES, "[\"core.note\"]").unwrap();
            store::meta_set(&conn, store::META_SLICE_TIER, "library").unwrap();
            let mut row = store::testing::note("row", "server", "body", "2026-01-01T00:00:00Z");
            row.version = 3;
            store::put_server_item(
                &conn,
                &row,
                Some(&["a".into()]),
                &catalog::Indexing::default(),
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
            store::fold_into_beneath(&conn, &tagged).unwrap();
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
    fn every_edge_of_one_type_is_read_at_once() {
        let core = Core::open_in_memory(None).unwrap();
        assert_eq!(
            core.edges_of_type("in-thread"),
            Err(CoreError::HydrationIncomplete)
        );
        {
            let conn = core.conn().unwrap();
            store::meta_set(&conn, store::META_EVENT_CURSOR, "10").unwrap();
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
        adopt(photo(false, "thumbnail"));
        assert_eq!(found("unicornsXYZ"), vec![id.clone()]);
        adopt(photo(true, "thumbnail"));
        assert!(
            found("unicornsXYZ").is_empty(),
            "a title field naming the thumbnail put its base64 in the index"
        );
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
            ("withdraw", reader.withdraw("blocked").unwrap_err()),
            // Refused at the handle before the missing server, so not `NoServer`.
            ("drain", reader.drain().unwrap_err()),
            ("forget_answered", reader.forget_answered().unwrap_err()),
            ("discard", reader.discard("refused").unwrap_err()),
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
            33,
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
    fn a_trim_keeps_the_bytes_an_upload_still_names() {
        let dir = tempfile::tempdir().unwrap();
        let core = Core::open(dir.path().join("core.sqlite"), None).unwrap();
        let file = |name: &str, bytes: &[u8]| {
            let path = dir.path().join(name);
            std::fs::write(&path, bytes).unwrap();
            core.cache().unwrap().take(&path).unwrap()
        };
        let waiting = file("waiting.txt", b"to be sent");
        let read = file("read.txt", b"fetched once");
        let upload = queue_upload(&core.conn().unwrap(), &waiting, "text/plain").unwrap();

        core.trim_blobs(None, 0);
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
        core.trim_blobs(None, 0);
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
            assert!(report.failed_opens >= 1, "{report:?}");
        });
        assert!(!matches!(core.catch_up(), Err(CoreError::Invalid(_))));
    }

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
            matches!(refusal(&odd), CoreError::Store(message) if message.contains("no such column")),
            "an error the reading open cannot name was called something it is not"
        );

        let meta = "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);";
        let older = made(
            "older.sqlite",
            &format!("{meta} INSERT INTO meta VALUES ('schema_version', '0');"),
        );
        let unversioned = made("unversioned.sqlite", meta);
        for (path, found) in [(&older, "0"), (&unversioned, "none")] {
            assert_eq!(
                refusal(path),
                CoreError::WrongSchema {
                    expected: store::SCHEMA_VERSION.into(),
                    found: found.into(),
                    path: path.display().to_string(),
                }
            );
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
