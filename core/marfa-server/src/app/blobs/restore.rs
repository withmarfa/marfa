//! Placed bytes stay unrecorded and queued for deletion until the restore's write records them.

use std::io;
use std::sync::Arc;

use futures_util::StreamExt;

use super::disk::{Disk, Staged};
use super::store::{self, Answer, Failed, Held, Store};
use super::{App, Blob, Hash, REPLICATE, Scratch, joined, room, rows, unavailable, unwritable};
use crate::app::faults::{Faults, HOLD_BLOB_HAS, Lie};
use crate::app::refusal::Result;
use crate::db::Write;
use crate::settings::registry::DISK_RESERVE_BYTES;

/// The disk store's `tmp`, as a restore writes into it while the body arrives. Every method
/// blocks.
#[derive(Clone)]
pub struct Spool {
    disk: Arc<Disk>,
    faults: Arc<Faults>,
    reserve: u64,
}

impl Spool {
    /// Refuses where the volume has less free than the reserve.
    pub fn room(&self, incoming: u64) -> Result<()> {
        room(&self.faults, self.disk.root(), self.reserve, incoming)
    }

    pub fn scratch(&self) -> Result<Scratch> {
        self.disk.scratch().map_err(unwritable)
    }

    pub fn stage(&self) -> Result<Arriving> {
        Ok(Arriving(self.disk.stage().map_err(unwritable)?))
    }
}

/// A blob entry's bytes as they arrive, hashed as they go.
pub struct Arriving(Staged);

impl Arriving {
    pub fn append(&mut self, spool: &Spool, bytes: &[u8]) -> Result<()> {
        spool.room(0)?;
        self.0.append(bytes).map_err(unwritable)
    }

    pub fn seal(mut self) -> Result<Sealed> {
        let hash = self.0.seal().map_err(unwritable)?;
        Ok(Sealed {
            size: self.0.size(),
            staged: self.0,
            hash,
        })
    }
}

/// A blob entry whose bytes have all arrived, named by what they hash to.
pub struct Sealed {
    staged: Staged,
    pub hash: Hash,
    pub size: u64,
}

/// A blob the archive names, with the type and size its manifest gives.
#[derive(Clone, Debug)]
pub struct Named {
    pub hash: Hash,
    pub mime_type: Option<String>,
    pub size_bytes: Option<u64>,
}

/// A copy a restore records when it commits.
#[derive(Clone, Debug)]
pub struct Copy {
    blob: Blob,
    store_id: String,
    object: String,
}

/// Where a blob the archive names and does not carry was found.
enum Absent {
    /// An attached store holds the instance's recorded copy whole.
    Held,
    /// The object store holds it under its name, checked against the name.
    Found(Copy),
    Missing,
}

/// What a restore's blobs came to before its write: the copies to record, the blobs it found
/// nowhere, and the locks it holds on every blob it names until the write ends.
pub struct Placed {
    pub copies: Vec<Copy>,
    pub imported: usize,
    pub missing: Vec<String>,
    pub replicates: bool,
    held: Vec<Held>,
}

/// Records each copy and, for a blob the instance did not hold, the blob itself, ending the
/// deletion its placing queued.
pub fn record(
    tx: &rusqlite::Transaction<'_>,
    copies: &[Copy],
    replicates: bool,
    holder: &str,
    at: &str,
) -> Result<()> {
    if replicates && !copies.is_empty() {
        super::housekeeping::bring_forward(tx, REPLICATE, at)?;
    }
    for copy in copies {
        let held = rows::find(tx, &copy.blob.hash)?.is_some();
        if !held && copy.object.is_empty() {
            rows::record_upload(tx, &copy.blob, &copy.store_id, Some(holder), at)?;
        } else {
            if !held {
                rows::record_found(tx, &copy.blob, at)?;
            }
            rows::record_copy(tx, &copy.blob.hash, &copy.store_id, &copy.object, at)?;
        }
        rows::deleted(tx, &copy.blob.hash, &copy.store_id, &copy.object)?;
    }
    Ok(())
}

/// The refusal for a spool the restore could not write.
pub fn unwritten(error: io::Error) -> crate::app::refusal::Refusal {
    unwritable(error)
}

/// The stored length of a blob the instance records.
pub fn stored_size(tx: &rusqlite::Transaction<'_>, hash: &Hash) -> Result<Option<u64>> {
    Ok(rows::find(tx, hash)?.map(|blob| blob.size_bytes))
}

