//! What every store does with a blob's bytes, within the time a store is given to answer, and
//! the lock that keeps two changes to one blob's bytes apart.

use std::collections::HashMap;
use std::future::Future;
use std::io;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use bytes::Bytes;
use futures_util::StreamExt;
use futures_util::stream::{self, BoxStream};
use sha2::{Digest, Sha256};
use tokio::sync::OwnedMutexGuard;

use super::disk::Disk;
use super::hash::Hash;
use super::s3::S3;

pub type ByteStream = BoxStream<'static, io::Result<Bytes>>;

/// How long a store is given to answer whether it holds a blob, or to begin a read.
pub const CHECK_DEADLINE: Duration = Duration::from_secs(15);
/// A write or a read through is given a second more for each of these.
const BYTES_PER_SECOND: u64 = 256 * 1024;
const CHUNK: usize = 256 * 1024;

/// Where a blob's bytes live.
#[derive(Clone, Debug)]
pub enum Store {
    Disk(Arc<Disk>),
    S3(Arc<S3>),
}

impl Store {
    pub fn id(&self) -> &str {
        match self {
            Store::Disk(disk) => disk.id(),
            Store::S3(s3) => s3.id(),
        }
    }

    pub fn kind(&self) -> &'static str {
        match self {
            Store::Disk(_) => "disk",
            Store::S3(_) => "s3",
        }
    }
}

/// A store that did not answer in time, or answered with a failure.
#[derive(Debug)]
pub enum Failed {
    Late,
    Io(io::Error),
}

impl From<io::Error> for Failed {
    fn from(error: io::Error) -> Failed {
        Failed::Io(error)
    }
}

pub fn write_deadline(check: Duration, size: u64) -> Duration {
    check + Duration::from_secs(size / BYTES_PER_SECOND)
}

fn held<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// One lock per blob for every change to its bytes, and the blobs a store is still writing
/// or deleting after the server stopped waiting for it.
#[derive(Debug, Default)]
pub struct Gate {
    locks: Mutex<HashMap<Hash, Arc<tokio::sync::Mutex<()>>>>,
    unfinished: Mutex<HashMap<Hash, u32>>,
}

/// A blob's lock, given up when this goes.
pub struct Held {
    gate: Arc<Gate>,
    hash: Hash,
    guard: Option<OwnedMutexGuard<()>>,
}

impl Drop for Held {
    fn drop(&mut self) {
        self.guard.take();
        let mut locks = held(&self.gate.locks);
        if locks
            .get(&self.hash)
            .is_some_and(|lock| Arc::strong_count(lock) == 1)
        {
            locks.remove(&self.hash);
        }
    }
}

impl Gate {
    pub async fn lock(self: &Arc<Gate>, hash: &Hash) -> Held {
        let lock = held(&self.locks).entry(hash.clone()).or_default().clone();
        let guard = lock.lock_owned().await;
        Held {
            gate: self.clone(),
            hash: hash.clone(),
            guard: Some(guard),
        }
    }

    pub fn unfinished(&self, hash: &Hash) -> bool {
        held(&self.unfinished).contains_key(hash)
    }

    fn mark(&self, hash: &Hash) {
        *held(&self.unfinished).entry(hash.clone()).or_default() += 1;
    }

    fn unmark(&self, hash: &Hash) {
        let mut unfinished = held(&self.unfinished);
        if let Some(count) = unfinished.get_mut(hash) {
            *count -= 1;
            if *count == 0 {
                unfinished.remove(hash);
            }
        }
    }

