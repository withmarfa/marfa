//! The disk store: one file per blob under `<folder>/<hex 0..4>/<hex>`, and a `tmp`
//! folder that holds bytes until they are whole. Every write and removal goes through the
//! folder's descriptor, which the store locked before it made or changed anything in it.

use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::os::fd::AsFd;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use rustix::fs::{AtFlags, Mode, OFlags};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::hash::Hash;
use crate::failure::Failure;
use crate::folder_lock::{self, DirLocked, Held, Standing};
use crate::server_lock::Untaken;

pub const MARKER: &str = ".marfa-store";
/// A store an adopt claimed the folder for, which becomes the marker once the record names it.
pub const PENDING: &str = ".marfa-store.pending";
const TMP: &str = "tmp";

#[derive(Debug)]
pub struct Disk {
    id: String,
    root: PathBuf,
    place: Place,
    /// The folder as the store locked it; `None` until a folder the start did not find is
    /// taken back, and once the store lets it go.
    held: Mutex<Option<Arc<Area>>>,
    returning: Returning,
}

/// A folder the store took, with what it opened inside it.
#[derive(Debug)]
pub struct Area {
    folder: Held,
    tmp: Mutex<Option<Arc<File>>>,
    /// Why a returned blob folder takes no write yet, while it could not be made private.
    unfit: Mutex<Option<String>>,
}

impl Area {
    fn new(folder: Held, private: bool) -> Area {
        Area {
            folder,
            tmp: Mutex::new(None),
            unfit: Mutex::new((!private).then(String::new)),
        }
    }

    fn dir(&self) -> &File {
        self.folder.dir()
    }

    /// `tmp`, made where a disk that came back, or a tool that copied it, left it out.
    fn tmp(&self) -> io::Result<Arc<File>> {
        let mut cached = self.tmp.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(tmp) = cached.as_ref()
            && let (Ok(open), Ok(named)) = (
                rustix::fs::fstat(&**tmp),
                rustix::fs::statat(self.dir(), TMP, AtFlags::SYMLINK_NOFOLLOW),
            )
            && (open.st_dev, open.st_ino) == (named.st_dev, named.st_ino)
        {
            return Ok(tmp.clone());
        }
        let (tmp, made) = open_or_make(self.dir(), TMP)?;
        if made {
            self.dir().sync_all()?;
        }
        let tmp = Arc::new(tmp);
        *cached = Some(tmp.clone());
        Ok(tmp)
    }

    /// Makes a returned blob folder private through the descriptor it was locked by. Until
    /// that succeeds, the folder takes no write.
    fn fit(&self, root: &Path) -> io::Result<()> {
        let mut unfit = self.unfit.lock().unwrap_or_else(PoisonError::into_inner);
        if unfit.is_none() {
            return Ok(());
        }
        #[cfg(test)]
        BETWEEN_LOCK_AND_MODE.with_borrow_mut(|between| between.take().map(|run| run()));
        match crate::private_files::secure_returned_blob_folder(self.dir(), root) {
            Ok(()) => {
                *unfit = None;
                Ok(())
            }
            Err(failure) => {
                if unfit.as_deref() != Some(failure.message.as_str()) {
                    tracing::warn!(reason = %failure.message, "A returned blob folder could not be made private");
                    *unfit = Some(failure.message.clone());
                }
                Err(io::Error::other(format!(
                    "the blob folder could not be made private, so no file can be stored: {}",
                    failure.message
                )))
            }
        }
    }
}

#[cfg(test)]
thread_local! {
    static BETWEEN_LOCK_AND_MODE: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
}

/// Runs `run` once, on this thread, after a returned blob folder is locked and before it is made
/// private.
#[cfg(test)]
fn between_lock_and_mode(run: impl FnOnce() + 'static) {
    BETWEEN_LOCK_AND_MODE.set(Some(Box::new(run)));
}

/// A folder the start did not find, taken once it is back, before the first write to it.
#[derive(Debug, Default)]
struct Returning {
    awaited: AtomicBool,
    refused: AtomicBool,
    let_go: AtomicBool,
    /// Kept apart from `Disk::held`, which the runtime waits on, since taking a lock does I/O.
    taking: Mutex<()>,
}

/// Which folder a disk store is, for what the server says of it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Place {
    Blobs,
    BackupFiles,
}

impl Place {
    fn named(self, root: &Path) -> String {
        match self {
            Place::Blobs => format!("The blob folder {}", root.display()),
            Place::BackupFiles => {
                format!("The backup folder's files area {}", root.display())
            }
        }
    }
}

fn refused(place: Place, root: &Path, what: &str, error: io::Error) -> Failure {
    Failure::start(format!("{} {what}: {error}", place.named(root)))
}

/// Why a folder could not be locked, in the server's words.
fn untaken(place: Place, root: &Path, untaken: Untaken) -> Failure {
    let named = place.named(root);
    Failure::start(match untaken {
        Untaken::Held => match place {
            Place::Blobs => format!(
                "{named} is open in another Marfa server. Stop that server, or give this one a \
                 blob folder of its own."
            ),
            Place::BackupFiles => format!(
                "{named} is open in another Marfa server, which runs a copy of this instance. \
                 Stop that server, or give this one a backup folder of its own."
            ),
        },
        Untaken::Unsupported(error) => {
            format!("{named} could not be locked: its file system takes no locks ({error})")
        }
        // The lock file of a server running as another account is refused here too.
        Untaken::Refused(why) => format!("{named} could not be locked: {why}"),
    })
}

/// What the start took of the blob folder before it opened the database.
#[derive(Debug)]
pub enum Taken {
    /// The folder, locked; it has no marker yet, so it has no lock file either.
    Dir(DirLocked),
    /// The marked folder with its lock file.
    Whole(Held),
}

/// Locks the blob folder `dir` the start opened, and its lock file where it is `marked`.
pub fn take_blob_folder(dir: File, root: &Path) -> Result<Taken, Failure> {
    let locked =
        folder_lock::lock_dir(dir).map_err(|(why, _)| untaken(Place::Blobs, root, why))?;
    let marked = matches!(marker_in(locked.dir(), root, Place::Blobs), Ok(Some(_)));
    if !marked {
        return Ok(Taken::Dir(locked));
    }
    locked
        .with_file()
        .map(Taken::Whole)
        .map_err(|why| untaken(Place::Blobs, root, why))
}

/// Takes the blob folder's locks, which the server does not start without.
pub fn lock_blobs(root: &Path) -> Result<Held, Failure> {
    let dir = folder_lock::open_dir(root)
        .map_err(|error| refused(Place::Blobs, root, "could not be opened", error))?;
    folder_lock::lock_dir(dir)
        .map_err(|(why, _)| why)
        .and_then(DirLocked::with_file)
        .map_err(|why| untaken(Place::Blobs, root, why))
}

/// Locks the folder at `root`; only the backup folder, which the server can start without, is
/// left unlocked where its file system takes no locks.
fn take(root: &Path, place: Place) -> Result<Held, Failure> {
    let dir = folder_lock::open_dir(root)
        .map_err(|error| refused(place, root, "could not be opened", error))?;
    match (folder_lock::lock_dir(dir), place) {
        (Ok(locked), _) => locked.with_file().map_err(|why| untaken(place, root, why)),
        (Err((Untaken::Unsupported(error), dir)), Place::BackupFiles) => {
            let why = format!("its file system takes no locks ({error})");
            tracing::warn!(
                folder = %root.display(),
                reason = %why,
                "The backup folder's files area is not locked, so another server could use it too"
            );
            Ok(Held::unlocked(dir, why))
        }
        (Err((why, _)), _) => Err(untaken(place, root, why)),
    }
}

/// What a folder holds before the server takes it as its disk store.
#[derive(Debug, PartialEq, Eq)]
pub enum Found {
    Marked,
    Unmarked,
    Missing,
}

