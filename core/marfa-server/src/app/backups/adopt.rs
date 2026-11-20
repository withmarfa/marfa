//! Adopting the backup folder: an unmarked files area becomes a new store, and the old store's
//! backups and copies are forgotten.

use std::sync::Arc;
use std::sync::atomic::Ordering;

use rusqlite::{OptionalExtension, Transaction};
use serde_json::{Value, json};

use super::{Destination, REPLICATION, blocking, counted, forget_backups, found, running};
use crate::app::App;
use crate::app::access::{Caller, Permission};
use crate::app::blobs::folder::{Adoptable, Folder};
use crate::app::blobs::{Attached, Blobs, unsettled};
use crate::app::faults::{HOLD_STORES_RECORD, HOLD_STORES_SWAP};
use crate::app::fingerprint::Fingerprint;
use crate::app::housekeeping;
use crate::app::mcp::guard::{Guard, Halt};
use crate::app::refusal::{Code, Refusal, Result};

pub const ADOPTED: &str = "backup_folder.adopt";

/// What adopting forgets, as read now.
#[derive(Debug)]
pub struct Forgets {
    pub replaced_store_id: String,
    pub backups: Vec<String>,
    pub found_backups: Vec<String>,
    pub copies: i64,
    pub last_backup: Option<String>,
    pub last_backup_at: Option<String>,
    /// What a confirmation binds: these and the folder's fingerprint.
    pub digest: String,
}

/// What adopting the backup folder would do, as read now.
#[derive(Debug)]
pub struct Adoption {
    pub folder: String,
    pub files_folder: String,
    pub forgets: Forgets,
}

/// Whether the new store's marker reached the folder.
#[derive(Debug)]
pub enum Marker {
    Written,
    Failed(String),
    /// The folder did not answer in time; the marker may land later.
    Unanswered,
}

#[derive(Debug)]
pub struct Adopted {
    pub store_id: String,
    pub replaced_store_id: String,
    pub backups: usize,
    pub copies: usize,
    pub folder: String,
    pub files_folder: String,
    pub marker: Marker,
    /// The folder read otherwise once the marker was written than when it was locked, or could
    /// not be read again; `None` where the folder did not answer.
    pub folder_changed: Option<bool>,
}

#[derive(Debug)]
pub enum Adopting {
    Done(Adopted),
    Halted(Halt),
}

/// The backup folder now, and whether its files area holds the marker of the store recorded there.
#[derive(Debug)]
pub struct FolderNow {
    pub store_id: String,
    /// `None` where the folder did not answer in time or could not be read.
    pub marked: Option<bool>,
}

pub fn target() -> String {
    crate::app::mcp::confirm::ids_digest(&["backup folder".to_string()])
}

