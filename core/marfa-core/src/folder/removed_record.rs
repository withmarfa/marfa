//! Removal records and first-sync decisions for a directory added back in place.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;

use rustix::fs::{Mode, OFlags};
use serde::{Deserialize, Serialize};

use super::{Folder, retained, state};
use crate::directory::Directory;
use crate::model::Item;
use crate::{CoreError, Result, store};

pub const RECORD: &str = "removed.json";
/// How a held file's reason starts.
pub(super) const RESTORED_ELSEWHERE: &str =
    "this folder last synced it with another instance, and ";
pub(super) const AS_NEW: &str =
    "; to send it as a new item, take out its marfa_id line, or delete it to keep the instance's";
const STAGED: &str = "removed.json.tmp";
const FORMAT: u32 = 1;
const LIMIT: u64 = 256 * 1024 * 1024;

#[derive(Debug, Serialize, Deserialize)]
struct Record {
    format: u32,
    folder: String,
    /// The instance the folder last synced with.
    instance: String,
    files: Vec<Sent>,
}

/// A file's item as its server last acknowledged it.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Sent {
    path: String,
    item: String,
    version: i64,
    /// `None` where a change to the file was never acknowledged.
    hash: Option<String>,
}

/// What a removal did besides deleting the folder's state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Removed {
    pub unsent: super::UnsentChanges,
    /// Whether another instance answers at the folder's server.
    pub instance_changed: bool,
    /// How many files the record names; `None` where the first sync waited,
    /// which agreed nothing with the server.
    pub recorded: Option<usize>,
}

/// What a folder knows of the record in its own `.marfa`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case", tag = "record", content = "reason")]
pub enum Known {
    None,
    /// A record that cannot be read, or one of another folder.
    Unknown(String),
    /// The folder last synced with the instance that answers now.
    SameInstance,
    /// The folder last synced with another instance.
    OtherInstance,
}

/// What the first sync does with a file the record names, decided before
/// the sync runs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case", tag = "outcome")]
pub enum Foreseen {
    /// The instance holds the item as the restore left it, an earlier
    /// version than the folder sent: the file is sent as an edit of it.
    Send {
        held: i64,
        sent: i64,
    },
    /// The instance changed the item since the restore: a file that differs
    /// is merged from the last version both hold, keeping both edits.
    Both {
        held: i64,
        shared: i64,
    },
    /// The folder on the instance holds no item for the file.
    Absent,
    /// The record cannot tell which version both hold.
    Unsure {
        reason: String,
    },
    Gone,
    Unreadable {
        reason: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ForeseenFile {
    pub path: String,
    #[serde(flatten)]
    pub outcome: Foreseen,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Foresight {
    #[serde(flatten)]
    pub known: Known,
    pub files: Vec<ForeseenFile>,
}

/// A file a scan sent as the removal record decided, named in its report.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SentByRecord {
    pub path: String,
    /// The version the edit names.
    pub base: i64,
    /// Whether the instance still held that version as the restore left it.
    pub over_restored: bool,
}

/// How the first sync sends a file whose item the record names.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Basis {
    /// As an edit of the current version, which the server refuses once the
    /// item moves past it.
    Exact(i64),
    /// As an edit of an earlier version both hold, which the server merges.
    Merge(i64),
    Unsure(String),
}

/// A record of another instance, as a scan reads it.
pub(super) struct Evidence {
    /// When the instance that answers now was made, in Unix milliseconds.
    born: Option<i64>,
    files: HashMap<String, Sent>,
}

impl Evidence {
    pub(super) fn names(&self, item: &str) -> bool {
        self.files.contains_key(item)
    }

    pub(super) fn items(&self) -> impl Iterator<Item = &str> {
        self.files.keys().map(String::as_str)
    }
}

impl Folder {
    /// Writes the record and makes it durable, before the removal clears
    /// anything. Answers how many files it names.
    pub(super) fn write_removal_record(&self) -> Result<usize> {
        let conn = self.core.conn()?;
        let instance = store::meta_get(&conn, store::META_INSTANCE_ID)?.unwrap_or_default();
        let bound = state::every_bound(&conn)?;
        let ids: Vec<String> = bound.iter().map(|row| row.item_id.clone()).collect();
        let versions: HashMap<String, i64> = store::items_by_ids(&conn, &ids)?
            .into_iter()
            .map(|item| (item.id, item.version))
            .collect();
        let mut files = Vec::new();
        for row in bound {
            // Version 0 is a create the server never answered.
            let Some(&version) = versions.get(&row.item_id).filter(|version| **version > 0) else {
                continue;
            };
            let hash = (!store::item_waits(&conn, &row.item_id)?).then_some(row.content_hash);
            files.push(Sent {
                path: row.path,
                item: row.item_id,
                version,
                hash,
            });
        }
        drop(conn);
        let count = files.len();
        let bytes = serde_json::to_vec(&Record {
            format: FORMAT,
            folder: self.folder.clone(),
            instance,
            files,
        })?;
        durable_write(&self.state_dir, &bytes).map_err(|error| {
            CoreError::Store(format!(
                "cannot write the removal record into {}: {error}; nothing was removed",
                self.root.join(super::STATE_DIR).display()
            ))
        })?;
        Ok(count)
    }

