use super::writers::{Census, Writers};
use crate::directory::Directory;
use crate::directory::{Mode, OFlags};
use serde::{Deserialize, Serialize};
use std::fs::{File, Metadata};
use std::io::{self, Read, Seek, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Debug)]
pub(crate) enum Unlanded {
    Failed(io::Error),
    /// The target is no longer what the caller decided to write over.
    Changed,
    /// A program holds the target open for writing, so it stays as it is.
    Busy,
}

impl std::fmt::Display for Unlanded {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Unlanded::Failed(error) => error.fmt(f),
            Unlanded::Changed => f.write_str("it changed on the disk while it was being written"),
            Unlanded::Busy => f.write_str(BUSY),
        }
    }
}

impl From<Unlanded> for io::Error {
    fn from(unlanded: Unlanded) -> io::Error {
        match unlanded {
            Unlanded::Failed(error) => error,
            Unlanded::Changed => io::Error::other(Unlanded::Changed.to_string()),
            Unlanded::Busy => busy(),
        }
    }
}

const BUSY: &str =
    "a program has it open for writing, so Marfa leaves it until that program closes it";

/// The error a write or a removal answers where a program holds its target
/// open for writing.
pub(crate) fn busy() -> io::Error {
    io::Error::new(io::ErrorKind::ResourceBusy, BUSY)
}

/// Whether `error` is [`busy`]'s.
pub(crate) fn is_busy(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::ResourceBusy
}

impl From<io::Error> for Unlanded {
    fn from(error: io::Error) -> Unlanded {
        Unlanded::Failed(error)
    }
}

/// Writes `bytes` over `target` as [`land`] does.
#[cfg(test)]
pub(crate) fn write(
    target: &Path,
    bytes: &[u8],
    still: impl FnOnce(Option<&[u8]>) -> bool,
) -> Result<(), Unlanded> {
    land(target, |file, _| file.write_all(bytes), still)
}

/// Fills a new file beside `target`, in a directory that must exist, syncs it
/// and puts it in the target's place, so a write that fails at any point
/// leaves the old file whole. `fill` may also set the new file's permissions
/// and attributes through its descriptor, before it lands.
///
/// `still` is asked, after the new file is written, whether the target's
/// bytes as read then, or `None` where there was none, are what the caller
/// decided to write over; where they are not, nothing lands. The file read
/// is held open, and the new file lands only where the file it displaces is
/// that one, unchanged: a person's save made after the read goes back to the
/// path, or beside it, and the new file does not land. An absent target must
/// stay absent through the rename. Answers the metadata of the file written,
/// taken before it lands.
pub(crate) fn land_at(
    dir: &Directory,
    guard: Guard<'_>,
    target: &Path,
    fill: impl FnOnce(&mut File, &Path) -> io::Result<()>,
    still: impl FnOnce(Option<&[u8]>) -> bool,
) -> Result<Metadata, Unlanded> {
    land_flushed(dir, Some(guard), target, fill, still, Flush::Full)
}

/// Writes a file only Marfa writes, under a lock it holds, over whatever is
/// at `target`, as [`land_at`] does with no check of what it replaces.
pub(crate) fn land_owned_at(
    dir: &Directory,
    target: &Path,
    fill: impl FnOnce(&mut File, &Path) -> io::Result<()>,
) -> Result<Metadata, Unlanded> {
    land_flushed(dir, None, target, fill, |_| true, Flush::Full)
}

/// [`land_at`], flushing the file and its directory as an ordering point
/// only, so a crash cannot keep the rename without the bytes, nor anything
/// written after it without them. It does not make the file durable: the
/// caller must end the run with [`Unflushed::flush`] on the same `unflushed`
/// before it reports the file written, and only where the file shares a
/// volume with whatever records it. Where the platform has no cheaper
/// ordering flush than a full one, this is [`land_at`].
pub(crate) fn land_ordered_at(
    dir: &Directory,
    guard: Guard<'_>,
    unflushed: &Unflushed,
    target: &Path,
    fill: impl FnOnce(&mut File, &Path) -> io::Result<()>,
    still: impl FnOnce(Option<&[u8]>) -> bool,
) -> Result<Metadata, Unlanded> {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        land_flushed(
            dir,
            Some(guard),
            target,
            fill,
            still,
            Flush::Ordered(unflushed),
        )
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    {
        let _ = unflushed;
        land_at(dir, guard, target, fill, still)
    }
}

#[derive(Clone, Copy)]
enum Flush<'a> {
    Full,
    #[cfg_attr(not(any(target_os = "macos", target_os = "ios")), allow(dead_code))]
    Ordered(&'a Unflushed),
}

/// The files one folder landed with an ordering flush only, which no full
/// flush has followed yet. Each folder keeps its own, because a full flush
/// reaches only the volume of the directory it is given.
#[derive(Default)]
pub(crate) struct Unflushed {
    waiting: AtomicU64,
    flushing: std::sync::Mutex<()>,
}

impl Unflushed {
    #[cfg_attr(not(any(target_os = "macos", target_os = "ios")), allow(dead_code))]
    fn add(&self, count: u64) {
        self.waiting.fetch_add(count, Ordering::SeqCst);
    }

    /// Makes every file landed with [`land_ordered_at`] against this count
    /// durable, with one full flush of `dir`'s volume where any is waiting.
    /// Takes the lock while it flushes, so a run that finds nothing waiting
    /// is not ahead of a flush another run has begun for its files.
    pub(crate) fn flush(&self, dir: &Directory) -> io::Result<()> {
        let _one = self
            .flushing
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let waiting = self.waiting.swap(0, Ordering::SeqCst);
        if waiting == 0 {
            return Ok(());
        }
        count(Counted::Full);
        dir.sync().inspect_err(|_| self.add(waiting))
    }
}

#[cfg(unix)]
fn order_dir(dir: &Directory) -> io::Result<()> {
    // Any failure of the cheaper flush falls back to a full one, so the
    // rename is ordered before what the caller records next.
    order(dir.file()).or_else(|_| {
        count(Counted::Full);
        dir.sync()
    })
}

#[cfg(not(unix))]
fn order_dir(dir: &Directory) -> io::Result<()> {
    count(Counted::Full);
    dir.sync()
}

/// Flushes `file` so that what it holds reaches the media before anything
/// written after this call. Where the file system has no such flush, a full
/// one.
fn order(file: &File) -> io::Result<()> {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        use std::os::fd::AsRawFd;
        let result = if let Some(errno) = forced_barrier_error() {
            Err(io::Error::from_raw_os_error(errno))
        } else {
            loop {
                // SAFETY: the descriptor is open for as long as `file` is.
                match unsafe { libc::fcntl(file.as_raw_fd(), libc::F_BARRIERFSYNC) } {
                    -1 => {
                        let error = io::Error::last_os_error();
                        if error.kind() != io::ErrorKind::Interrupted {
                            break Err(error);
                        }
                    }
                    _ => break Ok(()),
                }
            }
        };
        match result {
            Ok(()) => {
                count(Counted::Barrier);
                return Ok(());
            }
            // Network volumes and ExFAT do not know it.
            Err(error)
                if matches!(
                    error.raw_os_error(),
                    Some(libc::ENOTSUP | libc::EINVAL | libc::ENOTTY)
                ) => {}
            Err(error) => return Err(error),
        }
    }
    count(Counted::Full);
    file.sync_all()
}

#[cfg(test)]
thread_local! {
    /// An error number the ordering flush fails with, where a test asks.
    #[allow(dead_code)]
    pub(crate) static FORCE_BARRIER_ERROR: std::cell::Cell<Option<i32>> = const { std::cell::Cell::new(None) };
    pub(crate) static COUNTS: std::cell::Cell<(u32, u32)> = const { std::cell::Cell::new((0, 0)) };
}

#[cfg(all(test, any(target_os = "macos", target_os = "ios")))]
fn forced_barrier_error() -> Option<i32> {
    FORCE_BARRIER_ERROR.with(std::cell::Cell::get)
}

#[cfg(all(not(test), any(target_os = "macos", target_os = "ios")))]
fn forced_barrier_error() -> Option<i32> {
    None
}

enum Counted {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    Barrier,
    Full,
}

#[cfg(test)]
fn count(kind: Counted) {
    COUNTS.with(|counts| {
        let (barrier, full) = counts.get();
        counts.set(match kind {
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            Counted::Barrier => (barrier + 1, full),
            Counted::Full => (barrier, full + 1),
        });
    });
}

#[cfg(not(test))]
fn count(_: Counted) {}

fn land_flushed(
    dir: &Directory,
    guard: Option<Guard<'_>>,
    target: &Path,
    fill: impl FnOnce(&mut File, &Path) -> io::Result<()>,
    still: impl FnOnce(Option<&[u8]>) -> bool,
    flush: Flush<'_>,
) -> Result<Metadata, Unlanded> {
    let read = Held::take(dir, target)?;
    if let (Some(read), Some(guard)) = (&read, guard)
        && guard.writers.of(&read.file) == Writers::Open
    {
        return Err(Unlanded::Busy);
    }
    let (mut file, beside) = beside(dir)?;
    let landed = (|| {
        // A file written anew keeps the permission the one it replaces had,
        // and one its owner made read-only is refused, as a write in place
        // would be, though a rename could replace it.
        if let Some(read) = &read {
            if read.metadata.permissions().readonly() {
                return Err(Unlanded::Failed(io::Error::from(
                    io::ErrorKind::PermissionDenied,
                )));
            }
            file.set_permissions(read.metadata.permissions())?;
            keep_attributes(&read.file, &file);
        }
        fill(&mut file, &beside)?;
        if crate::fault::named("sync-failure").is_some_and(|name| {
            target
                .file_name()
                .is_some_and(|file| file.to_string_lossy() == name)
        }) {
            return Err(Unlanded::Failed(io::Error::other(
                "sync refused by fixture",
            )));
        }
        match flush {
            Flush::Full => {
                count(Counted::Full);
                file.sync_all()?
            }
            Flush::Ordered(_) => order(&file)?,
        }
        // The rename keeps the identity, size, modification time and
        // executable bits the scan compares. A later path lookup might
        // describe a person's save instead.
        let written = file.metadata()?;
        save_meanwhile(dir, target);
        if !still(read.as_ref().map(|read| read.bytes.as_slice())) {
            return Err(Unlanded::Changed);
        }
        save_after_last_look(dir, target);
        write_after_last_look(dir, target);
        crash_if_named(target, "crash-before-rename");
        appear_at(dir, target, "create-before-rename")?;
        match (&read, guard) {
            (None, _) => {
                rename_new_at(dir, &beside, dir, target).map_err(|error| {
                    if error.kind() == io::ErrorKind::AlreadyExists {
                        Unlanded::Changed
                    } else {
                        Unlanded::Failed(error)
                    }
                })?;
            }
            (Some(read), Some(guard)) => replace(dir, guard, target, &beside, &written, read)?,
            (Some(_), None) => dir.rename(&beside, dir, target, false)?,
        }
        Ok(written)
    })();
    drop(file);
    if landed.is_err() {
        // Gone already where a guarded replace moved it to a reserved name.
        let _ = dir.unlink(&beside);
        return landed;
    }
    // The rename is only durable once its directory is; a failure here
    // leaves the new file in place all the same.
    match flush {
        Flush::Full => {
            count(Counted::Full);
            let _ = dir.sync();
        }
        Flush::Ordered(unflushed) => {
            // Counted pending even where the ordering flush fails: the run's
            // full flush then covers the rename.
            unflushed.add(1);
            let _ = order_dir(dir);
        }
    }
    landed
}

