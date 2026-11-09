//! The blobs an archive carries: the copies it can take them from, the bytes it sends, and the
//! copy it strikes when those bytes are not the blob's.

use std::collections::BTreeSet;
use std::io;

use futures_util::StreamExt;
use futures_util::future::join_all;
use rusqlite::Transaction;
use serde_json::json;

use super::disk::Scratch;
use super::rows::{self, Held};
use super::store::{self, Answer, ByteStream, Hasher, Store};
use super::{App, Blob, Hash, unavailable};
use crate::app::access::Caller;
use crate::app::faults::{FAIL_BLOB_READ, HOLD_BLOB_READ, Lie};
use crate::app::refusal::{Refusal, Result};

const CHECKS_AT_ONCE: usize = 8;

/// A blob an archive lists, and the copies the copy record named when the selection was read.
#[derive(Clone, Debug)]
pub struct Carried {
    pub blob: Blob,
    held: Vec<Held>,
}

/// What the stores answered for a listed blob.
#[derive(Debug, PartialEq, Eq)]
pub enum Copy {
    /// The store that holds a recorded copy whole.
    Whole(String),
    Missing,
}

/// The bytes of a blob as they leave a store, and the copy they come from.
pub struct Bytes {
    pub stream: ByteStream,
    store: Store,
    object: String,
}

/// The blob a caller may read, with the copies recorded in attached stores; `None` for a hash
/// the instance holds no blob of, or one the caller may not read.
pub fn carried(tx: &Transaction<'_>, caller: &Caller, hash: &Hash) -> Result<Option<Carried>> {
    let Some(blob) = rows::find(tx, hash)? else {
        return Ok(None);
    };
    if !caller.may_read_blob(rows::lenders(tx, hash))? {
        return Ok(None);
    }
    Ok(Some(Carried {
        blob,
        held: rows::holders(tx, hash)?,
    }))
}

/// Whether the caller may read the blob now.
pub fn readable(tx: &Transaction<'_>, caller: &Caller, hash: &Hash) -> Result<bool> {
    caller.may_read_blob(rows::lenders(tx, hash))
}

impl App {
    /// Asks the stores, a few blobs at a time, which recorded copy each blob is whole in. A
    /// blob whose only possible copies are in stores that failed or did not answer refuses
    /// the export, since that is no evidence the copy is gone.
    pub async fn whole_copies(&self, carried: &[Carried]) -> Result<Vec<Copy>> {
        let mut silent = BTreeSet::new();
        let mut answers = Vec::with_capacity(carried.len());
        for chunk in carried.chunks(CHECKS_AT_ONCE) {
            let mut checks = Vec::with_capacity(chunk.len());
            for one in chunk {
                checks.push(self.whole_copy(one));
            }
            for (copy, failed) in join_all(checks).await {
                if copy == Copy::Missing && !failed.is_empty() {
                    return Err(unavailable());
                }
                silent.extend(failed);
                answers.push(copy);
            }
        }
        if !silent.is_empty() {
            tracing::warn!(stores = silent.len(), "A store did not answer for a blob an export carries");
        }
        Ok(answers)
    }

    async fn whole_copy(&self, carried: &Carried) -> (Copy, Vec<String>) {
        let mut failed = Vec::new();
        for store in self.blobs.attached() {
            let Some(held) = carried.held.iter().find(|held| held.store_id == store.id()) else {
                continue;
            };
            match self
                .blobs
                .answer_of(&store, &carried.blob.hash, &held.object)
                .await
            {
                Ok(Answer::Holds(size)) if size == carried.blob.size_bytes => {
                    return (Copy::Whole(store.id().to_string()), failed);
                }
                Ok(_) => {}
                Err(failure) => {
                    tracing::warn!(store = store.kind(), ?failure, "A store did not answer for a copy");
                    failed.push(store.id().to_string());
                }
            }
        }
        (Copy::Missing, failed)
    }

    /// The bytes of a listed blob, from the store the check found it whole in or, failing that,
    /// any attached store whose recorded copy is as long as the blob. The record is read again,
    /// so a blob that has lost its record or every copy since is refused.
    pub async fn carried_bytes(&self, blob: &Blob, preferred: &str) -> Result<Bytes> {
        let hash = blob.hash.clone();
        let (record, held) = self
            .db
            .read(move |tx| Ok((rows::find(tx, &hash)?, rows::holders(tx, &hash)?)))
            .await?;
        if record.as_ref().map(|found| found.size_bytes) != Some(blob.size_bytes) {
            return Err(gone(blob));
        }
        let mut stores = self.blobs.attached();
        stores.sort_by_key(|store| store.id() != preferred);
        for store in stores {
            let Some(held) = held.iter().find(|held| held.store_id == store.id()) else {
                continue;
            };
            match self.blobs.answer_of(&store, &blob.hash, &held.object).await {
                Ok(Answer::Holds(size)) if size == blob.size_bytes => {}
                Ok(_) => continue,
                Err(failure) => {
                    tracing::warn!(store = store.kind(), ?failure, "A store did not answer for a copy");
                    continue;
                }
            }
            match self
                .blobs
                .open_bytes(&store, &blob.hash, &held.object, 0, blob.size_bytes)
                .await
            {
                Ok(stream) => {
                    return Ok(Bytes {
                        stream: store::idle_limited(stream, self.blobs.check()),
                        store,
                        object: held.object.clone(),
                    });
                }
                Err(failure) => {
                    tracing::warn!(store = store.kind(), ?failure, "A store did not open a copy");
                }
            }
        }
        Err(gone(blob))
    }

