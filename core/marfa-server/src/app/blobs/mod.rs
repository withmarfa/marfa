//! Blobs: bytes named by the hash of what they hold, kept in every attached store, and who may
//! read them.

mod digests;
mod disk;
mod hash;
pub mod link;
pub mod range;
pub mod references;
mod rows;
mod s3;
mod store;
pub mod upkeep;

use std::future::Future;
use std::io;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use futures_util::future::join_all;
use serde_json::json;
use uuid::Uuid;

use super::App;
use super::access::{Caller, Permission};
use super::catalog::{self, Snapshot};
use super::faults::{
    FAIL_BLOB_DELETE, FAIL_BLOB_READ, FAIL_BLOB_WRITE, Faults, HOLD_BLOB_DELETE, HOLD_BLOB_HAS,
    HOLD_BLOB_READ, HOLD_BLOB_WRITE, Lie, Volume,
};
use super::housekeeping;
use super::refusal::{Code, Refusal, Result};
use crate::db::{Db, Write, volume};
use crate::failure::Failure;
use crate::settings::registry::{
    BLOB_MIN_COPIES, BLOB_READ_IDLE_TIMEOUT_MS, DISK_RESERVE_BYTES, UPLOAD_IDLE_TIMEOUT_MS,
};
use crate::settings::start::ObjectStoreSettings;
pub use disk::MARKER;
use disk::{Disk, Staged};
pub use hash::Hash;
use rows::Held;
pub use rows::{CopyRecord, Lender, OrphanRecord, StoreRecord};
use s3::{Marker, S3};
pub use store::ByteStream;
use store::{CHECK_DEADLINE, Failed, Gate, Store};

pub const DEFAULT_TYPE: &str = "application/octet-stream";
const REPLICATE: &str = "blob-replicate";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Blob {
    pub hash: Hash,
    pub mime_type: String,
    pub size_bytes: u64,
}

/// A blob a caller may read, the copies the copy record names in attached stores, and whether
/// it records a copy anywhere.
#[derive(Debug)]
pub struct Found {
    pub blob: Blob,
    held: Vec<Held>,
    recorded: bool,
}

impl Found {
    /// The object a store holds the blob in, where the copy record names a copy there.
    fn object_in(&self, store: &Store) -> Option<&str> {
        self.held
            .iter()
            .find(|held| held.store_id == store.id())
            .map(|held| held.object.as_str())
    }
}

pub struct Link {
    pub url: String,
    pub expires_in: u64,
}

pub struct Blobs {
    disk: Arc<Disk>,
    s3: Option<Arc<S3>>,
    gate: Arc<Gate>,
    faults: Arc<Faults>,
    signer: link::Signer,
}

fn started(error: impl std::fmt::Display) -> Failure {
    Failure::start(error.to_string())
}

/// The refusal for a start over a blob folder that is missing or holds no marker while the
/// copy record names copies there.
fn folder_missing(root: &Path, why: &str) -> Failure {
    Failure::start(format!(
        "The blob folder {} is missing or holds no store marker, and the copy record names \
         copies there{why}. Mount or restore it, then start again.",
        root.display()
    ))
}

/// The object store named by the configuration: the one its marker names, writing a marker
/// for a store that has none, or, while it is not reached, the one the copy record names at
/// its locator. With `unfilled` naming a blob folder that lost its copies, only a store the
/// server has recorded may fill it, and nothing is written before that is known.
async fn object_store(
    db: &Db,
    settings: &ObjectStoreSettings,
    unfilled: Option<&Path>,
) -> std::result::Result<S3, Failure> {
    let refused =
        |what: String| Failure::start(format!("The object store {} {what}", settings.locator()));
    let bucket = S3::new(settings, String::new()).map_err(started)?;
    let marker = match tokio::time::timeout(CHECK_DEADLINE, bucket.marker()).await {
        Ok(marker) => marker,
        Err(_) => Marker::Silent(io::Error::new(io::ErrorKind::TimedOut, "no answer in time")),
    };
    let unknown = ", and the object store is not one the server has kept copies in";
    match marker {
        Marker::Id(id) => {
            if let Some(root) = unfilled {
                let named = id.clone();
                let recorded = db
                    .read(move |tx| rows::recorded_object_store(tx, &named))
                    .await
                    .map_err(started)?;
                if !recorded {
                    return Err(folder_missing(root, unknown));
                }
            }
            S3::new(settings, id).map_err(started)
        }
        Marker::None => {
            if let Some(root) = unfilled {
                return Err(folder_missing(root, unknown));
            }
            let s3 = S3::new(settings, Uuid::now_v7().to_string()).map_err(started)?;
            match tokio::time::timeout(CHECK_DEADLINE, s3.mark()).await {
                Ok(Ok(())) => Ok(s3),
                Ok(Err(error)) => Err(refused(format!(
                    "holds no store marker and took none: {error}"
                ))),
                Err(_) => Err(refused(
                    "holds no store marker and took none in time".to_string(),
                )),
            }
        }
        Marker::Silent(error) => {
            if let Some(root) = unfilled {
                return Err(folder_missing(
                    root,
                    ", and the object store did not answer",
                ));
            }
            let locator = settings.locator();
            let recorded = db
                .read(move |tx| rows::attached_object_store(tx, &locator))
                .await
                .map_err(started)?;
            match recorded {
                Some(id) => {
                    tracing::warn!(%error, "The object store did not answer at start; its copies wait");
                    S3::new(settings, id).map_err(started)
                }
                None => Err(refused(format!("did not answer: {error}"))),
            }
        }
        Marker::Refused(error) => Err(refused(format!("did not say which store it is: {error}"))),
    }
}

