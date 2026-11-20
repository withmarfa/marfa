//! The backup folder the owner names: each backup's manifest under `backups/<instance id>/`, the
//! parts manifests name under `backup-parts/<instance id>/`, and a copy of each file under
//! `files/<instance id>/`, a disk store of its own.

use std::collections::BTreeSet;
use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{self, Write as _};
use std::os::unix::fs::{DirEntryExt as _, MetadataExt as _};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError, RwLock};
use std::time::{Duration, SystemTime};

use futures_util::StreamExt;
use futures_util::stream;
use uuid::Uuid;

use super::disk::{self, AreaLock, Disk, Place};
use super::hash::Hash;
use super::rows;
use super::store::ByteStream;
use crate::app::faults::{FAIL_BACKUP_FOLDER_WRITE, Faults};
use crate::app::fingerprint::Fingerprint;
use crate::db::Db;
use crate::failure::Failure;

pub const BACKUPS: &str = "backups";
pub const PARTS: &str = "backup-parts";
pub const FILES: &str = "files";
const PARTIAL: &str = ".partial";

/// The two folders per instance a backup is written to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Area {
    Backups,
    Parts,
}

impl Area {
    pub fn name(self) -> &'static str {
        match self {
            Area::Backups => BACKUPS,
            Area::Parts => PARTS,
        }
    }
}

#[derive(Debug)]
pub struct Folder {
    root: PathBuf,
    instance: String,
    /// Replaced only when the owner adopts a folder whose files area lost its marker.
    files: RwLock<Arc<Disk>>,
    /// The files area with its links resolved when opened, so every path to it shares one claim.
    claim_key: PathBuf,
    /// A temporary file staged before this is a leftover of a process that ended.
    started: SystemTime,
}

/// A timed-out claim outlives its caller and may share its area with a reopened folder.
static CLAIMING: Mutex<BTreeSet<PathBuf>> = Mutex::new(BTreeSet::new());

fn claiming() -> std::sync::MutexGuard<'static, BTreeSet<PathBuf>> {
    CLAIMING.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Ends an area's claim when its blocking work ends or never runs.
struct Claiming(PathBuf);

impl Drop for Claiming {
    fn drop(&mut self) {
        claiming().remove(&self.0);
    }
}

/// What the folder holds when the owner asks to adopt it.
#[derive(Debug, PartialEq, Eq)]
pub enum Adoptable {
    /// Its files area holds this store's marker, so there is nothing to adopt.
    Held,
    /// The folder `backup_path` names is not there.
    Missing,
    /// Its files area holds the marker of the store with this id.
    Foreign(String),
    /// Its files area holds no marker.
    Unmarked,
}

/// What adopting found once the files area was locked, holding the area's claim and lock until
/// the marker is written.
pub struct Holding {
    _claiming: Claiming,
    lock: Option<AreaLock>,
    pub found: Adoptable,
    /// What `Folder::fingerprint` read under the lock.
    pub fingerprint: String,
}

/// What writing the marker under a held lock did.
pub struct Claimed {
    pub written: io::Result<()>,
    /// The folder's fingerprint once the marker was written.
    pub fingerprint: io::Result<String>,
}

fn not_there() -> io::Error {
    io::Error::new(io::ErrorKind::NotFound, "the backup folder is not there")
}

fn born(meta: &Metadata) -> Option<String> {
    let born = meta
        .created()
        .ok()?
        .duration_since(SystemTime::UNIX_EPOCH)
        .ok()?;
    Some(format!("{}.{:09}", born.as_secs(), born.subsec_nanos()))
}

/// Names the operating system or a desktop gives entries it makes in any folder it opens.
fn made_by_the_system(name: &str) -> bool {
    name.starts_with("._")
        || name.starts_with(".Trash")
        || matches!(
            name,
            ".DS_Store"
                | ".Spotlight-V100"
                | ".fseventsd"
                | ".TemporaryItems"
                | ".DocumentRevisions-V100"
                | ".apdisk"
                | ".VolumeIcon.icns"
                | ".localized"
                | ".com.apple.timemachine.donotpresent"
                | ".directory"
                | ".hidden"
        )
}

