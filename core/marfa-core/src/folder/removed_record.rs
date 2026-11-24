//! What a folder last sent, kept in its directory's `.marfa` once the folder
//! is removed, so a directory added in its place can name each file whose
//! item the instance holds at an older version and send it
//! (`folder-setup/remove-records-sent`).

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};

use rustix::fs::{Mode, OFlags};
use serde::{Deserialize, Serialize};

use super::{Folder, STATE_DIR, retained, state};
use crate::directory::Directory;
use crate::model::ItemState;
use crate::{Result, store};

/// The record's name in the removed directory's `.marfa`.
pub const RECORD: &str = "removed.json";
const FORMAT: u32 = 1;
/// The files a directory's add named older, with the version it read.
const META_NEWER: &str = "folder_newer_elsewhere";

#[derive(Debug, Serialize, Deserialize)]
struct Record {
    format: u32,
    folder: String,
    /// The instance the folder's copy was filled from.
    instance: Option<String>,
    files: Vec<Sent>,
}

/// A file's item as the folder last agreed it with its server.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Sent {
    path: String,
    item: String,
    version: i64,
    hash: String,
}

/// Whether the removal wrote its record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Recorded {
    /// The record names this many files.
    Written(usize),
    /// Why it could not be written. The removal stands.
    NotWritten(String),
}

/// What a removal did besides deleting the folder's state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Removed {
    pub unsent: super::UnsentChanges,
    /// Whether another instance answers at the folder's server.
    pub instance_changed: bool,
    /// `None` for a folder whose first sync still waited.
    pub recorded: Option<Recorded>,
}

/// What the record in a removed directory says of the instance a directory
/// was added for.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Compared {
    /// The removed directory.
    pub from: PathBuf,
    /// Why nothing is known: no record, one that cannot be read, one of
    /// another folder, or a copy of the instance that could not be read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unknown: Option<String>,
    /// Files whose item the instance holds at an older version than the
    /// folder last sent.
    pub older: Vec<Older>,
    /// Files whose item the folder on the instance does not hold.
    pub absent: Vec<String>,
    /// Files the record names that are no longer in the removed directory.
    pub gone: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Older {
    pub path: String,
    pub item: String,
    /// The version the folder last sent.
    pub sent: i64,
    /// The version the instance holds.
    pub held: i64,
    /// Whether the file changed after the folder last sent it.
    pub changed: bool,
}

/// One file `--send-newer` took up.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SentNewer {
    pub path: String,
    pub outcome: NewerOutcome,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NewerOutcome {
    /// Written into the directory, for the push to send.
    Queued,
    /// The directory's file holds these bytes already.
    Already,
    /// Not in the removed directory any more; nothing sent.
    Gone,
    /// The instance changed the item after the add read it; nothing sent.
    ChangedThere { read: i64, held: i64 },
    /// The directory's file of the item was changed after it was written;
    /// nothing sent.
    ChangedHere,
    /// The directory holds no file of the item yet; a push writes it.
    NotWritten,
}

#[derive(Debug, Serialize, Deserialize)]
struct Newer {
    from: PathBuf,
    files: Vec<Pending>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Pending {
    path: String,
    item: String,
    read: i64,
}

impl Folder {
    /// The record of every bound file whose item the copy holds, as the copy
    /// last had it from the server.
    pub(super) fn sent_record(&self) -> Result<(Vec<u8>, usize)> {
        let conn = self.core.conn()?;
        let bound = state::every_bound(&conn)?;
        let ids: Vec<String> = bound.iter().map(|row| row.item_id.clone()).collect();
        let versions: HashMap<String, i64> = store::items_by_ids(&conn, &ids)?
            .into_iter()
            .map(|item| (item.id, item.version))
            .collect();
        let files: Vec<Sent> = bound
            .into_iter()
            .filter_map(|row| {
                Some(Sent {
                    version: *versions.get(&row.item_id)?,
                    path: row.path,
                    item: row.item_id,
                    hash: row.content_hash,
                })
            })
            .collect();
        let count = files.len();
        let record = Record {
            format: FORMAT,
            folder: self.folder.clone(),
            instance: store::meta_get(&conn, store::META_INSTANCE_ID)?,
            files,
        };
        Ok((serde_json::to_vec_pretty(&record)?, count))
    }

