use std::collections::{HashMap, HashSet};
use std::path::Path;

use serde::Serialize;

use super::edge_types::EdgeTypes;
use super::{
    Flagged, Folder, ScanReport, captured_identities, carries_frontmatter, document, id_named,
    identity, is_document, named_by_its_file, near_limit, one_per_name, state, text_of,
};
use crate::Result;
use crate::catalog::Catalog;
use crate::model::{ItemState, QueuedWrite, Verdict, WriteKind};

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FileStatus {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item_id: Option<String>,
    /// `in_step`, `waiting`, `held`, `unmatched`, `unreached` or `outside`.
    /// `outside` is a file that is not bound and that the folder does not
    /// take: an empty file item, or a file the query holds no type for. It is
    /// not the pull report's `outside` count, which is an item whose path the
    /// folder will not write to.
    pub status: &'static str,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub waits: Vec<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flag: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct StatusReport {
    pub files: Vec<FileStatus>,
    pub paused: Paused,
    pub directories: Vec<Flagged>,
    /// Where the first sync waits to be confirmed, what the last read of the
    /// folder said it will do; `plan` is empty until a read has.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_sync: Option<FirstSyncStatus>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct FirstSyncStatus {
    pub plan: Option<super::FirstSync>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Paused {
    pub disk: usize,
    pub pull: usize,
}

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
    /// Writes nothing, so a store opened without holding it answers it.
    pub(super) fn status(&self) -> Result<StatusReport> {
        self.refuse_if_gone()?;
        let settings = self.settings()?;
        let (catalog, edge_types) = {
            let conn = self.core.conn()?;
            crate::store::catalog_scope(&conn, |conn| {
                let catalog = Catalog::load(conn)?;
                #[cfg(debug_assertions)]
                crate::fault::hold(|| "folder-status-catalog");
                let edge_types = EdgeTypes::load(conn)?;
                #[cfg(debug_assertions)]
                edge_types.observe_status_types();
                Ok((catalog, edge_types))
            })?
        };
        let lists = settings.lists()?;
        let walked = self.walked(&lists);
        let (snapshot, disk, pull, unmatched) = {
            let conn = self.core.conn()?;
            (
                // As the next scan settles any write a crash cut off.
                state::every_bound(&conn)?
                    .into_iter()
                    .filter_map(|row| state::settled(&row, &self.root_dir).unwrap_or(Some(row)))
                    .collect::<Vec<_>>(),
                state::paused(&conn, state::Removal::Disk)?,
                state::paused(&conn, state::Removal::Pull)?,
                state::unmatched(&conn)?,
            )
        };
        let disk: HashSet<String> = disk.into_iter().collect();
        let pull: HashSet<String> = pull.into_iter().collect();
        let unmatched: HashSet<String> = unmatched.into_iter().collect();
        let queue = self.core.queue()?;
        let waiting = crate::store::current_waiting_writes(&*self.core.conn()?, &queue)?;
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
        let marks = captured_identities(&paths, &walked);
        let rows = Rows {
            by_path: &by_path,
            by_mark: snapshot
                .iter()
                .filter_map(|row| Some((row.identity.as_deref()?, row)))
                .collect(),
            marked: marks.values().map(identity::Identity::key).collect(),
        };
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
            let bytes = walked
                .opened
                .get(path)
                .and_then(|captured| captured.read().ok());
            let file_item = match bytes.as_deref() {
                Some(bytes) if is_document(path) => self.file_item_at(
                    path,
                    key,
                    bytes,
                    marks.get(path).map(identity::Identity::key),
                    &rows,
                    &catalog,
                )?,
                _ => false,
            };
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
                    file_item,
                    (&settings, &catalog, &edge_types),
                ),
            };
            // As the scan measures: the text it sends, which a file item's
            // bytes are not.
            entry.warning = bytes
                .as_deref()
                .filter(|_| !file_item)
                .and_then(|bytes| near_limit(key, text_of(bytes).ok()?))
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
            } else if crate::store::items_by_ids(
                &*self.core.conn()?,
                std::slice::from_ref(&bound.item_id),
            )?
            .pop()
            .is_none_or(|item| item.state == ItemState::Trashed)
            {
                FileStatus {
                    waits: vec!["scan"],
                    ..FileStatus::new(&bound.path, at, "waiting")
                }
                .because(
                    "gone",
                    "is gone, and its item is already in the bin or no longer held, so no delete is sent: a scan past the grace lets the file go",
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
            directories: walked.directories,
            paused: Paused {
                disk: disk.len(),
                pull: pull.len(),
            },
            first_sync: if self.awaiting_confirmation()? {
                Some(FirstSyncStatus {
                    plan: self.first_sync_plan()?,
                })
            } else {
                None
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
        let mut entry = FileStatus::new(&bound.path, Some(&bound.item_id), "held");
        let changed = hash.as_deref() != Some(bound.content_hash.as_str());
        if pull.contains(&bound.path) {
            if crate::store::purged(&*self.core.conn()?, &bound.item_id)? {
                return Ok(entry.because(
                    "removal",
                    "its item was purged with more files than the removal threshold lets go at once, so the file stays: `folders confirm` takes it away; a purged item cannot be restored",
                ));
            }
            return Ok(entry.because(
                "removal",
                "its item left elsewhere with more files than the removal threshold lets go at once, so the file stays: `folders confirm` takes it away, and `folders restore` brings its item back",
            ));
        }
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
            if row.verdict == Some(Verdict::Dead) {
                entry = entry.because(
                    "dead",
                    "its current write reached the refusal limit and remains held",
                );
            }
            if let Some(refusal) = &row.refusal {
                let code = refusal.code.as_deref().unwrap_or(&refusal.reason);
                let message = refusal.message.as_deref().unwrap_or(code);
                entry = entry.because("credential_refused", format!("{code}: {message}"));
            }
            // An upload the write waits on names no item of its own.
            for upload in waiting
                .iter()
                .filter(|other| row.depends_on.contains(&other.id))
            {
                named.push(self.wait_of(upload));
                if upload.verdict == Some(Verdict::Dead) {
                    entry = entry.because("dead", "an upload its current write needs reached the refusal limit and remains held");
                }
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
        file_item: bool,
        (settings, catalog, edge_types): (&super::Settings, &Catalog, &EdgeTypes),
    ) -> FileStatus {
        let entry = FileStatus::new(key, None, "outside");
        if !is_document(path) && bytes.is_some_and(<[u8]>::is_empty) {
            return entry.because("empty", "it is empty, and a file item holds bytes");
        }
        // Held by the scan before anything binds it, so read as the scan reads.
        if is_document(path)
            && !file_item
            && let Some(held) =
                self.held_document(key, path, bytes, (settings, catalog, edge_types))
        {
            return FileStatus::new(key, None, "held").because(held.flag, held.reason);
        }
        if self.pushes(path, settings, catalog) {
            return waits(FileStatus::new(key, None, "waiting"), vec!["scan"]);
        }
        entry.because(
            "query",
            "the query holds no type this file would be, so it is left alone",
        )
    }

    /// Whether the scan sends a file at a document name as a file item's
    /// bytes. A status runs no claim, so this follows the one a file meets:
    /// one naming a note's id is that note's, and any other is the item its
    /// identity is bound to, or else the item bound at its path where no
    /// other file's identity names that binding.
    fn file_item_at(
        &self,
        path: &Path,
        key: &str,
        bytes: &[u8],
        mark: Option<String>,
        rows: &Rows<'_>,
        catalog: &Catalog,
    ) -> Result<bool> {
        let bound = match mark.as_deref().and_then(|mark| rows.by_mark.get(mark)) {
            Some(bound) => Some(*bound),
            None => rows.by_path.get(key).copied().filter(|bound| {
                bound
                    .identity
                    .as_deref()
                    .is_none_or(|identity| !rows.marked.contains(identity))
            }),
        };
        let Some(bound) = bound else {
            return Ok(false);
        };
        if !self.file_item(&bound.item_id, catalog)? {
            return Ok(false);
        }
        let read = text_of(bytes)
            .ok()
            .filter(|_| carries_frontmatter(path))
            .map(document::read);
        let Some(id) = id_named(path, bytes, read.as_ref()) else {
            return Ok(true);
        };
        Ok(!self
            .core
            .get(&id)?
            .is_some_and(|item| named_by_its_file(&item, catalog)))
    }

    /// Why the scan holds a document it has not bound, where it does: its
    /// text cannot be read, or the copy would refuse it as a new item.
    fn held_document(
        &self,
        key: &str,
        path: &Path,
        bytes: Option<&[u8]>,
        (settings, catalog, edge_types): (&super::Settings, &Catalog, &EdgeTypes),
    ) -> Option<Flagged> {
        let unreadable =
            |reason: String| Flagged::of(key, &format!("{}{reason}", state::UNREADABLE));
        let text = match super::text_of(bytes?) {
            Ok(text) => text,
            Err(reason) => return Some(unreadable(reason.to_string())),
        };
        let document = super::document_of(path, text);
        if super::carries_frontmatter(path)
            && let Some(reason) = document
                .unreadable
                .clone()
                .or_else(|| super::fields::read(&document.front, edge_types).err())
        {
            return Some(unreadable(reason));
        }
        // A document of a file type is sent as its bytes, never as a draft.
        if self.file_type_of(path, settings, catalog).is_some() {
            return None;
        }
        match super::push::new_document(key, &document, (settings, catalog, edge_types)) {
            Err(held) => Some(held),
            Ok(made) => super::push::admission_hold(catalog, key, &made.draft),
        }
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
            WriteKind::ReplaceMetadata | WriteKind::WriteExtension | WriteKind::DeleteExtension => {
                "metadata"
            }
            WriteKind::UploadBlob => "upload",
        }
    }
}

impl StatusReport {
    pub(super) fn inventory_complete(&self) -> bool {
        !self
            .directories
            .iter()
            .any(|entry| matches!(entry.flag, "unreadable" | "gone"))
    }
}

/// The bindings a status reads a file's item from.
struct Rows<'a> {
    by_path: &'a HashMap<&'a str, &'a state::Bound>,
    by_mark: HashMap<&'a str, &'a state::Bound>,
    /// Every walked file's identity.
    marked: HashSet<String>,
}

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Core, catalog::Indexing, store, wire::WireCatalog};
    use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };

    fn wire_catalog(written_at: &str) -> WireCatalog {
        WireCatalog {
            types: serde_json::from_value(serde_json::json!([{ "id": "core.note", "fields": {} }]))
                .unwrap(),
            edge_types: vec![
                serde_json::json!({ "id": "references", "label": "References", "reverse_label": "Referenced by", "cardinality": "many-to-many", "source_type_constraints": ["*"], "target_type_constraints": ["*"], "cascade_on_delete": "orphan", "property_schema": {}, "shipped": true, "written_at": written_at }),
            ],
        }
    }

    /// A folder holding one new `core.note` file per name in `notes`, read
    /// through a reader copy, and the connection that writes the copy.
    fn folder_of_new_notes(notes: &[&str]) -> (tempfile::TempDir, rusqlite::Connection, Folder) {
        let dir = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let state_dir = dir.path().join(super::super::STATE_DIR);
        std::fs::create_dir(&state_dir).unwrap();
        let path = state_dir.join("core.sqlite");
        let writing = store::open(&path).unwrap();
        store::replace_catalog(&writing, &wire_catalog("source")).unwrap();
        for (key, value) in [
            (store::META_SLICE_TYPES, "[\"core.note\"]"),
            (store::META_SLICE_TIER, "library"),
            (store::META_EVENT_CURSOR, "1"),
            (crate::reach::FENCE, crate::scripted::FENCE),
            (store::META_INSTANCE_ID, crate::scripted::INSTANCE),
        ] {
            store::meta_set(&writing, key, value).unwrap();
        }
        store::upsert_item(
            &writing,
            &store::testing::wire_item(
                "folder",
                "system.folder",
                "active",
                "2026-01-01T00:00:00Z",
                serde_json::json!({ "query": {"types": ["core.note"]} }),
            ),
            None,
            &Indexing::default(),
        )
        .unwrap();
        for note in notes {
            std::fs::write(dir.path().join(note), "new note\n").unwrap();
        }
        let core = Core::open_reader(&path).unwrap();
        let folder = Folder {
            root: dir.path().to_path_buf(),
            folder: "folder".into(),
            core,
            key: std::sync::Mutex::new(None),
            unread_give_ways: std::sync::Mutex::new(Default::default()),
            permissions: std::sync::OnceLock::new(),
            refused_renames: std::sync::Mutex::new(Default::default()),
            replaced: None,
            root_dir: crate::directory::Directory::open(&dir.path().canonicalize().unwrap())
                .unwrap(),
            store_mark: crate::directory::Directory::open(&state_dir.canonicalize().unwrap())
                .unwrap()
                .entry_identity(std::path::Path::new("core.sqlite"))
                .unwrap(),
            state_dir: crate::directory::Directory::open(&state_dir.canonicalize().unwrap())
                .unwrap(),
        };
        (dir, writing, folder)
    }

    #[test]
    fn status_keeps_the_edge_catalog_from_its_item_catalog_snapshot() {
        let (_dir, writing, folder) = folder_of_new_notes(&["Note.md"]);
        let changed = Arc::new(AtomicBool::new(false));
        let witnessed = changed.clone();
        let mut type_reads = 0;
        folder
            .core
            .conn()
            .unwrap()
            .authorizer(Some(move |ctx: AuthContext<'_>| {
                if matches!(
                    ctx.action,
                    AuthAction::Read {
                        table_name: "types",
                        column_name: "parent"
                    }
                ) {
                    type_reads += 1;
                }
                if type_reads >= 2
                    && matches!(
                        ctx.action,
                        AuthAction::Read {
                            table_name: "meta",
                            column_name: "value"
                        }
                    )
                    && !witnessed.swap(true, Ordering::SeqCst)
                {
                    // The next catalog is unreadable. This status began with the
                    // previous one and must not combine the two revisions.
                    store::replace_catalog(&writing, &wire_catalog("unreadable")).unwrap();
                }
                Authorization::Allow
            }))
            .unwrap();
        let status = folder.status().unwrap();
        assert!(
            changed.load(Ordering::SeqCst),
            "the concurrent refresh did not run"
        );
        assert_eq!(status.files.len(), 1);
        assert_eq!(
            (status.files[0].path.as_str(), status.files[0].status),
            ("Note.md", "waiting")
        );
        assert!(
            folder.status().is_err(),
            "a later status did not see the unreadable replacement"
        );
    }

    /// How many times a status read the item catalog's types.
    fn catalog_reads_of_a_status(notes: &[&str]) -> usize {
        let (_dir, _writing, folder) = folder_of_new_notes(notes);
        let reads = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counted = reads.clone();
        folder
            .core
            .conn()
            .unwrap()
            .authorizer(Some(move |ctx: AuthContext<'_>| {
                if matches!(
                    ctx.action,
                    AuthAction::Read {
                        table_name: "types",
                        column_name: "parent"
                    }
                ) {
                    counted.fetch_add(1, Ordering::SeqCst);
                }
                Authorization::Allow
            }))
            .unwrap();
        let status = folder.status().unwrap();
        assert_eq!(status.files.len(), notes.len());
        reads.load(Ordering::SeqCst)
    }

    #[test]
    fn status_judges_every_new_document_against_the_one_catalog_it_loaded() {
        let one = catalog_reads_of_a_status(&["One.md"]);
        assert!(one > 0, "the witness read no catalog");
        assert_eq!(
            catalog_reads_of_a_status(&["One.md", "Two.md", "Three.md"]),
            one,
            "a document loaded the catalog again, so a refresh between two could split the status across revisions"
        );
    }
}