/// Adds the entries of `folder` but `own` to `print`, by name, kind and inode.
fn entries(print: &mut Fingerprint, folder: &Path, own: &[&str]) -> io::Result<()> {
    let listed = match fs::read_dir(folder) {
        Ok(listed) => listed,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            print.number(0);
            return Ok(());
        }
        Err(error) => return Err(error),
    };
    let mut found = Vec::new();
    for entry in listed {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if own.contains(&name.as_str()) || made_by_the_system(&name) {
            continue;
        }
        let kind = match entry.file_type() {
            Ok(kind) if kind.is_dir() => "d",
            Ok(kind) if kind.is_file() => "f",
            Ok(kind) if kind.is_symlink() => "l",
            Ok(_) => "o",
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        };
        found.push((name, kind, entry.ino()));
    }
    found.sort_unstable();
    print.number(i64::try_from(found.len()).unwrap_or(i64::MAX));
    for (name, kind, ino) in &found {
        print.text(name).text(kind).text(&ino.to_string());
    }
    Ok(())
}

fn started(error: impl std::fmt::Display) -> Failure {
    Failure::start(error.to_string())
}

/// `path` with its symbolic links resolved as far as it exists.
fn resolved(path: &Path) -> PathBuf {
    let mut existing = path;
    let mut rest = Vec::new();
    loop {
        if let Ok(found) = fs::canonicalize(existing) {
            return rest.iter().rev().fold(found, |path, part| path.join(part));
        }
        match (existing.parent(), existing.file_name()) {
            (Some(parent), Some(name)) => {
                rest.push(name.to_os_string());
                existing = parent;
            }
            _ => return path.to_path_buf(),
        }
    }
}

/// Refuses a folder inside one the instance keeps its data in, since it goes with the data.
pub fn outside(root: &Path, data: &[(&str, &Path)]) -> Result<(), Failure> {
    let folder = resolved(root);
    for (what, dir) in data {
        let dir = resolved(dir);
        if folder.starts_with(&dir) {
            return Err(Failure::start(format!(
                "backup_path names {}, which is inside the {what} {}. A backup there is lost \
                 with what it backs up: name a folder outside it, best on another disk.",
                root.display(),
                dir.display()
            )));
        }
    }
    Ok(())
}

