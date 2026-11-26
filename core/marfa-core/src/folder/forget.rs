//! A folder remembers each other folder it found, so a registry that loses
//! one does not hide a move into it. Nothing at a remembered path proves the
//! folder gone, so only the person, naming the exact path, ends that memory.

use std::fmt::Display;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use rusqlite::Connection;
use serde::Serialize;

use super::elsewhere::{META_OTHERS, META_STORE};
use super::held::HeldFile;
use super::registry::{self, Registered, Registry};
use super::{Folder, STATE_DIR, admitted_root, handover, settings_file, state};
use crate::directory::Directory;
use crate::{Core, CoreError, Result, store};

/// The folders on this computer that remember a directory, or hold a delete
/// that waits on it, as read once.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Remembered {
    /// The directory, made absolute as a folder records it.
    pub dir: PathBuf,
    /// Whether the registry lists it too. Every folder finds it again at its
    /// next pass, so a forget changes nothing until it is removed.
    pub listed: bool,
    pub folders: Vec<Remembering>,
    /// Listed folders whose memory could not be read, each with why.
    pub not_read: Vec<NotRead>,
    /// Directories remembered that differ from `dir` only in case. They are
    /// not forgotten.
    pub alike: Vec<PathBuf>,
}

/// A listed folder that remembers the directory or holds a delete that waits
/// on it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Remembering {
    pub dir: PathBuf,
    pub folder: String,
    /// The store read, which the forget finds again before it writes. It is
    /// opaque: compare it for equality and do not parse it.
    #[serde(skip)]
    pub store: String,
    /// Its held deletes that wait on the directory.
    pub held: Vec<WaitingHold>,
}

/// A held delete that waits on the directory being forgotten.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WaitingHold {
    #[serde(flatten)]
    pub file: HeldFile,
    /// The other directories it waits on, which keep it held once the
    /// directory is forgotten. Where there are none, the forget releases it
    /// and the folder's next pass decides it again.
    pub still_waits_on: Vec<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct NotRead {
    pub dir: PathBuf,
    pub reason: String,
}

