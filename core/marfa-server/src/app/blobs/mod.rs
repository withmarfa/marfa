//! Blobs: bytes kept under the hash of what they hold, and who may read them.

mod disk;
mod hash;
pub mod link;
pub mod range;
mod rows;

use std::fs::File;
use std::io;
use std::path::Path;
use std::sync::Arc;

use super::App;
use super::access::{Caller, Permission};
use super::catalog::{self, Snapshot};
use super::faults::{FAIL_BLOB_WRITE, Faults, Volume};
use super::refusal::{Code, Refusal, Result};
use crate::db::{Db, Write, volume};
use crate::failure::Failure;
use crate::settings::registry::{
    BLOB_MIN_COPIES, BLOB_READ_IDLE_TIMEOUT_MS, DISK_RESERVE_BYTES, UPLOAD_IDLE_TIMEOUT_MS,
};
pub use disk::MARKER;
use disk::{Disk, Staged};
pub use hash::Hash;
pub use rows::{CopyRecord, Lender, StoreRecord};

pub const DEFAULT_TYPE: &str = "application/octet-stream";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Blob {
    pub hash: Hash,
    pub mime_type: String,
    pub size_bytes: u64,
}

/// A blob a caller may read, and whether an attached store holds its bytes.
#[derive(Debug)]
pub struct Found {
    pub blob: Blob,
    held: bool,
}

pub struct Link {
    pub url: String,
    pub expires_in: u64,
}

/// Where a blob's bytes live. An object store fits beside the disk.
enum Store {
    Disk(Arc<Disk>),
}

impl Store {
    fn id(&self) -> &str {
        match self {
            Store::Disk(disk) => disk.id(),
        }
    }

    fn disk(&self) -> Arc<Disk> {
        match self {
            Store::Disk(disk) => disk.clone(),
        }
    }
}

pub struct Blobs {
    store: Store,
    signer: link::Signer,
}

impl Blobs {
    /// Blocks, so it runs before the server takes requests.
    pub fn open(root: &Path, secret: &str) -> std::result::Result<Blobs, Failure> {
        let signer =
            link::Signer::derive(secret).map_err(|refused| Failure::start(refused.to_string()))?;
        Ok(Blobs {
            store: Store::Disk(Arc::new(Disk::open(root)?)),
            signer,
        })
    }

    pub fn store_id(&self) -> String {
        self.store.id().to_string()
    }

    /// The store is attached the first time its marker is seen. A later start keeps its
    /// `attached_at`, takes the folder it is now at, and attaches it again if it was detached.
    pub async fn register(&self, db: &Db, at: String) -> std::result::Result<(), Failure> {
        let Store::Disk(disk) = &self.store;
        let id = disk.id().to_string();
        let locator = disk.root().display().to_string();
        db.write(Write::own(), move |tx| {
            rows::register_disk(tx, &id, &locator, &at)
        })
        .await
        .map_err(|refused| Failure::start(refused.to_string()))
    }
}