impl Folder {
    /// Takes the named folder, which must exist, making only `files/<instance id>/` inside it.
    /// A folder whose files area went away since the server recorded it, such as a disk that
    /// did not mount, is kept as it is, and each backup fails until it is back or the owner
    /// adopts the folder there now.
    pub async fn open(db: &Db, root: &Path, instance: &str) -> Result<Folder, Failure> {
        let area = root.join(FILES).join(instance);
        let probed = area.clone();
        let (found, claim_key) = tokio::task::spawn_blocking(move || {
            Disk::probe(&probed, Place::BackupFiles).map(|found| (found, resolved(&probed)))
        })
        .await
        .map_err(started)??;
        let files = if found == disk::Found::Marked {
            let opened = area.clone();
            tokio::task::spawn_blocking(move || Disk::open(&opened, Place::BackupFiles, None))
                .await
                .map_err(started)??
        } else {
            let locator = area.display().to_string();
            let recorded = db
                .read(move |tx| rows::folder_at(tx, &locator))
                .await
                .map_err(started)?;
            match recorded {
                Some(id) => {
                    tracing::warn!(
                        folder = %root.display(),
                        "The backup folder is not there, or does not hold this instance's files; \
                         backups fail until its disk is mounted, or `marfa backups folder adopt` \
                         takes a disk that replaced it"
                    );
                    Disk::unmounted(id, area)
                }
                None => {
                    let (made, opened) = (root.to_path_buf(), area.clone());
                    tokio::task::spawn_blocking(move || {
                        if !made.is_dir() {
                            return Err(Failure::start(format!(
                                "backup_path names {}, which does not exist. Create it, or \
                                 mount the disk it is on: the server makes only the folders \
                                 inside it.",
                                made.display()
                            )));
                        }
                        make_inside(&made.join(FILES)).map_err(|error| {
                            Failure::start(format!(
                                "The backup folder {} took no files folder: {error}",
                                made.display()
                            ))
                        })?;
                        Disk::open(&opened, Place::BackupFiles, None)
                    })
                    .await
                    .map_err(started)??
                }
            }
        };
        Ok(Folder {
            root: root.to_path_buf(),
            instance: instance.to_string(),
            files: RwLock::new(Arc::new(files)),
            claim_key,
            #[allow(
                clippy::disallowed_methods,
                reason = "compared with files' modification times, which are the host's time"
            )]
            started: SystemTime::now(),
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn files(&self) -> Arc<Disk> {
        self.files
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    pub fn let_go(&self) {
        self.files().let_go();
    }

    /// Whether the folder is the one the server took: its files area holds this store's marker.
    pub fn reachable(&self) -> bool {
        self.files().reachable()
    }

    /// This instance's files area.
    pub fn area(&self) -> PathBuf {
        self.root.join(FILES).join(&self.instance)
    }

    /// What adopting the folder would meet. It blocks.
    pub fn adoptable(&self) -> io::Result<Adoptable> {
        if self.reachable() {
            return Ok(Adoptable::Held);
        }
        if !self.root.is_dir() {
            return Ok(Adoptable::Missing);
        }
        match Disk::marked(&self.area()) {
            Ok(Some(id)) => Ok(Adoptable::Foreign(id)),
            Ok(None) => Ok(Adoptable::Unmarked),
            Err(failure) => Err(io::Error::other(failure.message)),
        }
    }

    /// Whether a claim has started whose blocking work has not ended.
    pub fn claim_unended(&self) -> bool {
        claiming().contains(&self.claim_key)
    }

    /// A timeout does not cancel the blocking claim.
    pub async fn claim_within(
        self: &Arc<Self>,
        id: String,
        deadline: Duration,
    ) -> Option<io::Result<()>> {
        if !claiming().insert(self.claim_key.clone()) {
            return None;
        }
        let (folder, claiming) = (self.clone(), Claiming(self.claim_key.clone()));
        let claimed = tokio::task::spawn_blocking(move || {
            let _claiming = claiming;
            folder.claim(&id)
        });
        match tokio::time::timeout(deadline, claimed).await {
            Ok(Ok(answer)) => Some(answer),
            Ok(Err(error)) => Some(Err(io::Error::other(error))),
            Err(_) => None,
        }
    }

    /// Takes the files area as the store `id`; where that fails, `id` waits as one not mounted.
    fn claim(&self, id: &str) -> io::Result<()> {
        let area = self.area();
        let locked = if self.root.is_dir() {
            make_inside(&self.root.join(FILES))
                .and_then(|()| make_inside(&area))
                .and_then(|()| Disk::lock_area(&area))
        } else {
            Err(not_there())
        };
        self.claim_locked(id, locked)
    }

    /// Locks the files area and reads what adopting it would take, keeping the area's claim and
    /// lock until `claim_held` writes the marker. A timeout does not cancel the blocking work.
    pub async fn hold_within(self: &Arc<Self>, deadline: Duration) -> Option<io::Result<Holding>> {
        if !claiming().insert(self.claim_key.clone()) {
            return None;
        }
        let (folder, claiming) = (self.clone(), Claiming(self.claim_key.clone()));
        let held = tokio::task::spawn_blocking(move || folder.hold(claiming));
        match tokio::time::timeout(deadline, held).await {
            Ok(Ok(answer)) => Some(answer),
            Ok(Err(error)) => Some(Err(io::Error::other(error))),
            Err(_) => None,
        }
    }

    fn hold(&self, claiming: Claiming) -> io::Result<Holding> {
        let holding = |lock, found, fingerprint| Holding {
            _claiming: claiming,
            lock,
            found,
            fingerprint,
        };
        if !self.root.is_dir() {
            return Ok(holding(None, Adoptable::Missing, String::new()));
        }
        let old = self.files();
        if old.reachable() {
            return Ok(holding(None, Adoptable::Held, String::new()));
        }
        // The old store's lock, where its folder is still here without its marker, refuses ours.
        old.let_go();
        let area = self.area();
        make_inside(&self.root.join(FILES))?;
        make_inside(&area)?;
        let lock = Disk::lock_area(&area)?;
        let found = match Disk::marked(&area) {
            Ok(Some(id)) if id == old.id() => Adoptable::Held,
            Ok(Some(id)) => Adoptable::Foreign(id),
            Ok(None) => Adoptable::Unmarked,
            Err(failure) => return Err(io::Error::other(failure.message)),
        };
        let fingerprint = self.fingerprint()?;
        Ok(holding(Some(lock), found, fingerprint))
    }

    /// Writes the marker of the store `id` under the lock `holding` took, then reads the folder
    /// again. A timeout does not cancel the blocking work.
    pub async fn claim_held(
        self: &Arc<Self>,
        holding: Holding,
        id: String,
        deadline: Duration,
    ) -> Option<Claimed> {
        let folder = self.clone();
        let claimed = tokio::task::spawn_blocking(move || {
            let Holding {
                _claiming: claiming,
                lock,
                ..
            } = holding;
            let _claiming = claiming;
            let written = folder.claim_locked(&id, lock.ok_or_else(not_there));
            Claimed {
                written,
                fingerprint: folder.fingerprint(),
            }
        });
        match tokio::time::timeout(deadline, claimed).await {
            Ok(Ok(claimed)) => Some(claimed),
            Ok(Err(error)) => Some(Claimed {
                written: Err(io::Error::other(error)),
                fingerprint: Err(not_there()),
            }),
            Err(_) => None,
        }
    }

    /// What adopting would take: the folder, by device, inode and birth time, and the entries of
    /// its root, of `files/` and of this instance's files area, by name, kind and inode. The
    /// entries the operating system makes and the server's own are left out, and a folder that
    /// is not there reads as an empty one. It blocks.
    pub fn fingerprint(&self) -> io::Result<String> {
        let meta = fs::metadata(&self.root)?;
        let mut print = Fingerprint::new("backup folder");
        print
            .text(&meta.dev().to_string())
            .text(&meta.ino().to_string())
            .maybe(born(&meta).as_deref());
        entries(&mut print, &self.root, &[FILES])?;
        entries(&mut print, &self.root.join(FILES), &[&self.instance])?;
        entries(&mut print, &self.area(), &[disk::MARKER, disk::LOCK, disk::TMP])?;
        Ok(print.finish())
    }

    fn claim_locked(&self, id: &str, locked: io::Result<AreaLock>) -> io::Result<()> {
        let area = self.area();
        let claimed = locked.and_then(|lock| {
            if self.root.is_dir() {
                Disk::claim(&area, id, lock)
            } else {
                Err(not_there())
            }
        });
        let (disk, answer) = match claimed {
            Ok(disk) => (disk, Ok(())),
            Err(error) => (Disk::unmounted(id.to_string(), area), Err(error)),
        };
        *self.files.write().unwrap_or_else(PoisonError::into_inner) = Arc::new(disk);
        answer
    }

    fn checked(&self) -> io::Result<()> {
        if self.reachable() {
            return Ok(());
        }
        Err(io::Error::new(
            io::ErrorKind::NotFound,
            "the backup folder is not there, or does not hold this instance's files",
        ))
    }

    fn folder_of(&self, area: Area, instance: &str) -> PathBuf {
        self.root.join(area.name()).join(instance)
    }

    /// The files directly in `instance`'s folder of `area`, by name, with each one's size and
    /// stamp. It blocks.
    pub fn list_in(&self, area: Area, instance: &str) -> io::Result<Vec<(String, u64, String)>> {
        self.checked()?;
        listed(&self.folder_of(area, instance))
    }

    /// Every backup in an instance's folder, as its folder and name, and its size. It blocks.
    pub fn list_all(&self) -> io::Result<Vec<(Vec<String>, u64)>> {
        self.checked()?;
        let entries = match fs::read_dir(self.root.join(BACKUPS)) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error),
        };
        let mut found = Vec::new();
        for entry in entries {
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                continue;
            }
            let instance = entry.file_name().to_string_lossy().into_owned();
            for (name, size, _) in listed(&entry.path())? {
                found.push((vec![instance.clone(), name], size));
            }
        }
        Ok(found)
    }

    /// The file `name` in `instance`'s folder of `area`, with its size and stamp as it was
    /// opened, where the folder holds it. It blocks.
    pub fn open_in(
        &self,
        area: Area,
        instance: &str,
        name: &str,
    ) -> io::Result<Option<(u64, String, File)>> {
        self.checked()?;
        match File::open(self.folder_of(area, instance).join(name)) {
            Ok(file) => {
                let meta = file.metadata()?;
                Ok(meta.is_file().then(|| (meta.len(), stamp(&meta), file)))
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error),
        }
    }

    /// The copy of `hash` in `instance`'s files area, where there is one. It blocks.
    pub fn open_copy(&self, instance: &str, hash: &Hash) -> io::Result<Option<File>> {
        self.checked()?;
        let hex = hash.hex();
        let path = self
            .root
            .join(FILES)
            .join(instance)
            .join(&hex[0..4])
            .join(hex);
        match File::open(path) {
            Ok(file) => Ok(file.metadata()?.is_file().then_some(file)),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error),
        }
    }

    /// The size of the copy of `hash` in `instance`'s files area, where there is one. It blocks.
    pub fn copy_size(&self, instance: &str, hash: &Hash) -> io::Result<Option<u64>> {
        self.open_copy(instance, hash)?
            .map(|file| file.metadata().map(|meta| meta.len()))
            .transpose()
    }

    /// Deletes `name` from this instance's folder of `area`; one not there is already gone. It
    /// blocks.
    pub fn delete(&self, area: Area, name: &str) -> io::Result<()> {
        self.checked()?;
        let own = self.folder_of(area, &self.instance);
        match fs::remove_file(own.join(name)) {
            Ok(()) => File::open(&own)?.sync_all(),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error),
        }
    }

    /// Removes what a backup or a copy left half written when its process ended. Only one backup
    /// runs at a time, so every partial file in this instance's folders is a leftover. It blocks.
    pub fn clear_leftovers(&self) -> io::Result<usize> {
        self.checked()?;
        let mut cleared = self.files().clear_tmp_before(self.started)?;
        for area in [Area::Backups, Area::Parts] {
            cleared += clear_partials(&self.folder_of(area, &self.instance))?;
        }
        Ok(cleared)
    }

    /// A temporary file beside `name` in this instance's folder of `area`, made with the folders
    /// above it inside the named folder. It blocks.
    fn partial(&self, area: Area, name: &str) -> io::Result<Partial> {
        self.checked()?;
        let above = self.root.join(area.name());
        make_inside(&above)?;
        let own = above.join(&self.instance);
        make_inside(&own)?;
        let path = own.join(format!(".{name}.{}{PARTIAL}", Uuid::now_v7()));
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)?;
        Ok(Partial {
            target: own.join(name),
            folder: own,
            path,
            file: Some(file),
            placed: false,
        })
    }
}