/// A claim an adopt made on a files area: locked, with `tmp` made and the new store's id
/// waiting beside the marker it becomes.
#[derive(Debug)]
pub struct Claim {
    area: Arc<Area>,
    id: String,
    root: PathBuf,
}

impl Claim {
    pub fn id(&self) -> &str {
        &self.id
    }

    /// Removes the pending marker; one already gone is undone. It blocks.
    pub fn undo(self) -> io::Result<()> {
        match rustix::fs::unlinkat(self.area.dir(), PENDING, AtFlags::empty()) {
            Ok(()) | Err(rustix::io::Errno::NOENT) => {}
            Err(error) => return Err(error.into()),
        }
        self.area.dir().sync_all()
    }

    /// Makes the pending marker the folder's marker, and answers the store it now holds. It
    /// blocks.
    pub fn promote(self) -> io::Result<Disk> {
        let dir = self.area.dir();
        match read_in(dir, PENDING)? {
            Some(found) if found.trim() == self.id => {}
            _ => {
                return Err(io::Error::other(
                    "its pending marker changed or went away before it was made the marker",
                ));
            }
        }
        rustix::fs::renameat(dir, PENDING, dir, MARKER)?;
        dir.sync_all()?;
        Ok(Disk {
            id: self.id,
            root: self.root,
            place: Place::BackupFiles,
            held: Mutex::new(Some(self.area)),
            returning: Returning::default(),
        })
    }
}

impl Disk {
    /// Looks at the folder without changing it.
    pub fn probe(root: &Path, place: Place) -> Result<Found, Failure> {
        if !root.is_dir() {
            return Ok(Found::Missing);
        }
        match read_marker(root, place)? {
            Some(_) => Ok(Found::Marked),
            None => Ok(Found::Unmarked),
        }
    }

    /// Reads the store's id from its marker, writing one for a folder that has none, and
    /// empties `tmp`, holding the folder's locks first unless `taken` holds them. A folder
    /// that takes no locks keeps its `tmp`, which another server may be writing. It blocks, so
    /// it runs before the server takes requests.
    pub fn open(root: &Path, place: Place, taken: Option<Taken>) -> Result<Disk, Failure> {
        let folder = match taken {
            Some(Taken::Whole(held)) => held,
            Some(Taken::Dir(locked)) => locked
                .with_file()
                .map_err(|why| untaken(place, root, why))?,
            None => {
                // The one thing made before the lock: a folder that is not there has no
                // server in it.
                if fs::symlink_metadata(root).is_err() {
                    fs::create_dir_all(root)
                        .map_err(|error| refused(place, root, "could not be made", error))?;
                }
                take(root, place)?
            }
        };
        let dir = folder.dir();
        let id = match marker_in(dir, root, place)? {
            Some(id) => id,
            None => {
                let id = Uuid::now_v7().to_string();
                write_in(dir, MARKER, &id)
                    .map_err(|error| refused(place, root, "got no marker", error))?;
                id
            }
        };
        let locked = folder.unlocked_why().is_none();
        if locked {
            empty_tmp(dir).map_err(|error| {
                refused(place, root, "has a tmp folder that did not empty", error)
            })?;
        }
        let area = Area::new(folder, true);
        area.tmp()
            .map_err(|error| refused(place, root, "has no tmp folder", error))?;
        Ok(Disk {
            id,
            root: root.to_path_buf(),
            place,
            held: Mutex::new(Some(Arc::new(area))),
            returning: Returning::default(),
        })
    }

    /// A store the server recorded at `root` whose folder is not there now; nothing is touched
    /// until a folder holding its marker is back, which the first write then locks.
    pub fn unmounted(id: String, root: PathBuf, place: Place) -> Disk {
        let disk = Disk {
            id,
            root,
            place,
            held: Mutex::default(),
            returning: Returning::default(),
        };
        disk.returning.awaited.store(true, Ordering::Release);
        disk
    }

    /// The id the marker in the backup folder's files area `root` holds, where it holds one. It
    /// blocks.
    pub fn marked(root: &Path) -> Result<Option<String>, Failure> {
        read_marker(root, Place::BackupFiles)
    }