impl Blobs {
    /// Takes the disk store from its folder's marker and the object store from the
    /// configuration, and detaches every store the configuration no longer names. The folder
    /// is changed only once nothing refuses the start.
    pub async fn open(
        db: &Db,
        root: &Path,
        object: Option<&ObjectStoreSettings>,
        secret: &str,
        faults: Arc<Faults>,
        at: String,
    ) -> std::result::Result<Blobs, Failure> {
        let signer = link::Signer::derive(secret).map_err(started)?;
        let folder = root.to_path_buf();
        let found = tokio::task::spawn_blocking(move || Disk::probe(&folder))
            .await
            .map_err(started)??;
        let unfilled = if found == disk::Found::Marked {
            false
        } else {
            let locator = root.display().to_string();
            db.read(move |tx| rows::copies_at_folder(tx, &locator))
                .await
                .map_err(started)?
        };
        let s3 = match object {
            Some(settings) => Some(Arc::new(
                object_store(db, settings, unfilled.then_some(root)).await?,
            )),
            None if unfilled => return Err(folder_missing(root, "")),
            None => None,
        };
        let folder = root.to_path_buf();
        let disk = Arc::new(
            tokio::task::spawn_blocking(move || Disk::open(&folder))
                .await
                .map_err(started)??,
        );
        let attached: Vec<(String, &'static str, String)> = std::iter::once((
            disk.id().to_string(),
            "disk",
            disk.root().display().to_string(),
        ))
        .chain(
            s3.iter()
                .map(|s3| (s3.id().to_string(), "s3", s3.locator().to_string())),
        )
        .collect();
        db.write(Write::own(), move |tx| {
            for (id, kind, locator) in &attached {
                rows::attach(tx, id, kind, locator, &at)?;
            }
            let kept: Vec<&str> = attached.iter().map(|(id, _, _)| id.as_str()).collect();
            rows::detach_others(tx, &kept, &at)
        })
        .await
        .map_err(started)?;
        Ok(Blobs {
            disk,
            s3,
            gate: Arc::new(Gate::default()),
            faults,
            signer,
        })
    }

    fn check(&self) -> Duration {
        self.faults.store_check_deadline().unwrap_or(CHECK_DEADLINE)
    }

    /// The attached stores, the disk first.
    fn attached(&self) -> Vec<Store> {
        std::iter::once(Store::Disk(self.disk.clone()))
            .chain(self.s3.iter().map(|s3| Store::S3(s3.clone())))
            .collect()
    }

    fn store(&self, id: &str) -> Option<Store> {
        self.attached().into_iter().find(|store| store.id() == id)
    }

    /// Whether the store holds the blob in `object`, and at what size, within the time a store
    /// is given.
    async fn size_of(
        &self,
        store: &Store,
        hash: &Hash,
        object: &str,
    ) -> std::result::Result<Option<u64>, Failed> {
        let asked = async {
            self.faults.hold(HOLD_BLOB_HAS, None).await;
            match store {
                Store::Disk(disk) => {
                    match self.faults.lie(hash.as_str()) {
                        Some(Lie::Lost) => return Ok(None),
                        Some(Lie::Unreadable) => return Err(store::unreadable()),
                        Some(Lie::Damaged) | None => {}
                    }
                    let (disk, hash) = (disk.clone(), hash.clone());
                    tokio::task::spawn_blocking(move || disk.size_of(&hash))
                        .await
                        .map_err(io::Error::other)?
                }
                Store::S3(s3) => s3.size_of(object).await,
            }
        };
        match tokio::time::timeout(self.check(), asked).await {
            Ok(answer) => answer.map_err(Failed::Io),
            Err(_) => Err(Failed::Late),
        }
    }

    /// Opens a window of a blob's bytes, which the store must begin to answer in time.
    async fn open_bytes(
        &self,
        store: &Store,
        hash: &Hash,
        object: &str,
        first: u64,
        length: u64,
    ) -> std::result::Result<ByteStream, Failed> {
        let opened = async {
            self.faults.hold(HOLD_BLOB_READ, None).await;
            if self.faults.fail(FAIL_BLOB_READ, None) {
                return Err(io::Error::other("the store failed the read"));
            }
            match store {
                Store::Disk(disk) => {
                    let lie = self.faults.lie(hash.as_str());
                    match lie {
                        Some(Lie::Lost) => return Err(io::ErrorKind::NotFound.into()),
                        Some(Lie::Unreadable) => return Err(store::unreadable()),
                        Some(Lie::Damaged) | None => {}
                    }
                    let (disk, hash) = (disk.clone(), hash.clone());
                    let file = tokio::task::spawn_blocking(move || disk.open_blob(&hash))
                        .await
                        .map_err(io::Error::other)??;
                    let bytes = store::file_stream(file, first, length);
                    if lie == Some(Lie::Damaged) && first == 0 {
                        return Ok(store::first_byte_changed(bytes));
                    }
                    Ok(bytes)
                }
                Store::S3(s3) => s3.read(object, first, length).await,
            }
        };
        match tokio::time::timeout(self.check(), opened).await {
            Ok(answer) => answer.map_err(Failed::Io),
            Err(_) => Err(Failed::Late),
        }
    }

    /// Whether the store answers in time that it holds bytes under the blob's name, failing
    /// as a read of them would but reading none.
    async fn answers_for(
        &self,
        store: &Store,
        hash: &Hash,
        object: &str,
    ) -> std::result::Result<(), Failed> {
        let asked = async {
            self.faults.hold(HOLD_BLOB_READ, None).await;
            if self.faults.fail(FAIL_BLOB_READ, None) {
                return Err(io::Error::other("the store failed the read"));
            }
            let size = match store {
                Store::Disk(disk) => {
                    match self.faults.lie(hash.as_str()) {
                        Some(Lie::Lost) => return Err(io::ErrorKind::NotFound.into()),
                        Some(Lie::Unreadable) => return Err(store::unreadable()),
                        Some(Lie::Damaged) | None => {}
                    }
                    let (disk, hash) = (disk.clone(), hash.clone());
                    tokio::task::spawn_blocking(move || disk.size_of(&hash))
                        .await
                        .map_err(io::Error::other)??
                }
                Store::S3(s3) => s3.size_of(object).await?,
            };
            size.map(|_| ())
                .ok_or_else(|| io::ErrorKind::NotFound.into())
        };
        match tokio::time::timeout(self.check(), asked).await {
            Ok(answer) => answer.map_err(Failed::Io),
            Err(_) => Err(Failed::Late),
        }
    }

    /// Whether the store has bytes of the blob, recorded or not, and whether any of them hash to
    /// it, asked of the store itself.
    async fn holding(&self, store: &Store, hash: &Hash) -> (bool, bool) {
        let asked = async {
            match store {
                Store::Disk(disk) => {
                    let (disk, hash) = (disk.clone(), hash.clone());
                    let read = tokio::task::spawn_blocking(move || {
                        disk.rehash(&hash, false)
                            .map(|found| found.map(|(_, found)| found == hash))
                    });
                    read.await.map_err(io::Error::other)?
                }
                Store::S3(s3) => {
                    let objects = s3.objects_of(hash).await?;
                    if objects.is_empty() {
                        return Ok(None);
                    }
                    for (object, size) in objects {
                        let mut bytes = s3.read(&object, 0, size).await?;
                        let mut hasher = store::Hasher::default();
                        while let Some(chunk) = bytes.next().await {
                            hasher.update(&chunk?);
                        }
                        if hasher.matches(hash, size).is_ok() {
                            return Ok(Some(true));
                        }
                    }
                    Ok(Some(false))
                }
            }
        };
        match tokio::time::timeout(self.check(), asked).await {
            Ok(Ok(Some(intact))) => (true, intact),
            Ok(Ok(None)) => (false, false),
            Ok(Err(error)) => {
                tracing::warn!(%error, store = store.kind(), "A store did not say what it holds");
                (false, false)
            }
            Err(_) => (false, false),
        }
    }

    /// Whether the store answers now with its own marker. Asked again before each strike, made
    /// after the answer that found the copy missing, so an endpoint that stopped being the
    /// store since an earlier answer strikes nothing.
    async fn is_itself(&self, store: &Store) -> bool {
        let Store::S3(s3) = store else {
            return true;
        };
        let answer = match tokio::time::timeout(self.check(), s3.is_itself()).await {
            Ok(answer) => answer,
            Err(_) => Err(io::Error::new(io::ErrorKind::TimedOut, "no answer in time")),
        };
        match answer {
            Ok(()) => true,
            Err(error) => {
                tracing::warn!(%error, "The object store did not answer as itself; nothing is struck there");
                false
            }
        }
    }

    /// Writes a blob's bytes to a store on a task that outlasts the wait for it.
    async fn writing<W>(&self, hash: &Hash, size: u64, work: W) -> std::result::Result<(), Failed>
    where
        W: Future<Output = io::Result<()>> + Send + 'static,
    {
        let faults = self.faults.clone();
        let deadline = store::write_deadline(self.check(), size);
        self.gate
            .outlast(hash, deadline, async move {
                faults.hold(HOLD_BLOB_WRITE, None).await;
                if faults.fail(FAIL_BLOB_WRITE, None) {
                    return Err(io::ErrorKind::StorageFull.into());
                }
                work.await
            })
            .await
    }

    /// Deletes a blob's bytes, the disk's file or one object, from a store on a task that
    /// outlasts the wait for it.
    async fn delete(
        &self,
        store: &Store,
        hash: &Hash,
        object: &str,
    ) -> std::result::Result<(), Failed> {
        let (faults, store, blob) = (self.faults.clone(), store.clone(), hash.clone());
        let object = object.to_string();
        let deadline = self.check();
        self.gate
            .outlast(hash, deadline, async move {
                faults.hold(HOLD_BLOB_DELETE, None).await;
                if faults.fail(FAIL_BLOB_DELETE, None) {
                    return Err(io::Error::other("the store failed the delete"));
                }
                match store {
                    Store::Disk(disk) => {
                        let gone = blob.clone();
                        tokio::task::spawn_blocking(move || disk.delete(&gone))
                            .await
                            .map_err(io::Error::other)??;
                        faults.heal(blob.as_str(), false);
                        Ok(())
                    }
                    Store::S3(s3) => {
                        store::within(store::stall_limit(deadline), s3.delete(&object)).await
                    }
                }
            })
            .await
    }
}