/// Where a guarded write or removal keeps a file it moves out of its path:
/// `aside`, a directory on the target's volume and never inside the folder's
/// state, which the folder clears, and the ledger that records the move.
/// Where `beside` is false, a save that cannot go back to its path stays
/// under its reserved name in `aside`, rather than at a numbered name beside
/// the path.
#[derive(Clone, Copy)]
pub(crate) struct Guard<'a> {
    pub(crate) aside: &'a Directory,
    pub(crate) ledger: &'a dyn Ledger,
    pub(crate) beside: bool,
    /// What tells whether a program holds a file open for writing.
    pub(crate) writers: &'a Census,
}

/// Records each move of a person's file out of its path before the rename,
/// so a run that stops after it is settled from the disk at the next pass,
/// and hears of a file kept beside its path.
pub(crate) trait Ledger {
    fn record(&self, displacement: &Displacement) -> io::Result<()>;
    fn clear(&self, displacement: &Displacement);
    /// A person's file kept at `name`: beside its path, in the target's
    /// directory, or under its reserved name in the aside directory.
    fn kept(&self, name: &Path, aside: bool, reason: String);
    /// Records the file read, out of its path and kept under its reserved
    /// name in the aside directory, for each pass to settle.
    fn retain(&self, retained: &Retained) -> io::Result<()>;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Displaced {
    /// A replace by an exchange of the two names, which leaves the path
    /// empty at no moment.
    Exchange,
    /// A replace where the volume cannot exchange names: the file read moves
    /// aside first, so the path is empty until the new file lands.
    Aside,
    Withdraw,
}

/// A file by its device and inode, and by its length and modification time
/// or by the hash of its bytes, so an inode used again later is not taken
/// for it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Object {
    pub(crate) device: u64,
    pub(crate) inode: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) length: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) modified: Option<(u64, u32)>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) hash: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Displacement {
    pub(crate) id: String,
    pub(crate) kind: Displaced,
    /// The target's name in its directory.
    pub(crate) target: String,
    /// The reserved name, in the aside directory, the file read goes to.
    pub(crate) kept: String,
    /// The reserved name the new file waits at, and that file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) ours: Option<(String, Object)>,
    pub(crate) read: Object,
}

/// A file as the caller last read it, held open, so its inode cannot be
/// another file's while it is held.
struct Held {
    file: File,
    metadata: Metadata,
    bytes: Vec<u8>,
}

impl Held {
    fn take(dir: &Directory, target: &Path) -> io::Result<Option<Held>> {
        let mut file = match dir.open_file(target, OFlags::RDONLY, Mode::empty()) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        let metadata = file.metadata()?;
        let mut bytes = Vec::with_capacity(usize::try_from(metadata.len()).unwrap_or(0));
        file.read_to_end(&mut bytes)?;
        Ok(Some(Held {
            file,
            metadata,
            bytes,
        }))
    }

    fn object(&self) -> Object {
        let (device, inode) = identity(&self.metadata);
        Object {
            device,
            inode,
            length: None,
            modified: None,
            hash: Some(crate::folder::state::hash(&self.bytes)),
        }
    }

    /// Whether its bytes, read again through the held descriptor, are still
    /// those it was read with.
    fn unchanged(&self) -> io::Result<bool> {
        self.proved().unchanged()
    }

    fn proved(&self) -> Proved<'_> {
        Proved {
            file: &self.file,
            bytes: Proof::Bytes(&self.bytes),
        }
    }
}

/// A file open, with what tells whether it still holds the bytes it was
/// proved to hold.
#[derive(Clone, Copy)]
struct Proved<'a> {
    file: &'a File,
    bytes: Proof<'a>,
}

#[derive(Clone, Copy)]
enum Proof<'a> {
    Bytes(&'a [u8]),
    Hash(&'a str),
}

impl Proved<'_> {
    fn unchanged(&self) -> io::Result<bool> {
        let mut file = self.file;
        file.seek(io::SeekFrom::Start(0))?;
        match self.bytes {
            Proof::Bytes(bytes) => same_bytes(file, bytes),
            Proof::Hash(hash) => {
                let mut bytes = Vec::new();
                file.read_to_end(&mut bytes)?;
                Ok(crate::folder::state::hash(&bytes) == hash)
            }
        }
    }
}

/// Whether `reader` holds exactly `bytes`, read a chunk at a time, so a
/// large file is never held twice.
fn same_bytes(mut reader: impl Read, bytes: &[u8]) -> io::Result<bool> {
    let mut chunk = vec![0; 1 << 16];
    let mut at = 0;
    loop {
        let read = match reader.read(&mut chunk) {
            Ok(0) => return Ok(at == bytes.len()),
            Ok(read) => read,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        };
        if bytes.get(at..at + read) != chunk.get(..read) {
            return Ok(false);
        }
        at += read;
    }
}

pub(crate) fn identity(metadata: &Metadata) -> (u64, u64) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        (metadata.dev(), metadata.ino())
    }
    #[cfg(not(unix))]
    {
        let _ = metadata;
        (0, 0)
    }
}

fn modified(time: std::time::SystemTime) -> Option<(u64, u32)> {
    time.duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|since| (since.as_secs(), since.subsec_nanos()))
}

/// When the file's status last changed, which every write moves and no
/// program can set.
fn changed_at(metadata: &Metadata) -> Option<(u64, u32)> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        u64::try_from(metadata.ctime())
            .ok()
            .zip(u32::try_from(metadata.ctime_nsec()).ok())
    }
    #[cfg(not(unix))]
    {
        let _ = metadata;
        None
    }
}

pub(crate) fn seconds(time: std::time::SystemTime) -> u64 {
    time.duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |since| since.as_secs())
}

fn written_object(written: &Metadata) -> Object {
    let (device, inode) = identity(written);
    Object {
        device,
        inode,
        length: Some(written.len()),
        modified: written.modified().ok().and_then(modified),
        hash: None,
    }
}

/// What a run knows a file at a name by: the files it holds, or after a
/// crash, only what it recorded.
#[derive(Clone, Copy)]
enum Known<'a> {
    Held {
        ours: Option<&'a Object>,
        read: Option<&'a Held>,
    },
    Recorded(&'a Displacement),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Found {
    Absent,
    /// The new file this run wrote.
    Ours,
    /// The file read, its bytes unchanged.
    Read,
    /// Anything else: a person's file, a link, a directory.
    Other,
}

fn found(dir: &Directory, name: &Path, known: Known<'_>) -> io::Result<Found> {
    let at = match dir.entry_identity(name) {
        Ok(at) => at,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Found::Absent),
        // Not a regular file.
        Err(error) if error.kind() == io::ErrorKind::InvalidInput => return Ok(Found::Other),
        Err(error) => return Err(error),
    };
    let ours = match known {
        Known::Held { ours, .. } => ours,
        Known::Recorded(displacement) => displacement.ours.as_ref().map(|(_, ours)| ours),
    };
    // Matched by length and time too, so a write into the new file in place
    // makes it a person's.
    if let Some(ours) = ours
        && (ours.device, ours.inode) == at
    {
        let (_, length, time) = dir.entry_stat(name)?;
        if ours.length == Some(length) && ours.modified == modified(time) {
            return Ok(Found::Ours);
        }
    }
    match known {
        Known::Held { read, .. } => {
            if let Some(read) = read
                && identity(&read.metadata) == at
                && read.unchanged()?
            {
                return Ok(Found::Read);
            }
        }
        Known::Recorded(displacement) => {
            let read = &displacement.read;
            if (read.device, read.inode) == at
                && read.hash.as_deref()
                    == Some(crate::folder::state::hash(&dir.read(name)?).as_str())
            {
                return Ok(Found::Read);
            }
        }
    }
    Ok(Found::Other)
}

/// A name no sweep removes and no walk takes, in a directory on the target's
/// volume.
pub(crate) fn reserved(id: &str) -> PathBuf {
    PathBuf::from(format!("{RESERVED}{id}.tmp"))
}

const RESERVED: &str = ".marfa-kept-";

/// Whether `path` names a file a guarded write or removal moved aside.
pub(crate) fn is_reserved(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with(RESERVED) && name.ends_with(".tmp"))
}

fn name_of(target: &Path) -> io::Result<String> {
    target
        .to_str()
        .filter(|name| !name.contains('/'))
        .map(str::to_string)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "not a plain UTF-8 name"))
}

fn discard(aside: &Directory, name: &Path) -> io::Result<()> {
    match aside.unlink(name) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        result => result,
    }
}

/// A file read and moved out of its path, kept under its reserved name in
/// the aside directory while a program may still write to it through a
/// descriptor it held before the move.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Retained {
    pub(crate) id: String,
    pub(crate) kind: Displaced,
    /// The target's name in its directory.
    pub(crate) target: String,
    /// Its reserved name in the aside directory.
    pub(crate) kept: String,
    /// The new file that took the target's path, where one did.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) ours: Option<Object>,
    /// The file as it was set aside: its identity, length, modification time
    /// and the hash of the bytes proved.
    pub(crate) read: Object,
    /// When its status last changed as it was set aside.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) changed: Option<(u64, u32)>,
    /// When it was set aside, in seconds since the Unix epoch.
    pub(crate) since: u64,
    /// What the last look found holding it open for writing, where one was
    /// made.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) writers: Option<Writers>,
}

/// How long a file set aside and never changed is kept where it cannot be
/// told whether a program still holds it open for writing.
pub(crate) const RETAINED_FOR: u64 = 7 * 24 * 60 * 60;

enum LetGo {
    /// Discarded, or kept for each pass to settle.
    Gone,
    /// Its bytes are no longer those proved: a program wrote to it.
    Changed,
}

/// The one place that decides what becomes of the file read, once it is out
/// of its path at `name` in the aside directory and proved to be that file:
/// discarded only where no program holds it open for writing and it is
/// still unchanged, and otherwise recorded and kept for each pass to settle.
/// `ours` is the new file at its path, where one took it.
fn let_go(
    guard: Guard<'_>,
    displacement: &Displacement,
    name: &Path,
    ours: Option<&Object>,
    proved: Proved<'_>,
) -> io::Result<LetGo> {
    // Taken before the bytes are checked, so a write after the check shows
    // in what is recorded, and asked before, so no writer can close after
    // the answer and leave its last bytes unchecked.
    let metadata = proved.file.metadata()?;
    let writers = guard
        .writers
        .current()
        .then(|| guard.writers.of(proved.file));
    if !proved.unchanged()? {
        return Ok(LetGo::Changed);
    }
    if writers == Some(Writers::None) {
        discard(guard.aside, name)?;
        return Ok(LetGo::Gone);
    }
    let (device, inode) = identity(&metadata);
    let retained = Retained {
        id: displacement.id.clone(),
        kind: displacement.kind,
        target: displacement.target.clone(),
        kept: name_of(name)?,
        ours: ours.cloned(),
        read: Object {
            device,
            inode,
            length: Some(metadata.len()),
            modified: metadata.modified().ok().and_then(modified),
            hash: displacement.read.hash.clone(),
        },
        changed: changed_at(&metadata),
        since: seconds(crate::clock::system_time()),
        writers,
    };
    if let Err(error) = guard.ledger.retain(&retained) {
        guard.ledger.kept(
            name,
            true,
            format!(
                "it is {} as Marfa read it before it replaced or removed the file, kept because a program may still write to it, and Marfa could not record it to look again: {error}; check it, and delete it when it is not needed",
                displacement.target
            ),
        );
    }
    Ok(LetGo::Gone)
}

