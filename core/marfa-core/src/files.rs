//! Attachments, files taken in and the file cache: bytes held, fetched, kept and
//! trimmed.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use rusqlite::Connection;
use serde_json::Value;

use crate::edge_writes::queue_edge;
use crate::write::{Based, queue_create, queue_update, refuse_invalid_names, refuse_system_type};
use crate::{
    Added, Attached, Attachment, BlobPath, Core, CoreError, Draft, EdgeDraft, Edit, FileBudget,
    FileCache, Handle, KeptFetch, QueuedWrite, Result, WriteKind, blob, body, catch_up, damage,
    file_cache, http, lock, store,
};

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
        | CoreError::Network(_)
        | CoreError::ConnectionRefused { .. } => (Why::Unreachable, true),
        CoreError::Decoding(_)
        | CoreError::Server { .. }
        | CoreError::NotFound { .. }
        | CoreError::Validation { .. }
        | CoreError::Redirected { .. }
        | CoreError::Io(_)
        | CoreError::Store(_)
        | CoreError::StoreBusy(_)
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

/// A renewal changes the bearer, not the credential, so each upload
/// recorded as sent with the replaced header is now recorded as sent with
/// the new one (`store::move_uploads_sent_as`).
pub(crate) fn write_down_renewals(
    conn: &Connection,
    pending: &Mutex<Vec<(String, String)>>,
) -> Result<()> {
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

pub(crate) fn keep_relocated_origin(
    conn: &Mutex<Connection>,
    claim: &lock::WriterLock,
    recorded_origin: &str,
    recorded_instance: Option<&str>,
    origin: &str,
    stopped: &AtomicBool,
) -> Result<()> {
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
    let writer = claim.handle() == Handle::Writer;
    let held_origin = store::meta_get(&tx, store::META_SERVER_ORIGIN)?;
    // The writer may have recorded this very move since the reading handle opened.
    let origin_held = held_origin.as_deref() == Some(recorded_origin)
        || (!writer && held_origin.as_deref() == Some(origin));
    if !origin_held
        || store::meta_get(&tx, store::META_INSTANCE_ID)?.as_deref() != recorded_instance
    {
        return Err(CoreError::WrongServer {
            expected: recorded_origin.into(),
            got: origin.into(),
        });
    }
    if writer {
        store::meta_set(&tx, store::META_SERVER_ORIGIN, origin)?;
        tx.commit()?;
    }
    Ok(())
}

/// Lets go of a pin, and of the row where the slice does not take it.
pub(crate) fn unpin_held(tx: &Connection, id: &str) -> Result<bool> {
    let pinned = store::unpin(tx, id)?;
    if pinned && store::slice(tx)?.is_some() && store::item_held(tx, id)? {
        store::let_go_unless_kept(tx, &crate::catalog::load(tx)?, id)?;
    }
    Ok(pinned)
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
pub(crate) fn name_bytes(
    properties: &mut serde_json::Map<String, Value>,
    catalog: &marfa_rules::catalog::Catalog,
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

pub(crate) fn queue_upload(conn: &Connection, hash: &str, mime_type: &str) -> Result<QueuedWrite> {
    let payload = serde_json::json!({ "hash": hash, "mime_type": mime_type }).to_string();
    store::enqueue(
        conn,
        &store::NewWrite {
            kind: WriteKind::UploadBlob,
            item_id: None,
            to_id: None,
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

impl Core {
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
        if crate::catalog::load(&conn)?.known(r#type) {
            return Ok(());
        }
        Err(CoreError::UnknownType {
            server: None,
            message: format!("{type} is not a type this copy holds", type = r#type),
        })
    }

    /// One transaction: a write queued without the upload it names would
    /// name bytes the server is never sent.
    fn with_upload<T>(
        &self,
        path: &Path,
        mime_type: &str,
        then: impl FnOnce(
            &Connection,
            &marfa_rules::catalog::Catalog,
            &QueuedWrite,
            &blob::Taken,
        ) -> Result<T>,
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
        then: impl FnOnce(
            &Connection,
            &marfa_rules::catalog::Catalog,
            &QueuedWrite,
            &blob::Taken,
        ) -> Result<T>,
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
            let catalog = crate::catalog::load(&conn)?;
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
    /// embeds the file in the item's body, which reads back as the item's
    /// `references` edge to the file beside that edge.
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
                    server: None,
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
                    from_id: file.clone(),
                    to_id: target.to_string(),
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
        self.take_blobs_under(cache, |held| {
            let volume = (setting == FileBudget::Default)
                .then(|| cache.volume())
                .flatten();
            file_cache::in_force(setting, volume, held).bytes
        })
    }

    /// `blob::Cache::trim` to `budget`, called under `hold`.
    fn take_blobs_under(
        &self,
        cache: &blob::Cache,
        budget: impl FnOnce(u64) -> Option<u64>,
    ) -> u64 {
        // Held until the trim ends, so no attachment lands between the reads
        // and the trim that spares what they name.
        let Ok(conn) = self.conn() else {
            return 0;
        };
        let Ok((kept, attachments)) = self.keep_sets(&conn) else {
            return 0;
        };
        cache.trim(&kept, &attachments, budget)
    }

    /// The bytes the queue keeps and the bytes attachments keep, by the hex
    /// of their hash, both read on `conn`.
    fn keep_sets(&self, conn: &Connection) -> Result<(HashSet<String>, HashSet<String>)> {
        let kept = self.queue_keeps(conn)?;
        #[cfg(debug_assertions)]
        crate::fault::hold(|| format!("uploads-read:{:p}", self));
        let attachments = store::kept_attachments(conn)?;
        #[cfg(debug_assertions)]
        crate::fault::hold(|| format!("attachments-read:{:p}", self));
        Ok((kept, attachments))
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
        self.queue_keeps(&*self.conn().ok()?).ok()
    }

    /// The bytes the queue keeps, and those a set-aside keeps for writes it
    /// could not read, by the hex of their hash.
    fn queue_keeps(&self, conn: &Connection) -> Result<HashSet<String>> {
        let mut kept: HashSet<String> = store::kept_uploads(conn)?
            .iter()
            .filter_map(|hash| blob::hex_of(hash).ok().map(str::to_string))
            .collect();
        if let Some(cache) = &self.cache {
            kept.extend(damage::kept_bytes(conn, |name| cache.beside_store(name))?);
        }
        Ok(kept)
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

    pub(crate) fn file_cache_with(&self, conn: &Connection) -> Result<FileCache> {
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

    /// Takes every file the cache holds that a device can fetch again, and
    /// answers how many bytes it took. Keeps the bytes of attachments, of
    /// queued uploads, of a set-aside's unread writes and of reads in
    /// progress, and the partial files a fetch holds, and leaves the file
    /// budget as it was. Where the store or
    /// the cache cannot be read, takes nothing and answers the error. An
    /// attachment made while the files go can lose its bytes, which the next
    /// fetch of kept files brings back. Refused to a reading handle.
    pub fn remove_fetched_files(&self) -> Result<u64> {
        self.lock.refuse_unless_writer()?;
        let Some(cache) = &self.cache else {
            return Ok(0);
        };
        let _held = cache.hold();
        // The connection goes before the files do, so other calls are not
        // held up for every unlink. An upload is queued only under `hold`,
        // so the queue names no new bytes until this returns.
        let (kept, attachments) = self.keep_sets(&*self.conn()?)?;
        #[cfg(debug_assertions)]
        crate::fault::hold(|| format!("keep-sets-read:{:p}", self));
        cache
            .try_trim(&kept, &attachments, |_| Some(0))
            .map_err(|error| CoreError::Store(format!("the file cache cannot be read: {error}")))
    }
}