fn not_found() -> Refusal {
    Refusal::new(Code::BlobNotFound, "Blob not found")
}

fn copy_not_found() -> Refusal {
    Refusal::new(
        Code::BlobCopyNotFound,
        "No attached store with that id holds a copy of this blob.",
    )
}

fn below(live: usize, min_copies: u64) -> Refusal {
    Refusal::new(
        Code::CopiesBelowMinimum,
        "Dropping this copy would leave fewer copies than the instance keeps.",
    )
    .with_detail("live", live)
    .with_detail("min_copies", min_copies)
}

fn unavailable() -> Refusal {
    Refusal::new(
        Code::BlobStoreUnavailable,
        "The blob store did not answer; try again later.",
    )
}

fn insufficient() -> Refusal {
    Refusal::new(
        Code::InsufficientStorage,
        "The volume the blobs are kept on has no room for the upload.",
    )
}

/// A write that ran out of room is `507`; any other failure is the store's.
fn unwritable(error: io::Error) -> Refusal {
    if matches!(
        error.kind(),
        io::ErrorKind::StorageFull | io::ErrorKind::QuotaExceeded
    ) {
        return insufficient();
    }
    tracing::error!(%error, "A blob write failed");
    unavailable()
}

fn joined<T>(outcome: std::result::Result<T, tokio::task::JoinError>) -> Result<T> {
    outcome.map_err(|error| Refusal::internal(&format!("a blob task did not finish: {error}")))
}