/// What became of a file kept by [`let_go`] when a pass settled it.
#[derive(Debug)]
pub(crate) enum Settled {
    /// Its reserved name no longer holds it, so there is nothing to settle.
    Gone,
    /// Unchanged, and no program can still write to it.
    Discarded,
    /// Changed, and back at its path in place of the new file, which goes.
    /// Answers the metadata of the file now at the path, and the bytes of
    /// the new file it replaced.
    PutBack {
        metadata: Metadata,
        replaced: Vec<u8>,
    },
    /// Changed after its removal, and back at its empty path.
    Restored,
    /// Changed, and kept beside its path under the name answered, or under
    /// its reserved name where it cannot go there, and reported.
    Beside(PathBuf),
    /// Unchanged, and kept, with what this look found.
    Kept(Retained),
}

/// Settles `retained`, whose reserved name `file` was opened from, with
/// `writers`, what was found holding it open for writing at `now`, in
/// seconds since the Unix epoch.
pub(crate) fn settle_retained(
    dir: &Directory,
    guard: Guard<'_>,
    retained: &Retained,
    file: &File,
    writers: Writers,
    now: u64,
) -> io::Result<Settled> {
    let name = Path::new(&retained.kept);
    let metadata = file.metadata()?;
    let at = identity(&metadata);
    if !is_reserved(name)
        || at != (retained.read.device, retained.read.inode)
        || guard.aside.entry_identity(name).ok() != Some(at)
    {
        return Ok(Settled::Gone);
    }
    let stated = retained.read.length == Some(metadata.len())
        && retained.read.modified == metadata.modified().ok().and_then(modified)
        && retained.changed == changed_at(&metadata);
    let proved = Proved {
        file,
        bytes: Proof::Hash(retained.read.hash.as_deref().unwrap_or_default()),
    };
    // A tag, a mode or new times change the status and leave the bytes. The
    // status taken before the hash is recorded, so a write after it shows.
    if stated || proved.unchanged()? {
        let kept = Retained {
            read: Object {
                length: Some(metadata.len()),
                modified: metadata.modified().ok().and_then(modified),
                ..retained.read.clone()
            },
            changed: changed_at(&metadata),
            writers: Some(writers),
            ..retained.clone()
        };
        let due = match writers {
            Writers::None => true,
            Writers::Unknown => now >= retained.since.saturating_add(RETAINED_FOR),
            Writers::Open => false,
        };
        if !due {
            return Ok(Settled::Kept(kept));
        }
        // A write that keeps the length on a volume with coarse times shows
        // only in the bytes.
        if !stated || proved.unchanged()? {
            match discard_checked(guard.aside, name, Some(at), |_| proved.unchanged())? {
                Discard::Removed => return Ok(Settled::Discarded),
                Discard::Absent => return Ok(Settled::Gone),
                Discard::Stranded(left) => {
                    guard.ledger.kept(
                        &left,
                        true,
                        format!(
                            "it is {} as Marfa set it aside, and it changed as Marfa discarded it; check it, and delete it when it is not needed",
                            retained.target
                        ),
                    );
                    return Ok(Settled::Gone);
                }
                // Back under its reserved name, and put back as any change is.
                Discard::Changed => {}
            }
        }
    }
    let target = Path::new(&retained.target);
    if let Some(ours) = &retained.ours {
        let known = Known::Held {
            ours: Some(ours),
            read: None,
        };
        if found(dir, target, known)? == Found::Ours {
            let replaced = dir.read(target)?;
            match exchange_at(guard.aside, name, dir, target) {
                Ok(()) => {
                    match found(guard.aside, name, known)? {
                        Found::Ours => guard.aside.unlink(name)?,
                        Found::Absent => {}
                        // Saved at the path again as it went back.
                        Found::Read | Found::Other => {
                            keep_beside(dir, guard, target, name)?;
                        }
                    }
                    return Ok(Settled::PutBack {
                        metadata: dir.entry_metadata(target)?,
                        replaced,
                    });
                }
                Err(error) if error.kind() == io::ErrorKind::Unsupported => {}
                Err(error) => return Err(error),
            }
        }
    }
    if retained.kind == Displaced::Withdraw {
        match rename_new_at(guard.aside, name, dir, target) {
            Ok(()) => return Ok(Settled::Restored),
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::AlreadyExists | io::ErrorKind::Unsupported
                ) => {}
            Err(error) => return Err(error),
        }
    }
    keep_beside(dir, guard, target, name).map(Settled::Beside)
}

/// What [`discard_checked`] did with a kept file.
pub(crate) enum Discard {
    Removed,
    /// Nothing was at its name.
    Absent,
    /// It was no longer the file proved, and is back at its name.
    Changed,
    /// It was no longer the file proved, and another file took its name, so
    /// it stays under this private name.
    Stranded(PathBuf),
}

/// A private name keeps a save at the old name out of the final check and unlink.
pub(crate) fn discard_checked(
    dir: &Directory,
    name: &Path,
    at: Option<(u64, u64)>,
    still: impl FnOnce(&Path) -> io::Result<bool>,
) -> io::Result<Discard> {
    write_before_discard(dir, name);
    let private = reserved(&uuid::Uuid::now_v7().simple().to_string());
    match rename_new_at(dir, name, dir, &private) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Discard::Absent),
        Err(error) => return Err(error),
    }
    let same = at.is_none_or(|at| dir.entry_identity(&private).ok() == Some(at));
    if same && still(&private)? {
        discard(dir, &private)?;
        return Ok(Discard::Removed);
    }
    match rename_new_at(dir, &private, dir, name) {
        Ok(()) => Ok(Discard::Changed),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            Ok(Discard::Stranded(private))
        }
        Err(error) => Err(error),
    }
}

fn exchange_at(from_dir: &Directory, from: &Path, to_dir: &Directory, to: &Path) -> io::Result<()> {
    if failing_here("rename-exchange-unsupported")
        || crate::fault::named("rename-exchange-unsupported").is_some_and(|name| {
            name.is_empty()
                || to
                    .file_name()
                    .is_some_and(|file| file.to_string_lossy() == name)
        })
    {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "an atomic swap is unavailable in fixture",
        ));
    }
    from_dir.exchange(from, to_dir, to)
}

/// A run stopping at `point`: the process, where a device fixture names the
/// target, or the thread, where a unit test asks.
pub(crate) fn stop_if_asked(target: &Path, point: &str) {
    crash_if_named(target, point);
    if failing_here(point) {
        panic!("stopped at {point} as the test asks");
    }
}

/// Whether a unit test, or a fixture in its own process, has made `point`
/// fail.
fn failing_here(point: &str) -> bool {
    #[cfg(debug_assertions)]
    return crate::fault::fails(|| point);
    #[cfg(not(debug_assertions))]
    {
        let _ = point;
        false
    }
}

/// Replaces the file `read` came from at `target` with the new file at
/// `temporary`, where the file moved out is that one, unchanged. Anything
/// else moved out goes back to its path, or beside it.
fn replace(
    dir: &Directory,
    guard: Guard<'_>,
    target: &Path,
    temporary: &Path,
    ours: &Metadata,
    read: &Held,
) -> Result<(), Unlanded> {
    let id = uuid::Uuid::now_v7().simple().to_string();
    let waiting = reserved(&id);
    let ours = written_object(ours);
    let mut displacement = Displacement {
        id,
        kind: Displaced::Exchange,
        target: name_of(target)?,
        kept: name_of(&waiting)?,
        ours: Some((name_of(&waiting)?, ours.clone())),
        read: read.object(),
    };
    guard.ledger.record(&displacement)?;
    if let Err(error) = dir.rename(temporary, guard.aside, &waiting, false) {
        guard.ledger.clear(&displacement);
        return Err(error.into());
    }
    let known = Known::Held {
        ours: Some(&ours),
        read: Some(read),
    };
    match exchange_at(guard.aside, &waiting, dir, target) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::Unsupported => {
            return without_exchange(dir, guard, target, (&ours, read), &mut displacement);
        }
        Err(error) => {
            // Nothing moved: the new file still waits at its reserved name.
            guard.aside.unlink(&waiting)?;
            guard.ledger.clear(&displacement);
            return Err(if error.kind() == io::ErrorKind::NotFound {
                Unlanded::Changed
            } else {
                Unlanded::Failed(error)
            });
        }
    }
    stop_if_asked(target, "crash-after-exchange");
    let landed = match found(guard.aside, &waiting, known)? {
        Found::Read => match let_go(guard, &displacement, &waiting, Some(&ours), read.proved())? {
            LetGo::Gone => Ok(()),
            LetGo::Changed => {
                put_back(dir, guard, target, &waiting, known)?;
                landed_after(dir, target, known)
            }
        },
        Found::Other => {
            put_back(dir, guard, target, &waiting, known)?;
            Err(Unlanded::Changed)
        }
        Found::Ours => {
            guard.aside.unlink(&waiting)?;
            Err(Unlanded::Changed)
        }
        Found::Absent => match found(dir, target, known)? {
            Found::Ours => Ok(()),
            _ => Err(Unlanded::Changed),
        },
    };
    guard.ledger.clear(&displacement);
    landed
}

/// [`replace`] where the file system cannot swap two names: the file read
/// moves aside, replacing nothing, and is checked, and only then does the
/// new file move in, replacing nothing. A file made at the path in between
/// stays, and the new file does not land.
fn without_exchange(
    dir: &Directory,
    guard: Guard<'_>,
    target: &Path,
    (ours, read): (&Object, &Held),
    displacement: &mut Displacement,
) -> Result<(), Unlanded> {
    let known = Known::Held {
        ours: Some(ours),
        read: Some(read),
    };
    let waiting = PathBuf::from(
        displacement
            .ours
            .as_ref()
            .map(|(waiting, _)| waiting.clone())
            .unwrap_or_default(),
    );
    let aside = reserved(&uuid::Uuid::now_v7().simple().to_string());
    displacement.kind = Displaced::Aside;
    displacement.kept = name_of(&aside)?;
    if let Err(error) = guard.ledger.record(displacement) {
        guard.aside.unlink(&waiting)?;
        guard.ledger.clear(displacement);
        return Err(error.into());
    }
    let withdrawn = if named_for(target, "rename-new-unsupported") {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "no-replace rename unavailable in fixture",
        ))
    } else {
        rename_new_at(dir, target, guard.aside, &aside)
    };
    if let Err(error) = withdrawn {
        guard.aside.unlink(&waiting)?;
        guard.ledger.clear(displacement);
        return Err(match error.kind() {
            io::ErrorKind::NotFound => Unlanded::Changed,
            io::ErrorKind::Unsupported => Unlanded::Failed(io::Error::new(
                io::ErrorKind::Unsupported,
                "the file system can neither swap two names nor rename without replacing, so a person's save could be lost",
            )),
            _ => Unlanded::Failed(error),
        });
    }
    stop_if_asked(target, "crash-after-withdraw");
    appear_at(dir, target, "create-in-the-gap")?;
    let landed = match found(guard.aside, &aside, known)? {
        Found::Read => match rename_new_at(guard.aside, &waiting, dir, target) {
            Ok(()) => {
                stop_if_asked(target, "crash-after-aside-landing");
                match let_go(guard, displacement, &aside, Some(ours), read.proved())? {
                    LetGo::Gone => Ok(()),
                    LetGo::Changed => {
                        put_back(dir, guard, target, &aside, known)?;
                        landed_after(dir, target, known)
                    }
                }
            }
            Err(error) => {
                guard.aside.unlink(&waiting)?;
                restore(dir, guard, target, &aside, displacement, read.proved())?;
                Err(if error.kind() == io::ErrorKind::AlreadyExists {
                    Unlanded::Changed
                } else {
                    Unlanded::Failed(error)
                })
            }
        },
        Found::Other => {
            put_back(dir, guard, target, &aside, known)?;
            guard.aside.unlink(&waiting)?;
            Err(Unlanded::Changed)
        }
        Found::Absent | Found::Ours => {
            guard.aside.unlink(&waiting)?;
            Err(Unlanded::Changed)
        }
    };
    guard.ledger.clear(displacement);
    landed
}