impl App {
    pub fn restore_spool(&self) -> Spool {
        Spool {
            disk: self.blobs.disk.clone(),
            faults: self.faults.clone(),
            reserve: self.settings.live().get(DISK_RESERVE_BYTES),
        }
    }

    /// Refuses a declared body that would leave less free than the reserve.
    pub async fn restore_room(&self, declared: u64) -> Result<()> {
        let spool = self.restore_spool();
        joined(tokio::task::spawn_blocking(move || spool.room(declared)).await)?
    }

    /// Places the carried bytes the disk does not hold whole, and finds the named blobs the
    /// archive does not carry. Every blob named is locked until the result is dropped.
    pub async fn place_restored(
        &self,
        carried: Vec<(Sealed, String)>,
        absent: Vec<Named>,
    ) -> Result<Placed> {
        let mut hashes: Vec<Hash> = carried
            .iter()
            .map(|(sealed, _)| sealed.hash.clone())
            .chain(absent.iter().map(|named| named.hash.clone()))
            .collect();
        hashes.sort_by(|a, b| a.as_str().cmp(b.as_str()));
        hashes.dedup();
        let mut held = Vec::with_capacity(hashes.len());
        for hash in &hashes {
            if self.blobs.gate.unfinished(hash) {
                return Err(unavailable());
            }
            held.push(self.blobs.gate.lock(hash).await);
            if self.blobs.gate.unfinished(hash) {
                return Err(unavailable());
            }
        }
        let disk = Store::Disk(self.blobs.disk.clone());
        let disk_id = self.blobs.disk.id().to_string();
        let mut copies = Vec::new();
        let mut placing = Vec::new();
        let imported = carried.len();
        for (sealed, mime_type) in carried {
            let hash = sealed.hash.clone();
            let looked = hash.clone();
            let recorded = self
                .db
                .read(move |tx| rows::holders(tx, &looked))
                .await?
                .iter()
                .any(|copy| copy.store_id == disk_id);
            let whole = recorded && self.disk_holds_whole(&hash).await;
            let blob = Blob {
                hash,
                mime_type,
                size_bytes: sealed.size,
            };
            if recorded && whole {
                let staged = sealed.staged;
                let _ = tokio::task::spawn_blocking(move || staged.discard()).await;
                copies.push(Copy {
                    blob,
                    store_id: disk_id.clone(),
                    object: String::new(),
                });
                continue;
            }
            if let Err(failure) = self.finish_deletion(&disk, &blob.hash).await {
                tracing::warn!(
                    ?failure,
                    "A queued deletion of restored bytes did not finish"
                );
                return Err(unavailable());
            }
            placing.push((sealed.staged, blob, recorded));
        }
        let queued: Vec<Hash> = placing
            .iter()
            .filter(|(_, _, recorded)| !recorded)
            .map(|(_, blob, _)| blob.hash.clone())
            .collect();
        if !queued.is_empty() {
            let (store_id, at) = (self.blobs.disk.id().to_string(), self.clock.stamp());
            self.db
                .write(Write::own(), move |tx| {
                    for hash in &queued {
                        rows::queue_deletion(tx, hash, &store_id, "", &at)?;
                    }
                    Ok(())
                })
                .await?;
        }
        for (staged, blob, _) in placing {
            self.publish_restored(staged, &blob.hash, blob.size_bytes)
                .await?;
            copies.push(Copy {
                blob,
                store_id: self.blobs.disk.id().to_string(),
                object: String::new(),
            });
        }
        let mut missing = Vec::new();
        for named in absent {
            match self.find_absent(&named).await? {
                Absent::Held => {}
                Absent::Found(copy) => copies.push(copy),
                Absent::Missing => missing.push(named.hash.as_str().to_string()),
            }
        }
        Ok(Placed {
            copies,
            imported,
            missing,
            held,
            replicates: self.blobs.s3.is_some(),
        })
    }

    async fn publish_restored(&self, staged: Staged, hash: &Hash, size: u64) -> Result<()> {
        let (target, placed, faults) = (self.blobs.disk.clone(), hash.clone(), self.faults.clone());
        let mut staged = staged;
        self.blobs
            .writing(hash, size, async move {
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
            })
    }

