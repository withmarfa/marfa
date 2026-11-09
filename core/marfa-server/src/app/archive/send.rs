//! Sends a prepared archive; only a whole archive finishes its body, any other end is an error.

use std::fs::File;
use std::io;
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use futures_util::StreamExt;
use sha2::{Digest, Sha256};

use super::spool::{Spooled, read_chunk};
use super::tar;
use super::{EdgeNeed, InstanceNeed, ItemNeed, Prepared, Sender};
use crate::app::App;
use crate::app::access::Caller;
use crate::app::blobs::Hash;
use crate::app::blobs::carry::{self, Carried};
use crate::app::items::{Reader, reading};

/// How many bytes of a blob pass between asking whether the credential still reads it.
const BLOB_CHECK_BYTES: usize = 1024 * 1024;

enum Stop {
    /// The client left or stopped reading; nobody is there to tell.
    Gone,
    Failed(io::Error),
}

impl From<io::Error> for Stop {
    fn from(error: io::Error) -> Stop {
        Stop::Failed(error)
    }
}

fn failed(what: &str) -> Stop {
    Stop::Failed(io::Error::other(what.to_string()))
}

struct Out<'a> {
    app: &'a App,
    caller: &'a Caller,
    sender: &'a Sender,
    mtime: u64,
    /// How long the reader may take no bytes before the archive is given up on.
    idle: Duration,
}

pub async fn archive(
    app: Arc<App>,
    caller: Caller,
    prepared: Prepared,
    sender: Sender,
    idle: Duration,
) {
    let mtime = u64::try_from(prepared.created_at.at().timestamp()).unwrap_or(0);
    let out = Out {
        app: &app,
        caller: &caller,
        sender: &sender,
        mtime,
        idle,
    };
    match out.whole(&prepared).await {
        Ok(()) => sender.finish(),
        Err(Stop::Gone) => tracing::info!("An archive export's client left or stopped reading"),
        Err(Stop::Failed(error)) => tracing::warn!(%error, "An archive export ended short"),
    }
    drop(prepared);
}

impl Out<'_> {
    async fn emit(&self, bytes: Bytes) -> Result<(), Stop> {
        match tokio::time::timeout(self.idle, self.sender.chunks.send(bytes)).await {
            Ok(Ok(())) => Ok(()),
            _ => Err(Stop::Gone),
        }
    }

    async fn header(&self, name: &str, size: u64) -> Result<(), Stop> {
        let block =
            tar::header(name, size, self.mtime).ok_or_else(|| failed("a tar name did not fit"))?;
        self.emit(Bytes::copy_from_slice(&block)).await
    }

    async fn pad(&self, size: u64) -> Result<(), Stop> {
        let padding = tar::padding(size);
        if padding > 0 {
            self.emit(Bytes::from(vec![0; padding])).await?;
        }
        Ok(())
    }

    /// Asks, in one snapshot, whether the credential stands and `check` holds of it.
    async fn holds<F>(&self, check: F) -> Result<(), Stop>
    where
        F: FnOnce(&Reader<'_, '_>) -> crate::app::refusal::Result<bool> + Send + 'static,
    {
        match reading(self.app, self.caller, check).await {
            Ok(true) => Ok(()),
            Ok(false) => Err(failed(
                "the export's credential no longer reads what it sends",
            )),
            Err(refusal) => Err(failed(&format!(
                "the export's credential ended: {}",
                refusal.message
            ))),
        }
    }

    async fn whole(&self, prepared: &Prepared) -> Result<(), Stop> {
        self.holds(|_| Ok(true)).await?;
        self.header("manifest.json", prepared.manifest.len() as u64)
            .await?;
        self.emit(Bytes::copy_from_slice(&prepared.manifest))
            .await?;
        self.pad(prepared.manifest.len() as u64).await?;
        self.lines("instance.ndjson.gz", &prepared.instance, instance_need)
            .await?;
        self.lines("items.ndjson.gz", &prepared.items, items_need)
            .await?;
        self.lines("edges.ndjson.gz", &prepared.edges, edges_need)
            .await?;
        for (carried, store) in &prepared.blobs {
            self.blob(carried, store).await?;
        }
        self.emit(Bytes::from_static(&tar::END)).await
    }

    async fn lines<N>(
        &self,
        name: &str,
        spooled: &Spooled<N>,
        need: impl Fn(&N) -> Judge,
    ) -> Result<(), Stop> {
        self.header(name, spooled.size).await?;
        let mut file = Some(spooled.open()?);
        let mut at = 0;
        for (end, needs) in &spooled.segments {
            let judge = need(needs);
            self.holds(move |read| judge(read)).await?;
            while at < *end {
                let (back, chunk) = read(file.take(), at, *end).await?;
                file = Some(back);
                at += chunk.len() as u64;
                self.emit(Bytes::from(chunk)).await?;
            }
        }
        self.pad(spooled.size).await
    }

    async fn blob(&self, carried: &Carried, store: &str) -> Result<(), Stop> {
        let blob = carried.blob.clone();
        self.blob_readable(&blob.hash).await?;
        let mut bytes = self
            .app
            .carried_bytes(&blob, store)
            .await
            .map_err(|refusal| failed(&refusal.message))?;
        self.header(&format!("blobs/{}", blob.hash.as_str()), blob.size_bytes)
            .await?;
        let mut digest = Sha256::new();
        let mut read = 0u64;
        let mut held: Option<Bytes> = None;
        let mut since = 0usize;
        while let Some(chunk) = bytes.stream.next().await {
            let chunk = chunk?;
            read += chunk.len() as u64;
            if read > blob.size_bytes {
                return Err(failed("a store sent more bytes than the blob holds"));
            }
            digest.update(&chunk);
            if let Some(previous) = held.replace(chunk) {
                since += previous.len();
                self.emit(previous).await?;
                if since >= BLOB_CHECK_BYTES {
                    since = 0;
                    self.blob_readable(&blob.hash).await?;
                }
            }
        }
        if read < blob.size_bytes {
            return Err(failed("a store ended a blob's bytes short"));
        }
        if Hash::from_digest(&digest.finalize()) != blob.hash {
            if let Err(refusal) = self.app.judge_damaged(bytes, &blob).await {
                tracing::warn!(message = %refusal.message, "A damaged copy was not judged");
            }
            return Err(failed("a blob's bytes do not hash to its name"));
        }
        if let Some(last) = held {
            self.emit(last).await?;
        }
        self.pad(blob.size_bytes).await
    }

    async fn blob_readable(&self, hash: &Hash) -> Result<(), Stop> {
        let hash = hash.clone();
        self.holds(move |read| carry::readable(read.tx, &read.caller, &hash))
            .await
    }
}