    pub(super) fn drop_removal_record(&self) {
        let _ = self.state_dir.unlink(Path::new(RECORD));
    }

    /// What the record in `.marfa` says of the instance the copy follows.
    fn read_evidence(&self) -> Result<(Known, Option<Record>)> {
        let record = match read(&self.state_dir) {
            Ok(None) => return Ok((Known::None, None)),
            Ok(Some(record)) => record,
            Err(reason) => return Ok((Known::Unknown(reason), None)),
        };
        if record.folder != self.folder {
            return Ok((
                Known::Unknown(format!(
                    "its removal record is of the folder {}, not this one",
                    record.folder
                )),
                None,
            ));
        }
        let now = store::meta_get(&*self.core.conn()?, store::META_INSTANCE_ID)?;
        Ok(match now {
            Some(now) if now == record.instance => (Known::SameInstance, None),
            Some(_) => (Known::OtherInstance, Some(record)),
            None => (
                Known::Unknown("the instance it follows has not been read yet".into()),
                None,
            ),
        })
    }

    /// The record's files, where the folder last synced with another instance.
    pub(super) fn restore_evidence(&self) -> Result<Option<Evidence>> {
        let (_, record) = self.read_evidence()?;
        let Some(record) = record else {
            return Ok(None);
        };
        let born = store::meta_get(&*self.core.conn()?, store::META_INSTANCE_ID)?
            .as_deref()
            .and_then(born_ms);
        Ok(Some(Evidence {
            born,
            files: record
                .files
                .into_iter()
                .map(|file| (file.item.clone(), file))
                .collect(),
        }))
    }

    /// The version the file and the instance last both held, and how to send
    /// the file from it. `line` is the file's version line.
    pub(super) fn restored_basis(
        &self,
        evidence: &Evidence,
        item: &Item,
        line: Option<i64>,
    ) -> Option<Basis> {
        let sent = evidence.files.get(&item.id)?;
        let file_base = line.map_or(sent.version, |line| line.min(sent.version));
        let Some(born) = evidence.born else {
            return Some(Basis::Unsure(
                "the instance's ID does not say when it was made".into(),
            ));
        };
        let shared = match self.shared_version(born, item) {
            Ok(Some(shared)) => shared,
            Ok(None) => {
                return Some(Basis::Unsure(
                    "the instance holds no version of it from before the restore".into(),
                ));
            }
            Err(error) => {
                return Some(Basis::Unsure(format!(
                    "the instance's history of it could not be read: {error}"
                )));
            }
        };
        let base = shared.min(file_base);
        Some(if base < 1 {
            Basis::Unsure("the file names no version the instance holds".into())
        } else if base == item.version {
            Basis::Exact(base)
        } else {
            Basis::Merge(base)
        })
    }

    /// The newest version of `item` the instance holds from before it was
    /// made: one its restore brought, which no later write changed. `None`
    /// where the instance wrote every version itself.
    fn shared_version(&self, born: i64, item: &Item) -> Result<Option<i64>> {
        if before(&item.updated_at, born) {
            return Ok(Some(item.version));
        }
        if !before(&item.created_at, born) {
            return Ok(None);
        }
        let mut shared = 1;
        // A snapshot is made when the version after it is written.
        for (version, left_at) in self.core.http()?.version_history(&item.id)? {
            if !before(&left_at, born) {
                break;
            }
            shared = version + 1;
        }
        Ok(Some(shared.min(item.version)))
    }