/// Puts the file read, proved unchanged, back at `target` where nothing
/// took the path; where something did, that is newer, and the file read is
/// let go, or kept beside it where it changed.
fn restore(
    dir: &Directory,
    guard: Guard<'_>,
    target: &Path,
    name: &Path,
    displacement: &Displacement,
    proved: Proved<'_>,
) -> io::Result<()> {
    match rename_new_at(guard.aside, name, dir, target) {
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            match let_go(guard, displacement, name, None, proved)? {
                LetGo::Gone => Ok(()),
                LetGo::Changed => keep_beside(dir, guard, target, name).map(drop),
            }
        }
        result => result,
    }
}

/// What a write answers once a file it moved out of its path changed and
/// went back to its path or beside it: written only where the new file is
/// still at the path.
fn landed_after(dir: &Directory, target: &Path, known: Known<'_>) -> Result<(), Unlanded> {
    match found(dir, target, known)? {
        Found::Ours => Ok(()),
        _ => Err(Unlanded::Changed),
    }
}

/// Puts a file this run did not mean to move, at `name` in the aside
/// directory, back at `target`: in place of the new file where that is at
/// the path, at the path where nothing is, and otherwise beside it. Answers
/// the name beside it, where it went there.
fn put_back(
    dir: &Directory,
    guard: Guard<'_>,
    target: &Path,
    name: &Path,
    known: Known<'_>,
) -> io::Result<Option<PathBuf>> {
    appear_at(dir, target, "create-before-put-back")?;
    let beside = || keep_beside(dir, guard, target, name).map(Some);
    match found(dir, target, known)? {
        Found::Ours => {
            save_during_put_back(dir, target);
            match exchange_at(guard.aside, name, dir, target) {
                Ok(()) => match found(guard.aside, name, known)? {
                    Found::Ours => guard.aside.unlink(name).map(|()| None),
                    Found::Absent => Ok(None),
                    // Saved at the path again as it went back: that save is
                    // kept too.
                    Found::Read | Found::Other => beside(),
                },
                Err(error) if error.kind() == io::ErrorKind::Unsupported => beside(),
                Err(error) => Err(error),
            }
        }
        Found::Absent => match rename_new_at(guard.aside, name, dir, target) {
            Ok(()) => Ok(None),
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::AlreadyExists | io::ErrorKind::Unsupported
                ) =>
            {
                beside()
            }
            Err(error) => Err(error),
        },
        Found::Read | Found::Other => beside(),
    }
}

/// Moves `name`, in the aside directory, to the first free numbered name
/// beside `target`, replacing nothing, and reports it. Answers that name.
pub(crate) fn keep_beside(
    dir: &Directory,
    guard: Guard<'_>,
    target: &Path,
    name: &Path,
) -> io::Result<PathBuf> {
    let target = name_of(target)?;
    if !guard.beside {
        guard.ledger.kept(
            name,
            true,
            format!(
                "it was saved as {target} while Marfa wrote that file, and another save took that name; Marfa never sends a file under this name, so move it back yourself if it is the one you want"
            ),
        );
        return Ok(name.to_path_buf());
    }
    loop {
        let kept = super::placement::beside(&target, |candidate| {
            dir.entry_kind(Path::new(candidate)).is_ok()
        });
        match rename_new_at(guard.aside, name, dir, Path::new(&kept)) {
            Ok(()) => {
                guard.ledger.kept(
                    Path::new(&kept),
                    false,
                    format!(
                        "it was saved while Marfa replaced or removed {target}, and another file took that name"
                    ),
                );
                return Ok(PathBuf::from(kept));
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) if error.kind() == io::ErrorKind::Unsupported => {
                guard.ledger.kept(
                    name,
                    true,
                    format!(
                        "it was saved while Marfa replaced or removed {target}, and this volume cannot move it back without risking another save; move it back yourself"
                    ),
                );
                return Ok(name.to_path_buf());
            }
            Err(error) => return Err(error),
        }
    }
}

/// Settles a displacement a run recorded and did not clear, from what the
/// disk holds now: the new file goes; the file read goes back where the new
/// file never took its path, is kept where the path was emptied after it
/// did, and is otherwise discarded; anything else goes back to its path or
/// beside it. The record is cleared once settled.
pub(crate) fn settle(
    dir: &Directory,
    guard: Guard<'_>,
    displacement: &Displacement,
) -> io::Result<()> {
    let target = Path::new(&displacement.target);
    let known = Known::Recorded(displacement);
    let mut names = vec![displacement.kept.as_str()];
    if let Some((waiting, _)) = &displacement.ours
        && *waiting != displacement.kept
    {
        names.push(waiting);
    }
    for name in names {
        let name = Path::new(name);
        if !is_reserved(name) {
            continue;
        }
        match found(guard.aside, name, known)? {
            Found::Absent => {}
            Found::Ours => guard.aside.unlink(name)?,
            Found::Read => {
                let file = guard.aside.open_file(name, OFlags::RDONLY, Mode::empty())?;
                if identity(&file.metadata()?)
                    != (displacement.read.device, displacement.read.inode)
                {
                    drop(put_back(dir, guard, target, name, known)?);
                    continue;
                }
                let proved = Proved {
                    file: &file,
                    bytes: Proof::Hash(displacement.read.hash.as_deref().unwrap_or_default()),
                };
                settle_read(dir, guard, displacement, name, proved)?;
            }
            Found::Other => drop(put_back(dir, guard, target, name, known)?),
        }
    }
    guard.ledger.clear(displacement);
    Ok(())
}

/// Settles the file read, found unchanged at `name` after a run stopped.
fn settle_read(
    dir: &Directory,
    guard: Guard<'_>,
    displacement: &Displacement,
    name: &Path,
    proved: Proved<'_>,
) -> io::Result<()> {
    let target = Path::new(&displacement.target);
    let known = Known::Recorded(displacement);
    match (displacement.kind, found(dir, target, known)?) {
                // Where the volume cannot exchange names, the path is empty
                // in the gap, while the new file still waits.
                (Displaced::Aside, Found::Absent) if waits(guard, displacement)? => {
                    restore(dir, guard, target, name, displacement, proved)?
                }
                // Once the new file has taken the path, an empty path is the
                // person's delete.
                (Displaced::Aside | Displaced::Exchange, Found::Absent) => guard.ledger.kept(
                    name,
                    true,
                    format!(
                        "it is {} as Marfa read it before it replaced the file, which was then deleted; it is kept rather than put back over that delete, so delete it when it is not needed",
                        displacement.target
                    ),
                ),
                (_, at) => {
                    let ours = displacement
                        .ours
                        .as_ref()
                        .filter(|_| at == Found::Ours)
                        .map(|(_, ours)| ours);
                    if let LetGo::Changed = let_go(guard, displacement, name, ours, proved)? {
                        drop(put_back(dir, guard, target, name, known)?);
                    }
                }
    }
    Ok(())
}

/// Whether the new file of `displacement` still waits under its reserved
/// name, so it never took the path.
fn waits(guard: Guard<'_>, displacement: &Displacement) -> io::Result<bool> {
    let Some((waiting, _)) = &displacement.ours else {
        return Ok(false);
    };
    Ok(found(
        guard.aside,
        Path::new(waiting),
        Known::Recorded(displacement),
    )? == Found::Ours)
}

/// Move only into an absent directory entry, including refusing a dangling
/// symlink. Unsupported kernels or filesystems must not fall back to replacing
/// a destination after a separate existence check.
pub(crate) fn rename_new_at(
    from_dir: &Directory,
    from: &Path,
    to_dir: &Directory,
    to: &Path,
) -> io::Result<()> {
    if failing_here("rename-new-unsupported") || named_for(to, "rename-new-unsupported") {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "no-replace publication unavailable in fixture",
        ));
    }
    from_dir.rename(from, to_dir, to, true)
}

/// Removes `target` where `still` says its bytes are what the caller decided
/// to remove, and it is still that file as it goes. Answers whether it did;
/// a target already gone answers `false`.
pub(crate) fn remove_at(
    dir: &Directory,
    guard: Guard<'_>,
    target: &Path,
    still: impl FnOnce(&[u8]) -> bool,
) -> io::Result<bool> {
    remove_checked_at(dir, guard, target, still).map_err(|error| match error {
        RemoveError::Read(error) | RemoveError::Remove(error) => error,
    })
}

pub(crate) enum RemoveError {
    Read(io::Error),
    Remove(io::Error),
}

pub(crate) fn remove_checked_at(
    dir: &Directory,
    guard: Guard<'_>,
    target: &Path,
    still: impl FnOnce(&[u8]) -> bool,
) -> Result<bool, RemoveError> {
    Ok(matches!(
        withdraw_at(dir, guard, target, still, || Ok(()))?,
        Withdrawal::Removed
    ))
}

#[derive(Debug)]
pub(crate) enum Withdrawal {
    /// Nothing was at the target.
    Absent,
    /// `still` declined it, or it changed as it went, and it is back at its
    /// path, or beside it under the name given.
    Kept(Option<PathBuf>),
    /// Out of its path, and `then` done.
    Removed,
    /// `then` failed, and the file is back at its path, or, where another
    /// took that, gone for it.
    Undone(io::Error),
}

/// Moves `target` aside, replacing nothing, where `still` says its bytes are
/// what the caller decided to remove; then, where what moved is that file
/// unchanged, runs `then` and discards it. Anything else that moved goes
/// back to its path, or beside it. A volume that cannot rename without
/// replacing leaves the file in place, as `Unsupported`.
pub(crate) fn withdraw_at(
    dir: &Directory,
    guard: Guard<'_>,
    target: &Path,
    still: impl FnOnce(&[u8]) -> bool,
    then: impl FnOnce() -> io::Result<()>,
) -> Result<Withdrawal, RemoveError> {
    save_meanwhile(dir, target);
    let read = match Held::take(dir, target) {
        Ok(Some(read)) => read,
        Ok(None) => return Ok(Withdrawal::Absent),
        Err(error) => return Err(RemoveError::Read(error)),
    };
    if !still(&read.bytes) {
        return Ok(Withdrawal::Kept(None));
    }
    if guard.writers.of(&read.file) == Writers::Open {
        return Err(RemoveError::Remove(busy()));
    }
    save_after_last_look(dir, target);
    write_after_last_look(dir, target);
    let id = uuid::Uuid::now_v7().simple().to_string();
    let aside = reserved(&id);
    let displacement = Displacement {
        id,
        kind: Displaced::Withdraw,
        target: name_of(target).map_err(RemoveError::Remove)?,
        kept: name_of(&aside).map_err(RemoveError::Remove)?,
        ours: None,
        read: read.object(),
    };
    guard
        .ledger
        .record(&displacement)
        .map_err(RemoveError::Remove)?;
    let moved =
        if failing_here("rename-new-unsupported") || named_for(target, "rename-new-unsupported") {
            Err(io::Error::from(io::ErrorKind::Unsupported))
        } else {
            rename_new_at(dir, target, guard.aside, &aside)
        };
    if let Err(error) = moved {
        guard.ledger.clear(&displacement);
        return match error.kind() {
            io::ErrorKind::NotFound => Ok(Withdrawal::Absent),
            io::ErrorKind::Unsupported => Err(RemoveError::Remove(io::Error::new(
                io::ErrorKind::Unsupported,
                "the volume cannot rename a file without replacing another, so Marfa leaves it rather than risk a save made as it goes",
            ))),
            _ => Err(RemoveError::Remove(error)),
        };
    }
    stop_if_asked(target, "crash-after-withdraw");
    if failing_here("withdraw-look-refused") || named_for(target, "withdraw-look-refused") {
        return Err(RemoveError::Remove(io::Error::from(
            io::ErrorKind::PermissionDenied,
        )));
    }
    let known = Known::Held {
        ours: None,
        read: Some(&read),
    };
    let withdrawn = (|| match found(guard.aside, &aside, known)? {
        Found::Read => match then() {
            Ok(()) => match let_go(guard, &displacement, &aside, None, read.proved())? {
                LetGo::Gone => Ok(Withdrawal::Removed),
                LetGo::Changed => Ok(Withdrawal::Kept(put_back(
                    dir, guard, target, &aside, known,
                )?)),
            },
            Err(error) => {
                restore(dir, guard, target, &aside, &displacement, read.proved())?;
                Ok(Withdrawal::Undone(error))
            }
        },
        Found::Other => Ok(Withdrawal::Kept(put_back(
            dir, guard, target, &aside, known,
        )?)),
        Found::Absent | Found::Ours => Ok(Withdrawal::Kept(None)),
    })()
    .map_err(RemoveError::Remove)?;
    guard.ledger.clear(&displacement);
    Ok(withdrawn)
}

