//! The record a removal leaves, and what a directory added back in place
//! does with the files it names.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;

use rustix::fs::{Mode, OFlags};
use serde::{Deserialize, Serialize};

use super::{
    BoundFiles, Catalog, EdgeTypes, Folder, Item, ItemState, Names, Scanned, carries_frontmatter,
    document, fields, state,
};
use crate::directory::Directory;
use crate::{CoreError, Result, store};

pub const RECORD: &str = "removed.json";
const STAGED: &str = "removed.json.tmp";
const FORMAT: u32 = 2;
const LIMIT: u64 = 64 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    format: u32,
    folder: String,
    files: Vec<Sent>,
}

/// A file's item as the instance it last synced with acknowledged it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Sent {
    path: String,
    item: String,
    /// `None` where the copy never read which instance it followed.
    instance: Option<String>,
    version: i64,
    /// The hash of the file as the folder wrote it at `version`; `None`
    /// where the file was not that.
    hash: Option<String>,
}

/// What a removal did besides deleting the folder's state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Removed {
    pub unsent: super::UnsentChanges,
    /// Whether another instance answers at the folder's server.
    pub instance_changed: bool,
    /// How many files the record names; `None` where none was written, as
    /// when the first sync still waited.
    pub recorded: Option<usize>,
}

/// What a folder knows of the record in its own `.marfa`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case", tag = "record", content = "reason")]
pub enum Known {
    None,
    /// A record that cannot be read or is of another folder: every file
    /// carrying a `marfa_id` line is judged as one of another instance.
    Unknown(String),
    /// Every file it names last synced with the instance that answers now.
    SameInstance,
    /// Some file it names last synced with another instance.
    OtherInstance,
}

