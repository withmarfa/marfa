use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::{Folder, state};
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

pub(super) const META_REFUSED: &str = "folder_placements_refused";

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

/// How long a placement write whose give-way read failed waits before a
/// watch reads for it again: a watch drains every second, and a read refused
/// for good would otherwise spend the key's rate limit.
const GIVE_WAY_REREAD: Duration = Duration::from_secs(60);

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
                    .entry(crate::names::folded(&path))
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
        if crate::fault::named("purge-before-placement").as_deref() == Some(item_id) {
            store::purge_item(&*self.core.conn()?, item_id)?;
        }
        let placed = self.queue_placement(item_id, path);
        // A row purged since the pass read it can no longer be placed, and
        // its file is the next pull's to take away.
        match placed {
            Err(_) if !crate::store::item_held(&*self.core.conn()?, item_id)? => Ok(false),
            placed => placed,
        }
    }

    /// Ends this folder's placement of an item whose file at `leaving` is
    /// leaving the folder for good, so the server stops listing the folder as
    /// placing an item it no longer shows. Called before the file's binding
    /// goes, so a failure leaves the binding for the next pass to try again.
    /// Ends nothing while another file here is bound to the item. A restored
    /// item is placed again, as a new one is. Answers how many placements it
    /// ended.
    pub(super) fn end_placement(&self, item_id: &str, leaving: &str) -> Result<usize> {
        if state::bound_beside(&*self.core.conn()?, item_id, leaving)? {
            return Ok(0);
        }
        if crate::fault::named("end-placement-fails").is_some() {
            return Err(CoreError::Store(
                "injected failure to end a placement".into(),
            ));
        }
        let mut ended = 0;
        for edge in self
            .core
            .edges_from(item_id)?
            .into_iter()
            .filter(|edge| edge.edge_type == PLACEMENT_EDGE && edge.target_id == self.folder)
        {
            match self.core.delete_edge(&edge.id) {
                Ok(_) => ended += 1,
                // Gone from the copy since it was listed, by another machine's end.
                Err(CoreError::NotFound { .. }) => {}
                Err(error) => return Err(error),
            }
        }
        Ok(ended)
    }

    fn queue_placement(&self, item_id: &str, path: &str) -> Result<bool> {
        let mut properties = Map::new();
        properties.insert(PATH_PROPERTY.into(), Value::String(path.into()));
        match self.placement(item_id)? {
            // A path differing only in case or form is the same place, so each
            // machine keeps its file's own name.
            Some(edge) if path_of(&edge).is_some_and(|held| crate::names::same(held, path)) => {
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
            // A purged item has no file left to place.
            if store::item_held(&*self.core.conn()?, &item)? && self.placement_at(&item)? == held.at
            {
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

    /// The version of the settings the copy holds, read whether or not the
    /// copy can be read: a drain that a changed reach ends remembers its
    /// refusals before the copy is built again.
    fn settings_version(&self) -> Result<Option<i64>> {
        store::held_version(&*self.core.conn()?, &self.folder)
    }

    fn refused(&self) -> Result<Option<Refused>> {
        let Some(json) = store::meta_get(&*self.core.conn()?, META_REFUSED)? else {
            return Ok(None);
        };
        let refused: Option<Refused> = serde_json::from_str(&json).ok();
        let settings = self.settings_version()?;
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
            && crate::clock::now().saturating_duration_since(read.at) < KEY_REREAD
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
            at: crate::clock::now(),
        });
        asked
    }

    /// Gives way where another machine placed or moved the item first,
    /// whichever drain the server said so in, and remembers any other refusal
    /// this drain reports. Reads nothing where the drain already found the
    /// server unable to answer. Answers how many gave way.
    pub(super) fn settle_placements(
        &self,
        report: &mut DrainReport,
        watched: bool,
    ) -> Result<usize> {
        self.remember_refusals(report)?;
        if report.unavailable.is_some() || report.stopped.is_some() {
            return Ok(0);
        }
        let (gave_way, withdrawn) = self.give_way(watched)?;
        report
            .verdicts
            .retain(|verdict| !withdrawn.contains(&verdict.id));
        Ok(gave_way)
    }

    /// Remembers each placement the server refused among the verdicts a
    /// drain reports, and reads nothing.
    pub(super) fn remember_refusals(&self, report: &DrainReport) -> Result<()> {
        let mut refused: Vec<(String, Held)> = Vec::new();
        for verdict in &report.verdicts {
            let row = {
                let conn = self.core.conn()?;
                store::queued_write(&conn, &verdict.id)?
            };
            let Some(row) = row else {
                continue;
            };
            if gives_way(&row) || !self.places_by(&row)? {
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
        }
        if !refused.is_empty() {
            self.remember_refused(refused)?;
        }
        Ok(())
    }

    /// Gives way from the latest of this folder's placement writes to each
    /// edge that gives way. A read the server cannot answer now, or refuses,
    /// leaves its write as it is for a later drain to read again; a watch
    /// waits out `GIVE_WAY_REREAD` first. Answers how many gave way and the
    /// writes that left the queue.
    fn give_way(&self, watched: bool) -> Result<(usize, HashSet<String>)> {
        let queue = store::queued_writes(&*self.core.conn()?)?;
        let mut latest: Vec<QueuedWrite> = Vec::new();
        for row in queue {
            if !gives_way(&row) || !self.places_by(&row)? {
                continue;
            }
            match latest.iter_mut().find(|held| held.edge_id == row.edge_id) {
                Some(held) => *held = row,
                None => latest.push(row),
            }
        }
        let mut unread = self
            .unread_give_ways
            .lock()
            .map_err(|_| CoreError::Store("the give-way record was poisoned".into()))?;
        unread.retain(|_, at| crate::clock::now().saturating_duration_since(*at) < GIVE_WAY_REREAD);
        let mut gave_way = 0;
        let mut withdrawn = HashSet::new();
        for row in latest {
            if watched && unread.contains_key(&row.id) {
                continue;
            }
            match self.take_servers_placement(&row) {
                Ok(Some(left)) => {
                    gave_way += 1;
                    withdrawn.extend(left);
                }
                Ok(None) => {}
                Err(error) if !goes_on(&error) => return Err(error),
                Err(error) => {
                    if watched {
                        unread.insert(row.id, crate::clock::now());
                    }
                    // Every read after it would wait on the same server.
                    if error.is_environmental() {
                        break;
                    }
                }
            }
        }
        Ok((gave_way, withdrawn))
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
                Some(id) => store::edge_ends(&conn, id)?.map(|edge| edge.edge_type),
                None => None,
            },
            _ => None,
        };
        Ok(edge_type.as_deref() == Some(PLACEMENT_EDGE))
    }

    /// Puts the placement the server holds for the item `answered` places
    /// into the copy, in place of any this machine holds, as the queue puts
    /// back any row it read again: never over a row the copy took while the
    /// read was out. Withdraws the writes to the edge queued up to
    /// `answered`, or every one where `answered` is a create, since none can
    /// reach an edge the server never made. Answers the writes withdrawn, or
    /// `None` where `answered` no longer gives way once the read is in.
    fn take_servers_placement(&self, answered: &QueuedWrite) -> Result<Option<Vec<String>>> {
        let (Some(source), Some(edge_id)) =
            (answered.item_id.as_deref(), answered.edge_id.as_deref())
        else {
            return Ok(None);
        };
        let through = (answered.kind != WriteKind::CreateEdge).then_some(answered.id.as_str());
        let (context, known) = {
            let conn = self.core.conn()?;
            let context = crate::reach::Context::capture(&conn)?;
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
        #[cfg(debug_assertions)]
        crate::fault::hold(|| "folder-give-way-read");
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
                    Some(_) => return Err(crate::reach::invalid()),
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
            if !store::queued_write(&tx, &answered.id)?.is_some_and(|row| gives_way(&row)) {
                return Ok(None);
            }
            let withdrawn = store::withdraw_edge_writes(&tx, edge_id, through)?;
            #[cfg(debug_assertions)]
            crate::fault::hold(|| "folder-give-way-withdrawn");
            for read in &reads {
                crate::drain::apply_read_back(&tx, read)?;
            }
            tx.commit()?;
            Ok(Some(withdrawn))
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
                settings: self.settings_version()?.unwrap_or(0),
                placements: Withheld::new(),
            },
        };
        record.placements.extend(placements);
        self.keep_refused(&record)
    }
}