fn failed(refused: Refusal) -> Failed {
    Failed::Io(io::Error::other(refused.to_string()))
}

/// Refuses a body that would leave less free on the blob volume than the reserve.
fn room(faults: &Faults, root: &Path, reserve: u64, incoming: u64) -> Result<()> {
    if reserve == 0 {
        return Ok(());
    }
    let Some(available) = faults
        .free(Volume::Blobs)
        .unwrap_or_else(|| volume::free_bytes(root))
    else {
        return Ok(());
    };
    if available.saturating_sub(incoming) < reserve {
        return Err(insufficient()
            .with_detail("reserve_bytes", reserve)
            .with_detail("available_bytes", available));
    }
    Ok(())
}

/// Bytes on the disk that no record names yet, locked against deletion until `release_upload`.
pub struct Placed {
    recording: Recording,
    held: store::Held,
}

impl Placed {
    /// What records the bytes inside the write; the lock stays with `self`, past the commit.
    pub fn recording(&self) -> Recording {
        self.recording.clone()
    }
}

#[derive(Clone)]
pub struct Recording {
    blob: Blob,
    store_id: String,
    replicates: bool,
}

impl Recording {
    /// Records the blob and its copy, and the uploader's proof where there is one.
    pub fn record(
        &self,
        tx: &rusqlite::Transaction<'_>,
        holder: Option<&str>,
        at: &str,
    ) -> Result<Blob> {
        let recorded = rows::record_upload(tx, &self.blob, &self.store_id, holder, at)?;
        rows::deleted(tx, &self.blob.hash, &self.store_id, "")?;
        if self.replicates {
            housekeeping::bring_forward(tx, REPLICATE, at)?;
        }
        Ok(recorded)
    }
}

