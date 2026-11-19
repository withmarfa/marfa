//! Blobs: content-addressed bytes, kept in every attached store.

pub mod carry;
mod digests;
pub mod disk;
pub mod folder;
mod hash;
pub mod link;
pub mod range;
pub mod references;
pub mod restore;
mod room;
mod rows;
pub mod s3;
pub mod store;
pub mod upkeep;

use std::fs::File;
use std::future::Future;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use arc_swap::ArcSwap;
use futures_util::StreamExt;
use futures_util::future::join_all;
use serde_json::json;
use uuid::Uuid;

use super::App;
use super::access::{Caller, Permission};
use super::catalog::{self, Snapshot};
use super::faults::{
    FAIL_BLOB_DELETE, FAIL_BLOB_READ, FAIL_BLOB_WRITE, FAIL_STORES_RECORD, FAIL_STORES_RECORD_LOST,
    Faults, HOLD_BLOB_DELETE, HOLD_BLOB_HAS, HOLD_BLOB_READ, HOLD_BLOB_WRITE, HOLD_STORES_RECORD,
    HOLD_STORES_SWAP, Lie,
};
use super::refusal::{Code, Refusal, Result};
use super::unit::Unit;
use super::{housekeeping, provenance, stored};
use crate::db::{Db, Write, io_refusal};
use crate::failure::Failure;
use crate::settings::registry::Snapshot as Settings;
use crate::settings::registry::{BACKUP_PATH, BLOB_MIN_COPIES, DISK_RESERVE_BYTES};
use crate::telemetry::caught;
use disk::{Disk, Place, Staged};
pub use disk::{MARKER, Scratch, lock_blobs};
pub use folder::Folder;
pub use hash::Hash;
pub use restore::stored_size;
pub use room::{Room, bytes_in_words, copy_shortfall, folder_shortfall, room, shortfall};
use rows::Held;
pub use rows::{
    CopyRecord, Lender, OrphanRecord, StoreRecord, find as blob_record, held_in, registered,
};
pub use s3::ObjectStoreSettings;
use s3::{Marker, S3};
pub use store::ByteStream;
use store::{Answer, CHECK_DEADLINE, Failed, Gate, Store};

pub const DEFAULT_TYPE: &str = "application/octet-stream";
const REPLICATE: &str = "blob-replicate";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Blob {
    pub hash: Hash,
    pub mime_type: String,
    pub size_bytes: u64,
}

/// `recorded` counts copies in detached stores too.
#[derive(Debug)]
pub struct Found {
    pub blob: Blob,
    held: Vec<Held>,
    recorded: bool,
}

impl Found {
    /// The object a store holds the blob in, where the copy record names a copy there.
    fn object_in(&self, store: &Store) -> Option<&str> {
        self.held
            .iter()
            .find(|held| held.store_id == store.id())
            .map(|held| held.object.as_str())
    }
}

/// A copy from another store is spooled in `tmp` and removed on `close`.
pub struct Opened {
    file: File,
    spool: Option<Staged>,
}

impl Opened {
    pub fn file(&self) -> &File {
        &self.file
    }

    /// Ends the read, removing a spooled copy. It blocks.
    pub fn close(self) {
        if let Some(spool) = self.spool {
            spool.discard();
        }
    }
}

pub struct Link {
    pub url: String,
    pub ttl_seconds: u64,
}

/// The store beside the disk that backups and file copies go to, as one attachment holds it.
pub enum Kept {
    Bucket { s3: Arc<S3>, prefix: String },
    Folder(Arc<Folder>),
}

/// What the destination settings ask the store beside the disk to be.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Wanted {
    Disk,
    Bucket(ObjectStoreSettings),
    Folder(PathBuf),
    /// A stored setting naming the store that does not read: none is taken until it is set again.
    Unreadable(Vec<&'static str>),
}

impl Wanted {
    pub fn of(settings: &Settings) -> Wanted {
        match ObjectStoreSettings::of(settings) {
            Ok(Some(bucket)) => return Wanted::Bucket(bucket),
            Ok(None) => {}
            Err(keys) => return Wanted::Unreadable(keys),
        }
        if settings.unreadable().contains(&BACKUP_PATH.entry.key) {
            return Wanted::Unreadable(vec![BACKUP_PATH.entry.key]);
        }
        match settings.get(BACKUP_PATH) {
            Some(folder) => Wanted::Folder(PathBuf::from(folder)),
            None => Wanted::Disk,
        }
    }

    /// The kind of backup destination this names, where it names one.
    pub(crate) fn destination_kind(&self) -> Option<&'static str> {
        match self {
            Wanted::Disk => None,
            Wanted::Folder(_) => Some("folder"),
            Wanted::Unreadable(keys) if keys.contains(&BACKUP_PATH.entry.key) => Some("folder"),
            Wanted::Bucket(_) | Wanted::Unreadable(_) => Some("bucket"),
        }
    }
}

/// What the store beside the disk is to be: what the settings name, the instance whose files a
/// backup folder holds, and the folders it must be outside of.
pub struct Beside<'a> {
    pub wanted: Wanted,
    pub instance: &'a str,
    pub kept: Vec<(&'static str, PathBuf)>,
}

/// One attachment keeps a store, its prefix, and its failure consistent.
pub struct Attached {
    wanted: Wanted,
    s3: Option<Arc<S3>>,
    folder: Option<Arc<Folder>>,
    /// Why the store `wanted` names is not attached, in the owner's words.
    trouble: Option<String>,
}

impl Attached {
    /// Why the store the settings name is not attached, in the owner's words.
    pub fn trouble(&self) -> Option<&str> {
        self.trouble.as_deref()
    }

    /// The store backups and file copies go to, where one is attached.
    pub fn kept(&self) -> Option<Kept> {
        match (&self.s3, &self.folder, &self.wanted) {
            (Some(s3), _, Wanted::Bucket(settings)) => Some(Kept::Bucket {
                s3: s3.clone(),
                prefix: settings.prefix.clone(),
            }),
            (None, Some(folder), _) => Some(Kept::Folder(folder.clone())),
            _ => None,
        }
    }

    /// Whether this is the store `wanted` names, and could be used.
    pub(crate) fn is(&self, wanted: &Wanted) -> bool {
        self.wanted == *wanted && self.trouble.is_none()
    }

    /// Lets another server take the backup folder this attachment opened.
    fn let_go(&self) {
        if let Some(folder) = &self.folder {
            folder.let_go();
        }
    }

    /// What the stores record names attached beside the disk: each store's id, kind and locator.
    fn recorded(&self) -> Vec<(String, &'static str, String)> {
        let folder = self.folder.iter().map(|folder| {
            let files = folder.files();
            (
                files.id().to_string(),
                "folder",
                files.root().display().to_string(),
            )
        });
        let s3 = self
            .s3
            .iter()
            .map(|s3| (s3.id().to_string(), "s3", s3.locator().to_string()));
        folder.chain(s3).collect()
    }

    fn troubled(wanted: Wanted, failure: Failure) -> Attached {
        let place = match &wanted {
            Wanted::Folder(_) => "backup folder",
            Wanted::Unreadable(keys) if keys.contains(&BACKUP_PATH.entry.key) => "backup folder",
            _ => "object store",
        };
        let message = failure.message.trim_end_matches('.').to_string();
        Attached {
            wanted,
            s3: None,
            folder: None,
            trouble: Some(format!(
                "{message}. Until the {place} can be used, no file is copied there, no backup is \
                 taken and no file is purged."
            )),
        }
    }
}

