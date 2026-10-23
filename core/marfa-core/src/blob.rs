use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::{Duration, SystemTime};

use sha2::{Digest, Sha256};
use ureq::Agent;

use crate::Result;
use crate::error::CoreError;
use crate::http::{Call, CallBody, Http, Method};

const PREFIX: &str = "sha256:";

/// The most bytes one fetch pulls. The cache as a whole is bounded by the
/// file budget, not by this.
pub(crate) const CACHE_MOST: u64 = 512 * 1024 * 1024;

pub(crate) struct Cache {
    dir: PathBuf,
    #[cfg(unix)]
    parent: Option<crate::directory::Directory>,
    #[cfg(unix)]
    directory: std::sync::OnceLock<crate::directory::Directory>,
    /// Held while bytes are taken in for an upload and queued, while the
    /// cache is trimmed, and while fetched bytes take their name, so a trim
    /// never takes bytes an upload is about to name and a fetch never marks
    /// them out of backups.
    settling: Mutex<()>,
    /// The bytes callers are reading, by name, with how many read each,
    /// shared by every handle in the process on the same folder. Held by a
    /// removal from the moment it reads the set until it is done, so a caller
    /// that joins the set either is seen or finds its bytes gone and fetches
    /// them again.
    reading: Readers,
}

type ReadingSet = Mutex<HashMap<String, usize>>;
type Readers = Arc<ReadingSet>;

/// Which folder of fetched files a set of readers is for.
#[derive(PartialEq, Eq)]
enum Folder {
    /// The device and inode of the folder holding the store, and the store's
    /// file name.
    In(u64, u64, std::ffi::OsString),
    /// Where the folder holding the store cannot be read.
    Named(PathBuf),
}

/// The set of readers every handle on `folder` shares.
fn readers_of(folder: Folder) -> Readers {
    static SHARED: Mutex<Vec<(Folder, Weak<ReadingSet>)>> = Mutex::new(Vec::new());
    let mut shared = SHARED
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    shared.retain(|(_, readers)| readers.strong_count() > 0);
    if let Some(readers) = shared
        .iter()
        .find(|(held, _)| *held == folder)
        .and_then(|(_, readers)| readers.upgrade())
    {
        return readers;
    }
    let readers = Readers::default();
    shared.push((folder, Arc::downgrade(&readers)));
    readers
}

/// Keeps a caller's bytes from every removal until it is dropped.
#[derive(Debug)]
pub(crate) struct Reading {
    readers: Readers,
    name: String,
}

impl Drop for Reading {
    fn drop(&mut self) {
        let mut reading = self
            .readers
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(count) = reading.get_mut(&self.name) {
            *count -= 1;
            if *count == 0 {
                reading.remove(&self.name);
            }
        }
    }
}

/// Bytes taken in for an upload: the name they are held under and their
/// length.
pub(crate) struct Taken {
    pub(crate) hash: String,
    pub(crate) size: u64,
}

/// Bytes fetched and kept.
#[derive(Debug)]
pub(crate) struct Fetched {
    pub(crate) path: PathBuf,
    pub(crate) mark: Mark,
}

/// Whether fetched bytes were kept out of backups.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Mark {
    Excluded,
    /// The system refused the mark, for this reason.
    Refused(String),
    /// A queued upload names the bytes, so they stay in backups.
    Kept,
}

/// Why bytes did not arrive whole: the source failed, or the cache did.
enum Copy {
    Source(io::Error),
    Cache(io::Error),
}

