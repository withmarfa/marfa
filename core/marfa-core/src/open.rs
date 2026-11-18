//! Opening a working copy and the store files it is made from: opening,
//! replacing, removing and reading what a refused or damaged store holds.

use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rusqlite::Connection;

use crate::directory_vfs;
use crate::files::{keep_relocated_origin, write_down_renewals};
use crate::{
    Core, CoreError, DEFAULT_CATCH_UP_IDLE, Handle, INCOMING_GRACE, Result, Server, SetAside,
    UnsentWrite, UnsentWrites, blob, damage, directory, file_cache, http, lock, owner_only,
    remove_name, store, watch,
};

impl Core {
    #[cfg(test)]
    pub(crate) fn open_directory(
        state: &directory::Directory,
        store_label: &Path,
        server: Option<Server>,
    ) -> Result<Core> {
        let lock = Arc::new(Self::claim_directory(state)?);
        Self::open_claimed(state, store_label, server, lock)
    }

    /// The writer lock of the store in `state`, claimed apart from the
    /// store, so a caller can go on holding it after the store closes.
    #[cfg(unix)]
    pub(crate) fn claim_directory(state: &directory::Directory) -> Result<lock::WriterLock> {
        lock::WriterLock::claim_directory(&directory_vfs::DirectoryVfs::new(state.file())?)
    }

    /// Opens the store in `state` under `lock`, which `claim_directory`
    /// claimed there.
    #[cfg(unix)]
    pub(crate) fn open_claimed(
        state: &directory::Directory,
        store_label: &Path,
        server: Option<Server>,
        lock: Arc<lock::WriterLock>,
    ) -> Result<Core> {
        damage::refuse_emptied_in(state, store_label)?;
        let vfs = directory_vfs::DirectoryVfs::new(state.file())?;
        let writer = lock.handle() == Handle::Writer;
        let cache = blob::Cache::anchored(state, store_label, writer)?;
        Self::from_connection(
            store::open_directory(&vfs, store_label)?,
            server,
            lock,
            Some(cache),
        )
        .map(Core::swept)
    }

    #[cfg(unix)]
    pub(crate) fn read_directory(state: &directory::Directory, store_label: &Path) -> Result<Core> {
        damage::refuse_emptied_in(state, store_label)?;
        let vfs = directory_vfs::DirectoryVfs::new(state.file())?;
        Self::from_connection(
            store::read_directory(&vfs, store_label)?,
            None,
            Arc::new(lock::WriterLock::reader()),
            Some(blob::Cache::anchored(state, store_label, false)?),
        )
    }

    #[cfg(not(unix))]
    pub(crate) fn claim_directory(_state: &directory::Directory) -> Result<lock::WriterLock> {
        Err(CoreError::Invalid(
            "folder directory capabilities are unavailable on this platform".into(),
        ))
    }

    #[cfg(not(unix))]
    pub(crate) fn open_claimed(
        _state: &directory::Directory,
        _store_label: &Path,
        _server: Option<Server>,
        _lock: Arc<lock::WriterLock>,
    ) -> Result<Core> {
        Err(CoreError::Invalid(
            "folder directory capabilities are unavailable on this platform".into(),
        ))
    }

    #[cfg(not(unix))]
    pub(crate) fn read_directory(
        _state: &directory::Directory,
        _store_label: &Path,
    ) -> Result<Core> {
        Err(CoreError::Invalid(
            "folder directory capabilities are unavailable on this platform".into(),
        ))
    }

    /// Creates the file when absent. A changed origin is confirmed against
    /// the recorded instance before the first request.
    pub fn open(path: impl AsRef<Path>, server: Option<Server>) -> Result<Core> {
        let path = path.as_ref();
        // Claimed before the store is opened: a second opener that read the
        // store first would act as a writer until it found out it was not.
        let lock = lock::WriterLock::claim(Some(path))?;
        let cache = blob::Cache::beside(path);
        if lock.handle() == Handle::Writer {
            damage::refuse_unfinished(path)?;
            owner_only(path)?;
        }
        Self::from_connection(store::open(path)?, server, Arc::new(lock), Some(cache))
            .map(Core::swept)
            .map_err(|error| damage::at_path(error, path))
    }