pub(crate) fn crash_if_named(target: &Path, fault: &str) {
    if named_for(target, fault) {
        eprintln!("crashing at {} as MARFA_TEST_FAULT asks", target.display());
        std::process::abort();
    }
}

/// Whether `MARFA_TEST_FAULT` names `fault` with the target's file name.
pub(crate) fn named_for(target: &Path, fault: &str) -> bool {
    crate::fault::named(fault).is_some_and(|name| {
        target
            .file_name()
            .is_some_and(|file| file.to_string_lossy() == name)
    })
}

/// A competing file arriving after the last check, where a debug fixture asks.
pub(crate) fn appear_at(dir: &Directory, target: &Path, fault: &str) -> io::Result<()> {
    #[cfg(unix)]
    if fault == "create-before-rename"
        && crate::fault::named("symlink-before-rename").is_some_and(|name| {
            target
                .file_name()
                .is_some_and(|file| file.to_string_lossy() == name)
        })
    {
        return rustix::fs::symlinkat("absent-fixture-target", dir.file(), target)
            .map_err(Into::into);
    }
    if failing_here(fault) || named_for(target, fault) {
        dir.open_file(
            target,
            OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL,
            Mode::from_raw_mode(0o666),
        )?
        .write_all(b"appeared meanwhile\n")?;
    }
    Ok(())
}