    /// Runs a write or a deletion on a task of its own and waits `deadline` for it. One that
    /// takes longer goes on, and its blob stays unfinished until it ends.
    pub async fn outlast<T, W>(
        self: &Arc<Gate>,
        hash: &Hash,
        deadline: Duration,
        work: W,
    ) -> Result<T, Failed>
    where
        T: Send + 'static,
        W: Future<Output = io::Result<T>> + Send + 'static,
    {
        #[derive(PartialEq)]
        enum Phase {
            Running,
            Late,
            Done,
        }
        let phase = Arc::new(Mutex::new(Phase::Running));
        let (gate, blob, watched) = (self.clone(), hash.clone(), phase.clone());
        let mut task = tokio::spawn(async move {
            let outcome = work.await;
            let mut phase = held(&watched);
            if *phase == Phase::Late {
                gate.unmark(&blob);
            }
            *phase = Phase::Done;
            outcome
        });
        let joined = match tokio::time::timeout(deadline, &mut task).await {
            Ok(joined) => joined,
            Err(_) => {
                {
                    let mut phase = held(&phase);
                    if *phase != Phase::Done {
                        *phase = Phase::Late;
                        self.mark(hash);
                        return Err(Failed::Late);
                    }
                }
                task.await
            }
        };
        joined
            .map_err(|error| Failed::Io(io::Error::other(error)))?
            .map_err(Failed::Io)
    }
}

/// Hashes bytes as they pass, to check them against the name they are sent under.
#[derive(Default)]
pub struct Hasher {
    digest: Sha256,
    size: u64,
}

impl Hasher {
    pub fn update(&mut self, bytes: &[u8]) {
        self.digest.update(bytes);
        self.size += bytes.len() as u64;
    }

    pub fn matches(&self, hash: &Hash, size: u64) -> io::Result<()> {
        if self.size == size && Hash::from_digest(&self.digest.clone().finalize()) == *hash {
            return Ok(());
        }
        Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "the bytes do not hash to the blob's name",
        ))
    }
}

/// A window of a file, read a chunk at a time off the runtime.
pub fn file_stream(file: std::fs::File, first: u64, length: u64) -> ByteStream {
    use std::os::unix::fs::FileExt;
    let file = Arc::new(file);
    stream::unfold((file, first, length), |(file, at, left)| async move {
        if left == 0 {
            return None;
        }
        let want = usize::try_from(left).map_or(CHUNK, |left| left.min(CHUNK));
        let reader = file.clone();
        let read = tokio::task::spawn_blocking(move || {
            let mut buffer = vec![0; want];
            let count = reader.read_at(&mut buffer, at)?;
            buffer.truncate(count);
            Ok::<_, io::Error>(buffer)
        })
        .await;
        let chunk = match read {
            Ok(Ok(buffer)) if !buffer.is_empty() => buffer,
            Ok(Ok(_)) => return Some((Err(io::ErrorKind::UnexpectedEof.into()), (file, at, 0))),
            Ok(Err(error)) => return Some((Err(error), (file, at, 0))),
            Err(error) => return Some((Err(io::Error::other(error)), (file, at, 0))),
        };
        let count = chunk.len() as u64;
        Some((Ok(Bytes::from(chunk)), (file, at + count, left - count)))
    })
    .boxed()
}

/// Writes a stream to the disk store, and places it only once it hashes to `hash`.
pub async fn place_on_disk(
    disk: Arc<Disk>,
    hash: Hash,
    size: u64,
    mut bytes: ByteStream,
) -> io::Result<()> {
    let mut staged = {
        let disk = disk.clone();
        tokio::task::spawn_blocking(move || disk.stage())
            .await
            .map_err(io::Error::other)??
    };
    while let Some(chunk) = bytes.next().await {
        let chunk = chunk?;
        staged = tokio::task::spawn_blocking(move || staged.append(&chunk).map(|()| staged))
            .await
            .map_err(io::Error::other)??;
    }
    tokio::task::spawn_blocking(move || {
        let sealed = staged.seal()?;
        if sealed != hash || staged.size() != size {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "the bytes do not hash to the blob's name",
            ));
        }
        disk.publish(&mut staged, &hash)
    })
    .await
    .map_err(io::Error::other)?
}
