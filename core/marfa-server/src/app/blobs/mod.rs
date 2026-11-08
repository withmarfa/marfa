//! Blobs: bytes kept under the hash of what they hold, in every attached store, and who may
//! read them.

mod digests;
mod disk;
mod hash;
pub mod link;
pub mod range;
mod rows;
mod s3;
mod store;
pub mod upkeep;

use std::future::Future;
use std::io;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use futures_util::future::join_all;
use serde_json::json;

use super::App;
use super::access::{Caller, Permission};
use super::catalog::{self, Snapshot};
use super::faults::{
    FAIL_BLOB_DELETE, FAIL_BLOB_READ, FAIL_BLOB_WRITE, Faults, HOLD_BLOB_DELETE, HOLD_BLOB_HAS,
    HOLD_BLOB_READ, HOLD_BLOB_WRITE, Volume,
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
pub use rows::{CopyRecord, Lender, OrphanRecord, StoreRecord};
use s3::S3;
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

/// A blob a caller may read, and the attached stores the copy record says hold it.
#[derive(Debug)]
pub struct Found {
    pub blob: Blob,
    held: Vec<String>,
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

/// The object store named by the configuration: the one its marker names, or, while it does
/// not answer, the one the copy record names at its locator.
async fn object_store(db: &Db, settings: &ObjectStoreSettings) -> std::result::Result<S3, Failure> {
    let opened = match tokio::time::timeout(CHECK_DEADLINE, S3::open(settings)).await {
        Ok(opened) => opened,
        Err(_) => Err(io::Error::new(io::ErrorKind::TimedOut, "no answer")),
    };
    let error = match opened {
        Ok(s3) => return Ok(s3),
        Err(error) => error,
    };
    let locator = settings.locator();
    let recorded = db
        .read(move |tx| rows::attached_object_store(tx, &locator))
        .await
        .map_err(started)?;
    match recorded {
        Some(id) => {
            tracing::warn!(%error, "The object store did not answer at start; its copies wait");
            S3::known(settings, id).map_err(started)
        }
        None => Err(Failure::start(format!(
            "The object store {} did not answer: {error}",
            settings.locator()
        ))),
    }
}

impl Blobs {
    /// Takes the disk store from its folder's marker and the object store from the
    /// configuration, and detaches every store the configuration no longer names.
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
        if found != disk::Found::Marked && object.is_none() {
            let locator = root.display().to_string();
            let named = db
                .read(move |tx| rows::copies_at_folder(tx, &locator))
                .await
                .map_err(started)?;
            if named {
                return Err(Failure::start(format!(
                    "The blob folder {} is missing or holds no store marker, and the copy \
                     record names copies there. Mount or restore it, then start again.",
                    root.display()
                )));
            }
        }
        let folder = root.to_path_buf();
        let disk = Arc::new(
            tokio::task::spawn_blocking(move || Disk::open(&folder))
                .await
                .map_err(started)??,
        );
        let s3 = match object {
            Some(settings) => Some(Arc::new(object_store(db, settings).await?)),
            None => None,
        };
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

    /// Whether the store holds the blob, and at what size, within the time a store is given.
    async fn size_of(
        &self,
        store: &Store,
        hash: &Hash,
    ) -> std::result::Result<Option<u64>, Failed> {
        let asked = async {
            self.faults.hold(HOLD_BLOB_HAS, None).await;
            match store {
                Store::Disk(disk) => {
                    let (disk, hash) = (disk.clone(), hash.clone());
                    tokio::task::spawn_blocking(move || disk.size_of(&hash))
                        .await
                        .map_err(io::Error::other)?
                }
                Store::S3(s3) => s3.size_of(hash).await,
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
                    let (disk, hash) = (disk.clone(), hash.clone());
                    let file = tokio::task::spawn_blocking(move || disk.open_blob(&hash))
                        .await
                        .map_err(io::Error::other)??;
                    Ok(store::file_stream(file, first, length))
                }
                Store::S3(s3) => s3.read(hash, first, length).await,
            }
        };
        match tokio::time::timeout(self.check(), opened).await {
            Ok(answer) => answer.map_err(Failed::Io),
            Err(_) => Err(Failed::Late),
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

    /// Deletes a blob's bytes from a store on a task that outlasts the wait for it.
    async fn delete(&self, store: &Store, hash: &Hash) -> std::result::Result<(), Failed> {
        let (faults, store, blob) = (self.faults.clone(), store.clone(), hash.clone());
        self.gate
            .outlast(hash, self.check(), async move {
                faults.hold(HOLD_BLOB_DELETE, None).await;
                if faults.fail(FAIL_BLOB_DELETE, None) {
                    return Err(io::Error::other("the store failed the delete"));
                }
                match store {
                    Store::Disk(disk) => tokio::task::spawn_blocking(move || disk.delete(&blob))
                        .await
                        .map_err(io::Error::other)?,
                    Store::S3(s3) => s3.delete(&blob).await,
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
    if error.kind() == io::ErrorKind::StorageFull {
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
        .or_else(|| volume::free_bytes(root))
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

/// An upload that is arriving. Its file goes when this does, unless `finish_upload` placed it.
pub struct Intake {
    staged: Option<Staged>,
    disk: Arc<Disk>,
    faults: Arc<Faults>,
    reserve: u64,
    mime_type: String,
}

impl Intake {
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

    /// Places the bytes on the disk, and only then records them: a file with no record is
    /// never served, and a recorded one is never removed.
    pub async fn finish_upload(&self, caller: &Caller, mut intake: Intake) -> Result<Blob> {
        let Some(mut staged) = intake.staged.take() else {
            return Err(Refusal::internal("an upload finished twice"));
        };
        if staged.size() == 0 {
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
        let (target, placed) = (self.blobs.disk.clone(), hash.clone());
        let mut staged = staged;
        self.blobs
            .writing(&hash, size, async move {
                tokio::task::spawn_blocking(move || target.publish(&mut staged, &placed))
                    .await
                    .map_err(io::Error::other)?
            })
            .await
            .map_err(|failure| match failure {
                Failed::Late => unavailable(),
                Failed::Io(error) => unwritable(error),
            })?;
        let blob = Blob {
            hash,
            mime_type: intake.mime_type.clone(),
            size_bytes: size,
        };
        let store_id = self.blobs.disk.id().to_string();
        let replicates = self.blobs.s3.is_some();
        let cache = self.catalog_handle();
        let recorded = self
            .write(caller, "blob.upload", move |unit| {
                let catalog = catalog::current(&cache, unit.tx(), Snapshot::Pending)?;
                unit.caller
                    .require_upload(catalog.provenance.keys().map(String::as_str))?;
                let holder = unit.caller.credential_handle();
                let recorded =
                    rows::record_upload(unit.tx(), &blob, &store_id, Some(&holder), &unit.at)?;
                rows::deleted(unit.tx(), &blob.hash, &store_id)?;
                if replicates {
                    housekeeping::bring_forward(unit.tx(), REPLICATE, &unit.at)?;
                }
                Ok(recorded)
            })
            .await?;
        drop(held);
        if replicates {
            housekeeping::wake(self);
        }
        Ok(recorded)
    }

    /// Carries out a queued deletion of a store's bytes of a blob, where the copy record no
    /// longer names a copy there. The caller holds the blob's lock.
    async fn finish_deletion(&self, store: &Store, hash: &Hash) -> std::result::Result<(), Failed> {
        let (blob, id) = (hash.clone(), store.id().to_string());
        let (queued, recorded) = self
            .db
            .read(move |tx| rows::deletion(tx, &blob, &id))
            .await
            .map_err(failed)?;
        if !queued {
            return Ok(());
        }
        let outcome = if recorded {
            Ok(())
        } else {
            self.blobs.delete(store, hash).await
        };
        let (blob, id) = (hash.clone(), store.id().to_string());
        let error = match &outcome {
            Ok(()) => None,
            Err(Failed::Late) => Some("the store did not finish the delete in time".to_string()),
            Err(Failed::Io(error)) => Some(error.to_string()),
        };
        self.db
            .write(Write::own(), move |tx| match &error {
                None => rows::deleted(tx, &blob, &id),
                Some(error) => rows::deletion_failed(tx, &blob, &id, error),
            })
            .await
            .map_err(failed)?;
        outcome
    }

    fn found_in(
        tx: &rusqlite::Transaction<'_>,
        caller: Option<&Caller>,
        hash: &Hash,
    ) -> Result<Found> {
        let Some(blob) = rows::find(tx, hash)? else {
            return Err(not_found());
        };
        if let Some(caller) = caller {
            let lenders = if caller.reads_every_blob() {
                Vec::new()
            } else {
                rows::lenders(tx, hash)?
            };
            if !caller.may_read_blob(&lenders) {
                return Err(not_found());
            }
        }
        let held = rows::holders(tx, hash)?;
        Ok(Found { blob, held })
    }

    /// A blob the caller may read; one it may not read is answered as an unknown one.
    pub async fn find_blob(&self, caller: &Caller, hash: &Hash) -> Result<Found> {
        let (caller, hash) = (caller.clone(), hash.clone());
        self.db
            .read(move |tx| App::found_in(tx, Some(&caller), &hash))
            .await
    }

    /// A window of a blob's bytes, from the first store that holds a copy and begins to
    /// answer in time. No copy in an attached store is an unknown blob, and no store that
    /// answers is a store that failed.
    pub async fn bytes_of(&self, found: &Found, first: u64, length: u64) -> Result<ByteStream> {
        if found.held.is_empty() {
            return Err(not_found());
        }
        for store in self.blobs.attached() {
            if !found.held.iter().any(|id| id == store.id()) {
                continue;
            }
            match self
                .blobs
                .open_bytes(&store, &found.blob.hash, first, length)
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

    pub async fn mint_link(&self, caller: &Caller, hash: &Hash, ttl: u64) -> Result<Link> {
        let found = self.find_blob(caller, hash).await?;
        if let Some(s3) = &self.blobs.s3
            && found.held.iter().any(|id| id == s3.id())
        {
            match s3.link(&found.blob.hash, Duration::from_secs(ttl)).await {
                Ok(url) => {
                    return Ok(Link {
                        url,
                        expires_in: ttl,
                    });
                }
                Err(error) => tracing::warn!(%error, "The object store made no link"),
            }
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
            .filter(|_| holders.iter().any(|id| id == store_id))
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
        if !holders.iter().any(|id| id == store_id) {
            return Err(copy_not_found());
        }
        let others: Vec<Store> = holders
            .iter()
            .filter(|id| *id != store_id)
            .filter_map(|id| self.blobs.store(id))
            .collect();
        let answers = join_all(
            others
                .iter()
                .map(|other| self.blobs.size_of(other, &found.hash)),
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
            if !holders.contains(&dropped) {
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