/// A placement the server answered as made over another machine's: a move
/// based on a placement it has moved on from, or a create where it holds one.
fn gives_way(row: &QueuedWrite) -> bool {
    let duplicate = row.verdict == Some(Verdict::Refused)
        && row.kind == WriteKind::CreateEdge
        && row.answer.as_deref().is_some_and(is_duplicate);
    duplicate || row.blocked_reason() == Some(BlockedReason::ConflictUnresolved)
}

/// Whether a give-way read's failure is the server's answer about that one
/// placement, failing now or refusing this read, after which the drain goes
/// on. Anything else ends the drain, as it ends any read's.
fn goes_on(error: &CoreError) -> bool {
    match error {
        CoreError::RenewalFailed(_) | CoreError::StorageFull(_) => false,
        CoreError::NotFound { .. }
        | CoreError::Forbidden { .. }
        | CoreError::Unauthorized { .. }
        | CoreError::Validation { .. }
        | CoreError::Decoding(_) => true,
        CoreError::Server { status, .. } if (400..500).contains(status) => true,
        _ => error.is_environmental(),
    }
}

pub(super) fn rank_of(edge: &Edge) -> Rank {
    (false, false, edge.created_at.clone(), edge.id.clone())
}

pub(super) fn unplaced_rank(settled: bool) -> Rank {
    (true, !settled, String::new(), String::new())
}