/// A Finder tag, say, which a file written anew would otherwise lose.
#[cfg(target_os = "macos")]
fn keep_attributes(from: &File, to: &File) {
    use xattr::FileExt;
    let Ok(names) = from.list_xattr() else {
        return;
    };
    for name in names {
        if let Ok(Some(value)) = from.get_xattr(&name) {
            let _ = to.set_xattr(&name, &value);
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn keep_attributes(_from: &File, _to: &File) {}

/// A file a write left beside its target, named for a process no longer
/// running: what a crash before the rename leaves.
pub(crate) fn left_behind(path: &Path) -> bool {
    let Some(pid) = path
        .file_name()
        .and_then(|name| name.to_str())
        .and_then(|name| name.strip_prefix(".marfa-"))
        .and_then(|rest| rest.strip_suffix(".tmp"))
        .and_then(|rest| rest.split_once('-'))
        .filter(|(_, count)| count.parse::<u64>().is_ok())
        .and_then(|(pid, _)| pid.parse::<i32>().ok())
    else {
        return false;
    };
    pid != std::process::id().cast_signed() && !running(pid)
}

#[cfg(unix)]
fn running(pid: i32) -> bool {
    match rustix::process::Pid::from_raw(pid) {
        Some(pid) => !matches!(
            rustix::process::test_kill_process(pid),
            Err(rustix::io::Errno::SRCH)
        ),
        None => true,
    }
}

#[cfg(not(unix))]
fn running(_pid: i32) -> bool {
    true
}

/// A person's save made between the folder's decision and its last look.
pub(crate) fn save_meanwhile(dir: &Directory, target: &Path) {
    if crate::fault::named("save-before-last-look").is_some()
        && target
            .extension()
            .is_some_and(|extension| extension == "md")
        && dir.entry_metadata(target).is_ok()
    {
        let _ = dir
            .open_file(target, OFlags::WRONLY | OFlags::APPEND, Mode::empty())
            .and_then(|mut file| file.write_all(b"saved meanwhile\n"));
    }
}

/// A person's save, made as an editor makes one, by renaming a new file over
/// the target, after the folder's last look at it, where a fixture names the
/// target or a unit test asks.
fn save_after_last_look(dir: &Directory, target: &Path) {
    save_over(
        dir,
        target,
        "save-after-last-look",
        b"saved after the last look\n",
    );
}

/// Another save made the same way, as a file moved out by mistake goes back.
fn save_during_put_back(dir: &Directory, target: &Path) {
    save_over(dir, target, "save-during-put-back", b"saved again\n");
}

/// A program's write into a kept file, after the look that found it
/// unchanged and before it is discarded.
pub(crate) fn write_before_discard(dir: &Directory, name: &Path) {
    if asked_for(dir, name, "write-before-discard") {
        let _ = dir
            .open_file(name, OFlags::WRONLY | OFlags::APPEND, Mode::empty())
            .and_then(|mut file| file.write_all(b"written before the discard\n"));
    }
}

/// A person's write into the file in place, after the folder's last look.
fn write_after_last_look(dir: &Directory, target: &Path) {
    if asked_for(dir, target, "write-after-last-look") {
        let _ = dir
            .open_file(target, OFlags::WRONLY | OFlags::APPEND, Mode::empty())
            .and_then(|mut file| file.write_all(b"written after the last look\n"));
    }
}

/// Whether a unit test or a fixture asks for `fault` at `target`, an existing
/// file; with no file name, at every document a pass writes or removes.
fn asked_for(dir: &Directory, target: &Path, fault: &str) -> bool {
    let asked = failing_here(fault)
        || crate::fault::named(fault).is_some_and(|name| {
            if name.is_empty() {
                target
                    .extension()
                    .is_some_and(|extension| extension == "md")
            } else {
                target
                    .file_name()
                    .is_some_and(|file| file.to_string_lossy() == name)
            }
        });
    asked && dir.entry_identity(target).is_ok()
}

fn save_over(dir: &Directory, target: &Path, fault: &str, line: &[u8]) {
    if !asked_for(dir, target, fault) {
        return;
    }
    let mut bytes = dir.read(target).unwrap_or_default();
    // A settings file stays one that reads.
    if target
        .extension()
        .is_some_and(|extension| extension == "yaml")
    {
        bytes.extend_from_slice(b"# ");
    }
    bytes.extend_from_slice(line);
    let staged = PathBuf::from(format!(".{}.saving", target.display()));
    let _ = dir.unlink(&staged);
    let _ = dir
        .open_file(
            &staged,
            OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL,
            Mode::from_raw_mode(0o666),
        )
        .and_then(|mut file| file.write_all(&bytes))
        .and_then(|()| dir.rename(&staged, dir, target, false));
}

/// Named so the built-in lists never take it (`*.tmp`), and in the target's
/// own directory, so the rename never crosses a volume.
fn aside_name() -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    PathBuf::from(format!(
        ".marfa-{}-{}.tmp",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ))
}

fn beside(dir: &Directory) -> io::Result<(File, PathBuf)> {
    loop {
        let path = aside_name();
        match dir.open_file(
            &path,
            OFlags::RDWR | OFlags::CREATE | OFlags::EXCL,
            Mode::from_raw_mode(0o666),
        ) {
            Ok(file) => return Ok((file, path)),
            // Left by a crashed process that had this id.
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
    }
}

/// A ledger held in memory, for a test.
#[cfg(test)]
#[derive(Default)]
pub(crate) struct Memory {
    pub(crate) rows: std::cell::RefCell<Vec<Displacement>>,
    pub(crate) kept: std::cell::RefCell<Vec<(PathBuf, String)>>,
    pub(crate) retained: std::cell::RefCell<Vec<Retained>>,
    /// Refuses every record, as a store on a full disk does.
    pub(crate) full: std::cell::Cell<bool>,
}

#[cfg(test)]
impl Ledger for Memory {
    fn record(&self, displacement: &Displacement) -> io::Result<()> {
        if self.full.get() {
            return Err(io::Error::from(io::ErrorKind::StorageFull));
        }
        let mut rows = self.rows.borrow_mut();
        rows.retain(|row| row.id != displacement.id);
        rows.push(displacement.clone());
        Ok(())
    }

    fn clear(&self, displacement: &Displacement) {
        self.rows
            .borrow_mut()
            .retain(|row| row.id != displacement.id);
    }

    fn kept(&self, name: &Path, _aside: bool, reason: String) {
        self.kept.borrow_mut().push((name.to_path_buf(), reason));
    }

    fn retain(&self, retained: &Retained) -> io::Result<()> {
        if self.full.get() {
            return Err(io::Error::from(io::ErrorKind::StorageFull));
        }
        let mut kept = self.retained.borrow_mut();
        kept.retain(|row| row.id != retained.id);
        kept.push(retained.clone());
        Ok(())
    }
}

#[cfg(test)]
impl Memory {
    /// Settles every file retained, as a pass does: each opened, then one
    /// fresh look at the programs writing them. Answers what became of each.
    pub(crate) fn settle(&self, dir: &Directory, guard: Guard<'_>, now: u64) -> Vec<Settled> {
        let rows = self.retained.take();
        let files: Vec<_> = rows
            .iter()
            .map(|row| {
                guard
                    .aside
                    .open_file(Path::new(&row.kept), OFlags::RDONLY, Mode::empty())
            })
            .collect();
        guard.writers.fresh();
        let mut settled = Vec::new();
        for (row, file) in rows.iter().zip(files) {
            let Ok(file) = file else {
                settled.push(Settled::Gone);
                continue;
            };
            let writers = guard.writers.of(&file);
            let outcome = settle_retained(dir, guard, row, &file, writers, now).unwrap();
            if let Settled::Kept(kept) = &outcome {
                self.retained.borrow_mut().push(kept.clone());
            }
            settled.push(outcome);
        }
        settled
    }
}

#[cfg(test)]
pub(crate) fn land(
    target: &Path,
    fill: impl FnOnce(&mut File, &Path) -> io::Result<()>,
    still: impl FnOnce(Option<&[u8]>) -> bool,
) -> Result<(), Unlanded> {
    let dir = Directory::open(&target.parent().unwrap().canonicalize()?)?;
    let ledger = Memory::default();
    let guard = Guard {
        aside: &dir,
        ledger: &ledger,
        beside: true,
        writers: &Census::default(),
    };
    let landed = land_at(
        &dir,
        guard,
        Path::new(target.file_name().unwrap()),
        fill,
        still,
    )
    .map(drop);
    ledger.settle(&dir, guard, now());
    landed
}

#[cfg(test)]
fn now() -> u64 {
    seconds(crate::clock::system_time())
}

#[cfg(test)]
fn rename_new(from: &Path, to: &Path) -> io::Result<()> {
    rename_new_at(
        &Directory::open(&from.parent().unwrap().canonicalize()?)?,
        Path::new(from.file_name().unwrap()),
        &Directory::open(&to.parent().unwrap().canonicalize()?)?,
        Path::new(to.file_name().unwrap()),
    )
}

#[cfg(test)]
fn remove(target: &Path, still: impl FnOnce(&[u8]) -> bool) -> io::Result<bool> {
    let dir = Directory::open(&target.parent().unwrap().canonicalize()?)?;
    let ledger = Memory::default();
    let guard = Guard {
        aside: &dir,
        ledger: &ledger,
        beside: true,
        writers: &Census::default(),
    };
    let removed = remove_at(&dir, guard, Path::new(target.file_name().unwrap()), still);
    ledger.settle(&dir, guard, now());
    removed
}

#[cfg(test)]
mod tests {
    use super::*;

    fn leftovers(dir: &Path) -> Vec<String> {
        std::fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".tmp"))
            .collect()
    }

    fn counted(run: impl FnOnce()) -> (u32, u32) {
        COUNTS.with(|counts| counts.set((0, 0)));
        run();
        COUNTS.with(std::cell::Cell::get)
    }

    fn land_ordered(dir: &Path, unflushed: &Unflushed, name: &str) {
        let dir = Directory::open(dir).unwrap();
        let ledger = Memory::default();
        land_ordered_at(
            &dir,
            Guard {
                aside: &dir,
                ledger: &ledger,
                beside: true,
                writers: &Census::default(),
            },
            unflushed,
            Path::new(name),
            |file, _| file.write_all(b"text"),
            |_| true,
        )
        .unwrap();
    }

    #[cfg(any(target_os = "macos", target_os = "ios"))]
    #[test]
    fn files_landed_in_order_are_followed_by_one_full_flush() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let handle = Directory::open(&root).unwrap();
        let unflushed = Unflushed::default();
        let (barriers, fulls) = counted(|| {
            for name in ["a.md", "b.md", "c.md"] {
                land_ordered(&root, &unflushed, name);
            }
        });
        assert_eq!(
            (barriers, fulls),
            (6, 0),
            "a barrier on each file and directory"
        );
        assert_eq!(counted(|| unflushed.flush(&handle).unwrap()), (0, 1));
        // Nothing is waiting now, so another run's end flushes nothing.
        assert_eq!(counted(|| unflushed.flush(&handle).unwrap()), (0, 0));
        assert_eq!(std::fs::read(root.join("b.md")).unwrap(), b"text");
    }

    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    #[test]
    fn without_a_cheaper_flush_a_landing_is_a_full_one_and_nothing_waits() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let handle = Directory::open(&root).unwrap();
        let unflushed = Unflushed::default();
        let (barriers, fulls) = counted(|| land_ordered(&root, &unflushed, "a.md"));
        assert_eq!((barriers, fulls), (0, 2));
        assert_eq!(counted(|| unflushed.flush(&handle).unwrap()), (0, 0));
    }

    #[cfg(any(target_os = "macos", target_os = "ios"))]
    #[test]
    fn one_folders_flush_leaves_the_files_another_folder_landed_waiting() {
        let (one, other) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let one_root = one.path().canonicalize().unwrap();
        let other_root = other.path().canonicalize().unwrap();
        let (mine, theirs) = (Unflushed::default(), Unflushed::default());
        land_ordered(&one_root, &mine, "a.md");
        land_ordered(&other_root, &theirs, "b.md");
        let (one_dir, other_dir) = (
            Directory::open(&one_root).unwrap(),
            Directory::open(&other_root).unwrap(),
        );
        // The first folder ends its run: its own file is flushed.
        assert_eq!(counted(|| mine.flush(&one_dir).unwrap()), (0, 1));
        // With one count for the process, that flush would have taken the
        // other folder's as well, and this one would flush nothing.
        assert_eq!(counted(|| theirs.flush(&other_dir).unwrap()), (0, 1));
    }

    #[cfg(any(target_os = "macos", target_os = "ios"))]
    #[test]
    fn a_file_system_without_the_ordering_flush_gets_the_full_one() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        FORCE_BARRIER_ERROR.with(|force| force.set(Some(libc::ENOTSUP)));
        let (barriers, fulls) = counted(|| land_ordered(&root, &Unflushed::default(), "a.md"));
        FORCE_BARRIER_ERROR.with(|force| force.set(None));
        assert_eq!((barriers, fulls), (0, 2));
        assert_eq!(std::fs::read(root.join("a.md")).unwrap(), b"text");
    }

    #[cfg(any(target_os = "macos", target_os = "ios"))]
    #[test]
    fn a_directory_whose_barrier_fails_is_synced_in_full() {
        let dir = tempfile::tempdir().unwrap();
        let handle = Directory::open(&dir.path().canonicalize().unwrap()).unwrap();
        // The witness: where the barrier works, no full sync is made.
        assert_eq!(counted(|| order_dir(&handle).unwrap()), (1, 0));
        FORCE_BARRIER_ERROR.with(|force| force.set(Some(libc::EIO)));
        let after_failure = counted(|| order_dir(&handle).unwrap());
        FORCE_BARRIER_ERROR.with(|force| force.set(None));
        assert_eq!(after_failure, (0, 1));
    }

    #[test]
    fn a_landing_that_fails_waits_for_no_flush() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let handle = Directory::open(&root).unwrap();
        let unflushed = Unflushed::default();
        let ledger = Memory::default();
        let failed = land_ordered_at(
            &handle,
            Guard {
                aside: &handle,
                ledger: &ledger,
                beside: true,
                writers: &Census::default(),
            },
            &unflushed,
            Path::new("a.md"),
            |_, _| Err(io::Error::other("the disk is full")),
            |_| true,
        );
        assert!(failed.is_err());
        assert_eq!(counted(|| unflushed.flush(&handle).unwrap()), (0, 0));
    }

    #[test]
    fn an_absent_target_cannot_be_replaced_after_its_last_check() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let target = root.join("note.md");
        let failed = write(&target, b"from the server", |found| {
            assert!(found.is_none());
            std::fs::write(&target, b"appeared meanwhile").unwrap();
            true
        });
        assert!(matches!(failed, Err(Unlanded::Changed)));
        assert_eq!(std::fs::read(&target).unwrap(), b"appeared meanwhile");
        assert!(leftovers(dir.path()).is_empty());
        std::fs::remove_file(&target).unwrap();
        write(&target, b"from the server", |found| found.is_none()).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"from the server");
    }

    #[cfg(unix)]
    #[test]
    fn a_move_refuses_existing_files_and_dangling_symlinks() {
        let dir = tempfile::tempdir().unwrap();
        let from = dir.path().join("source");
        let to = dir.path().join("destination");
        std::fs::write(&from, b"source").unwrap();
        std::fs::write(&to, b"destination").unwrap();
        assert_eq!(
            rename_new(&from, &to).unwrap_err().kind(),
            io::ErrorKind::AlreadyExists
        );
        assert_eq!(std::fs::read(&from).unwrap(), b"source");
        assert_eq!(std::fs::read(&to).unwrap(), b"destination");
        std::fs::remove_file(&to).unwrap();
        std::os::unix::fs::symlink("missing", &to).unwrap();
        assert_eq!(
            rename_new(&from, &to).unwrap_err().kind(),
            io::ErrorKind::AlreadyExists
        );
        assert_eq!(std::fs::read_link(&to).unwrap(), Path::new("missing"));
        assert_eq!(std::fs::read(&from).unwrap(), b"source");
        std::fs::remove_file(&to).unwrap();
        rename_new(&from, &to).unwrap();
        assert_eq!(std::fs::read(&to).unwrap(), b"source");
        assert!(!from.exists());
    }

    #[test]
    fn a_write_that_fails_part_way_leaves_the_old_file_whole() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let target = root.join("note.md");
        std::fs::write(&target, b"the person's whole text").unwrap();
        let failed = land(
            &target,
            |file, _| {
                file.write_all(b"half")?;
                Err(io::Error::other("the disk is full"))
            },
            |_| true,
        );
        assert!(matches!(failed, Err(Unlanded::Failed(_))));
        assert_eq!(
            std::fs::read(&target).unwrap(),
            b"the person's whole text",
            "a write that failed after it began left the file cut short, and the next scan sends what is left as an edit"
        );
        assert!(leftovers(dir.path()).is_empty());
        // The witness: the same write that does not fail lands.
        write(&target, b"new text", |_| true).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"new text");
        assert!(leftovers(dir.path()).is_empty());
    }

    #[test]
    fn a_target_changed_before_the_rename_is_left_as_it_is() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let target = root.join("note.md");
        std::fs::write(&target, b"as last written").unwrap();
        let changed = land(
            &target,
            |file, _| {
                // The person saves while the new file is written.
                std::fs::write(&target, b"the person's save")?;
                file.write_all(b"from the server")
            },
            |found| found == Some(b"as last written".as_slice()),
        );
        assert!(matches!(changed, Err(Unlanded::Changed)));
        assert_eq!(std::fs::read(&target).unwrap(), b"the person's save");
        assert!(leftovers(dir.path()).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn a_file_written_anew_keeps_its_permission_and_gets_a_new_inode() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let target = root.join("tool.sh");
        std::fs::write(&target, b"old").unwrap();
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o750)).unwrap();
        let before = std::fs::metadata(&target).unwrap().ino();
        write(&target, b"new", |_| true).unwrap();
        let after = std::fs::metadata(&target).unwrap();
        assert_ne!(after.ino(), before, "the file was written in place");
        assert_eq!(after.permissions().mode() & 0o777, 0o750);
    }

    #[test]
    fn a_file_left_by_a_process_no_longer_running_is_named_left_behind() {
        let dir = tempfile::tempdir().unwrap();
        let mut ended = std::process::Command::new("true").spawn().unwrap();
        let gone = ended.id();
        ended.wait().unwrap();
        let left = dir.path().join(format!(".marfa-{gone}-0.tmp"));
        assert!(left_behind(&left));
        // The witness: this process's own is not, nor a name it never writes.
        let own = dir
            .path()
            .join(format!(".marfa-{}-0.tmp", std::process::id()));
        assert!(!left_behind(&own));
        assert!(!left_behind(&dir.path().join(format!(".marfa-{gone}.tmp"))));
        assert!(!left_behind(&dir.path().join("notes.tmp")));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_file_written_anew_keeps_its_other_attributes() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let target = root.join("note.md");
        std::fs::write(&target, b"old").unwrap();
        xattr::set(&target, "com.example.kept", b"yes").unwrap();
        write(&target, b"new", |_| true).unwrap();
        assert_eq!(
            xattr::get(&target, "com.example.kept").unwrap().as_deref(),
            Some(b"yes".as_slice())
        );
    }

    #[test]
    fn removes_only_what_is_still_the_callers() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let target = root.join("note.md");
        std::fs::write(&target, b"edited since").unwrap();
        assert!(!remove(&target, |found| found == b"as written").unwrap());
        assert!(target.exists());
        assert!(remove(&target, |found| found == b"edited since").unwrap());
        assert!(!target.exists());
        assert!(!remove(&target, |_| true).unwrap());
    }
    /// A save as an editor makes it: a new file renamed over the old.
    fn save_atomically(target: &Path, bytes: &[u8]) {
        let staged = target.with_file_name("editor-save.swp");
        std::fs::write(&staged, bytes).unwrap();
        std::fs::rename(&staged, target).unwrap();
    }

    #[test]
    fn a_save_renamed_over_the_target_after_the_last_look_survives_a_write() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let target = root.join("note.md");
        std::fs::write(&target, b"as last written").unwrap();
        let landed = land(
            &target,
            |file, _| file.write_all(b"from the server"),
            |found| {
                let same = found == Some(b"as last written".as_slice());
                save_atomically(&target, b"the person's save");
                same
            },
        );
        assert!(matches!(landed, Err(Unlanded::Changed)), "{landed:?}");
        assert_eq!(std::fs::read(&target).unwrap(), b"the person's save");
        assert!(leftovers(&root).is_empty(), "{:?}", leftovers(&root));
        // The witness: with no save, the same write lands.
        std::fs::write(&target, b"as last written").unwrap();
        land(
            &target,
            |file, _| file.write_all(b"from the server"),
            |found| found == Some(b"as last written".as_slice()),
        )
        .unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"from the server");
        assert!(leftovers(&root).is_empty());
    }

    #[test]
    fn a_save_renamed_over_the_target_after_the_last_look_survives_a_removal() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let target = root.join("note.md");
        std::fs::write(&target, b"as last written").unwrap();
        let removed = remove(&target, |found| {
            let same = found == b"as last written";
            save_atomically(&target, b"the person's save");
            same
        })
        .unwrap();
        assert!(!removed);
        assert_eq!(std::fs::read(&target).unwrap(), b"the person's save");
        assert!(leftovers(&root).is_empty(), "{:?}", leftovers(&root));
        // The witness: with no save, the same removal removes it.
        std::fs::write(&target, b"as last written").unwrap();
        assert!(remove(&target, |found| found == b"as last written").unwrap());
        assert!(!target.exists());
        assert!(leftovers(&root).is_empty());
    }

    /// Names no sweep removes: a file under one was moved out of its path.
    fn reserved_left(dir: &Path) -> Vec<String> {
        std::fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| is_reserved(Path::new(name)))
            .collect()
    }

    /// The file as a save after the last look leaves it.
    #[cfg(debug_assertions)]
    const SAVED: &[u8] = b"as last writtensaved after the last look\n";

    struct Place {
        _temp: tempfile::TempDir,
        root: PathBuf,
        dir: Directory,
        ledger: Memory,
        census: Census,
    }

    impl Place {
        fn new(text: Option<&[u8]>) -> Place {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().canonicalize().unwrap();
            if let Some(text) = text {
                std::fs::write(root.join("note.md"), text).unwrap();
            }
            let dir = Directory::open(&root).unwrap();
            Place {
                _temp: temp,
                root,
                dir,
                ledger: Memory::default(),
                census: Census::default(),
            }
        }

        fn guard(&self) -> Guard<'_> {
            Guard {
                aside: &self.dir,
                ledger: &self.ledger,
                beside: true,
                writers: &self.census,
            }
        }

        fn write(&self, still: &[u8]) -> Result<Metadata, Unlanded> {
            land_at(
                &self.dir,
                self.guard(),
                Path::new("note.md"),
                |file, _| file.write_all(b"from the server"),
                |found| found == Some(still),
            )
        }

        fn remove(&self, still: &[u8]) -> io::Result<bool> {
            remove_at(&self.dir, self.guard(), Path::new("note.md"), |found| {
                found == still
            })
        }

        fn read(&self, name: &str) -> Vec<u8> {
            std::fs::read(self.root.join(name)).unwrap()
        }

        /// Settles what the ledger still holds, as the next pass does.
        #[cfg(debug_assertions)]
        fn settle(&self) {
            let rows = self.ledger.rows.borrow().clone();
            for row in rows {
                settle(&self.dir, self.guard(), &row).unwrap();
            }
            assert!(self.ledger.rows.borrow().is_empty());
            self.ledger.settle(&self.dir, self.guard(), now());
        }

        fn clean(&self) {
            // The next pass lets go of what no program holds open.
            self.ledger.settle(&self.dir, self.guard(), now());
            assert!(
                leftovers(&self.root).is_empty(),
                "{:?}",
                leftovers(&self.root)
            );
        }
    }

    #[cfg(debug_assertions)]
    #[test]
    fn a_second_save_as_the_first_goes_back_is_kept_beside_it() {
        let place = Place::new(Some(b"as last written"));
        let _first = crate::fault::fail_on_this_thread("save-after-last-look");
        let _second = crate::fault::fail_on_this_thread("save-during-put-back");
        let landed = place.write(b"as last written");
        assert!(matches!(landed, Err(Unlanded::Changed)), "{landed:?}");
        assert_eq!(place.read("note.md"), SAVED);
        assert_eq!(place.read("note (2).md"), b"from the serversaved again\n");
        let kept = place.ledger.kept.borrow();
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].0, Path::new("note (2).md"));
        assert!(place.ledger.rows.borrow().is_empty());
        place.clean();
    }

    #[cfg(debug_assertions)]
    #[test]
    fn a_write_stopped_after_the_exchange_is_settled_by_the_next_pass() {
        for saved in [false, true] {
            let place = Place::new(Some(b"as last written"));
            let stopped = {
                let _stop = crate::fault::fail_on_this_thread("crash-after-exchange");
                let _save =
                    saved.then(|| crate::fault::fail_on_this_thread("save-after-last-look"));
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    place.write(b"as last written")
                }))
            };
            assert!(stopped.is_err());
            assert_eq!(place.ledger.rows.borrow().len(), 1);
            assert_eq!(reserved_left(&place.root).len(), 1);
            place.settle();
            assert_eq!(
                place.read("note.md"),
                if saved {
                    SAVED
                } else {
                    b"from the server".as_slice()
                }
            );
            assert!(place.ledger.kept.borrow().is_empty());
            place.clean();
        }
    }

    #[cfg(debug_assertions)]
    #[test]
    fn a_removal_stopped_after_the_withdraw_is_settled_by_the_next_pass() {
        for saved in [false, true] {
            let place = Place::new(Some(b"as last written"));
            let stopped = {
                let _stop = crate::fault::fail_on_this_thread("crash-after-withdraw");
                let _save =
                    saved.then(|| crate::fault::fail_on_this_thread("save-after-last-look"));
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    place.remove(b"as last written")
                }))
            };
            assert!(stopped.is_err());
            assert!(!place.root.join("note.md").exists());
            assert_eq!(reserved_left(&place.root).len(), 1);
            place.settle();
            if saved {
                assert_eq!(place.read("note.md"), SAVED);
            } else {
                assert!(!place.root.join("note.md").exists());
            }
            place.clean();
        }
    }

    #[cfg(debug_assertions)]
    #[test]
    fn without_an_exchange_a_write_moves_the_file_aside_first() {
        let place = Place::new(Some(b"as last written"));
        let _unsupported = crate::fault::fail_on_this_thread("rename-exchange-unsupported");
        place.write(b"as last written").unwrap();
        assert_eq!(place.read("note.md"), b"from the server");
        place.clean();

        // A save after the last look goes back, and the new file does not land.
        std::fs::write(place.root.join("note.md"), b"as last written").unwrap();
        {
            let _save = crate::fault::fail_on_this_thread("save-after-last-look");
            let landed = place.write(b"as last written");
            assert!(matches!(landed, Err(Unlanded::Changed)), "{landed:?}");
        }
        assert_eq!(place.read("note.md"), SAVED);
        place.clean();

        // A file made at the path while it is empty stays there.
        std::fs::write(place.root.join("note.md"), b"as last written").unwrap();
        {
            let _gap = crate::fault::fail_on_this_thread("create-in-the-gap");
            let landed = place.write(b"as last written");
            assert!(matches!(landed, Err(Unlanded::Changed)), "{landed:?}");
        }
        assert_eq!(place.read("note.md"), b"appeared meanwhile\n");
        assert!(place.ledger.rows.borrow().is_empty());
        place.clean();
    }

    #[cfg(debug_assertions)]
    #[test]
    fn without_an_exchange_a_write_stopped_in_the_gap_puts_the_file_back() {
        let place = Place::new(Some(b"as last written"));
        let stopped = {
            let _unsupported = crate::fault::fail_on_this_thread("rename-exchange-unsupported");
            let _stop = crate::fault::fail_on_this_thread("crash-after-withdraw");
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                place.write(b"as last written")
            }))
        };
        assert!(stopped.is_err());
        assert!(!place.root.join("note.md").exists());
        assert_eq!(reserved_left(&place.root).len(), 2);
        place.settle();
        assert_eq!(place.read("note.md"), b"as last written");
        place.clean();
    }

    #[cfg(debug_assertions)]
    #[test]
    fn with_neither_an_exchange_nor_a_rename_that_replaces_nothing_the_file_stays() {
        let place = Place::new(Some(b"as last written"));
        {
            let _exchange = crate::fault::fail_on_this_thread("rename-exchange-unsupported");
            let _new = crate::fault::fail_on_this_thread("rename-new-unsupported");
            let landed = place.write(b"as last written");
            assert!(
                matches!(&landed, Err(Unlanded::Failed(error)) if error.kind() == io::ErrorKind::Unsupported),
                "{landed:?}"
            );
        }
        assert_eq!(place.read("note.md"), b"as last written");
        assert!(place.ledger.rows.borrow().is_empty());
        place.clean();
        // The witness: with either one, the write lands.
        {
            let _exchange = crate::fault::fail_on_this_thread("rename-exchange-unsupported");
            place.write(b"as last written").unwrap();
        }
        assert_eq!(place.read("note.md"), b"from the server");
        place.clean();
    }

    #[cfg(debug_assertions)]
    #[test]
    fn without_a_rename_that_replaces_nothing_a_removal_leaves_the_file() {
        let place = Place::new(Some(b"as last written"));
        {
            let _new = crate::fault::fail_on_this_thread("rename-new-unsupported");
            let removed = place.remove(b"as last written");
            assert!(
                matches!(&removed, Err(error) if error.kind() == io::ErrorKind::Unsupported),
                "{removed:?}"
            );
        }
        assert_eq!(place.read("note.md"), b"as last written");
        assert!(reserved_left(&place.root).is_empty());
        assert!(place.ledger.rows.borrow().is_empty());
        place.clean();
        // The witness: where the volume can, the same removal removes it.
        assert!(place.remove(b"as last written").unwrap());
        assert!(!place.root.join("note.md").exists());
        place.clean();
    }

    #[cfg(debug_assertions)]
    #[test]
    fn a_file_deleted_after_a_stopped_exchange_is_not_brought_back() {
        let place = Place::new(Some(b"as last written"));
        let stopped = {
            let _stop = crate::fault::fail_on_this_thread("crash-after-exchange");
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                place.write(b"as last written")
            }))
        };
        assert!(stopped.is_err());
        assert_eq!(place.read("note.md"), b"from the server");
        // The person deletes the file the write left at the path.
        std::fs::remove_file(place.root.join("note.md")).unwrap();
        place.settle();
        assert!(
            !place.root.join("note.md").exists(),
            "the person's delete was undone"
        );
        let left = reserved_left(&place.root);
        assert_eq!(left.len(), 1);
        assert_eq!(place.read(&left[0]), b"as last written");
        assert_eq!(place.ledger.kept.borrow()[0].0, Path::new(&left[0]));
    }

    /// A reader that notes the largest buffer it is asked to fill.
    struct Widest<'a> {
        bytes: &'a [u8],
        widest: usize,
    }

    impl Read for Widest<'_> {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            self.widest = self.widest.max(buffer.len());
            let read = self.bytes.read(buffer)?;
            Ok(read)
        }
    }

    #[test]
    fn a_large_file_is_compared_a_chunk_at_a_time() {
        let bytes = vec![7u8; 4 << 20];
        let mut reader = Widest {
            bytes: &bytes,
            widest: 0,
        };
        assert!(same_bytes(&mut reader, &bytes).unwrap());
        assert!(
            reader.widest <= 1 << 16,
            "read {} bytes at once",
            reader.widest
        );
        let mut longer = bytes.clone();
        longer.push(1);
        for (on_disk, read) in [(&longer[..], &bytes[..]), (&bytes[..], &longer[..])] {
            let mut reader = Widest {
                bytes: on_disk,
                widest: 0,
            };
            assert!(!same_bytes(&mut reader, read).unwrap());
        }
        let mut changed = bytes.clone();
        changed[3 << 20] = 8;
        assert!(!same_bytes(changed.as_slice(), &bytes).unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn a_link_made_at_the_path_after_the_last_look_stays() {
        let place = Place::new(Some(b"as last written"));
        let target = place.root.join("note.md");
        let link = || {
            std::fs::remove_file(&target).unwrap();
            std::os::unix::fs::symlink("elsewhere.md", &target).unwrap();
        };
        let landed = land_at(
            &place.dir,
            place.guard(),
            Path::new("note.md"),
            |file, _| file.write_all(b"from the server"),
            |found| {
                link();
                found == Some(b"as last written".as_slice())
            },
        );
        assert!(matches!(landed, Err(Unlanded::Changed)), "{landed:?}");
        assert_eq!(
            std::fs::read_link(&target).unwrap(),
            Path::new("elsewhere.md")
        );
        place.clean();

        std::fs::remove_file(&target).unwrap();
        std::fs::write(&target, b"as last written").unwrap();
        let removed = remove_at(&place.dir, place.guard(), Path::new("note.md"), |found| {
            link();
            found == b"as last written"
        })
        .unwrap();
        assert!(!removed);
        assert_eq!(
            std::fs::read_link(&target).unwrap(),
            Path::new("elsewhere.md")
        );
        assert!(place.ledger.rows.borrow().is_empty());
        place.clean();
    }

    #[cfg(unix)]
    #[test]
    fn a_read_only_file_or_folder_is_left_as_it_is() {
        use std::os::unix::fs::PermissionsExt;
        let place = Place::new(Some(b"as last written"));
        let target = place.root.join("note.md");
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o444)).unwrap();
        let landed = place.write(b"as last written");
        assert!(matches!(landed, Err(Unlanded::Failed(_))), "{landed:?}");
        assert_eq!(place.read("note.md"), b"as last written");
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o644)).unwrap();
        {
            let _locked = crate::test_folders::locked(&place.root, 0o555);
            assert!(place.write(b"as last written").is_err());
            assert!(place.remove(b"as last written").is_err());
            assert_eq!(place.read("note.md"), b"as last written");
        }
        assert!(place.ledger.rows.borrow().is_empty());
        place.clean();
        // The witness: unlocked, both land.
        place.write(b"as last written").unwrap();
        assert!(place.remove(b"from the server").unwrap());
        place.clean();
    }

    #[test]
    fn a_displacement_that_cannot_be_recorded_on_a_full_disk_moves_nothing() {
        let place = Place::new(Some(b"as last written"));
        place.ledger.full.set(true);
        let landed = place.write(b"as last written");
        assert!(matches!(landed, Err(Unlanded::Failed(_))), "{landed:?}");
        assert!(place.remove(b"as last written").is_err());
        assert_eq!(place.read("note.md"), b"as last written");
        assert!(place.ledger.rows.borrow().is_empty());
        place.clean();
        // The witness: with room for the record, both land.
        place.ledger.full.set(false);
        place.write(b"as last written").unwrap();
        assert!(place.remove(b"from the server").unwrap());
        place.clean();
    }

    #[test]
    fn a_name_in_another_case_on_a_volume_that_ignores_case_is_the_same_file() {
        let place = Place::new(Some(b"as last written"));
        if !place.root.join("NOTE.MD").exists() {
            return;
        }
        let landed = land_at(
            &place.dir,
            place.guard(),
            Path::new("NOTE.md"),
            |file, _| file.write_all(b"from the server"),
            |found| found == Some(b"as last written".as_slice()),
        );
        assert!(landed.is_ok(), "{landed:?}");
        assert_eq!(place.read("note.md"), b"from the server");
        place.clean();
        let names: Vec<_> = std::fs::read_dir(&place.root)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(names.len(), 1, "{names:?}");
    }

    #[test]
    fn publication_and_failed_temp_cleanup_follow_the_retained_parent() {
        for fail in [false, true] {
            let temp = tempfile::tempdir().unwrap();
            let base = temp.path().canonicalize().unwrap();
            let path = base.join("child");
            std::fs::create_dir(&path).unwrap();
            std::fs::write(path.join("note.md"), b"owned").unwrap();
            let directory = Directory::open(&path).unwrap();
            let ledger = Memory::default();
            let census = Census::default();
            let guard = Guard {
                aside: &directory,
                ledger: &ledger,
                beside: true,
                writers: &census,
            };
            let result = land_at(
                &directory,
                guard,
                Path::new("note.md"),
                |file, temporary| {
                    std::fs::rename(&path, base.join("original"))?;
                    std::fs::create_dir(&path)?;
                    std::fs::write(path.join("note.md"), b"replacement")?;
                    std::fs::write(path.join(temporary), b"replacement temporary")?;
                    file.write_all(b"published")?;
                    if fail {
                        return Err(io::Error::other("fixture stopped before publication"));
                    }
                    Ok(())
                },
                |found| found == Some(b"owned".as_slice()),
            );
            assert_eq!(result.is_err(), fail);
            assert!(ledger.rows.borrow().is_empty());
            ledger.settle(&directory, guard, now());
            assert!(reserved_left(&path).is_empty());
            assert!(reserved_left(&base.join("original")).is_empty());
            assert_eq!(std::fs::read(path.join("note.md")).unwrap(), b"replacement");
            let names = leftovers(&path);
            assert_eq!(names.len(), 1);
            assert_eq!(
                std::fs::read(path.join(&names[0])).unwrap(),
                b"replacement temporary"
            );
            assert!(leftovers(&base.join("original")).is_empty());
            assert_eq!(
                std::fs::read(base.join("original/note.md")).unwrap(),
                if fail {
                    b"owned".as_slice()
                } else {
                    b"published".as_slice()
                }
            );
        }
    }

    fn appending(path: &Path) -> File {
        std::fs::OpenOptions::new().append(true).open(path).unwrap()
    }

    #[cfg(unix)]
    #[test]
    fn a_descriptor_held_open_for_writing_keeps_its_file_through_a_write() {
        use std::os::unix::fs::MetadataExt;
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().canonicalize().unwrap().join("note.md");
        std::fs::write(&target, b"first half\n").unwrap();
        let mut writer = appending(&target);
        let _ = write(&target, b"from the server", |_| true);
        writer.write_all(b"second half\n").unwrap();
        assert_eq!(
            writer.metadata().unwrap().nlink(),
            1,
            "the file was unlinked"
        );
        assert_eq!(
            std::fs::read(&target).unwrap(),
            b"first half\nsecond half\n"
        );
        drop(writer);
        // Witness: once the program closes it, the write lands.
        write(&target, b"from the server", |_| true).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"from the server");
        assert!(leftovers(dir.path()).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn a_file_a_program_holds_open_for_writing_is_not_removed() {
        let place = Place::new(Some(b"as last written"));
        let writer = appending(&place.root.join("note.md"));
        let removed = place.remove(b"as last written");
        assert!(removed.as_ref().is_err_and(is_busy), "{removed:?}");
        assert_eq!(place.read("note.md"), b"as last written");
        drop(writer);
        place.census.fresh();
        assert!(place.remove(b"as last written").unwrap());
        assert!(!place.root.join("note.md").exists());
        place.clean();
    }

    #[cfg(debug_assertions)]
    #[test]
    fn a_file_written_through_a_descriptor_after_it_was_set_aside_goes_back_to_its_path() {
        let place = Place::new(Some(b"first half\n"));
        let mut writer = appending(&place.root.join("note.md"));
        {
            let _unknown = crate::fault::fail_on_this_thread("writers-unknown");
            place.write(b"first half\n").unwrap();
        }
        assert_eq!(place.read("note.md"), b"from the server");
        writer.write_all(b"second half\n").unwrap();
        drop(writer);
        let settled = place.ledger.settle(&place.dir, place.guard(), now());
        assert!(
            matches!(settled.as_slice(), [Settled::PutBack { .. }]),
            "{settled:?}"
        );
        assert_eq!(place.read("note.md"), b"first half\nsecond half\n");
        assert!(place.ledger.retained.borrow().is_empty());
        place.clean();
    }

    #[cfg(debug_assertions)]
    #[test]
    fn a_file_set_aside_unchanged_goes_once_no_program_holds_it_open() {
        let place = Place::new(Some(b"as last written"));
        let writer = appending(&place.root.join("note.md"));
        {
            let _unknown = crate::fault::fail_on_this_thread("writers-unknown");
            place.write(b"as last written").unwrap();
        }
        let settled = place.ledger.settle(&place.dir, place.guard(), now());
        assert!(
            matches!(
                settled.as_slice(),
                [Settled::Kept(Retained {
                    writers: Some(Writers::Open),
                    ..
                })]
            ),
            "{settled:?}"
        );
        assert_eq!(reserved_left(&place.root).len(), 1);
        drop(writer);
        let settled = place.ledger.settle(&place.dir, place.guard(), now());
        assert!(
            matches!(settled.as_slice(), [Settled::Discarded]),
            "{settled:?}"
        );
        assert_eq!(place.read("note.md"), b"from the server");
        place.clean();
    }

    #[cfg(debug_assertions)]
    #[test]
    fn a_file_set_aside_where_writers_are_unknown_goes_after_a_week_unchanged() {
        let place = Place::new(Some(b"as last written"));
        let _unknown = crate::fault::fail_on_this_thread("writers-unknown");
        place.write(b"as last written").unwrap();
        let at = now();
        for when in [at, at + RETAINED_FOR - 60] {
            let settled = place.ledger.settle(&place.dir, place.guard(), when);
            assert!(
                matches!(
                    settled.as_slice(),
                    [Settled::Kept(Retained {
                        writers: Some(Writers::Unknown),
                        ..
                    })]
                ),
                "{settled:?}"
            );
            assert_eq!(reserved_left(&place.root).len(), 1);
        }
        let settled = place
            .ledger
            .settle(&place.dir, place.guard(), at + RETAINED_FOR + 60);
        assert!(
            matches!(settled.as_slice(), [Settled::Discarded]),
            "{settled:?}"
        );
        assert!(reserved_left(&place.root).is_empty());
        place.clean();
    }

    #[cfg(debug_assertions)]
    #[test]
    fn a_file_set_aside_that_changed_after_a_newer_save_is_kept_beside_it() {
        let place = Place::new(Some(b"first half\n"));
        let mut writer = appending(&place.root.join("note.md"));
        let _unknown = crate::fault::fail_on_this_thread("writers-unknown");
        place.write(b"first half\n").unwrap();
        writer.write_all(b"second half\n").unwrap();
        std::fs::write(place.root.join("note.md"), b"saved by the person").unwrap();
        let settled = place.ledger.settle(&place.dir, place.guard(), now());
        assert!(
            matches!(settled.as_slice(), [Settled::Beside(_)]),
            "{settled:?}"
        );
        let beside = place.ledger.kept.borrow()[0].0.clone();
        assert!(!is_reserved(&beside), "{beside:?}");
        assert_eq!(
            place.read(&beside.to_string_lossy()),
            b"first half\nsecond half\n"
        );
        assert_eq!(place.read("note.md"), b"saved by the person");
        assert_eq!(place.ledger.kept.borrow().len(), 1);
        place.clean();
    }

    #[cfg(debug_assertions)]
    #[test]
    fn a_removed_file_written_after_it_was_set_aside_goes_back_to_its_path() {
        let place = Place::new(Some(b"first half\n"));
        let mut writer = appending(&place.root.join("note.md"));
        {
            let _unknown = crate::fault::fail_on_this_thread("writers-unknown");
            assert!(place.remove(b"first half\n").unwrap());
        }
        assert!(!place.root.join("note.md").exists());
        writer.write_all(b"second half\n").unwrap();
        let settled = place.ledger.settle(&place.dir, place.guard(), now());
        assert!(
            matches!(settled.as_slice(), [Settled::Restored]),
            "{settled:?}"
        );
        assert_eq!(place.read("note.md"), b"first half\nsecond half\n");
        drop(writer);
        place.clean();
    }
}
