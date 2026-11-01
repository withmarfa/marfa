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
use crate::priority::inheriting;

pub(crate) const PREFIX: &str = "sha256:";

/// How long the bytes of a fetch that stopped are kept for a resume. A link
/// is good for seven days at most, and bytes beyond that are not worth the
/// space they take, which no budget counts.
const PARTIAL_KEPT: Duration = Duration::from_secs(7 * 24 * 60 * 60);

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
    /// How the last partial file a fetch made was marked out of backups,
    /// until `staged_mark` takes it.
    staged: Mutex<Option<Mark>>,
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

/// A file in the cache: a kept blob or a partial file.
struct Held {
    read: SystemTime,
    size: u64,
    path: PathBuf,
    partial: bool,
}

/// A file the bytes of one fetch are written to.
pub(crate) struct Staging {
    label: PathBuf,
    file: File,
    /// The bytes in the file now, which a resume continues from.
    held: u64,
    /// Whether the file is the one a fetch of the same bytes resumes from,
    /// which this fetch has locked. Otherwise another fetch of them holds
    /// that file, and this one writes a file of its own and keeps nothing.
    shared: bool,
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

    /// The folder of fetched bytes beside the store at `store`
    /// (`device/blob-kept-beside`).
    pub(crate) fn dir_beside(store: &Path) -> PathBuf {
        let mut name = store.as_os_str().to_owned();
        name.push(".blobs");
        PathBuf::from(name)
    }