pub struct Blobs {
    disk: Arc<Disk>,
    attached: ArcSwap<Attached>,
    /// Whether the start took the blob folder, which it leaves alone while it may be unmounted.
    folder_opened: bool,
    /// One change of store at a time.
    following: tokio::sync::Mutex<()>,
    /// A follow is asked for and has not yet read the settings.
    asked: AtomicBool,
    /// The stores record may not name the store in use. Changed only under `following`.
    record_doubted: AtomicBool,
    /// Reloads of the settings that failed since the last one that published.
    settings_doubted: AtomicU64,
    instance: String,
    /// The folders a backup folder must be outside of, each with what it is.
    kept: Vec<(&'static str, PathBuf)>,
    gate: Arc<Gate>,
    faults: Arc<Faults>,
    signer: link::Signer,
}

fn started(error: impl std::fmt::Display) -> Failure {
    Failure::start(error.to_string())
}

fn folder_missing(root: &Path, why: &str) -> Failure {
    Failure::start(format!(
        "The blob folder {} is missing or holds no store marker, and the copy record names \
         copies there{why}. Mount or restore it, then start again.",
        root.display()
    ))
}

/// With `unfilled`, only a store the server kept copies in may refill the folder.
async fn object_store(
    db: &Db,
    settings: &ObjectStoreSettings,
    unfilled: Option<&Path>,
) -> std::result::Result<S3, Failure> {
    let refused =
        |what: String| Failure::start(format!("The object store {} {what}", settings.locator()));
    let bucket = S3::new(settings, String::new()).map_err(started)?;
    let marker = match tokio::time::timeout(CHECK_DEADLINE, bucket.marker()).await {
        Ok(marker) => marker,
        Err(_) => Marker::Silent(io::Error::new(io::ErrorKind::TimedOut, "no answer in time")),
    };
    let unknown = ", and the object store is not one the server has kept copies in";
    match marker {
        Marker::Id(id) => {
            if let Some(root) = unfilled {
                let named = id.clone();
                let kept_copies = db
                    .read(move |tx| rows::object_store_kept_copies(tx, &named))
                    .await
                    .map_err(started)?;
                if !kept_copies {
                    return Err(folder_missing(root, unknown));
                }
            }
            S3::new(settings, id).map_err(started)
        }
        Marker::None => {
            if let Some(root) = unfilled {
                return Err(folder_missing(root, unknown));
            }
            let s3 = S3::new(settings, Uuid::now_v7().to_string()).map_err(started)?;
            match tokio::time::timeout(CHECK_DEADLINE, s3.mark()).await {
                Ok(Ok(())) => Ok(s3),
                Ok(Err(error)) => Err(refused(format!(
                    "holds no store marker and took none: {}",
                    upkeep::object_store_said(&error)
                ))),
                Err(_) => Err(refused(
                    "holds no store marker and took none in time".to_string(),
                )),
            }
        }
        Marker::Silent(error) => {
            if let Some(root) = unfilled {
                return Err(folder_missing(
                    root,
                    ", and the object store did not answer",
                ));
            }
            let locator = settings.locator();
            let recorded = db
                .read(move |tx| rows::object_store_at(tx, &locator))
                .await
                .map_err(started)?;
            match recorded {
                Some(id) => {
                    tracing::warn!(%error, "The object store did not answer; its copies wait");
                    S3::new(settings, id).map_err(started)
                }
                None => Err(refused(format!(
                    "did not answer: {}",
                    upkeep::object_store_said(&error)
                ))),
            }
        }
        Marker::Refused(error) => {
            tracing::warn!(%error, "The object store did not say which store it is");
            Err(refused(format!(
                "did not say which store it is: {}",
                upkeep::object_store_said(&error)
            )))
        }
    }
}

/// How long a backup folder is given to be looked at and taken.
const FOLDER_DEADLINE: Duration = Duration::from_secs(30);

fn does_not_read(keys: &[&str]) -> Failure {
    Failure::start(format!(
        "The stored {} {}",
        keys.join(", "),
        if keys.len() == 1 {
            "setting does not read"
        } else {
            "settings do not read"
        }
    ))
}

fn client_failed() -> Failure {
    Failure::start("The store's client failed while the store was being opened")
}

/// Takes the store `wanted` names. One that cannot be used, for any reason, is attached as
/// trouble and never refused, so no store setting can keep the server from starting.
async fn attach(
    db: &Db,
    wanted: Wanted,
    instance: &str,
    kept: &[(&'static str, PathBuf)],
) -> Attached {
    match caught(taking(db, wanted.clone(), instance, kept)).await {
        Ok(attached) => attached,
        Err(_) => Attached::troubled(wanted, client_failed()),
    }
}

async fn taking(
    db: &Db,
    wanted: Wanted,
    instance: &str,
    kept: &[(&'static str, PathBuf)],
) -> Attached {
    match &wanted {
        Wanted::Disk => Attached {
            wanted,
            s3: None,
            folder: None,
            trouble: None,
        },
        Wanted::Unreadable(keys) => {
            let failure = does_not_read(keys);
            Attached::troubled(wanted, failure)
        }
        Wanted::Bucket(settings) => match object_store(db, settings, None).await {
            Ok(s3) => Attached {
                s3: Some(Arc::new(s3)),
                wanted,
                folder: None,
                trouble: None,
            },
            Err(failure) => Attached::troubled(wanted, failure),
        },
        Wanted::Folder(root) => {
            let (checked, kept) = (root.clone(), kept.to_vec());
            let taken = async {
                tokio::task::spawn_blocking(move || {
                    let kept: Vec<(&str, &Path)> = kept
                        .iter()
                        .map(|(what, path)| (*what, path.as_path()))
                        .collect();
                    folder::outside(&checked, &kept)
                })
                .await
                .map_err(started)??;
                Folder::open(db, root, instance).await
            };
            match tokio::time::timeout(FOLDER_DEADLINE, taken).await {
                Ok(Ok(opened)) => Attached {
                    folder: Some(Arc::new(opened)),
                    wanted,
                    s3: None,
                    trouble: None,
                },
                Ok(Err(failure)) => Attached::troubled(wanted, failure),
                Err(_) => Attached::troubled(
                    wanted.clone(),
                    Failure::start(format!(
                        "The backup folder {} did not answer in time",
                        root.display()
                    )),
                ),
            }
        }
    }
}

/// An unreadable store setting does not refuse the start: only a running server can correct it.
async fn refilling(db: &Db, wanted: Wanted, root: &Path) -> std::result::Result<Attached, Failure> {
    let failure = match &wanted {
        Wanted::Bucket(settings) => match caught(object_store(db, settings, Some(root))).await {
            Ok(Ok(s3)) => {
                return Ok(Attached {
                    s3: Some(Arc::new(s3)),
                    wanted,
                    folder: None,
                    trouble: None,
                });
            }
            Ok(Err(refused)) => return Err(refused),
            Err(_) => client_failed(),
        },
        Wanted::Unreadable(keys) => does_not_read(keys),
        Wanted::Disk | Wanted::Folder(_) => return Err(folder_missing(root, "")),
    };
    Ok(Attached::troubled(wanted, failure))
}

type StoreRows = Vec<(String, &'static str, String)>;

fn store_rows(disk: &Disk, attached: &Attached) -> StoreRows {
    std::iter::once((
        disk.id().to_string(),
        "disk",
        disk.root().display().to_string(),
    ))
    .chain(attached.recorded())
    .collect()
}

/// Records `rows` as the stores in use, and every other store as detached.
fn write_stores(tx: &rusqlite::Transaction<'_>, rows: &StoreRows, at: &str) -> Result<()> {
    for (id, kind, locator) in rows {
        rows::attach(tx, id, kind, locator, at)?;
    }
    let kept: Vec<&str> = rows.iter().map(|(id, _, _)| id.as_str()).collect();
    rows::detach_others(tx, &kept, at)
}

/// What a record of the stores in use did.
enum Recorded {
    /// Recorded while the settings were at this generation.
    At(u64),
    /// The committed settings name another store, so nothing was written.
    Superseded,
}

impl Blobs {
    /// The folder is changed only once nothing refuses the start; `held` is its lock if taken.
    /// A store beside the disk that cannot be used is reported, not refused, unless the blob
    /// folder is empty and a store whose settings read must refill it. An empty folder the record
    /// names copies in that no store refills is left as it is, since the disk may yet be mounted
    /// there, and the recorded store stays in use.
    pub async fn open(
        db: &Db,
        (root, held): (&Path, Option<File>),
        Beside {
            wanted,
            instance,
            kept,
        }: Beside<'_>,
        secret: &str,
        faults: Arc<Faults>,
        at: String,
    ) -> std::result::Result<Blobs, Failure> {
        let signer = link::Signer::derive(secret).map_err(started)?;
        let folder = root.to_path_buf();
        let found = tokio::task::spawn_blocking(move || Disk::probe(&folder, Place::Blobs))
            .await
            .map_err(started)??;
        let recorded = if found == disk::Found::Marked {
            None
        } else {
            let locator = root.display().to_string();
            db.read(move |tx| rows::disk_with_copies_at(tx, &locator))
                .await
                .map_err(started)?
        };
        let (attached, away) = match recorded {
            Some(id) => {
                let attached = refilling(db, wanted, root).await?;
                let away = attached.trouble.is_some().then_some(id);
                (attached, away)
            }
            None => (attach(db, wanted, instance, &kept).await, None),
        };
        if let Some(trouble) = &attached.trouble {
            tracing::error!("{trouble}");
        }
        let folder_opened = away.is_none();
        let disk = Arc::new(match away {
            Some(id) => Disk::awaiting_blob_folder(id, root.to_path_buf()),
            None => {
                let folder = root.to_path_buf();
                tokio::task::spawn_blocking(move || Disk::open(&folder, Place::Blobs, held))
                    .await
                    .map_err(started)??
            }
        });
        let rows = store_rows(&disk, &attached);
        db.write(Write::own(), move |tx| write_stores(tx, &rows, &at))
            .await
            .map_err(started)?;
        Ok(Blobs {
            disk,
            attached: ArcSwap::from_pointee(attached),
            folder_opened,
            following: tokio::sync::Mutex::new(()),
            asked: AtomicBool::new(false),
            record_doubted: AtomicBool::new(false),
            settings_doubted: AtomicU64::new(0),
            instance: instance.to_string(),
            kept,
            gate: Arc::new(Gate::default()),
            faults,
            signer,
        })
    }

    /// Whether the start took the blob folder as the disk store.
    pub fn folder_opened(&self) -> bool {
        self.folder_opened
    }

    /// Whether the blob folder is there and holds this store's marker. It blocks.
    pub fn folder_reachable(&self) -> bool {
        self.disk.reachable()
    }

    /// Whether the blob folder returned after the start and cannot be locked now. It blocks.
    pub fn folder_unlockable(&self) -> bool {
        self.disk.returned_unlockable()
    }

    /// Whether the store in use is the usable one `wanted` names.
    pub fn follows(&self, wanted: &Wanted) -> bool {
        self.attached.load().is(wanted)
    }

    /// Whether no record failure or failed settings reload remains unresolved.
    pub fn settled(&self) -> bool {
        !self.record_doubted.load(Ordering::SeqCst)
            && self.settings_doubted.load(Ordering::SeqCst) == 0
    }

    /// Marks the live settings as not known, after a change whose reload did not publish.
    pub fn doubt_settings(&self) {
        self.settings_doubted.fetch_add(1, Ordering::SeqCst);
    }

    /// Held while the store in use changes, or while its record is replaced.
    pub(crate) async fn changing(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.following.lock().await
    }

    /// The caller must hold `changing`.
    pub(crate) fn doubt_record(&self) {
        self.record_doubted.store(true, Ordering::SeqCst);
    }

    /// The store beside the disk in use now, to be held to the end of whatever reads it.
    pub fn attachment(&self) -> Arc<Attached> {
        self.attached.load_full()
    }

    /// The attachment in use, if it is of the store `wanted` names.
    pub(crate) fn stores_in_use(&self, wanted: &Wanted) -> Result<Arc<Attached>> {
        let attached = self.attachment();
        if attached.wanted != *wanted {
            return Err(unsettled());
        }
        Ok(attached)
    }

    /// Why the store the settings name is not in use, in the owner's words.
    pub fn trouble(&self) -> Option<String> {
        self.attachment().trouble().map(str::to_string)
    }

    /// How long a store is given to answer.
    pub fn check(&self) -> Duration {
        self.faults.store_check_deadline().unwrap_or(CHECK_DEADLINE)
    }

    /// The object store, where one is in use.
    pub fn s3(&self) -> Option<Arc<S3>> {
        self.attached.load().s3.clone()
    }

    /// The backup folder, where one is in use.
    pub fn folder(&self) -> Option<Arc<Folder>> {
        self.attached.load().folder.clone()
    }

    /// The store backups and file copies go to, where one is in use.
    pub fn kept(&self) -> Option<Kept> {
        self.attached.load().kept()
    }

    /// Lets another server open the blob folder and the backup folder's files area.
    pub fn let_go(&self) {
        self.disk.let_go();
        if let Some(folder) = &self.folder() {
            folder.let_go();
        }
    }

    /// Records the backup folder's files area as the store `id`, forgetting the store `old` and
    /// every copy it records; answers how many copies it forgot.
    pub fn replace_folder_store(
        tx: &rusqlite::Transaction<'_>,
        old: &str,
        id: &str,
        locator: &str,
        at: &str,
    ) -> Result<usize> {
        let forgotten = rows::forget_store(tx, old, at)?;
        rows::attach(tx, id, "folder", locator, at)?;
        Ok(forgotten)
    }

    pub fn check_adoptable(
        tx: &rusqlite::Transaction<'_>,
        app: &App,
        root: &Path,
        old: &str,
    ) -> Result<()> {
        let named = Wanted::of(&app.settings.candidate(&stored::rows(tx)?));
        let recorded = rows::attached_folder(tx)?;
        if named == Wanted::Folder(root.to_path_buf()) && recorded.as_deref() == Some(old) {
            return Ok(());
        }
        Err(Refusal::new(
            Code::Conflict,
            "The backup folder changed while it was being adopted, so nothing was adopted. Try \
             again.",
        ))
    }

    /// The store backups name their files in: the object store or the backup folder.
    pub fn backup_store_id(&self) -> Option<String> {
        let attached = self.attached.load();
        match (&attached.s3, &attached.folder) {
            (Some(s3), _) => Some(s3.id().to_string()),
            (None, Some(folder)) => Some(folder.files().id().to_string()),
            (None, None) => None,
        }
    }

    /// Whether a blob is copied to another store than the disk.
    pub fn replicates(&self) -> bool {
        let attached = self.attached.load();
        attached.s3.is_some() || attached.folder.is_some()
    }

    /// What a blob fault makes `store` read of `hash`; only the disk store is ever faulted.
    pub(crate) fn lie_for(&self, store: &Store, hash: &Hash) -> Option<Lie> {
        match store {
            Store::Disk(_) => self.faults.lie(hash.as_str()),
            Store::Folder(_) | Store::S3(_) => None,
        }
    }

    /// The attached stores, the disk first.
    fn attached(&self) -> Vec<Store> {
        let attached = self.attached.load();
        std::iter::once(Store::Disk(self.disk.clone()))
            .chain(
                attached
                    .folder
                    .iter()
                    .map(|folder| Store::Folder(folder.files().clone())),
            )
            .chain(attached.s3.iter().map(|s3| Store::S3(s3.clone())))
            .collect()
    }

    fn store(&self, id: &str) -> Option<Store> {
        self.attached().into_iter().find(|store| store.id() == id)
    }

    /// Object-store confirmations require the writer's store id.
    async fn answer_of(
        &self,
        store: &Store,
        hash: &Hash,
        object: &str,
    ) -> std::result::Result<Answer, Failed> {
        let asked = async {
            self.faults.hold(HOLD_BLOB_HAS, None).await;
            match store {
                Store::Disk(disk) | Store::Folder(disk) => {
                    match self.lie_for(store, hash) {
                        Some(Lie::Lost) => return Ok(Answer::Missing),
                        Some(Lie::Unreadable) => return Err(store::unreadable()),
                        Some(Lie::Damaged) | None => {}
                    }
                    let (disk, hash) = (disk.clone(), hash.clone());
                    let size = tokio::task::spawn_blocking(move || disk.size_of(&hash))
                        .await
                        .map_err(io::Error::other)??;
                    Ok(size.map_or(Answer::Missing, Answer::Holds))
                }
                Store::S3(s3) => s3.answer_for(object).await,
            }
        };
        match tokio::time::timeout(self.check(), asked).await {
            Ok(answer) => answer.map_err(Failed::Io),
            Err(_) => Err(Failed::Late),
        }
    }

    /// Opens a window of a blob's bytes, which the store must begin to answer in time.
    async fn open_bytes(
        &self,
        store: &Store,
        hash: &Hash,
        object: &str,
        first: u64,
        length: u64,
    ) -> std::result::Result<ByteStream, Failed> {
        let opened = async {
            self.faults.hold(HOLD_BLOB_READ, None).await;
            if self.faults.fail(FAIL_BLOB_READ, None) {
                return Err(io::Error::other("the store failed the read"));
            }
            match store {
                Store::Disk(disk) | Store::Folder(disk) => {
                    let lie = self.lie_for(store, hash);
                    match lie {
                        Some(Lie::Lost) => return Err(io::ErrorKind::NotFound.into()),
                        Some(Lie::Unreadable) => return Err(store::unreadable()),
                        Some(Lie::Damaged) | None => {}
                    }
                    let (disk, hash) = (disk.clone(), hash.clone());
                    let file = tokio::task::spawn_blocking(move || disk.open_blob(&hash))
                        .await
                        .map_err(io::Error::other)??;
                    let bytes = store::file_stream(file, first, length);
                    if lie == Some(Lie::Damaged) && first == 0 {
                        return Ok(store::first_byte_changed(bytes));
                    }
                    Ok(bytes)
                }
                Store::S3(s3) => s3.read(object, first, length).await,
            }
        };
        match tokio::time::timeout(self.check(), opened).await {
            Ok(answer) => answer.map_err(Failed::Io),
            Err(_) => Err(Failed::Late),
        }
    }

    /// Opens the disk store's copy as a file, which the store must begin to answer in time.
    async fn open_file(&self, disk: &Arc<Disk>, hash: &Hash) -> std::result::Result<File, Failed> {
        let opened = async {
            self.faults.hold(HOLD_BLOB_READ, None).await;
            if self.faults.fail(FAIL_BLOB_READ, None) {
                return Err(io::Error::other("the store failed the read"));
            }
            match self.faults.lie(hash.as_str()) {
                Some(Lie::Lost) => return Err(io::ErrorKind::NotFound.into()),
                Some(Lie::Unreadable) => return Err(store::unreadable()),
                Some(Lie::Damaged) | None => {}
            }
            let (disk, hash) = (disk.clone(), hash.clone());
            tokio::task::spawn_blocking(move || disk.open_blob(&hash))
                .await
                .map_err(io::Error::other)?
        };
        match tokio::time::timeout(self.check(), opened).await {
            Ok(answer) => answer.map_err(Failed::Io),
            Err(_) => Err(Failed::Late),
        }
    }

    /// Kept only if the spooled bytes hash to the blob's name.
    async fn spool(
        &self,
        store: &Store,
        blob: &Blob,
        object: &str,
    ) -> std::result::Result<Opened, Failed> {
        let (hash, size) = (blob.hash.clone(), blob.size_bytes);
        let bytes = self.open_bytes(store, &hash, object, 0, size).await?;
        let mut bytes = store::idle_limited(bytes, self.check());
        let disk = self.disk.clone();
        let spooled = async move {
            let mut staged = tokio::task::spawn_blocking(move || disk.stage())
                .await
                .map_err(io::Error::other)??;
            while let Some(chunk) = bytes.next().await {
                let chunk = chunk?;
                if staged.size().saturating_add(chunk.len() as u64) > size {
                    return Err(store::not_the_blob());
                }
                staged =
                    tokio::task::spawn_blocking(move || staged.append(&chunk).map(|()| staged))
                        .await
                        .map_err(io::Error::other)??;
            }
            tokio::task::spawn_blocking(move || {
                if staged.seal()? != hash || staged.size() != size {
                    return Err(store::not_the_blob());
                }
                let file = staged.reopen()?;
                Ok(Opened {
                    file,
                    spool: Some(staged),
                })
            })
            .await
            .map_err(io::Error::other)?
        };
        let limit = store::stall_limit(store::write_deadline(self.check(), size));
        store::within(limit, spooled).await.map_err(Failed::Io)
    }

    /// Fails as a read would, but reads no bytes.
    async fn answers_for(
        &self,
        store: &Store,
        hash: &Hash,
        object: &str,
    ) -> std::result::Result<(), Failed> {
        let asked = async {
            self.faults.hold(HOLD_BLOB_READ, None).await;
            if self.faults.fail(FAIL_BLOB_READ, None) {
                return Err(io::Error::other("the store failed the read"));
            }
            let size = match store {
                Store::Disk(disk) | Store::Folder(disk) => {
                    match self.lie_for(store, hash) {
                        Some(Lie::Lost) => return Err(io::ErrorKind::NotFound.into()),
                        Some(Lie::Unreadable) => return Err(store::unreadable()),
                        Some(Lie::Damaged) | None => {}
                    }
                    let (disk, hash) = (disk.clone(), hash.clone());
                    tokio::task::spawn_blocking(move || disk.size_of(&hash))
                        .await
                        .map_err(io::Error::other)??
                }
                Store::S3(s3) => s3.size_of(object).await?,
            };
            size.map(|_| ())
                .ok_or_else(|| io::ErrorKind::NotFound.into())
        };
        match tokio::time::timeout(self.check(), asked).await {
            Ok(answer) => answer.map_err(Failed::Io),
            Err(_) => Err(Failed::Late),
        }
    }

    /// Whether the store holds any bytes of the blob, and whether any are intact.
    async fn holding(&self, store: &Store, hash: &Hash) -> (bool, bool) {
        let asked = async {
            match store {
                Store::Disk(disk) | Store::Folder(disk) => {
                    let (disk, hash) = (disk.clone(), hash.clone());
                    let read = tokio::task::spawn_blocking(move || {
                        disk.rehash(&hash, false)
                            .map(|found| found.map(|(_, found)| found == hash))
                    });
                    read.await.map_err(io::Error::other)?
                }
                Store::S3(s3) => {
                    let objects = s3.objects_of(hash).await?;
                    if objects.is_empty() {
                        return Ok(None);
                    }
                    for (object, size) in objects {
                        let mut bytes = s3.read(&object, 0, size).await?;
                        let mut hasher = store::Hasher::default();
                        while let Some(chunk) = bytes.next().await {
                            hasher.update(&chunk?);
                        }
                        if hasher.matches(hash, size).is_ok() {
                            return Ok(Some(true));
                        }
                    }
                    Ok(Some(false))
                }
            }
        };
        match tokio::time::timeout(self.check(), asked).await {
            Ok(Ok(Some(intact))) => (true, intact),
            Ok(Ok(None)) => (false, false),
            Ok(Err(error)) => {
                tracing::warn!(%error, store = store.kind(), "A store did not say what it holds");
                (false, false)
            }
            Err(_) => (false, false),
        }
    }

    /// Whether the store answers with its own marker.
    async fn is_itself(&self, store: &Store) -> bool {
        let s3 = match store {
            Store::Disk(_) => return true,
            Store::Folder(disk) => {
                let disk = disk.clone();
                return tokio::task::spawn_blocking(move || disk.reachable())
                    .await
                    .unwrap_or(false);
            }
            Store::S3(s3) => s3,
        };
        let answer = match tokio::time::timeout(self.check(), s3.is_itself()).await {
            Ok(answer) => answer,
            Err(_) => Err(io::Error::new(io::ErrorKind::TimedOut, "no answer in time")),
        };
        match answer {
            Ok(()) => true,
            Err(error) => {
                tracing::warn!(%error, "The object store did not answer as itself; nothing is struck there");
                false
            }
        }
    }

    /// Writes a blob's bytes to a store on a task that outlasts the wait for it.
    async fn writing<W>(&self, hash: &Hash, size: u64, work: W) -> std::result::Result<(), Failed>
    where
        W: Future<Output = io::Result<()>> + Send + 'static,
    {
        let faults = self.faults.clone();
        let deadline = store::write_deadline(self.check(), size);
        self.gate
            .outlast(hash, deadline, async move {
                faults.hold(HOLD_BLOB_WRITE, None).await;
                if faults.fail(FAIL_BLOB_WRITE, None) {
                    return Err(io::ErrorKind::StorageFull.into());
                }
                work.await
            })
            .await
    }

    /// Runs on a task that outlasts the wait for it.
    async fn delete(
        &self,
        store: &Store,
        hash: &Hash,
        object: &str,
    ) -> std::result::Result<(), Failed> {
        let (faults, store, blob) = (self.faults.clone(), store.clone(), hash.clone());
        let object = object.to_string();
        let deadline = self.check();
        self.gate
            .outlast(hash, deadline, async move {
                faults.hold(HOLD_BLOB_DELETE, None).await;
                if faults.fail(FAIL_BLOB_DELETE, None) {
                    return Err(io::Error::other("the store failed the delete"));
                }
                match store {
                    Store::Disk(disk) => {
                        let gone = blob.clone();
                        tokio::task::spawn_blocking(move || disk.delete(&gone))
                            .await
                            .map_err(io::Error::other)??;
                        faults.heal(blob.as_str(), false);
                        Ok(())
                    }
                    Store::Folder(disk) => tokio::task::spawn_blocking(move || disk.delete(&blob))
                        .await
                        .map_err(io::Error::other)?,
                    Store::S3(s3) => {
                        store::within(store::stall_limit(deadline), s3.delete(&object)).await
                    }
                }
            })
            .await
    }
}

fn not_found() -> Refusal {
    Refusal::new(Code::BlobNotFound, "Blob not found")
}

fn copy_not_found() -> Refusal {
    Refusal::new(
        Code::BlobCopyNotFound,
        "No attached store with that id holds a copy of this blob.",
    )
}

fn held_by_backup() -> Refusal {
    Refusal::new(
        Code::CopyHeldByBackup,
        "A backup kept in this object store names the blob, so its copy there stays until \
         thinning deletes every such backup.",
    )
}

/// Refuses the drop of a copy in `store_id` that a backup kept there names.
fn keep_held(tx: &rusqlite::Transaction<'_>, hash: &Hash, store_id: &str) -> Result<()> {
    if crate::app::backups::held(tx, store_id, std::slice::from_ref(hash))?.is_empty() {
        Ok(())
    } else {
        Err(held_by_backup())
    }
}

/// The copies but the one in `store_id` that count toward the minimum: those this server wrote.
fn own_others(holders: &[rows::Held], store_id: &str) -> usize {
    holders
        .iter()
        .filter(|held| held.store_id != store_id && held.written)
        .count()
}

fn below(live: usize, min_copies: u64) -> Refusal {
    Refusal::new(
        Code::CopiesBelowMinimum,
        "Dropping this copy would leave fewer copies than the instance keeps.",
    )
    .with_detail("live", live)
    .with_detail("min_copies", min_copies)
}

fn unrecorded() -> Refusal {
    Refusal::new(
        Code::BlobStoreUnavailable,
        "The store the settings name could not be recorded as in use, so the server kept the one \
         it had; try again.",
    )
}

pub(crate) fn unsettled() -> Refusal {
    Refusal::new(
        Code::BlobStoreUnavailable,
        "The stores in use are not known to be the ones the settings name; try again.",
    )
}

fn unavailable() -> Refusal {
    Refusal::new(
        Code::BlobStoreUnavailable,
        "The blob store did not answer; try again later.",
    )
}

fn insufficient() -> Refusal {
    Refusal::new(
        Code::InsufficientStorage,
        "The volume the blobs are kept on has no room.",
    )
}

/// What a backup or export is told when the blob folder cannot take its working files.
pub const WORKING_FILES_REFUSED: &str =
    "The blob folder cannot take working files now; try again later.";

/// `507` for a write that met a volume with no room.
pub fn out_of_room(error: &io::Error) -> Option<Refusal> {
    matches!(
        error.kind(),
        io::ErrorKind::StorageFull | io::ErrorKind::QuotaExceeded
    )
    .then(insufficient)
}

/// A write that ran out of room is `507`; any other failure is the store's.
fn unwritable(error: io::Error) -> Refusal {
    if let Some(refusal) = out_of_room(&error) {
        return refusal;
    }
    tracing::error!(%error, "A blob write failed");
    unavailable()
}

/// `unwritable` for a working file, which says the blob folder is what refused.
fn no_working_file(error: io::Error) -> Refusal {
    if let Some(refusal) = out_of_room(&error) {
        return refusal;
    }
    tracing::error!(%error, "A working file was not made");
    Refusal::new(Code::BlobStoreUnavailable, WORKING_FILES_REFUSED)
}

fn joined<T>(outcome: std::result::Result<T, tokio::task::JoinError>) -> Result<T> {
    outcome.map_err(|error| Refusal::internal(&format!("a blob task did not finish: {error}")))
}

/// A disconnected caller abandons its wait without cancelling the work.
async fn owned<T: Send + 'static>(
    work: impl Future<Output = Result<T>> + Send + 'static,
) -> Result<T> {
    joined(tokio::spawn(provenance::carried(work)).await)?
}

fn failed(refused: Refusal) -> Failed {
    Failed::Io(io::Error::other(refused))
}

/// The database's refusal a failure carries, as `failed` keeps it.
fn refusal_in(failure: &Failed) -> Option<Refusal> {
    match failure {
        Failed::Io(error) => error.get_ref()?.downcast_ref::<Refusal>().cloned(),
        Failed::Late => None,
    }
}

/// Bytes on the disk that no record names yet, locked against deletion until it is dropped, once the record's write has ended.
struct Placed {
    recording: Recording,
    _held: store::Held,
}

#[derive(Clone)]
pub struct Recording {
    blob: Blob,
    store_id: String,
    replicates: bool,
}

impl Recording {
    /// Records the blob and its copy, and the uploader's proof where there is one.
    pub fn record(
        &self,
        tx: &rusqlite::Transaction<'_>,
        holder: Option<&str>,
        at: &str,
    ) -> Result<Blob> {
        let recorded = rows::record_upload(tx, &self.blob, &self.store_id, holder, at)?;
        rows::deleted(tx, &self.blob.hash, &self.store_id, "")?;
        if self.replicates {
            housekeeping::bring_forward(tx, REPLICATE, at)?;
        }
        Ok(recorded)
    }
}

/// An upload that is arriving. Its file goes when this does, unless `place_upload` placed it.
pub struct Intake {
    staged: Option<Staged>,
    disk: Arc<Disk>,
    faults: Arc<Faults>,
    reserve: u64,
    mime_type: String,
}

impl Intake {
    /// Removes the file on a blocking task, so that when this returns it is gone.
    pub async fn discard(mut self) {
        if let Some(staged) = self.staged.take() {
            let _ = tokio::task::spawn_blocking(move || staged.discard()).await;
        }
    }

    pub async fn push(&mut self, bytes: impl AsRef<[u8]> + Send + 'static) -> Result<()> {
        let Some(mut staged) = self.staged.take() else {
            return Err(Refusal::internal("an upload was pushed after it finished"));
        };
        let (faults, disk, reserve) = (self.faults.clone(), self.disk.clone(), self.reserve);
        let (staged, outcome) = joined(
            tokio::task::spawn_blocking(move || {
                let outcome = room(&faults, disk.root(), reserve, 0)
                    .and_then(|()| staged.append(bytes.as_ref()).map_err(unwritable));
                (staged, outcome)
            })
            .await,
        )?;
        self.staged = Some(staged);
        outcome
    }
}

/// Whether a follow tries again to take a store the settings name that could not be used.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Retry {
    Trouble,
    /// Only brings the store in use and its record to the committed settings.
    Settle,
}

impl App {
    /// A queued follow covers requests made before it reads the settings.
    pub fn ask_stores_to_follow(self: &Arc<App>) {
        if !self.blobs.asked.swap(true, Ordering::SeqCst) {
            let app = self.clone();
            tokio::spawn(async move {
                let _ = app.follow_stores(Retry::Trouble).await;
            });
        }
    }

    /// Reads the live settings again if a reload failed, then follows the committed settings.
    /// Fails while a reload has not published since the last one that failed.
    pub async fn settle_stores(self: &Arc<App>, retry: Retry) -> Result<()> {
        let doubted = self.blobs.settings_doubted.load(Ordering::SeqCst);
        if doubted > 0 && stored::reload(self).await {
            let _ = self.blobs.settings_doubted.compare_exchange(
                doubted,
                0,
                Ordering::SeqCst,
                Ordering::SeqCst,
            );
        }
        self.follow_stores(retry).await?;
        if self.blobs.settings_doubted.load(Ordering::SeqCst) > 0 {
            return Err(Refusal::new(
                Code::BlobStoreUnavailable,
                "The settings could not be read again after a change of them whose outcome is \
                 not known.",
            ));
        }
        Ok(())
    }

    /// The store the committed settings name beside the disk.
    async fn named_store(self: &Arc<App>) -> Result<Wanted> {
        let rows = self.db.read(stored::rows).await?;
        Ok(Wanted::of(&self.settings.candidate(&rows)))
    }

    /// Records `attached` as the stores in use, unless the committed settings name another.
    async fn record_stores(self: &Arc<App>, attached: &Attached) -> Result<Recorded> {
        self.faults.hold(HOLD_STORES_RECORD, None).await;
        let (app, wanted) = (self.clone(), attached.wanted.clone());
        let (rows, at) = (store_rows(&self.blobs.disk, attached), self.clock.stamp());
        let recorded = self
            .db
            .write(Write::own(), move |tx| {
                let named = Wanted::of(&app.settings.candidate(&stored::rows(tx)?));
                if named != wanted {
                    return Ok(Recorded::Superseded);
                }
                let generation = app.settings.generation();
                write_stores(tx, &rows, &at)?;
                if app.faults.fail(FAIL_STORES_RECORD, None) {
                    return Err(io_refusal());
                }
                Ok(Recorded::At(generation))
            })
            .await?;
        if matches!(recorded, Recorded::At(_)) && self.faults.fail(FAIL_STORES_RECORD_LOST, None) {
            return Err(Refusal {
                commit_failed: true,
                ..io_refusal()
            });
        }
        Ok(recorded)
    }

    /// An adopt may have recorded a new ID without finishing its claim on the folder.
    pub(crate) async fn retake_folder(&self, folder: &Arc<Folder>) -> Result<()> {
        let deadline = self.blobs.check();
        let late = || {
            Refusal::new(
                Code::BlobStoreUnavailable,
                format!(
                    "The backup folder {} did not answer in time, so the store it holds is not \
                     known. Check that its disk is mounted and answering, then try again.",
                    folder.root().display()
                ),
            )
        };
        if folder.claim_unended() {
            return Err(late());
        }
        let looked = folder.clone();
        let reachable = tokio::time::timeout(
            deadline,
            tokio::task::spawn_blocking(move || looked.reachable()),
        )
        .await
        .map_err(|_| late())?;
        if joined(reachable)? {
            return Ok(());
        }
        let files = folder.files();
        let locator = files.root().display().to_string();
        let recorded = self
            .db
            .read(move |tx| rows::folder_at(tx, &locator))
            .await?;
        let Some(id) = recorded.filter(|id| id != files.id()) else {
            return Ok(());
        };
        match folder.claim_within(id, deadline).await {
            None => Err(late()),
            Some(Ok(())) => Ok(()),
            Some(Err(error)) => {
                tracing::warn!(%error, "The backup folder could not take the store the record names");
                Ok(())
            }
        }
    }

    /// Its own task keeps cancellation from separating the record and swap.
    async fn follow(self: &Arc<App>, retry: Retry) -> Result<()> {
        let blobs = &self.blobs;
        let _one = blobs.following.lock().await;
        blobs.asked.store(false, Ordering::SeqCst);
        let mut tried: Option<Wanted> = None;
        let mut kept: Option<Arc<Attached>> = None;
        loop {
            let wanted = match self.named_store().await {
                Ok(wanted) => wanted,
                Err(refused) => {
                    if let Some(next) = kept.take() {
                        next.let_go();
                    }
                    blobs.doubt_record();
                    tracing::error!(%refused, "The settings could not be read to follow them");
                    return Err(unrecorded());
                }
            };
            if let Some(stale) = kept.take_if(|next| next.wanted != wanted) {
                stale.let_go();
            }
            let current = blobs.attached.load_full();
            let next = match kept.take() {
                Some(next) => next,
                None if current.wanted == wanted
                    && (current.trouble.is_none()
                        || retry == Retry::Settle
                        || tried.as_ref() == Some(&wanted)) =>
                {
                    if !blobs.record_doubted.load(Ordering::SeqCst) {
                        return Ok(());
                    }
                    if let Some(folder) = &current.folder
                        && let Err(refused) = self.retake_folder(folder).await
                    {
                        tracing::error!(%refused, "The backup folder in use could not be checked against its record");
                        return Err(unrecorded());
                    }
                    match self.record_stores(&current).await {
                        Ok(Recorded::At(_)) => blobs.record_doubted.store(false, Ordering::SeqCst),
                        Ok(Recorded::Superseded) => {}
                        Err(refused) => {
                            tracing::error!(%refused, "The stores in use could not be recorded");
                            return Err(unrecorded());
                        }
                    }
                    continue;
                }
                None => {
                    tried = Some(wanted.clone());
                    Arc::new(attach(&self.db, wanted, &blobs.instance, &blobs.kept).await)
                }
            };
            let generation = match self.record_stores(&next).await {
                Ok(Recorded::At(generation)) => generation,
                Ok(Recorded::Superseded) => {
                    next.let_go();
                    continue;
                }
                Err(refused) => {
                    next.let_go();
                    blobs.doubt_record();
                    tracing::error!(%refused, "The stores in use could not be recorded; the old ones stay");
                    return Err(unrecorded());
                }
            };
            self.faults.hold(HOLD_STORES_SWAP, None).await;
            let swapped = self
                .settings
                .unless_staged(generation, || blobs.attached.swap(next.clone()));
            let Some(old) = swapped else {
                // A change staged after the record may name another store; it is read again.
                blobs.doubt_record();
                kept = Some(next);
                continue;
            };
            blobs.record_doubted.store(false, Ordering::SeqCst);
            match &next.trouble {
                Some(trouble) => tracing::error!("{trouble}"),
                None => tracing::info!("The store beside the disk follows the settings"),
            }
            old.let_go();
        }
    }

    /// Follows the committed settings on a task of its own, and waits for it.
    pub async fn follow_stores(self: &Arc<App>, retry: Retry) -> Result<()> {
        let app = self.clone();
        joined(tokio::spawn(async move { app.follow(retry).await }).await)?
    }

    /// Whether the caller may upload, on the types registered now.
    pub async fn check_upload(&self, caller: &Caller) -> Result<()> {
        let cache = self.catalog_handle();
        let catalog = self
            .db
            .read(move |tx| catalog::current(&cache, tx, Snapshot::Committed))
            .await?;
        caller.require_upload(catalog.provenance.keys().map(String::as_str))
    }

    /// Refuses a body declared too large for the room, then opens a file for it.
    pub async fn begin_upload(&self, declared: Option<u64>, mime_type: String) -> Result<Intake> {
        let reserve = self.settings.live().get(DISK_RESERVE_BYTES);
        let disk = self.blobs.disk.clone();
        let faults = self.faults.clone();
        joined(
            tokio::task::spawn_blocking(move || {
                room(&faults, disk.root(), reserve, declared.unwrap_or(0))?;
                let staged = disk.stage().map_err(unwritable)?;
                Ok(Intake {
                    staged: Some(staged),
                    disk,
                    faults,
                    reserve,
                    mime_type,
                })
            })
            .await,
        )?
    }

    pub fn upload_idle(&self) -> Duration {
        self.settings.start.tuning.upload_idle
    }

    pub fn room(&self) -> Room {
        Room::new(
            self.faults.clone(),
            self.blobs.disk.root().to_path_buf(),
            self.settings.live().get(DISK_RESERVE_BYTES),
        )
    }

    pub fn blob_read_idle(&self) -> Duration {
        self.settings.start.tuning.blob_read_idle
    }

    /// A restore keeps its blob locks until commit, so waiting writers must hear its refusal.
    pub(crate) async fn lock_to_write(&self, hash: &Hash) -> Result<store::Held> {
        tokio::select! {
            biased;
            refusal = self.db.writes_refusing() => Err(refusal),
            held = self.blobs.gate.lock(hash) => Ok(held),
        }
    }

    /// A refusal is answered only once the staged file is gone.
    async fn place_upload(&self, mut intake: Intake) -> Result<Placed> {
        let Some(staged) = intake.staged.take() else {
            return Err(Refusal::internal("an upload finished twice"));
        };
        let spooled = staged.path().to_path_buf();
        let placed = self.place_staged(staged, &intake.mime_type).await;
        if placed.is_err() {
            let _ = tokio::task::spawn_blocking(move || disk::unspool(&spooled)).await;
        }
        placed
    }

    async fn place_staged(&self, staged: Staged, mime_type: &str) -> Result<Placed> {
        if staged.size() == 0 {
            return Err(
                Refusal::validation("The body is empty; send the bytes to keep.")
                    .with_detail("field", "body"),
            );
        }
        let mut staged = staged;
        let (staged, hash) = joined(
            tokio::task::spawn_blocking(move || staged.seal().map(|hash| (staged, hash))).await,
        )?
        .map_err(unwritable)?;
        let size = staged.size();
        let held = self.lock_to_write(&hash).await?;
        if self.blobs.gate.unfinished(&hash) {
            return Err(unavailable());
        }
        let disk = Store::Disk(self.blobs.disk.clone());
        if let Err(failure) = self.finish_deletion(&disk, &hash).await {
            tracing::warn!(
                ?failure,
                "A queued deletion of an upload's bytes did not finish"
            );
            return Err(refusal_in(&failure).unwrap_or_else(unavailable));
        }
        let (queued, at) = (hash.clone(), self.clock.stamp());
        let disk_id = self.blobs.disk.id().to_string();
        self.db
            .write(Write::own(), move |tx| {
                rows::queue_deletion(tx, &queued, &disk_id, "", &at)
            })
            .await?;
        let (target, placed, faults) = (self.blobs.disk.clone(), hash.clone(), self.faults.clone());
        let mut staged = staged;
        self.blobs
            .writing(&hash, size, async move {
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
            })?;
        Ok(Placed {
            recording: Recording {
                blob: Blob {
                    hash,
                    mime_type: mime_type.to_string(),
                    size_bytes: size,
                },
                store_id: self.blobs.disk.id().to_string(),
                replicates: self.blobs.replicates(),
            },
            _held: held,
        })
    }

    /// Holds the blob lock through the record's commit, even if the caller disconnects.
    pub async fn keep_upload<T, F>(
        self: &Arc<App>,
        caller: &Caller,
        action: &'static str,
        intake: Intake,
        job: F,
    ) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&Unit<'_, '_>, &Recording) -> Result<T> + Send + 'static,
    {
        let (app, caller) = (self.clone(), caller.clone());
        owned(async move {
            let placed = app.place_upload(intake).await?;
            let recording = placed.recording.clone();
            let written = app
                .write(&caller, action, move |unit| job(unit, &recording))
                .await;
            drop(placed);
            written
        })
        .await
    }

    pub async fn finish_upload(self: &Arc<App>, caller: &Caller, intake: Intake) -> Result<Blob> {
        let cache = self.catalog_handle();
        self.keep_upload(caller, "blob.upload", intake, move |unit, recording| {
            let catalog = catalog::current(&cache, unit.tx(), Snapshot::Pending)?;
            unit.caller
                .require_upload(catalog.provenance.keys().map(String::as_str))?;
            let holder = unit.caller.credential_handle();
            let blob = recording.record(unit.tx(), Some(&holder), &unit.at)?;
            unit.audit(
                "blob",
                blob.hash.as_str(),
                Some(json!({ "mime_type": blob.mime_type, "size_bytes": blob.size_bytes })),
            )?;
            Ok(blob)
        })
        .await
    }

    /// The caller holds the blob's lock.
    async fn finish_deletion(&self, store: &Store, hash: &Hash) -> std::result::Result<(), Failed> {
        let (blob, id) = (hash.clone(), store.id().to_string());
        let queued = self
            .db
            .read(move |tx| rows::deletion(tx, &blob, &id))
            .await
            .map_err(failed)?;
        for (object, recorded) in queued {
            let outcome = if recorded {
                Ok(())
            } else {
                self.blobs.delete(store, hash, &object).await
            };
            let (blob, id, gone) = (hash.clone(), store.id().to_string(), object.clone());
            let error = match &outcome {
                Ok(()) => None,
                Err(Failed::Late) => {
                    Some("the store did not finish the delete in time".to_string())
                }
                Err(Failed::Io(error)) => Some(error.to_string()),
            };
            self.db
                .write(Write::own(), move |tx| match &error {
                    None => rows::deleted(tx, &blob, &id, &gone),
                    Some(error) => rows::deletion_failed(tx, &blob, &id, &gone, error),
                })
                .await
                .map_err(failed)?;
            outcome?;
        }
        Ok(())
    }

    /// A blob held in the store, by a caller's right to read it where one is given.
    pub(crate) fn found_in(
        tx: &rusqlite::Transaction<'_>,
        caller: Option<&Caller>,
        hash: &Hash,
    ) -> Result<Found> {
        let Some(blob) = rows::find(tx, hash)? else {
            return Err(not_found());
        };
        if let Some(caller) = caller
            && !caller.may_read_blob(rows::lenders(tx, hash))?
        {
            return Err(not_found());
        }
        let recorded = !rows::copies(tx, hash)?.is_empty();
        let held = rows::holders(tx, hash)?;
        Ok(Found {
            blob,
            held,
            recorded,
        })
    }

    /// Whether an attached store records a copy of the blob.
    pub(crate) fn copy_recorded(tx: &rusqlite::Transaction<'_>, hash: &Hash) -> Result<bool> {
        Ok(!rows::holders(tx, hash)?.is_empty())
    }

    /// For the test hooks: what each store holds, past every blob fault.
    pub async fn inspect_stores(&self, hash: Option<&str>) -> Result<serde_json::Value> {
        let hash = hash.map(Hash::parse).transpose()?;
        let mut stores = Vec::new();
        for store in self.blobs.attached() {
            let (holds, intact) = match &hash {
                Some(hash) => self.blobs.holding(&store, hash).await,
                None => (false, false),
            };
            stores.push(json!({
                "id": store.id(),
                "kind": store.kind(),
                "holds": holds,
                "intact": intact,
            }));
        }
        let disk = self.blobs.disk.clone();
        let spool = joined(tokio::task::spawn_blocking(move || disk.spool()).await)?
            .map_err(|error| Refusal::internal(&error.to_string()))?;
        let spool: Vec<_> = spool
            .into_iter()
            .map(|(name, size)| json!({ "name": name, "size": size }))
            .collect();
        Ok(json!({ "stores": stores, "spool": spool }))
    }

    /// A blob the caller may read; one it may not read is answered as an unknown one.
    pub async fn find_blob(&self, caller: &Caller, hash: &Hash) -> Result<Found> {
        let (caller, hash) = (caller.clone(), hash.clone());
        self.db
            .read(move |tx| App::found_in(tx, Some(&caller), &hash))
            .await
    }

    /// A copy only in a detached or silent store is a store that failed, not an unknown blob.
    pub async fn bytes_of(&self, found: &Found, first: u64, length: u64) -> Result<ByteStream> {
        if !found.recorded {
            return Err(not_found());
        }
        for store in self.blobs.attached() {
            let Some(object) = found.object_in(&store) else {
                continue;
            };
            match self
                .blobs
                .open_bytes(&store, &found.blob.hash, object, first, length)
                .await
            {
                Ok(bytes) => return Ok(bytes),
                Err(failure) => {
                    tracing::warn!(
                        store = store.kind(),
                        ?failure,
                        "A store did not open a blob"
                    );
                }
            }
        }
        Err(unavailable())
    }

    /// Answers as `bytes_of` would, without reading the bytes.
    pub async fn check_bytes(&self, found: &Found) -> Result<()> {
        if !found.recorded {
            return Err(not_found());
        }
        for store in self.blobs.attached() {
            let Some(object) = found.object_in(&store) else {
                continue;
            };
            match self
                .blobs
                .answers_for(&store, &found.blob.hash, object)
                .await
            {
                Ok(()) => return Ok(()),
                Err(failure) => {
                    tracing::warn!(
                        store = store.kind(),
                        ?failure,
                        "A store did not answer for a blob"
                    );
                }
            }
        }
        Err(unavailable())
    }

    /// `None` when no attached store holds a copy.
    pub async fn open_held(&self, hash: &Hash) -> Result<Option<(Opened, Blob)>> {
        let looked = hash.clone();
        let found = self
            .db
            .read(move |tx| {
                if rows::find(tx, &looked)?.is_none() {
                    return Ok(None);
                }
                App::found_in(tx, None, &looked).map(Some)
            })
            .await?;
        let Some(found) = found.filter(|found| !found.held.is_empty()) else {
            return Ok(None);
        };
        let hash = &found.blob.hash;
        for store in self.blobs.attached() {
            let Some(object) = found.object_in(&store) else {
                continue;
            };
            let opened = match &store {
                Store::Disk(disk) if self.faults.lie(hash.as_str()) != Some(Lie::Damaged) => self
                    .blobs
                    .open_file(disk, hash)
                    .await
                    .map(|file| Opened { file, spool: None }),
                _ => {
                    let reserve = self.settings.live().get(DISK_RESERVE_BYTES);
                    let (faults, disk) = (self.faults.clone(), self.blobs.disk.clone());
                    let size = found.blob.size_bytes;
                    joined(
                        tokio::task::spawn_blocking(move || {
                            room(&faults, disk.root(), reserve, size)
                        })
                        .await,
                    )??;
                    self.blobs.spool(&store, &found.blob, object).await
                }
            };
            match opened {
                Ok(opened) => return Ok(Some((opened, found.blob))),
                Err(failure) => {
                    tracing::warn!(
                        store = store.kind(),
                        ?failure,
                        "A store did not open a blob to read"
                    );
                }
            }
        }
        Err(unavailable())
    }

    /// The object store's own link while it holds a copy, else the instance's.
    pub async fn mint_link(&self, caller: &Caller, hash: &Hash, ttl: u64) -> Result<Link> {
        let found = self.find_blob(caller, hash).await?;
        if let Some(s3) = &self.blobs.s3()
            && let Some(object) = found.object_in(&Store::S3(s3.clone()))
        {
            let lifetime = Duration::from_secs(ttl);
            return match s3.link(object, lifetime, self.blobs.check()).await {
                Ok(url) => Ok(Link {
                    url,
                    ttl_seconds: ttl,
                }),
                Err(error) => {
                    tracing::warn!(%error, "The object store made no link");
                    Err(unavailable())
                }
            };
        }
        let expires_ms = i64::try_from(ttl)
            .ok()
            .and_then(|seconds| seconds.checked_mul(1000))
            .and_then(|ms| self.clock.now_ms().checked_add(ms))
            .ok_or_else(|| Refusal::internal("a link's expiry did not fit"))?;
        let signature = self.blobs.signer.sign(&found.blob.hash, expires_ms)?;
        Ok(Link {
            url: link::url(
                self.addresses().sign_in().origin(),
                &found.blob.hash,
                expires_ms,
                &signature,
            ),
            ttl_seconds: ttl,
        })
    }

    /// A link is checked here and now, whatever happened to the key that minted it.
    pub async fn find_linked(&self, hash: &Hash, expires: &str, signature: &str) -> Result<Found> {
        let expires_ms = expires.parse::<i64>().ok();
        let live = expires_ms.is_some_and(|ms| ms >= self.clock.now_ms());
        let signed = expires_ms.is_some_and(|ms| self.blobs.signer.verifies(hash, ms, signature));
        if !(live && signed) {
            return Err(super::access::unauthorized());
        }
        let hash = hash.clone();
        self.db.read(move |tx| App::found_in(tx, None, &hash)).await
    }

    pub async fn blob_copies(&self, caller: &Caller, hash: &Hash) -> Result<Vec<CopyRecord>> {
        let (caller, hash) = (caller.clone(), hash.clone());
        self.db
            .read(move |tx| {
                App::found_in(tx, Some(&caller), &hash)?;
                rows::copies(tx, &hash)
            })
            .await
    }

    /// Every store, and the fewest live copies of a blob the instance keeps.
    pub async fn blob_stores(&self, caller: &Caller) -> Result<(Vec<StoreRecord>, u64)> {
        caller.require(Permission::InstanceRead)?;
        let stores = self.db.read(rows::stores).await?;
        Ok((stores, self.settings.live().get(BLOB_MIN_COPIES)))
    }

    pub async fn blob_orphans(&self, caller: &Caller) -> Result<Vec<OrphanRecord>> {
        caller.require(Permission::InstanceRead)?;
        self.db.read(rows::orphans).await
    }

    /// Queues deletion with the copy's removal before deleting its bytes.
    pub async fn drop_copy(
        self: &Arc<App>,
        caller: &Caller,
        hash: &Hash,
        store_id: &str,
    ) -> Result<()> {
        let (app, caller, hash) = (self.clone(), caller.clone(), hash.clone());
        let store_id = store_id.to_string();
        owned(async move { app.dropping(&caller, &hash, &store_id).await }).await
    }

    async fn dropping(&self, caller: &Caller, hash: &Hash, store_id: &str) -> Result<()> {
        let blob = hash.clone();
        let (found, holders) = self
            .db
            .read(move |tx| Ok((rows::find(tx, &blob)?, rows::holders(tx, &blob)?)))
            .await?;
        let Some(found) = found else {
            return Err(not_found());
        };
        if self.blobs.gate.unfinished(hash) {
            return Err(unavailable());
        }
        let store = self
            .blobs
            .store(store_id)
            .filter(|_| holders.iter().any(|held| held.store_id == store_id))
            .ok_or_else(copy_not_found)?;
        if matches!(store, Store::S3(_) | Store::Folder(_)) {
            crate::app::backups::survey_folder(self).await?;
        }
        let (blob, kept_in) = (hash.clone(), store_id.to_string());
        self.db
            .read(move |tx| keep_held(tx, &blob, &kept_in))
            .await?;
        let seeds = self.settings.seeds();
        let min_copies = self
            .db
            .read(move |tx| stored::deciding(tx, &seeds, BLOB_MIN_COPIES))
            .await?;
        let kept = own_others(&holders, store_id);
        if (kept as u64) < min_copies {
            return Err(below(kept + 1, min_copies));
        }
        let _held = self.lock_to_write(hash).await?;
        if self.blobs.gate.unfinished(hash) {
            return Err(unavailable());
        }
        let blob = hash.clone();
        let holders = self.db.read(move |tx| rows::holders(tx, &blob)).await?;
        if !holders.iter().any(|held| held.store_id == store_id) {
            return Err(copy_not_found());
        }
        let others: Vec<(Store, &str)> = holders
            .iter()
            .filter(|held| held.store_id != store_id && held.written)
            .filter_map(|held| Some((self.blobs.store(&held.store_id)?, held.object.as_str())))
            .collect();
        let answers = join_all(
            others
                .iter()
                .map(|(other, object)| self.blobs.answer_of(other, &found.hash, object)),
        )
        .await;
        let mut confirmed = 0;
        for ((other, _), answer) in others.iter().zip(&answers) {
            if matches!(answer, Ok(Answer::Holds(size)) if *size == found.size_bytes)
                && self.blobs.is_itself(other).await
            {
                confirmed += 1;
            }
        }
        if (confirmed as u64) < min_copies {
            return Err(below(confirmed + 1, min_copies));
        }
        let (blob, dropped) = (hash.clone(), store_id.to_string());
        let seeds = self.settings.seeds();
        self.write(caller, "blob.copy_dropped", move |unit| {
            unit.caller.require(Permission::BlobsManage)?;
            let holders = rows::holders(unit.tx(), &blob)?;
            if !holders.iter().any(|held| held.store_id == dropped) {
                return Err(copy_not_found());
            }
            keep_held(unit.tx(), &blob, &dropped)?;
            let min_copies = stored::deciding(unit.tx(), &seeds, BLOB_MIN_COPIES)?;
            let kept = own_others(&holders, &dropped);
            if (kept as u64) < min_copies {
                return Err(below(kept + 1, min_copies));
            }
            if (confirmed as u64) < min_copies {
                return Err(below(confirmed + 1, min_copies));
            }
            let object = holders
                .iter()
                .find(|held| held.store_id == dropped)
                .map(|held| held.object.as_str())
                .ok_or_else(copy_not_found)?;
            rows::remove_copy(unit.tx(), &blob, &dropped, object, &unit.at)?;
            unit.audit("blob", blob.as_str(), Some(json!({ "store_id": dropped })))
        })
        .await?;
        if let Err(failure) = self.finish_deletion(&store, hash).await {
            tracing::warn!(?failure, "A dropped copy's bytes wait for a later run");
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use crate::db::migrate::MIGRATIONS;
    use crate::db::{Lock, Options};
    use crate::settings::DatabasePath;
    use crate::settings::sealed::Secret;

    use super::*;

    fn database() -> Db {
        let options = Options {
            path: DatabasePath::Memory,
            write_wait: Duration::from_secs(5),
            readers: 1,
            migrations: MIGRATIONS,
            reserve: 0,
        };
        let lock = Lock::take(&options.path)
            .map_err(|failure| failure.message)
            .unwrap();
        Db::open(&options, lock, Arc::default())
            .map_err(|failure| failure.message)
            .unwrap()
    }

    /// A name the region rule refuses, for settings no write could make.
    fn refused_region() -> String {
        let alphabet = b"aenstx01-_";
        let mut names = vec![String::new()];
        for _ in 0..5 {
            names = names
                .iter()
                .flat_map(|name| {
                    alphabet
                        .iter()
                        .map(move |letter| format!("{name}{}", *letter as char))
                })
                .collect();
            if let Some(name) = names
                .iter()
                .find(|name| url::Url::parse(&format!("https://s3.{name}.amazonaws.com/")).is_err())
            {
                return name.clone();
            }
        }
        panic!("the rule refused no name");
    }

    fn signed_settings(region: String) -> ObjectStoreSettings {
        ObjectStoreSettings {
            bucket: "marfa".to_string(),
            region,
            endpoint: None,
            access_key_id: Some("key".to_string()),
            secret_access_key: Some(Secret::new("secret".to_string())),
            path_style: true,
            prefix: "marfa".to_string(),
            private_allowed: false,
        }
    }

    #[tokio::test]
    async fn a_store_client_that_fails_while_attaching_is_reported_trouble() {
        let db = database();
        let wanted = Wanted::Bucket(signed_settings(refused_region()));
        let attached = attach(&db, wanted.clone(), "instance", &[]).await;
        assert!(attached.s3.is_none());
        assert_eq!(attached.wanted, wanted);
        let trouble = attached.trouble.unwrap();
        assert!(trouble.contains("object store"), "{trouble}");
    }

    #[tokio::test]
    async fn a_store_client_that_fails_while_refilling_the_folder_is_reported_trouble() {
        let db = database();
        let wanted = Wanted::Bucket(signed_settings(refused_region()));
        let attached = refilling(&db, wanted, Path::new("/blobs")).await;
        let attached = attached.map_err(|failure| failure.message).unwrap();
        assert!(attached.s3.is_none());
        let trouble = attached.trouble.unwrap();
        assert!(trouble.contains("object store"), "{trouble}");
    }
}
