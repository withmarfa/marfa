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

/// The folders on this computer that remember a directory, as read once.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Remembered {
    /// The directory, made absolute as a folder records it.
    pub dir: PathBuf,
    /// Whether the registry lists it too, so every folder finds it again at
    /// its next pass and no held delete is decided again.
    pub listed: bool,
    pub folders: Vec<Remembering>,
    /// Listed folders whose memory could not be read, each with why.
    pub not_read: Vec<NotRead>,
    /// Directories remembered that differ from `dir` only in case. They are
    /// not forgotten.
    pub alike: Vec<PathBuf>,
}

/// A listed folder that remembers the directory.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Remembering {
    pub dir: PathBuf,
    pub folder: String,
    /// The store read, which the forget finds again before it writes. It is
    /// opaque: compare it for equality and do not parse it.
    #[serde(skip)]
    pub store: String,
    /// Its held deletes that wait on the directory, decided again at its next
    /// pass once it forgets.
    pub held: Vec<HeldFile>,
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
    /// and those whose store could not be claimed or was not the one shown.
    pub not_changed: Vec<NotRead>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ForgottenIn {
    pub dir: PathBuf,
    pub folder: String,
    /// Paths of its held deletes no longer held, which its next pass decides.
    pub released: Vec<String>,
}

impl Folder {
    /// Which listed folders remember `dir`, and which of their held deletes
    /// forgetting it lets be decided again. Reads only, and asks no watch for
    /// a folder. `dir` is matched as spelled, made absolute, and never
    /// through the file system, so a link standing in a parent leads nowhere
    /// else. A remembered path that differs from it only in case is pointed
    /// out, in `alike`. Refused where anything but an empty directory stands
    /// at `dir`.
    pub fn remembering(dir: impl AsRef<Path>) -> Result<Remembered> {
        let dir = registry::absolute(dir.as_ref());
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

    /// Forgets the directory in each folder `shown` names, and releases the
    /// held deletes it showed that still wait on it, unchanged. A watch
    /// holding a folder lets it go while this runs. A folder is changed only
    /// while the registry lists it and its store is the one shown; none is
    /// changed where anything but an empty directory stands at the directory.
    pub fn forget_remembered(shown: &Remembered) -> Result<Forgotten> {
        Folder::forget_waiting(shown, handover::HANDOVER_WAIT)
    }

    pub(super) fn forget_waiting(shown: &Remembered, wait: Duration) -> Result<Forgotten> {
        nothing_stands(&shown.dir)?;
        let mut done = Forgotten {
            dir: shown.dir.clone(),
            listed: listed()?.iter().any(|entry| entry.dir == shown.dir),
            forgotten: Vec::new(),
            not_changed: shown.not_read.clone(),
        };
        for holder in &shown.folders {
            match forget_in(holder, &shown.dir, wait) {
                Ok((released, listed)) => {
                    done.listed |= listed;
                    done.forgotten.push(ForgottenIn {
                        dir: holder.dir.clone(),
                        folder: holder.folder.clone(),
                        released,
                    });
                }
                Err(reason) => done.not_changed.push(NotRead {
                    dir: holder.dir.clone(),
                    reason,
                }),
            }
        }
        Ok(done)
    }
}

/// Refuses a directory where something stands that may be the folder, or
/// hold a file moved into it: only nothing, or an empty directory such as an
/// unmounted volume's mount point, can be forgotten.
fn nothing_stands(dir: &Path) -> Result<()> {
    use std::io::ErrorKind;
    let refused = |what: String| {
        Err(CoreError::Invalid(format!(
            "{} {what}, so it may still be the folder or hold a file moved into it, and nothing was forgotten; unmount its volume, or remove what is there or make it readable, then forget it again",
            dir.display()
        )))
    };
    match std::fs::symlink_metadata(dir) {
        Err(error) if matches!(error.kind(), ErrorKind::NotFound | ErrorKind::NotADirectory) => {
            Ok(())
        }
        Err(error) => refused(format!("cannot be checked ({error})")),
        Ok(found) if !found.is_dir() => refused("is not a directory".into()),
        Ok(_) => match std::fs::read_dir(dir) {
            Ok(mut entries) => match entries.next() {
                None => Ok(()),
                Some(Ok(_)) => refused("is not empty".into()),
                Some(Err(error)) => refused(format!("cannot be read ({error})")),
            },
            Err(error) => refused(format!("cannot be read ({error})")),
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
    let mark = state_dir
        .entry_identity(Path::new("core.sqlite"))
        .map_err(|error| CoreError::Store(error.to_string()))?;
    let folder = settings_file::bound(core)?;
    let id = store::meta_get(&*core.conn()?, META_STORE)?;
    Ok((folder, store_key(mark, id.as_deref()), id))
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
    if !others.iter().any(|other| other.dir == target) {
        return Ok((None, alike));
    }
    let held = if listed {
        Vec::new()
    } else {
        held.into_iter()
            .filter_map(|row| match row.kept {
                Some(state::Kept::Unsure(unsure)) if unsure.waits_on(target) => Some(HeldFile {
                    path: row.path,
                    item: row.item_id,
                    missing_since: row.missing_since,
                    reason: unsure.reason,
                }),
                _ => None,
            })
            .collect()
    };
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
const NOT_LISTED: &str =
    "the registry no longer lists it as the folder that was shown, so nothing in it was changed";

/// Forgets `target` in the folder `holder` names, under its writer lock,
/// and answers the paths released and whether the registry lists `target`;
/// or why nothing in it changed.
fn forget_in(
    holder: &Remembering,
    target: &Path,
    wait: Duration,
) -> std::result::Result<(Vec<String>, bool), String> {
    let is_holder = |entry: &Registered| entry.dir == holder.dir && entry.folder == holder.folder;
    let entry = listed()
        .map_err(|error| because("the folder registry cannot be read")(&error))?
        .into_iter()
        .find(is_holder)
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
    // Compared before any open that can write, which tidies the store.
    let read = Core::read_directory(&state_dir, &label)
        .and_then(|core| bound_store(&core, &state_dir))
        .map_err(|error| because("its saved state cannot be read")(&error))?;
    if read.0.as_deref() != Some(holder.folder.as_str()) || read.1 != holder.store {
        return Err(NOT_SHOWN.into());
    }
    let core = Core::open_claimed(&state_dir, &label, None, Arc::new(lock))
        .map_err(|error| because("its saved state cannot be opened")(&error))?;
    (|| -> Result<std::result::Result<(Vec<String>, bool), String>> {
        let (folder, store, _) = bound_store(&core, &state_dir)?;
        if folder.as_deref() != Some(holder.folder.as_str()) || store != holder.store {
            return Ok(Err(NOT_SHOWN.into()));
        }
        let conn = core.conn()?;
        let commit = |listed: &[Registered]| -> Result<std::result::Result<_, String>> {
            if !listed.iter().any(is_holder) {
                return Ok(Err(NOT_LISTED.into()));
            }
            // Listed, the directory stays a folder every pass reads, so
            // nothing held for it is decided again.
            let target_listed = listed.iter().any(|entry| entry.dir == target);
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
            for file in holder.held.iter().filter(|_| !target_listed) {
                let still = state::journaled_at(&tx, &file.path, &file.item)?.is_some_and(|row| {
                    row.missing_since == file.missing_since
                        && matches!(row.kept, Some(state::Kept::Unsure(unsure)) if unsure.waits_on(target))
                });
                if still {
                    state::journal_keep(&tx, &file.path, &file.item, None)?;
                    if !released.contains(&file.path) {
                        released.push(file.path.clone());
                    }
                }
            }
            tx.commit()?;
            Ok(Ok((released, target_listed)))
        };
        match Registry::located() {
            Some(registry) => registry.while_listed(commit)?,
            None => commit(&[]),
        }
    })()
    .map_err(|error| because("it could not be changed")(&error))?
}

fn remembered_in(conn: &Connection) -> Result<Vec<Registered>> {
    match store::meta_get(conn, META_OTHERS)? {
        Some(json) => serde_json::from_str(&json).map_err(|error| {
            CoreError::Store(format!("what it remembers cannot be read ({error})"))
        }),
        None => Ok(Vec::new()),
    }
}

/// Which store was read: its file and the id it holds.
fn store_key(mark: (u64, u64), id: Option<&str>) -> String {
    format!("{}:{}:{}", mark.0, mark.1, id.unwrap_or_default())
}

fn alike(one: &Path, other: &Path) -> bool {
    one.to_string_lossy().to_lowercase() == other.to_string_lossy().to_lowercase()
}
