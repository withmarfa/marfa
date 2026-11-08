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

/// What a store answered for one copy's bytes.
#[derive(Debug, PartialEq, Eq)]
pub enum Answer {
    Missing,
    /// Bytes of this size that the store wrote itself.
    Holds(u64),
    /// An object the store did not write, so not the copy.
    Foreign,
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

/// Bounds background work after its caller stops waiting.
pub fn stall_limit(deadline: Duration) -> Duration {
    deadline * 4
}

/// Runs work against an object store, which ends as a failure once it outlasts `limit`.
pub async fn within<T>(
    limit: Duration,
    work: impl Future<Output = io::Result<T>>,
) -> io::Result<T> {
    tokio::time::timeout(limit, work).await.unwrap_or_else(|_| {
        Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "the object store stalled",
        ))
    })
}

/// `bytes`, failing once the next chunk takes longer than `idle` to arrive.
pub fn idle_limited(bytes: ByteStream, idle: Duration) -> ByteStream {
    stream::unfold(Some(bytes), move |bytes| async move {
        let mut bytes = bytes?;
        match tokio::time::timeout(idle, bytes.next()).await {
            Ok(Some(chunk)) => Some((chunk, Some(bytes))),
            Ok(None) => None,
            Err(_) => Some((
                Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "the store stopped sending",
                )),
                None,
            )),
        }
    })
    .boxed()
}

fn held<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// One lock per blob for every change to its bytes, and the blobs with a write or a deletion
/// still running after the server stopped waiting for it.
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

    /// A timed-out or dropped wait keeps the blob unfinished until the work ends.
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
        let phase = Arc::new(Mutex::new(Phase::Running));
        let ending = Ending {
            gate: self.clone(),
            hash: hash.clone(),
            phase: phase.clone(),
        };
        let mut task = tokio::spawn(async move {
            let _ending = ending;
            work.await
        });
        let waiting = Waiting {
            gate: self.clone(),
            hash: hash.clone(),
            phase,
        };
        let joined = match tokio::time::timeout(deadline, &mut task).await {
            Ok(joined) => joined,
            Err(_) => {
                if waiting.leave() {
                    return Err(Failed::Late);
                }
                task.await
            }
        };
        joined
            .map_err(|error| Failed::Io(io::Error::other(error)))?
            .map_err(Failed::Io)
    }
}

#[derive(PartialEq)]
enum Phase {
    Running,
    Late,
    Done,
}

/// Held by the work, which ends with it even by a panic, and frees a blob left unfinished.
struct Ending {
    gate: Arc<Gate>,
    hash: Hash,
    phase: Arc<Mutex<Phase>>,
}

impl Drop for Ending {
    fn drop(&mut self) {
        let mut phase = held(&self.phase);
        if *phase == Phase::Late {
            self.gate.unmark(&self.hash);
        }
        *phase = Phase::Done;
    }
}

/// Keeps unfinished work marked when its caller stops waiting.
struct Waiting {
    gate: Arc<Gate>,
    hash: Hash,
    phase: Arc<Mutex<Phase>>,
}

impl Waiting {
    /// Whether the work is still running.
    fn leave(&self) -> bool {
        let mut phase = held(&self.phase);
        if *phase == Phase::Running {
            *phase = Phase::Late;
            self.gate.mark(&self.hash);
        }
        *phase != Phase::Done
    }
}