fn not_found() -> Refusal {
    Refusal::new(Code::BlobNotFound, "Blob not found")
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

/// Bytes in a store that no record names yet.
pub struct Placed {
    blob: Blob,
    store_id: String,
}

impl Placed {
    /// Records the blob and its copy, and the uploader's proof where there is one.
    pub fn record(
        &self,
        tx: &rusqlite::Transaction<'_>,
        holder: Option<&str>,
        at: &str,
    ) -> Result<Blob> {
        rows::record_upload(tx, &self.blob, &self.store_id, holder, at)
    }
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
                let outcome = if faults.fail(FAIL_BLOB_WRITE, None) {
                    Err(insufficient())
                } else {
                    room(&faults, disk.root(), reserve, 0)
                        .and_then(|()| staged.append(bytes.as_ref()).map_err(unwritable))
                };
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
        let disk = self.blobs.store.disk();
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

    pub fn upload_idle(&self) -> std::time::Duration {
        std::time::Duration::from_millis(self.settings.live().get(UPLOAD_IDLE_TIMEOUT_MS))
    }

    pub fn blob_read_idle(&self) -> std::time::Duration {
        std::time::Duration::from_millis(self.settings.live().get(BLOB_READ_IDLE_TIMEOUT_MS))
    }

    /// Places the bytes in the store. Nothing serves them until a record names them.
    pub async fn place_upload(&self, mut intake: Intake) -> Result<Placed> {
        let Some(mut staged) = intake.staged.take() else {
            return Err(Refusal::internal("an upload finished twice"));
        };
        let disk = intake.disk.clone();
        let (hash, size) = joined(
            tokio::task::spawn_blocking(move || {
                if staged.size() == 0 {
                    staged.discard();
                    return Ok::<_, io::Error>(None);
                }
                let placed = staged
                    .seal()
                    .and_then(|hash| disk.publish(&mut staged, &hash).map(|()| hash));
                let size = staged.size();
                staged.discard();
                placed.map(|hash| Some((hash, size)))
            })
            .await,
        )?
        .map_err(unwritable)?
        .ok_or_else(|| {
            Refusal::validation("The body is empty; send the bytes to keep.")
                .with_detail("field", "body")
        })?;
        Ok(Placed {
            blob: Blob {
                hash,
                mime_type: intake.mime_type.clone(),
                size_bytes: size,
            },
            store_id: self.blobs.store.id().to_string(),
        })
    }

    /// Places the bytes in the store, and only then records them: a file with no record is
    /// never served, and a recorded one is never removed.
    pub async fn finish_upload(&self, caller: &Caller, intake: Intake) -> Result<Blob> {
        let placed = self.place_upload(intake).await?;
        let cache = self.catalog_handle();
        self.write(caller, "blob.upload", move |unit| {
            let catalog = catalog::current(&cache, unit.tx(), Snapshot::Pending)?;
            unit.caller
                .require_upload(catalog.provenance.keys().map(String::as_str))?;
            let holder = unit.caller.credential_handle();
            placed.record(unit.tx(), Some(&holder), &unit.at)
        })
        .await
    }

    /// A blob held in the store, by a caller's right to read it where one is given.
    pub(crate) fn found_in(
        tx: &rusqlite::Transaction<'_>,
        caller: Option<&Caller>,
        hash: &Hash,
        store_id: &str,
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
        let held = rows::held_in(tx, hash, store_id)?;
        Ok(Found { blob, held })
    }

    /// A blob the caller may read; one it may not read is answered as an unknown one.
    pub async fn find_blob(&self, caller: &Caller, hash: &Hash) -> Result<Found> {
        let (caller, hash) = (caller.clone(), hash.clone());
        let store_id = self.blobs.store.id().to_string();
        self.db
            .read(move |tx| App::found_in(tx, Some(&caller), &hash, &store_id))
            .await
    }

    /// The bytes of a blob, from the store that holds them. No attached store holding a copy
    /// is an unknown blob, and a copy that will not open is a store that failed.
    pub async fn bytes_of(&self, found: &Found) -> Result<File> {
        if !found.held {
            return Err(not_found());
        }
        let (disk, hash) = (self.blobs.store.disk(), found.blob.hash.clone());
        joined(tokio::task::spawn_blocking(move || disk.open_blob(&hash)).await)?.map_err(|error| {
            tracing::error!(%error, "A recorded copy of a blob did not open");
            unavailable()
        })
    }

    pub async fn mint_link(&self, caller: &Caller, hash: &Hash, ttl: u64) -> Result<Link> {
        let found = self.find_blob(caller, hash).await?;
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
        let store_id = self.blobs.store.id().to_string();
        self.db
            .read(move |tx| App::found_in(tx, None, &hash, &store_id))
            .await
    }

    pub async fn blob_copies(&self, caller: &Caller, hash: &Hash) -> Result<Vec<CopyRecord>> {
        let (caller, hash) = (caller.clone(), hash.clone());
        let store_id = self.blobs.store.id().to_string();
        self.db
            .read(move |tx| {
                App::found_in(tx, Some(&caller), &hash, &store_id)?;
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
}