/// An upload that is arriving. Its file goes when this does, unless `place_upload` placed it.
pub struct Intake {
    staged: Option<Staged>,
    disk: Arc<Disk>,
    faults: Arc<Faults>,
    reserve: u64,
    mime_type: String,
}

impl Intake {
    /// Removes the file on a blocking task, so that when this returns it is gone.
    pub async fn discard(mut self) {
        if let Some(staged) = self.staged.take() {
            let _ = tokio::task::spawn_blocking(move || staged.discard()).await;
        }
    }

    pub async fn push(&mut self, bytes: impl AsRef<[u8]> + Send + 'static) -> Result<()> {
        let Some(mut staged) = self.staged.take() else {
            return Err(Refusal::internal("an upload was pushed after it finished"));
        };
        let (faults, disk, reserve) = (self.faults.clone(), self.disk.clone(), self.reserve);
        let (staged, outcome) = joined(
            tokio::task::spawn_blocking(move || {
                let outcome = room(&faults, disk.root(), reserve, 0)
                    .and_then(|()| staged.append(bytes.as_ref()).map_err(unwritable));
                (staged, outcome)
            })
            .await,
        )?;
        self.staged = Some(staged);
        outcome
    }
}

impl App {
    /// Whether the caller may upload, on the types registered now.
    pub async fn check_upload(&self, caller: &Caller) -> Result<()> {
        let cache = self.catalog_handle();
        let catalog = self
            .db
            .read(move |tx| catalog::current(&cache, tx, Snapshot::Committed))
            .await?;
        caller.require_upload(catalog.provenance.keys().map(String::as_str))
    }

    /// Refuses a body declared too large for the room, then opens a file for it.
    pub async fn begin_upload(&self, declared: Option<u64>, mime_type: String) -> Result<Intake> {
        let reserve = self.settings.live().get(DISK_RESERVE_BYTES);
        let disk = self.blobs.disk.clone();
        let faults = self.faults.clone();
        joined(
            tokio::task::spawn_blocking(move || {
                room(&faults, disk.root(), reserve, declared.unwrap_or(0))?;
                let staged = disk.stage().map_err(unwritable)?;
                Ok(Intake {
                    staged: Some(staged),
                    disk,
                    faults,
                    reserve,
                    mime_type,
                })
            })
            .await,
        )?
    }

    pub fn upload_idle(&self) -> Duration {
        Duration::from_millis(self.settings.live().get(UPLOAD_IDLE_TIMEOUT_MS))
    }

    pub fn blob_read_idle(&self) -> Duration {
        Duration::from_millis(self.settings.live().get(BLOB_READ_IDLE_TIMEOUT_MS))
    }