    /// Reads the record in `from`'s `.marfa` against the copy, caught up
    /// first, and keeps the older files for `send_newer`.
    pub fn compare_removed(&self, from: &Path) -> Result<Compared> {
        let from = std::path::absolute(from).map_err(super::io_error)?;
        let mut compared = Compared {
            from: from.clone(),
            ..Compared::default()
        };
        let record = match read(&from) {
            Ok(record) if record.folder == self.folder => record,
            Ok(record) => {
                compared.unknown = Some(format!(
                    "its record is of the folder {}, not this one",
                    record.folder
                ));
                return Ok(compared);
            }
            Err(reason) => {
                compared.unknown = Some(reason);
                return Ok(compared);
            }
        };
        if let Err(error) = self.resume().and_then(|_| self.catch_up()) {
            compared.unknown = Some(format!("the instance could not be read: {error}"));
            return Ok(compared);
        }
        let ids: Vec<String> = record.files.iter().map(|file| file.item.clone()).collect();
        let held: HashMap<String, i64> = store::items_by_ids(&*self.core.conn()?, &ids)?
            .into_iter()
            .filter(|item| matches!(item.state, ItemState::Active | ItemState::Archived))
            .map(|item| (item.id, item.version))
            .collect();
        let mut pending = Vec::new();
        for file in record.files {
            let Some(bytes) = file_at(&from, &file.path) else {
                compared.gone.push(file.path);
                continue;
            };
            let Some(&version) = held.get(&file.item) else {
                compared.absent.push(file.path);
                continue;
            };
            if version < file.version {
                pending.push(Pending {
                    path: file.path.clone(),
                    item: file.item.clone(),
                    read: version,
                });
                compared.older.push(Older {
                    changed: state::hash(&bytes) != file.hash,
                    path: file.path,
                    item: file.item,
                    sent: file.version,
                    held: version,
                });
            }
        }
        let conn = self.core.conn()?;
        if pending.is_empty() {
            store::meta_delete(&conn, META_NEWER)?;
        } else {
            store::meta_set(
                &conn,
                META_NEWER,
                &serde_json::to_string(&Newer {
                    from,
                    files: pending,
                })?,
            )?;
        }
        Ok(compared)
    }

    /// Writes each file the add named older from the removed directory over
    /// the directory's file of its item, where the instance still holds the
    /// version the add read and the file is as the folder wrote it, so the
    /// next scan sends it conditional on that version. Answers `None` where
    /// no add named a file.
    pub fn send_newer(&self) -> Result<Option<Vec<SentNewer>>> {
        self.refuse_if_gone()?;
        self.refuse_while_waiting()?;
        let Some(newer) = store::meta_get(&*self.core.conn()?, META_NEWER)?
            .and_then(|json| serde_json::from_str::<Newer>(&json).ok())
        else {
            return Ok(None);
        };
        // Out of reach, the copy stands: the edit still names the version read.
        match self.catch_up() {
            Ok(_) => {}
            Err(error) if error.is_environmental() => {}
            Err(error) => return Err(error),
        }
        let mut said = Vec::new();
        let mut left = Vec::new();
        for file in newer.files {
            let outcome = self.send_one(&newer.from, &file)?;
            if matches!(
                outcome,
                NewerOutcome::NotWritten | NewerOutcome::ChangedHere
            ) {
                left.push(file.clone());
            }
            said.push(SentNewer {
                path: file.path,
                outcome,
            });
        }
        let conn = self.core.conn()?;
        if left.is_empty() {
            store::meta_delete(&conn, META_NEWER)?;
        } else {
            store::meta_set(
                &conn,
                META_NEWER,
                &serde_json::to_string(&Newer {
                    from: newer.from,
                    files: left,
                })?,
            )?;
        }
        Ok(Some(said))
    }