impl Cache {
    pub(crate) fn beside(store: &Path) -> Cache {
        let holder = store
            .parent()
            .filter(|holder| !holder.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        let folder = match (fs::metadata(holder), store.file_name()) {
            #[cfg(unix)]
            (Ok(held), Some(name)) => {
                use std::os::unix::fs::MetadataExt;
                Folder::In(held.dev(), held.ino(), name.to_owned())
            }
            _ => Folder::Named(fs::canonicalize(holder).map_or_else(
                |_| store.to_path_buf(),
                |holder| holder.join(store.file_name().unwrap_or_default()),
            )),
        };
        Self::for_folder(store, folder)
    }

    fn for_folder(store: &Path, folder: Folder) -> Cache {
        let mut name = store.as_os_str().to_owned();
        name.push(".blobs");
        Cache {
            dir: PathBuf::from(name),
            #[cfg(unix)]
            parent: None,
            #[cfg(unix)]
            directory: std::sync::OnceLock::new(),
            settling: Mutex::new(()),
            reading: readers_of(folder),
        }
    }

    #[cfg(unix)]
    pub(crate) fn anchored(
        parent: &crate::directory::Directory,
        label: &Path,
        create: bool,
    ) -> Result<Self> {
        use std::os::unix::fs::MetadataExt;
        let folder = match parent.metadata() {
            Ok(held) => Folder::In(held.dev(), held.ino(), "core.sqlite".into()),
            Err(_) => Folder::Named(label.to_path_buf()),
        };
        let mut cache = Self::for_folder(label, folder);
        cache.parent = Some(parent.clone());
        match parent.child(Path::new("core.sqlite.blobs"), create) {
            Ok(directory) => {
                let _ = cache.directory.set(directory);
            }
            Err(error) if !create && error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(cache.unwritable(error)),
        }
        Ok(cache)
    }

    #[cfg(unix)]
    fn capability(&self, create: bool) -> io::Result<Option<&crate::directory::Directory>> {
        let Some(parent) = &self.parent else {
            return Ok(None);
        };
        if let Some(directory) = self.directory.get() {
            return Ok(Some(directory));
        }
        let directory = parent.child(Path::new("core.sqlite.blobs"), create)?;
        let _ = self.directory.set(directory);
        Ok(self.directory.get())
    }

    fn open_label(&self, label: &Path, write: bool, create: bool) -> io::Result<File> {
        #[cfg(unix)]
        if let Some(directory) = self.capability(create)? {
            use rustix::fs::{Mode, OFlags};
            let relative = label.strip_prefix(&self.dir).map_err(|_| {
                io::Error::new(io::ErrorKind::InvalidInput, "not a cache entry label")
            })?;
            let flags = if create {
                OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL
            } else if write {
                OFlags::WRONLY
            } else {
                OFlags::RDONLY
            };
            return directory.open_file(relative, flags, Mode::from_raw_mode(0o600));
        }
        File::options()
            .read(!write && !create)
            .write(write || create)
            .create_new(create)
            .open(label)
    }

    pub(crate) fn open_held(&self, hash: &str) -> io::Result<File> {
        let name = hex_of(hash)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error.to_string()))?;
        self.open_label(&self.dir.join(name), false, false)
    }

    fn unlink_label(&self, label: &Path) -> io::Result<()> {
        #[cfg(unix)]
        if let Some(directory) = self.capability(false)? {
            let relative = label.strip_prefix(&self.dir).map_err(|_| {
                io::Error::new(io::ErrorKind::InvalidInput, "not a cache entry label")
            })?;
            return directory.unlink(relative);
        }
        fs::remove_file(label)
    }

    fn entries(&self) -> io::Result<Vec<PathBuf>> {
        #[cfg(unix)]
        if let Some(directory) = self.capability(false)? {
            return Ok(directory
                .entries()?
                .into_iter()
                .map(|name| self.dir.join(name))
                .collect());
        }
        fs::read_dir(&self.dir)?
            .map(|entry| entry.map(|entry| entry.path()))
            .collect()
    }

    pub(crate) fn hold(&self) -> MutexGuard<'_, ()> {
        self.settling
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn readers(&self) -> MutexGuard<'_, HashMap<String, usize>> {
        self.reading
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Keeps `hash`'s bytes from every removal while the answer is held. Taken
    /// before the bytes are looked for or fetched.
    pub(crate) fn reading(&self, hash: &str) -> Result<Reading> {
        let name = hex_of(hash)?.to_string();
        *self.readers().entry(name.clone()).or_default() += 1;
        Ok(Reading {
            readers: Arc::clone(&self.reading),
            name,
        })
    }

    /// Marks held bytes as just read, so a trim takes the bytes read longest
    /// ago first.
    pub(crate) fn touch(&self, path: &Path) {
        let _ = self
            .open_label(path, true, false)
            .and_then(|file| file.set_modified(SystemTime::now()));
    }

    /// Called under `hold`, with `kept` read under it. Bytes a caller is
    /// reading stay too.
    pub(crate) fn let_go(&self, hash: &str, kept: &HashSet<String>) {
        let Ok(hex) = hex_of(hash) else {
            return;
        };
        let reading = self.readers();
        if !kept.contains(hex) && !reading.contains_key(hex) {
            let _ = self.unlink_label(&self.dir.join(hex));
        }
    }

    /// What the cache holds: every kept blob, nothing still arriving. Each
    /// entry is read by `stat`, never opened, so a large cache costs no open
    /// per file.
    fn scan(&self) -> Vec<(SystemTime, u64, PathBuf)> {
        let Ok(entries) = self.entries() else {
            return Vec::new();
        };
        let mut found = Vec::new();
        for entry in entries {
            let name = entry.file_name().unwrap_or_default().to_string_lossy();
            if name.starts_with(".incoming-") {
                continue;
            }
            let Ok((file, size, read)) = self.stat_label(&entry) else {
                continue;
            };
            if file {
                found.push((read, size, entry));
            }
        }
        found
    }

    /// Whether the entry is a regular file, its length and when it was last
    /// read, following no link.
    fn stat_label(&self, label: &Path) -> io::Result<(bool, u64, SystemTime)> {
        #[cfg(unix)]
        if let Some(directory) = self.capability(false)? {
            let relative = label.strip_prefix(&self.dir).map_err(|_| {
                io::Error::new(io::ErrorKind::InvalidInput, "not a cache entry label")
            })?;
            let (kind, size, read) = directory.entry_stat(relative)?;
            return Ok((kind == crate::directory::FileType::RegularFile, size, read));
        }
        let metadata = fs::symlink_metadata(label)?;
        Ok((
            metadata.is_file(),
            metadata.len(),
            metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
        ))
    }

    /// The bytes of every blob kept.
    pub(crate) fn held_bytes(&self) -> u64 {
        self.scan().iter().map(|(_, size, _)| size).sum()
    }

    /// The volume holding the cache: read through the folder held open
    /// where the cache is anchored, so a path that now names another place
    /// does not change the answer.
    pub(crate) fn volume(&self) -> Option<crate::file_cache::Volume> {
        use crate::file_cache::{Place, read_volume};
        #[cfg(unix)]
        if let Some(parent) = &self.parent {
            return match self.capability(false) {
                Ok(Some(directory)) => read_volume(Place::Held(directory.file())),
                _ => read_volume(Place::Held(parent.file())),
            };
        }
        read_volume(Place::Named(&self.dir))
    }

    /// Takes the bytes read longest ago until what is left fits the budget
    /// `budget` gives for the bytes held, and answers how many it took.
    /// Bytes named in `kept`, and bytes a caller is reading, stay whatever
    /// the budget, and `None` takes nothing. Called under `hold`, with `kept`
    /// read under it.
    pub(crate) fn trim(
        &self,
        kept: &HashSet<String>,
        budget: impl FnOnce(u64) -> Option<u64>,
    ) -> u64 {
        let reading = self.readers();
        let found = self.scan();
        let mut total: u64 = found.iter().map(|(_, size, _)| size).sum();
        let Some(most) = budget(total) else {
            return 0;
        };
        let mut held: Vec<_> = found
            .into_iter()
            .filter(|(_, _, path)| {
                let name = path.file_name().unwrap_or_default().to_string_lossy();
                !kept.contains(name.as_ref()) && !reading.contains_key(name.as_ref())
            })
            .collect();
        held.sort();
        let mut taken = 0;
        for (_, size, path) in held {
            if total <= most {
                break;
            }
            if self.unlink_label(&path).is_ok() {
                total -= size;
                taken += size;
            }
        }
        taken
    }

    pub(crate) fn held(&self, hash: &str) -> Result<Option<PathBuf>> {
        let path = self.dir.join(hex_of(hash)?);
        match self.open_held(hash) {
            Ok(_) => Ok(Some(path)),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(self.unwritable(error)),
        }
    }

    /// The copy is what an upload later streams from, so a file the person
    /// changes or deletes after asking does not change what is sent.
    pub(crate) fn take_reader(&self, source: &Path, file: impl Read) -> Result<Taken> {
        let unreadable = |error: io::Error| {
            CoreError::Invalid(format!("{} cannot be read: {error}", source.display()))
        };
        let (hash, size, incoming) = self.copy_in(file).map_err(|error| match error {
            Copy::Source(error) => unreadable(error),
            Copy::Cache(error) => self.unwritable(error),
        })?;
        if size == 0 {
            let _ = self.unlink_label(&incoming);
            return Err(CoreError::Invalid(format!(
                "{} is empty, and the server holds no empty blob",
                source.display()
            )));
        }
        self.settle(&incoming, &hash)?;
        Ok(Taken { hash, size })
    }

    pub(crate) fn requires_descriptor(&self) -> bool {
        #[cfg(unix)]
        return self.parent.is_some();
        #[cfg(not(unix))]
        false
    }

    /// A process that ended mid-copy leaves its file behind, and only its age
    /// tells it from a copy still being written.
    pub(crate) fn sweep_incoming(&self, older_than: Duration) {
        let Ok(entries) = self.entries() else {
            return;
        };
        for entry in entries {
            let stale = entry
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .starts_with(".incoming-")
                && self
                    .open_label(&entry, false, false)
                    .and_then(|file| file.metadata()?.modified())
                    .is_ok_and(|modified| modified.elapsed().is_ok_and(|age| age > older_than));
            if stale {
                let _ = self.unlink_label(&entry);
            }
        }
    }

    /// `kept` reads the hashes queued uploads name, and is called under
    /// `hold`.
    pub(crate) fn keep(
        &self,
        hash: &str,
        bytes: impl Read,
        kept: impl FnOnce() -> Option<HashSet<String>>,
    ) -> Result<Fetched> {
        let hex = hex_of(hash)?;
        let (found, _, incoming) = self.copy_in(bytes).map_err(|error| match error {
            Copy::Source(error) => CoreError::BytesAbsent {
                hash: hash.to_string(),
                reason: format!("the bytes stopped arriving: {error}"),
            },
            Copy::Cache(error) => self.unwritable(error),
        })?;
        if found != hash {
            let _ = self.unlink_label(&incoming);
            return Err(CoreError::Decoding(format!(
                "the bytes fetched for {hash} hash to {found}, so they are not the blob asked for"
            )));
        }
        #[cfg(debug_assertions)]
        crate::fault::hold(|| format!("blob-arrived:{hash}"));
        // Fetched bytes can be fetched again, so no backup needs them. But an
        // upload of the same bytes may have been queued while they arrived,
        // and its file, the only copy until the server has it, is the one
        // this replaces; the queue is read under the hold that queuing takes,
        // and a queue that cannot be read counts as naming them.
        let _held = self.hold();
        let mark = if kept().is_none_or(|kept| kept.contains(hex)) {
            Mark::Kept
        } else {
            match self
                .open_label(&incoming, false, false)
                .and_then(|file| crate::file_cache::exclude_from_backup(&file))
            {
                Ok(()) => Mark::Excluded,
                Err(error) => Mark::Refused(error.to_string()),
            }
        };
        Ok(Fetched {
            path: self.settle(&incoming, hash)?,
            mark,
        })
    }

    fn copy_in(&self, mut from: impl Read) -> std::result::Result<(String, u64, PathBuf), Copy> {
        #[cfg(unix)]
        if self.parent.is_some() {
            self.capability(true).map_err(Copy::Cache)?;
        }
        #[cfg(unix)]
        let make = self.parent.is_none();
        #[cfg(not(unix))]
        let make = true;
        if make {
            let mut made = fs::DirBuilder::new();
            made.recursive(true);
            #[cfg(unix)]
            std::os::unix::fs::DirBuilderExt::mode(&mut made, 0o700);
            made.create(&self.dir).map_err(Copy::Cache)?;
        }
        let incoming = self.dir.join(format!(".incoming-{}", uuid::Uuid::now_v7()));
        let copied = (|| {
            let mut to = self
                .open_label(&incoming, true, true)
                .map_err(Copy::Cache)?;
            let mut hasher = Sha256::new();
            let mut buffer = vec![0u8; 64 * 1024];
            let mut size = 0u64;
            loop {
                let read = match from.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(read) => read,
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                    Err(error) => return Err(Copy::Source(error)),
                };
                hasher.update(&buffer[..read]);
                to.write_all(&buffer[..read]).map_err(Copy::Cache)?;
                size += read as u64;
            }
            to.sync_all().map_err(Copy::Cache)?;
            Ok((format!("{PREFIX}{}", hex::encode(hasher.finalize())), size))
        })();
        match copied {
            Ok((hash, size)) => Ok((hash, size, incoming)),
            Err(error) => {
                let _ = self.unlink_label(&incoming);
                Err(error)
            }
        }
    }

    /// A rename, so a second reader sees the whole file or none of it.
    fn settle(&self, incoming: &Path, hash: &str) -> Result<PathBuf> {
        let path = self.dir.join(hex_of(hash)?);
        #[cfg(unix)]
        let renamed = match self.capability(false) {
            Ok(Some(directory)) => directory.rename(
                incoming.strip_prefix(&self.dir).expect("incoming label"),
                directory,
                Path::new(hex_of(hash)?),
                false,
            ),
            Ok(None) => fs::rename(incoming, &path),
            Err(error) => Err(error),
        };
        #[cfg(not(unix))]
        let renamed = fs::rename(incoming, &path);
        renamed.map_err(|error| {
            let _ = self.unlink_label(incoming);
            self.unwritable(error)
        })?;
        #[cfg(unix)]
        if let Some(directory) = self
            .capability(false)
            .map_err(|error| self.unwritable(error))?
        {
            directory.sync().map_err(|error| self.unwritable(error))?;
        }
        Ok(path)
    }

    fn unwritable(&self, error: io::Error) -> CoreError {
        CoreError::Store(format!(
            "the bytes cannot be held in {}: {error}",
            self.dir.display()
        ))
    }
}