/// What the first sync does with a file the record names.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    /// The file shows what the instance holds now: it is bound, and nothing
    /// is sent.
    InStep,
    /// The file differs from what the instance holds now: it is kept and
    /// waits, and the item's own file shows the instance's version.
    Both,
    /// The instance holds no item for it, or one the folder does not show:
    /// the file waits.
    Absent,
    /// The file cannot be judged now: it waits.
    Unknown,
    Gone,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ForeseenFile {
    pub path: String,
    pub outcome: Outcome,
    /// The version the instance holds now.
    pub held: Option<i64>,
    /// The version the folder last synced with the other instance.
    pub sent: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl ForeseenFile {
    /// Whether the instance holds the item at an older version than the
    /// folder last synced.
    pub fn older(&self) -> bool {
        self.held
            .zip(self.sent)
            .is_some_and(|(held, sent)| held < sent)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Foresight {
    #[serde(flatten)]
    pub known: Known,
    pub files: Vec<ForeseenFile>,
}

/// A file a scan judged by the record, as the sync left it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RestoredFile {
    pub path: String,
    pub outcome: Outcome,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item: Option<String>,
    /// Where the file was moved to, out of its item's way.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kept_as: Option<String>,
    /// Where the directory shows the instance's version of the item, once a
    /// pull has written it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instance_file: Option<String>,
}

/// The record as a scan reads it.
pub(super) struct Restore {
    unknown: bool,
    /// The instance that answers now.
    now: Option<String>,
    by_path: HashMap<String, Sent>,
    by_item: HashMap<String, Vec<Sent>>,
}

/// How the record covers one file.
pub(super) enum Cover {
    /// Judged as the ordinary engine judges it.
    Ordinary,
    /// Judged by the record: the item it names, where it names one.
    Judged(Option<String>),
}

impl Restore {
    fn of_other(&self, sent: &Sent) -> bool {
        self.now.is_none() || sent.instance.is_none() || sent.instance != self.now
    }

    /// `bare` says the file cannot carry a `marfa_id` line, so only its path
    /// names its item; a document whose line was taken out is new.
    pub(super) fn cover(&self, key: &str, id: Option<&str>, bare: bool) -> Cover {
        if self.unknown {
            return match id {
                Some(id) => Cover::Judged(Some(id.to_string())),
                None => Cover::Ordinary,
            };
        }
        if let Some(sent) = self.by_path.get(key)
            && id.map_or(bare, |id| id == sent.item)
        {
            return if self.of_other(sent) {
                Cover::Judged(Some(sent.item.clone()))
            } else {
                Cover::Ordinary
            };
        }
        match id.and_then(|id| self.by_item.get(id)) {
            Some(sent) if sent.iter().any(|sent| self.of_other(sent)) => {
                Cover::Judged(id.map(str::to_string))
            }
            _ => Cover::Ordinary,
        }
    }
}

impl Folder {
    /// Writes the record and makes it durable, before the removal clears
    /// anything. An earlier record's files that this copy did not bind stay
    /// in it. Answers how many files it names, and the earlier record's
    /// bytes, to put back where the removal is refused after.
    pub(super) fn write_removal_record(&self) -> Result<(usize, Option<Vec<u8>>)> {
        let earlier = match read_bytes(&self.state_dir) {
            Ok(earlier) => earlier,
            Err(reason) => {
                return Err(CoreError::Invalid(format!(
                    "{reason}; this removal would replace it, so nothing was removed: delete it to remove the folder"
                )));
            }
        };
        let mut files = Vec::new();
        {
            let conn = self.core.conn()?;
            let instance = store::meta_get(&conn, store::META_INSTANCE_ID)?;
            let bound = state::every_bound(&conn)?;
            let ids: Vec<String> = bound.iter().map(|row| row.item_id.clone()).collect();
            let versions: HashMap<String, i64> = store::items_by_ids(&conn, &ids)?
                .into_iter()
                .map(|item| (item.id, item.version))
                .collect();
            for row in &bound {
                // Version 0 is a create the server never answered.
                let Some(&version) = versions.get(&row.item_id).filter(|version| **version > 0)
                else {
                    continue;
                };
                files.push(Sent {
                    path: row.path.clone(),
                    item: row.item_id.clone(),
                    instance: instance.clone(),
                    version,
                    hash: acknowledged_hash(&conn, row)?,
                });
            }
        }
        if let Some(earlier) = &earlier {
            let earlier = parse(earlier).map_err(|reason| {
                CoreError::Invalid(format!(
                    "{reason}; this removal would replace it, so nothing was removed: delete it to remove the folder"
                ))
            })?;
            if earlier.folder == self.folder {
                let bound: std::collections::HashSet<String> =
                    files.iter().map(|sent| sent.path.clone()).collect();
                files.extend(
                    earlier
                        .files
                        .into_iter()
                        .filter(|sent| !bound.contains(&sent.path)),
                );
            }
        }
        let record = Record {
            format: FORMAT,
            folder: self.folder.clone(),
            files,
        };
        let bytes = serde_json::to_vec(&record)?;
        check(&record, bytes.len() as u64).map_err(|reason| {
            CoreError::Invalid(format!(
                "the removal record could not be written, because {reason}; nothing was removed"
            ))
        })?;
        durable_write(&self.state_dir, &bytes).map_err(|error| {
            CoreError::Store(format!(
                "cannot write the removal record into {}: {error}; nothing was removed",
                self.root.join(super::STATE_DIR).display()
            ))
        })?;
        Ok((record.files.len(), earlier))
    }

    /// Puts back the record a refused removal replaced, or deletes the one it
    /// wrote.
    pub(super) fn put_back_removal_record(&self, earlier: Option<&[u8]>) {
        match earlier {
            Some(bytes) => {
                let _ = durable_write(&self.state_dir, bytes);
            }
            None => {
                let _ = self.state_dir.unlink(Path::new(RECORD));
            }
        }
    }

    pub(super) fn retire_removal_record(&self) {
        let _ = self.state_dir.unlink(Path::new(RECORD));
        let _ = self.state_dir.sync();
    }

    /// The record as the scan judges files by it; `None` where there is none.
    pub(super) fn removal_record(&self) -> Result<Option<Restore>> {
        let record = match read(&self.state_dir) {
            Ok(None) => return Ok(None),
            Ok(Some(record)) if record.folder == self.folder => Some(record),
            Ok(Some(_)) | Err(_) => None,
        };
        let now = store::meta_get(&*self.core.conn()?, store::META_INSTANCE_ID)?;
        let Some(record) = record else {
            return Ok(Some(Restore {
                unknown: true,
                now,
                by_path: HashMap::new(),
                by_item: HashMap::new(),
            }));
        };
        let mut by_item: HashMap<String, Vec<Sent>> = HashMap::new();
        for sent in &record.files {
            by_item
                .entry(sent.item.clone())
                .or_default()
                .push(sent.clone());
        }
        Ok(Some(Restore {
            unknown: false,
            now,
            by_path: record
                .files
                .into_iter()
                .map(|sent| (sent.path.clone(), sent))
                .collect(),
            by_item,
        }))
    }

    /// Whether `file` shows what the instance holds of `item` now, its version
    /// line apart. Anything that cannot be told is a difference.
    pub(super) fn shows_as_held(
        &self,
        item: &Item,
        file: &Scanned,
        catalog: &Catalog,
        edge_types: &EdgeTypes,
    ) -> Result<bool> {
        if super::bytes_of(item, catalog).is_some() {
            return Ok(self.holds_bytes(item, file, catalog));
        }
        if file.unreadable.is_some() || file.deferred {
            return Ok(false);
        }
        let names = Names::load(&*self.core.conn()?, catalog, &BoundFiles)?;
        let document = file.document();
        let rendered = self.render(
            item,
            &file.key,
            Some(item.version),
            catalog,
            edge_types,
            (&names, Some(&document), &[]),
        )?;
        let Ok(text) = rendered.text else {
            return Ok(false);
        };
        let held = if carries_frontmatter(&file.path) {
            document::read(&text)
        } else {
            document::read_body(&text)
        };
        let unversioned = |shown: document::Presentation| shown.with(fields::VERSION_FIELD, None);
        Ok(unversioned(held.presentation())
            .agrees(&unversioned(document.presentation()), edge_types))
    }

    /// The item a judged file is weighed against: held, out of the bin and in
    /// the folder's query. `None` where the instance shows the folder none.
    pub(super) fn held_for_restore(
        &self,
        id: &str,
        members: &std::collections::HashSet<String>,
    ) -> Result<Option<Item>> {
        Ok(self.core.get(id)?.filter(|item| {
            matches!(item.state, ItemState::Active | ItemState::Archived)
                && members.contains(&item.id)
        }))
    }

    /// How a file the record judges goes, with what cannot be told of it
    /// where that is why it waits. `claimed` is the item the scan gave the
    /// file, `named` the one the record names.
    pub(super) fn judge_restored(
        &self,
        file: &Scanned,
        claimed: Option<&str>,
        named: Option<&str>,
        members: &std::collections::HashSet<String>,
        catalog: &Catalog,
        edge_types: &EdgeTypes,
    ) -> Result<(Outcome, Option<&'static str>)> {
        if claimed
            .zip(named)
            .is_some_and(|(claimed, named)| claimed != named)
        {
            return Ok((
                Outcome::Unknown,
                Some("it carries another item's marfa_id than the one it was synced as"),
            ));
        }
        let Some(id) = claimed.or(named) else {
            return Ok((Outcome::Unknown, Some("it names no item")));
        };
        let Some(held) = self.held_for_restore(id, members)? else {
            return Ok((Outcome::Absent, None));
        };
        if file.deferred || file.unreadable.is_some() {
            return Ok((Outcome::Unknown, Some("it cannot be read now")));
        }
        if claimed.is_none() {
            // Another file here is that item's, or the bytes are not its own.
            return Ok((Outcome::Both, None));
        }
        Ok(if self.shows_as_held(&held, file, catalog, edge_types)? {
            (Outcome::InStep, None)
        } else {
            (Outcome::Both, None)
        })
    }

    /// Moves a file the record keeps out of its item's way, to a numbered
    /// name beside it, so the pull writes the instance's version at the path.
    /// The record names the new path first, so the file is judged there and
    /// never sent. Answers the new path; `None` where the file stays, as in a
    /// first sync not yet confirmed or where the item has a file already.
    pub(super) fn set_restored_aside(&self, file: &Scanned, item: &str) -> Result<Option<String>> {
        if self.awaiting_confirmation()?
            || state::bound_to_item(&*self.core.conn()?, item)?.is_some()
        {
            return Ok(None);
        }
        let taken = |candidate: &str, record: Option<&Record>| {
            self.exists(self.root.join(candidate))
                || record
                    .is_some_and(|record| record.files.iter().any(|sent| sent.path == candidate))
        };
        let aside = match read(&self.state_dir) {
            Ok(Some(mut record)) if record.folder == self.folder => {
                let Some(sent) = record
                    .files
                    .iter()
                    .find(|sent| sent.path == file.key && sent.item == item)
                    .or_else(|| record.files.iter().find(|sent| sent.item == item))
                    .cloned()
                else {
                    return Ok(None);
                };
                let aside = super::placement::beside(&file.key, |candidate| {
                    taken(candidate, Some(&record))
                });
                record.files.push(Sent {
                    path: aside.clone(),
                    hash: None,
                    ..sent
                });
                let written = serde_json::to_vec(&record)?;
                if check(&record, written.len() as u64).is_err()
                    || durable_write(&self.state_dir, &written).is_err()
                {
                    return Ok(None);
                }
                aside
            }
            Ok(None) => return Ok(None),
            // A record that cannot be read judges every file by its
            // marfa_id line, which the moved file keeps.
            _ if file.id.as_deref() == Some(item) => {
                super::placement::beside(&file.key, |candidate| taken(candidate, None))
            }
            _ => return Ok(None),
        };
        match super::landing::rename_new_at(
            &self.root_dir,
            Path::new(&file.key),
            &self.root_dir,
            Path::new(&aside),
        ) {
            Ok(()) => Ok(Some(aside)),
            Err(_) => Ok(None),
        }
    }

    /// Where the directory shows the instance's version of each item kept
    /// beside a file, as the pull left it.
    pub(super) fn locate_restored(&self, restored: &mut [RestoredFile]) -> Result<()> {
        let conn = self.core.conn()?;
        for file in restored
            .iter_mut()
            .filter(|file| file.kept_as.is_some() || file.outcome == Outcome::Both)
        {
            if let Some(item) = &file.item {
                file.instance_file = state::bound_to_item(&conn, item)?.map(|bound| bound.path);
            }
        }
        Ok(())
    }

    /// What the first sync will do with each file the record names. Reads
    /// the instance first where a record is there.
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
        let record = match read(&self.state_dir) {
            Ok(Some(record)) if record.folder == self.folder => record,
            Ok(Some(record)) => {
                return Ok(Foresight {
                    known: Known::Unknown(format!(
                        "its removal record is of the folder {}, not this one",
                        record.folder
                    )),
                    files: Vec::new(),
                });
            }
            Ok(None) => {
                return Ok(Foresight {
                    known: Known::None,
                    files: Vec::new(),
                });
            }
            Err(reason) => {
                return Ok(Foresight {
                    known: Known::Unknown(reason),
                    files: Vec::new(),
                });
            }
        };
        let Some(restore) = self.removal_record()? else {
            return Ok(Foresight {
                known: Known::None,
                files: Vec::new(),
            });
        };
        let (catalog, edge_types) = {
            let conn = self.core.conn()?;
            (crate::catalog::load(&conn)?, EdgeTypes::load(&conn)?)
        };
        let members = self.members(&self.settings()?)?;
        let mut files = Vec::new();
        for sent in &record.files {
            if !restore.of_other(sent) {
                continue;
            }
            let held = self.held_for_restore(&sent.item, &members)?;
            let mut foreseen = ForeseenFile {
                path: sent.path.clone(),
                outcome: Outcome::Unknown,
                held: held.as_ref().map(|item| item.version),
                sent: Some(sent.version),
                reason: None,
            };
            let file = match plain_relative(&sent.path)
                .and_then(|relative| self.root_dir.read(relative))
            {
                Ok(bytes) => Scanned::alone(&self.root, &sent.path, bytes, &edge_types),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    foreseen.outcome = Outcome::Gone;
                    files.push(foreseen);
                    continue;
                }
                Err(error) => {
                    foreseen.reason = Some(error.to_string());
                    files.push(foreseen);
                    continue;
                }
            };
            let claimed = file.id.clone().unwrap_or_else(|| sent.item.clone());
            let (outcome, detail) = self.judge_restored(
                &file,
                Some(&claimed),
                Some(&sent.item),
                &members,
                &catalog,
                &edge_types,
            )?;
            foreseen.outcome = outcome;
            foreseen.reason = detail.map(str::to_string);
            files.push(foreseen);
        }
        let known = if files.is_empty() && record.files.iter().all(|sent| !restore.of_other(sent)) {
            Known::SameInstance
        } else {
            Known::OtherInstance
        };
        Ok(Foresight { known, files })
    }
}

