//! Every file's status, read from the folder's store and its disk with no
//! request to the server (`folders.md` 48).

use std::collections::{HashMap, HashSet};
use std::path::Path;

use serde::Serialize;

use super::edge_types::EdgeTypes;
use super::{Flagged, Folder, ScanReport, identity, is_document, near_limit, one_per_name, state};
use crate::Result;
use crate::catalog::Catalog;
use crate::model::{QueuedWrite, Verdict, WriteKind};

/// One file and where it stands.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FileStatus {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item_id: Option<String>,
    /// `in_step`, `waiting`, `held`, `unmatched`, `unreached` or `outside`.
    pub status: &'static str,
    /// What a waiting file waits for, in the order the list names them.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub waits: Vec<&'static str>,
    /// Why a held, unreached or outside file stands where it does.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flag: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// A text near the server's limit (`folders.md` 47).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

/// Every file the folder reads or holds a binding for, in path order.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct StatusReport {
    pub files: Vec<FileStatus>,
    /// Removals waiting to be confirmed, by where they came from.
    pub paused: Paused,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Paused {
    /// Files gone from the disk whose deletes wait.
    pub disk: usize,
    /// Files whose items left elsewhere, which a pull leaves in place.
    pub pull: usize,
}

/// The words a waiting file's writes are named by, in the order a status
/// lists them.
const WAITS: [&str; 11] = [
    "scan",
    "upload",
    "create",
    "edit",
    "tag",
    "state",
    "restore",
    "edge",
    "placement",
    "metadata",
    "delete",
];

impl FileStatus {
    fn new(path: &str, item_id: Option<&str>, status: &'static str) -> FileStatus {
        FileStatus {
            path: path.to_string(),
            item_id: item_id.map(str::to_string),
            status,
            waits: Vec::new(),
            flag: None,
            reason: None,
            warning: None,
        }
    }

    fn because(mut self, flag: &'static str, reason: impl Into<String>) -> FileStatus {
        self.flag = Some(flag);
        self.reason = Some(reason.into());
        self
    }
}

impl Folder {
    /// Where every file stands. Nothing is written, so a reading handle beside
    /// a running watch answers it.
    pub fn status(&self) -> Result<StatusReport> {
        let settings = self.settings()?;
        let (catalog, edge_types) = {
            let conn = self.core.conn()?;
            (Catalog::load(&conn)?, EdgeTypes::load(&conn)?)
        };
        let lists = settings.lists()?;
        let walked = self.walked(&lists);
        let (snapshot, disk, pull, unmatched) = {
            let conn = self.core.conn()?;
            (
                state::every_bound(&conn)?,
                state::paused(&conn, state::Removal::Disk)?,
                state::paused(&conn, state::Removal::Pull)?,
                state::unmatched(&conn)?,
            )
        };
        let disk: HashSet<String> = disk.into_iter().collect();
        let pull: HashSet<String> = pull.into_iter().collect();
        let unmatched: HashSet<String> = unmatched.into_iter().collect();
        let waiting: Vec<QueuedWrite> = self
            .core
            .queue()?
            .into_iter()
            .filter(|row| matches!(row.verdict, None | Some(Verdict::Blocked)))
            .collect();
        let found = walked
            .files
            .iter()
            .map(|path| identity::relative(&self.root, path))
            .collect::<Result<Vec<String>>>()?;
        let mut named = ScanReport::default();
        let (paths, keys) = one_per_name(&walked.files, found, &snapshot, &mut named);
        let by_path: HashMap<&str, &state::Bound> = snapshot
            .iter()
            .map(|row| (row.path.as_str(), row))
            .collect();
        let mut seen: HashSet<String> = HashSet::new();
        let mut files: Vec<FileStatus> = Vec::new();
        for held in named.flagged {
            seen.insert(held.path.clone());
            let item_id = by_path
                .get(held.path.as_str())
                .map(|row| row.item_id.as_str());
            files
                .push(FileStatus::new(&held.path, item_id, "held").because(held.flag, held.reason));
        }
        for (path, key) in paths.iter().zip(&keys) {
            seen.insert(key.clone());
            let bytes = std::fs::read(path).ok();
            let mut entry = match by_path.get(key.as_str()) {
                Some(bound) => self.bound_status(
                    bound,
                    bytes.as_deref().map(state::hash),
                    &pull,
                    &unmatched,
                    &waiting,
                )?,
                None => self.unbound_status(
                    key,
                    path,
                    bytes.as_deref(),
                    (&settings, &catalog, &edge_types),
                ),
            };
            entry.warning = bytes
                .as_deref()
                .and_then(|bytes| near_limit(key, &String::from_utf8_lossy(bytes)))
                .map(|flagged| flagged.reason);
            files.push(entry);
        }
        for bound in &snapshot {
            if seen.contains(&bound.path) {
                continue;
            }
            let at = Some(bound.item_id.as_str());
            files.push(if !lists.takes(&bound.path) {
                FileStatus::new(&bound.path, at, "unreached")
                    .because("lists", "the folder's lists no longer take it, so it is held rather than deleted")
            } else if let Some(dir) = walked.directories.iter().find(|dir| {
                dir.path.is_empty()
                    || bound
                        .path
                        .strip_prefix(&dir.path)
                        .is_some_and(|rest| rest.starts_with('/'))
            }) {
                FileStatus::new(&bound.path, at, "unreached").because(
                    dir.flag,
                    format!("{} {}", display_dir(&dir.path), dir.reason),
                )
            } else if disk.contains(&bound.path) {
                FileStatus::new(&bound.path, at, "held").because(
                    "removal",
                    "is gone with more files than the removal threshold lets go at once, so its item is not deleted: `folders confirm` deletes it, and `folders restore` or putting it back cancels that",
                )
            } else {
                FileStatus {
                    waits: vec!["delete"],
                    ..FileStatus::new(&bound.path, at, "waiting")
                }
            });
        }
        files.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(StatusReport {
            files,
            paused: Paused {
                disk: disk.len(),
                pull: pull.len(),
            },
        })
    }