fn items_need(need: &ItemNeed) -> Judge {
    let need = need.clone();
    Box::new(move |read| {
        let caller = &read.caller;
        let levers = caller.levers()?;
        Ok(need.rows.iter().all(|(type_id, source)| {
            caller.may_read_type(type_id) && levers.lists(&read.catalog.rules, type_id, source)
        }) && need
            .namespaces
            .iter()
            .all(|name| caller.may_read_extension(name))
            && need
                .types
                .iter()
                .all(|type_id| caller.may_read_type(type_id)))
    })
}

fn instance_need(need: &InstanceNeed) -> Judge {
    let need = need.clone();
    Box::new(move |read| {
        let caller = &read.caller;
        let levers = caller.levers()?;
        Ok(need
            .permissions
            .iter()
            .all(|permission| caller.holds(*permission))
            && need.sources.iter().all(|(source, types)| {
                types.iter().any(|type_id| {
                    caller.may_read_type(type_id)
                        && levers.lists(&read.catalog.rules, type_id, source)
                })
            })
            && need.rows.iter().all(|(type_id, source)| {
                caller.may_read_type(type_id) && levers.lists(&read.catalog.rules, type_id, source)
            }))
    })
}

fn edges_need(need: &EdgeNeed) -> Judge {
    let need = need.clone();
    Box::new(move |read| {
        Ok(need
            .0
            .iter()
            .all(|(edge_type, source_type)| read.caller.may_read_edge(edge_type, source_type)))
    })
}

/// Whether the export's credential still reads one segment.
type Judge = Box<dyn Fn(&Reader<'_, '_>) -> crate::app::refusal::Result<bool> + Send>;

async fn read(file: Option<File>, at: u64, end: u64) -> Result<(File, Vec<u8>), Stop> {
    let mut file = file.ok_or_else(|| failed("a spool file was lost"))?;
    let read = tokio::task::spawn_blocking(move || {
        let chunk = read_chunk(&mut file, at, end);
        chunk.map(|chunk| (file, chunk))
    })
    .await
    .map_err(|_| failed("a spool read stopped"))??;
    Ok(read)
}