    /// Reads every page of the store at `path`, and checks each index
    /// against its rows. Refuses, leaving it as it is, with `StoreDamaged`,
    /// its path and what its queue holds where SQLite cannot read it, with
    /// `WrongSchema` where another build made it, and with `ReadingHandle`
    /// while another process, or another `Core` in this one, holds the
    /// writer role. Reads the whole file, so it takes
    /// longer the larger the store: for a store a call refused
    /// `StoreDamaged` without naming it.
    pub fn check_store(path: impl AsRef<Path>) -> Result<()> {
        let path = path.as_ref();
        let lock = lock::WriterLock::claim(Some(path))?;
        lock.refuse_unless_writer()?;
        if path.symlink_metadata().is_err() {
            return Err(CoreError::Invalid(format!(
                "{} holds no store to check",
                path.display()
            )));
        }
        damage::check(path)
    }

    /// The writes the store at `path` holds that the server has not taken,
    /// whatever build made it, with the confirmation `remove_store` takes to
    /// lose exactly these. A path with no store holds none, as a removal
    /// counts it, and is read without making a writer lock there. Refuses
    /// with `ReadingHandle` while another process holds the writer role, with
    /// `StoreDamaged` while a set-aside of the store is unfinished or where
    /// its file is empty while its log holds committed writes, and with
    /// `Store` where the queue cannot be read.
    pub fn read_unsent(path: impl AsRef<Path>) -> Result<UnsentWrites> {
        let path = path.as_ref();
        // A store made after this check is still guarded by the confirmation.
        if path.symlink_metadata().is_err() && lock::lock_path(path).symlink_metadata().is_err() {
            damage::refuse_unfinished(path)?;
            return Ok(UnsentWrites {
                confirmation: store::confirmation(&[]),
                writes: Vec::new(),
            });
        }
        // Here, not in `claim_unsent`, so a removal losing all still takes it.
        damage::refuse_emptied(path)?;
        let writes = match Self::claim_unsent(path, false)? {
            Unsent::Held(_, writes) => writes,
            Unsent::NoFolder => Some(Vec::new()),
        };
        let writes = writes.ok_or_else(|| {
            CoreError::Store(format!(
                "the queue of {} cannot be read: set it aside if it is damaged (`marfa device set-aside`, or `setAsideDamaged` in a binding), which names each write it cannot read",
                path.display()
            ))
        })?;
        Ok(UnsentWrites {
            confirmation: store::confirmation(&writes),
            writes,
        })
    }