    fn send_one(&self, from: &Path, file: &Pending) -> Result<NewerOutcome> {
        let Some(mut bytes) = file_at(from, &file.path) else {
            return Ok(NewerOutcome::Gone);
        };
        let (row, held) = {
            let conn = self.core.conn()?;
            (
                state::bound_to_item(&conn, &file.item)?,
                store::items_by_ids(&conn, std::slice::from_ref(&file.item))?
                    .pop()
                    .map(|item| item.version),
            )
        };
        let held = held.unwrap_or_default();
        if held != file.read {
            return Ok(NewerOutcome::ChangedThere {
                read: file.read,
                held,
            });
        }
        let Some(row) = row else {
            return Ok(NewerOutcome::NotWritten);
        };
        let Ok(here) = self.root_dir.read(Path::new(&row.path)) else {
            return Ok(NewerOutcome::NotWritten);
        };
        // The version line names the version read, so the scan sends the
        // file whole, as an edit of that version.
        if let Ok(text) = std::str::from_utf8(&bytes)
            && let Some(line) = retained::version_line(text)
        {
            let ending = if text[line.clone()].ends_with("\r\n") {
                "\r\n"
            } else {
                "\n"
            };
            bytes = [
                &text[..line.start],
                &format!("{}: {}{ending}", super::fields::VERSION_FIELD, file.read),
                &text[line.end..],
            ]
            .concat()
            .into_bytes();
        }
        if here == bytes {
            return Ok(NewerOutcome::Already);
        }
        let here_hash = state::hash(&here);
        if here_hash != row.content_hash && row.written_hash.as_deref() != Some(&here_hash) {
            return Ok(NewerOutcome::ChangedHere);
        }
        replace(&self.root_dir, Path::new(&row.path), &bytes).map_err(super::io_error)?;
        Ok(NewerOutcome::Queued)
    }
}

/// Writes the record into the removed directory's `.marfa`, whose state the
/// removal cleared.
pub(super) fn write(state_dir: &Directory, record: &[u8]) -> Result<()> {
    replace(state_dir, Path::new(RECORD), record).map_err(super::io_error)
}

fn read(from: &Path) -> std::result::Result<Record, String> {
    let path = from.join(STATE_DIR).join(RECORD);
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(format!(
                "{} holds no record of what its folder sent, as a directory removed by an earlier build does not",
                from.display()
            ));
        }
        Err(error) => {
            return Err(format!(
                "its record {} cannot be read: {error}",
                path.display()
            ));
        }
    };
    match serde_json::from_slice::<Record>(&bytes) {
        Ok(record) if record.format == FORMAT => Ok(record),
        Ok(record) => Err(format!(
            "its record {} is of format {}, which this build does not read",
            path.display(),
            record.format
        )),
        Err(error) => Err(format!(
            "its record {} cannot be read: {error}",
            path.display()
        )),
    }
}

/// The bytes of the regular file at `relative` under `from`, following no
/// link; `None` where there is none.
fn file_at(from: &Path, relative: &str) -> Option<Vec<u8>> {
    if relative
        .split('/')
        .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return None;
    }
    Directory::open(from).ok()?.read(Path::new(relative)).ok()
}

/// Replaces the file at `relative` in `dir` in one step, as an editor saves.
fn replace(dir: &Directory, relative: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let (parent, name) = dir.parent(relative, false)?;
    let staged = PathBuf::from(format!(".marfa-{}-sending.tmp", std::process::id()));
    let _ = parent.unlink(&staged);
    let mut file = parent.open_file(
        &staged,
        OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL,
        Mode::from_raw_mode(0o666),
    )?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    parent.rename(&staged, &parent, Path::new(&name), false)
}