pub(crate) fn is_duplicate(answer: &str) -> bool {
    serde_json::from_str::<Value>(answer).is_ok_and(|body| {
        body.pointer("/error/details/constraint")
            .and_then(Value::as_str)
            == Some("duplicate")
    })
}

pub(super) fn places(key: &Value) -> bool {
    matches!(grant(key).as_deref(), Some("write"))
}

pub(crate) fn reads(key: &Value, item_type: &str) -> bool {
    matches!(
        resolved(key, "type_permissions", item_type).as_deref(),
        Some("read" | "write")
    )
}

fn grant(key: &Value) -> Option<String> {
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
    let (stem, _) = super::names::unnumbered(stem);
    (2u64..)
        .map(|n| {
            let name = super::names::fitted(stem, &format!(" ({n}){extension}"));
            format!("{dir}{name}")
        })
        .find(|candidate| !taken(candidate))
        .unwrap_or_else(|| path.to_string())
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
        let dir = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let db = dir.path().join(super::super::STATE_DIR).join("core.sqlite");
        std::fs::create_dir_all(db.parent().unwrap()).unwrap();
        let core = super::super::working(crate::Core::open(&db, None).unwrap()).unwrap();
        super::super::settings_file::bind(&core, "folder").unwrap();
        {
            let conn = core.conn().unwrap();
            store::meta_set(&conn, store::META_EVENT_CURSOR, "10").unwrap();
            store::meta_set(&conn, crate::reach::FENCE, crate::scripted::FENCE).unwrap();
            store::meta_set(&conn, store::META_INSTANCE_ID, crate::scripted::INSTANCE).unwrap();
            store::meta_set(&conn, store::META_SLICE_TYPES, "[\"core.note\"]").unwrap();
            store::meta_set(&conn, store::META_SLICE_TIER, "library").unwrap();
            store::replace_types(
                &conn,
                &[store::testing::wire_type("core.note", None, Some("title"))],
            )
            .unwrap();
            let note = store::testing::note("note", "Plan", "", "2026-01-01T00:00:00Z");
            store::put_server_item(&conn, &note, None, &crate::catalog::Catalog::empty()).unwrap();
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

    /// The move `moved_and_refused_as_stale` queued.
    fn blocked(folder: &Folder) -> QueuedWrite {
        store::queued_writes(&folder.core.conn().unwrap())
            .unwrap()
            .into_iter()
            .find(|row| row.edge_id.as_deref() == Some("placed"))
            .unwrap()
    }

    fn placed_at(version: i64, path: &str) -> crate::wire::WireEdge {
        let mut edge = store::testing::wire_edge("placed", "note", "folder", PLACEMENT_EDGE);
        edge.properties.insert("path".into(), path.into());
        edge.version = version;
        edge.updated_at = format!("2026-01-0{version}T00:00:00Z");
        edge
    }

    fn placed_json(version: i64, path: &str) -> Value {
        edge_json(placed_at(version, path))
    }

    fn edge_json(edge: crate::wire::WireEdge) -> Value {
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
            let giving_way = scope.spawn(|| folder.take_servers_placement(&blocked(&folder)));
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
            assert!(giving_way.join().unwrap().unwrap().is_some());
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
                let giving_way = scope.spawn(|| folder.take_servers_placement(&blocked(&folder)));
                server.wait_for("/edges/other", 1, Duration::from_secs(10));
                if moved_meanwhile {
                    store::put_server_edge(&folder.core.conn().unwrap(), &other(2)).unwrap();
                }
                ready.store(true, Ordering::SeqCst);
                assert!(giving_way.join().unwrap().unwrap().is_some());
            });
            let held = store::edge_by_id(&folder.core.conn().unwrap(), "other").unwrap();
            assert_eq!(
                held.map(|edge| edge.version),
                moved_meanwhile.then_some(2),
                "moved meanwhile: {moved_meanwhile}"
            );
        }
    }

    fn drained(verdicts: Vec<crate::drain::DrainVerdict>) -> DrainReport {
        DrainReport {
            answered: verdicts.len(),
            held: 0,
            undelivered: 0,
            unsent: 0,
            unmade: 0,
            unavailable: None,
            verdicts,
            stopped: None,
            unclaimed_sources: Vec::new(),
            retry_after_seconds: None,
        }
    }

    /// What the drain reported for each write to `placed` the queue holds.
    fn reported(folder: &Folder) -> Vec<crate::drain::DrainVerdict> {
        store::queued_writes(&folder.core.conn().unwrap())
            .unwrap()
            .into_iter()
            .filter(|row| row.edge_id.as_deref() == Some("placed"))
            .map(|row| crate::drain::DrainVerdict {
                id: row.id,
                kind: row.kind,
                item_id: row.item_id,
                edge_id: row.edge_id,
                verdict: row.verdict,
                reason: row.reason,
                refusal: None,
                conflicted_copy_id: None,
                refusals: row.refusals,
                replayed: false,
                merged_fields: Vec::new(),
            })
            .collect()
    }

    fn held_path(folder: &Folder) -> Option<String> {
        let held = store::edge_by_id(&folder.core.conn().unwrap(), "placed").unwrap()?;
        path_of(&held).map(str::to_string)
    }

    fn placements_listed(version: i64, path: &str) -> crate::scripted::Answer {
        crate::scripted::certified(crate::scripted::json(
            200,
            &json!({ "data": [placed_json(version, path)], "next_cursor": null }).to_string(),
        ))
    }

    #[test]
    fn a_give_way_whose_read_failed_is_finished_by_a_later_drain() {
        let server = crate::scripted::Scripted::start();
        server.on(
            "/items/note/edges",
            vec![
                crate::scripted::refusal(503, "unavailable"),
                placements_listed(2, "First/Plan.md"),
            ],
        );
        let (_dir, folder) = moved_and_refused_as_stale(server.url());
        let _ = folder.settle_placements(&mut drained(reported(&folder)), false);
        let gave_way = folder
            .settle_placements(&mut drained(Vec::new()), false)
            .unwrap();
        assert_eq!(gave_way, 1, "a later drain did not finish giving way");
        assert_eq!(held_path(&folder).as_deref(), Some("First/Plan.md"));
        assert!(
            store::queued_writes(&folder.core.conn().unwrap())
                .unwrap()
                .is_empty(),
            "the stale move stayed queued"
        );
    }

    #[test]
    fn a_give_way_read_that_fails_keeps_the_write_the_copy_and_the_report() {
        let refusals = [
            (503, "unavailable"),
            (404, "item_not_found"),
            (403, "type_not_permitted"),
        ];
        for (status, code) in refusals {
            let server = crate::scripted::Scripted::start();
            // A refusal of a read carries the reach it was asked in.
            let refused = || match status {
                503 => crate::scripted::refusal(status, code),
                _ => crate::scripted::certified(crate::scripted::refusal(status, code)),
            };
            server.on(
                "/items/note/edges",
                vec![refused(), refused(), placements_listed(2, "First/Plan.md")],
            );
            let (_dir, folder) = moved_and_refused_as_stale(server.url());
            let before = blocked(&folder);
            // Two drains of a watch, then one that is not.
            for (drain, watched, reads) in [(0, true, 1), (1, true, 1), (2, false, 2)] {
                let mut report = drained(reported(&folder));
                let gave_way = folder
                    .settle_placements(&mut report, watched)
                    .unwrap_or_else(|error| {
                        panic!("{status} failed drain {drain}: {error}");
                    });
                assert_eq!(gave_way, 0, "{status}");
                assert_eq!(
                    report.verdicts.iter().map(|v| &v.id).collect::<Vec<_>>(),
                    vec![&before.id],
                    "{status}: drain {drain} lost its verdict"
                );
                assert_eq!(blocked(&folder), before, "{status}");
                assert_eq!(held_path(&folder).as_deref(), Some("Second/Plan.md"));
                assert_eq!(
                    server.seen("/items/note/edges").len(),
                    reads,
                    "{status}: drain {drain} read the placement again within the minute of a watch, or a drain outside one did not"
                );
            }
            // The witness: the read answered, it gives way.
            assert_eq!(
                folder
                    .settle_placements(&mut drained(Vec::new()), false)
                    .unwrap(),
                1
            );
            assert_eq!(held_path(&folder).as_deref(), Some("First/Plan.md"));
        }
    }

    /// A second item, `memo`, placed by `memo-placed` at `Memo.md` and moved
    /// to `Elsewhere/Memo.md` by a move the server answered as stale.
    fn memo_moved_and_refused_as_stale(folder: &Folder) {
        {
            let conn = folder.core.conn().unwrap();
            let memo = store::testing::note("memo", "Memo", "", "2026-01-01T00:00:00Z");
            store::put_server_item(&conn, &memo, None, &crate::catalog::Catalog::empty()).unwrap();
            store::put_server_edge(&conn, &memo_at(1, "Memo.md")).unwrap();
        }
        folder
            .core
            .update_edge(
                "memo-placed",
                &EdgeEdit {
                    properties: json!({ "path": "Elsewhere/Memo.md" })
                        .as_object()
                        .unwrap()
                        .clone(),
                    base_version: Some(1),
                    ..Default::default()
                },
            )
            .unwrap();
        store::block_unanswered(
            &folder.core.conn().unwrap(),
            BlockedReason::ConflictUnresolved,
        )
        .unwrap();
    }

    fn memo_at(version: i64, path: &str) -> crate::wire::WireEdge {
        let mut edge = placed_at(version, path);
        edge.id = "memo-placed".into();
        edge.source_id = "memo".into();
        edge
    }

    #[test]
    fn an_environmental_give_way_failure_leaves_the_other_edges_to_the_next_drain() {
        let server = crate::scripted::Scripted::start();
        server.on(
            "/items/note/edges",
            vec![
                crate::scripted::refusal(503, "unavailable"),
                placements_listed(2, "First/Plan.md"),
            ],
        );
        server.on(
            "/items/memo/edges",
            vec![crate::scripted::certified(crate::scripted::json(
                200,
                &json!({ "data": [edge_json(memo_at(2, "Kept/Memo.md"))], "next_cursor": null })
                    .to_string(),
            ))],
        );
        let (_dir, folder) = moved_and_refused_as_stale(server.url());
        memo_moved_and_refused_as_stale(&folder);
        let gave_way = folder
            .settle_placements(&mut drained(Vec::new()), false)
            .unwrap();
        assert_eq!(gave_way, 0);
        assert!(
            server.seen("/items/memo/edges").is_empty(),
            "a drain went on reading a server that had just failed"
        );
        // The witness: the next drain reads for both and gives way twice.
        let gave_way = folder
            .settle_placements(&mut drained(Vec::new()), false)
            .unwrap();
        assert_eq!(gave_way, 2);
        assert_eq!(server.seen("/items/memo/edges").len(), 1);
        let memo = store::edge_by_id(&folder.core.conn().unwrap(), "memo-placed")
            .unwrap()
            .unwrap();
        assert_eq!(path_of(&memo), Some("Kept/Memo.md"));
    }

    #[test]
    fn a_give_way_read_that_finds_another_server_ends_the_drain() {
        let server = crate::scripted::Scripted::start();
        server.on(
            "/items/note/edges",
            vec![placements_listed(2, "First/Plan.md")],
        );
        let (dir, folder) = moved_and_refused_as_stale(server.url());
        store::meta_set(
            &folder.core.conn().unwrap(),
            store::META_SERVER_ORIGIN,
            "http://127.0.0.1:8",
        )
        .unwrap();
        drop(folder);
        server.on(
            "/",
            vec![crate::scripted::root(
                "00000000-0000-7000-8000-000000000001",
            )],
        );
        let folder = Folder::open(
            dir.path(),
            Some(crate::Server {
                url: server.url(),
                key: "fixture".into(),
            }),
        )
        .unwrap();
        let before = blocked(&folder);
        let ended = folder.settle_placements(&mut drained(reported(&folder)), false);
        assert!(
            matches!(ended, Err(CoreError::WrongServer { .. })),
            "{ended:?}"
        );
        assert_eq!(blocked(&folder), before);
        assert!(server.seen("/items/note/edges").is_empty());
    }

    #[test]
    fn a_drain_that_found_the_server_unable_to_answer_reads_nothing_to_give_way() {
        let server = crate::scripted::Scripted::start();
        server.on(
            "/items/note/edges",
            vec![placements_listed(2, "First/Plan.md")],
        );
        let (_dir, folder) = moved_and_refused_as_stale(server.url());
        let before = blocked(&folder);
        for (unavailable, stopped) in [(true, false), (false, true)] {
            let mut report = DrainReport {
                unavailable: unavailable.then(|| "the server did not answer".into()),
                stopped: stopped.then(|| "credential_refused".into()),
                ..drained(reported(&folder))
            };
            assert_eq!(folder.settle_placements(&mut report, false).unwrap(), 0);
            assert!(server.seen("/items/note/edges").is_empty());
            assert_eq!(blocked(&folder), before);
            assert_eq!(report.verdicts.len(), 1);
        }
        // The witness: a drain that reached the server gives way.
        assert_eq!(
            folder
                .settle_placements(&mut drained(Vec::new()), false)
                .unwrap(),
            1
        );
    }

    #[test]
    fn giving_way_keeps_a_move_queued_after_the_one_the_server_answered() {
        let server = crate::scripted::Scripted::start();
        server.on(
            "/items/note/edges",
            vec![placements_listed(2, "First/Plan.md")],
        );
        let (_dir, folder) = moved_and_refused_as_stale(server.url());
        let stale = blocked(&folder);
        // A catch-up brought the other machine's move, under the stale one.
        {
            let conn = folder.core.conn().unwrap();
            store::put_server_edge(&conn, &placed_at(2, "First/Plan.md")).unwrap();
            store::lay_waiting_edge_writes_over(&conn, "placed").unwrap();
        }
        folder
            .core
            .update_edge(
                "placed",
                &EdgeEdit {
                    properties: json!({ "path": "Third/Plan.md" })
                        .as_object()
                        .unwrap()
                        .clone(),
                    base_version: Some(2),
                    ..Default::default()
                },
            )
            .unwrap();
        let queued = store::queued_writes(&folder.core.conn().unwrap()).unwrap();
        assert_eq!(queued.len(), 2, "the later move was not queued on its own");
        let later = queued.last().unwrap().clone();
        let mut report = drained(reported(&folder));
        assert_eq!(folder.settle_placements(&mut report, false).unwrap(), 1);
        assert_eq!(
            store::queued_writes(&folder.core.conn().unwrap()).unwrap(),
            vec![later.clone()],
            "giving way took a move queued after the one the server answered"
        );
        assert_eq!(
            report.verdicts.iter().map(|v| &v.id).collect::<Vec<_>>(),
            vec![&later.id],
            "the withdrawn move is still reported, or the later one is not"
        );
        assert_ne!(stale.id, later.id);
        let held = store::edge_by_id(&folder.core.conn().unwrap(), "placed")
            .unwrap()
            .unwrap();
        assert_eq!((held.version, path_of(&held)), (2, Some("Third/Plan.md")));
    }

    #[test]
    fn giving_way_from_two_stale_moves_of_one_edge_reads_once_and_takes_both() {
        let server = crate::scripted::Scripted::start();
        server.on(
            "/items/note/edges",
            vec![placements_listed(2, "First/Plan.md")],
        );
        let (_dir, folder) = moved_and_refused_as_stale(server.url());
        folder
            .core
            .update_edge(
                "placed",
                &EdgeEdit {
                    properties: json!({ "path": "Third/Plan.md" })
                        .as_object()
                        .unwrap()
                        .clone(),
                    base_version: Some(1),
                    ..Default::default()
                },
            )
            .unwrap();
        store::block_unanswered(
            &folder.core.conn().unwrap(),
            BlockedReason::ConflictUnresolved,
        )
        .unwrap();
        assert_eq!(reported(&folder).len(), 2);
        let mut report = drained(reported(&folder));
        assert_eq!(folder.settle_placements(&mut report, false).unwrap(), 1);
        assert_eq!(server.seen("/items/note/edges").len(), 1);
        assert!(report.verdicts.is_empty());
        assert!(
            store::queued_writes(&folder.core.conn().unwrap())
                .unwrap()
                .is_empty()
        );
        assert_eq!(held_path(&folder).as_deref(), Some("First/Plan.md"));
    }

    fn bound_file(path: &str) -> state::Bound {
        state::Bound {
            path: path.into(),
            item_id: "note".into(),
            identity: None,
            content_hash: "hash".into(),
            presentation: None,
            blob: None,
            written_hash: None,
            links: Vec::new(),
            lines: Vec::new(),
            edit_line: None,
            held: None,
            own: None,
            writes: state::Writes::default(),
        }
    }

    #[test]
    fn a_placement_ends_only_with_the_last_file_bound_to_its_item() {
        let (_dir, folder) = moved_and_refused_as_stale("http://127.0.0.1:1".into());
        {
            let conn = folder.core.conn().unwrap();
            state::bind(&conn, &bound_file("Plan.md")).unwrap();
            state::bind(&conn, &bound_file("Copy.md")).unwrap();
        }
        assert_eq!(folder.end_placement("note", "Plan.md").unwrap(), 0);
        assert!(
            folder.placement("note").unwrap().is_some(),
            "the placement ended while another file here was bound to the item"
        );
        state::unbind(&folder.core.conn().unwrap(), "Copy.md").unwrap();
        assert_eq!(folder.end_placement("note", "Plan.md").unwrap(), 1);
        assert!(folder.placement("note").unwrap().is_none());
        assert_eq!(
            folder.end_placement("note", "Plan.md").unwrap(),
            0,
            "a second end found a placement to end"
        );
    }

    #[test]
    fn a_key_places_by_the_grant_the_server_would_resolve() {
        let key = |grants: Value| json!({ "edge_permissions": grants });
        assert!(places(&key(json!({ "in-folder": "write" }))));
        assert!(places(&key(json!({ "*": "write" }))));
        assert!(!places(&key(json!({ "*": "write", "in-folder": "read" }))));
        assert!(!places(&key(json!({ "references": "write" }))));
        assert!(!places(&json!({})));
    }
}