    /// Whether the disk's file for `hash` reads through to that hash.
    async fn disk_holds_whole(&self, hash: &Hash) -> bool {
        let damaged = match self.faults.lie(hash.as_str()) {
            Some(Lie::Lost | Lie::Unreadable) => return false,
            Some(Lie::Damaged) => true,
            None => false,
        };
        let (disk, looked) = (self.blobs.disk.clone(), hash.clone());
        let read = tokio::task::spawn_blocking(move || disk.rehash(&looked, damaged)).await;
        matches!(read, Ok(Ok(Some((_, found)))) if &found == hash)
    }

    /// A store that fails or stays silent, where none answers whole, refuses the restore.
    async fn find_absent(&self, named: &Named) -> Result<Absent> {
        let looked = named.hash.clone();
        let (record, holders) = self
            .db
            .read(move |tx| Ok((rows::find(tx, &looked)?, rows::holders(tx, &looked)?)))
            .await?;
        let mut failed = false;
        if let Some(blob) = &record {
            for copy in &holders {
                let Some(store) = self.blobs.store(&copy.store_id) else {
                    continue;
                };
                match self.blobs.answer_of(&store, &blob.hash, &copy.object).await {
                    Ok(Answer::Holds(size)) if size == blob.size_bytes => return Ok(Absent::Held),
                    Ok(_) => {}
                    Err(failure) => {
                        tracing::warn!(
                            ?failure,
                            store = store.kind(),
                            "A store did not answer for a restored blob"
                        );
                        failed = true;
                    }
                }
            }
        }
        if failed {
            return Err(unavailable());
        }
        let Some(s3) = self.blobs.s3.clone() else {
            return Ok(Absent::Missing);
        };
        let check = self.blobs.check();
        let hash = named.hash.clone();
        let faults = self.faults.clone();
        let listed = async {
            faults.hold(HOLD_BLOB_HAS, None).await;
            let mut whole = Vec::new();
            for (object, size) in s3.objects_of(&hash).await? {
                let named = object
                    .strip_prefix(hash.hex())
                    .and_then(|rest| rest.strip_prefix('/'))
                    .is_some_and(|write| {
                        !write.is_empty() && write.bytes().all(|byte| byte.is_ascii_hexdigit())
                    });
                if named
                    && matches!(s3.answer_for(&object).await?, Answer::Holds(held) if held == size)
                {
                    whole.push((object, size));
                }
            }
            Ok::<_, io::Error>(whole)
        };
        let silent = || io::Error::new(io::ErrorKind::TimedOut, "no answer in time");
        let listed = tokio::time::timeout(check, listed)
            .await
            .unwrap_or_else(|_| Err(silent()));
        let mut found = None;
        let candidates = listed.map_err(|error| {
            tracing::warn!(%error, "The object store did not answer for a restored blob");
            unavailable()
        })?;
        for (object, size) in candidates {
            // The read may take as long as its bytes keep arriving; only its start is timed.
            let checked = async {
                let opened = tokio::time::timeout(check, s3.read(&object, 0, size))
                    .await
                    .unwrap_or_else(|_| Err(silent()))?;
                let mut bytes = store::idle_limited(opened, check);
                let mut hasher = store::Hasher::default();
                while let Some(chunk) = bytes.next().await {
                    hasher.update(&chunk?);
                }
                Ok::<_, io::Error>(hasher.matches(&hash, size).is_ok())
            };
            match checked.await {
                Ok(true) => {
                    found = Some((object, size));
                    break;
                }
                Ok(false) => {}
                Err(error) => {
                    tracing::warn!(%error, "The object store did not answer for a restored blob");
                    return Err(unavailable());
                }
            }
        }
        let Some((object, size)) = found else {
            return Ok(Absent::Missing);
        };
        let blob = match record {
            Some(blob) => blob,
            None => Blob {
                hash: named.hash.clone(),
                mime_type: named
                    .mime_type
                    .clone()
                    .unwrap_or_else(|| super::DEFAULT_TYPE.to_string()),
                size_bytes: size,
            },
        };
        Ok(Absent::Found(Copy {
            blob,
            store_id: s3.id().to_string(),
            object,
        }))
    }
}

impl Placed {
    /// Starts copying to other stores if the write committed.
    pub fn release(self, app: &App, committed: bool) {
        drop(self.held);
        if committed && self.replicates && !self.copies.is_empty() {
            super::housekeeping::wake(app);
        }
    }
}