pub(crate) fn named(hash: &str) -> Result<String> {
    let hex = hex_of(hash)?;
    Ok(format!("{PREFIX}{hex}"))
}

pub(crate) fn name_of(bytes: &[u8]) -> String {
    format!("{PREFIX}{}", hex::encode(Sha256::digest(bytes)))
}

/// The hex becomes a file name, so nothing but 64 lowercase hex digits may reach one.
pub(crate) fn hex_of(hash: &str) -> Result<&str> {
    Some(hash.strip_prefix(PREFIX).unwrap_or(hash))
        .filter(|hex| {
            hex.len() == 64
                && hex
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
        .ok_or_else(|| {
            CoreError::Invalid(format!(
                "{hash} is not a blob's name; a blob is named sha256: and 64 lowercase hex digits"
            ))
        })
}

/// `kept` is as for `Cache::keep`.
pub(crate) fn fetch(
    cache: &Cache,
    http: &Http,
    hash: &str,
    kept: impl FnOnce() -> Option<HashSet<String>>,
) -> Result<Fetched> {
    let absent = |reason: String| CoreError::BytesAbsent {
        hash: hash.to_string(),
        reason,
    };
    let reply = http
        .call(Call {
            method: Method::Get,
            segments: &["blobs", hash, "url"],
            params: &[],
            headers: &[],
            body: CallBody::None,
            credential: true,
            stream: false,
        })
        .map_err(|error| match error {
            CoreError::Network(reason) => absent(format!("the server cannot be reached: {reason}")),
            other => other,
        })?;
    let text = reply.body;
    // Only the server's own 404, naming its contract: a proxy's says nothing
    // about which bytes the server holds.
    if reply.status == 404 && reply.contract.is_some() {
        return Err(absent(format!("the server holds none: {text}")));
    }
    if !(200..300).contains(&reply.status) {
        return Err(http.refused(
            reply.status,
            reply.contract.is_some(),
            &text,
            reply.retry_after_seconds,
        ));
    }
    let link: serde_json::Value = serde_json::from_str(&text)?;
    let link = link
        .get("url")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| CoreError::Decoding(format!("the link door answered no url: {text}")))?;
    // Used exactly as given and never re-serialized: an object store signs
    // its own spelling of the URL.
    url::Url::parse(link).map_err(|error| {
        CoreError::Decoding(format!(
            "the link door answered a link that is not an absolute URL ({error}): {link}"
        ))
    })?;
    pull(cache, hash, link, CACHE_MOST, LINK_IDLE, kept)
}

/// How long a link may send nothing before the fetch is given up on. A blob
/// can be large and a link slow, so silence has a shorter bound than the
/// whole body. A stalled link must not hold the caller for the body's limit.
const LINK_IDLE: Duration = Duration::from_secs(60);

/// A bound on the whole body, far past any fetch that is going on. The reader
/// that watches for silence leaves its thread behind when it gives up, and a
/// connection that stays silent for good would hold that thread for good; this
/// ends it.
const LINK_BODY_MOST: Duration = Duration::from_secs(6 * 60 * 60);

/// What a link sends is bounded by `most`, the most one fetch pulls.
fn pull(
    cache: &Cache,
    hash: &str,
    link: &str,
    most: u64,
    idle: Duration,
    kept: impl FnOnce() -> Option<HashSet<String>>,
) -> Result<Fetched> {
    let bytes = open(link).map_err(|reason| CoreError::BytesAbsent {
        hash: hash.to_string(),
        reason,
    })?;
    cache.keep(
        hash,
        Bounded {
            inner: Idle::watching(bytes, idle),
            left: most,
        },
        kept,
    )
}

/// A reader whose reads fail once the source has sent nothing for `idle`. The
/// HTTP client bounds a phase of a call, not a silence in one. The source is
/// read on a thread of its own, which is left behind when a read gives up and
/// ends when the source does, which `LINK_BODY_MOST` makes certain of.
struct Idle {
    chunks: std::sync::mpsc::Receiver<io::Result<Vec<u8>>>,
    idle: Duration,
    held: Vec<u8>,
    at: usize,
}

impl Idle {
    fn watching(mut source: impl Read + Send + 'static, idle: Duration) -> Idle {
        let (sender, chunks) = std::sync::mpsc::sync_channel(4);
        std::thread::spawn(move || {
            let mut buffer = vec![0u8; 64 * 1024];
            loop {
                let chunk = match source.read(&mut buffer) {
                    Ok(read) => Ok(buffer[..read].to_vec()),
                    Err(error) => Err(error),
                };
                let last = !matches!(&chunk, Ok(bytes) if !bytes.is_empty());
                if sender.send(chunk).is_err() || last {
                    return;
                }
            }
        });
        Idle {
            chunks,
            idle,
            held: Vec::new(),
            at: 0,
        }
    }
}

impl Read for Idle {
    fn read(&mut self, into: &mut [u8]) -> io::Result<usize> {
        if self.at == self.held.len() {
            match self.chunks.recv_timeout(self.idle) {
                Ok(chunk) => {
                    self.held = chunk?;
                    self.at = 0;
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "the link went silent",
                    ));
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return Ok(0),
            }
        }
        let n = into.len().min(self.held.len() - self.at);
        into[..n].copy_from_slice(&self.held[self.at..self.at + n]);
        self.at += n;
        Ok(n)
    }
}