    fn bound_status(
        &self,
        bound: &state::Bound,
        hash: Option<String>,
        pull: &HashSet<String>,
        unmatched: &HashSet<String>,
        waiting: &[QueuedWrite],
    ) -> Result<FileStatus> {
        let entry = FileStatus::new(&bound.path, Some(&bound.item_id), "held");
        let changed = hash.as_deref() != Some(bound.content_hash.as_str());
        // A refused create forgets its row, and the file keeps the reason.
        if self.core.get(&bound.item_id)?.is_none() {
            if changed {
                return Ok(waits(entry, vec!["scan"]));
            }
            return Ok(match bound.writes.refused.last() {
                Some(refused) => entry.because("refused", refused.reason.clone()),
                None => entry.because(
                    "lost",
                    "is bound to an item this copy no longer holds, and unchanged since, so nothing is sent; changed, it goes as a new item",
                ),
            });
        }
        if pull.contains(&bound.path) {
            return Ok(entry.because(
                "removal",
                "its item left elsewhere with more files than the removal threshold lets go at once, so the file stays: `folders confirm` takes it away, and `folders restore` brings its item back",
            ));
        }
        if let Some(held) = &bound.held {
            let flagged = Flagged::of(&bound.path, held);
            return Ok(entry.because(flagged.flag, flagged.reason));
        }
        if let Some(refused) = bound.writes.refused.last() {
            return Ok(entry.because("refused", refused.reason.clone()));
        }
        let mut named: Vec<&'static str> = Vec::new();
        if changed {
            named.push("scan");
        }
        for row in waiting.iter().filter(|row| {
            row.item_id.as_deref() == Some(bound.item_id.as_str())
                || row.target_id.as_deref() == Some(bound.item_id.as_str())
        }) {
            named.push(self.wait_of(row));
            // An upload the write waits on names no item of its own.
            for upload in waiting
                .iter()
                .filter(|other| row.depends_on.contains(&other.id))
            {
                named.push(self.wait_of(upload));
            }
        }
        if !named.is_empty() {
            return Ok(waits(entry, named));
        }
        let status = if unmatched.contains(&bound.item_id) {
            "unmatched"
        } else {
            "in_step"
        };
        Ok(FileStatus { status, ..entry })
    }

    fn unbound_status(
        &self,
        key: &str,
        path: &Path,
        bytes: Option<&[u8]>,
        (settings, catalog, edge_types): (&super::Settings, &Catalog, &EdgeTypes),
    ) -> FileStatus {
        let entry = FileStatus::new(key, None, "outside");
        if !is_document(path) && bytes.is_some_and(<[u8]>::is_empty) {
            return entry.because("empty", "is empty, and a file item holds bytes");
        }
        // Held by the scan before anything binds it, so read as the scan reads.
        if super::carries_frontmatter(path)
            && let Some(reason) = bytes.and_then(|bytes| {
                let read = super::document::read(&String::from_utf8_lossy(bytes));
                read.unreadable
                    .or_else(|| super::fields::read(&read.front, edge_types).err())
            })
        {
            return FileStatus::new(key, None, "held").because("unreadable", reason);
        }
        if self.pushes(path, settings, catalog) {
            return waits(FileStatus::new(key, None, "waiting"), vec!["scan"]);
        }
        entry.because(
            "search",
            "the search holds no type this file would be, so it is left alone",
        )
    }

    fn wait_of(&self, row: &QueuedWrite) -> &'static str {
        match row.kind {
            WriteKind::CreateItem => "create",
            WriteKind::UpdateItem => "edit",
            WriteKind::DeleteItem => "delete",
            WriteKind::RestoreItem => "restore",
            WriteKind::TransitionItem => "state",
            WriteKind::AddTag | WriteKind::RemoveTag => "tag",
            WriteKind::CreateEdge | WriteKind::UpdateEdge | WriteKind::DeleteEdge
                if row.target_id.as_deref() == Some(self.folder.as_str()) =>
            {
                "placement"
            }
            WriteKind::CreateEdge | WriteKind::UpdateEdge | WriteKind::DeleteEdge => "edge",
            WriteKind::ReplaceMetadata
            | WriteKind::MergeMetadata
            | WriteKind::WriteExtension
            | WriteKind::DeleteExtension => "metadata",
            WriteKind::UploadBlob => "upload",
        }
    }
}

/// A waiting entry, its waits each named once in the list's order.
fn waits(entry: FileStatus, named: Vec<&'static str>) -> FileStatus {
    FileStatus {
        status: "waiting",
        waits: WAITS
            .iter()
            .copied()
            .filter(|word| named.contains(word))
            .collect(),
        ..entry
    }
}

fn display_dir(path: &str) -> String {
    if path.is_empty() {
        "the folder".into()
    } else {
        path.to_string()
    }
}