impl Drop for Waiting {
    fn drop(&mut self) {
        self.leave();
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

/// The error a disk gives for a read it cannot make.
pub fn unreadable() -> io::Error {
    io::Error::other("EIO: the disk could not read the blob")
}

/// `bytes` with their first byte changed.
pub fn first_byte_changed(bytes: ByteStream) -> ByteStream {
    let mut first = true;
    bytes
        .map(move |chunk| {
            let chunk = chunk?;
            if !std::mem::take(&mut first) || chunk.is_empty() {
                return Ok(chunk);
            }
            let mut changed = chunk.to_vec();
            changed[0] ^= 0xff;
            Ok(Bytes::from(changed))
        })
        .boxed()
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

#[cfg(test)]
mod tests {
    use tokio::sync::oneshot;

    use super::*;

    #[tokio::test]
    async fn work_that_outlasts_its_deadline_leaves_its_blob_unfinished_until_it_ends() {
        let gate = Arc::new(Gate::default());
        let hash = Hash::from_digest(&Sha256::digest(b"slow"));
        let (finish, finished) = oneshot::channel::<()>();
        let (ended, end) = oneshot::channel::<()>();
        let work = async move {
            let _ = finished.await;
            let _ = ended.send(());
            Ok(())
        };

        let late = gate.outlast(&hash, Duration::from_millis(20), work).await;
        assert!(matches!(late, Err(Failed::Late)));
        assert!(gate.unfinished(&hash));

        finish.send(()).unwrap();
        end.await.unwrap();
        tokio::task::yield_now().await;
        let began = std::time::Instant::now();
        while gate.unfinished(&hash) && began.elapsed() < Duration::from_secs(2) {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        assert!(!gate.unfinished(&hash));
    }

    #[tokio::test]
    async fn work_whose_wait_is_dropped_leaves_its_blob_unfinished_until_it_ends() {
        let gate = Arc::new(Gate::default());
        let hash = Hash::from_digest(&Sha256::digest(b"abandoned"));
        let (finish, finished) = oneshot::channel::<()>();
        let (ended, end) = oneshot::channel::<()>();
        let work = async move {
            let _ = finished.await;
            let _ = ended.send(());
            Ok(())
        };

        let waited = tokio::time::timeout(
            Duration::from_millis(20),
            gate.outlast(&hash, Duration::from_secs(60), work),
        )
        .await;
        assert!(waited.is_err());
        assert!(gate.unfinished(&hash));

        finish.send(()).unwrap();
        end.await.unwrap();
        let began = std::time::Instant::now();
        while gate.unfinished(&hash) && began.elapsed() < Duration::from_secs(2) {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        assert!(!gate.unfinished(&hash));
    }

    #[tokio::test]
    async fn work_within_its_deadline_answers_and_marks_nothing() {
        let gate = Arc::new(Gate::default());
        let hash = Hash::from_digest(&Sha256::digest(b"quick"));
        let answer = gate
            .outlast(&hash, Duration::from_secs(5), async { Ok(7) })
            .await;
        assert!(matches!(answer, Ok(7)));
        assert!(!gate.unfinished(&hash));

        let failed = gate
            .outlast(&hash, Duration::from_secs(5), async {
                Err::<(), _>(io::Error::other("refused"))
            })
            .await;
        assert!(matches!(failed, Err(Failed::Io(_))));
        assert!(!gate.unfinished(&hash));
    }

    #[tokio::test]
    async fn a_store_that_stalls_ends_its_work_and_frees_its_blob() {
        let gate = Arc::new(Gate::default());
        let hash = Hash::from_digest(&Sha256::digest(b"stalled"));
        let stalled = within(
            Duration::from_millis(60),
            std::future::pending::<io::Result<()>>(),
        );
        let late = gate
            .outlast(&hash, Duration::from_millis(20), stalled)
            .await;
        assert!(matches!(late, Err(Failed::Late)));
        let began = std::time::Instant::now();
        while gate.unfinished(&hash) && began.elapsed() < Duration::from_secs(2) {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert!(!gate.unfinished(&hash));
    }

    #[tokio::test]
    async fn a_source_that_stops_sending_fails_the_stream_after_the_idle_limit() {
        let first = stream::once(async { Ok(Bytes::from_static(b"some")) });
        let bytes = idle_limited(
            first.chain(stream::pending()).boxed(),
            Duration::from_millis(30),
        );
        let read: Vec<io::Result<Bytes>> = bytes.collect().await;
        assert_eq!(read.len(), 2);
        assert!(matches!(&read[0], Ok(chunk) if chunk.as_ref() == b"some"));
        assert!(matches!(&read[1], Err(error) if error.kind() == io::ErrorKind::TimedOut));
    }
}