    /// Places the bytes on the disk. Nothing serves them until a record names them.
    pub async fn place_upload(&self, mut intake: Intake) -> Result<Placed> {
        let Some(mut staged) = intake.staged.take() else {
            return Err(Refusal::internal("an upload finished twice"));
        };
        if staged.size() == 0 {
            let _ = tokio::task::spawn_blocking(move || staged.discard()).await;
            return Err(
                Refusal::validation("The body is empty; send the bytes to keep.")
                    .with_detail("field", "body"),
            );
        }
        let (staged, hash) = joined(
            tokio::task::spawn_blocking(move || staged.seal().map(|hash| (staged, hash))).await,
        )?
        .map_err(unwritable)?;
        let size = staged.size();
        let held = self.blobs.gate.lock(&hash).await;
        if self.blobs.gate.unfinished(&hash) {
            return Err(unavailable());
        }
        let disk = Store::Disk(self.blobs.disk.clone());
        if let Err(failure) = self.finish_deletion(&disk, &hash).await {
            tracing::warn!(
                ?failure,
                "A queued deletion of an upload's bytes did not finish"
            );
            return Err(unavailable());
        }
        let (target, placed, faults) = (self.blobs.disk.clone(), hash.clone(), self.faults.clone());
        let mut staged = staged;
        self.blobs
            .writing(&hash, size, async move {
                let name = placed.clone();
                tokio::task::spawn_blocking(move || target.publish(&mut staged, &placed))
                    .await
                    .map_err(io::Error::other)??;
                faults.heal(name.as_str(), true);
                Ok(())
            })
            .await
            .map_err(|failure| match failure {
                Failed::Late => unavailable(),
                Failed::Io(error) => unwritable(error),
            })?;
        Ok(Placed {
            recording: Recording {
                blob: Blob {
                    hash,
                    mime_type: intake.mime_type.clone(),
                    size_bytes: size,
                },
                store_id: self.blobs.disk.id().to_string(),
                replicates: self.blobs.s3.is_some(),
            },
            held,
        })
    }

    /// Unlocks placed bytes once the write that records them has ended, and replicates them if
    /// it committed.
    pub fn release_upload(&self, placed: Placed, committed: bool) {
        let Placed { recording, held } = placed;
        drop(held);
        if committed && recording.replicates {
            housekeeping::wake(self);
        }
    }

    /// Places the bytes on the disk, and only then records them: a file with no record is
    /// never served, and a recorded one is never removed.
    pub async fn finish_upload(&self, caller: &Caller, intake: Intake) -> Result<Blob> {
        let placed = self.place_upload(intake).await?;
        let recording = placed.recording();
        let cache = self.catalog_handle();
        let recorded = self
            .write(caller, "blob.upload", move |unit| {
                let catalog = catalog::current(&cache, unit.tx(), Snapshot::Pending)?;
                unit.caller
                    .require_upload(catalog.provenance.keys().map(String::as_str))?;
                let holder = unit.caller.credential_handle();
                recording.record(unit.tx(), Some(&holder), &unit.at)
            })
            .await;
        self.release_upload(placed, recorded.is_ok());
        recorded
    }

    /// Carries out the queued deletions of a store's bytes of a blob, each of an object no copy
    /// records. The caller holds the blob's lock.
    async fn finish_deletion(&self, store: &Store, hash: &Hash) -> std::result::Result<(), Failed> {
        let (blob, id) = (hash.clone(), store.id().to_string());
        let queued = self
            .db
            .read(move |tx| rows::deletion(tx, &blob, &id))
            .await
            .map_err(failed)?;
        for (object, recorded) in queued {
            let outcome = if recorded {
                Ok(())
            } else {
                self.blobs.delete(store, hash, &object).await
            };
            let (blob, id, gone) = (hash.clone(), store.id().to_string(), object.clone());
            let error = match &outcome {
                Ok(()) => None,
                Err(Failed::Late) => {
                    Some("the store did not finish the delete in time".to_string())
                }
                Err(Failed::Io(error)) => Some(error.to_string()),
            };
            self.db
                .write(Write::own(), move |tx| match &error {
                    None => rows::deleted(tx, &blob, &id, &gone),
                    Some(error) => rows::deletion_failed(tx, &blob, &id, &gone, error),
                })
                .await
                .map_err(failed)?;
            outcome?;
        }
        Ok(())
    }

    /// A blob held in the store, by a caller's right to read it where one is given.
    pub(crate) fn found_in(
        tx: &rusqlite::Transaction<'_>,
        caller: Option<&Caller>,
        hash: &Hash,
    ) -> Result<Found> {
        let Some(blob) = rows::find(tx, hash)? else {
            return Err(not_found());
        };
        if let Some(caller) = caller
            && !caller.may_read_blob(rows::lenders(tx, hash))?
        {
            return Err(not_found());
        }
        let recorded = !rows::copies(tx, hash)?.is_empty();
        let held = rows::holders(tx, hash)?;
        Ok(Found {
            blob,
            held,
            recorded,
        })
    }