/// Why a file the record judged waits.
pub(super) fn restored_reason(outcome: Outcome, detail: Option<&str>, carries_id: bool) -> String {
    let as_new = if carries_id {
        "take out its marfa_id line"
    } else {
        "move or rename it"
    };
    let why = match outcome {
        Outcome::Both => "the instance holds a different version of its item now. It is kept as it is and not sent, and the item's own file shows the instance's version. Copy what you want to keep into that file, then delete this one".to_string(),
        Outcome::Absent => "the folder on the instance holds no item for it. It is not sent".to_string(),
        _ => format!(
            "{}. It is not sent, and nothing on the instance is changed",
            detail.unwrap_or("what the instance holds of it cannot be told")
        ),
    };
    format!(
        "this directory last synced it with another instance, and {why}; to send it as a new item, {as_new}"
    )
}

/// A hash only for bytes the folder itself wrote at the version the server
/// last acknowledged, with nothing of the file held, refused or waiting.
fn acknowledged_hash(conn: &rusqlite::Connection, row: &state::Bound) -> Result<Option<String>> {
    let agreed = row.held.is_none()
        && !row.holds_refusal()
        && row.written_hash.as_deref() == Some(row.content_hash.as_str())
        && state::untaken_read_version(&row.content_hash).is_none()
        && !store::item_waits(conn, &row.item_id)?;
    Ok(agreed.then(|| row.content_hash.clone()))
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

fn shown() -> std::path::PathBuf {
    Path::new(super::STATE_DIR).join(RECORD)
}

/// The record's bytes; `Ok(None)` where there is none. Follows no link, and
/// reads only a regular file of a bounded size.
fn read_bytes(dir: &Directory) -> std::result::Result<Option<Vec<u8>>, String> {
    let unreadable = |error: &dyn std::fmt::Display| {
        format!(
            "its removal record {} cannot be read: {error}",
            shown().display()
        )
    };
    let file = match dir.open_file(Path::new(RECORD), OFlags::RDONLY, Mode::empty()) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(unreadable(&error)),
    };
    let metadata = file.metadata().map_err(|error| unreadable(&error))?;
    if !metadata.is_file() {
        return Err(unreadable(&"it is not a regular file"));
    }
    let size = metadata.len();
    if size > LIMIT {
        return Err(unreadable(&format!("it is larger than {LIMIT} bytes")));
    }
    let mut bytes = Vec::new();
    file.take(LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| unreadable(&error))?;
    Ok(Some(bytes))
}