    fn area(&self) -> Option<Arc<Area>> {
        self.held
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// The folder at `root` as this store holds it, or newly locked. It blocks.
    fn hold_at(&self, root: &Path) -> io::Result<Arc<Area>> {
        let dir = folder_lock::open_dir(root)?;
        if let Some(area) = self.area()
            && area.folder.is(&dir)
        {
            return Ok(area);
        }
        let folder = match folder_lock::lock_dir(dir) {
            Ok(locked) => locked.with_file(),
            Err((Untaken::Unsupported(error), dir)) => Ok(Held::unlocked(
                dir,
                format!("its file system takes no locks ({error})"),
            )),
            Err((why, _)) => Err(why),
        }
        .map_err(|why| io::Error::other(untaken(Place::BackupFiles, root, why).message))?;
        Ok(Arc::new(Area::new(folder, true)))
    }

    /// Claims the backup folder's files area `root`, which must exist and hold no other store's
    /// marker, for the store `id`, under its locks: this store's own where it holds the folder.
    /// The id waits as a pending marker until [`Claim::promote`]. It blocks.
    pub fn claim(&self, root: &Path, id: &str) -> io::Result<Claim> {
        let area = self.hold_at(root)?;
        match read_in(area.dir(), MARKER)? {
            Some(found) if !found.trim().is_empty() && found.trim() != id => {
                return Err(io::Error::new(
                    io::ErrorKind::AlreadyExists,
                    format!("it holds the marker of another store, {}", found.trim()),
                ));
            }
            _ => {}
        }
        area.tmp()?;
        if let Err(error) = write_in(area.dir(), PENDING, id) {
            // A full disk can leave the pending marker empty or half written.
            let _ = rustix::fs::unlinkat(area.dir(), PENDING, AtFlags::empty());
            return Err(error);
        }
        Ok(Claim {
            area,
            id: id.to_string(),
            root: root.to_path_buf(),
        })
    }

    /// The claim an adopt left pending in the files area `root`, where it holds no marker. It
    /// blocks.
    pub fn pending(&self, root: &Path) -> io::Result<Option<Claim>> {
        if !root.is_dir() {
            return Ok(None);
        }
        let area = self.hold_at(root)?;
        if read_in(area.dir(), MARKER)?.is_some_and(|found| !found.trim().is_empty()) {
            return Ok(None);
        }
        let Some(id) = read_in(area.dir(), PENDING)?.filter(|id| !id.trim().is_empty()) else {
            return Ok(None);
        };
        if Uuid::parse_str(id.trim()).is_err() {
            return Err(io::Error::other(format!(
                "its pending marker {} does not hold a store id",
                root.join(PENDING).display()
            )));
        }
        Ok(Some(Claim {
            area,
            id: id.trim().to_string(),
            root: root.to_path_buf(),
        }))
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    /// Lets another server open the folder; a write already under way finishes first.
    pub fn let_go(&self) {
        self.returning.let_go.store(true, Ordering::Release);
        self.returning.awaited.store(false, Ordering::Release);
        self.held
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Why the folder is not locked against another server, where it could not be.
    pub fn unlocked(&self) -> Option<String> {
        self.area()
            .and_then(|area| area.folder.unlocked_why().map(str::to_string))
    }

    /// Why the folder's locks may not keep out a server on another machine.
    pub fn shared(&self) -> Option<String> {
        self.area()
            .and_then(|area| area.folder.shared().map(str::to_string))
    }

    /// What the server mended in the folder's locking since it took it.
    pub fn lock_note(&self) -> Option<String> {
        self.area().and_then(|area| area.folder.note())
    }

    /// Runs `run` on the folder's descriptor, where the store holds it.
    pub fn with_dir<T>(&self, run: impl FnOnce(&File) -> T) -> Option<T> {
        self.area().map(|area| run(area.dir()))
    }

    fn path_of(&self, hash: &Hash) -> PathBuf {
        let hex = hash.hex();
        self.root.join(&hex[0..4]).join(hex)
    }

    /// The folder is there and still holds this store's marker. A folder that went away, a
    /// drive that did not mount and an empty mount point all fail this.
    pub fn reachable(&self) -> bool {
        fs::read_to_string(self.root.join(MARKER)).is_ok_and(|text| text.trim() == self.id)
    }

    fn unreachable() -> io::Error {
        io::Error::other("the disk store's folder or marker is missing")
    }

    /// What keeps the store from taking a write now, where something does. A folder that came
    /// back is taken by the look. It blocks.
    pub fn unwritable(&self) -> Option<String> {
        self.writable().err().map(|error| error.to_string())
    }

    /// The folder the store writes in: the one it locked, still at its path and holding this
    /// store's marker. A folder that returned after the start, or after the one held was
    /// removed or its disk went away, is taken back here. It blocks.
    fn writable(&self) -> io::Result<Arc<Area>> {
        if self.returning.let_go.load(Ordering::Acquire) {
            return Err(io::Error::other("the store has let its folder go"));
        }
        let mut retaken = false;
        let area = loop {
            let area = match self.area() {
                Some(area) => area,
                None => self.take_back()?,
            };
            if self.place == Place::Blobs {
                area.fit(&self.root)?;
            }
            // Checked after the folder is taken and made private, either of which a folder
            // put at the path meanwhile would otherwise pass.
            match area.folder.check(&self.root) {
                Standing::Kept => break area,
                Standing::Moved { gone: false } => {
                    return Err(self.refusing(format!(
                        "the folder at {} is not the one the server took, so nothing is \
                         written until that folder is back",
                        self.root.display()
                    )));
                }
                Standing::Lost(why) => {
                    return Err(self.refusing(format!(
                        "the server no longer has sole use of {}: {why}",
                        self.root.display()
                    )));
                }
                Standing::Moved { gone: true } => {
                    let mut held = self.held.lock().unwrap_or_else(PoisonError::into_inner);
                    if held.as_ref().is_some_and(|now| Arc::ptr_eq(now, &area)) {
                        held.take();
                        self.returning.awaited.store(true, Ordering::Release);
                    }
                    drop(held);
                    if retaken {
                        return Err(Disk::unreachable());
                    }
                    retaken = true;
                }
            }
        };
        if marker_in(area.dir(), &self.root, self.place)
            .ok()
            .flatten()
            .as_deref()
            != Some(self.id.as_str())
        {
            return Err(Disk::unreachable());
        }
        self.returning.refused.store(false, Ordering::Release);
        Ok(area)
    }

    fn refusing(&self, why: String) -> io::Error {
        if !self.returning.refused.swap(true, Ordering::AcqRel) {
            tracing::warn!(reason = %why, "A disk store refuses writes");
        }
        io::Error::other(why)
    }

    /// Takes a folder that came back holding this store's marker: locked, and for the blob
    /// folder made private, through one descriptor. Nothing is written in a folder without
    /// the marker. It blocks.
    fn take_back(&self) -> io::Result<Arc<Area>> {
        let returning = &self.returning;
        let _one_at_a_time = returning
            .taking
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if let Some(area) = self.area() {
            return Ok(area);
        }
        if !returning.awaited.load(Ordering::Acquire) {
            return Err(Disk::unreachable());
        }
        let dir = match self.place {
            Place::Blobs => crate::private_files::open_returned_blob_folder(&self.root)
                .map_err(|failure| io::Error::other(failure.message))?,
            Place::BackupFiles => folder_lock::open_dir(&self.root)?,
        };
        if marker_in(&dir, &self.root, self.place)
            .ok()
            .flatten()
            .as_deref()
            != Some(self.id.as_str())
        {
            return Err(Disk::unreachable());
        }
        let folder = match folder_lock::lock_dir(dir) {
            Ok(locked) => locked.with_file(),
            Err((Untaken::Unsupported(error), dir)) if self.place == Place::BackupFiles => Ok(
                Held::unlocked(dir, format!("its file system takes no locks ({error})")),
            ),
            Err((why, _)) => Err(why),
        };
        let folder = folder.map_err(|why| {
            let failure = untaken(self.place, &self.root, why);
            self.refusing(match self.place {
                Place::Blobs => format!(
                    "the blob folder could not be locked, so no file can be stored: {}",
                    failure.message
                ),
                Place::BackupFiles => failure.message,
            })
        })?;
        let area = Arc::new(Area::new(folder, self.place == Place::BackupFiles));
        let mut held = self.held.lock().unwrap_or_else(PoisonError::into_inner);
        // `let_go` may have run since the look above, and the folder then closes here.
        if !returning.awaited.swap(false, Ordering::AcqRel) {
            return Err(io::Error::other("the store has let its folder go"));
        }
        *held = Some(area.clone());
        Ok(area)
    }

    /// The folder to stage in, and its `tmp`.
    fn staging(&self) -> io::Result<(Arc<Area>, Arc<File>)> {
        let area = self.writable()?;
        let tmp = area.tmp()?;
        Ok((area, tmp))
    }

    /// A file of its own for an upload that is arriving.
    pub fn stage(&self) -> io::Result<Staged> {
        let (area, tmp) = self.staging()?;
        let name = Uuid::now_v7().to_string();
        let file = create_in(&tmp, &name, OFlags::WRONLY)?;
        Ok(Staged {
            area,
            tmp,
            name,
            file: Some(file),
            hasher: Sha256::new(),
            size: 0,
            published: false,
        })
    }

    /// A file of the server's own in `tmp`, which a start empties. It blocks.
    pub fn scratch(&self) -> io::Result<Scratch> {
        let (area, tmp) = self.staging()?;
        let name = Uuid::now_v7().to_string();
        let file = create_in(&tmp, &name, OFlags::RDWR)?;
        Ok(Scratch {
            _area: Some(area),
            tmp,
            name,
            file,
        })
    }

    /// Moves a sealed file into place over whatever stands there, which may be a damaged
    /// copy's bytes, and syncs every folder whose entries changed. Only a file staged in the
    /// folder the store writes in now is moved.
    pub fn publish(&self, staged: &mut Staged, hash: &Hash) -> io::Result<()> {
        let area = self.writable()?;
        if !Arc::ptr_eq(&area, &staged.area) {
            return Err(io::Error::other(
                "the file was staged in a folder the store no longer writes in",
            ));
        }
        let hex = hash.hex();
        let (shard, made) = open_or_make(area.dir(), &hex[0..4])?;
        rustix::fs::renameat(&*staged.tmp, staged.name.as_str(), &shard, hex)?;
        staged.published = true;
        shard.sync_all()?;
        if made {
            area.dir().sync_all()?;
        }
        Ok(())
    }

    pub fn open_blob(&self, hash: &Hash) -> io::Result<File> {
        if !self.reachable() {
            return Err(Disk::unreachable());
        }
        File::open(self.path_of(hash))
    }

    /// The size of the file a blob would be in, or `None` where there is none.
    pub fn size_of(&self, hash: &Hash) -> io::Result<Option<u64>> {
        if !self.reachable() {
            return Err(Disk::unreachable());
        }
        match fs::metadata(self.path_of(hash)) {
            Ok(meta) => Ok(Some(meta.len())),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error),
        }
    }

    /// Reads a blob's file through and answers its size and what it hashes to, with its first
    /// byte changed when `changed` says so.
    pub fn rehash(&self, hash: &Hash, changed: bool) -> io::Result<Option<(u64, Hash)>> {
        self.rehash_opened(hash, changed, |path| File::open(path))
    }

    fn rehash_opened(
        &self,
        hash: &Hash,
        changed: bool,
        open: impl FnOnce(&Path) -> io::Result<File>,
    ) -> io::Result<Option<(u64, Hash)>> {
        if !self.reachable() {
            return Err(Disk::unreachable());
        }
        let mut file = match open(&self.path_of(hash)) {
            Ok(file) => file,
            // A drive that went away after the first look shows every file as missing.
            Err(error) if error.kind() == io::ErrorKind::NotFound && !self.reachable() => {
                return Err(Disk::unreachable());
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        let (mut hasher, mut size, mut buffer) = (Sha256::new(), 0u64, vec![0; 256 * 1024]);
        loop {
            let count = file.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            if changed && size == 0 {
                buffer[0] ^= 0xff;
            }
            hasher.update(&buffer[..count]);
            size += count as u64;
        }
        Ok(Some((size, Hash::from_digest(&hasher.finalize()))))
    }

    /// Removes each file in `tmp` staged before `before`, which only a process that ended left.
    /// A folder that takes no locks keeps them: another server may be writing them. It blocks.
    pub fn clear_tmp_before(&self, before: std::time::SystemTime) -> io::Result<usize> {
        let area = self.writable()?;
        if area.folder.unlocked_why().is_some() {
            return Ok(0);
        }
        let tmp = match open_at(area.dir(), TMP, OFlags::DIRECTORY) {
            Ok(tmp) => tmp,
            Err(rustix::io::Errno::NOENT) => return Ok(0),
            Err(error) => return Err(error.into()),
        };
        let mut cleared = 0;
        for name in names_in(&tmp)? {
            let staged_at = Uuid::parse_str(&name)
                .ok()
                .and_then(|id| id.get_timestamp())
                .map(|stamp| {
                    let (seconds, nanos) = stamp.to_unix();
                    std::time::UNIX_EPOCH + std::time::Duration::new(seconds, nanos)
                });
            if staged_at.is_none_or(|at| at < before) {
                match rustix::fs::unlinkat(&tmp, name.as_str(), AtFlags::empty()) {
                    Ok(()) => cleared += 1,
                    Err(rustix::io::Errno::NOENT) => {}
                    Err(error) => return Err(error.into()),
                }
            }
        }
        if cleared > 0 {
            tmp.sync_all()?;
        }
        Ok(cleared)
    }

    /// The name and size of each file in `tmp`. It blocks.
    pub fn spool(&self) -> io::Result<Vec<(String, u64)>> {
        let entries = match fs::read_dir(self.root.join(TMP)) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error),
        };
        let mut files = Vec::new();
        for entry in entries {
            let entry = entry?;
            match entry.metadata() {
                Ok(meta) => {
                    files.push((entry.file_name().to_string_lossy().into_owned(), meta.len()))
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
        }
        files.sort();
        Ok(files)
    }

    /// Removes a blob's file. One that is not there is already gone.
    pub fn delete(&self, hash: &Hash) -> io::Result<()> {
        let area = self.writable()?;
        let hex = hash.hex();
        let shard = match open_at(area.dir(), &hex[0..4], OFlags::DIRECTORY) {
            Ok(shard) => shard,
            Err(rustix::io::Errno::NOENT) => return Ok(()),
            Err(error) => return Err(error.into()),
        };
        match rustix::fs::unlinkat(&shard, hex, AtFlags::empty()) {
            Ok(()) => shard.sync_all(),
            Err(rustix::io::Errno::NOENT) => Ok(()),
            Err(error) => Err(error.into()),
        }
    }
}

fn open_at(dir: impl AsFd, name: &str, flags: OFlags) -> rustix::io::Result<File> {
    rustix::fs::openat(
        dir,
        name,
        flags | OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map(File::from)
}

/// The folder `name` inside `dir`, made where it is not there, and whether it was made.
fn open_or_make(dir: &File, name: &str) -> io::Result<(File, bool)> {
    match open_at(dir, name, OFlags::DIRECTORY) {
        Ok(found) => return Ok((found, false)),
        Err(rustix::io::Errno::NOENT) => {}
        Err(error) => return Err(error.into()),
    }
    let made = match rustix::fs::mkdirat(dir, name, Mode::from_raw_mode(0o777)) {
        Ok(()) => true,
        Err(rustix::io::Errno::EXIST) => false,
        Err(error) => return Err(error.into()),
    };
    Ok((open_at(dir, name, OFlags::DIRECTORY)?, made))
}

fn create_in(dir: &File, name: &str, access: OFlags) -> io::Result<File> {
    Ok(rustix::fs::openat(
        dir,
        name,
        access | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::from_raw_mode(0o666),
    )
    .map(File::from)?)
}

/// The text of the file `name` in `dir`, or `None` where there is none. A FIFO there blocks the
/// read until it is written.
fn read_in(dir: &File, name: &str) -> io::Result<Option<String>> {
    let mut file = match open_at(dir, name, OFlags::empty()) {
        Ok(file) => file,
        Err(rustix::io::Errno::NOENT) => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let mut text = String::new();
    file.read_to_string(&mut text)?;
    Ok(Some(text))
}

/// Writes `text` as the file `name` in `dir`, synced with the folder that names it.
fn write_in(dir: &File, name: &str, text: &str) -> io::Result<()> {
    let mut file = File::from(rustix::fs::openat(
        dir,
        name,
        OFlags::WRONLY | OFlags::CREATE | OFlags::TRUNC | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::from_raw_mode(0o666),
    )?);
    file.write_all(text.as_bytes())?;
    file.sync_all()?;
    drop(file);
    dir.sync_all()
}

/// The names in the folder `dir`.
fn names_in(dir: &File) -> io::Result<Vec<String>> {
    let mut names = Vec::new();
    for entry in rustix::fs::Dir::read_from(dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name != "." && name != ".." {
            names.push(name);
        }
    }
    Ok(names)
}

/// Removes everything in `dir`.
fn empty(dir: &File) -> io::Result<()> {
    for name in names_in(dir)? {
        match rustix::fs::unlinkat(dir, name.as_str(), AtFlags::empty()) {
            Ok(()) | Err(rustix::io::Errno::NOENT) => continue,
            Err(rustix::io::Errno::ISDIR | rustix::io::Errno::PERM) => {}
            Err(error) => return Err(error.into()),
        }
        let inner = open_at(dir, &name, OFlags::DIRECTORY)?;
        empty(&inner)?;
        match rustix::fs::unlinkat(dir, name.as_str(), AtFlags::REMOVEDIR) {
            Ok(()) | Err(rustix::io::Errno::NOENT) => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

/// Empties the folder's `tmp`, where it has one.
fn empty_tmp(dir: &File) -> io::Result<()> {
    let tmp = match open_at(dir, TMP, OFlags::DIRECTORY) {
        Ok(tmp) => tmp,
        Err(rustix::io::Errno::NOENT) => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    empty(&tmp)?;
    tmp.sync_all()
}

/// The store id in `text`, the marker's contents.
fn parsed(text: &str, root: &Path) -> Result<Option<String>, Failure> {
    if text.trim().is_empty() {
        return Ok(None);
    }
    Uuid::parse_str(text.trim())
        .map(|id| Some(id.to_string()))
        .map_err(|_| {
            Failure::start(format!(
                "The marker {} does not hold a store id.",
                root.join(MARKER).display()
            ))
        })
}

fn read_marker(root: &Path, place: Place) -> Result<Option<String>, Failure> {
    match fs::read_to_string(root.join(MARKER)) {
        Ok(text) => parsed(&text, root),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(refused(place, root, "has an unreadable marker", error)),
    }
}

/// The marker in the folder `dir`, which is at `root`.
fn marker_in(dir: &File, root: &Path, place: Place) -> Result<Option<String>, Failure> {
    match read_in(dir, MARKER) {
        Ok(Some(text)) => parsed(&text, root),
        Ok(None) => Ok(None),
        Err(error) => Err(refused(place, root, "has an unreadable marker", error)),
    }
}

/// Goes when this does, unless it was moved into place.
#[derive(Debug)]
pub struct Staged {
    /// Held so the folder stays locked until the upload ends.
    area: Arc<Area>,
    tmp: Arc<File>,
    name: String,
    file: Option<File>,
    hasher: Sha256,
    size: u64,
    published: bool,
}

impl Staged {
    pub fn size(&self) -> u64 {
        self.size
    }

    /// Writes and hashes `bytes`. It blocks.
    pub fn append(&mut self, bytes: &[u8]) -> io::Result<()> {
        let Some(file) = self.file.as_mut() else {
            return Err(io::Error::other("a staged file was closed"));
        };
        file.write_all(bytes)?;
        self.hasher.update(bytes);
        self.size += bytes.len() as u64;
        Ok(())
    }

    /// Opens the file for reading. It blocks.
    pub fn reopen(&self) -> io::Result<File> {
        Ok(open_at(&*self.tmp, &self.name, OFlags::empty())?)
    }

    /// Syncs the file and names it by what it holds. It blocks.
    pub fn seal(&mut self) -> io::Result<Hash> {
        let Some(file) = self.file.take() else {
            return Err(io::Error::other("a staged file was closed"));
        };
        file.sync_all()?;
        Ok(Hash::from_digest(&self.hasher.clone().finalize()))
    }

    /// What removes the file, where it was not moved into place by then.
    pub fn unspool(&self) -> Unspool {
        Unspool {
            tmp: self.tmp.clone(),
            name: self.name.clone(),
        }
    }

    #[cfg(test)]
    fn exists(&self) -> bool {
        rustix::fs::statat(&*self.tmp, self.name.as_str(), AtFlags::SYMLINK_NOFOLLOW).is_ok()
    }

    /// Blocking: async code runs it on a blocking task.
    pub fn discard(mut self) {
        self.published = true;
        self.unspool().run();
    }
}

/// Removes a staged file from the folder it was staged in; one already placed or removed is not
/// there.
#[derive(Debug)]
pub struct Unspool {
    tmp: Arc<File>,
    name: String,
}

impl Unspool {
    /// It blocks.
    pub fn run(self) {
        let _ = rustix::fs::unlinkat(&*self.tmp, self.name.as_str(), AtFlags::empty());
    }

    /// On the runtime the removal goes to a blocking task.
    fn soon(self) {
        match tokio::runtime::Handle::try_current() {
            Ok(runtime) => {
                runtime.spawn_blocking(move || self.run());
            }
            Err(_) => self.run(),
        }
    }
}

impl Drop for Staged {
    /// The way out for an upload that was cancelled while it held the file, wherever it was
    /// dropped.
    fn drop(&mut self) {
        if !self.published {
            self.unspool().soon();
        }
    }
}

/// A file in `tmp` the server writes and reads back. It goes when this does.
#[derive(Debug)]
pub struct Scratch {
    _area: Option<Arc<Area>>,
    tmp: Arc<File>,
    name: String,
    file: File,
}

impl Scratch {
    #[cfg(test)]
    pub fn at(path: PathBuf) -> io::Result<Scratch> {
        let folder = path.parent().unwrap_or(Path::new("."));
        let name = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .ok_or_else(|| io::Error::other("a scratch path has no name"))?;
        let tmp = Arc::new(folder_lock::open_dir(folder)?);
        let file = create_in(&tmp, &name, OFlags::RDWR)?;
        Ok(Scratch {
            _area: None,
            tmp,
            name,
            file,
        })
    }

    pub fn file(&mut self) -> &mut File {
        &mut self.file
    }

    pub fn reopen(&self) -> io::Result<File> {
        Ok(open_at(&*self.tmp, &self.name, OFlags::empty())?)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        Unspool {
            tmp: self.tmp.clone(),
            name: std::mem::take(&mut self.name),
        }
        .soon();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::folder_lock::LOCK;
    use crate::server_lock::{without_locks, without_locks_answering};
    use tempfile::TempDir;

    const NO_LOCKS: [i32; 3] = [libc::ENOTSUP, libc::EOPNOTSUPP, libc::ENOLCK];

    #[test]
    fn a_fresh_folder_gets_a_marker_that_a_second_start_reads_back() {
        let dir = TempDir::new().unwrap();
        let first = Disk::open(&dir.path().join("blobs"), Place::Blobs, None).unwrap();
        let id = first.id().to_string();
        drop(first);
        let second = Disk::open(&dir.path().join("blobs"), Place::Blobs, None).unwrap();
        assert_eq!(second.id(), id);
        assert!(Uuid::parse_str(&id).is_ok());
    }

    #[test]
    fn a_folder_another_server_has_open_is_refused_and_keeps_its_tmp() {
        let dir = TempDir::new().unwrap();
        let root = dir.path().join("blobs");
        let first = Disk::open(&root, Place::Blobs, None).unwrap();
        let half = root.join(TMP).join("half");
        fs::write(&half, b"half an upload").unwrap();
        let through = dir.path().join("through");
        std::os::unix::fs::symlink(dir.path(), &through).unwrap();
        for named in [root.clone(), through.join("blobs")] {
            let refused = Disk::open(&named, Place::Blobs, None).unwrap_err();
            assert_eq!(refused.status, 1);
            assert!(
                refused.message.contains("is open in another Marfa server"),
                "{}",
                refused.message
            );
            assert_eq!(fs::read(&half).unwrap(), b"half an upload");
        }
        drop(first);
        Disk::open(&root, Place::Blobs, None).unwrap();
        assert!(!half.exists());
    }

    #[test]
    fn a_backup_files_area_another_server_has_open_is_refused_in_its_own_words() {
        let dir = TempDir::new().unwrap();
        let area = dir.path().join("files").join("instance");
        let _first = Disk::open(&area, Place::BackupFiles, None).unwrap();
        let refused = Disk::open(&area, Place::BackupFiles, None).unwrap_err();
        assert!(
            refused
                .message
                .starts_with("The backup folder's files area")
                && refused.message.contains("is open in another Marfa server"),
            "{}",
            refused.message
        );
        let adopted = dir.path().join("adopted");
        fs::create_dir_all(&adopted).unwrap();
        let id = Uuid::now_v7().to_string();
        let _claimed = _first.claim(&adopted, &id).unwrap();
        let other = Disk::open(&dir.path().join("other"), Place::BackupFiles, None).unwrap();
        let again = other.claim(&adopted, &id).unwrap_err();
        assert!(
            again
                .to_string()
                .contains("is open in another Marfa server"),
            "{again}"
        );
    }

    #[test]
    fn a_claim_waits_beside_the_marker_until_it_is_promoted_or_undone() {
        let dir = TempDir::new().unwrap();
        let current = Disk::open(&dir.path().join("current"), Place::BackupFiles, None).unwrap();
        let area = dir.path().join("adopted");
        fs::create_dir(&area).unwrap();
        let id = Uuid::now_v7().to_string();

        let claim = current.claim(&area, &id).unwrap();
        assert_eq!(fs::read_to_string(area.join(PENDING)).unwrap(), id);
        assert!(!area.join(MARKER).exists());
        assert!(area.join(TMP).is_dir() && area.join(LOCK).is_file());
        assert!(Disk::open(&area, Place::BackupFiles, None).is_err());
        claim.undo().unwrap();
        assert!(!area.join(PENDING).exists());
        assert!(current.pending(&area).unwrap().is_none());

        drop(current.claim(&area, &id).unwrap());
        let found = current.pending(&area).unwrap().unwrap();
        assert_eq!(found.id(), id);
        let adopted = found.promote().unwrap();
        assert_eq!(adopted.id(), id);
        assert_eq!(fs::read_to_string(area.join(MARKER)).unwrap(), id);
        assert!(!area.join(PENDING).exists());
        assert!(adopted.pending(&area).unwrap().is_none());
        assert!(adopted.stage().is_ok());

        let elsewhere = dir.path().join("elsewhere");
        fs::create_dir(&elsewhere).unwrap();
        fs::write(elsewhere.join(MARKER), Uuid::now_v7().to_string()).unwrap();
        let refused = current.claim(&elsewhere, &id).unwrap_err();
        assert!(
            refused.to_string().contains("marker of another store"),
            "{refused}"
        );
        assert!(!elsewhere.join(PENDING).exists());
    }

    #[test]
    fn a_claim_of_the_folder_the_store_holds_takes_no_second_lock() {
        let dir = TempDir::new().unwrap();
        let area = dir.path().join("area");
        let current = Disk::open(&area, Place::BackupFiles, None).unwrap();
        let claim = current.claim(&area, current.id()).unwrap();
        assert!(Arc::ptr_eq(&claim.area, &current.area().unwrap()));
    }

    #[test]
    fn a_pending_marker_changed_before_its_promotion_is_not_promoted() {
        let dir = TempDir::new().unwrap();
        let current = Disk::open(&dir.path().join("current"), Place::BackupFiles, None).unwrap();
        let area = dir.path().join("adopted");
        fs::create_dir(&area).unwrap();
        let claim = current.claim(&area, &Uuid::now_v7().to_string()).unwrap();
        let other = Uuid::now_v7().to_string();
        fs::write(area.join(PENDING), &other).unwrap();
        assert!(claim.promote().is_err());
        assert!(!area.join(MARKER).exists());
        assert_eq!(fs::read_to_string(area.join(PENDING)).unwrap(), other);
    }

    #[test]
    fn a_folder_whose_lock_file_was_removed_or_replaced_is_still_refused_and_keeps_its_tmp() {
        for place in [Place::Blobs, Place::BackupFiles] {
            for replaced in [false, true] {
                let dir = TempDir::new().unwrap();
                let root = dir.path().join("area");
                let first = Disk::open(&root, place, None).unwrap();
                let half = half_written(&root);
                fs::remove_file(root.join(LOCK)).unwrap();
                if replaced {
                    let other = dir.path().join("other");
                    fs::write(&other, b"").unwrap();
                    fs::rename(&other, root.join(LOCK)).unwrap();
                }
                let refused = Disk::open(&root, place, None).unwrap_err();
                assert!(
                    refused.message.contains("is open in another Marfa server"),
                    "{place:?} {replaced}: {}",
                    refused.message
                );
                assert_eq!(fs::read(&half).unwrap(), b"left", "{place:?} {replaced}");
                // The witness: once the first lets go, a second open empties `tmp`.
                drop(first);
                Disk::open(&root, place, None).unwrap();
                assert!(!half.exists(), "{place:?} {replaced}");
            }
        }
    }

    /// Each entry under `root` with its mode, so a test can tell that nothing changed.
    fn entries(root: &Path) -> Vec<(PathBuf, u32)> {
        use std::os::unix::fs::MetadataExt as _;
        let mut found = Vec::new();
        let mut walking = vec![root.to_path_buf()];
        while let Some(folder) = walking.pop() {
            for entry in fs::read_dir(&folder).unwrap() {
                let path = entry.unwrap().path();
                let meta = fs::symlink_metadata(&path).unwrap();
                if meta.is_dir() {
                    walking.push(path.clone());
                }
                found.push((path, meta.mode()));
            }
        }
        found.sort();
        found
    }

    #[test]
    fn a_refused_open_changes_nothing_in_the_folder() {
        use std::os::unix::fs::PermissionsExt as _;
        for place in [Place::Blobs, Place::BackupFiles] {
            let dir = TempDir::new().unwrap();
            let root = dir.path().join("area");
            let _first = Disk::open(&root, place, None).unwrap();
            half_written(&root);
            fs::set_permissions(root.join(LOCK), fs::Permissions::from_mode(0o660)).unwrap();
            let before = entries(&root);
            assert!(Disk::open(&root, place, None).is_err());
            assert_eq!(entries(&root), before, "{place:?}");
        }
    }

    #[test]
    fn a_folder_renamed_and_replaced_by_a_copy_takes_no_write() {
        let dir = TempDir::new().unwrap();
        let root = dir.path().join("blobs");
        let disk = Disk::open(&root, Place::Blobs, None).unwrap();
        let mut early = disk.stage().unwrap();
        early.append(b"staged before the move").unwrap();
        let moved = dir.path().join("moved");
        fs::rename(&root, &moved).unwrap();
        fs::create_dir(&root).unwrap();
        fs::copy(moved.join(MARKER), root.join(MARKER)).unwrap();
        let copy = entries(&root);
        assert!(disk.stage().is_err());
        assert!(disk.scratch().is_err());
        let hash = early.seal().unwrap();
        assert!(disk.publish(&mut early, &hash).is_err());
        assert!(disk.delete(&hash).is_err());
        assert!(disk.clear_tmp_before(std::time::SystemTime::now()).is_err());
        assert_eq!(entries(&root), copy, "the copy at the path was written");
        drop(early);
        assert!(fs::read_dir(moved.join(TMP)).unwrap().next().is_none());
    }

    #[test]
    fn a_lock_file_removed_or_replaced_while_the_folder_is_held_is_made_again() {
        for replaced in [false, true] {
            let dir = TempDir::new().unwrap();
            let root = dir.path().join("blobs");
            let disk = Disk::open(&root, Place::Blobs, None).unwrap();
            fs::remove_file(root.join(LOCK)).unwrap();
            if replaced {
                fs::write(root.join(LOCK), b"").unwrap();
            }
            assert!(disk.stage().is_ok(), "{replaced}");
            assert!(disk.lock_note().is_some(), "{replaced}");
            assert!(open_refused(&root), "{replaced}");
            // The witness: the lock file a second server would take is the one the store holds.
            assert!(matches!(
                crate::server_lock::take(&root.join(LOCK)),
                Err(Untaken::Held)
            ));
        }
    }

    #[test]
    fn a_folder_removed_and_put_back_with_its_marker_is_taken_again() {
        let dir = TempDir::new().unwrap();
        let root = dir.path().join("blobs");
        let disk = Disk::open(&root, Place::Blobs, None).unwrap();
        fs::remove_dir_all(&root).unwrap();
        assert!(disk.stage().is_err());
        fs::create_dir(&root).unwrap();
        fs::write(root.join(MARKER), disk.id()).unwrap();
        let staged = disk.stage().unwrap();
        assert!(staged.exists());
        assert!(root.join(LOCK).is_file());
        assert!(open_refused(&root));
    }

    #[test]
    fn a_returned_blob_folder_is_made_private_through_the_descriptor_it_was_locked_by() {
        use std::os::unix::fs::PermissionsExt as _;
        let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
        let dir = TempDir::new().unwrap();
        let root = dir.path().join("blobs");
        let id = left_marked(&root);
        fs::set_permissions(&root, fs::Permissions::from_mode(0o755)).unwrap();

        // The witness: a returned folder left in place is made private by the first write.
        let disk = Disk::unmounted(id.clone(), root.clone(), Place::Blobs);
        assert!(disk.stage().is_ok());
        assert_eq!(mode(&root), 0o700);
        drop(disk);

        fs::set_permissions(&root, fs::Permissions::from_mode(0o755)).unwrap();
        let disk = Disk::unmounted(id.clone(), root.clone(), Place::Blobs);
        let moved = dir.path().join("moved");
        let (root_now, moved_now) = (root.clone(), moved.clone());
        between_lock_and_mode(move || {
            fs::rename(&root_now, &moved_now).unwrap();
            fs::create_dir(&root_now).unwrap();
            fs::set_permissions(&root_now, fs::Permissions::from_mode(0o755)).unwrap();
            fs::write(root_now.join(MARKER), &id).unwrap();
        });
        assert!(disk.stage().is_err());
        assert_eq!(mode(&root), 0o755, "the folder put at the path was changed");
        assert_eq!(mode(&moved), 0o700);
        assert_eq!(
            fs::read_dir(&root).unwrap().count(),
            1,
            "only the marker the test wrote"
        );
    }

    /// A folder holding an upload in progress in `tmp`.
    fn half_written(root: &Path) -> PathBuf {
        let half = root.join(TMP).join("half");
        fs::create_dir_all(root.join(TMP)).unwrap();
        fs::write(&half, b"left").unwrap();
        half
    }

    #[test]
    fn a_backup_files_area_on_a_file_system_without_locks_opens_unlocked_and_says_why() {
        for code in NO_LOCKS {
            let dir = TempDir::new().unwrap();
            let area = dir.path().join("area");
            let half = half_written(&area);
            let disk =
                without_locks_answering(code, || Disk::open(&area, Place::BackupFiles, None))
                    .unwrap();
            assert!(
                disk.unlocked()
                    .is_some_and(|why| why.contains("takes no locks")),
                "{code}: {:?}",
                disk.unlocked()
            );
            assert!(half.exists(), "{code}");

            let adopted = dir.path().join("adopted");
            fs::create_dir_all(&adopted).unwrap();
            let id = Uuid::now_v7().to_string();
            let claimed = without_locks_answering(code, || disk.claim(&adopted, &id)).unwrap();
            assert!(claimed.area.folder.unlocked_why().is_some(), "{code}");

            let blobs = dir.path().join("blobs");
            let half = half_written(&blobs);
            let refused =
                without_locks_answering(code, || Disk::open(&blobs, Place::Blobs, None))
                    .unwrap_err();
            assert!(
                refused.message.contains("could not be locked"),
                "{code}: {}",
                refused.message
            );
            assert!(half.exists(), "{code}");
            let refused = without_locks_answering(code, || lock_blobs(&blobs)).unwrap_err();
            assert!(
                refused.message.contains("takes no locks"),
                "{code}: {}",
                refused.message
            );
        }
    }

    #[test]
    fn a_backup_files_area_without_locks_removes_nothing_it_did_not_make() {
        for code in NO_LOCKS {
            let dir = TempDir::new().unwrap();
            let area = dir.path().join("area");
            let half = half_written(&area);
            let disk =
                without_locks_answering(code, || Disk::open(&area, Place::BackupFiles, None))
                    .unwrap();
            assert!(disk.unlocked().is_some(), "{code}");
            assert_eq!(fs::read(&half).unwrap(), b"left", "{code}");
            assert_eq!(
                disk.clear_tmp_before(std::time::SystemTime::now()).ok(),
                Some(0),
                "{code}"
            );
            assert_eq!(fs::read(&half).unwrap(), b"left", "{code}");
        }
        // The witness: a locked area clears the same file.
        let dir = TempDir::new().unwrap();
        let area = dir.path().join("area");
        let disk = Disk::open(&area, Place::BackupFiles, None).unwrap();
        let half = half_written(&area);
        assert_eq!(
            disk.clear_tmp_before(std::time::SystemTime::now()).ok(),
            Some(1)
        );
        assert!(!half.exists());
    }

    #[test]
    fn a_backup_files_area_whose_lock_file_is_refused_refuses_the_start_and_keeps_its_tmp() {
        let dir = TempDir::new().unwrap();
        let area = dir.path().join("area");
        // The witness: the area opens, locked, while its lock file is one the server can take.
        drop(Disk::open(&area, Place::BackupFiles, None).unwrap());
        let half = half_written(&area);
        // What the lock file of a server running as another account fails too.
        fs::remove_file(area.join(LOCK)).unwrap();
        fs::create_dir(area.join(LOCK)).unwrap();
        let refused = Disk::open(&area, Place::BackupFiles, None).unwrap_err();
        assert!(
            refused
                .message
                .starts_with("The backup folder's files area")
                && refused.message.contains("its lock file"),
            "{}",
            refused.message
        );
        assert!(half.exists());
        let id = Uuid::now_v7().to_string();
        let current = Disk::open(&dir.path().join("current"), Place::BackupFiles, None).unwrap();
        let refused = current.claim(&area, &id).unwrap_err();
        assert!(refused.to_string().contains("its lock file"), "{refused}");
        assert!(half.exists());
    }

    #[test]
    fn a_start_empties_tmp_and_keeps_the_blobs() {
        let dir = TempDir::new().unwrap();
        let root = dir.path().join("blobs");
        let disk = Disk::open(&root, Place::Blobs, None).unwrap();
        let mut staged = disk.stage().unwrap();
        staged.append(b"kept").unwrap();
        let hash = staged.seal().unwrap();
        disk.publish(&mut staged, &hash).unwrap();
        fs::write(root.join(TMP).join("half"), b"half an upload").unwrap();
        let kept = disk.path_of(&hash);
        drop(staged);
        drop(disk);
        Disk::open(&root, Place::Blobs, None).unwrap();
        assert!(fs::read_dir(root.join(TMP)).unwrap().next().is_none());
        assert_eq!(fs::read(&kept).unwrap(), b"kept");
        let hex = hash.hex();
        assert!(root.join(&hex[0..4]).join(hex).is_file());
    }

    #[test]
    fn staging_makes_a_missing_tmp_inside_the_marked_folder_and_never_the_folder() {
        let dir = TempDir::new().unwrap();
        let root = dir.path().join("blobs");
        let disk = Disk::open(&root, Place::Blobs, None).unwrap();
        fs::remove_dir(root.join(TMP)).unwrap();
        let staged = disk.stage().unwrap();
        assert!(staged.exists());
        fs::remove_dir_all(root.join(TMP)).unwrap();
        assert!(disk.scratch().is_ok());
        fs::remove_dir_all(&root).unwrap();
        assert!(disk.stage().is_err());
        assert!(disk.scratch().is_err());
        assert!(!root.exists());
        fs::create_dir(&root).unwrap();
        assert!(disk.stage().is_err());
        assert!(!root.join(TMP).exists());
    }

    #[test]
    fn a_marker_that_is_not_an_id_stops_the_start() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join(MARKER), b"not an id").unwrap();
        assert!(Disk::open(dir.path(), Place::Blobs, None).is_err());
    }

    #[test]
    fn a_staged_file_goes_with_its_upload_unless_it_was_placed() {
        let dir = TempDir::new().unwrap();
        let disk = Disk::open(dir.path(), Place::Blobs, None).unwrap();
        let mut dropped = disk.stage().unwrap();
        dropped.append(b"half").unwrap();
        drop(dropped);
        assert!(fs::read_dir(dir.path().join(TMP)).unwrap().next().is_none());
    }

    #[tokio::test]
    async fn a_staged_file_dropped_on_the_runtime_is_removed_off_it() {
        let dir = TempDir::new().unwrap();
        let disk = Disk::open(dir.path(), Place::Blobs, None).unwrap();
        let mut dropped = disk.stage().unwrap();
        dropped.append(b"half").unwrap();
        drop(dropped);
        for _ in 0..100 {
            if fs::read_dir(dir.path().join(TMP)).unwrap().next().is_none() {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        panic!("the staged file was not removed");
    }

    #[test]
    fn a_probe_changes_nothing_and_a_folder_without_its_marker_is_unreachable() {
        let dir = TempDir::new().unwrap();
        let root = dir.path().join("blobs");
        assert_eq!(Disk::probe(&root, Place::Blobs).unwrap(), Found::Missing);
        assert!(!root.exists());
        fs::create_dir(&root).unwrap();
        assert_eq!(Disk::probe(&root, Place::Blobs).unwrap(), Found::Unmarked);
        let disk = Disk::open(&root, Place::Blobs, None).unwrap();
        assert_eq!(Disk::probe(&root, Place::Blobs).unwrap(), Found::Marked);
        assert!(disk.reachable());
        fs::remove_file(root.join(MARKER)).unwrap();
        assert!(!disk.reachable());
        let hash = Hash::from_digest(&Sha256::digest(b"x"));
        assert!(disk.size_of(&hash).is_err());
        assert!(disk.delete(&hash).is_err());
    }

    /// The id of a marked blob folder no running store holds.
    fn left_marked(root: &Path) -> String {
        Disk::open(root, Place::Blobs, None)
            .unwrap()
            .id()
            .to_string()
    }

    fn open_refused(root: &Path) -> bool {
        Disk::open(root, Place::Blobs, None)
            .is_err_and(|refused| refused.message.contains("is open in another Marfa server"))
    }

    #[test]
    fn a_returned_blob_folder_is_locked_by_the_first_write_and_not_by_a_read() {
        let dir = TempDir::new().unwrap();
        let root = dir.path().join("blobs");
        let id = left_marked(&root);
        let disk = Disk::unmounted(id, root.clone(), Place::Blobs);
        assert!(disk.reachable());
        assert!(
            disk.size_of(&Hash::from_digest(&Sha256::digest(b"x")))
                .is_ok()
        );
        assert!(!open_refused(&root), "the witness: a read took no lock");
        let staged = disk.stage().unwrap();
        assert!(open_refused(&root));
        assert!(staged.exists());
    }

    #[test]
    fn a_returned_blob_folder_another_server_holds_is_read_and_not_written_until_it_ends() {
        let dir = TempDir::new().unwrap();
        let root = dir.path().join("blobs");
        let id = left_marked(&root);
        let disk = Disk::unmounted(id, root.clone(), Place::Blobs);
        let other = Disk::open(&root, Place::Blobs, None).unwrap();
        let hash = Hash::from_digest(&Sha256::digest(b"x"));
        assert!(disk.reachable());
        assert!(disk.size_of(&hash).is_ok());
        assert!(disk.unwritable().is_some());
        assert!(disk.stage().is_err());
        assert!(disk.scratch().is_err());
        assert!(disk.delete(&hash).is_err());
        assert!(disk.clear_tmp_before(std::time::SystemTime::now()).is_err());
        drop(other);
        assert!(disk.unwritable().is_none());
        assert!(open_refused(&root), "the look took the lock");
        assert!(disk.stage().is_ok());
    }

    #[test]
    fn only_a_folder_with_the_marker_gets_a_lock_file_when_it_is_awaited() {
        let dir = TempDir::new().unwrap();
        let root = dir.path().join("blobs");
        fs::create_dir(&root).unwrap();
        let id = Uuid::now_v7().to_string();
        let disk = Disk::unmounted(id.clone(), root.clone(), Place::Blobs);
        assert!(disk.stage().is_err());
        assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
        // The witness: the same write makes the lock file once the marker is there.
        fs::write(root.join(MARKER), &id).unwrap();
        assert!(disk.stage().is_ok());
        assert!(root.join(LOCK).is_file());
    }

    #[test]
    fn a_store_let_go_takes_no_lock_and_writes_nothing_when_its_folder_returns() {
        let dir = TempDir::new().unwrap();
        let root = dir.path().join("blobs");
        let id = left_marked(&root);
        let disk = Disk::unmounted(id.clone(), root.clone(), Place::Blobs);
        disk.let_go();
        let before = entries(&root);
        assert!(disk.stage().is_err());
        assert!(!open_refused(&root));
        assert_eq!(entries(&root), before);
        // The witness: the same store not let go takes the folder by its first write.
        let kept = Disk::unmounted(id, root.clone(), Place::Blobs);
        assert!(kept.stage().is_ok());
        assert!(open_refused(&root));
    }

    #[test]
    fn a_store_let_go_keeps_its_lock_until_a_write_under_way_ends() {
        let dir = TempDir::new().unwrap();
        let root = dir.path().join("blobs");
        let disk = Disk::open(&root, Place::Blobs, None).unwrap();
        let mut staged = disk.stage().unwrap();
        disk.let_go();
        assert!(open_refused(&root));
        staged.append(b"under way").unwrap();
        drop(staged);
        assert!(!open_refused(&root));
    }

    #[test]
    fn a_returned_blob_folder_on_a_file_system_without_locks_is_not_written() {
        let dir = TempDir::new().unwrap();
        let root = dir.path().join("blobs");
        let id = left_marked(&root);
        let disk = Disk::unmounted(id, root, Place::Blobs);
        assert!(without_locks(|| disk.stage()).is_err());
        assert!(without_locks(|| disk.unwritable()).is_some());
    }

    #[test]
    fn a_rehash_finds_an_altered_file_and_a_missing_one() {
        let dir = TempDir::new().unwrap();
        let disk = Disk::open(dir.path(), Place::Blobs, None).unwrap();
        let mut staged = disk.stage().unwrap();
        staged.append(b"kept bytes").unwrap();
        let hash = staged.seal().unwrap();
        disk.publish(&mut staged, &hash).unwrap();
        assert_eq!(disk.rehash(&hash, false).unwrap(), Some((10, hash.clone())));
        let changed = Hash::from_digest(&Sha256::digest(b"\x94ept bytes"));
        assert_eq!(disk.rehash(&hash, true).unwrap(), Some((10, changed)));
        fs::write(disk.path_of(&hash), b"kept bytez").unwrap();
        assert_ne!(disk.rehash(&hash, false).unwrap().unwrap().1, hash);
        disk.delete(&hash).unwrap();
        disk.delete(&hash).unwrap();
        assert_eq!(disk.rehash(&hash, false).unwrap(), None);
    }

    #[test]
    fn a_file_missing_because_the_folder_went_away_is_unreachable_not_missing() {
        let dir = TempDir::new().unwrap();
        let disk = Disk::open(dir.path(), Place::Blobs, None).unwrap();
        let hash = Hash::from_digest(&Sha256::digest(b"never kept"));
        assert_eq!(disk.rehash(&hash, false).unwrap(), None);
        let unmounted = disk.rehash_opened(&hash, false, |path| {
            fs::remove_file(dir.path().join(MARKER))?;
            File::open(path)
        });
        assert!(unmounted.is_err(), "{unmounted:?}");
    }

    #[test]
    fn only_files_staged_before_the_cut_are_cleared_from_tmp() {
        let dir = TempDir::new().unwrap();
        let disk = Disk::open(dir.path(), Place::Blobs, None).unwrap();
        fs::write(dir.path().join(TMP).join("not an id"), b"stray").unwrap();
        let early = disk.stage().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        let cut = std::time::SystemTime::now();
        std::thread::sleep(std::time::Duration::from_millis(5));
        let late = disk.stage().unwrap();
        assert_eq!(disk.clear_tmp_before(cut).unwrap(), 2);
        assert!(!early.exists());
        assert!(late.exists());
        fs::remove_file(dir.path().join(MARKER)).unwrap();
        assert!(disk.clear_tmp_before(cut).is_err());
    }

    #[test]
    fn a_second_publish_of_the_same_bytes_discards_its_staged_file() {
        let dir = TempDir::new().unwrap();
        let disk = Disk::open(dir.path(), Place::Blobs, None).unwrap();
        let mut hashes = Vec::new();
        for _ in 0..2 {
            let mut staged = disk.stage().unwrap();
            staged.append(b"same bytes").unwrap();
            let hash = staged.seal().unwrap();
            disk.publish(&mut staged, &hash).unwrap();
            hashes.push(hash);
        }
        assert_eq!(hashes[0], hashes[1]);
        assert!(fs::read_dir(dir.path().join(TMP)).unwrap().next().is_none());
        assert_eq!(fs::read(disk.path_of(&hashes[0])).unwrap(), b"same bytes");
    }
}