struct Bounded<R> {
    inner: R,
    left: u64,
}

impl<R: Read> Read for Bounded<R> {
    fn read(&mut self, into: &mut [u8]) -> io::Result<usize> {
        // One more than is left, so a body of exactly the limit ends cleanly
        // and a longer one is seen to be longer.
        let allowed = (self.left + 1).min(into.len() as u64) as usize;
        let read = self.inner.read(&mut into[..allowed])?;
        if read as u64 > self.left {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "the link sent more than the cache holds",
            ));
        }
        self.left -= read as u64;
        Ok(read)
    }
}

/// Not through `Http`: it rebuilds a URL from segments and re-encodes them,
/// which breaks an object store's signature, and it carries the bearer,
/// which an object store's host must never see.
fn open(link: &str) -> std::result::Result<impl Read + Send + 'static, String> {
    let agent: Agent = Agent::config_builder()
        .http_status_as_error(false)
        .timeout_connect(Some(Duration::from_secs(10)))
        .timeout_recv_response(Some(Duration::from_secs(30)))
        .timeout_recv_body(Some(LINK_BODY_MOST))
        .build()
        .into();
    let response = agent
        .get(link)
        .call()
        .map_err(|error| format!("the link cannot be reached: {error}"))?;
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(format!("the link answered {status}"));
    }
    Ok(response.into_body().into_reader())
}