    /// What each attached store physically holds of `hash`, past every blob fault, and the
    /// files the disk store is receiving now. Only the test hooks ask.
    pub async fn inspect_stores(&self, hash: Option<&str>) -> Result<serde_json::Value> {
        let hash = match hash {
            Some(text) if text.starts_with("sha256:") => Some(Hash::parse(text)?),
            Some(_) => {
                return Err(Refusal::validation("Provide hash as a sha256: blob name.")
                    .with_detail("field", "hash"));
            }
            None => None,
        };
        let mut stores = Vec::new();
        for store in self.blobs.attached() {
            let (holds, intact) = match &hash {
                Some(hash) => self.blobs.holding(&store, hash).await,
                None => (false, false),
            };
            stores.push(json!({
                "id": store.id(),
                "kind": store.kind(),
                "holds": holds,
                "intact": intact,
            }));
        }
        let disk = self.blobs.disk.clone();
        let spool = joined(tokio::task::spawn_blocking(move || disk.spool()).await)?
            .map_err(|error| Refusal::internal(&error.to_string()))?;
        let spool: Vec<_> = spool
            .into_iter()
            .map(|(name, size)| json!({ "name": name, "size": size }))
            .collect();
        Ok(json!({ "stores": stores, "spool": spool }))
    }

    /// A blob the caller may read; one it may not read is answered as an unknown one.
    pub async fn find_blob(&self, caller: &Caller, hash: &Hash) -> Result<Found> {
        let (caller, hash) = (caller.clone(), hash.clone());
        self.db
            .read(move |tx| App::found_in(tx, Some(&caller), &hash))
            .await
    }

    /// A window of a blob's bytes, from the first store that holds a copy and begins to
    /// answer in time. A blob with no recorded copy is an unknown one; a copy in a detached
    /// store, or in a store that does not answer, is a store that failed.
    pub async fn bytes_of(&self, found: &Found, first: u64, length: u64) -> Result<ByteStream> {
        if !found.recorded {
            return Err(not_found());
        }
        for store in self.blobs.attached() {
            let Some(object) = found.object_in(&store) else {
                continue;
            };
            match self
                .blobs
                .open_bytes(&store, &found.blob.hash, object, first, length)
                .await
            {
                Ok(bytes) => return Ok(bytes),
                Err(failure) => {
                    tracing::warn!(
                        store = store.kind(),
                        ?failure,
                        "A store did not open a blob"
                    );
                }
            }
        }
        Err(unavailable())
    }

    /// Answers as `bytes_of` would, from the copy record and a store that says it holds a
    /// copy, without reading the bytes.
    pub async fn check_bytes(&self, found: &Found) -> Result<()> {
        if !found.recorded {
            return Err(not_found());
        }
        for store in self.blobs.attached() {
            let Some(object) = found.object_in(&store) else {
                continue;
            };
            match self
                .blobs
                .answers_for(&store, &found.blob.hash, object)
                .await
            {
                Ok(()) => return Ok(()),
                Err(failure) => {
                    tracing::warn!(
                        store = store.kind(),
                        ?failure,
                        "A store did not answer for a blob"
                    );
                }
            }
        }
        Err(unavailable())
    }

    /// The object store's own link while it holds a copy, or the instance's. A store that
    /// holds a copy and makes no link in time, its credentials included, is a store that failed.
    pub async fn mint_link(&self, caller: &Caller, hash: &Hash, ttl: u64) -> Result<Link> {
        let found = self.find_blob(caller, hash).await?;
        if let Some(s3) = &self.blobs.s3
            && let Some(object) = found.object_in(&Store::S3(s3.clone()))
        {
            let lifetime = Duration::from_secs(ttl);
            return match s3.link(object, lifetime, self.blobs.check()).await {
                Ok(url) => Ok(Link {
                    url,
                    expires_in: ttl,
                }),
                Err(error) => {
                    tracing::warn!(%error, "The object store made no link");
                    Err(unavailable())
                }
            };
        }
        let expires_ms = i64::try_from(ttl)
            .ok()
            .and_then(|seconds| seconds.checked_mul(1000))
            .and_then(|ms| self.clock.now_ms().checked_add(ms))
            .ok_or_else(|| Refusal::internal("a link's expiry did not fit"))?;
        let signature = self.blobs.signer.sign(&found.blob.hash, expires_ms)?;
        Ok(Link {
            url: link::url(
                self.addresses().sign_in().origin(),
                &found.blob.hash,
                expires_ms,
                &signature,
            ),
            expires_in: ttl,
        })
    }