    fn for_folder(store: &Path, folder: Folder) -> Cache {
        Cache {
            dir: Self::dir_beside(store),
            #[cfg(unix)]
            parent: None,
            #[cfg(unix)]
            directory: std::sync::OnceLock::new(),
            settling: Mutex::new(()),
            staged: Mutex::new(None),
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

    /// What the cache holds: every kept blob and every partial file, but not
    /// a copy still arriving. Each entry is read by `stat`, never opened, so
    /// a large cache costs no open per file. A folder not made yet holds
    /// nothing, exactly; a folder or an entry that cannot be read is an
    /// error, never a shorter list. An entry gone between the listing and its
    /// `stat` was taken by another trim and does not count.
    fn scan(&self) -> std::result::Result<Vec<Held>, String> {
        let entries = match self.entries() {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error.to_string()),
        };
        let mut found = Vec::new();
        for entry in entries {
            let name = entry.file_name().unwrap_or_default().to_string_lossy();
            if name.starts_with(".incoming-") {
                continue;
            }
            let partial = name.starts_with(".partial-");
            match self.stat_label(&entry) {
                Ok((true, size, read)) => found.push(Held {
                    read,
                    size,
                    path: entry,
                    partial,
                }),
                Ok(_) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.to_string()),
            }
        }
        Ok(found)
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

    /// The size of each entry `scan` finds, by its name in the folder: the
    /// hex of a kept blob's hash, or `.partial-` and that hex.
    pub(crate) fn sizes(&self) -> std::result::Result<HashMap<String, u64>, String> {
        Ok(self
            .scan()?
            .into_iter()
            .map(|held| {
                let name = held.path.file_name().unwrap_or_default();
                (name.to_string_lossy().into_owned(), held.size)
            })
            .collect())
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

    /// Takes bytes larger than the budget, then the bytes read longest ago,
    /// until what is left fits the budget `budget` gives for the bytes held,
    /// and answers how many it took. Partial files of fetches count with the
    /// rest, and are taken when no fetch holds them locked. Bytes named in
    /// `kept`, bytes a caller is reading and partial files a fetch holds stay
    /// whatever the budget, and one of them larger than the budget is not
    /// counted against it, since no trim can take it. Bytes named in
    /// `attachments`, and their partial files, stay too and are never
    /// counted, so `budget` is given the bytes held less theirs. `None` takes
    /// nothing. A cache that cannot be read takes nothing, since its bytes
    /// are not all known. Called under `hold`, with `kept` and `attachments`
    /// read under it, and no attachment made until it returns.
    pub(crate) fn trim(
        &self,
        kept: &HashSet<String>,
        attachments: &HashSet<String>,
        budget: impl FnOnce(u64) -> Option<u64>,
    ) -> u64 {
        self.try_trim(kept, attachments, budget).unwrap_or(0)
    }

    /// `trim`, answering why where the cache cannot be read. Called under
    /// `hold`, with `kept` read under it. Spares only the `attachments`
    /// given, so a caller that lets go of the connection before this
    /// returns can lose the bytes of an attachment made meanwhile.
    pub(crate) fn try_trim(
        &self,
        kept: &HashSet<String>,
        attachments: &HashSet<String>,
        budget: impl FnOnce(u64) -> Option<u64>,
    ) -> std::result::Result<u64, String> {
        let reading = self.readers();
        let found = self.scan()?;
        let found: Vec<Held> = found
            .into_iter()
            .filter(|entry| !attachment_entry(attachments, &entry.path))
            .collect();
        let mut total: u64 = found.iter().map(|held| held.size).sum();
        let Some(most) = budget(total) else {
            return Ok(0);
        };
        let mut held = Vec::new();
        // Each lock stays until its file is unlinked.
        let mut locks = Vec::new();
        for entry in found {
            let name = entry.path.file_name().unwrap_or_default().to_string_lossy();
            let mut protected = kept.contains(name.as_ref()) || reading.contains_key(name.as_ref());
            if entry.partial && !protected {
                match self.lock_partial(&entry.path) {
                    Some(lock) => locks.push(lock),
                    None => protected = true,
                }
            }
            if !protected {
                held.push(entry);
            } else if entry.size > most {
                total -= entry.size;
            }
        }
        // Bytes larger than the budget go first: they can never fit, so a
        // trim that kept them for being read lately would take every smaller
        // file before them.
        held.sort_by(|a, b| {
            ((a.size <= most), a.read, a.size, &a.path).cmp(&(
                (b.size <= most),
                b.read,
                b.size,
                &b.path,
            ))
        });
        let mut taken = 0;
        for entry in held {
            if total <= most {
                break;
            }
            if self.unlink_label(&entry.path).is_ok() {
                total -= entry.size;
                taken += entry.size;
            }
        }
        Ok(taken)
    }

    /// Locks a partial file as a fetch does, if no fetch holds it. Nothing
    /// is locked where the platform has no partial files.
    fn lock_partial(&self, label: &Path) -> Option<File> {
        let file = self.open_label(label, false, false).ok()?;
        self.lock_opened(file, label)
    }

    /// Locks `file`, opened from `label`, if no fetch holds it and `label`
    /// still names it: a fetch that dropped it unlinked it before letting go,
    /// and another may since have made a file at the same path.
    fn lock_opened(&self, file: File, label: &Path) -> Option<File> {
        #[cfg(unix)]
        {
            rustix::fs::flock(&file, rustix::fs::FlockOperation::NonBlockingLockExclusive).ok()?;
            self.names(&file, label).then_some(file)
        }
        #[cfg(not(unix))]
        {
            let _ = (file, label);
            None
        }
    }

    /// Takes the partial files of bytes other than `except` and
    /// `attachments`, which no fetch holds, and answers how many bytes it
    /// took. A fetch the volume has no room for makes room this way before
    /// it is refused. Called with no attachment made until it returns.
    fn take_other_partials(&self, except: &Path, attachments: &HashSet<String>) -> u64 {
        let Ok(found) = self.scan() else {
            return 0;
        };
        let mut taken = 0;
        for entry in found {
            if !entry.partial || entry.path == except || attachment_entry(attachments, &entry.path)
            {
                continue;
            }
            let Some(_lock) = self.lock_partial(&entry.path) else {
                continue;
            };
            if self.unlink_label(&entry.path).is_ok() {
                taken += entry.size;
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
        // An upload is queued once its bytes have their name, and a rename
        // that a power loss undoes leaves them in an `.incoming-` file the
        // startup sweep takes by its age.
        self.sync_folder().map_err(|error| {
            let message = format!(
                "the bytes are held in {}, but the folder holding them cannot be synced, so the upload is not queued: {error}",
                self.dir.display()
            );
            if error.kind() == io::ErrorKind::StorageFull {
                CoreError::StorageFull(message)
            } else {
                CoreError::Store(message)
            }
        })?;
        Ok(Taken { hash, size })
    }

    pub(crate) fn requires_descriptor(&self) -> bool {
        #[cfg(unix)]
        return self.parent.is_some();
        #[cfg(not(unix))]
        false
    }

    /// A process that ended mid-copy leaves its file behind, and only its age
    /// tells it from a copy still being written. The partial files of
    /// `attachments` stay whatever their age, for a fetch of attachments to
    /// resume, and no partial file goes where `attachments` is unknown.
    pub(crate) fn sweep_incoming(
        &self,
        older_than: Duration,
        attachments: Option<&HashSet<String>>,
    ) {
        let Ok(entries) = self.entries() else {
            return;
        };
        for entry in entries {
            let name = entry.file_name().unwrap_or_default().to_string_lossy();
            let partial = name.starts_with(".partial-");
            let older_than = if name.starts_with(".incoming-") {
                older_than
            } else if partial
                && attachments.is_some_and(|attachments| !names_kept(attachments, &name))
            {
                older_than.max(PARTIAL_KEPT)
            } else {
                continue;
            };
            // A fetch resuming a partial holds its lock, and a partial is
            // only ever unlinked under it.
            let opened = if partial {
                self.lock_partial(&entry)
            } else {
                self.open_label(&entry, false, false).ok()
            };
            let Some(file) = opened else {
                continue;
            };
            let stale = file
                .metadata()
                .and_then(|meta| meta.modified())
                .is_ok_and(|modified| modified.elapsed().is_ok_and(|age| age > older_than));
            if stale {
                let _ = self.unlink_label(&entry);
            }
        }
    }

    /// `kept` reads the hashes queued uploads name, and is called under
    /// `hold`.
    #[cfg(test)]
    pub(crate) fn keep(
        &self,
        hash: &str,
        bytes: impl Read,
        kept: impl FnOnce() -> Option<HashSet<String>>,
    ) -> Result<Fetched> {
        hex_of(hash)?;
        let (found, _, incoming) = self.copy_in(bytes).map_err(|error| match error {
            Copy::Source(error) => CoreError::BytesAbsent {
                hash: hash.to_string(),
                reason: format!("the bytes stopped arriving: {error}"),
            },
            Copy::Cache(error) => self.unwritable(error),
        })?;
        self.finish(hash, &found, &incoming, false, kept)
    }

    /// Gives bytes that hashed to `found` the name `hash`, if it is theirs.
    /// `marked` says whether `incoming` may carry a backup mark.
    fn finish(
        &self,
        hash: &str,
        found: &str,
        incoming: &Path,
        marked: bool,
        kept: impl FnOnce() -> Option<HashSet<String>>,
    ) -> Result<Fetched> {
        let hex = hex_of(hash)?;
        if found != hash {
            let _ = self.unlink_label(incoming);
            return Err(CoreError::Decoding(format!(
                "the bytes fetched for {hash} hash to {found}, so they are not the blob asked for"
            )));
        }
        #[cfg(debug_assertions)]
        crate::fault::hold(|| format!("blob-arrived:{hash}"));
        // Fetched bytes can be fetched again, so no backup needs them. But an
        // upload of the same bytes may have been queued while they arrived,
        // and its file is the only copy until the server has it; the queue is
        // read under the hold that queuing takes, and a queue that cannot be
        // read counts as naming them.
        let _held = self.hold();
        let kept = kept().map(|kept| kept.contains(hex));
        // Queuing an upload gives its bytes their name under the same hold,
        // and no trim or let-go takes bytes the queue names.
        let upload_held = kept == Some(true)
            && self
                .open_held(hash)
                .is_ok_and(|file| file.metadata().is_ok_and(|held| held.is_file()));
        match naming(kept, upload_held, marked) {
            Naming::Reuse => {
                let _ = self.unlink_label(incoming);
                Ok(Fetched {
                    path: self.dir.join(hex),
                    mark: Mark::Kept,
                })
            }
            Naming::Rename => Ok(Fetched {
                path: self.settle_fetched(incoming, hash)?,
                mark: Mark::Kept,
            }),
            Naming::Exclude => {
                let mark = match self
                    .open_label(incoming, false, false)
                    .and_then(|file| crate::file_cache::exclude_from_backups(&file))
                {
                    Ok(()) => Mark::Excluded,
                    Err(error) => Mark::Refused(error.to_string()),
                };
                Ok(Fetched {
                    path: self.settle_fetched(incoming, hash)?,
                    mark,
                })
            }
            // A failed copy leaves the fetched file whole, for a resume.
            Naming::Copy => {
                let copy = self
                    .copy_unmarked(incoming)
                    .map_err(|error| self.unwritable(error))?;
                let path = self.settle_fetched(&copy, hash)?;
                let _ = self.unlink_label(incoming);
                Ok(Fetched {
                    path,
                    mark: Mark::Kept,
                })
            }
        }
    }

    /// Copies the file at `from` to a new file that carries no backup mark.
    fn copy_unmarked(&self, from: &Path) -> io::Result<PathBuf> {
        let copy = self.dir.join(format!(".incoming-{}", uuid::Uuid::now_v7()));
        let copied = (|| {
            #[cfg(debug_assertions)]
            if crate::fault::fails(|| "blob-copy-full") {
                return Err(io::Error::from(io::ErrorKind::StorageFull));
            }
            let mut source = self.open_label(from, false, false)?;
            let mut to = self.open_label(&copy, true, true)?;
            io::copy(&mut source, &mut to)?;
            to.sync_all()
        })();
        match copied {
            Ok(()) => Ok(copy),
            Err(error) => {
                let _ = self.unlink_label(&copy);
                Err(error)
            }
        }
    }

    /// Makes the folder the bytes are written to, if it is not made yet.
    fn ensure_folder(&self) -> io::Result<()> {
        #[cfg(unix)]
        if self.parent.is_some() {
            self.capability(true)?;
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
            made.create(&self.dir)?;
        }
        Ok(())
    }

    fn copy_in(&self, mut from: impl Read) -> std::result::Result<(String, u64, PathBuf), Copy> {
        self.ensure_folder().map_err(Copy::Cache)?;
        let incoming = self.dir.join(format!(".incoming-{}", uuid::Uuid::now_v7()));
        let copied = (|| {
            let mut to = self
                .open_label(&incoming, true, true)
                .map_err(Copy::Cache)?;
            let mut hasher = Sha256::new();
            let mut size = 0u64;
            pour(&mut from, &mut to, &mut hasher, &mut size, None)?;
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

    fn open_read_write(&self, label: &Path, create: bool) -> io::Result<File> {
        #[cfg(unix)]
        if let Some(directory) = self.capability(true)? {
            use rustix::fs::{Mode, OFlags};
            let relative = label.strip_prefix(&self.dir).map_err(|_| {
                io::Error::new(io::ErrorKind::InvalidInput, "not a cache entry label")
            })?;
            let flags = if create {
                OFlags::RDWR | OFlags::CREATE
            } else {
                OFlags::RDWR
            };
            return directory.open_file(relative, flags, Mode::from_raw_mode(0o600));
        }
        let mut options = File::options();
        options.read(true).write(true).create(create);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        options.open(label)
    }

    /// Whether `label` still names the file `file` is open on.
    #[cfg(unix)]
    fn names(&self, file: &File, label: &Path) -> bool {
        use std::os::unix::fs::MetadataExt;
        let Ok(held) = file.metadata() else {
            return false;
        };
        if let Ok(Some(directory)) = self.capability(false) {
            return label
                .strip_prefix(&self.dir)
                .ok()
                .and_then(|relative| directory.entry_identity(relative).ok())
                == Some((held.dev(), held.ino()));
        }
        fs::symlink_metadata(label)
            .is_ok_and(|named| (named.dev(), named.ino()) == (held.dev(), held.ino()))
    }

    /// The file the bytes of `hash` are written to: the one an earlier fetch
    /// of them left, locked so no other fetch writes it at once, or where
    /// another holds it, a file of this fetch's own.
    pub(crate) fn stage(&self, hash: &str) -> Result<Staging> {
        let hex = hex_of(hash)?;
        self.ensure_folder()
            .map_err(|error| self.unwritable(error))?;
        #[cfg(unix)]
        {
            let label = self.dir.join(format!(".partial-{hex}"));
            // A fetch that drops the file it holds unlinks it before it lets
            // go, so one that locks a file the name no longer leads to tries
            // again.
            for _ in 0..4 {
                let file = self
                    .open_read_write(&label, true)
                    .map_err(|error| self.unwritable(error))?;
                match rustix::fs::flock(&file, rustix::fs::FlockOperation::NonBlockingLockExclusive)
                {
                    Ok(()) => {}
                    Err(rustix::io::Errno::WOULDBLOCK) => break,
                    Err(error) => return Err(self.unwritable(error.into())),
                }
                if self.names(&file, &label) {
                    let held = file
                        .metadata()
                        .map_err(|error| self.unwritable(error))?
                        .len();
                    // Marked as soon as it is made, since a fetch that stops
                    // leaves it behind for a resume.
                    let mark = match crate::file_cache::exclude_from_backups(&file) {
                        Ok(()) => Mark::Excluded,
                        Err(error) => Mark::Refused(error.to_string()),
                    };
                    *self
                        .staged
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(mark);
                    return Ok(Staging {
                        label,
                        file,
                        held,
                        shared: true,
                    });
                }
            }
        }
        let label = self.dir.join(format!(".incoming-{}", uuid::Uuid::now_v7()));
        let file = self
            .open_read_write(&label, true)
            .map_err(|error| self.unwritable(error))?;
        Ok(Staging {
            label,
            file,
            held: 0,
            shared: false,
        })
    }

    /// How the partial file the last fetch made was marked out of backups,
    /// once, for the state report.
    pub(crate) fn staged_mark(&self) -> Option<Mark> {
        self.staged
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take()
    }

    /// Empties the staging file, for bytes that start again.
    pub(crate) fn restart(&self, staging: &mut Staging) -> Result<()> {
        use std::io::{Seek, SeekFrom};
        staging
            .file
            .set_len(0)
            .and_then(|()| staging.file.seek(SeekFrom::Start(0)).map(|_| ()))
            .map_err(|error| self.unwritable(error))?;
        staging.held = 0;
        Ok(())
    }

    /// Removes the staging file: its bytes are no use to a resume, or the
    /// space they take is the person's to have back.
    pub(crate) fn drop_staging(&self, staging: Staging) {
        let _ = self.unlink_label(&staging.label);
    }

    /// Lets go of the staging file, keeping what it holds for a resume where
    /// it holds any.
    pub(crate) fn leave_staging(&self, staging: Staging) {
        if !staging.shared || staging.file.metadata().is_ok_and(|held| held.len() == 0) {
            self.drop_staging(staging);
        }
    }

    /// Writes what `from` sends after the bytes the staging file holds, and
    /// keeps the whole under `hash` if it hashes to it. `end` is how many
    /// bytes the whole has, which a link that ends before is a link that
    /// stopped.
    pub(crate) fn receive(
        &self,
        hash: &str,
        staging: Staging,
        from: impl Read,
        end: u64,
        kept: impl FnOnce() -> Option<HashSet<String>>,
    ) -> Result<Fetched> {
        use std::io::{Seek, SeekFrom};
        hex_of(hash)?;
        let absent = |reason: String| CoreError::BytesAbsent {
            hash: hash.to_string(),
            reason,
        };
        let mut hasher = Sha256::new();
        let mut size = staging.held;
        if size > 0 {
            let mut prefix = (&staging.file).take(size);
            let hashed = pour(&mut prefix, &mut io::sink(), &mut hasher, &mut 0, None)
                .map_err(|(Copy::Source(error) | Copy::Cache(error))| error);
            let at_end = (&staging.file).seek(SeekFrom::End(0));
            if let Err(error) = hashed.and(at_end.map(|_| ())) {
                self.drop_staging(staging);
                return Err(self.unwritable(error));
            }
        }
        #[cfg(debug_assertions)]
        let full_at = crate::fault::named("fetch-disk-full").and_then(|bytes| bytes.parse().ok());
        #[cfg(not(debug_assertions))]
        let full_at = None;
        let mut from = from;
        let mut to = &staging.file;
        match pour(&mut from, &mut to, &mut hasher, &mut size, full_at) {
            Ok(()) => {}
            Err(Copy::Cache(error)) => {
                self.drop_staging(staging);
                return Err(self.unwritable(error));
            }
            Err(Copy::Source(error))
                if error.get_ref().is_some_and(|inner| inner.is::<TooLong>()) =>
            {
                self.drop_staging(staging);
                return Err(absent(
                    "the link sent more than the size the file is stated to hold".into(),
                ));
            }
            Err(Copy::Source(error)) => {
                let _ = staging.file.sync_data();
                self.leave_staging(staging);
                return Err(absent(format!(
                    "{LINK_STOPPED} after {size} of {end}: {error}"
                )));
            }
        }
        if size < end {
            let _ = staging.file.sync_data();
            self.leave_staging(staging);
            return Err(absent(format!(
                "{LINK_STOPPED}: the link ended after {size} of {end} bytes"
            )));
        }
        if let Err(error) = staging.file.sync_all() {
            self.drop_staging(staging);
            return Err(self.unwritable(error));
        }
        let found = format!("{PREFIX}{}", hex::encode(hasher.finalize()));
        let label = staging.label.clone();
        // Only a partial file another fetch could resume is marked.
        let marked = cfg!(any(target_os = "macos", target_os = "ios")) && staging.shared;
        // The bytes are given their name while this fetch still holds the
        // partial file's lock, so no other fetch locks a partial that has
        // become the blob.
        let fetched = self.finish(hash, &found, &label, marked, kept);
        drop(staging);
        fetched
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
        Ok(path)
    }

    /// `settle` for fetched bytes. A power loss that undoes the name leaves
    /// bytes that can be fetched again, so the fetch still gives the file it
    /// holds when the folder cannot be synced.
    fn settle_fetched(&self, incoming: &Path, hash: &str) -> Result<PathBuf> {
        let path = self.settle(incoming, hash)?;
        if let Err(error) = self.sync_folder() {
            crate::telemetry::unsynced!(&self.unwritable(error));
        }
        Ok(path)
    }

    /// On Unix, syncs the folder, so a name `settle` gave outlasts a power
    /// loss.
    fn sync_folder(&self) -> io::Result<()> {
        #[cfg(unix)]
        {
            #[cfg(debug_assertions)]
            if crate::fault::fails(|| "blob-folder-sync") {
                return Err(io::Error::other("the folder sync failed"));
            }
            match self.capability(false)? {
                Some(directory) => directory.sync()?,
                None => File::open(&self.dir)?.sync_all()?,
            }
        }
        Ok(())
    }

    fn unwritable(&self, error: io::Error) -> CoreError {
        let message = format!(
            "the bytes cannot be held in {}: {error}",
            self.dir.display()
        );
        if error.kind() == io::ErrorKind::StorageFull {
            CoreError::StorageFull(message)
        } else {
            CoreError::Store(message)
        }
    }
}

/// How fetched bytes take their name.
#[derive(Debug, PartialEq, Eq)]
enum Naming {
    /// No upload names them, so they are marked out of backups.
    Exclude,
    /// An upload names them and its own file holds them, so the fetched
    /// file goes.
    Reuse,
    /// An upload may name them, and their file never had a mark.
    Rename,
    /// An upload may name them, and their file may carry a mark, which can
    /// come back when cleared soon after it was set, so they are copied to a
    /// file that never had one.
    Copy,
}

/// `kept` says whether the queue names the bytes (`None` where it cannot be
/// read), `upload_held` whether the upload's file holds them, and `marked`
/// whether the fetched file may carry a backup mark.
fn naming(kept: Option<bool>, upload_held: bool, marked: bool) -> Naming {
    match kept {
        Some(false) => Naming::Exclude,
        Some(true) if upload_held => Naming::Reuse,
        _ if marked => Naming::Copy,
        _ => Naming::Rename,
    }
}

/// How the reason of a `BytesAbsent` begins where the server could not be
/// reached, where it holds no bytes by the hash, where the link it gave could
/// not be reached, and where the link stopped sending part way, so
/// `why_absent` can tell them apart.
const SERVER_UNREACHABLE: &str = "the server cannot be reached";
const SERVER_HOLDS_NONE: &str = "the server holds none";
const LINK_UNREACHABLE: &str = "the link cannot be reached";
const LINK_STOPPED: &str = "the bytes stopped arriving";

/// Why a fetch refused `BytesAbsent` for `reason` left the bytes unheld,
/// and whether a fetch of other bytes from the same server would fare the
/// same.
pub(crate) fn why_absent(reason: &str) -> (crate::file_cache::NotHeldReason, bool) {
    use crate::file_cache::NotHeldReason as Why;
    if reason.starts_with(SERVER_UNREACHABLE) {
        (Why::Unreachable, true)
    } else if reason.starts_with(SERVER_HOLDS_NONE) {
        (Why::Absent, false)
    } else if reason.starts_with(LINK_UNREACHABLE) || reason.starts_with(LINK_STOPPED) {
        (Why::Unreachable, false)
    } else {
        (Why::Failed, false)
    }
}

/// Whether the entry at `path` holds bytes `attachments` names, whole or in
/// part.
fn attachment_entry(attachments: &HashSet<String>, path: &Path) -> bool {
    names_kept(
        attachments,
        &path.file_name().unwrap_or_default().to_string_lossy(),
    )
}

/// Whether the cache entry named `name` holds bytes `attachments` names,
/// whole or in part.
pub(crate) fn names_kept(attachments: &HashSet<String>, name: &str) -> bool {
    attachments.contains(name)
        || name
            .strip_prefix(".partial-")
            .is_some_and(|hex| attachments.contains(hex))
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

/// `stated` is the size the working copy states for the bytes, if it does;
/// `kept` is as for `Cache::keep`; `attachments` reads the bytes of
/// attachments, by hex, whose partial files a fetch with no room leaves in
/// place, with a guard that keeps any attachment from being made until it
/// is dropped.
pub(crate) fn fetch<G>(
    cache: &Cache,
    http: &Http,
    hash: &str,
    stated: Option<u64>,
    kept: impl FnOnce() -> Option<HashSet<String>>,
    attachments: impl FnOnce() -> Option<(G, HashSet<String>)>,
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
            CoreError::Network(reason) => absent(format!("{SERVER_UNREACHABLE}: {reason}")),
            other => other,
        })?;
    let text = reply.body;
    // Only the server's own 404, naming its contract: a proxy's says nothing
    // about which bytes the server holds.
    if reply.status == 404 && reply.contract.is_some() {
        return Err(absent(format!("{SERVER_HOLDS_NONE}: {text}")));
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
    pull(
        cache,
        hash,
        link,
        stated,
        LINK_IDLE,
        || cache.volume().map(|volume| volume.free),
        kept,
        attachments,
    )
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

/// Fetches the bytes from `link`, continuing the bytes an earlier fetch of
/// them left where the link serves a range. What a link sends is bounded by
/// `stated`, or by the length the link states where nothing else does, so no
/// fetch is unbounded. `room` answers the free space of the volume holding
/// the cache, `None` where it cannot be read.
#[allow(clippy::too_many_arguments)]
fn pull<G>(
    cache: &Cache,
    hash: &str,
    link: &str,
    stated: Option<u64>,
    idle: Duration,
    room: impl Fn() -> Option<u64>,
    kept: impl FnOnce() -> Option<HashSet<String>>,
    attachments: impl FnOnce() -> Option<(G, HashSet<String>)>,
) -> Result<Fetched> {
    let absent = |reason: String| CoreError::BytesAbsent {
        hash: hash.to_string(),
        reason,
    };
    let mut staging = cache.stage(hash)?;
    // Bytes held past the stated size cannot be a start of the file.
    if stated.is_some_and(|stated| staging.held > stated) {
        cache.restart(&mut staging)?;
    }
    // Bytes held to the stated size leave the link nothing to send, and
    // their hash says whether they are the file.
    if staging.held > 0 && stated == Some(staging.held) {
        let held = staging.held;
        return cache.receive(hash, staging, io::empty(), held, kept);
    }
    let opened = match open(link, staging.held) {
        Ok(opened) => opened,
        // A link answers `416` to a range from the end of the whole file, so
        // where no size is stated the bytes held may be all of it.
        Err(Refusal::Unsatisfiable) if stated.is_none() && staging.held > 0 => {
            let held = staging.held;
            return cache
                .receive(hash, staging, io::empty(), held, kept)
                .map_err(|error| match error {
                    CoreError::Decoding(_) => absent(
                        "the link cannot serve the range asked for, so the bytes held were dropped"
                            .into(),
                    ),
                    other => other,
                });
        }
        Err(Refusal::Unsatisfiable) => {
            cache.drop_staging(staging);
            return Err(absent(
                "the link cannot serve the range asked for, so the bytes held were dropped".into(),
            ));
        }
        Err(Refusal::Other(reason)) => {
            cache.leave_staging(staging);
            return Err(absent(reason));
        }
    };
    let held = staging.held;
    let (resume, observed) = match (held > 0, opened.status) {
        (_, 206) => match opened.range {
            Some(ContentRange {
                first,
                last,
                total: Some(total),
            }) if held > 0
                && first == held
                && first <= last
                && last.checked_add(1) == Some(total) =>
            {
                (true, Some(total))
            }
            _ => {
                cache.drop_staging(staging);
                return Err(absent(
                    "the link answered a range that does not continue the bytes held, so they were dropped"
                        .into(),
                ));
            }
        },
        (_, 200) | (false, _) => (false, opened.length),
        (true, status) => {
            cache.leave_staging(staging);
            return Err(absent(format!(
                "the link answered {status} to a request for a range"
            )));
        }
    };
    let (bound, end) = match (stated, observed) {
        (Some(stated), Some(observed)) if observed > stated => {
            cache.drop_staging(staging);
            return Err(absent(format!(
                "the link sends {observed} bytes, more than the {stated} the file is stated to hold"
            )));
        }
        (Some(stated), Some(observed)) => (stated, observed),
        (Some(stated), None) => (stated, stated),
        (None, Some(observed)) => (observed, observed),
        (None, None) => {
            cache.leave_staging(staging);
            return Err(absent(
                "the link states no length and the working copy states no size, so there is no bound on what it sends"
                    .into(),
            ));
        }
    };
    if !resume && held > 0 {
        cache.restart(&mut staging)?;
    }
    let start = staging.held;
    let needed = end.saturating_sub(start);
    let free = room();
    if let Some(short) = free
        && short < needed
    {
        let mut free = free;
        // Unknown attachments take no partial file, and keep this one.
        let read = attachments();
        let hex = hex_of(hash)?;
        let attachment = read.as_ref().is_none_or(|(_, kept)| kept.contains(hex));
        if let Some((_, kept)) = &read
            && cache.take_other_partials(&staging.label, kept) > 0
        {
            free = room();
        }
        // `read` holds the store until the partial file is left or dropped,
        // so no edge can make this file an attachment in between.
        if let Some(free) = free
            && free < needed
        {
            if attachment {
                cache.leave_staging(staging);
            } else {
                cache.drop_staging(staging);
            }
            return Err(CoreError::NoRoom {
                hash: hash.to_string(),
                size: end,
                free,
            });
        }
    }
    let body = Bounded {
        inner: Idle::watching(opened.body, idle),
        left: bound.saturating_sub(start),
    };
    cache.receive(hash, staging, body, end, kept)
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
        std::thread::spawn(inheriting(move || {
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
        }));
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

/// What a link that sends more than the bound fails a read with.
#[derive(Debug)]
struct TooLong;

impl std::fmt::Display for TooLong {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("the link sent more than the size the file is stated to hold")
    }
}

impl std::error::Error for TooLong {}

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
            return Err(io::Error::new(io::ErrorKind::InvalidData, TooLong));
        }
        self.left -= read as u64;
        Ok(read)
    }
}

/// Copies `from` to `to`, hashing it and counting it in `size`. `full_at` is
/// a size past which writing fails as a full disk does, which no fixture can
/// make a disk do.
fn pour(
    from: &mut impl Read,
    to: &mut impl Write,
    hasher: &mut Sha256,
    size: &mut u64,
    full_at: Option<u64>,
) -> std::result::Result<(), Copy> {
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        let read = match from.read(&mut buffer) {
            Ok(0) => return Ok(()),
            Ok(read) => read,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(Copy::Source(error)),
        };
        hasher.update(&buffer[..read]);
        if full_at.is_some_and(|full| *size + read as u64 > full) {
            return Err(Copy::Cache(io::ErrorKind::StorageFull.into()));
        }
        to.write_all(&buffer[..read]).map_err(Copy::Cache)?;
        *size += read as u64;
    }
}

/// What a link answered.
struct Opened {
    status: u16,
    length: Option<u64>,
    range: Option<ContentRange>,
    body: Box<dyn Read + Send>,
}

/// The bytes a `206` answers: `first` through `last` of `total`, if the link
/// knows the whole.
struct ContentRange {
    first: u64,
    last: u64,
    total: Option<u64>,
}

impl ContentRange {
    fn parse(text: &str) -> Option<ContentRange> {
        let (span, total) = text.trim().strip_prefix("bytes ")?.split_once('/')?;
        let (first, last) = span.split_once('-')?;
        Some(ContentRange {
            first: first.parse().ok()?,
            last: last.parse().ok()?,
            total: total.parse().ok(),
        })
    }
}

enum Refusal {
    /// The link answered `416` to a range.
    Unsatisfiable,
    Other(String),
}

/// Not through `Http`: it rebuilds a URL from segments and re-encodes them,
/// which breaks an object store's signature, and it carries the bearer,
/// which an object store's host must never see. Asks from byte `from` on
/// where `from` is above zero.
fn open(link: &str, from: u64) -> std::result::Result<Opened, Refusal> {
    let agent: Agent = Agent::config_builder()
        .http_status_as_error(false)
        .timeout_connect(Some(Duration::from_secs(10)))
        .timeout_recv_response(Some(Duration::from_secs(30)))
        .timeout_recv_body(Some(LINK_BODY_MOST))
        .build()
        .into();
    // The agent offers gzip unless told otherwise, and drops the length of
    // what it decompresses, so the stated size and the offsets of a range
    // would describe a different representation from the stored bytes.
    let mut request = agent.get(link).header("Accept-Encoding", "identity");
    if from > 0 {
        request = request.header("Range", format!("bytes={from}-"));
    }
    let response = request
        .call()
        .map_err(|error| Refusal::Other(format!("{LINK_UNREACHABLE}: {error}")))?;
    let status = response.status().as_u16();
    if status == 416 {
        return Err(Refusal::Unsatisfiable);
    }
    if !(200..300).contains(&status) {
        return Err(Refusal::Other(format!("the link answered {status}")));
    }
    let header = |name: &str| {
        response
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string)
    };
    Ok(Opened {
        status,
        length: header("content-length").and_then(|length| length.parse().ok()),
        range: header("content-range").and_then(|range| ContentRange::parse(&range)),
        body: Box::new(response.into_body().into_reader()),
    })
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
        "xhtml" => "application/xhtml+xml",
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

/// The file type a MIME type names when the writer names none. Parameters
/// and case do not change the kind (`Text/HTML; charset=utf-8` is a page), and
/// a page is a Web Page whatever its top-level part, which names only text.
pub fn file_type_for(mime_type: &str, given: Option<&str>) -> String {
    if let Some(given) = given {
        return given.to_string();
    }
    let essence = mime_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    match essence.as_str() {
        "text/html" | "application/xhtml+xml" => return "core.file.webpage".to_string(),
        _ => {}
    }
    match essence.split('/').next().unwrap_or("") {
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

    /// The bytes of every entry the cache holds.
    fn total(cache: &Cache) -> std::result::Result<u64, String> {
        Ok(cache.sizes()?.values().sum())
    }

    /// A queue that names no upload.
    pub(crate) fn no_uploads() -> Option<HashSet<String>> {
        Some(HashSet::new())
    }

    pub(crate) fn no_attachments() -> Option<((), HashSet<String>)> {
        Some(((), HashSet::new()))
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

    #[cfg(debug_assertions)]
    #[cfg(unix)]
    #[test]
    fn bytes_take_their_name_only_once_the_folder_holding_them_is_synced() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap().join("owned");
        fs::create_dir(&root).unwrap();
        let directory = crate::directory::Directory::open(&root).unwrap();
        let source = temp.path().join("source.bin");
        fs::write(&source, b"queued as an upload").unwrap();
        for cache in [
            Cache::beside(&temp.path().join("core.sqlite")),
            Cache::anchored(&directory, &root.join("core.sqlite"), true).unwrap(),
        ] {
            {
                let _failing = crate::fault::fail_on_this_thread("blob-folder-sync");
                let refused = cache.take_reader(&source, File::open(&source).unwrap());
                assert!(
                    matches!(&refused, Err(CoreError::Store(message))
                        if message.contains("cannot be synced, so the upload is not queued")),
                    "bytes were taken without a sync of their folder: {:?}",
                    refused.err()
                );
            }
            // The witness: the same bytes are taken once the sync succeeds.
            let taken = cache
                .take_reader(&source, File::open(&source).unwrap())
                .unwrap();
            assert!(cache.held(&taken.hash).unwrap().is_some());
        }
    }

    #[cfg(debug_assertions)]
    #[cfg(unix)]
    #[test]
    fn fetched_bytes_are_given_although_the_folder_holding_them_is_not_synced() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap().join("owned");
        fs::create_dir(&root).unwrap();
        let directory = crate::directory::Directory::open(&root).unwrap();
        let bytes = b"fetched from the server";
        let hash = format!("{PREFIX}{}", hex::encode(Sha256::digest(bytes)));
        for cache in [
            Cache::beside(&temp.path().join("core.sqlite")),
            Cache::anchored(&directory, &root.join("core.sqlite"), true).unwrap(),
        ] {
            let _failing = crate::fault::fail_on_this_thread("blob-folder-sync");
            let fetched = cache
                .keep(&hash, &bytes[..], || Some(HashSet::new()))
                .expect("a fetch failed over a folder sync");
            assert_eq!(fs::read(&fetched.path).unwrap(), bytes);
            assert_eq!(cache.held(&hash).unwrap(), Some(fetched.path));
        }
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
        cache.sweep_incoming(Duration::from_secs(3600), Some(&HashSet::new()));
        assert_eq!(
            retained
                .entry_kind(Path::new(".incoming-old"))
                .unwrap_err()
                .kind(),
            io::ErrorKind::NotFound
        );
        cache.trim(
            &HashSet::from([hex_of(&copied.hash).unwrap().to_string()]),
            &HashSet::new(),
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
        assert!(
            pull(
                &cache,
                &hash,
                &url,
                Some(1000),
                within,
                || None,
                no_uploads,
                no_attachments
            )
            .is_ok()
        );
        let url = linking(bytes, false);
        let refused = pull(
            &cache,
            &hash,
            &url,
            Some(999),
            within,
            || None,
            no_uploads,
            no_attachments,
        )
        .unwrap_err();
        assert!(
            matches!(&refused, CoreError::BytesAbsent { reason, .. } if reason.contains("more than")),
            "{refused:?}"
        );
    }

    /// A link on a port of its own that serves `body` to every request, and
    /// answers a `Range` with `206` when `ranges` is set. The first
    /// connection ends after `cut` bytes if it is given. The `Range` header
    /// of each request is recorded.
    struct Ranged {
        url: String,
        asked: Arc<Mutex<Vec<Option<String>>>>,
    }

    fn ranged(body: Vec<u8>, ranges: bool, cut: Option<usize>) -> Ranged {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/bytes", listener.local_addr().unwrap());
        let asked = Arc::new(Mutex::new(Vec::new()));
        let record = Arc::clone(&asked);
        std::thread::spawn(move || {
            let mut first = true;
            while let Ok((mut socket, _)) = listener.accept() {
                let mut request = [0u8; 4096];
                let read = Read::read(&mut socket, &mut request).unwrap_or(0);
                let text = String::from_utf8_lossy(&request[..read]).to_lowercase();
                let from = text
                    .lines()
                    .find_map(|line| line.strip_prefix("range: bytes="))
                    .map(|range| range.trim_end_matches('-').to_string());
                record.lock().unwrap().push(from.clone());
                let start = from
                    .as_deref()
                    .and_then(|from| from.parse::<usize>().ok())
                    .filter(|_| ranges)
                    .unwrap_or(0);
                if start >= body.len() && start > 0 {
                    let _ = write!(
                        socket,
                        "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                        body.len()
                    );
                    first = false;
                    continue;
                }
                let rest = &body[start..];
                let head = if start > 0 {
                    format!(
                        "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {start}-{}/{}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len() - 1,
                        body.len(),
                        rest.len()
                    )
                } else {
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        rest.len()
                    )
                };
                let _ = socket.write_all(head.as_bytes());
                let sent = match cut.filter(|_| first) {
                    Some(cut) => &rest[..cut.min(rest.len())],
                    None => rest,
                };
                let _ = socket.write_all(sent);
                first = false;
            }
        });
        Ranged { url, asked }
    }

    const WITHIN: Duration = Duration::from_secs(10);

    fn payload(length: usize) -> Vec<u8> {
        (0..length).map(|at| (at * 7 % 251) as u8).collect()
    }

    fn held_partial(dir: &Path, hash: &str) -> Option<Vec<u8>> {
        let path = Cache::beside(&dir.join("store.sqlite"))
            .dir
            .join(format!(".partial-{}", hex_of(hash).unwrap()));
        fs::read(path).ok()
    }

    fn left_behind(cache: &Cache) -> Vec<String> {
        fs::read_dir(&cache.dir)
            .map(|entries| {
                entries
                    .flatten()
                    .map(|entry| entry.file_name().to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default()
    }

    #[test]
    fn a_fetch_that_stopped_part_way_resumes_where_the_link_serves_a_range() {
        let bytes = payload(5000);
        let hash = name_of(&bytes);
        let dir = tempfile::tempdir().unwrap();
        let cache = Cache::beside(&dir.path().join("store.sqlite"));
        let link = ranged(bytes.clone(), true, Some(3000));
        let first = pull(
            &cache,
            &hash,
            &link.url,
            Some(5000),
            WITHIN,
            || None,
            no_uploads,
            no_attachments,
        );
        assert!(
            matches!(first, Err(CoreError::BytesAbsent { .. })),
            "{first:?}"
        );
        assert_eq!(
            held_partial(dir.path(), &hash),
            Some(bytes[..3000].to_vec())
        );
        let fetched = pull(
            &cache,
            &hash,
            &link.url,
            Some(5000),
            WITHIN,
            || None,
            no_uploads,
            no_attachments,
        )
        .unwrap();
        assert_eq!(fs::read(fetched.path).unwrap(), bytes);
        assert_eq!(
            *link.asked.lock().unwrap(),
            [None, Some("3000".to_string())]
        );
        assert_eq!(held_partial(dir.path(), &hash), None);
    }

    #[test]
    fn a_fetch_that_stopped_part_way_starts_again_where_the_link_serves_no_range() {
        let bytes = payload(5000);
        let hash = name_of(&bytes);
        let dir = tempfile::tempdir().unwrap();
        let cache = Cache::beside(&dir.path().join("store.sqlite"));
        let link = ranged(bytes.clone(), false, Some(3000));
        assert!(
            pull(
                &cache,
                &hash,
                &link.url,
                Some(5000),
                WITHIN,
                || None,
                no_uploads,
                no_attachments,
            )
            .is_err()
        );
        let fetched = pull(
            &cache,
            &hash,
            &link.url,
            Some(5000),
            WITHIN,
            || None,
            no_uploads,
            no_attachments,
        )
        .unwrap();
        assert_eq!(fs::read(fetched.path).unwrap(), bytes);
        assert_eq!(link.asked.lock().unwrap().len(), 2);
    }

    #[test]
    fn a_resumed_fetch_that_hashes_wrong_keeps_nothing() {
        let bytes = payload(5000);
        let hash = name_of(&bytes);
        let dir = tempfile::tempdir().unwrap();
        let cache = Cache::beside(&dir.path().join("store.sqlite"));
        let link = ranged(bytes.clone(), true, Some(3000));
        assert!(
            pull(
                &cache,
                &hash,
                &link.url,
                Some(5000),
                WITHIN,
                || None,
                no_uploads,
                no_attachments,
            )
            .is_err()
        );
        // The bytes held are not the start of the file any longer.
        let partial = cache
            .dir
            .join(format!(".partial-{}", hex_of(&hash).unwrap()));
        fs::write(&partial, vec![0u8; 3000]).unwrap();
        let refused = pull(
            &cache,
            &hash,
            &link.url,
            Some(5000),
            WITHIN,
            || None,
            no_uploads,
            no_attachments,
        )
        .unwrap_err();
        assert!(matches!(refused, CoreError::Decoding(_)), "{refused:?}");
        assert!(left_behind(&cache).is_empty(), "{:?}", left_behind(&cache));
    }

    #[test]
    fn a_resume_asks_from_the_bytes_the_partial_file_holds_now() {
        let bytes = payload(5000);
        let hash = name_of(&bytes);
        let dir = tempfile::tempdir().unwrap();
        let cache = Cache::beside(&dir.path().join("store.sqlite"));
        let link = ranged(bytes.clone(), true, Some(3000));
        assert!(
            pull(
                &cache,
                &hash,
                &link.url,
                Some(5000),
                WITHIN,
                || None,
                no_uploads,
                no_attachments,
            )
            .is_err()
        );
        let partial = cache
            .dir
            .join(format!(".partial-{}", hex_of(&hash).unwrap()));
        fs::write(&partial, &bytes[..2000]).unwrap();
        let other = ranged(bytes.clone(), true, None);
        assert!(
            pull(
                &cache,
                &hash,
                &other.url,
                Some(5000),
                WITHIN,
                || None,
                no_uploads,
                no_attachments,
            )
            .is_ok()
        );
        assert_eq!(*other.asked.lock().unwrap(), [Some("2000".to_string())]);
    }

    #[test]
    fn a_fetch_the_volume_has_no_room_for_is_refused_and_leaves_nothing() {
        let bytes = payload(5000);
        let hash = name_of(&bytes);
        let dir = tempfile::tempdir().unwrap();
        let cache = Cache::beside(&dir.path().join("store.sqlite"));
        let link = ranged(bytes.clone(), true, None);
        let refused = pull(
            &cache,
            &hash,
            &link.url,
            Some(5000),
            WITHIN,
            || Some(4999),
            no_uploads,
            no_attachments,
        )
        .unwrap_err();
        assert!(
            matches!(
                refused,
                CoreError::NoRoom {
                    size: 5000,
                    free: 4999,
                    ..
                }
            ),
            "{refused:?}"
        );
        assert!(left_behind(&cache).is_empty(), "{:?}", left_behind(&cache));
        // The witness: with room for exactly the bytes the fetch is kept.
        let kept = pull(
            &cache,
            &hash,
            &link.url,
            Some(5000),
            WITHIN,
            || Some(5000),
            no_uploads,
            no_attachments,
        );
        assert!(kept.is_ok(), "{kept:?}");
    }

    #[test]
    fn a_resumed_fetch_needs_room_only_for_the_bytes_still_to_come() {
        let bytes = payload(5000);
        let hash = name_of(&bytes);
        let dir = tempfile::tempdir().unwrap();
        let cache = Cache::beside(&dir.path().join("store.sqlite"));
        let link = ranged(bytes.clone(), true, Some(3000));
        assert!(
            pull(
                &cache,
                &hash,
                &link.url,
                Some(5000),
                WITHIN,
                || None,
                no_uploads,
                no_attachments,
            )
            .is_err()
        );
        let fetched = pull(
            &cache,
            &hash,
            &link.url,
            Some(5000),
            WITHIN,
            || Some(2000),
            no_uploads,
            no_attachments,
        );
        assert!(fetched.is_ok(), "{fetched:?}");
    }

    #[test]
    fn a_link_that_states_no_length_for_a_file_that_states_no_size_is_refused() {
        let bytes = payload(100);
        let hash = name_of(&bytes);
        let dir = tempfile::tempdir().unwrap();
        let cache = Cache::beside(&dir.path().join("store.sqlite"));
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/bytes", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            if let Ok((mut socket, _)) = listener.accept() {
                let mut request = [0u8; 4096];
                let _ = Read::read(&mut socket, &mut request);
                let _ = socket.write_all(b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n");
                let _ = socket.write_all(&bytes);
            }
        });
        let refused = pull(
            &cache,
            &hash,
            &url,
            None,
            WITHIN,
            || None,
            no_uploads,
            no_attachments,
        )
        .unwrap_err();
        assert!(
            matches!(&refused, CoreError::BytesAbsent { reason, .. } if reason.contains("no bound")),
            "{refused:?}"
        );
    }

    #[test]
    fn a_full_disk_is_storage_full_and_not_a_store_failure() {
        let dir = tempfile::tempdir().unwrap();
        let cache = Cache::beside(&dir.path().join("store.sqlite"));
        let (mut hasher, mut size, mut sink) = (Sha256::new(), 0, Vec::new());
        let bytes = payload(5000);
        let full = pour(
            &mut &bytes[..],
            &mut sink,
            &mut hasher,
            &mut size,
            Some(2000),
        );
        let Err(Copy::Cache(error)) = full else {
            panic!("a full disk was not seen");
        };
        assert!(matches!(cache.unwritable(error), CoreError::StorageFull(_)));
        // The witness: with room the same bytes are poured whole.
        let (mut hasher, mut size, mut sink) = (Sha256::new(), 0, Vec::new());
        assert!(pour(&mut &bytes[..], &mut sink, &mut hasher, &mut size, None).is_ok());
        assert_eq!(size, 5000);
    }

    #[cfg(unix)]
    #[test]
    fn two_fetches_of_the_same_bytes_never_write_one_partial_file() {
        let bytes = payload(5000);
        let hash = name_of(&bytes);
        let dir = tempfile::tempdir().unwrap();
        let cache = Cache::beside(&dir.path().join("store.sqlite"));
        let one = cache.stage(&hash).unwrap();
        let two = cache.stage(&hash).unwrap();
        assert_ne!(one.label, two.label, "both fetches would write one file");
        cache.drop_staging(one);
        cache.drop_staging(two);
        assert!(left_behind(&cache).is_empty(), "{:?}", left_behind(&cache));
    }

    #[test]
    fn a_trim_takes_a_file_larger_than_the_budget_before_any_other() {
        let dir = tempfile::tempdir().unwrap();
        let cache = Cache::beside(&dir.path().join("store.sqlite"));
        let (_, small) = kept(&cache, b"aaaaaaaaaa", 0);
        let (_, large) = kept(&cache, &[b'z'; 100], 0);
        let (_, older) = kept(&cache, b"cccccccccc", 300);
        cache.trim(&HashSet::new(), &HashSet::new(), |_| Some(20));
        assert!(!large.exists(), "the file past the budget was kept");
        assert!(
            small.exists() && older.exists(),
            "the trim took more than it had to"
        );
    }

    #[test]
    fn a_protected_file_larger_than_the_budget_is_not_counted_against_it() {
        let dir = tempfile::tempdir().unwrap();
        let cache = Cache::beside(&dir.path().join("store.sqlite"));
        let (_, oldest) = kept(&cache, b"aaaaaaaaaa", 300);
        let (_, newest) = kept(&cache, b"bbbbbbbbbb", 0);
        let (reading, large) = kept(&cache, &[b'r'; 100], 0);
        let (named, queued) = kept(&cache, &[b'q'; 100], 0);
        let guard = cache.reading(&format!("sha256:{reading}")).unwrap();
        // 20 bytes besides the two large files, which are protected: they fit
        // a budget of 25, so nothing is taken.
        assert_eq!(
            cache.trim(&HashSet::from([named.clone()]), &HashSet::new(), |_| Some(
                25
            )),
            0
        );
        assert!(
            oldest.exists() && newest.exists(),
            "the trim emptied the cache for a file it could not take"
        );
        // The witness: under a budget the rest do not fit, it takes the rest.
        assert_eq!(
            cache.trim(&HashSet::from([named.clone()]), &HashSet::new(), |_| Some(
                10
            )),
            10
        );
        assert!(!oldest.exists() && newest.exists());
        // Once nothing protects the large files, the next trim takes them first.
        drop(guard);
        let (_, small) = kept(&cache, b"cccccccccc", 500);
        cache.trim(&HashSet::from([named]), &HashSet::new(), |_| Some(25));
        assert!(!large.exists(), "the file past the budget was kept");
        assert!(queued.exists() && small.exists() && newest.exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_trim_keeps_attachment_bytes_and_their_partial_files_and_does_not_count_them() {
        let dir = tempfile::tempdir().unwrap();
        let cache = Cache::beside(&dir.path().join("store.sqlite"));
        let (attached, whole) = kept(&cache, &[b'a'; 100], 500);
        let (_, other) = kept(&cache, b"oooooooooo", 0);
        let partial = partial_of(&cache, &[b'p'; 50], 400);
        let partial_hex = partial
            .file_name()
            .unwrap()
            .to_string_lossy()
            .strip_prefix(".partial-")
            .unwrap()
            .to_string();
        let attachments = HashSet::from([attached.clone(), partial_hex]);
        let mut given = None;
        // 160 bytes are held, and only the 10 of the other file count.
        let taken = cache.trim(&HashSet::new(), &attachments, |held| {
            given = Some(held);
            Some(10)
        });
        assert_eq!(given, Some(10));
        assert_eq!(taken, 0);
        assert!(whole.exists() && partial.exists() && other.exists());
        // Under a budget of nothing, only the other file goes.
        assert_eq!(cache.trim(&HashSet::new(), &attachments, |_| Some(0)), 10);
        assert!(whole.exists() && partial.exists() && !other.exists());
        // The witness: once they are no attachment's, the same trim takes them.
        assert_eq!(
            cache.trim(&HashSet::new(), &HashSet::new(), |_| Some(0)),
            150
        );
        assert!(!whole.exists() && !partial.exists());
    }

    #[test]
    fn fetched_bytes_are_copied_only_where_an_upload_may_need_them_and_their_file_may_be_marked() {
        use Naming::*;
        for marked in [false, true] {
            for upload_held in [false, true] {
                assert_eq!(naming(Some(false), upload_held, marked), Exclude);
            }
            assert_eq!(naming(Some(true), true, marked), Reuse);
        }
        for kept in [Some(true), None] {
            assert_eq!(naming(kept, false, false), Rename);
            assert_eq!(naming(kept, false, true), Copy);
        }
        // An unread queue does not say whose file holds the bytes.
        assert_eq!(naming(None, true, true), Copy);
        assert_eq!(naming(None, true, false), Rename);
    }

    #[cfg(unix)]
    fn inode(path: &Path) -> u64 {
        std::os::unix::fs::MetadataExt::ino(&fs::metadata(path).unwrap())
    }

    /// The entries of the cache folder other than the blob `hex`.
    #[cfg(unix)]
    fn others(cache: &Cache, hex: &str) -> Vec<PathBuf> {
        let mut found = cache.entries().unwrap();
        found.retain(|entry| entry.file_name().unwrap() != hex);
        found
    }

    #[cfg(unix)]
    #[test]
    fn fetched_bytes_a_queued_upload_already_holds_leave_the_upload_file_in_place() {
        let dir = tempfile::tempdir().unwrap();
        let cache = Cache::beside(&dir.path().join("core.sqlite"));
        let bytes = payload(64);
        let source = dir.path().join("source.bin");
        fs::write(&source, &bytes).unwrap();
        let taken = cache
            .take_reader(&source, File::open(&source).unwrap())
            .unwrap();
        let upload = cache.held(&taken.hash).unwrap().unwrap();
        let before = inode(&upload);
        let hex = hex_of(&taken.hash).unwrap().to_string();

        let mut staging = cache.stage(&taken.hash).unwrap();
        assert!(staging.shared);
        let label = staging.label.clone();
        staging.file.write_all(&bytes[..4]).unwrap();
        std::io::Seek::rewind(&mut staging.file).unwrap();
        staging.held = 4;
        let named = HashSet::from([hex.clone()]);
        let fetched = cache
            .receive(&taken.hash, staging, &bytes[4..], 64, || Some(named))
            .unwrap();
        assert_eq!(fetched.mark, Mark::Kept);
        assert_eq!(fetched.path, upload);
        assert_eq!(
            inode(&fetched.path),
            before,
            "the upload's file was replaced"
        );
        assert_eq!(fs::read(&fetched.path).unwrap(), bytes);
        assert!(!label.exists(), "the partial file was left behind");
        assert!(others(&cache, &hex).is_empty(), "a copy was left behind");

        // The witness: where no upload names the bytes, the fetched file
        // takes the name.
        let mut staging = cache.stage(&taken.hash).unwrap();
        let fetched_inode = std::os::unix::fs::MetadataExt::ino(&staging.file.metadata().unwrap());
        staging.file.write_all(&bytes[..4]).unwrap();
        std::io::Seek::rewind(&mut staging.file).unwrap();
        staging.held = 4;
        let fetched = cache
            .receive(&taken.hash, staging, &bytes[4..], 64, no_uploads)
            .unwrap();
        assert_eq!(fetched.mark, Mark::Excluded);
        assert_eq!(inode(&fetched.path), fetched_inode);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn bytes_a_fetch_of_its_own_received_take_their_name_without_a_copy() {
        let dir = tempfile::tempdir().unwrap();
        let cache = Cache::beside(&dir.path().join("core.sqlite"));
        let bytes = payload(64);
        let hash = name_of(&bytes);
        let named = HashSet::from([hex_of(&hash).unwrap().to_string()]);
        let receive = |staging: Staging| {
            let staged = std::os::unix::fs::MetadataExt::ino(&staging.file.metadata().unwrap());
            let fetched = cache
                .receive(&hash, staging, &bytes[..], 64, || Some(named.clone()))
                .unwrap();
            assert_eq!(fetched.mark, Mark::Kept);
            (staged, inode(&fetched.path))
        };
        // Another fetch holds the partial file, so this one writes a file of
        // its own, which is never marked and is renamed as it is.
        let holder = cache.stage(&hash).unwrap();
        let own = cache.stage(&hash).unwrap();
        assert!(!own.shared);
        let (staged, held) = receive(own);
        assert_eq!(staged, held, "bytes in a file with no mark were copied");
        cache.drop_staging(holder);
        fs::remove_file(cache.held(&hash).unwrap().unwrap()).unwrap();

        // The witness: the marked partial file is copied.
        let shared = cache.stage(&hash).unwrap();
        assert!(shared.shared);
        let (staged, held) = receive(shared);
        assert_ne!(staged, held, "bytes in a marked file were not copied");
    }

    #[cfg(debug_assertions)]
    #[cfg(target_os = "macos")]
    #[test]
    fn a_copy_the_volume_has_no_room_for_keeps_the_fetched_bytes_for_a_resume() {
        for stated in [Some(5000), None] {
            let dir = tempfile::tempdir().unwrap();
            let cache = Cache::beside(&dir.path().join("store.sqlite"));
            let bytes = payload(5000);
            let hash = name_of(&bytes);
            let named = HashSet::from([hex_of(&hash).unwrap().to_string()]);
            let link = ranged(bytes.clone(), true, None);
            let label = cache
                .dir
                .join(format!(".partial-{}", hex_of(&hash).unwrap()));
            {
                let _full = crate::fault::fail_on_this_thread("blob-copy-full");
                let refused = pull(
                    &cache,
                    &hash,
                    &link.url,
                    stated,
                    WITHIN,
                    || None,
                    || Some(named.clone()),
                    no_attachments,
                )
                .unwrap_err();
                assert!(
                    matches!(refused, CoreError::StorageFull(_)),
                    "{stated:?}: refused with {refused:?}"
                );
            }
            assert_eq!(fs::read(&label).unwrap(), bytes, "the fetched bytes went");
            assert!(cache.held(&hash).unwrap().is_none());
            assert_eq!(
                others(&cache, "").len(),
                1,
                "the failed copy was left behind"
            );

            drop(lock_when_free(&cache, &label));
            let fetched = pull(
                &cache,
                &hash,
                &link.url,
                stated,
                WITHIN,
                || None,
                || Some(named.clone()),
                no_attachments,
            )
            .unwrap();
            assert_eq!(fs::read(&fetched.path).unwrap(), bytes);
            assert!(!label.exists());
            // With a size stated the link is not asked again; without one it
            // is asked from the end and answers that it has nothing more.
            let asked_again = stated.is_none().then(|| Some("5000".to_string()));
            let expected: Vec<_> = std::iter::once(None).chain(asked_again).collect();
            assert_eq!(*link.asked.lock().unwrap(), expected, "{stated:?}");
        }
    }

    #[test]
    fn a_whole_partial_file_of_the_wrong_bytes_is_dropped_without_asking_the_link() {
        let bytes = payload(5000);
        let hash = name_of(&bytes);
        for (stated, held, keeps) in [
            (Some(5000), vec![0u8; 5000], false),
            (None, vec![0u8; 5000], false),
            // The witness: the right bytes held are kept.
            (Some(5000), bytes.clone(), true),
            (None, bytes.clone(), true),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let cache = Cache::beside(&dir.path().join("store.sqlite"));
            let link = ranged(bytes.clone(), true, None);
            fs::create_dir_all(&cache.dir).unwrap();
            let partial = cache
                .dir
                .join(format!(".partial-{}", hex_of(&hash).unwrap()));
            fs::write(&partial, &held).unwrap();
            let fetched = pull(
                &cache,
                &hash,
                &link.url,
                stated,
                WITHIN,
                || None,
                no_uploads,
                no_attachments,
            );
            let case = format!("stated {stated:?}, right bytes {keeps}");
            if keeps {
                let fetched = fetched.unwrap_or_else(|error| panic!("{case}: {error:?}"));
                assert_eq!(fs::read(fetched.path).unwrap(), bytes, "{case}");
            } else {
                let refused = fetched.unwrap_err();
                match stated {
                    Some(_) => {
                        assert!(
                            matches!(refused, CoreError::Decoding(_)),
                            "{case}: {refused:?}"
                        )
                    }
                    None => assert!(
                        matches!(&refused, CoreError::BytesAbsent { reason, .. } if reason.contains("dropped")),
                        "{case}: {refused:?}"
                    ),
                }
                assert!(
                    left_behind(&cache).is_empty(),
                    "{case}: {:?}",
                    left_behind(&cache)
                );
            }
            let asked = stated.is_none().then(|| Some("5000".to_string()));
            assert_eq!(
                *link.asked.lock().unwrap(),
                asked.into_iter().collect::<Vec<_>>(),
                "{case}"
            );
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_partial_file_is_kept_out_of_backups_from_the_start_and_the_bytes_an_upload_names_are_not()
    {
        use crate::file_cache::tests::excluded;
        // The system excludes its own temporary folders, so the witness has to
        // sit under the home folder.
        let home = std::env::var_os("HOME").expect("HOME");
        let area = tempfile::Builder::new()
            .prefix(".marfa-backup-test-")
            .tempdir_in(home)
            .unwrap();
        let cache = Cache::beside(&area.path().join("core.sqlite"));
        let bytes = payload(64);
        let hash = name_of(&bytes);
        let staging = cache.stage(&hash).unwrap();
        let label = staging.label.clone();
        assert_eq!(cache.staged_mark(), Some(Mark::Excluded));
        assert!(excluded(&label), "tmutil does not exclude the partial file");
        cache.leave_staging(staging);

        // Finished where a queued upload names the bytes, the file is the
        // upload's and goes into backups. A mark cleared soon after it was set
        // can come back a few milliseconds later, so the file is read again
        // after a pause, over several rounds.
        let named = HashSet::from([hex_of(&hash).unwrap().to_string()]);
        for round in 0..20 {
            let area = tempfile::Builder::new()
                .prefix(".marfa-backup-test-")
                .tempdir_in(std::env::var_os("HOME").expect("HOME"))
                .unwrap();
            let cache = Cache::beside(&area.path().join("core.sqlite"));
            cache.leave_staging(cache.stage(&hash).unwrap());
            let mut staging = cache.stage(&hash).unwrap();
            let label = staging.label.clone();
            staging.file.write_all(&bytes[..4]).unwrap();
            std::io::Seek::rewind(&mut staging.file).unwrap();
            staging.held = 4;
            let fetched = cache
                .receive(&hash, staging, &bytes[4..], 64, || Some(named.clone()))
                .unwrap();
            assert_eq!(fetched.mark, Mark::Kept);
            assert!(!label.exists(), "the partial file was left behind");
            std::thread::sleep(Duration::from_millis(60));
            assert!(
                !has_backup_mark(&fetched.path),
                "the mark on a partial file stayed on the bytes of an upload (round {round})"
            );
            if round == 0 {
                assert!(!excluded(&fetched.path));
            }
        }
    }

    /// Whether the file at `path` carries the backup exclusion mark itself,
    /// read without starting a process.
    #[cfg(target_os = "macos")]
    fn has_backup_mark(path: &Path) -> bool {
        use std::os::unix::ffi::OsStrExt;
        let path = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
        let name = c"com.apple.metadata:com_apple_backup_excludeItem";
        // SAFETY: both names are NUL-terminated and a null buffer of size 0
        // asks only for the attribute's size.
        unsafe { libc::getxattr(path.as_ptr(), name.as_ptr(), std::ptr::null_mut(), 0, 0, 0) >= 0 }
    }

    #[cfg(unix)]
    fn partial_of(cache: &Cache, bytes: &[u8], ago: u64) -> PathBuf {
        let mut staging = cache
            .stage(&name_of(&payload(bytes.len() + ago as usize)))
            .unwrap();
        staging.file.write_all(bytes).unwrap();
        let label = staging.label.clone();
        staging
            .file
            .set_modified(SystemTime::now() - Duration::from_secs(ago))
            .unwrap();
        cache.leave_staging(staging);
        drop(lock_when_free(cache, &label));
        label
    }

    /// Locks the partial file at `label`, waiting for a hold that is not a
    /// fetch's. A process another test thread starts holds a copy of every
    /// descriptor open at that moment until it executes, and an advisory lock
    /// lasts as long as any copy does, so a lock a fetch dropped can stay
    /// taken for a moment where tests share a process.
    #[cfg(unix)]
    fn lock_when_free(cache: &Cache, label: &Path) -> File {
        let until = std::time::Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(lock) = cache.lock_partial(label) {
                return lock;
            }
            assert!(
                std::time::Instant::now() < until,
                "the partial file never unlocked"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[cfg(unix)]
    #[test]
    fn partial_files_count_in_the_bytes_held_and_a_trim_takes_those_no_fetch_holds() {
        let dir = tempfile::tempdir().unwrap();
        let cache = Cache::beside(&dir.path().join("store.sqlite"));
        let (_, blob) = kept(&cache, b"aaaaaaaaaa", 0);
        let left = partial_of(&cache, &[b'p'; 30], 500);
        assert!(left.exists());
        assert_eq!(total(&cache), Ok(40));
        // A partial a fetch holds locked counts, and is never taken.
        let held = cache.stage(&name_of(&payload(1))).unwrap();
        assert_eq!(held.held, 0);
        let busy = held.label.clone();
        let mut writing = held;
        writing.file.write_all(&[b'w'; 50]).unwrap();
        assert_eq!(total(&cache), Ok(90));
        let taken = cache.trim(&HashSet::new(), &HashSet::new(), |_| Some(15));
        assert_eq!(taken, 30);
        assert!(!left.exists(), "a partial no fetch holds was kept");
        assert!(blob.exists() && busy.exists(), "the trim took too much");
        cache.drop_staging(writing);
    }

    #[cfg(unix)]
    #[test]
    fn a_partial_replaced_between_opening_and_locking_is_not_held() {
        let dir = tempfile::tempdir().unwrap();
        let cache = Cache::beside(&dir.path().join("store.sqlite"));
        let label = partial_of(&cache, b"old", 10);
        // The witness: a partial that is still the one at its path locks.
        drop(lock_when_free(&cache, &label));
        let opened = cache.open_label(&label, false, false).unwrap();
        fs::remove_file(&label).unwrap();
        fs::write(&label, b"replacement").unwrap();
        assert!(cache.lock_opened(opened, &label).is_none());
        assert_eq!(fs::read(&label).unwrap(), b"replacement");
    }

    #[cfg(unix)]
    #[test]
    fn the_startup_sweep_leaves_a_partial_another_handle_holds() {
        let dir = tempfile::tempdir().unwrap();
        let cache = Cache::beside(&dir.path().join("store.sqlite"));
        let mut staging = cache.stage(&name_of(&payload(8))).unwrap();
        staging.file.write_all(b"some bytes").unwrap();
        let week = PARTIAL_KEPT + Duration::from_secs(60);
        staging.file.set_modified(SystemTime::now() - week).unwrap();
        let label = staging.label.clone();
        let other = Cache::beside(&dir.path().join("store.sqlite"));
        other.sweep_incoming(Duration::ZERO, Some(&HashSet::new()));
        assert!(label.exists(), "the sweep took a partial a fetch holds");
        // The witness: once let go, the same old partial is swept.
        cache.leave_staging(staging);
        other.sweep_incoming(Duration::ZERO, Some(&HashSet::new()));
        assert!(!label.exists());
    }

    #[cfg(unix)]
    #[test]
    fn the_startup_sweep_spares_the_partial_file_of_an_attachment_however_old() {
        let dir = tempfile::tempdir().unwrap();
        let cache = Cache::beside(&dir.path().join("store.sqlite"));
        let hash = name_of(&payload(8));
        let mut staging = cache.stage(&hash).unwrap();
        staging.file.write_all(b"some bytes").unwrap();
        let week = PARTIAL_KEPT + Duration::from_secs(60);
        staging.file.set_modified(SystemTime::now() - week).unwrap();
        let label = staging.label.clone();
        cache.leave_staging(staging);
        let attached = HashSet::from([hex_of(&hash).unwrap().to_string()]);
        cache.sweep_incoming(Duration::ZERO, Some(&attached));
        assert!(
            label.exists(),
            "the sweep took the partial file of an attachment"
        );
        cache.sweep_incoming(Duration::ZERO, None);
        assert!(
            label.exists(),
            "the sweep took a partial file with attachments unknown"
        );
        // The witness: once no attachment's, the same old partial is swept.
        cache.sweep_incoming(Duration::ZERO, Some(&HashSet::new()));
        assert!(!label.exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_fetch_of_an_attachment_short_of_room_keeps_its_partial_file() {
        let bytes = payload(5000);
        let hash = name_of(&bytes);
        let dir = tempfile::tempdir().unwrap();
        let cache = Cache::beside(&dir.path().join("store.sqlite"));
        let link = ranged(bytes.clone(), true, Some(3000));
        let partial = cache
            .dir
            .join(format!(".partial-{}", hex_of(&hash).unwrap()));
        let stopped = pull(
            &cache,
            &hash,
            &link.url,
            Some(5000),
            WITHIN,
            || None,
            no_uploads,
            no_attachments,
        );
        assert!(stopped.is_err());
        assert_eq!(fs::metadata(&partial).unwrap().len(), 3000);
        let attached = || Some(((), HashSet::from([hex_of(&hash).unwrap().to_string()])));
        let refused = pull(
            &cache,
            &hash,
            &link.url,
            Some(5000),
            WITHIN,
            || Some(1000),
            no_uploads,
            attached,
        );
        assert!(
            matches!(refused, Err(CoreError::NoRoom { .. })),
            "{refused:?}"
        );
        assert_eq!(
            fs::metadata(&partial).map(|held| held.len()).ok(),
            Some(3000),
            "a fetch with no room dropped the part of an attachment it held"
        );
        // The witness: for bytes no attachment's, the same refusal drops it.
        let refused = pull(
            &cache,
            &hash,
            &link.url,
            Some(5000),
            WITHIN,
            || Some(1000),
            no_uploads,
            no_attachments,
        );
        assert!(
            matches!(refused, Err(CoreError::NoRoom { .. })),
            "{refused:?}"
        );
        assert!(!partial.exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_fetch_short_of_room_takes_the_partials_of_other_bytes_and_asks_again() {
        let bytes = payload(5000);
        let hash = name_of(&bytes);
        let dir = tempfile::tempdir().unwrap();
        let cache = Cache::beside(&dir.path().join("store.sqlite"));
        let link = ranged(bytes.clone(), true, None);
        let other = partial_of(&cache, &[b'o'; 4000], 10);
        let room = || Some(if other.exists() { 1000 } else { 5000 });
        let fetched = pull(
            &cache,
            &hash,
            &link.url,
            Some(5000),
            WITHIN,
            room,
            no_uploads,
            no_attachments,
        );
        assert!(fetched.is_ok(), "{fetched:?}");
        assert!(!other.exists());
        // The witness: where taking them gives no room, the ask is refused.
        let again = partial_of(&cache, &[b'o'; 4000], 10);
        let full = || Some(1000);
        let refused = pull(
            &cache,
            &hash,
            &link.url,
            Some(5000),
            WITHIN,
            full,
            no_uploads,
            no_attachments,
        );
        assert!(
            matches!(refused, Err(CoreError::NoRoom { .. })),
            "{refused:?}"
        );
        assert!(!again.exists());
    }

    /// A link that gzips its answer, with no length, to any ask that offers
    /// gzip, and answers the rest as stored. The `Accept-Encoding` of each
    /// ask is recorded.
    fn gzipping(body: Vec<u8>) -> (String, Arc<Mutex<Vec<String>>>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/bytes", listener.local_addr().unwrap());
        let offered = Arc::new(Mutex::new(Vec::new()));
        let record = Arc::clone(&offered);
        std::thread::spawn(move || {
            while let Ok((mut socket, _)) = listener.accept() {
                let mut request = [0u8; 4096];
                let read = Read::read(&mut socket, &mut request).unwrap_or(0);
                let text = String::from_utf8_lossy(&request[..read]).to_lowercase();
                let encoding = text
                    .lines()
                    .find_map(|line| line.strip_prefix("accept-encoding:"))
                    .unwrap_or("")
                    .trim()
                    .to_string();
                let zipped = encoding.contains("gzip");
                record.lock().unwrap().push(encoding);
                if zipped {
                    let mut packed =
                        flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
                    packed.write_all(&body).unwrap();
                    let packed = packed.finish().unwrap();
                    let _ = socket.write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nConnection: close\r\n\r\n",
                    );
                    let _ = socket.write_all(&packed);
                } else {
                    let head = format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    );
                    let _ = socket.write_all(head.as_bytes());
                    let _ = socket.write_all(&body);
                }
            }
        });
        (url, offered)
    }

    #[test]
    fn every_ask_to_a_link_wants_the_stored_bytes_and_not_a_compressed_copy() {
        let bytes = payload(5000);
        let hash = name_of(&bytes);
        let dir = tempfile::tempdir().unwrap();
        let cache = Cache::beside(&dir.path().join("store.sqlite"));
        let (url, offered) = gzipping(bytes.clone());
        let fetched = pull(
            &cache,
            &hash,
            &url,
            None,
            WITHIN,
            || None,
            no_uploads,
            no_attachments,
        );
        assert!(fetched.is_ok(), "{fetched:?}");
        let _ = open(&url, 100);
        let offered = offered.lock().unwrap();
        assert_eq!(*offered, ["identity", "identity"]);
    }

    /// A link that answers every ask `206` with the `Content-Range` given.
    fn lying(content_range: &str) -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/bytes", listener.local_addr().unwrap());
        let range = content_range.to_string();
        std::thread::spawn(move || {
            while let Ok((mut socket, _)) = listener.accept() {
                let mut request = [0u8; 4096];
                let _ = Read::read(&mut socket, &mut request);
                let head = format!(
                    "HTTP/1.1 206 Partial Content\r\nContent-Range: {range}\r\nContent-Length: 2\r\nConnection: close\r\n\r\nab"
                );
                let _ = socket.write_all(head.as_bytes());
            }
        });
        url
    }

    #[cfg(unix)]
    #[test]
    fn a_content_range_that_overflows_or_contradicts_itself_is_bytes_absent() {
        let bytes = payload(5000);
        let hash = name_of(&bytes);
        for range in [
            "bytes 3000-18446744073709551615/18446744073709551615",
            "bytes 3000-18446744073709551615/5000",
            "bytes 3000-5000/5000",
            "bytes 3000-2999/5000",
        ] {
            let dir = tempfile::tempdir().unwrap();
            let cache = Cache::beside(&dir.path().join("store.sqlite"));
            let cut = ranged(bytes.clone(), true, Some(3000));
            let _ = pull(
                &cache,
                &hash,
                &cut.url,
                Some(5000),
                WITHIN,
                || None,
                no_uploads,
                no_attachments,
            );
            let url = lying(range);
            let refused = pull(
                &cache,
                &hash,
                &url,
                Some(5000),
                WITHIN,
                || None,
                no_uploads,
                no_attachments,
            );
            assert!(
                matches!(refused, Err(CoreError::BytesAbsent { .. })),
                "{range}: {refused:?}"
            );
            assert!(
                left_behind(&cache).is_empty(),
                "{range}: {:?}",
                left_behind(&cache)
            );
        }
    }

    #[test]
    fn a_trim_leaves_a_file_being_read_and_one_an_upload_names_however_large() {
        let dir = tempfile::tempdir().unwrap();
        let cache = Cache::beside(&dir.path().join("store.sqlite"));
        let (reading, read) = kept(&cache, &[b'r'; 100], 0);
        let (named, queued) = kept(&cache, &[b'q'; 100], 0);
        let _guard = cache.reading(&format!("sha256:{reading}")).unwrap();
        cache.trim(&HashSet::from([named]), &HashSet::new(), |_| Some(10));
        assert!(read.exists(), "bytes being read were taken");
        assert!(queued.exists(), "bytes an upload names were taken");
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
            Some(1100),
            Duration::from_millis(500),
            || None,
            no_uploads,
            no_attachments,
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
        let refused = fetch(&cache, &http, &hash, None, no_uploads, no_attachments).unwrap_err();
        assert!(
            matches!(refused, CoreError::Unnamed { status: 401, .. }),
            "a gateway's 401 on a blob's link was read as the credential refused: {refused:?}"
        );
        server.on(&door, vec![crate::scripted::refusal(401, "unauthorized")]);
        assert!(matches!(
            fetch(&cache, &http, &hash, None, no_uploads, no_attachments).unwrap_err(),
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
    fn a_page_is_a_web_page_by_its_mime_type() {
        for mime in [
            "text/html",
            "text/html; charset=utf-8",
            "Text/HTML ;charset=ISO-8859-1",
            "application/xhtml+xml",
        ] {
            assert_eq!(file_type_for(mime, None), "core.file.webpage", "{mime}");
        }
        for name in ["a.html", "A.HTML", "old.htm", "OLD.Htm", "a.xhtml"] {
            let mime = mime_type_for(Path::new(name), None);
            assert_eq!(file_type_for(&mime, None), "core.file.webpage", "{name}");
        }
        // The rest of text stays a file, and so does a page that says it is
        // something else; a writer's own type wins.
        assert_eq!(file_type_for("text/plain", None), "core.file");
        assert_eq!(file_type_for("text/htmlish", None), "core.file");
        assert_eq!(file_type_for("text/html", Some("core.file")), "core.file");
        assert_eq!(
            file_type_for("text/html", Some("user.report")),
            "user.report"
        );
        assert_eq!(file_type_for("IMAGE/PNG; x=1", None), "core.file.image");
    }

    #[test]
    fn a_half_written_copy_is_swept_once_it_is_old() {
        let dir = tempfile::tempdir().unwrap();
        let cache = Cache::beside(&dir.path().join("store.sqlite"));
        fs::create_dir_all(&cache.dir).unwrap();
        let left = cache.dir.join(".incoming-left-by-a-crash");
        fs::write(&left, b"half").unwrap();
        let held = cache.keep(EMPTY, &b""[..], no_uploads).unwrap().path;
        cache.sweep_incoming(Duration::from_secs(3600), Some(&HashSet::new()));
        assert!(left.exists());
        cache.sweep_incoming(Duration::ZERO, Some(&HashSet::new()));
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

    #[cfg(unix)]
    #[test]
    fn a_cache_that_cannot_be_read_is_unknown_and_a_trim_takes_nothing() {
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
            // A folder not made yet holds nothing, exactly.
            let absent = Cache::beside(&dir.path().join("elsewhere").join("store.sqlite"));
            assert_eq!(total(&absent), Ok(0));
            let (_, path) = kept(&cache, b"cannot be listed", 0);
            let folder = path.parent().unwrap().to_path_buf();
            // The witness: it counts and trims while the folder is readable.
            assert_eq!(total(&cache), Ok(16));
            fs::set_permissions(&folder, fs::Permissions::from_mode(0o000)).unwrap();
            let sealed = fs::read_dir(&folder).is_err() && File::open(&path).is_err();
            let counted = total(&cache);
            let taken = cache.trim(&HashSet::new(), &HashSet::new(), |_| Some(0));
            fs::set_permissions(&folder, fs::Permissions::from_mode(0o755)).unwrap();
            assert!(sealed, "the folder could still be read");
            assert!(
                counted.is_err(),
                "an unreadable cache was counted as {counted:?}"
            );
            assert_eq!(taken, 0);
            assert!(
                path.exists(),
                "a trim of a cache it could not read took bytes"
            );
            assert_eq!(
                cache.trim(&HashSet::new(), &HashSet::new(), |_| Some(0)),
                16
            );
        }
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

        cache.trim(&HashSet::from([waiting]), &HashSet::new(), |_| Some(25));
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
        cache.trim(&HashSet::new(), &HashSet::new(), |_| Some(20));
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
            assert_eq!(total(&cache), Ok(20));
            fs::set_permissions(&sealed, fs::Permissions::from_mode(0o000)).unwrap();
            assert!(
                File::open(&sealed).is_err(),
                "the file could still be opened"
            );
            assert_eq!(
                total(&cache),
                Ok(20),
                "a file that cannot be opened went uncounted, so it was opened"
            );
            cache.trim(&HashSet::new(), &HashSet::new(), |_| Some(10));
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