    /// The unsent writes at `path` as both `read_unsent` and a removal read
    /// them, with the writer lock they were read under. `None` where they
    /// cannot be read. A removal refuses a folder's store before reading.
    fn claim_unsent(path: &Path, refuse_folders: bool) -> Result<Unsent> {
        let holder = path
            .parent()
            .filter(|holder| !holder.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        if !holder.is_dir() {
            return Ok(Unsent::NoFolder);
        }
        let lock = lock::WriterLock::claim(Some(path))?;
        lock.refuse_unless_writer()?;
        if refuse_folders {
            store::refuse_folders(path)?;
        }
        // The missing store a stopped set-aside leaves is no store with no writes.
        damage::refuse_unfinished(path)?;
        let writes = match path.metadata() {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Some(Vec::new()),
            _ => store::removal_writes(path),
        };
        Ok(Unsent::Held(lock, writes))
    }

    /// Sets aside a store SQLite cannot read: moves the store file and its
    /// logs to `<store>.damaged-<n>` beside it, for the first `n` no file
    /// holds, never deleting them, and makes a new store at `path` that
    /// carries every write the old queue lets be read, under its id and
    /// idempotency key, with its body, base version and verdict. The new
    /// store keeps the server and instance the old one was built from, and
    /// the fetched and uploaded bytes beside the path, which are addressed by
    /// content. Where it cannot read every write, every record that decides
    /// how a carried write is sent, or every record of the bytes an earlier
    /// set-aside keeps, every byte held beside the path as it sets the store
    /// aside stays, whatever the file budget, until the store set aside is
    /// removed or moved from where the set-aside put it. It holds no copy: a drain sends nothing until it is
    /// hydrated, and a hydration from another instance holds the carried
    /// writes, as for any store. Refuses with `Invalid` a store that opens
    /// as it is and a folder's store, with `WrongSchema` a store another
    /// build made, and with `ReadingHandle` while another process holds the
    /// writer role. A set-aside that stopped part way is finished by asking
    /// again, and until then a writer's open is refused `StoreDamaged`.
    pub fn set_aside_damaged(path: impl AsRef<Path>) -> Result<SetAside> {
        let path = path.as_ref();
        let lock = lock::WriterLock::claim(Some(path))?;
        lock.refuse_unless_writer()?;
        damage::set_aside(path)
    }

    /// For a writer, lets go of old changes of removed edges and takes what
    /// a process that ended part way left in the cache, sparing the partial
    /// files of attachments, and forgets the bytes kept for a store set
    /// aside that is gone.
    fn swept(self) -> Core {
        if self.handle() != Handle::Writer {
            return self;
        }
        // Left to a later open where it fails: it commits the floor with the
        // rows it lets go, so a failed run leaves both as they were.
        if let Ok(conn) = self.conn() {
            let _ = store::prune_edge_changes(&conn, store::EDGE_CHANGES_KEPT);
        }
        if let Some(cache) = &self.cache {
            let attachments = self
                .conn()
                .ok()
                .and_then(|conn| store::kept_attachments(&conn).ok());
            cache.sweep_incoming(INCOMING_GRACE, attachments.as_ref());
            if let Ok(conn) = self.conn() {
                let _ = damage::forget_gone_keeps(&conn, |name| cache.beside_store(name));
            }
        }
        self
    }

    /// Replaces a store `open` refuses with `wrong_schema` by an empty one of
    /// this build's shape, and opens it as the writer. Refuses, leaving the
    /// store as it is, while another process holds the writer role, while
    /// the store holds a write the server has not taken or one it cannot
    /// count, and where `open` would not refuse it. The new store is empty,
    /// so what only the old store held, such as pins, is lost: read it
    /// first. The file budget's setting is kept, as far as the old store
    /// gives it: where it holds none, or none that can be read, the new store
    /// has the default. The blob cache is kept: it is addressed by content,
    /// not by the store. Refuses with `Invalid` a folder's store, and with
    /// `StoreDamaged` while a set-aside of the store is unfinished.
    pub fn replace_refused(path: impl AsRef<Path>, server: Option<Server>) -> Result<Core> {
        let path = path.as_ref();
        // Held from the count to the returned core, so no write can be
        // queued between the count and the replacement.
        let lock = lock::WriterLock::claim(Some(path))?;
        lock.refuse_unless_writer()?;
        // A server `open` would refuse is refused here, before the store goes.
        if let Some(server) = &server {
            http::Http::new(&server.url, &server.key)?;
        }
        store::refuse_folders(path)?;
        damage::refuse_unfinished(path)?;
        if path.symlink_metadata().is_err() {
            return Err(CoreError::Invalid(format!(
                "{} holds no store to replace",
                path.display()
            )));
        }
        match store::refusal(path)? {
            Some(CoreError::WrongSchema {
                unsent: Some(0), ..
            }) => {}
            Some(refused) => return Err(refused),
            None => {
                return Err(CoreError::Invalid(format!(
                    "{} opens as it is, so there is nothing to replace",
                    path.display()
                )));
            }
        }
        let budget = store::refused_file_budget(path);
        let conn = store::replace(path)?;
        // The budget is a setting the new store can do without, so a write
        // that fails leaves the default and does not undo a replacement
        // that is done.
        if let Some(setting) = budget
            && let Some(text) = setting.to_stored()
        {
            let _ = store::meta_set(&conn, file_cache::META_BUDGET, &text);
        }
        let cache = blob::Cache::beside(path);
        Self::from_connection(conn, server, Arc::new(lock), Some(cache)).map(Core::swept)
    }

    /// Removes the store at `path`, of any build's shape: the store file,
    /// its logs, the folder of fetched bytes beside it and its writer lock,
    /// and nothing else. A symbolic link at one of those names is removed,
    /// never what it leads to. `confirmation` is what `read_unsent` gave with
    /// the writes the person agreed to lose. Refuses, leaving everything as
    /// it is, with `ReadingHandle` while another process, or another `Core`
    /// in this one, holds the writer role, with `UnsentDiffers` where the
    /// writes it holds that the server has not taken are not, field for
    /// field, those the confirmation was given with, or cannot be read, with
    /// `Invalid` where the store is a folder's, bound or not, and with
    /// `StoreDamaged` while a set-aside of the store is unfinished, which
    /// asking for the set-aside again finishes. The writes are read and the
    /// store removed under one hold of the writer lock. A process that only
    /// reads the store does not hold the writer role, so it does not stop the
    /// removal. A path with no store holds none, so a confirmation of no
    /// writes takes any lock or bytes left there.
    pub fn remove_store(path: impl AsRef<Path>, confirmation: &str) -> Result<()> {
        Self::remove_agreed(path.as_ref(), Some(confirmation))
    }

    /// Removes the store at `path` as `remove_store` does, agreeing to lose
    /// every write it holds that the server has not taken, whatever they are
    /// and whether or not they can be read, as for a store SQLite cannot
    /// read. Refuses as `remove_store` does but for the writes.
    pub fn remove_store_losing_all(path: impl AsRef<Path>) -> Result<()> {
        Self::remove_agreed(path.as_ref(), None)
    }

    /// `agreed` is `None` where every write is agreed to be lost.
    fn remove_agreed(path: &Path, agreed: Option<&str>) -> Result<()> {
        let differs = |held: Option<Vec<UnsentWrite>>| match agreed {
            None => Ok(()),
            Some(agreed)
                if held
                    .as_deref()
                    .is_some_and(|held| store::confirmation(held) == agreed) =>
            {
                Ok(())
            }
            Some(_) => Err(CoreError::UnsentDiffers {
                path: path.display().to_string(),
                unsent: held.map(|held| held.len() as u64),
            }),
        };
        // Held from the read of the writes until the lock's own name is gone,
        // so no process can queue or change a write after the read, or make a
        // store at the path that the removal would then take.
        let (lock, held) = match Self::claim_unsent(path, true)? {
            Unsent::NoFolder => return differs(Some(Vec::new())),
            Unsent::Held(lock, held) => (lock, held),
        };
        differs(held)?;
        // The store goes after the fetched bytes, so a removal that stops
        // between the two leaves the store, and asking again finishes it. The
        // other order would leave bytes that a new store at the path adopts.
        remove_name(&blob::Cache::dir_beside(path))?;
        store::remove(path)?;
        remove_name(&lock::lock_path(path))?;
        drop(lock);
        Ok(())
    }

    /// Never claims the writer role, so a helper started before the app
    /// cannot lock the app out of its own store, and refuses a path where no
    /// store has been made rather than making one. `data_version` is how it
    /// learns the writer saved.
    pub fn open_reader(path: impl AsRef<Path>) -> Result<Core> {
        let path = path.as_ref();
        Ok(Core {
            conn: Arc::new(Mutex::new(store::open_to_read(path)?)),
            http: None,
            cache: Some(blob::Cache::beside(path)),
            catch_up_idle: DEFAULT_CATCH_UP_IDLE,
            lock: Arc::new(lock::WriterLock::reader()),
            streaming: Mutex::default(),
            draining: Mutex::new(()),
            watch: watch::Watch::new(),
            renewals: Arc::default(),
            reclaim_held_until: Mutex::default(),
            tables_owed: AtomicBool::new(false),
            damage_seen: damage::seen(),
        })
    }

    pub fn open_in_memory(server: Option<Server>) -> Result<Core> {
        let lock = lock::WriterLock::claim(None)?;
        Self::from_connection(store::open_in_memory()?, server, Arc::new(lock), None)
    }

    pub fn handle(&self) -> Handle {
        self.lock.handle()
    }

    /// Used when the server refuses the credential with a `401`; each
    /// refused call is sent again once.
    pub fn renew_credential_with(&self, renew: http::Renew) {
        if let Some(http) = &self.http {
            http.renew_with(renew);
        }
    }

    pub fn with_catch_up_idle(mut self, idle: Duration) -> Core {
        self.catch_up_idle = idle;
        self
    }

    fn from_connection(
        conn: Connection,
        server: Option<Server>,
        lock: Arc<lock::WriterLock>,
        cache: Option<blob::Cache>,
    ) -> Result<Core> {
        let damage_seen = damage::seen();
        let http = match server {
            Some(server) => Some(Arc::new(http::Http::new(&server.url, &server.key)?)),
            None => None,
        };
        let relocation = (|| -> Result<_> {
            let relocation = if let Some(http) = &http
                && let Some(expected) = store::meta_get(&conn, store::META_SERVER_ORIGIN)?
                && expected != http.origin()
            {
                Some((expected, store::meta_get(&conn, store::META_INSTANCE_ID)?))
            } else {
                None
            };
            // A copy that has never reached a server holds the types Marfa
            // ships, so an app can save before it has connected.
            if lock.handle() == Handle::Writer
                && store::never_synced(&conn)?
                && store::catalog_version(&conn)?.is_none()
            {
                store::hold_local_catalog_alone(&conn)?;
            }
            Ok(relocation)
        })()
        .inspect_err(|_| damage::keep_log_if_met(&conn, damage_seen))?;
        let conn = Arc::new(Mutex::new(conn));
        let renewals = Arc::new(Mutex::new(Vec::new()));
        if let Some(http) = &http {
            let db = Arc::clone(&conn);
            let pending = Arc::clone(&renewals);
            let writes = lock.handle() == Handle::Writer;
            http.on_renewed(Box::new(move |from, to| {
                // Only the handle that sent an upload records which bearer
                // sent it.
                if !writes {
                    return;
                }
                pending
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .push((store::credential_digest(from), store::credential_digest(to)));
                // Not waited for: a call can be renewed while its caller
                // holds the connection, and every drain writes it down as
                // it starts and as it ends.
                if let Ok(conn) = db.try_lock() {
                    let _ = write_down_renewals(&conn, &pending);
                }
            }));
        }
        if let Some((expected_origin, expected_instance)) = relocation {
            let http = http.as_ref().expect("relocation has a server");
            let db = Arc::clone(&conn);
            let origin = http.origin();
            let recorded_origin = expected_origin.clone();
            let recorded_instance = expected_instance.clone();
            let claim = Arc::clone(&lock);
            http.relocating(
                expected_origin,
                expected_instance,
                Box::new(move |stopped| {
                    keep_relocated_origin(
                        &db,
                        &claim,
                        &recorded_origin,
                        recorded_instance.as_deref(),
                        &origin,
                        stopped,
                    )
                }),
            );
        }
        Ok(Core {
            conn,
            http,
            cache,
            catch_up_idle: DEFAULT_CATCH_UP_IDLE,
            lock,
            streaming: Mutex::default(),
            draining: Mutex::new(()),
            watch: watch::Watch::new(),
            renewals,
            reclaim_held_until: Mutex::default(),
            tables_owed: AtomicBool::new(false),
            damage_seen,
        })
    }
}

enum Unsent {
    /// The path's folder does not exist, so it holds no store and no lock.
    NoFolder,
    Held(lock::WriterLock, Option<Vec<UnsentWrite>>),
}