    /// A link is checked here and now, whatever happened to the key that minted it.
    pub async fn find_linked(&self, hash: &Hash, expires: &str, signature: &str) -> Result<Found> {
        let expires_ms = expires.parse::<i64>().ok();
        let live = expires_ms.is_some_and(|ms| ms >= self.clock.now_ms());
        let signed = expires_ms.is_some_and(|ms| self.blobs.signer.verifies(hash, ms, signature));
        if !(live && signed) {
            return Err(super::access::unauthorized());
        }
        let hash = hash.clone();
        self.db.read(move |tx| App::found_in(tx, None, &hash)).await
    }

    pub async fn blob_copies(&self, caller: &Caller, hash: &Hash) -> Result<Vec<CopyRecord>> {
        let (caller, hash) = (caller.clone(), hash.clone());
        self.db
            .read(move |tx| {
                App::found_in(tx, Some(&caller), &hash)?;
                rows::copies(tx, &hash)
            })
            .await
    }

    /// Every store, and the fewest live copies of a blob the instance keeps.
    pub async fn blob_stores(&self, caller: &Caller) -> Result<(Vec<StoreRecord>, u64)> {
        caller.require(Permission::InstanceRead)?;
        let stores = self.db.read(rows::stores).await?;
        Ok((stores, self.settings.live().get(BLOB_MIN_COPIES)))
    }

    pub async fn blob_orphans(&self, caller: &Caller) -> Result<Vec<OrphanRecord>> {
        caller.require(Permission::InstanceRead)?;
        self.db.read(rows::orphans).await
    }

    /// Drops one store's copy while `min_copies` others remain, each confirmed by its store.
    /// The copy leaves the copy record, with its deletion queued, before its bytes go.
    pub async fn drop_copy(&self, caller: &Caller, hash: &Hash, store_id: &str) -> Result<()> {
        let min_copies = self.settings.live().get(BLOB_MIN_COPIES);
        let blob = hash.clone();
        let (found, holders) = self
            .db
            .read(move |tx| {
                let found = rows::find(tx, &blob)?;
                Ok((found, rows::holders(tx, &blob)?))
            })
            .await?;
        let Some(found) = found else {
            return Err(not_found());
        };
        if self.blobs.gate.unfinished(hash) {
            return Err(unavailable());
        }
        let store = self
            .blobs
            .store(store_id)
            .filter(|_| holders.iter().any(|held| held.store_id == store_id))
            .ok_or_else(copy_not_found)?;
        if ((holders.len() - 1) as u64) < min_copies {
            return Err(below(holders.len(), min_copies));
        }
        let _held = self.blobs.gate.lock(hash).await;
        if self.blobs.gate.unfinished(hash) {
            return Err(unavailable());
        }
        let blob = hash.clone();
        let holders = self.db.read(move |tx| rows::holders(tx, &blob)).await?;
        if !holders.iter().any(|held| held.store_id == store_id) {
            return Err(copy_not_found());
        }
        let others: Vec<(Store, &str)> = holders
            .iter()
            .filter(|held| held.store_id != store_id)
            .filter_map(|held| Some((self.blobs.store(&held.store_id)?, held.object.as_str())))
            .collect();
        let answers = join_all(
            others
                .iter()
                .map(|(other, object)| self.blobs.size_of(other, &found.hash, object)),
        )
        .await;
        let confirmed = answers
            .iter()
            .filter(|answer| matches!(answer, Ok(Some(size)) if *size == found.size_bytes))
            .count();
        if (confirmed as u64) < min_copies {
            return Err(below(confirmed + 1, min_copies));
        }
        let (blob, dropped) = (hash.clone(), store_id.to_string());
        self.write(caller, "blob.copy_dropped", move |unit| {
            unit.caller.require(Permission::BlobsManage)?;
            let holders = rows::holders(unit.tx(), &blob)?;
            if !holders.iter().any(|held| held.store_id == dropped) {
                return Err(copy_not_found());
            }
            if ((holders.len() - 1) as u64) < min_copies {
                return Err(below(holders.len(), min_copies));
            }
            rows::remove_copy(unit.tx(), &blob, &dropped, &unit.at)?;
            unit.audit("blob", blob.as_str(), Some(json!({ "store_id": dropped })))
        })
        .await?;
        if let Err(failure) = self.finish_deletion(&store, hash).await {
            tracing::warn!(?failure, "A dropped copy's bytes wait for a later run");
        }
        Ok(())
    }
}