    /// What the first sync will do with each file the record names. Reads
    /// the instance first where a record of this folder is there.
    pub fn restore_foresight(&self) -> Result<Foresight> {
        if read(&self.state_dir).is_ok_and(|record| record.is_none()) {
            return Ok(Foresight {
                known: Known::None,
                files: Vec::new(),
            });
        }
        if let Err(error) = self.resume().and_then(|_| self.catch_up()) {
            return Ok(Foresight {
                known: Known::Unknown(format!("the instance could not be read: {error}")),
                files: Vec::new(),
            });
        }
        let (known, record) = self.read_evidence()?;
        let (Some(record), Some(evidence)) = (record, self.restore_evidence()?) else {
            return Ok(Foresight {
                known,
                files: Vec::new(),
            });
        };
        let ids: Vec<String> = record.files.iter().map(|file| file.item.clone()).collect();
        let held: HashMap<String, Item> = store::items_by_ids(&*self.core.conn()?, &ids)?
            .into_iter()
            .filter(|item| {
                matches!(
                    item.state,
                    crate::model::ItemState::Active | crate::model::ItemState::Archived
                )
            })
            .map(|item| (item.id.clone(), item))
            .collect();
        let mut files = Vec::new();
        for sent in record.files {
            let bytes = match plain_relative(&sent.path)
                .and_then(|relative| self.root_dir.read(relative))
            {
                Ok(bytes) => bytes,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    files.push(ForeseenFile {
                        path: sent.path,
                        outcome: Foreseen::Gone,
                    });
                    continue;
                }
                Err(error) => {
                    files.push(ForeseenFile {
                        path: sent.path,
                        outcome: Foreseen::Unreadable {
                            reason: error.to_string(),
                        },
                    });
                    continue;
                }
            };
            let Some(item) = held.get(&sent.item) else {
                files.push(ForeseenFile {
                    path: sent.path,
                    outcome: Foreseen::Absent,
                });
                continue;
            };
            let line = std::str::from_utf8(&bytes).ok().and_then(version_in);
            let outcome = match self.restored_basis(&evidence, item, line) {
                Some(Basis::Exact(held))
                    if held == sent.version
                        && sent.hash.as_deref() == Some(state::hash(&bytes).as_str()) =>
                {
                    continue;
                }
                Some(Basis::Exact(held)) => Foreseen::Send {
                    held,
                    sent: sent.version,
                },
                Some(Basis::Merge(shared)) => Foreseen::Both {
                    held: item.version,
                    shared,
                },
                Some(Basis::Unsure(reason)) => Foreseen::Unsure { reason },
                None => continue,
            };
            files.push(ForeseenFile {
                path: sent.path,
                outcome,
            });
        }
        Ok(Foresight { known, files })
    }
}

/// Flush the staged file before the rename and the directory afterwards.
fn durable_write(dir: &Directory, bytes: &[u8]) -> std::io::Result<()> {
    let staged = Path::new(STAGED);
    let _ = dir.unlink(staged);
    let mut file = dir.open_file(
        staged,
        OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL,
        Mode::from_raw_mode(0o600),
    )?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    dir.rename(staged, dir, Path::new(RECORD), false)?;
    dir.sync()
}

/// `Ok(None)` where there is no record. Follows no link, and reads only a
/// regular file of a bounded size.
fn read(dir: &Directory) -> std::result::Result<Option<Record>, String> {
    let shown = Path::new(super::STATE_DIR).join(RECORD);
    let unreadable = |error: &dyn std::fmt::Display| {
        format!(
            "its removal record {} cannot be read: {error}",
            shown.display()
        )
    };
    let file = match dir.open_file(Path::new(RECORD), OFlags::RDONLY, Mode::empty()) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(unreadable(&error)),
    };
    let size = file.metadata().map_err(|error| unreadable(&error))?.len();
    if size > LIMIT {
        return Err(unreadable(&format!("it is larger than {LIMIT} bytes")));
    }
    let mut bytes = Vec::new();
    file.take(LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| unreadable(&error))?;
    match serde_json::from_slice::<Record>(&bytes) {
        Ok(record) if record.format == FORMAT => Ok(Some(record)),
        Ok(record) => Err(format!(
            "its removal record {} is of format {}, which this build does not read",
            shown.display(),
            record.format
        )),
        Err(error) => Err(unreadable(&error)),
    }
}

fn plain_relative(path: &str) -> std::io::Result<&Path> {
    if path.is_empty()
        || path
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "the record names a path outside the directory",
        ));
    }
    Ok(Path::new(path))
}

fn version_in(text: &str) -> Option<i64> {
    let range = retained::version_line(text)?;
    let (_, value) = text[range].split_once(':')?;
    value.trim().trim_matches(['"', '\'']).parse().ok()
}

/// When a UUIDv7 was made, in Unix milliseconds.
fn born_ms(id: &str) -> Option<i64> {
    let id = uuid::Uuid::parse_str(id).ok()?;
    if id.get_version_num() != 7 {
        return None;
    }
    let (seconds, nanos) = id.get_timestamp()?.to_unix();
    i64::try_from(seconds)
        .ok()?
        .checked_mul(1000)?
        .checked_add(i64::from(nanos / 1_000_000))
}

/// Whether `stamp` names a moment before `born`; a stamp that does not read
/// is not.
fn before(stamp: &str, born: i64) -> bool {
    marfa_rules::time::read(stamp).is_ok_and(|at| at < born)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_version_seven_id_tells_when_it_was_made() {
        let id = uuid::Uuid::now_v7().to_string();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        let born = born_ms(&id).unwrap();
        assert!((now - born).abs() < 5_000, "{born} against {now}");
        assert_eq!(born_ms("01234567-89ab-4def-8123-456789abcdef"), None);
    }
}
