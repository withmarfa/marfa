//! Where a file sits: its item's `in-folder` edge to the folder's
//! `system.folder` (`folders.md` 19).

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::Folder;
use crate::catalog::Catalog;
use crate::drain::DrainReport;
use crate::model::{
    BlockedReason, Edge, EdgeDraft, EdgeEdit, Item, QueuedWrite, Verdict, WriteKind,
};
use crate::{Result, store};

/// The edge that says where an item's file sits in a folder, never written
/// in a file.
pub const PLACEMENT_EDGE: &str = "in-folder";

const PATH_PROPERTY: &str = "path";

const META_REFUSED: &str = "folder_placements_refused";

/// Placements the server refused, each the item's and the path it named:
/// not sent again until the key or the settings change.
pub(super) type Withheld = BTreeMap<String, String>;

/// The key a credential is, as far as placing goes: its id and its
/// `in-folder` grant, both `None` for a credential that is not a key.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub(super) struct KeyState {
    id: Option<String>,
    grant: Option<String>,
}

impl KeyState {
    fn of(key: &Value) -> KeyState {
        KeyState {
            id: key.get("id").and_then(Value::as_str).map(str::to_string),
            grant: grant(key),
        }
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Refused {
    /// The key they were refused to.
    key: KeyState,
    /// The version of the settings they were refused under.
    settings: i64,
    placements: Withheld,
}

/// How a pull ranks items wanting one path: the older edge, then its id; an
/// item with no placement after every one with, one already there first.
pub(super) type Rank = (bool, bool, String, String);

impl Folder {
    /// The item's placement in this folder. The server holds one per item;
    /// of two held here while this machine's own waits, the older is taken
    /// until the server answers it.
    pub(super) fn placement(&self, item_id: &str) -> Result<Option<Edge>> {
        Ok(self
            .core
            .edges_from(item_id)?
            .into_iter()
            .filter(|edge| edge.edge_type == PLACEMENT_EDGE && edge.target_id == self.folder)
            .min_by_key(rank_of))
    }

    /// Records that the item's file sits at `path`, as an edge create or an
    /// update of its `path` alone. Answers whether anything was queued.
    pub(super) fn place(&self, item_id: &str, path: &str, withheld: &Withheld) -> Result<bool> {
        if withheld.get(item_id).is_some_and(|refused| refused == path) {
            return Ok(false);
        }
        let mut properties = Map::new();
        properties.insert(PATH_PROPERTY.into(), Value::String(path.into()));
        match self.placement(item_id)? {
            Some(edge) if path_of(&edge) == Some(path) => return Ok(false),
            Some(edge) => {
                self.core.update_edge(
                    &edge.id,
                    &EdgeEdit {
                        properties,
                        base_version: Some(edge.version),
                        ..Default::default()
                    },
                )?;
            }
            None => {
                self.core.create_edge(&EdgeDraft {
                    source_id: item_id.to_string(),
                    target_id: self.folder.clone(),
                    edge_type: PLACEMENT_EDGE.into(),
                    properties,
                    id: None,
                })?;
            }
        }
        Ok(true)
    }

    /// The placements the server refused, while the key and the settings
    /// they were refused under are the ones in force.
    pub(super) fn withheld(&self) -> Result<Withheld> {
        Ok(self
            .refused()?
            .map(|refused| refused.placements)
            .unwrap_or_default())
    }

    fn refused(&self) -> Result<Option<Refused>> {
        let Some(json) = store::meta_get(&*self.core.conn()?, META_REFUSED)? else {
            return Ok(None);
        };
        let refused: Option<Refused> = serde_json::from_str(&json).ok();
        let settings = self.core.get(&self.folder)?.map(|row| row.version);
        match refused {
            Some(refused)
                if Some(refused.settings) == settings && !self.key_changed(&refused.key) =>
            {
                Ok(Some(refused))
            }
            _ => {
                store::meta_delete(&*self.core.conn()?, META_REFUSED)?;
                Ok(None)
            }
        }
    }

    /// Whether the credential is another key, or the same key with another
    /// grant, than `recorded`. Unanswerable, offline say, it is the same.
    fn key_changed(&self, recorded: &KeyState) -> bool {
        match self.key_state() {
            Ok(current) => &current != recorded,
            Err(_) => false,
        }
    }

    /// The key this credential is, asked once per process.
    fn key_state(&self) -> Result<KeyState> {
        if let Some(known) = self.key.get() {
            return Ok(known.clone());
        }
        let state = self
            .core
            .http()?
            .current_key()?
            .map(|key| KeyState::of(&key))
            .unwrap_or_default();
        Ok(self.key.get_or_init(|| state).clone())
    }

    /// Gives way where another machine placed or moved the item first, and
    /// remembers any other refusal. Answers how many gave way.
    pub(super) fn settle_placements(&self, report: &mut DrainReport) -> Result<usize> {
        let mut gave_way = 0;
        let mut refused: Vec<(String, String)> = Vec::new();
        let mut kept = Vec::new();
        for verdict in std::mem::take(&mut report.verdicts) {
            let row = {
                let conn = self.core.conn()?;
                store::queued_write(&conn, &verdict.id)?
            };
            let Some(row) = row else {
                kept.push(verdict);
                continue;
            };
            if !self.places_by(&row)? {
                kept.push(verdict);
                continue;
            }
            let duplicate = row.verdict == Some(Verdict::Refused)
                && row.kind == WriteKind::CreateEdge
                && row.answer.as_deref().is_some_and(is_duplicate);
            let stale = row.blocked_reason() == Some(BlockedReason::ConflictUnresolved);
            if duplicate || stale {
                let (Some(source), Some(edge_id)) =
                    (row.item_id.as_deref(), row.edge_id.as_deref())
                else {
                    kept.push(verdict);
                    continue;
                };
                self.take_servers_placement(source)?;
                store::withdraw_edge_writes(&*self.core.conn()?, edge_id)?;
                gave_way += 1;
                continue;
            }
            // Only the server's own answer to the placement: one refused with
            // the create it waited on is that create's refusal.
            if row.verdict == Some(Verdict::Refused)
                && row.answer.is_some()
                && let Some(item) = row.item_id.clone()
            {
                let payload = store::payload_of(&*self.core.conn()?, &row.id)?;
                let path = serde_json::from_str::<Value>(&payload)
                    .ok()
                    .and_then(|body| {
                        body.pointer("/properties/path")
                            .and_then(Value::as_str)
                            .map(str::to_string)
                    })
                    .unwrap_or_default();
                refused.push((item, path));
            }
            kept.push(verdict);
        }
        report.verdicts = kept;
        if !refused.is_empty() {
            self.remember_refused(refused)?;
        }
        Ok(gave_way)
    }

    /// Whether a queued write is one of this folder's placements: an
    /// `in-folder` edge to it, and not another edge to the same row.
    fn places_by(&self, row: &QueuedWrite) -> Result<bool> {
        if row.target_id.as_deref() != Some(self.folder.as_str()) {
            return Ok(false);
        }
        let conn = self.core.conn()?;
        let edge_type = match row.kind {
            WriteKind::CreateEdge => {
                serde_json::from_str::<Value>(&store::payload_of(&conn, &row.id)?)
                    .ok()
                    .and_then(|body| {
                        body.get("edge_type")
                            .and_then(Value::as_str)
                            .map(str::to_string)
                    })
            }
            WriteKind::UpdateEdge => match row.edge_id.as_deref() {
                Some(id) => store::edge_by_id(&conn, id)?.map(|edge| edge.edge_type),
                None => None,
            },
            _ => None,
        };
        Ok(edge_type.as_deref() == Some(PLACEMENT_EDGE))
    }

    /// Puts the placement the server holds for `source` into the copy, in
    /// place of any this machine holds.
    fn take_servers_placement(&self, source: &str) -> Result<()> {
        let http = self.core.http()?;
        let mut held = Vec::new();
        let mut cursor: Option<String> = None;
        loop {
            let page = http.item_edges_page(source, PLACEMENT_EDGE, cursor.as_deref())?;
            held.extend(
                page.data
                    .into_iter()
                    .filter(|edge| edge.target_id == self.folder),
            );
            match page.next_cursor {
                Some(next) if Some(&next) != cursor.as_ref() => cursor = Some(next),
                _ => break,
            }
        }
        let conn = self.core.conn()?;
        for edge in store::edges_from(&conn, source)? {
            if edge.edge_type == PLACEMENT_EDGE
                && edge.target_id == self.folder
                && !held.iter().any(|found| found.id == edge.id)
            {
                store::delete_edge(&conn, &edge.id)?;
            }
        }
        for edge in &held {
            store::upsert_edge(&conn, edge)?;
        }
        Ok(())
    }

    fn remember_refused(&self, placements: Vec<(String, String)>) -> Result<()> {
        let mut record = match self.refused()? {
            Some(record) => record,
            None => Refused {
                key: self.key_state().unwrap_or_default(),
                settings: self.core.get(&self.folder)?.map_or(0, |row| row.version),
                placements: Withheld::new(),
            },
        };
        record.placements.extend(placements);
        store::meta_set(
            &*self.core.conn()?,
            META_REFUSED,
            &serde_json::to_string(&record)?,
        )
    }
}

pub(super) fn rank_of(edge: &Edge) -> Rank {
    (false, false, edge.created_at.clone(), edge.id.clone())
}

/// The rank of an item with no placement, after every one with.
pub(super) fn unplaced_rank(settled: bool) -> Rank {
    (true, !settled, String::new(), String::new())
}

fn is_duplicate(answer: &str) -> bool {
    serde_json::from_str::<Value>(answer).is_ok_and(|body| {
        body.pointer("/error/details/constraint")
            .and_then(Value::as_str)
            == Some("duplicate")
    })
}

/// Whether a key writes `in-folder` edges.
pub(super) fn places(key: &Value) -> bool {
    matches!(grant(key).as_deref(), Some("write" | OPERATOR))
}

const OPERATOR: &str = "operator";

/// A key's grant on `in-folder`, resolved as the server resolves an edge
/// grant: the exact name, then the longest `x.*`, then `*`.
fn grant(key: &Value) -> Option<String> {
    if key.get("is_operator").and_then(Value::as_bool) == Some(true) {
        return Some(OPERATOR.into());
    }
    let grants = key.get("edge_permissions").and_then(Value::as_object)?;
    let resolved = grants.get(PLACEMENT_EDGE).or_else(|| {
        grants
            .iter()
            .filter_map(|(pattern, level)| {
                let root = pattern.strip_suffix(".*")?;
                (PLACEMENT_EDGE == root || PLACEMENT_EDGE.starts_with(&format!("{root}.")))
                    .then_some((root.len(), level))
            })
            .max_by_key(|(length, _)| *length)
            .map(|(_, level)| level)
            .or_else(|| grants.get("*"))
    });
    resolved.and_then(Value::as_str).map(str::to_string)
}

/// The path a placement names.
pub(super) fn path_of(edge: &Edge) -> Option<&str> {
    edge.properties.get(PATH_PROPERTY).and_then(Value::as_str)
}

/// A path with empty and `.` names taken out, or `None` where a name climbs
/// out or is dot-led, which the walk never reads back (`folders.md` 25).
pub(super) fn cleaned(path: &str) -> Option<String> {
    let names: Vec<&str> = path
        .split('/')
        .filter(|name| !name.is_empty() && *name != ".")
        .collect();
    if names.is_empty() || names.iter().any(|name| name.starts_with('.')) {
        return None;
    }
    Some(names.join("/"))
}

/// The first free path beside `path`, numbered from its name without any
/// number it already carries: `Name (2).md`, then `(3)`.
pub(super) fn beside(path: &str, taken: impl Fn(&str) -> bool) -> String {
    let (dir, name) = match path.rsplit_once('/') {
        Some((dir, name)) => (format!("{dir}/"), name),
        None => (String::new(), path),
    };
    let (stem, extension) = match name.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() => (stem, format!(".{extension}")),
        _ => (name, String::new()),
    };
    let stem = unnumbered(stem);
    (2u64..)
        .map(|n| format!("{dir}{stem} ({n}){extension}"))
        .find(|candidate| !taken(candidate))
        .unwrap_or_else(|| path.to_string())
}

fn unnumbered(stem: &str) -> &str {
    if let Some(open) = stem.rfind(" (")
        && let Some(digits) = stem[open + 2..].strip_suffix(')')
        && !digits.is_empty()
        && digits.bytes().all(|byte| byte.is_ascii_digit())
    {
        return &stem[..open];
    }
    stem
}

/// Whether a path keeps the item its kind, or its next edit would send it as
/// another: a document at a document's name, a file item at its MIME type's.
pub(super) fn suited(item: &Item, path: &str, catalog: &Catalog) -> bool {
    match super::bytes_of(item, catalog) {
        None => super::is_document(Path::new(path)),
        Some(_) => {
            let named = crate::blob::mime_type_for(Path::new(path), None);
            named == UNNAMED_MIME
                || item
                    .properties
                    .get("mime_type")
                    .and_then(Value::as_str)
                    .is_none_or(|own| own == named)
        }
    }
}

const UNNAMED_MIME: &str = "application/octet-stream";

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn a_path_beside_takes_the_first_free_number_from_the_bare_name() {
        let taken = ["Shared (2).md", "Shared (3).md"];
        let free = |candidate: &str| taken.contains(&candidate);
        assert_eq!(beside("Shared.md", free), "Shared (4).md");
        assert_eq!(beside("Shared (2).md", free), "Shared (4).md");
        assert_eq!(beside("a/Plan (x).md", |_| false), "a/Plan (x) (2).md");
        assert_eq!(beside("README", |_| false), "README (2)");
    }

    #[test]
    fn a_key_places_by_the_grant_the_server_would_resolve() {
        let key = |grants: Value| json!({ "is_operator": false, "edge_permissions": grants });
        assert!(places(&key(json!({ "in-folder": "write" }))));
        assert!(places(&key(json!({ "*": "write" }))));
        assert!(!places(&key(json!({ "*": "write", "in-folder": "read" }))));
        assert!(!places(&key(json!({ "references": "write" }))));
        assert!(!places(&json!({ "is_operator": false })));
        assert!(places(&json!({ "is_operator": true })));
    }
}