    /// Strikes the copy `bytes` came from where, read again under the blob's lock, it is as
    /// long as the blob and still does not hash to its name.
    pub async fn judge_damaged(&self, bytes: Bytes, blob: &Blob) -> Result<()> {
        let Bytes { store, object, .. } = bytes;
        let _held = self.blobs.gate.lock(&blob.hash).await;
        if self.blobs.gate.unfinished(&blob.hash) {
            return Ok(());
        }
        match self.reread(&store, &object, blob).await {
            Ok(false) => {}
            Ok(true) => return Ok(()),
            Err(error) => {
                tracing::warn!(%error, store = store.kind(), "A copy was not read again");
                return Ok(());
            }
        }
        let (hash, id, kind) = (blob.hash.clone(), store.id().to_string(), store.kind());
        self.write(&Caller::Server, "blob.copy_struck", move |unit| {
            if rows::remove_copy(unit.tx(), &hash, &id, &object, &unit.at)? {
                unit.audit(
                    "blob",
                    hash.as_str(),
                    Some(json!({ "store_id": id, "kind": kind })),
                )?;
            }
            Ok(())
        })
        .await?;
        if let Err(failure) = self.finish_deletion(&store, &blob.hash).await {
            tracing::warn!(?failure, "A struck copy's bytes wait for a later run");
        }
        Ok(())
    }

    /// Whether the copy holds the blob whole. A read that fails or ends short is an error, not
    /// an answer.
    async fn reread(&self, store: &Store, object: &str, blob: &Blob) -> io::Result<bool> {
        let read = async {
            self.faults.hold(HOLD_BLOB_READ, None).await;
            if self.faults.fail(FAIL_BLOB_READ, None) {
                return Err(io::Error::other("the store failed the read"));
            }
            let mut bytes = match store {
                Store::Disk(disk) => {
                    let lie = self.faults.lie(blob.hash.as_str());
                    match lie {
                        Some(Lie::Lost) => return Err(io::ErrorKind::NotFound.into()),
                        Some(Lie::Unreadable) => return Err(store::unreadable()),
                        Some(Lie::Damaged) | None => {}
                    }
                    let (disk, hash) = (disk.clone(), blob.hash.clone());
                    let file = tokio::task::spawn_blocking(move || disk.open_blob(&hash))
                        .await
                        .map_err(io::Error::other)??;
                    let bytes = store::file_stream(file, 0, blob.size_bytes);
                    if lie == Some(Lie::Damaged) {
                        store::first_byte_changed(bytes)
                    } else {
                        bytes
                    }
                }
                Store::S3(s3) => s3.read(object, 0, blob.size_bytes).await?,
            };
            let mut hasher = Hasher::default();
            let mut size = 0u64;
            while let Some(chunk) = bytes.next().await {
                let chunk = chunk?;
                size += chunk.len() as u64;
                hasher.update(&chunk);
            }
            if size < blob.size_bytes {
                return Err(io::ErrorKind::UnexpectedEof.into());
            }
            Ok(hasher.matches(&blob.hash, blob.size_bytes).is_ok())
        };
        let limit = store::stall_limit(store::write_deadline(self.blobs.check(), blob.size_bytes));
        match tokio::time::timeout(limit, read).await {
            Ok(answer) => answer,
            Err(_) => Err(io::Error::new(io::ErrorKind::TimedOut, "no answer in time")),
        }
    }

    /// A file of the server's own in the disk store's `tmp`.
    pub async fn scratch(&self) -> Result<Scratch> {
        let disk = self.blobs.disk.clone();
        tokio::task::spawn_blocking(move || disk.scratch())
            .await
            .map_err(|_| Refusal::internal("a scratch file was not made"))?
            .map_err(|error| Refusal::internal(&format!("a scratch file was not made: {error}")))
    }
}

fn gone(blob: &Blob) -> Refusal {
    Refusal::internal(&format!(
        "no attached store holds a recorded copy of {} whole",
        blob.hash.as_str()
    ))
}