/// What forgetting a directory changed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Forgotten {
    pub dir: PathBuf,
    pub listed: bool,
    pub forgotten: Vec<ForgottenIn>,
    /// Folders left as they were, each with why: those not read when shown,
    /// and those not changed because the directory is listed or occupied, or
    /// their store could not be claimed or was not the one shown.
    pub not_changed: Vec<NotRead>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ForgottenIn {
    pub dir: PathBuf,
    pub folder: String,
    /// Paths of its held deletes no longer held, which its next pass decides.
    pub released: Vec<String>,
    /// Its held deletes that waited on the directory and still wait on
    /// others.
    pub still_held: Vec<StillHeld>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StillHeld {
    pub path: String,
    pub still_waits_on: Vec<PathBuf>,
}

impl Folder {
    /// Which listed folders remember `dir` or hold a delete that waits on it,
    /// and for each such held delete, the other directories it still waits
    /// on once `dir` is forgotten. Reads only, and asks no watch for a folder. `dir` is matched as spelled, made absolute, and never
    /// through the file system, so a link standing in a parent leads nowhere
    /// else. A remembered path that differs from it only in case is pointed
    /// out, in `alike`. Refused where anything but an empty directory stands
    /// at `dir`.
    pub fn remembering(dir: impl AsRef<Path>) -> Result<Remembered> {
        // Rebuilt from its parts, so a trailing slash is not shown.
        let dir: PathBuf = registry::absolute(dir.as_ref()).components().collect();
        nothing_stands(&dir)?;
        let entries = listed()?;
        let listed = entries.iter().any(|entry| entry.dir == dir);
        let mut shown = Remembered {
            dir,
            listed,
            folders: Vec::new(),
            not_read: Vec::new(),
            alike: Vec::new(),
        };
        for entry in entries {
            // Without a recorded root, an empty directory at its path may be
            // a volume that is not mounted, so it is tried and named.
            if entry.dir == shown.dir || entry.root.is_some() && registry::gone(&entry) {
                continue;
            }
            match read(&entry, &shown.dir, listed) {
                Ok((remembering, alike)) => {
                    shown.folders.extend(remembering);
                    for dir in alike {
                        if !shown.alike.contains(&dir) {
                            shown.alike.push(dir);
                        }
                    }
                }
                Err(reason) => shown.not_read.push(NotRead {
                    dir: entry.dir,
                    reason,
                }),
            }
        }
        Ok(shown)
    }

    /// Forgets the directory in each folder `shown` names, and takes it off
    /// each held delete it showed that still waits on it, unchanged,
    /// releasing the hold where it waits on nothing else. A watch
    /// holding a folder lets it go while this runs. A folder is changed only
    /// while the registry lists it at its path, its store is the one shown,
    /// the registry does not list the directory and nothing stands there but
    /// an empty directory, all read again as it is changed.
    pub fn forget_remembered(shown: &Remembered) -> Result<Forgotten> {
        Folder::forget_waiting(shown, handover::HANDOVER_WAIT)
    }

    pub(super) fn forget_waiting(shown: &Remembered, wait: Duration) -> Result<Forgotten> {
        nothing_stands(&shown.dir)?;
        let mut done = Forgotten {
            dir: shown.dir.clone(),
            listed: shown.listed || listed()?.iter().any(|entry| entry.dir == shown.dir),
            forgotten: Vec::new(),
            not_changed: shown.not_read.clone(),
        };
        for holder in &shown.folders {
            let changed = if done.listed {
                Err(Left::Listed)
            } else {
                forget_in(holder, &shown.dir, wait)
            };
            match changed {
                Ok((released, still_held)) => done.forgotten.push(ForgottenIn {
                    dir: holder.dir.clone(),
                    folder: holder.folder.clone(),
                    released,
                    still_held,
                }),
                Err(left) => {
                    done.listed |= matches!(left, Left::Listed);
                    done.not_changed.push(NotRead {
                        dir: holder.dir.clone(),
                        reason: left.reason(&shown.dir),
                    });
                }
            }
        }
        Ok(done)
    }
}

/// Refuses a directory where something stands that may be the folder, or
/// hold a file moved into it.
fn nothing_stands(dir: &Path) -> Result<()> {
    match occupied(dir) {
        None => Ok(()),
        Some(what) => Err(CoreError::Invalid(format!(
            "{} {what}, so it may still be the folder or hold a file moved into it, and nothing was forgotten; unmount its volume, or remove what is there or make it readable, then forget it again",
            dir.display()
        ))),
    }
}

/// What stands at `dir`, if anything but nothing or an empty directory, such
/// as an unmounted volume's mount point, does. A name a computer leaves by
/// itself, such as `.DS_Store`, is never a file a folder takes, so it does
/// not count.
fn occupied(dir: &Path) -> Option<String> {
    use std::io::ErrorKind;
    match std::fs::symlink_metadata(dir) {
        Err(error) if matches!(error.kind(), ErrorKind::NotFound | ErrorKind::NotADirectory) => {
            None
        }
        Err(error) => Some(format!("cannot be checked ({error})")),
        Ok(found) if !found.is_dir() => Some("is not a directory".into()),
        Ok(_) => match std::fs::read_dir(dir) {
            Ok(entries) => {
                for entry in entries {
                    match entry {
                        Ok(entry) => {
                            if !entry
                                .file_name()
                                .to_str()
                                .is_some_and(super::lists::machine_name)
                            {
                                return Some("is not empty".into());
                            }
                        }
                        Err(error) => return Some(format!("cannot be read ({error})")),
                    }
                }
                None
            }
            Err(error) => Some(format!("cannot be read ({error})")),
        },
    }
}

/// The registry's folders, read without tidying it, since showing changes
/// nothing.
fn listed() -> Result<Vec<Registered>> {
    Ok(Registry::located()
        .map(|registry| registry.read())
        .transpose()?
        .flatten()
        .unwrap_or_default())
}

fn because(what: &'static str) -> impl FnOnce(&dyn Display) -> String {
    move |error| format!("{what} ({error})")
}

fn opened_state(
    entry_dir: &Path,
    admitted: Option<&str>,
) -> std::result::Result<Directory, String> {
    let root = Directory::open(entry_dir)
        .map_err(|error| because("its directory cannot be opened")(&error))?;
    admitted_root(&root).map_err(|error| because("its directory cannot be read")(&error))?;
    if let Some(admitted) = admitted
        && registry::root_identity(&root).as_deref() != Some(admitted)
    {
        return Err("another directory stands at its listed path".into());
    }
    root.child(Path::new(STATE_DIR), false)
        .map_err(|error| because("its saved state cannot be opened")(&error))
}

/// The folder and the store `core` holds, as `Remembering::store` names it.
fn bound_store(
    core: &Core,
    state_dir: &Directory,
) -> Result<(Option<String>, String, Option<String>)> {
    let place = state_dir
        .metadata()
        .ok()
        .as_ref()
        .and_then(super::identity::of)
        .map(|identity| identity.key())
        .unwrap_or_default();
    let mark = state_dir
        .entry_identity(Path::new("core.sqlite"))
        .map_err(|error| CoreError::Store(error.to_string()))?;
    let folder = settings_file::bound(core)?;
    let id = store::meta_get(&*core.conn()?, META_STORE)?;
    Ok((folder, store_key(&place, mark, id.as_deref()), id))
}

/// A listed folder's memory of `target`, or why it cannot be read.
fn read(
    entry: &Registered,
    target: &Path,
    listed: bool,
) -> std::result::Result<(Option<Remembering>, Vec<PathBuf>), String> {
    let state_dir = opened_state(&entry.dir, entry.root.as_deref())?;
    let core = Core::read_directory(&state_dir, &entry.dir.join(STATE_DIR).join("core.sqlite"))
        .map_err(|error| because("its saved state cannot be read")(&error))?;
    let ((folder, store, store_id), others, held) = (|| -> Result<_> {
        let bound = bound_store(&core, &state_dir)?;
        let conn = core.conn()?;
        Ok((bound, remembered_in(&conn)?, state::journaled(&conn)?))
    })()
    .map_err(|error| because("its saved state cannot be read")(&error))?;
    if folder.as_deref() != Some(entry.folder.as_str())
        || entry.store.is_some() && entry.store != store_id
    {
        return Err("its saved state does not match the folder or store in the registry".into());
    }
    let alike = others
        .iter()
        .filter(|other| other.dir != target && alike(&other.dir, target))
        .map(|other| other.dir.clone())
        .collect();
    let waiting: Vec<WaitingHold> = held
        .into_iter()
        .filter_map(|row| match row.kept {
            Some(state::Kept::Unsure(unsure)) if unsure.waits_on(target) => Some(WaitingHold {
                still_waits_on: without(&unsure, target),
                file: HeldFile {
                    path: row.path,
                    item: row.item_id,
                    missing_since: row.missing_since,
                    reason: unsure.reason,
                },
            }),
            _ => None,
        })
        .collect();
    // A hold outlives the memory it was made for, as an earlier forget of a
    // listed directory could leave it.
    if waiting.is_empty() && !others.iter().any(|other| other.dir == target) {
        return Ok((None, alike));
    }
    let held = if listed { Vec::new() } else { waiting };
    Ok((
        Some(Remembering {
            dir: entry.dir.clone(),
            folder: entry.folder.clone(),
            store,
            held,
        }),
        alike,
    ))
}

const NOT_SHOWN: &str =
    "its saved state is not the one that was shown, so nothing in it was changed";
const MOVED: &str = "its saved state moved out of its directory while it was being changed, so nothing in it was changed";
const NOT_LISTED: &str =
    "the registry no longer lists it as the folder that was shown, so nothing in it was changed";

/// Why a folder was left as it was.
enum Left {
    /// The registry lists the directory being forgotten.
    Listed,
    Because(String),
}

impl Left {
    fn reason(self, target: &Path) -> String {
        match self {
            Left::Listed => format!(
                "the registry lists {}, so every folder finds it again at its next pass and nothing in this one was changed; `folders remove` it first, then forget it",
                target.display()
            ),
            Left::Because(reason) => reason,
        }
    }
}

impl From<String> for Left {
    fn from(reason: String) -> Left {
        Left::Because(reason)
    }
}

impl From<&str> for Left {
    fn from(reason: &str) -> Left {
        Left::Because(reason.into())
    }
}

/// The state directory of the folder the registry lists as `holder` now,
/// refused unless it is `state_dir`, the one claimed.
fn still_at_path(
    holder: &Remembering,
    listed: &[Registered],
    state_dir: &Directory,
) -> std::result::Result<(), String> {
    let entry = listed
        .iter()
        .find(|entry| entry.dir == holder.dir && entry.folder == holder.folder)
        .ok_or(NOT_LISTED)?;
    let now = opened_state(&holder.dir, entry.root.as_deref())?;
    match now.same(state_dir) {
        Ok(true) => Ok(()),
        _ => Err(format!(
            "another folder's saved state stands at {} now, so nothing in the one that was shown was changed",
            holder.dir.display()
        )),
    }
}

/// Forgets `target` in the folder `holder` names, under its writer lock,
/// and answers the paths released and the holds still waiting on others; or
/// why nothing in it changed.
fn forget_in(
    holder: &Remembering,
    target: &Path,
    wait: Duration,
) -> std::result::Result<(Vec<String>, Vec<StillHeld>), Left> {
    let registry_read =
        || listed().map_err(|error| because("the folder registry cannot be read")(&error));
    let entry = registry_read()?
        .into_iter()
        .find(|entry| entry.dir == holder.dir && entry.folder == holder.folder)
        .ok_or(NOT_LISTED)?;
    let state_dir = opened_state(&holder.dir, entry.root.as_deref())?;
    let label = holder.dir.join(STATE_DIR).join("core.sqlite");
    let lock =
        handover::claim_asking(&state_dir, &holder.dir, wait, false).map_err(
            |error| match error {
                CoreError::ReadingHandle => handover::not_handed_over(&holder.dir),
                other => because("it could not be claimed")(&other),
            },
        )?;
    // The folder may have moved while its watch held it, with another listed
    // at its path.
    still_at_path(holder, &registry_read()?, &state_dir)?;
    // Compared before any open that can write, which tidies the store.
    let read = Core::read_directory(&state_dir, &label)
        .and_then(|core| bound_store(&core, &state_dir))
        .map_err(|error| because("its saved state cannot be read")(&error))?;
    if read.0.as_deref() != Some(holder.folder.as_str()) || read.1 != holder.store {
        return Err(NOT_SHOWN.into());
    }
    let core = Core::open_claimed(&state_dir, &label, None, Arc::new(lock))
        .map_err(|error| because("its saved state cannot be opened")(&error))?;
    (|| -> Result<std::result::Result<(Vec<String>, Vec<StillHeld>), Left>> {
        let (folder, store, _) = bound_store(&core, &state_dir)?;
        if folder.as_deref() != Some(holder.folder.as_str()) || store != holder.store {
            return Ok(Err(NOT_SHOWN.into()));
        }
        let conn = core.conn()?;
        // Every entry as written: one `gone` drops, such as a rootless entry
        // at an empty mount point, may be a folder whose volume is away.
        let commit = |written: &[Registered]| -> Result<std::result::Result<_, Left>> {
            if let Err(reason) = still_at_path(holder, written, &state_dir) {
                return Ok(Err(reason.into()));
            }
            if written.iter().any(|entry| entry.dir == target) {
                return Ok(Err(Left::Listed));
            }
            if let Some(what) = occupied(target) {
                return Ok(Err(format!(
                    "{} {what} now, so it may still be the folder or hold a file moved into it, and nothing in this folder was changed",
                    target.display()
                )
                .into()));
            }
            let tx = conn.unchecked_transaction()?;
            let others = remembered_in(&tx)?;
            let kept: Vec<&Registered> =
                others.iter().filter(|other| other.dir != target).collect();
            if kept.len() != others.len() {
                let json = serde_json::to_string(&kept)
                    .map_err(|error| CoreError::Store(error.to_string()))?;
                store::meta_set(&tx, META_OTHERS, &json)?;
            }
            let mut released: Vec<String> = Vec::new();
            let mut still_held: Vec<StillHeld> = Vec::new();
            for WaitingHold { file, .. } in &holder.held {
                let Some(row) = state::journaled_at(&tx, &file.path, &file.item)? else {
                    continue;
                };
                let Some(state::Kept::Unsure(unsure)) = row.kept else {
                    continue;
                };
                if row.missing_since != file.missing_since || !unsure.waits_on(target) {
                    continue;
                }
                let rest = without(&unsure, target);
                if rest.is_empty() {
                    state::journal_keep(&tx, &file.path, &file.item, None)?;
                    if !released.contains(&file.path) {
                        released.push(file.path.clone());
                    }
                } else {
                    let narrowed = state::Unsure::on(unsure.reason, rest.clone());
                    state::journal_keep(
                        &tx,
                        &file.path,
                        &file.item,
                        Some(&state::Kept::Unsure(narrowed)),
                    )?;
                    let still = StillHeld {
                        path: file.path.clone(),
                        still_waits_on: rest,
                    };
                    if !still_held.contains(&still) {
                        still_held.push(still);
                    }
                }
            }
            // The checks above read the state directory, not the open file,
            // which can move out of it while the registry is awaited.
            if crate::lock::moved(&tx)? {
                return Ok(Err(MOVED.into()));
            }
            tx.commit()?;
            Ok(Ok((released, still_held)))
        };
        match Registry::located() {
            Some(registry) => registry.while_written(commit)?,
            None => commit(&[]),
        }
    })()
    .map_err(|error| Left::Because(because("it could not be changed")(&error)))?
}

fn remembered_in(conn: &Connection) -> Result<Vec<Registered>> {
    match store::meta_get(conn, META_OTHERS)? {
        Some(json) => serde_json::from_str(&json).map_err(|error| {
            CoreError::Store(format!("what it remembers cannot be read ({error})"))
        }),
        None => Ok(Vec::new()),
    }
}

/// Which store was read: its state directory, its file and the id it holds.
fn store_key(place: &str, mark: (u64, u64), id: Option<&str>) -> String {
    format!("{place}/{}:{}/{}", mark.0, mark.1, id.unwrap_or_default())
}

/// The directories `unsure` waits on but `target`.
fn without(unsure: &state::Unsure, target: &Path) -> Vec<PathBuf> {
    unsure
        .waits_on
        .iter()
        .flatten()
        .filter(|dir| dir.as_path() != target)
        .cloned()
        .collect()
}

fn alike(one: &Path, other: &Path) -> bool {
    one.to_string_lossy().to_lowercase() == other.to_string_lossy().to_lowercase()
}