fn parse(bytes: &[u8]) -> std::result::Result<Record, String> {
    let record: Record = serde_json::from_slice(bytes).map_err(|error| {
        format!(
            "its removal record {} cannot be read: {error}",
            shown().display()
        )
    })?;
    check(&record, bytes.len() as u64).map_err(|reason| {
        format!(
            "its removal record {} cannot be used, because {reason}",
            shown().display()
        )
    })?;
    Ok(record)
}

fn read(dir: &Directory) -> std::result::Result<Option<Record>, String> {
    read_bytes(dir)?.map(|bytes| parse(&bytes)).transpose()
}

/// What the reader refuses, and so the writer never writes.
fn check(record: &Record, size: u64) -> std::result::Result<(), String> {
    if size > LIMIT {
        return Err(format!("it would be larger than {LIMIT} bytes"));
    }
    if record.format != FORMAT {
        return Err(format!(
            "it is of format {}, which this build does not read",
            record.format
        ));
    }
    if record.folder.is_empty() {
        return Err("it names no folder".into());
    }
    let mut paths = std::collections::HashSet::new();
    for sent in &record.files {
        plain_relative(&sent.path).map_err(|error| error.to_string())?;
        if sent.item.is_empty() || sent.version < 1 {
            return Err(format!("its entry for {} names no item version", sent.path));
        }
        if sent.instance.as_deref().is_some_and(str::is_empty) {
            return Err(format!(
                "its entry for {} names an empty instance",
                sent.path
            ));
        }
        if !paths.insert(sent.path.as_str()) {
            return Err(format!("it names {} twice", sent.path));
        }
    }
    Ok(())
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