fn forgets(tx: &Transaction<'_>, store: &str, fingerprint: &str) -> Result<Forgets> {
    let backups: Vec<(i64, String)> = tx
        .prepare_cached("SELECT seq, name FROM backups WHERE store_id = ?1 ORDER BY seq")?
        .query_map([store], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let found_backups = found::named_in(tx, store)?;
    let copies = Blobs::copies_in(tx, store)?;
    type Last = (Option<i64>, Option<i64>, Option<String>, Option<String>);
    let (backed_up, version, last_backup, last_backup_at): Last = tx
        .query_row(
            "SELECT backed_up, backed_up_version, last_backup, last_backup_at FROM backup_state \
             WHERE id = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?
        .unwrap_or_default();
    let mut print = Fingerprint::new("backup folder adopt");
    print.text(store).text(fingerprint);
    for listed in [&backups, &found_backups] {
        print.number(i64::try_from(listed.len()).unwrap_or(i64::MAX));
        for (seq, name) in listed {
            print.number(*seq).text(name);
        }
    }
    print
        .number(copies)
        .maybe(backed_up.map(|at| at.to_string()).as_deref())
        .maybe(version.map(|at| at.to_string()).as_deref())
        .maybe(last_backup.as_deref())
        .maybe(last_backup_at.as_deref());
    Ok(Forgets {
        replaced_store_id: store.to_string(),
        backups: backups.into_iter().map(|(_, name)| name).collect(),
        found_backups: found_backups.into_iter().map(|(_, name)| name).collect(),
        copies,
        last_backup,
        last_backup_at,
        digest: print.finish(),
    })
}

fn unanswered(root: &str, what: &str) -> Refusal {
    Refusal::new(
        Code::BlobStoreUnavailable,
        format!(
            "The backup folder {root} {what}. Check that its disk is mounted and answering, then \
             try again."
        ),
    )
}

fn looked_at_failed(root: &str, error: &std::io::Error) -> Refusal {
    tracing::warn!(%error, "The backup folder could not be looked at to adopt it");
    let next = if error.kind() == std::io::ErrorKind::PermissionDenied {
        "Make the folder writable by the server, then try again."
    } else {
        "Check that its disk is mounted and answering, then try again."
    };
    Refusal::new(
        Code::BlobStoreUnavailable,
        format!(
            "The backup folder {root} failed while it was looked at, so nothing was adopted: \
             {error}. {next}"
        ),
    )
}

/// The refusal of a folder that does not hold an unmarked files area.
fn not_adoptable(folder: &Folder, found: Adoptable) -> Result<()> {
    let root = folder.root().display();
    match found {
        Adoptable::Unmarked => Ok(()),
        Adoptable::Held => Err(Refusal::new(
            Code::Conflict,
            format!(
                "The backup folder {root} holds this instance's files, so there is nothing to \
                 adopt."
            ),
        )),
        Adoptable::Missing => Err(Refusal::new(
            Code::BlobStoreUnavailable,
            format!(
                "The backup folder {root} is not there, so nothing was adopted. Mount the disk it \
                 is on, then try again."
            ),
        )),
        Adoptable::Foreign(id) => Err(Refusal::new(
            Code::Conflict,
            format!(
                "The files folder {} holds the marker of another store, {id}, so it was left as \
                 it is. Remove that marker to adopt the folder afresh.",
                folder.area().display()
            ),
        )),
    }
}

impl App {
    /// The backup folder an adopt takes, refused as an adopt is. The caller holds the follow lock.
    fn folder_to_adopt(&self, followed: &Result<Arc<Attached>>) -> Result<Arc<Folder>> {
        let wanted = self.named_destination()?;
        let attached = self
            .blobs
            .stores_in_use(&wanted)
            .map_err(|unsettled| followed.as_ref().err().cloned().unwrap_or(unsettled))?;
        match Destination::required(&attached)? {
            Destination::Folder(folder) => Ok(folder),
            Destination::Bucket(_) => Err(Refusal::new(
                Code::Conflict,
                "This instance backs up to an object store, so it has no backup folder to adopt.",
            )),
        }
    }

    /// Looks at the folder as an adopt does before it changes anything.
    async fn look_to_adopt(
        &self,
        folder: &Arc<Folder>,
        followed: Result<Arc<Attached>>,
    ) -> Result<()> {
        let root = folder.root().display().to_string();
        if folder.claim_unended() {
            return Err(unanswered(
                &root,
                "has not answered an earlier adopt, so nothing was adopted",
            ));
        }
        if !self.blobs.settled() {
            return Err(followed.err().unwrap_or_else(unsettled));
        }
        let looked = folder.clone();
        let found = tokio::time::timeout(self.blobs.check(), blocking(move || looked.adoptable()))
            .await
            .map_err(|_| unanswered(&root, "did not answer in time, so nothing was adopted"))?
            .map_err(|error| looked_at_failed(&root, &error))?;
        not_adoptable(folder, found)
    }

    async fn followed(self: &Arc<App>) -> Result<Result<Arc<Attached>>> {
        match self.backup_stores().await {
            Err(refused) if refused.code == Code::NoBackupDestination => Err(refused),
            followed => Ok(followed),
        }
    }

    /// What adopting the backup folder would forget, refused as the adopt would be.
    pub async fn backup_folder_adoption(self: &Arc<App>, caller: &Caller) -> Result<Adoption> {
        caller.require(Permission::BackupsManage)?;
        let followed = self.followed().await?;
        let _changing = self.blobs.changing().await;
        let folder = self.folder_to_adopt(&followed)?;
        if self.backups.running.try_lock().is_err() {
            return Err(running(self.backups.restoring.load(Ordering::Acquire)));
        }
        self.look_to_adopt(&folder, followed).await?;
        let root = folder.root().display().to_string();
        let looked = folder.clone();
        let fingerprint =
            tokio::time::timeout(self.blobs.check(), blocking(move || looked.fingerprint()))
                .await
                .map_err(|_| unanswered(&root, "did not answer in time"))?
                .map_err(|error| looked_at_failed(&root, &error))?;
        let (caller, at, app) = (caller.clone(), self.clock.stamp(), self.clone());
        let (named, old) = (folder.root().to_path_buf(), folder.files().id().to_string());
        let forgets = self
            .db
            .read(move |tx| {
                caller
                    .current(tx, &at)?
                    .require(Permission::BackupsManage)?;
                Blobs::check_adoptable(tx, &app, &named, &old)?;
                forgets(tx, &old, &fingerprint)
            })
            .await?;
        Ok(Adoption {
            folder: root,
            files_folder: folder.area().display().to_string(),
            forgets,
        })
    }

    /// The folder store the record names now, and whether the files area holds its marker.
    pub async fn backup_folder_now(&self) -> Result<Option<FolderNow>> {
        let Some(Destination::Folder(folder)) = Destination::of(&self.blobs.attachment()) else {
            return Ok(None);
        };
        let Some(store_id) = self.db.read(Blobs::attached_folder).await? else {
            return Ok(None);
        };
        let wanted = store_id.clone();
        let marked = tokio::time::timeout(
            self.blobs.check(),
            tokio::task::spawn_blocking(move || folder.holds_marker(&wanted)),
        )
        .await
        .ok()
        .and_then(|joined| joined.ok())
        .flatten();
        Ok(Some(FolderNow { store_id, marked }))
    }

    /// Judges an adopt's confirmation alone, before the folder is looked at.
    pub async fn peek_adoption(&self, guard: &Guard) -> Result<Option<Halt>> {
        let (guard, now) = (guard.clone(), self.clock.instant());
        self.db.read(move |tx| guard.peek(tx, now)).await
    }

    /// Takes an unmarked backup folder as a new store, forgetting the old one's copies and backups.
    pub async fn adopt_backup_folder(self: &Arc<App>, caller: &Caller) -> Result<Value> {
        let adopted = match self.adopt_folder(caller, None).await? {
            Adopting::Done(adopted) => adopted,
            Adopting::Halted(_) => {
                return Err(Refusal::internal("an adopt with no confirmation halted"));
            }
        };
        let forgot = forgot(adopted.backups, adopted.copies);
        let root = &adopted.folder;
        match adopted.marker {
            Marker::Written => {}
            Marker::Failed(error) => {
                return Err(Refusal::new(
                    Code::BlobStoreUnavailable,
                    format!(
                        "The backup folder {root} could not take the new store's marker: {error}. \
                         {forgot} Make the folder writable, then run `marfa backups folder adopt` \
                         again."
                    ),
                ));
            }
            Marker::Unanswered => {
                return Err(unanswered(
                    root,
                    &format!(
                        "did not answer in time when it was given the new store's marker. \
                         {forgot} Backups wait until it answers"
                    ),
                ));
            }
        }
        Ok(json!({
            "store_id": adopted.store_id,
            "replaced_store_id": adopted.replaced_store_id,
            "backups_forgotten": adopted.backups,
            "copies_forgotten": adopted.copies,
        }))
    }

    /// Adopts the backup folder. With a guard, the adopt holds what it forgets and the folder to
    /// what the preview read and spends the confirmation in the same write.
    pub async fn adopt_folder(
        self: &Arc<App>,
        caller: &Caller,
        guard: Option<Guard>,
    ) -> Result<Adopting> {
        caller.require(Permission::BackupsManage)?;
        let (app, caller) = (self.clone(), caller.clone());
        tokio::spawn(crate::app::provenance::carried(async move {
            app.adopting(&caller, guard).await
        }))
        .await
        .map_err(|_| Refusal::internal("an adopt of the backup folder did not finish"))?
    }

    /// The follow lock covers folder selection through its claim, and the files area's lock
    /// covers what the adopt reads of the folder through the marker it writes.
    async fn adopting(self: &Arc<App>, caller: &Caller, guard: Option<Guard>) -> Result<Adopting> {
        let followed = self.followed().await?;
        let _changing = self.blobs.changing().await;
        let folder = self.folder_to_adopt(&followed)?;
        let Ok(_running) = self.backups.running.try_lock() else {
            return Err(running(self.backups.restoring.load(Ordering::Acquire)));
        };
        self.look_to_adopt(&folder, followed).await?;
        let root = folder.root().display().to_string();
        let mut holding = match folder.hold_within(self.blobs.check()).await {
            Some(Ok(holding)) => holding,
            Some(Err(error)) => return Err(looked_at_failed(&root, &error)),
            None => {
                return Err(unanswered(
                    &root,
                    "did not answer in time, so nothing was adopted",
                ));
            }
        };
        let found = std::mem::replace(&mut holding.found, Adoptable::Unmarked);
        not_adoptable(&folder, found)?;
        let old = folder.files();
        let (old_id, id) = (old.id().to_string(), uuid::Uuid::now_v7().to_string());
        let locator = old.root().display().to_string();
        let (forgotten, new_id, fingerprint) =
            (old_id.clone(), id.clone(), holding.fingerprint.clone());
        let (checking, named) = (self.clone(), folder.root().to_path_buf());
        self.faults.hold(HOLD_STORES_RECORD, None).await;
        let written = self
            .write(caller, ADOPTED, move |unit| {
                unit.caller.require(Permission::BackupsManage)?;
                Blobs::check_adoptable(unit.tx(), &checking, &named, &forgotten)?;
                if let Some(guard) = &guard {
                    let forgets = forgets(unit.tx(), &forgotten, &fingerprint)?;
                    if let Some(halt) = guard.check(unit, Some(&forgets.digest))? {
                        return Ok(Err(halt));
                    }
                }
                let backups = forget_backups(unit.tx(), &forgotten)?;
                let copies = Blobs::replace_folder_store(
                    unit.tx(),
                    &forgotten,
                    &new_id,
                    &locator,
                    &unit.at,
                )?;
                housekeeping::bring_forward(unit.tx(), REPLICATION, &unit.at)?;
                unit.audit(
                    "store",
                    &new_id,
                    Some(json!({
                        "replaced_store_id": forgotten,
                        "backups_forgotten": backups,
                        "copies_forgotten": copies,
                    })),
                )?;
                if let Some(guard) = &guard {
                    guard.spend(unit, 1)?;
                }
                Ok(Ok((copies, backups)))
            })
            .await;
        let (copies, backups) = match written {
            Ok(Ok(counted)) => counted,
            Ok(Err(halt)) => return Ok(Adopting::Halted(halt)),
            Err(refusal) => {
                drop(holding);
                if refusal.commit_failed
                    && let Err(refused) = self.retake_folder(&folder).await
                {
                    tracing::error!(%refused, "An adopt of unknown outcome left the backup folder unchecked");
                    self.blobs.doubt_record();
                }
                return Err(refusal);
            }
        };
        self.faults.hold(HOLD_STORES_SWAP, None).await;
        let locked = holding.fingerprint.clone();
        let (marker, folder_changed) = match folder
            .claim_held(holding, id.clone(), self.blobs.check(), self.faults.clone())
            .await
        {
            Some(claimed) => {
                let changed = claimed.fingerprint.as_ref().ok() != Some(&locked);
                if changed {
                    tracing::warn!("The backup folder changed while it was adopted");
                }
                match claimed.written {
                    Ok(()) => (Marker::Written, Some(changed)),
                    Err(error) => (Marker::Failed(error.to_string()), Some(changed)),
                }
            }
            None => {
                if let Err(refused) = self.retake_folder(&folder).await {
                    tracing::error!(%refused, "An adopt whose claim did not answer left the backup folder unchecked");
                    self.blobs.doubt_record();
                }
                (Marker::Unanswered, None)
            }
        };
        tracing::info!(store = %id, replaced = %old_id, backups, copies, "The backup folder was adopted");
        Ok(Adopting::Done(Adopted {
            store_id: id,
            replaced_store_id: old_id,
            backups,
            copies,
            folder: root,
            files_folder: folder.area().display().to_string(),
            marker,
            folder_changed,
        }))
    }
}

/// What an adopt forgot, as a sentence.
pub fn forgot(backups: usize, copies: usize) -> String {
    format!(
        "The old store's {} and {} were forgotten.",
        counted(backups, "backup", "backups"),
        counted(copies, "file copy", "file copies"),
    )
}