/// Removes the partial files in `own`. It blocks.
fn clear_partials(own: &Path) -> io::Result<usize> {
    let entries = match fs::read_dir(own) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(error),
    };
    let mut cleared = 0;
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') && name.ends_with(PARTIAL) {
            match fs::remove_file(entry.path()) {
                Ok(()) => cleared += 1,
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
        }
    }
    if cleared > 0 {
        File::open(own)?.sync_all()?;
    }
    Ok(cleared)
}

/// Makes one folder whose parent must exist; one already there is kept.
fn make_inside(path: &Path) -> io::Result<()> {
    match fs::create_dir(path) {
        Ok(()) => {
            if let Some(parent) = path.parent() {
                File::open(parent)?.sync_all()?;
            }
            Ok(())
        }
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists && path.is_dir() => Ok(()),
        Err(error) => Err(error),
    }
}

/// A file's size, modified time, inode and, where the file system records one, birth time. A
/// disk's decay, or a write in place that sets the time back, keeps it. The change time is left
/// out, since a rename changes it on some file systems.
pub fn stamp(meta: &Metadata) -> String {
    let mut stamp = format!(
        "{}-{}.{:09}-{}",
        meta.len(),
        meta.mtime(),
        meta.mtime_nsec(),
        meta.ino()
    );
    if let Some(born) = meta
        .created()
        .ok()
        .and_then(|at| at.duration_since(SystemTime::UNIX_EPOCH).ok())
    {
        stamp.push_str(&format!("-{}.{:09}", born.as_secs(), born.subsec_nanos()));
    }
    stamp
}