pub fn mime_type_for(path: &Path, given: Option<&str>) -> String {
    if let Some(given) = given {
        return given.to_string();
    }
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "heic" => "image/heic",
        "pdf" => "application/pdf",
        "epub" => "application/epub+zip",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "txt" => "text/plain",
        "md" | "markdown" => "text/markdown",
        "html" | "htm" => "text/html",
        "json" => "application/json",
        "csv" => "text/csv",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "wav" => "audio/wav",
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    }
    .to_string()
}

pub fn file_type_for(mime_type: &str, given: Option<&str>) -> String {
    if let Some(given) = given {
        return given.to_string();
    }
    match mime_type.split('/').next().unwrap_or("") {
        "image" => "core.file.image",
        "audio" => "core.file.audio",
        "video" => "core.file.video",
        _ => "core.file",
    }
    .to_string()
}

#[cfg(test)]
pub(crate) mod tests {
    #[test]
    fn admitted_cache_does_not_remove_a_replacement_roots_bytes() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("owned");
        std::fs::create_dir(&root).unwrap();
        let directory = crate::directory::Directory::open(&root.canonicalize().unwrap()).unwrap();
        let cache = super::Cache::anchored(&directory, &root.join("core.sqlite"), true).unwrap();
        let source = temp.path().join("source");
        std::fs::write(&source, b"held bytes").unwrap();
        let taken = cache
            .take_reader(&source, File::open(&source).unwrap())
            .unwrap();
        let held = cache.held(&taken.hash).unwrap().unwrap();
        assert!(held.exists());
        std::fs::rename(&root, temp.path().join("original")).unwrap();
        std::fs::create_dir_all(held.parent().unwrap()).unwrap();
        std::fs::write(&held, b"replacement bytes").unwrap();
        cache.let_go(&taken.hash, &Default::default());
        assert_eq!(std::fs::read(&held).unwrap(), b"replacement bytes");
    }

    use super::*;

    /// A queue that names no upload.
    pub(crate) fn no_uploads() -> Option<HashSet<String>> {
        Some(HashSet::new())
    }

    #[test]
    fn fetched_bytes_an_upload_names_stay_in_backups_and_so_do_any_where_the_queue_is_unread() {
        let dir = tempfile::tempdir().unwrap();
        let cache = Cache::beside(&dir.path().join("core.sqlite"));
        let bytes = b"named by a queued upload";
        let hash = name_of(bytes);
        let named = HashSet::from([hex_of(&hash).unwrap().to_string()]);
        let mark =
            |kept: Option<HashSet<String>>| cache.keep(&hash, &bytes[..], || kept).unwrap().mark;
        assert_eq!(mark(no_uploads()), Mark::Excluded);
        assert_eq!(mark(Some(named)), Mark::Kept);
        assert_eq!(mark(None), Mark::Kept);
    }

    #[cfg(unix)]
    #[test]
    fn anchored_cache_uses_retained_state_and_blob_directories_for_every_operation() {
        let temp = tempfile::tempdir().unwrap();
        let parent = temp.path().canonicalize().unwrap();
        let root = parent.join("owned");
        fs::create_dir(&root).unwrap();
        fs::create_dir(root.join(".marfa")).unwrap();
        let state = crate::directory::Directory::open(&root.join(".marfa")).unwrap();
        let cache = Cache::anchored(&state, &root.join(".marfa/core.sqlite"), true).unwrap();
        let first = name_of(b"first original blob");
        cache
            .keep(&first, &b"first original blob"[..], no_uploads)
            .unwrap();
        fs::rename(&root, parent.join("original")).unwrap();
        fs::create_dir_all(root.join(".marfa/core.sqlite.blobs")).unwrap();
        let replacement = root.join(".marfa/core.sqlite.blobs");
        fs::write(
            replacement.join(hex_of(&first).unwrap()),
            b"replacement witness",
        )
        .unwrap();
        let incoming = replacement.join(".incoming-witness");
        fs::write(&incoming, b"keep incoming replacement").unwrap();
        let before = snapshot(&root);
        let mut opened = cache.open_held(&first).unwrap();
        let mut bytes = Vec::new();
        opened.read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes, b"first original blob");
        cache.touch(&cache.dir.join(hex_of(&first).unwrap()));
        let copied = cache
            .take_reader(Path::new("proof.bin"), &b"second original blob"[..])
            .unwrap();
        assert_eq!(copied.hash, name_of(b"second original blob"));
        cache
            .keep(
                &name_of(b"fetched original"),
                &b"fetched original"[..],
                no_uploads,
            )
            .unwrap();
        let retained = state.child(Path::new("core.sqlite.blobs"), false).unwrap();
        let left = retained
            .open_file(
                Path::new(".incoming-old"),
                rustix::fs::OFlags::WRONLY | rustix::fs::OFlags::CREATE | rustix::fs::OFlags::EXCL,
                rustix::fs::Mode::from_raw_mode(0o600),
            )
            .unwrap();
        left.set_modified(SystemTime::now() - Duration::from_secs(7200))
            .unwrap();
        cache.sweep_incoming(Duration::from_secs(3600));
        assert_eq!(
            retained
                .entry_kind(Path::new(".incoming-old"))
                .unwrap_err()
                .kind(),
            io::ErrorKind::NotFound
        );
        cache.trim(
            &HashSet::from([hex_of(&copied.hash).unwrap().to_string()]),
            |_| Some(0),
        );
        assert!(cache.held(&first).unwrap().is_none());
        cache.let_go(&copied.hash, &HashSet::new());
        assert!(cache.held(&copied.hash).unwrap().is_none());
        assert_eq!(snapshot(&root), before);
        fs::rename(
            parent.join("original/.marfa/core.sqlite.blobs"),
            parent.join("original/.marfa/retained-blobs"),
        )
        .unwrap();
        fs::create_dir(parent.join("original/.marfa/core.sqlite.blobs")).unwrap();
        cache
            .keep(&first, &b"first original blob"[..], no_uploads)
            .unwrap();
        assert_eq!(
            fs::read_dir(parent.join("original/.marfa/core.sqlite.blobs"))
                .unwrap()
                .count(),
            0
        );
        assert!(
            parent
                .join("original/.marfa/retained-blobs")
                .join(hex_of(&first).unwrap())
                .is_file()
        );
    }

    #[cfg(unix)]
    fn snapshot(root: &Path) -> Vec<(PathBuf, Vec<u8>)> {
        let mut result = Vec::new();
        fn read(dir: &Path, root: &Path, result: &mut Vec<(PathBuf, Vec<u8>)>) {
            for entry in fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    read(&path, root, result);
                } else {
                    result.push((
                        path.strip_prefix(root).unwrap().to_owned(),
                        fs::read(&path).unwrap(),
                    ));
                }
            }
        }
        read(root, root, &mut result);
        result.sort();
        result
    }

    /// A link on a port of its own that sends `body` and then, if asked,
    /// goes quiet with the connection open.
    pub(crate) fn linking(body: Vec<u8>, then_silent: bool) -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/bytes", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            if let Ok((mut socket, _)) = listener.accept() {
                let mut request = [0u8; 4096];
                let _ = Read::read(&mut socket, &mut request);
                let length = if then_silent {
                    body.len() + 1000
                } else {
                    body.len()
                };
                let _ = write!(
                    socket,
                    "HTTP/1.1 200 OK\r\nContent-Length: {length}\r\nConnection: close\r\n\r\n"
                );
                let _ = socket.write_all(&body);
                if then_silent {
                    std::thread::sleep(Duration::from_secs(20));
                }
            }
        });
        url
    }

    #[test]
    fn a_link_that_sends_more_than_the_cache_holds_is_cut_off() {
        let bytes = vec![7u8; 1000];
        let hash = name_of(&bytes);
        let dir = tempfile::tempdir().unwrap();
        let cache = Cache::beside(&dir.path().join("store.sqlite"));
        let within = Duration::from_secs(10);
        // The witness: a limit of exactly the body keeps it.
        let url = linking(bytes.clone(), false);
        assert!(pull(&cache, &hash, &url, 1000, within, no_uploads).is_ok());
        let url = linking(bytes, false);
        let refused = pull(&cache, &hash, &url, 999, within, no_uploads).unwrap_err();
        assert!(
            matches!(&refused, CoreError::BytesAbsent { reason, .. } if reason.contains("more than")),
            "{refused:?}"
        );
    }

    #[test]
    fn a_link_that_goes_quiet_is_given_up_on() {
        let bytes = vec![7u8; 100];
        let hash = name_of(&bytes);
        let dir = tempfile::tempdir().unwrap();
        let cache = Cache::beside(&dir.path().join("store.sqlite"));
        let url = linking(bytes, true);
        let started = std::time::Instant::now();
        let refused = pull(
            &cache,
            &hash,
            &url,
            CACHE_MOST,
            Duration::from_millis(500),
            no_uploads,
        )
        .unwrap_err();
        assert!(
            matches!(refused, CoreError::BytesAbsent { .. }),
            "{refused:?}"
        );
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[test]
    fn a_link_refused_naming_no_contract_is_the_network() {
        let server = crate::scripted::Scripted::start();
        let http = Http::new(&server.url(), "k").unwrap();
        let hash = name_of(b"bytes");
        let dir = tempfile::tempdir().unwrap();
        let cache = Cache::beside(&dir.path().join("core.sqlite"));
        let door = format!("/blobs/{hash}/url");
        server.on(&door, vec![crate::scripted::unnamed(401, "access_denied")]);
        let refused = fetch(&cache, &http, &hash, no_uploads).unwrap_err();
        assert!(
            matches!(refused, CoreError::Unnamed { status: 401, .. }),
            "a gateway's 401 on a blob's link was read as the credential refused: {refused:?}"
        );
        server.on(&door, vec![crate::scripted::refusal(401, "unauthorized")]);
        assert!(matches!(
            fetch(&cache, &http, &hash, no_uploads).unwrap_err(),
            CoreError::Unauthorized { .. }
        ));
    }

    const EMPTY: &str = "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

    #[test]
    fn blob_names_preserve_the_sha256_digest() {
        let dir = tempfile::tempdir().unwrap();
        let cache = Cache::beside(&dir.path().join("store.sqlite"));
        for (bytes, expected) in [
            (&b""[..], EMPTY),
            (
                &b"hello world"[..],
                "sha256:b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
            ),
        ] {
            assert_eq!(name_of(bytes), expected);
            let held = cache.keep(expected, bytes, no_uploads).unwrap().path;
            assert_eq!(held.file_name().unwrap(), hex_of(expected).unwrap());
            assert_eq!(fs::read(held).unwrap(), bytes);
        }
    }

    #[test]
    fn a_hash_names_a_file_and_nothing_else_does() {
        assert!(hex_of(EMPTY).is_ok());
        assert_eq!(
            named("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855").unwrap(),
            EMPTY
        );
        for bad in [
            "sha256:../../etc/passwd",
            "../../etc/passwd",
            "sha256:E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855",
            "sha256:e3b0",
        ] {
            assert!(hex_of(bad).is_err(), "{bad} was taken for a blob's name");
        }
    }

    #[test]
    fn bytes_are_kept_only_under_the_name_they_hash_to() {
        let dir = tempfile::tempdir().unwrap();
        let cache = Cache::beside(&dir.path().join("store.sqlite"));
        let other = "sha256:".to_string() + &"a".repeat(64);
        assert!(matches!(
            cache.keep(&other, &b""[..], no_uploads),
            Err(CoreError::Decoding(_))
        ));
        assert_eq!(cache.held(&other).unwrap(), None);
        let kept = cache.keep(EMPTY, &b""[..], no_uploads).unwrap().path;
        assert_eq!(cache.held(EMPTY).unwrap(), Some(kept));
        let names: Vec<_> = fs::read_dir(&cache.dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(
            names,
            vec![std::ffi::OsString::from(hex_of(EMPTY).unwrap())]
        );
    }

    #[test]
    fn an_attachment_is_typed_by_what_it_is_unless_told() {
        assert_eq!(
            mime_type_for(Path::new("scan.PDF"), None),
            "application/pdf"
        );
        assert_eq!(
            mime_type_for(Path::new("x.png"), Some("image/webp")),
            "image/webp"
        );
        assert_eq!(
            mime_type_for(Path::new("novel.epub"), None),
            "application/epub+zip"
        );
        assert_eq!(
            mime_type_for(Path::new("lease.docx"), None),
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        );
        assert_eq!(
            mime_type_for(Path::new("budget.xlsx"), None),
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        );
        assert_eq!(
            mime_type_for(Path::new("talk.PPTX"), None),
            "application/vnd.openxmlformats-officedocument.presentationml.presentation"
        );
        assert_eq!(
            mime_type_for(Path::new("noext"), None),
            "application/octet-stream"
        );
        assert_eq!(file_type_for("application/pdf", None), "core.file");
        assert_eq!(file_type_for("audio/mpeg", None), "core.file.audio");
        assert_eq!(file_type_for("image/png", None), "core.file.image");
        assert_eq!(file_type_for("image/png", Some("user.scan")), "user.scan");
    }

    #[test]
    fn a_half_written_copy_is_swept_once_it_is_old() {
        let dir = tempfile::tempdir().unwrap();
        let cache = Cache::beside(&dir.path().join("store.sqlite"));
        fs::create_dir_all(&cache.dir).unwrap();
        let left = cache.dir.join(".incoming-left-by-a-crash");
        fs::write(&left, b"half").unwrap();
        let held = cache.keep(EMPTY, &b""[..], no_uploads).unwrap().path;
        cache.sweep_incoming(Duration::from_secs(3600));
        assert!(left.exists());
        cache.sweep_incoming(Duration::ZERO);
        assert!(!left.exists());
        assert!(
            held.exists(),
            "the sweep took held bytes, which only a half-written copy may lose"
        );
    }

    /// Bytes kept under their name, read `ago` seconds ago.
    fn kept(cache: &Cache, bytes: &[u8], ago: u64) -> (String, PathBuf) {
        let hash = name_of(bytes);
        let path = cache.keep(&hash, bytes, no_uploads).unwrap().path;
        File::options()
            .append(true)
            .open(&path)
            .unwrap()
            .set_modified(SystemTime::now() - Duration::from_secs(ago))
            .unwrap();
        (hex_of(&hash).unwrap().to_string(), path)
    }

    #[test]
    fn a_trim_takes_the_bytes_read_longest_ago_until_the_rest_fit() {
        let dir = tempfile::tempdir().unwrap();
        let cache = Cache::beside(&dir.path().join("store.sqlite"));
        let (_, oldest) = kept(&cache, b"aaaaaaaaaa", 300);
        let (waiting, named) = kept(&cache, b"bbbbbbbbbb", 200);
        let (_, older) = kept(&cache, b"cccccccccc", 100);
        let (_, newest) = kept(&cache, b"dddddddddd", 0);
        let incoming = cache.dir.join(".incoming-still-arriving");
        fs::write(&incoming, b"half").unwrap();

        cache.trim(&HashSet::from([waiting]), |_| Some(25));
        assert!(!oldest.exists(), "the bytes read longest ago were kept");
        assert!(named.exists(), "bytes an upload still names were taken");
        assert!(!older.exists(), "the trim stopped before the rest fit");
        assert!(newest.exists(), "the trim went past what it had to take");
        assert!(
            incoming.exists(),
            "a copy still arriving was taken by a trim"
        );

        let (_, first) = kept(&cache, b"eeeeeeeeee", 500);
        cache.touch(&first);
        cache.trim(&HashSet::new(), |_| Some(20));
        assert!(first.exists(), "bytes just read were taken first");
        assert!(
            !named.exists(),
            "the trim took something other than the bytes read longest ago"
        );
    }

    /// A cache's size is read without opening its files, so a file that
    /// cannot be opened still counts and can still be taken.
    #[cfg(unix)]
    #[test]
    fn the_bytes_held_are_read_without_opening_each_file() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("anchored");
        fs::create_dir(&root).unwrap();
        let directory = crate::directory::Directory::open(&root.canonicalize().unwrap()).unwrap();
        let caches = [
            Cache::beside(&dir.path().join("store.sqlite")),
            Cache::anchored(&directory, &root.join("core.sqlite"), true).unwrap(),
        ];
        for cache in caches {
            let (_, readable) = kept(&cache, b"readable..", 0);
            let (_, sealed) = kept(&cache, b"sealed....", 100);
            // The witness: both count while both can be opened.
            assert_eq!(cache.held_bytes(), 20);
            fs::set_permissions(&sealed, fs::Permissions::from_mode(0o000)).unwrap();
            assert!(
                File::open(&sealed).is_err(),
                "the file could still be opened"
            );
            assert_eq!(
                cache.held_bytes(),
                20,
                "a file that cannot be opened went uncounted, so it was opened"
            );
            cache.trim(&HashSet::new(), |_| Some(10));
            assert!(!sealed.exists(), "the trim could not see a sealed file");
            assert!(readable.exists());
        }
    }

    #[test]
    fn bytes_let_go_are_gone_unless_an_upload_names_them() {
        let dir = tempfile::tempdir().unwrap();
        let cache = Cache::beside(&dir.path().join("store.sqlite"));
        let (hex, path) = kept(&cache, b"held", 0);
        let hash = format!("{PREFIX}{hex}");
        cache.let_go(&hash, &HashSet::from([hex.clone()]));
        assert!(path.exists(), "bytes an upload still names were let go");
        cache.let_go(&hash, &HashSet::new());
        assert_eq!(cache.held(&hash).unwrap(), None);
    }
}
