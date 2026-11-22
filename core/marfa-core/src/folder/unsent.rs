use std::collections::{HashMap, HashSet};

use serde::Serialize;

use super::{Folder, identity, state};
use crate::Result;
use crate::model::{QueuedWrite, WriteKind};

/// How a file differs from what the folder's server last received.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UnsentChange {
    Changed,
    New,
    Moved,
    Deleted,
}

/// What a removed folder held that its server never received: how many
/// writes waited, and the files that hold changes.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct UnsentChanges {
    pub writes: usize,
    pub files: Vec<UnsentFile>,
}

/// A file whose change the folder's server never received.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct UnsentFile {
    pub change: UnsentChange,
    /// The file's path in the directory; `None` for a deleted file whose path
    /// the copy holds no record of.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// Where a moved file was before it moved.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    /// The file's item, where it has one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item: Option<String>,
}

impl Folder {
    /// Every file whose change the server has not received: the files of the
    /// `waiting` writes, and the files changed, added or gone since the last
    /// scan read them.
    pub(super) fn unsent_files(&self, waiting: &[QueuedWrite]) -> Result<Vec<UnsentFile>> {
        let (bound, left) = {
            let conn = self.core.conn()?;
            (state::every_bound(&conn)?, state::left_at(&conn)?)
        };
        let mut kinds: HashMap<&str, Vec<WriteKind>> = HashMap::new();
        let mut leaving = HashSet::new();
        for write in waiting {
            if let Some(item) = write.item_id.as_deref() {
                kinds.entry(item).or_default().push(write.kind);
                if write.kind == WriteKind::DeleteItem || state::moves(write, &self.folder) {
                    leaving.insert(item);
                }
            }
        }
        // The server never held an item whose create waits.
        let created = |item: &str| {
            kinds
                .get(item)
                .is_some_and(|kinds| kinds.contains(&WriteKind::CreateItem))
        };
        // Where the server holds an item whose file moved or went unsent.
        let held_at = |item: &str| left.get(item).filter(|_| leaving.contains(item));
        // Read from the store as it stands, since the copy is expired.
        let held =
            crate::store::items_by_ids(&*self.core.conn()?, std::slice::from_ref(&self.folder))?
                .pop();
        let lists = match held {
            Some(item) => super::Settings::of(&item)?.lists()?,
            None => self.settings()?.lists()?,
        };
        let walked = self.walked(&lists);
        let mut on_disk = HashMap::new();
        for path in &walked.files {
            on_disk.insert(identity::relative(&self.root, path)?, path);
        }
        // A file the walk could not reach is not known to be gone.
        let unreached = |path: &str| {
            !lists.takes(path)
                || walked.directories.iter().any(|dir| {
                    dir.path.is_empty()
                        || path
                            .strip_prefix(&dir.path)
                            .is_some_and(|rest| rest.starts_with('/'))
                })
        };
        let mut files = Vec::new();
        let mut bound_paths = HashSet::new();
        let mut bound_items = HashSet::new();
        for row in &bound {
            bound_paths.insert(row.path.as_str());
            bound_items.insert(row.item_id.as_str());
            let writes = kinds.get(row.item_id.as_str());
            let file = |change, path: &String, from: Option<&String>| UnsentFile {
                change,
                path: Some(path.clone()),
                from: from.cloned(),
                item: Some(row.item_id.clone()),
            };
            let present = on_disk.get(&row.path);
            if created(&row.item_id) {
                if present.is_some() {
                    files.push(file(UnsentChange::New, &row.path, None));
                }
                continue;
            }
            let from = held_at(&row.item_id);
            let Some(path) = present else {
                if !unreached(&row.path) {
                    files.push(file(UnsentChange::Deleted, from.unwrap_or(&row.path), None));
                }
                continue;
            };
            if let Some(from) = from.filter(|from| **from != row.path) {
                files.push(file(UnsentChange::Moved, &row.path, Some(from)));
            } else if writes.is_some()
                || walked
                    .opened
                    .get(*path)
                    .and_then(|captured| captured.read().ok())
                    .is_none_or(|bytes| state::hash(&bytes) != row.content_hash)
            {
                files.push(file(UnsentChange::Changed, &row.path, None));
            }
        }
        for (item, writes) in &kinds {
            if writes.contains(&WriteKind::DeleteItem)
                && !created(item)
                && !bound_items.contains(item)
            {
                files.push(UnsentFile {
                    change: UnsentChange::Deleted,
                    path: held_at(item).cloned(),
                    from: None,
                    item: Some((*item).to_string()),
                });
            }
        }
        for key in on_disk.keys() {
            if !bound_paths.contains(key.as_str()) {
                files.push(UnsentFile {
                    change: UnsentChange::New,
                    path: Some(key.clone()),
                    from: None,
                    item: None,
                });
            }
        }
        files.sort_by(|a, b| {
            (a.path.is_none(), &a.path, &a.item).cmp(&(b.path.is_none(), &b.path, &b.item))
        });
        Ok(files)
    }
}