/// Files directly in `folder` whose names a listing may read, by name, size and stamp.
fn listed(folder: &Path) -> io::Result<Vec<(String, u64, String)>> {
    let entries = match fs::read_dir(folder) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    let mut found = Vec::new();
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        match entry.metadata() {
            Ok(meta) if meta.is_file() => found.push((name, meta.len(), stamp(&meta))),
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    Ok(found)
}

/// A file of a backup being written; it goes when this does, unless it was given its name.
struct Partial {
    target: PathBuf,
    folder: PathBuf,
    path: PathBuf,
    file: Option<File>,
    placed: bool,
}

impl Partial {
    fn append(&mut self, bytes: &[u8]) -> io::Result<()> {
        match self.file.as_mut() {
            Some(file) => file.write_all(bytes),
            None => Err(io::Error::other("a partial backup was closed")),
        }
    }

    /// Syncs the bytes, gives them the backup's name and syncs the folder that names them.
    /// Answers the file's stamp under its name.
    fn place(&mut self) -> io::Result<String> {
        let Some(file) = self.file.take() else {
            return Err(io::Error::other("a partial backup was closed"));
        };
        file.sync_all()?;
        fs::rename(&self.path, &self.target)?;
        self.placed = true;
        let stamped = stamp(&file.metadata()?);
        drop(file);
        File::open(&self.folder)?.sync_all()?;
        Ok(stamped)
    }
}

impl Drop for Partial {
    fn drop(&mut self) {
        if !self.placed {
            self.file.take();
            disk::unspool(&self.path);
        }
    }
}

/// A file of a backup written whole under a temporary name, which no listing reads until it is
/// placed.
pub struct Written {
    partial: Partial,
    pub size: u64,
}

impl Written {
    /// Gives the file its name, so it is listed whole or not at all. Answers its size and stamp.
    pub async fn place(self) -> io::Result<(u64, String)> {
        let Written { mut partial, size } = self;
        let stamped = tokio::task::spawn_blocking(move || partial.place())
            .await
            .map_err(io::Error::other)??;
        Ok((size, stamped))
    }
}

/// Writes a file of a backup to a temporary name in this instance's folder of `area`.
pub async fn write(
    folder: Arc<Folder>,
    area: Area,
    name: String,
    mut bytes: ByteStream,
    faults: Arc<Faults>,
) -> io::Result<Written> {
    let mut partial = tokio::task::spawn_blocking(move || folder.partial(area, &name))
        .await
        .map_err(io::Error::other)??;
    let mut size = 0u64;
    let mut first = true;
    while let Some(chunk) = bytes.next().await {
        let chunk = chunk?;
        size += chunk.len() as u64;
        partial = tokio::task::spawn_blocking(move || partial.append(&chunk).map(|()| partial))
            .await
            .map_err(io::Error::other)??;
        if std::mem::take(&mut first) && faults.fail(FAIL_BACKUP_FOLDER_WRITE, None) {
            return Err(full());
        }
    }
    Ok(Written { partial, size })
}

fn full() -> io::Error {
    io::Error::new(io::ErrorKind::StorageFull, "No space left on device")
}

/// `bytes` that fail as a full disk would after their first chunk, where the fault says so.
pub fn filling(bytes: ByteStream, faults: Arc<Faults>) -> ByteStream {
    let mut first = true;
    bytes
        .flat_map(move |chunk| {
            let fails = chunk.is_ok()
                && std::mem::take(&mut first)
                && faults.fail(FAIL_BACKUP_FOLDER_WRITE, None);
            let after = fails.then(|| Err(full()));
            stream::iter(std::iter::once(chunk).chain(after))
        })
        .boxed()
}

#[cfg(test)]
mod tests {
    use bytes::Bytes;

    use super::*;
    use tempfile::TempDir;

    fn opened(root: &Path) -> Folder {
        let area = root.join(FILES).join("instance");
        fs::create_dir_all(&area).unwrap();
        Folder {
            root: root.to_path_buf(),
            instance: "instance".into(),
            files: RwLock::new(Arc::new(
                Disk::open(&area, Place::BackupFiles, None).unwrap(),
            )),
            claim_key: resolved(&area),
            started: SystemTime::now(),
        }
    }

    fn chunks(parts: &[&'static [u8]]) -> ByteStream {
        let parts: Vec<io::Result<Bytes>> = parts
            .iter()
            .map(|part| Ok(Bytes::from_static(part)))
            .collect();
        stream::iter(parts).boxed()
    }

    #[tokio::test]
    async fn a_backup_is_listed_only_once_it_is_whole() {
        let dir = TempDir::new().unwrap();
        let folder = Arc::new(opened(dir.path()));
        let faults = Arc::new(Faults::default());
        let written = write(
            folder.clone(),
            Area::Backups,
            "a.json".into(),
            chunks(&[b"one", b"two"]),
            faults.clone(),
        )
        .await
        .unwrap();
        assert!(
            folder
                .list_in(Area::Backups, "instance")
                .unwrap()
                .is_empty()
        );
        let (size, placed) = written.place().await.unwrap();
        assert_eq!(size, 6);
        assert_eq!(
            folder.list_in(Area::Backups, "instance").unwrap(),
            [("a.json".into(), 6, placed.clone())]
        );
        let (_, opened, _) = folder
            .open_in(Area::Backups, "instance", "a.json")
            .unwrap()
            .unwrap();
        assert_eq!(opened, placed);
        let path = dir.path().join(BACKUPS).join("instance").join("a.json");
        fs::write(&path, b"onetwo").unwrap();
        let (_, _, rewritten) = folder.list_in(Area::Backups, "instance").unwrap().remove(0);
        assert_ne!(rewritten, placed);
        let dropped = write(
            folder.clone(),
            Area::Backups,
            "c.json".into(),
            chunks(&[b"never placed"]),
            faults.clone(),
        )
        .await
        .unwrap();
        drop(dropped);

        let broken = stream::iter([
            Ok(Bytes::from_static(b"half")),
            Err(io::Error::other("the archive stopped")),
        ])
        .boxed();
        assert!(
            write(
                folder.clone(),
                Area::Backups,
                "b.json".into(),
                broken,
                faults
            )
            .await
            .is_err()
        );
        let own = dir.path().join(BACKUPS).join("instance");
        let mut names: Vec<String> = fs::read_dir(&own)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(names, ["a.json"]);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_file_given_another_birth_time_with_its_size_time_and_inode_kept_is_stamped_anew() {
        use std::os::darwin::fs::FileTimesExt as _;

        let dir = TempDir::new().unwrap();
        let path = dir.path().join("p.ndjson.gz");
        fs::write(&path, b"part").unwrap();
        let before = fs::metadata(&path).unwrap();
        File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_times(
                fs::FileTimes::new()
                    .set_modified(before.modified().unwrap())
                    .set_created(SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(86_400)),
            )
            .unwrap();
        let after = fs::metadata(&path).unwrap();
        assert_eq!(
            (after.len(), after.modified().unwrap(), after.ino()),
            (before.len(), before.modified().unwrap(), before.ino())
        );
        assert_ne!(after.created().unwrap(), before.created().unwrap());
        assert_ne!(stamp(&after), stamp(&before));
    }

    #[test]
    fn leftovers_are_cleared_and_never_listed() {
        let dir = TempDir::new().unwrap();
        let folder = opened(dir.path());
        let own = dir.path().join(BACKUPS).join("instance");
        let parts = dir.path().join(PARTS).join("instance");
        fs::create_dir_all(&own).unwrap();
        fs::create_dir_all(&parts).unwrap();
        fs::write(own.join(".x.json.0190.partial"), b"half").unwrap();
        fs::write(own.join("kept.json"), b"whole").unwrap();
        fs::write(parts.join(".p.ndjson.gz.0190.partial"), b"half").unwrap();
        fs::write(parts.join("p.ndjson.gz"), b"part").unwrap();
        let sized = |area| -> Vec<(String, u64)> {
            folder
                .list_in(area, "instance")
                .unwrap()
                .into_iter()
                .map(|(name, size, _)| (name, size))
                .collect()
        };
        assert_eq!(sized(Area::Backups), [("kept.json".into(), 5)]);
        assert_eq!(sized(Area::Parts), [("p.ndjson.gz".into(), 4)]);
        assert_eq!(folder.clear_leftovers().unwrap(), 2);
        assert!(own.join("kept.json").exists());
        assert!(parts.join("p.ndjson.gz").exists());
        assert!(!own.join(".x.json.0190.partial").exists());
        assert!(!parts.join(".p.ndjson.gz.0190.partial").exists());
    }

    #[test]
    fn a_folder_that_went_away_answers_nothing_and_nothing_is_made() {
        let dir = TempDir::new().unwrap();
        let root = dir.path().join("disk");
        fs::create_dir(&root).unwrap();
        let folder = opened(&root);
        fs::remove_dir_all(&root).unwrap();
        assert!(folder.list_in(Area::Backups, "instance").is_err());
        assert!(folder.partial(Area::Backups, "a.json").is_err());
        assert!(folder.partial(Area::Parts, "p.ndjson.gz").is_err());
        assert!(folder.clear_leftovers().is_err());
        assert!(!root.exists());
        fs::create_dir(&root).unwrap();
        assert!(folder.partial(Area::Parts, "p.ndjson.gz").is_err());
        assert!(fs::read_dir(&root).unwrap().next().is_none());
    }

    #[test]
    fn a_folder_inside_the_data_directory_is_refused_however_it_is_written() {
        let dir = TempDir::new().unwrap();
        let data = dir.path().join("data");
        fs::create_dir(&data).unwrap();
        let link = dir.path().join("link");
        std::os::unix::fs::symlink(&data, &link).unwrap();
        for inside in [
            data.clone(),
            data.join("backups"),
            link.join("later/backups"),
        ] {
            assert!(
                outside(&inside, &[("data directory", &data)]).is_err(),
                "{inside:?}"
            );
        }
        assert!(outside(&dir.path().join("elsewhere"), &[("data directory", &data)]).is_ok());
        assert!(outside(&dir.path().join("data2"), &[("data directory", &data)]).is_ok());
    }

    /// A folder at `root` whose files area went unmounted, as `open` takes it.
    fn unmounted_at(root: &Path) -> Arc<Folder> {
        let area = root.join(FILES).join("instance");
        Arc::new(Folder {
            root: root.to_path_buf(),
            instance: "instance".into(),
            files: RwLock::new(Arc::new(Disk::unmounted("old".into(), area.clone()))),
            claim_key: resolved(&area),
            started: SystemTime::now(),
        })
    }

    /// Makes `root`'s files area with a FIFO as its marker, so a claim there waits for a writer.
    fn stalling(root: &Path) -> PathBuf {
        let area = root.join(FILES).join("instance");
        fs::create_dir_all(&area).unwrap();
        let marker = area.join(disk::MARKER);
        assert!(
            std::process::Command::new("mkfifo")
                .arg(&marker)
                .status()
                .unwrap()
                .success()
        );
        marker
    }

    /// Lets the claim waiting on `marker` go on, having written `sent` to it.
    async fn release(marker: &Path, sent: &[u8]) {
        use std::os::unix::fs::OpenOptionsExt as _;
        let mut writer = None;
        for _ in 0..500 {
            // Opening a FIFO's write end without blocking fails until a reader holds it.
            writer = OpenOptions::new()
                .write(true)
                .custom_flags(libc::O_NONBLOCK)
                .open(marker)
                .ok();
            if writer.is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let _ = fs::remove_file(marker);
        if let Some(writer) = writer.as_mut() {
            writer.write_all(sent).unwrap();
        }
    }

    async fn until_ended(folders: &[&Arc<Folder>]) {
        for _ in 0..500 {
            if folders.iter().all(|folder| !folder.claim_unended()) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    /// A claim on a folder at `root` is given up on; a folder at `other` then tries to claim.
    async fn claimed_beside(root: &Path, other: &Path) -> (bool, bool, Arc<Folder>) {
        let marker = stalling(root);
        let (given_up, again) = (unmounted_at(root), unmounted_at(other));
        let late = given_up
            .claim_within("late".into(), Duration::from_millis(50))
            .await;
        assert!(late.is_none(), "the claim did not wait on the marker");
        let held = again.claim_unended();
        let refused = again
            .claim_within("other".into(), Duration::from_millis(50))
            .await
            .is_none();
        // Release the stalled claim before assertions so a failing test can end.
        release(&marker, &[]).await;
        until_ended(&[&given_up, &again]).await;
        assert!(!given_up.claim_unended());
        assert_eq!(fs::read_to_string(&marker).unwrap(), "late");
        assert_eq!(given_up.files().id(), "late");
        (held, refused, again)
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_claim_given_up_on_keeps_any_folder_at_its_area_from_claiming_until_it_ends() {
        let dir = TempDir::new().unwrap();
        // A folder opened again at the same root, as a switch away and back opens one.
        let (held, refused, again) = claimed_beside(dir.path(), dir.path()).await;
        assert!(
            held,
            "a folder at the same area could claim while the first claim ran"
        );
        assert!(refused);
        assert_eq!(again.files().id(), "old");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_claim_given_up_on_keeps_a_folder_named_through_a_link_from_claiming() {
        let dir = TempDir::new().unwrap();
        let root = dir.path().join("disk");
        fs::create_dir(&root).unwrap();
        let link = dir.path().join("link");
        std::os::unix::fs::symlink(&root, &link).unwrap();
        let (held, refused, again) = claimed_beside(&root, &link).await;
        assert!(
            held,
            "a folder named through a link could claim while the first claim ran"
        );
        assert!(refused);
        assert_eq!(again.files().id(), "old");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_claim_given_up_on_that_then_fails_ends_its_claim_and_keeps_its_id_unmounted() {
        let dir = TempDir::new().unwrap();
        let marker = stalling(dir.path());
        let folder = unmounted_at(dir.path());
        let late = folder
            .claim_within("recorded".into(), Duration::from_millis(50))
            .await;
        let held = folder.claim_unended();
        // A marker that is not text fails the claim.
        release(&marker, &[0xff]).await;
        until_ended(&[&folder]).await;

        assert!(late.is_none());
        assert!(held);
        assert!(!folder.claim_unended());
        assert_eq!(folder.files().id(), "recorded");
        assert!(!folder.reachable());
        assert!(matches!(
            folder
                .claim_within("retry".into(), Duration::from_secs(2))
                .await,
            Some(Ok(()))
        ));
        assert_eq!(fs::read_to_string(&marker).unwrap(), "retry");
    }
}
