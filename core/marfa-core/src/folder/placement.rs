use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::Folder;
use crate::catalog::Catalog;
use crate::drain::{DrainReport, ReadBack};
use crate::error::CoreError;
use crate::model::{
    BlockedReason, Edge, EdgeDraft, EdgeEdit, Item, QueuedWrite, Subject, Verdict, WriteKind,
};
use crate::{Result, store};

/// The edge that says where an item's file sits in a folder, never written
/// in a file.
pub const PLACEMENT_EDGE: &str = "in-folder";

const PATH_PROPERTY: &str = "path";

const META_REFUSED: &str = "folder_placements_refused";

/// Placements the server refused, by item: not sent again until the key or
/// the settings change, or the item's placement moves on.
pub(super) type Withheld = BTreeMap<String, Held>;

/// A refused placement: the path it named, and the refused write's `edge_id`
/// and `base_version`, none for a create.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(super) struct Held {
    path: String,
    at: Option<(String, i64)>,
}

/// How long a key's answer stands before it is asked again: a running watch
/// meets a restored grant within it.
const KEY_REREAD: Duration = Duration::from_secs(60);

/// The key as last asked, and when; `None` where the asking failed.
pub(super) struct KeyRead {
    state: Option<KeyState>,
    at: Instant,
}

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
    /// The key they were refused to; `None` until it could be read.
    key: Option<KeyState>,
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

    pub(super) fn placed_here(&self) -> Result<HashMap<String, Vec<Edge>>> {
        let mut placed: HashMap<String, Vec<Edge>> = HashMap::new();
        for edge in self.core.edges_to(&self.folder)? {
            if edge.edge_type != PLACEMENT_EDGE {
                continue;
            }
            if let Some(path) = path_of(&edge).and_then(cleaned) {
                placed
                    .entry(super::names::folded(&path))
                    .or_default()
                    .push(edge);
            }
        }
        for edges in placed.values_mut() {
            edges.sort_by_key(rank_of);
        }
        Ok(placed)
    }

    /// Records that the item's file sits at `path`, as an edge create or an
    /// update of its `path` alone. Answers whether anything was queued.
    pub(super) fn place(&self, item_id: &str, path: &str, withheld: &Withheld) -> Result<bool> {
        if withheld
            .get(item_id)
            .is_some_and(|refused| refused.path == path)
        {
            return Ok(false);
        }
        let mut properties = Map::new();
        properties.insert(PATH_PROPERTY.into(), Value::String(path.into()));
        match self.placement(item_id)? {
            // A path differing only in case or form is the same place, so each
            // machine keeps its file's own name.
            Some(edge) if path_of(&edge).is_some_and(|held| super::names::same(held, path)) => {
                return Ok(false);
            }
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

    /// The refused placements, while their key and settings stand; one whose
    /// item's placement has moved since is let go, so the pull follows it.
    pub(super) fn withheld(&self) -> Result<Withheld> {
        let Some(mut refused) = self.refused()? else {
            return Ok(Withheld::new());
        };
        let before = refused.placements.len();
        let mut kept = Withheld::new();
        for (item, held) in std::mem::take(&mut refused.placements) {
            if self.placement_at(&item)? == held.at {
                kept.insert(item, held);
            }
        }
        refused.placements = kept;
        if refused.placements.len() != before {
            self.keep_refused(&refused)?;
        }
        Ok(refused.placements)
    }

    /// A create not yet answered, at version 0, has landed nowhere.
    fn placement_at(&self, item_id: &str) -> Result<Option<(String, i64)>> {
        Ok(self
            .core
            .edges_from(item_id)?
            .into_iter()
            .filter(|edge| {
                edge.edge_type == PLACEMENT_EDGE
                    && edge.target_id == self.folder
                    && edge.version > 0
            })
            .min_by_key(rank_of)
            .map(|edge| (edge.id, edge.version)))
    }

    fn keep_refused(&self, refused: &Refused) -> Result<()> {
        let conn = self.core.conn()?;
        if refused.placements.is_empty() {
            store::meta_delete(&conn, META_REFUSED)
        } else {
            store::meta_set(&conn, META_REFUSED, &serde_json::to_string(refused)?)
        }
    }

    fn refused(&self) -> Result<Option<Refused>> {
        let Some(json) = store::meta_get(&*self.core.conn()?, META_REFUSED)? else {
            return Ok(None);
        };
        let refused: Option<Refused> = serde_json::from_str(&json).ok();
        let settings = self.core.get(&self.folder)?.map(|row| row.version);
        let Some(mut refused) = refused.filter(|refused| Some(refused.settings) == settings) else {
            store::meta_delete(&*self.core.conn()?, META_REFUSED)?;
            return Ok(None);
        };
        // A key that cannot be read is unchanged; one unread at the refusal is
        // the key it was refused to once it can be.
        match (&refused.key, self.key_state()) {
            (Some(recorded), Ok(current)) if *recorded != current => {
                store::meta_delete(&*self.core.conn()?, META_REFUSED)?;
                Ok(None)
            }
            (None, Ok(current)) => {
                refused.key = Some(current);
                self.keep_refused(&refused)?;
                Ok(Some(refused))
            }
            _ => Ok(Some(refused)),
        }
    }

    /// The key this credential is, asked at most once a `KEY_REREAD`, a
    /// failed asking included, so a watch spares the server's rate limit.
    fn key_state(&self) -> Result<KeyState> {
        let mut last = self
            .key
            .lock()
            .map_err(|_| CoreError::Store("the key's record was poisoned".into()))?;
        if let Some(read) = last.as_ref()
            && read.at.elapsed() < KEY_REREAD
        {
            return read.state.clone().ok_or_else(|| {
                CoreError::Network("the key could not be read, and is asked again later".into())
            });
        }
        let asked = self
            .core
            .http()
            .and_then(|http| http.current_key())
            .map(|key| key.map(|key| KeyState::of(&key)).unwrap_or_default());
        *last = Some(KeyRead {
            state: asked.as_ref().ok().cloned(),
            at: Instant::now(),
        });
        asked
    }

    /// Gives way where another machine placed or moved the item first, and
    /// remembers any other refusal. Answers how many gave way.
    pub(super) fn settle_placements(&self, report: &mut DrainReport) -> Result<usize> {
        let mut gave_way = 0;
        let mut refused: Vec<(String, Held)> = Vec::new();
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
                self.take_servers_placement(source, edge_id)?;
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
                // The placement the refused write was based on, which the
                // copy may since have moved past.
                let at = match row.kind {
                    WriteKind::UpdateEdge => row.edge_id.clone().zip(row.base_version),
                    _ => None,
                };
                refused.push((item, Held { path, at }));
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
    /// place of any this machine holds, as the queue puts back any row it
    /// read again: never over a row the copy took while the read was out.
    fn take_servers_placement(&self, source: &str, edge_id: &str) -> Result<()> {
        let (context, known) = {
            let conn = self.core.conn()?;
            let context = crate::read_view::Context::capture(&conn)?;
            let mut known = Vec::new();
            for edge in store::edges_from(&conn, source)? {
                if edge.edge_type == PLACEMENT_EDGE && edge.target_id == self.folder {
                    let before = store::stamp(&conn, Subject::Edge, &edge.id)?;
                    known.push((edge.id, before));
                }
            }
            (context, known)
        };
        let http = context.http(self.core.http()?);
        let read = |id: String, held: Option<crate::wire::WireEdge>, before| ReadBack::Edge {
            context: context.clone(),
            id,
            held: held.map(Box::new),
            before,
        };
        let result = (|| {
            let mut reads = Vec::new();
            let mut cursor: Option<String> = None;
            let mut seen = std::collections::HashSet::new();
            loop {
                let page = http.item_edges_page(source, PLACEMENT_EDGE, cursor.as_deref())?;
                for edge in page.data {
                    if edge.target_id == self.folder {
                        reads.push(read(edge.id.clone(), Some(edge), None));
                    }
                }
                match page.next_cursor {
                    Some(next) if seen.insert(next.clone()) => cursor = Some(next),
                    Some(_) => return Err(crate::read_view::invalid()),
                    None => break,
                }
            }
            for (id, before) in known {
                let listed = reads
                    .iter()
                    .any(|read| matches!(read, ReadBack::Edge { id: found, .. } if *found == id));
                if !listed {
                    let current = http.edge(&id)?;
                    reads.push(read(id, current, before));
                }
            }
            let mut conn = self.core.conn()?;
            let tx = conn.transaction()?;
            context.check(&tx)?;
            store::withdraw_edge_writes(&tx, edge_id)?;
            for read in &reads {
                crate::drain::apply_read_back(&tx, read)?;
            }
            tx.commit()?;
            Ok(())
        })();
        result.map_err(|error| {
            context
                .failed(&self.core, error)
                .unwrap_or_else(|error| error)
        })
    }

    fn remember_refused(&self, placements: Vec<(String, Held)>) -> Result<()> {
        let mut record = match self.refused()? {
            Some(record) => record,
            None => Refused {
                key: self.key_state().ok(),
                settings: self.core.get(&self.folder)?.map_or(0, |row| row.version),
                placements: Withheld::new(),
            },
        };
        record.placements.extend(placements);
        self.keep_refused(&record)
    }
}

pub(super) fn rank_of(edge: &Edge) -> Rank {
    (false, false, edge.created_at.clone(), edge.id.clone())
}

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

pub(super) fn places(key: &Value) -> bool {
    matches!(grant(key).as_deref(), Some("write" | OPERATOR))
}

const OPERATOR: &str = "operator";

pub(crate) fn reads(key: &Value, item_type: &str) -> bool {
    matches!(
        resolved(key, "type_permissions", item_type).as_deref(),
        Some("read" | "write")
    )
}

fn grant(key: &Value) -> Option<String> {
    if key.get("is_operator").and_then(Value::as_bool) == Some(true) {
        return Some(OPERATOR.into());
    }
    resolved(key, "edge_permissions", PLACEMENT_EDGE)
}

/// A key's grant on `name` in one of its maps, resolved as the server
/// resolves one: the exact name, then the longest `x.*`, then `*`.
fn resolved(key: &Value, map: &str, name: &str) -> Option<String> {
    let grants = key.get(map).and_then(Value::as_object)?;
    let resolved = grants.get(name).or_else(|| {
        grants
            .iter()
            .filter_map(|(pattern, level)| {
                let root = pattern.strip_suffix(".*")?;
                (name == root || name.starts_with(&format!("{root}.")))
                    .then_some((root.len(), level))
            })
            .max_by_key(|(length, _)| *length)
            .map(|(_, level)| level)
            .or_else(|| grants.get("*"))
    });
    resolved.and_then(Value::as_str).map(str::to_string)
}

pub(super) fn path_of(edge: &Edge) -> Option<&str> {
    edge.properties.get(PATH_PROPERTY).and_then(Value::as_str)
}

/// A path with empty and `.` names taken out, or `None` where a name climbs
/// out; whether the folder takes it is its lists' to say.
pub(super) fn cleaned(path: &str) -> Option<String> {
    let names: Vec<&str> = path
        .split('/')
        .filter(|name| !name.is_empty() && *name != ".")
        .collect();
    if names.is_empty() || names.contains(&"..") {
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
    let (stem, extension) = super::names::split_extension(name);
    let stem = unnumbered(stem);
    (2u64..)
        .map(|n| {
            let name = super::names::fitted(stem, &format!(" ({n}){extension}"));
            format!("{dir}{name}")
        })
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
        // A name cut to the limit is cut again to take its number.
        let cut = format!("{}.md", "\u{65e5}".repeat(84));
        let numbered = beside(&format!("a/{cut}"), |_| false);
        assert_eq!(numbered, format!("a/{} (2).md", "\u{65e5}".repeat(82)));
        let long = format!("{}.md", "x".repeat(252));
        let taken = [format!("{} (2).md", "x".repeat(248))];
        assert_eq!(
            beside(&long, |candidate| taken
                .iter()
                .any(|held| held == candidate)),
            format!("{} (3).md", "x".repeat(248))
        );
    }

    /// A folder whose copy holds `note`, placed at `Plan.md` by the edge
    /// `placed`, and a move of it this machine queued that the server
    /// answered as stale.
    fn moved_and_refused_as_stale(url: String) -> (tempfile::TempDir, Folder) {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join(super::super::STATE_DIR).join("core.sqlite");
        std::fs::create_dir_all(db.parent().unwrap()).unwrap();
        let core = super::super::working(crate::Core::open(&db, None).unwrap()).unwrap();
        super::super::settings_file::bind(&core, "folder").unwrap();
        {
            let conn = core.conn().unwrap();
            store::meta_set(&conn, store::META_EVENT_CURSOR, "10").unwrap();
            store::meta_set(&conn, crate::read_view::FENCE, crate::scripted::FENCE).unwrap();
            store::meta_set(&conn, store::META_INSTANCE_ID, crate::scripted::INSTANCE).unwrap();
            store::meta_set(&conn, store::META_SLICE_TYPES, "[\"core.note\"]").unwrap();
            store::meta_set(&conn, store::META_SLICE_TIER, "library").unwrap();
            store::replace_types(
                &conn,
                &[store::testing::wire_type("core.note", None, Some("title"))],
            )
            .unwrap();
            let note = store::testing::note("note", "Plan", "", "2026-01-01T00:00:00Z");
            store::put_server_item(&conn, &note, None, &Default::default()).unwrap();
            store::put_server_edge(&conn, &placed_at(1, "Plan.md")).unwrap();
        }
        core.update_edge(
            "placed",
            &EdgeEdit {
                properties: json!({ "path": "Second/Plan.md" })
                    .as_object()
                    .unwrap()
                    .clone(),
                base_version: Some(1),
                ..Default::default()
            },
        )
        .unwrap();
        store::block_unanswered(&core.conn().unwrap(), BlockedReason::ConflictUnresolved).unwrap();
        drop(core);
        let folder = Folder::open(
            dir.path(),
            Some(crate::Server {
                url,
                key: "fixture".into(),
            }),
        )
        .unwrap();
        (dir, folder)
    }

    fn placed_at(version: i64, path: &str) -> crate::wire::WireEdge {
        let mut edge = store::testing::wire_edge("placed", "note", "folder", PLACEMENT_EDGE);
        edge.properties.insert("path".into(), path.into());
        edge.version = version;
        edge.updated_at = format!("2026-01-0{version}T00:00:00Z");
        edge
    }

    fn placed_json(version: i64, path: &str) -> Value {
        let edge = placed_at(version, path);
        json!({
            "id": edge.id,
            "source_id": edge.source_id,
            "target_id": edge.target_id,
            "edge_type": edge.edge_type,
            "properties": edge.properties,
            "version": edge.version,
            "created_at": edge.created_at,
            "updated_at": edge.updated_at,
        })
    }

    #[test]
    fn giving_way_keeps_a_placement_that_arrives_while_the_server_is_read() {
        use std::sync::Arc;
        use std::sync::atomic::{AtomicBool, Ordering};

        let server = crate::scripted::Scripted::start();
        let ready = Arc::new(AtomicBool::new(false));
        let listing = "/items/note/edges";
        server.on(
            listing,
            vec![crate::scripted::Answer::WaitFor {
                ready: Arc::clone(&ready),
                answer: Box::new(crate::scripted::certified(crate::scripted::json(
                    200,
                    &json!({ "data": [placed_json(2, "First/Plan.md")], "next_cursor": null })
                        .to_string(),
                ))),
            }],
        );
        let (_dir, folder) = moved_and_refused_as_stale(server.url());
        std::thread::scope(|scope| {
            let giving_way = scope.spawn(|| folder.take_servers_placement("note", "placed"));
            server.wait_for(listing, 1, Duration::from_secs(10));
            // What a follow applies for a third move, made after the server
            // answered the read.
            {
                let mut conn = folder.core.conn().unwrap();
                let tx = conn.transaction().unwrap();
                store::put_server_edge(&tx, &placed_at(3, "Third/Plan.md")).unwrap();
                store::lay_waiting_edge_writes_over(&tx, "placed").unwrap();
                tx.commit().unwrap();
            }
            ready.store(true, Ordering::SeqCst);
            giving_way.join().unwrap().unwrap();
        });
        let conn = folder.core.conn().unwrap();
        let held = store::edge_by_id(&conn, "placed").unwrap().unwrap();
        assert_eq!(
            (held.version, path_of(&held)),
            (3, Some("Third/Plan.md")),
            "giving way left the copy showing something other than the newest placement"
        );
        assert!(
            store::queued_writes(&conn)
                .unwrap()
                .iter()
                .all(|row| row.edge_id.as_deref() != Some("placed")),
            "the stale move was not withdrawn"
        );
    }

    #[test]
    fn giving_way_forgets_an_edge_the_server_no_longer_holds_unless_the_copy_moved_it_since() {
        use std::sync::Arc;
        use std::sync::atomic::{AtomicBool, Ordering};

        let other = |version: i64| {
            let mut edge = placed_at(version, "Other.md");
            edge.id = "other".into();
            edge
        };
        for moved_meanwhile in [false, true] {
            let server = crate::scripted::Scripted::start();
            let ready = Arc::new(AtomicBool::new(false));
            server.on(
                "/items/note/edges",
                vec![crate::scripted::certified(crate::scripted::json(
                    200,
                    &json!({ "data": [placed_json(2, "First/Plan.md")], "next_cursor": null })
                        .to_string(),
                ))],
            );
            server.on(
                "/edges/other",
                vec![crate::scripted::Answer::WaitFor {
                    ready: Arc::clone(&ready),
                    answer: Box::new(crate::scripted::certified(crate::scripted::refusal(
                        404,
                        "edge_not_found",
                    ))),
                }],
            );
            let (_dir, folder) = moved_and_refused_as_stale(server.url());
            store::put_server_edge(&folder.core.conn().unwrap(), &other(1)).unwrap();
            std::thread::scope(|scope| {
                let giving_way = scope.spawn(|| folder.take_servers_placement("note", "placed"));
                server.wait_for("/edges/other", 1, Duration::from_secs(10));
                if moved_meanwhile {
                    store::put_server_edge(&folder.core.conn().unwrap(), &other(2)).unwrap();
                }
                ready.store(true, Ordering::SeqCst);
                giving_way.join().unwrap().unwrap();
            });
            let held = store::edge_by_id(&folder.core.conn().unwrap(), "other").unwrap();
            assert_eq!(
                held.map(|edge| edge.version),
                moved_meanwhile.then_some(2),
                "moved meanwhile: {moved_meanwhile}"
            );
        }
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
