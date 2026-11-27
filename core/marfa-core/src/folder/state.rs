use crate::store::Cached;
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use super::fields::OwnBase;
use crate::error::CoreError;
use crate::model::{ItemState, QueuedWrite, Verdict, WriteKind};
use crate::store::now_iso;
use marfa_rules::catalog::End;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Bound {
    pub path: String,
    pub item_id: String,
    /// Device, inode and birth time; `None` where the filesystem gave none.
    pub identity: Option<String>,
    pub content_hash: String,
    /// What those bytes mean, independent of their YAML presentation. Kept on
    /// every scan and pull agreement, including before a file is deleted.
    pub presentation: Option<super::document::Presentation>,
    /// A file item's blob, as its item named it when the file was last
    /// written or sent; `None` for a document.
    pub blob: Option<String>,
    /// The bytes the folder itself last wrote at this path, hashed; `None`
    /// where the last agreement was a scan's read. A pull removes only a file
    /// it wrote.
    pub written_hash: Option<String>,
    /// The item ids the file's links named when last read or written.
    pub links: Vec<String>,
    /// The file items the file's embeds named when last read or written,
    /// apart from its links: an embed new to the body attaches an outside
    /// file, which a link to the same file does not.
    pub embeds: Vec<String>,
    /// The edges this file's lines named when last read or written: what tells
    /// a line taken out from an edge no pull has written yet.
    pub lines: Vec<Line>,
    /// The newest line an answered, unrefused edit of this file spent, or a pull
    /// wrote over a waiting write not its own; a waiting edit's is on its entry.
    pub edit_line: Option<i64>,
    /// Why this copy did not send the bytes at `content_hash`, where it did
    /// not: a pull leaves such a file as it is.
    pub held: Option<String>,
    /// The own fields the folder last wrote or read in this file, and what
    /// another machine moved at that version line without a version step.
    pub own: Option<OwnBase>,
    pub writes: Writes,
}

/// `{}`, the column's default, is a file that has recorded no write.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Writes {
    /// Counts the file's saves, so a later one's landing can supersede.
    pub save: i64,
    pub queued: Vec<Queued>,
    pub refused: Vec<Refused>,
    /// Set while a pull's write is bound and its bytes have not landed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub landing: Option<Landing>,
    /// A title sent beside the file's bytes while its title line was left as
    /// it was: the line is no edit while it shows that. Any pull ends it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deferred_title: Option<DeferredTitle>,
    /// When a file held `edges` is judged again while it is unchanged;
    /// `None` where no judgment recorded it, which is judged at the next scan.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rejudge: Option<Rejudge>,
    /// The file's names whose lookup the server refused, folded, each with
    /// its reason: not asked again until the file changes.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub refused_lookups: BTreeMap<String, String>,
    /// Embedded file IDs still waiting on a held `has-attachment` line.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub unattached: Vec<String>,
}

impl Writes {
    pub fn refused_state(&self) -> Option<&Refused> {
        self.refused
            .iter()
            .find(|entry| matches!(entry.change, Change::State(_)))
    }

    pub fn placement_refused(&self) -> bool {
        self.refused
            .iter()
            .any(|entry| entry.change == Change::InitialPlacement)
    }

    /// Keeps the newest refusal when changes supersede one another.
    pub fn keep_refused(&mut self, refused: Refused) {
        if self
            .refused
            .iter()
            .any(|held| held.save > refused.save && refused.change.supersedes(&held.change))
        {
            return;
        }
        self.refused
            .retain(|held| !refused.change.supersedes(&held.change));
        self.refused.push(refused);
    }
}

/// When an unchanged file held `edges` is judged again.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Rejudge {
    /// A name matched no item or more than one: once the copy has moved from
    /// this `copy_moment`.
    Moved(String),
    /// Nothing a change to the copy can resolve holds it.
    FileChanged,
}

/// The title line a file went on showing, which is no edit of the title.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DeferredTitle {
    pub field: String,
    pub shown: serde_json::Value,
}

/// A write bound before its bytes land: what the path was bound as before,
/// `None` where nothing was, so a write a crash cut off can be undone.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Landing {
    pub before: Option<Box<Bound>>,
}

/// What a binding a write left before its bytes landed settles to: itself,
/// where the bytes are on the disk; what the path was bound as before, where
/// they are not; or nothing, where it was bound as nothing. `None` where the
/// binding waits on no write, or the disk cannot be read now.
pub(crate) fn settled(row: &Bound, root: &crate::directory::Directory) -> Option<Option<Bound>> {
    let landing = row.writes.landing.as_ref()?;
    let found = match root.read(std::path::Path::new(&row.path)) {
        Ok(found) => Some(hash(&found)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(_) => return None,
    };
    if found.as_deref() == Some(row.content_hash.as_str()) {
        let mut landed = row.clone();
        landed.writes.landing = None;
        return Some(Some(landed));
    }
    Some(landing.before.as_deref().cloned())
}

/// Recover landed writes before a scan mistakes them for edits or deletions,
/// except at the paths in `waiting`, whose bytes may have landed elsewhere.
pub(crate) fn settle_landings(
    conn: &Connection,
    root: &crate::directory::Directory,
    waiting: &std::collections::HashSet<String>,
) -> Result<(), CoreError> {
    let rows = every_bound(conn)?;
    for row in &rows {
        if waiting.contains(&row.path) {
            continue;
        }
        match settled(row, root) {
            None => {}
            Some(Some(settled)) => {
                bind(conn, &settled)?;
                let mut landed = row.clone();
                landed.writes.landing = None;
                if settled != landed {
                    continue;
                }
                for left in rows.iter().filter(|left| {
                    left.item_id == row.item_id
                        && left.path != row.path
                        && left.writes.landing.is_none()
                }) {
                    if root
                        .read(std::path::Path::new(&left.path))
                        .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
                    {
                        unbind(conn, &left.path)?;
                        journal_clear(conn, &left.path, &left.item_id)?;
                    }
                }
            }
            Some(None) => {
                unbind(conn, &row.path)?;
                journal_clear(conn, &row.path, &row.item_id)?;
            }
        }
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Queued {
    pub id: String,
    pub save: i64,
    /// The version line an edit spends, kept apart until it is answered so a
    /// refusal takes back only its own.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<i64>,
    /// A default edge of the folder's settings, which no line of the file asks for.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub default: bool,
}

impl Bound {
    /// Whether the file holds a change the person made that was refused. A
    /// refused default edge holds none: the file is as the server has it.
    pub fn holds_refusal(&self) -> bool {
        self.writes
            .refused
            .iter()
            .any(|refused| !matches!(refused.change, Change::DefaultEdge { .. }))
    }

    /// Whether a file item's file was last agreed at `blob`; `None` where the
    /// binding names no blob to tell by.
    pub fn agreed_blob(&self, blob: &str) -> Option<bool> {
        let agreed = self.blob.as_deref()?;
        let name = |hash: &str| crate::blob::named(hash).unwrap_or_else(|_| hash.to_string());
        Some(name(agreed) == name(blob))
    }

    pub fn spent(&self) -> Option<i64> {
        self.writes
            .queued
            .iter()
            .filter_map(|queued| queued.line)
            .chain(self.edit_line)
            .max()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Refused {
    pub change: Change,
    pub save: i64,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Change {
    Edit,
    AddTag(String),
    RemoveTag(String),
    State(ItemState),
    InitialPlacement,
    /// An edge a line made (`shown`) or took out.
    Edge {
        line: Line,
        shown: bool,
    },
    /// An edge the folder's defaults ask for, refused. No line in the file
    /// names it, so a line-based clean-up never judges it.
    DefaultEdge {
        line: Line,
        /// Whether the file is a file item's, which has no lines to write.
        file: bool,
    },
}

impl Change {
    pub fn supersedes(&self, refused: &Change) -> bool {
        match (self, refused) {
            (Change::Edit, Change::Edit)
            | (Change::State(_), Change::State(_))
            | (Change::InitialPlacement, Change::InitialPlacement) => true,
            (
                Change::AddTag(tag) | Change::RemoveTag(tag),
                Change::AddTag(was) | Change::RemoveTag(was),
            ) => tag == was,
            (Change::Edge { line, .. }, Change::Edge { line: was, .. })
            | (Change::DefaultEdge { line, .. }, Change::DefaultEdge { line: was, .. }) => {
                line == was
            }
            _ => false,
        }
    }
}

/// `end` is the end the file is, and `other` the item at the other end.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, serde::Serialize, serde::Deserialize)]
pub struct Line {
    pub edge_type: String,
    pub end: End,
    pub other: String,
}

const HASH_START: u64 = 0xcbf2_9ce4_8422_2325;

fn hash_chunk(mut sum: u64, bytes: &[u8]) -> u64 {
    for byte in bytes {
        sum ^= u64::from(*byte);
        sum = sum.wrapping_mul(0x0000_0100_0000_01b3);
    }
    sum
}

pub fn hash(bytes: &[u8]) -> String {
    format!("{:016x}", hash_chunk(HASH_START, bytes))
}

pub(super) fn hash_reader(reader: impl std::io::Read) -> std::io::Result<String> {
    use std::io::BufRead;
    let mut reader = std::io::BufReader::new(reader);
    let mut sum = HASH_START;
    loop {
        let bytes = match reader.fill_buf() {
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            result => result?,
        };
        if bytes.is_empty() {
            return Ok(format!("{sum:016x}"));
        }
        sum = hash_chunk(sum, bytes);
        let consumed = bytes.len();
        reader.consume(consumed);
    }
}

/// A content hash no bytes have, for a save set aside in a conflicted copy
/// against this device's own: the file reads as changed, and its next
/// edit is said to be read at `version`.
pub fn untaken_read_at(version: i64) -> String {
    format!("{UNTAKEN_READ_PREFIX}{version}")
}

const UNTAKEN_READ_PREFIX: &str = "read@";

pub fn untaken_read_version(content_hash: &str) -> Option<i64> {
    content_hash
        .strip_prefix(UNTAKEN_READ_PREFIX)
        .and_then(|version| version.parse().ok())
}

/// Also pins the item's row, so the copy keeps it whatever the query says
/// of it.
pub fn bind(conn: &Connection, bound: &Bound) -> Result<(), CoreError> {
    let before = bound_at(conn, &bound.path)?;
    crate::store::pin(conn, &bound.item_id)?;
    conn.execute_cached(
        "INSERT INTO folder_files (path, item_id, identity, content_hash, written_hash, links, edge_lines, edit_line, held, own, writes, presentation, blob, seen_at, embeds)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
         ON CONFLICT (path) DO UPDATE SET
           item_id = excluded.item_id,
           identity = excluded.identity,
           content_hash = excluded.content_hash,
           written_hash = excluded.written_hash,
           links = excluded.links,
           edge_lines = excluded.edge_lines,
           edit_line = excluded.edit_line,
           held = excluded.held,
           own = excluded.own,
           writes = excluded.writes,
           presentation = excluded.presentation,
           blob = excluded.blob,
           seen_at = excluded.seen_at,
           embeds = excluded.embeds",
        params![
            bound.path,
            bound.item_id,
            bound.identity,
            bound.content_hash,
            bound.written_hash,
            serde_json::to_string(&bound.links).unwrap_or_else(|_| "[]".into()),
            serde_json::to_string(&bound.lines).unwrap_or_else(|_| "[]".into()),
            bound.edit_line,
            bound.held,
            bound
                .own
                .as_ref()
                .and_then(|own| serde_json::to_string(own).ok()),
            serde_json::to_string(&bound.writes).unwrap_or_else(|_| "{}".into()),
            bound.presentation.as_ref().map(serde_json::to_string).transpose().map_err(|error| CoreError::Store(error.to_string()))?,
            bound.blob,
            now_iso(),
            serde_json::to_string(&bound.embeds).unwrap_or_else(|_| "[]".into())
        ],
    )?;
    if let Some(before) = before {
        unpin_if_unheld(conn, &before.item_id)?;
    }
    Ok(())
}

pub fn unbind(conn: &Connection, path: &str) -> Result<(), CoreError> {
    let before = bound_at(conn, path)?;
    conn.execute_cached("DELETE FROM folder_files WHERE path = ?1", [path])?;
    if let Some(before) = before {
        unpin_if_unheld(conn, &before.item_id)?;
    }
    Ok(())
}

/// A binding lets its pin go unless a line still holds the row, which then
/// holds the pin as its own. The purge remembered for the row goes with its
/// last binding, a line's hold or not.
pub fn unpin_if_unheld(conn: &Connection, item_id: &str) -> Result<(), CoreError> {
    if bound_to_item(conn, item_id)?.is_some() {
        return Ok(());
    }
    crate::store::forget_purged(conn, item_id)?;
    match crate::store::meta_get(conn, &format!("{EDGE_END}{item_id}"))? {
        Some(_) => crate::store::meta_set(conn, &format!("{EDGE_END}{item_id}"), MADE),
        None => crate::store::unpin(conn, item_id).map(|_| ()),
    }
}

/// One `meta` row per edge end a line holds, so a bind asks for one by key;
/// `MADE` where the folder made the pin, which only then is its to let go.
const EDGE_END: &str = "folder_edge_end:";
const MADE: &str = "made";

/// A key range rather than `LIKE`, so the key's index answers it; `prefix`
/// must end in `:`, the byte just below `;`.
fn under(conn: &Connection, prefix: &str) -> Result<Vec<(String, String)>, CoreError> {
    let above = format!("{}{}", &prefix[..prefix.len() - 1], ';');
    let mut statement =
        conn.prepare("SELECT key, value FROM meta WHERE key >= ?1 AND key < ?2 ORDER BY key")?;
    let rows = statement.query_map(params![prefix, above], |row| Ok((row.get(0)?, row.get(1)?)))?;
    let mut found = Vec::new();
    for row in rows {
        let (key, value): (String, String) = row?;
        found.push((key[prefix.len()..].to_string(), value));
    }
    Ok(found)
}

/// A removal records its intent before the file leaves its path.
const TAKEN: &str = "folder_taken:";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Taken {
    /// Keeps recovery from unbinding another item at the same path.
    pub(crate) item_id: String,
    /// The file's device and inode as the removal found it.
    pub(crate) at: (u64, u64),
    /// Nonzero creation time in nanoseconds since the epoch, when available.
    pub(crate) born: Option<u128>,
    /// Hash of the bytes the binding expected to remove.
    pub(crate) hash: Option<String>,
}

pub(crate) fn set_taken(conn: &Connection, path: &str, taken: &Taken) -> Result<(), CoreError> {
    let value =
        serde_json::to_string(taken).map_err(|error| CoreError::Store(error.to_string()))?;
    crate::store::meta_set(conn, &format!("{TAKEN}{path}"), &value)
}

pub(crate) fn clear_taken(conn: &Connection, path: &str) -> Result<(), CoreError> {
    crate::store::meta_delete(conn, &format!("{TAKEN}{path}"))
}

/// An unreadable record still identifies its path by its key.
pub(crate) fn taken(conn: &Connection) -> Result<Vec<(String, Option<Taken>)>, CoreError> {
    Ok(under(conn, TAKEN)?
        .into_iter()
        .map(|(path, value)| (path, serde_json::from_str(&value).ok()))
        .collect())
}

/// One `meta` row per item a pull last moved, naming the path its file left,
/// where an editor that did not follow the move may save it again, and the
/// item's version when it moved. Cleared once the moved file is edited or
/// moved by the person.
const MOVED_FROM: &str = "folder_moved_from:";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MovedFrom {
    pub path: String,
    pub version: i64,
}

pub fn set_moved_from(
    conn: &Connection,
    item_id: &str,
    moved: &MovedFrom,
) -> Result<(), CoreError> {
    let value =
        serde_json::to_string(moved).map_err(|error| CoreError::Store(error.to_string()))?;
    crate::store::meta_set(conn, &format!("{MOVED_FROM}{item_id}"), &value)
}

pub fn clear_moved_from(conn: &Connection, item_id: &str) -> Result<(), CoreError> {
    crate::store::meta_delete(conn, &format!("{MOVED_FROM}{item_id}"))
}

/// Where each item's file last left in a pull's move, by item. A row that
/// does not read names nothing.
pub fn moved_from(conn: &Connection) -> Result<HashMap<String, MovedFrom>, CoreError> {
    Ok(under(conn, MOVED_FROM)?
        .into_iter()
        .filter_map(|(item, value)| Some((item, serde_json::from_str(&value).ok()?)))
        .collect())
}

/// One `meta` row per item whose file a scan moved or deleted while writes
/// to it waited, naming the path it had before the first of them: the path
/// the server last held it at, which no file says once it has gone.
const LEFT_AT: &str = "folder_left_at:";

/// Whether `write` has yet to reach the server: unanswered, or blocked.
pub fn unsent(write: &QueuedWrite) -> bool {
    matches!(write.verdict, None | Some(Verdict::Blocked))
}

/// Whether `write` moves its item's file in `folder`: a placement that names
/// a path.
pub fn moves(write: &QueuedWrite, folder: &str) -> bool {
    matches!(write.kind, WriteKind::CreateEdge | WriteKind::UpdateEdge)
        && write.to_id.as_deref() == Some(folder)
        && write.body["properties"]
            .get(super::placement::PATH_PROPERTY)
            .is_some()
}

/// Notes that the file of `item_id` leaves `path`, before the write that
/// sends its move or delete is queued. A row stands only while an unsent
/// write moves or deletes its item's file, so a row whose move or delete
/// was answered is replaced, not kept.
pub fn note_left(
    conn: &Connection,
    folder: &str,
    item_id: &str,
    path: &str,
) -> Result<(), CoreError> {
    for (item, _) in under(conn, LEFT_AT)? {
        let leaving = crate::store::waiting_writes_for_item(conn, &item)?
            .iter()
            .any(|write| {
                unsent(write) && (write.kind == WriteKind::DeleteItem || moves(write, folder))
            });
        if !leaving {
            crate::store::meta_delete(conn, &format!("{LEFT_AT}{item}"))?;
        }
    }
    let key = format!("{LEFT_AT}{item_id}");
    if crate::store::meta_get(conn, &key)?.is_none() {
        crate::store::meta_set(conn, &key, path)?;
    }
    Ok(())
}

/// The rows `note_left` keeps, by item; one counts only while an unsent
/// write moves or deletes its item's file.
pub fn left_at(conn: &Connection) -> Result<HashMap<String, String>, CoreError> {
    Ok(under(conn, LEFT_AT)?.into_iter().collect())
}

/// One `meta` row per old buffer held at the path a pull moved a file from:
/// the bytes it was held at and why. It stands until those bytes change or
/// the file goes.
const STALE_WAIT: &str = "folder_stale_wait:";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StaleWait {
    pub hash: String,
    pub reason: String,
}

pub fn set_stale_wait(conn: &Connection, path: &str, wait: &StaleWait) -> Result<(), CoreError> {
    let value = serde_json::to_string(wait).map_err(|error| CoreError::Store(error.to_string()))?;
    crate::store::meta_set(conn, &format!("{STALE_WAIT}{path}"), &value)
}

pub fn clear_stale_wait(conn: &Connection, path: &str) -> Result<(), CoreError> {
    crate::store::meta_delete(conn, &format!("{STALE_WAIT}{path}"))
}

/// The old buffers held, by path. A row that does not read holds nothing.
pub fn stale_waits(conn: &Connection) -> Result<HashMap<String, StaleWait>, CoreError> {
    Ok(under(conn, STALE_WAIT)?
        .into_iter()
        .filter_map(|(path, value)| Some((path, serde_json::from_str(&value).ok()?)))
        .collect())
}

const DISPLACED: &str = "folder_displaced:";

/// Written before the rename. Recovery only reports records that name an outside directory.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct Displaced {
    pub(crate) dir: String,
    pub(crate) dir_at: (u64, u64),
    pub(crate) aside: String,
    pub(crate) aside_at: (u64, u64),
    pub(crate) displacement: super::landing::Displacement,
}

pub(crate) fn set_displaced(conn: &Connection, displaced: &Displaced) -> Result<(), CoreError> {
    let value =
        serde_json::to_string(displaced).map_err(|error| CoreError::Store(error.to_string()))?;
    crate::store::meta_set(
        conn,
        &format!("{DISPLACED}{}", displaced.displacement.id),
        &value,
    )
}

impl Displaced {
    pub(crate) fn outside(&self) -> bool {
        !in_folder(&self.dir) || !in_folder(&self.aside)
    }
}

/// An empty place denotes the folder's root.
pub(crate) fn in_folder(place: &str) -> bool {
    Path::new(place)
        .components()
        .all(|component| matches!(component, std::path::Component::Normal(_)))
}

pub(crate) fn clear_displaced(conn: &Connection, id: &str) -> Result<(), CoreError> {
    crate::store::meta_delete(conn, &format!("{DISPLACED}{id}"))
}

/// A displaced row that does not read: its id and its value.
pub(crate) type UnreadDisplaced = (String, String);

/// Keep unreadable values so recovery can check their recorded directories.
pub(crate) fn displaced(
    conn: &Connection,
) -> Result<Vec<Result<Displaced, UnreadDisplaced>>, CoreError> {
    Ok(under(conn, DISPLACED)?
        .into_iter()
        .map(|(id, value)| serde_json::from_str(&value).map_err(|_| (id, value)))
        .collect())
}

/// Recover the kept path and source path for reporting an unreadable outside row.
pub(crate) fn unread_outside(id: &str, value: &str) -> Option<(String, String)> {
    let row: serde_json::Value = serde_json::from_str(value).ok()?;
    let text = |value: &serde_json::Value| value.as_str().map(str::to_string);
    let dir = text(&row["dir"]);
    let aside = text(&row["aside"]);
    if [&dir, &aside]
        .into_iter()
        .flatten()
        .all(|place| in_folder(place))
    {
        return None;
    }
    let kept = reserved_name(text(&row["displacement"]["kept"]), id);
    let from = dir
        .clone()
        .zip(text(&row["displacement"]["target"]))
        .map(|(dir, target)| super::joined(&dir, &target))
        .unwrap_or_default();
    Some((
        super::joined(&aside.or(dir).unwrap_or_default(), &kept),
        from,
    ))
}

fn reserved_name(name: Option<String>, id: &str) -> String {
    name.filter(|name| !name.contains('/') && super::landing::is_reserved(Path::new(name)))
        .unwrap_or_else(|| super::landing::reserved(id).to_string_lossy().into_owned())
}

const RETAINED: &str = "folder_retained:";

/// A file read and moved out of its path that a program may still write to,
/// kept under its reserved name for each pass to settle. `dir` and `aside`
/// are as in [`Displaced`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct Retained {
    pub(crate) dir: String,
    pub(crate) dir_at: (u64, u64),
    pub(crate) aside: String,
    pub(crate) aside_at: (u64, u64),
    pub(crate) retained: super::landing::Retained,
}

pub(crate) fn set_retained(conn: &Connection, retained: &Retained) -> Result<(), CoreError> {
    let value =
        serde_json::to_string(retained).map_err(|error| CoreError::Store(error.to_string()))?;
    crate::store::meta_set(conn, &format!("{RETAINED}{}", retained.retained.id), &value)
}

impl Retained {
    pub(crate) fn outside(&self) -> bool {
        !in_folder(&self.dir) || !in_folder(&self.aside)
    }
}

pub(crate) fn clear_retained(conn: &Connection, id: &str) -> Result<(), CoreError> {
    crate::store::meta_delete(conn, &format!("{RETAINED}{id}"))
}

/// A kept file whose row does not read, placed by what of the row does.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Unread {
    pub(crate) id: String,
    pub(crate) aside: String,
    /// Its reserved name in `aside`.
    pub(crate) kept: String,
    /// The path it came from, where the row names one.
    pub(crate) from: String,
    /// The hash of the bytes set aside, where the row still holds one.
    pub(crate) hash: Option<String>,
    /// Whether what of the row reads names a place outside the folder.
    pub(crate) outside: bool,
}

impl Unread {
    fn of(id: String, value: &str) -> Unread {
        let row: serde_json::Value = serde_json::from_str(value).unwrap_or_default();
        let text = |value: &serde_json::Value| value.as_str().map(str::to_string);
        let kept = reserved_name(text(&row["retained"]["kept"]), &id);
        let dir = text(&row["dir"]);
        let aside = text(&row["aside"]);
        let from = dir
            .clone()
            .zip(text(&row["retained"]["target"]))
            .map(|(dir, target)| super::joined(&dir, &target))
            .unwrap_or_default();
        let outside = [&dir, &aside]
            .into_iter()
            .flatten()
            .any(|place| !in_folder(place));
        Unread {
            hash: text(&row["retained"]["read"]["hash"]),
            // Without an aside, the source directory is only a reporting hint.
            aside: aside.or(dir.filter(|_| outside)).unwrap_or_default(),
            kept,
            from,
            id,
            outside,
        }
    }
}

/// Every file kept for a pass to settle.
pub(crate) fn retained(conn: &Connection) -> Result<Vec<Result<Retained, Box<Unread>>>, CoreError> {
    Ok(under(conn, RETAINED)?
        .into_iter()
        .map(|(id, value)| {
            serde_json::from_str(&value).map_err(|_| Box::new(Unread::of(id, &value)))
        })
        .collect())
}

/// Whether any file is kept for a pass to settle.
pub(crate) fn any_retained(conn: &Connection) -> Result<bool, CoreError> {
    let above = format!("{}{}", &RETAINED[..RETAINED.len() - 1], ';');
    Ok(conn
        .query_row_cached(
            "SELECT 1 FROM meta WHERE key >= ?1 AND key < ?2 LIMIT 1",
            params![RETAINED, above],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

const DISCARDING: &str = "folder_discarding:";

/// The private name must be recoverable before the rename.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Discarding {
    /// The id of the kept file's record.
    pub(crate) id: String,
    /// The directory both names are in, as in [`Retained`].
    pub(crate) aside: String,
    /// Its reserved name, which it goes back to where that is free.
    pub(crate) kept: String,
    pub(crate) private: String,
    /// The path it came from, where its record names one.
    pub(crate) from: String,
    /// Why the discard left it under the private name, once it did.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) left: Option<String>,
}

impl Discarding {
    /// Its key's path, which names the file under its private name.
    pub(crate) fn path(&self) -> String {
        super::joined(&self.aside, &self.private)
    }

    fn key(&self) -> String {
        format!("{DISCARDING}{}", self.path())
    }
}

pub(crate) fn mark_discarding(
    conn: &Connection,
    discarding: Discarding,
    mark: super::landing::Mark<'_>,
) -> Result<(), CoreError> {
    let left = match mark {
        super::landing::Mark::Free => return crate::store::meta_delete(conn, &discarding.key()),
        super::landing::Mark::Moving => None,
        super::landing::Mark::Left(reason) => Some(reason.to_string()),
    };
    set_discarding(conn, &Discarding { left, ..discarding })
}

pub(crate) fn set_discarding(conn: &Connection, discarding: &Discarding) -> Result<(), CoreError> {
    let value =
        serde_json::to_string(discarding).map_err(|error| CoreError::Store(error.to_string()))?;
    crate::store::meta_set(conn, &discarding.key(), &value)
}

/// The key retains the private path even if the value cannot be read.
pub(crate) fn discarding(
    conn: &Connection,
) -> Result<Vec<(String, Option<Discarding>)>, CoreError> {
    Ok(under(conn, DISCARDING)?
        .into_iter()
        .map(|(path, value)| (path, serde_json::from_str(&value).ok()))
        .collect())
}

pub(crate) fn clear_discarding_at(conn: &Connection, path: &str) -> Result<(), CoreError> {
    crate::store::meta_delete(conn, &format!("{DISCARDING}{path}"))
}

const KEPT: &str = "folder_kept:";

/// A person's file a write or a removal kept beside its path, or could not
/// put back, for the next report to name.
pub(crate) fn put_kept(conn: &Connection, path: &str, reason: &str) -> Result<(), CoreError> {
    crate::store::meta_set(conn, &format!("{KEPT}{path}"), reason)
}

/// The files kept since the last report, each once, by path.
pub(crate) fn take_kept(conn: &Connection) -> Result<Vec<(String, String)>, CoreError> {
    let kept = under(conn, KEPT)?;
    for (path, _) in &kept {
        crate::store::meta_delete(conn, &format!("{KEPT}{path}"))?;
    }
    Ok(kept)
}

/// The edge ends lines hold, each with whether the folder made its pin.
pub fn edge_ends(conn: &Connection) -> Result<Vec<(String, bool)>, CoreError> {
    Ok(under(conn, EDGE_END)?
        .into_iter()
        .map(|(id, made)| (id, made == MADE))
        .collect())
}

pub fn hold_edge_end(conn: &Connection, id: &str, made: bool) -> Result<(), CoreError> {
    crate::store::meta_set(
        conn,
        &format!("{EDGE_END}{id}"),
        if made { MADE } else { "" },
    )
}

/// Keeps a line's hold of `id`, but as a hold of a pin the folder did not
/// make, so its release leaves the pin to whoever holds it now.
pub fn disown_edge_end(conn: &Connection, id: &str) -> Result<(), CoreError> {
    let key = format!("{EDGE_END}{id}");
    if crate::store::meta_get(conn, &key)?.as_deref() == Some(MADE) {
        crate::store::meta_set(conn, &key, "")?;
    }
    Ok(())
}

/// Lets a line's hold go, and the pin with it where the folder made it and
/// no binding holds it.
pub fn release_edge_end(conn: &Connection, id: &str, made: bool) -> Result<(), CoreError> {
    crate::store::meta_delete(conn, &format!("{EDGE_END}{id}"))?;
    if made && bound_to_item(conn, id)?.is_none() {
        crate::store::unpin(conn, id)?;
    }
    Ok(())
}

/// What `read_bound` reads and `bindings` digests, in order. `seen_at` is left out: every scan rewrites it.
const BOUND_COLUMNS: &str = "path, item_id, identity, content_hash, written_hash, links, edge_lines, edit_line, held, own, writes, presentation, blob, embeds";

pub fn bound_at(conn: &Connection, path: &str) -> Result<Option<Bound>, CoreError> {
    Ok(conn
        .query_row(
            &format!("SELECT {BOUND_COLUMNS} FROM folder_files WHERE path = ?1"),
            [path],
            read_bound,
        )
        .optional()?)
}

/// Whether a file is held, or holds a refused change: the scan judges such a
/// file again, though its bytes are as they were, which a pull does not.
pub fn any_held_or_refused(conn: &Connection) -> Result<bool, CoreError> {
    Ok(conn.query_row_cached(
        "SELECT EXISTS (SELECT 1 FROM folder_files WHERE held IS NOT NULL
           OR (json_valid(writes) AND json_array_length(writes, '$.refused') > 0))",
        [],
        |row| row.get(0),
    )?)
}

pub fn bound_to_item(conn: &Connection, item_id: &str) -> Result<Option<Bound>, CoreError> {
    Ok(conn
        .query_row(
            &format!("SELECT {BOUND_COLUMNS} FROM folder_files WHERE item_id = ?1"),
            [item_id],
            read_bound,
        )
        .optional()?)
}

/// Whether a file other than the one at `path` is bound to the item.
pub fn bound_beside(conn: &Connection, item_id: &str, path: &str) -> Result<bool, CoreError> {
    Ok(conn.query_row_cached(
        "SELECT EXISTS (SELECT 1 FROM folder_files WHERE item_id = ?1 AND path <> ?2)",
        [item_id, path],
        |row| row.get(0),
    )?)
}

pub fn bound_paths(conn: &Connection) -> Result<Vec<(String, String)>, CoreError> {
    let mut statement = conn.prepare("SELECT path, item_id FROM folder_files ORDER BY path")?;
    let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn every_bound(conn: &Connection) -> Result<Vec<Bound>, CoreError> {
    bound_where(conn, "", [])
}

/// Every bound file with a refused change in its record.
pub fn bound_refused(conn: &Connection) -> Result<Vec<Bound>, CoreError> {
    bound_where(
        conn,
        "WHERE json_valid(writes) AND json_array_length(writes, '$.refused') > 0",
        [],
    )
}

/// The paths bound to an item the copy no longer holds.
pub fn bound_to_lost_items(conn: &Connection) -> Result<Vec<String>, CoreError> {
    let mut statement = conn.prepare(
        "SELECT path FROM folder_files WHERE item_id NOT IN (SELECT id FROM items) ORDER BY path",
    )?;
    let rows = statement.query_map([], |row| row.get(0))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Every bound file whose record waits on the answer of a write.
pub fn bound_awaiting(conn: &Connection) -> Result<Vec<Bound>, CoreError> {
    bound_where(
        conn,
        "WHERE json_valid(writes) AND json_array_length(writes, '$.queued') > 0",
        [],
    )
}

pub fn bound_with_identity(conn: &Connection, identity: &str) -> Result<Vec<Bound>, CoreError> {
    bound_where(conn, "WHERE identity = ?1", [identity])
}

pub fn every_bound_to_item(conn: &Connection, item_id: &str) -> Result<Vec<Bound>, CoreError> {
    bound_where(conn, "WHERE item_id = ?1", [item_id])
}

pub fn bound_with_hash(conn: &Connection, content_hash: &str) -> Result<Vec<Bound>, CoreError> {
    bound_where(conn, "WHERE content_hash = ?1", [content_hash])
}

/// A bound file's item and a digest of its row, so a pull keeps no file's text between pulls.
#[derive(Debug, Clone, PartialEq)]
pub struct Binding {
    pub item_id: String,
    digest: u64,
}

/// Every bound file's binding, by path, read a row at a time.
pub fn bindings(conn: &Connection) -> Result<HashMap<String, Binding>, CoreError> {
    use rusqlite::types::ValueRef;
    use std::hash::Hasher;
    let mut statement = conn.prepare(&format!("SELECT {BOUND_COLUMNS} FROM folder_files"))?;
    let columns = statement.column_count();
    let mut rows = statement.query([])?;
    let mut found = HashMap::new();
    while let Some(row) = rows.next()? {
        let mut hasher = std::hash::DefaultHasher::new();
        for at in 0..columns {
            match row.get_ref(at)? {
                ValueRef::Null => hasher.write_u8(0),
                ValueRef::Integer(number) => hasher.write_i64(number),
                ValueRef::Real(number) => hasher.write_u64(number.to_bits()),
                ValueRef::Text(bytes) | ValueRef::Blob(bytes) => {
                    hasher.write_usize(bytes.len());
                    hasher.write(bytes);
                }
            }
        }
        found.insert(
            row.get(0)?,
            Binding {
                item_id: row.get(1)?,
                digest: hasher.finish(),
            },
        );
    }
    Ok(found)
}

/// The ids of the items that have a file here.
pub fn bound_item_ids(conn: &Connection) -> Result<std::collections::HashSet<String>, CoreError> {
    let mut statement = conn.prepare("SELECT item_id FROM folder_files")?;
    let ids = statement.query_map([], |row| row.get(0))?;
    Ok(ids.collect::<rusqlite::Result<_>>()?)
}

fn bound_where<P: rusqlite::Params>(
    conn: &Connection,
    clause: &str,
    params: P,
) -> Result<Vec<Bound>, CoreError> {
    let mut statement = conn.prepare(&format!(
        "SELECT {BOUND_COLUMNS} FROM folder_files {clause} ORDER BY path",
    ))?;
    let rows = statement.query_map(params, read_bound)?;
    let mut bound = Vec::new();
    for row in rows {
        bound.push(row?);
    }
    Ok(bound)
}

fn read_bound(row: &rusqlite::Row<'_>) -> rusqlite::Result<Bound> {
    let links: String = row.get(5)?;
    let path: String = row.get(0)?;
    Ok(Bound {
        item_id: row.get(1)?,
        identity: row.get(2)?,
        content_hash: row.get(3)?,
        written_hash: row.get(4)?,
        presentation: row
            .get::<_, Option<String>>(11)?
            .and_then(|value| serde_json::from_str(&value).ok()),
        blob: row.get(12)?,
        // Unreadable, it names no links, so no edge is removed for it.
        links: serde_json::from_str(&links).unwrap_or_default(),
        embeds: row
            .get::<_, Option<String>>(13)?
            .and_then(|embeds| serde_json::from_str(&embeds).ok())
            .unwrap_or_default(),
        lines: recorded(row, 6, &path)?,
        edit_line: row.get(7)?,
        held: row.get(8)?,
        // Unreadable, it remembers nothing written, and no own line is sent.
        own: row
            .get::<_, Option<String>>(9)?
            .and_then(|own| serde_json::from_str(&own).ok()),
        writes: recorded(row, 10, &path)?,
        path,
    })
}

/// Read as empty, a record of lines would let a line taken out leave its edge
/// on the server, and one of writes would drop a refusal the file shows.
fn recorded<T: serde::de::DeserializeOwned>(
    row: &rusqlite::Row<'_>,
    at: usize,
    path: &str,
) -> rusqlite::Result<T> {
    serde_json::from_str(&row.get::<_, String>(at)?).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            at,
            rusqlite::types::Type::Text,
            format!("what the folder records of {path} cannot be read: {error}").into(),
        )
    })
}

/// The first file whose record of its lines or writes does not read as this
/// build's, which a store this build did not make can hold.
pub(crate) fn unreadable_record(conn: &Connection) -> Result<Option<String>, CoreError> {
    let mut statement = conn.prepare("SELECT path, edge_lines, writes FROM main.folder_files")?;
    let mut rows = statement.query([])?;
    while let Some(row) = rows.next()? {
        let lines = serde_json::from_str::<Vec<Line>>(&row.get::<_, String>(1)?);
        let writes = serde_json::from_str::<Writes>(&row.get::<_, String>(2)?);
        if lines.is_err() || writes.is_err() {
            return Ok(Some(row.get(0)?));
        }
    }
    Ok(None)
}

/// How a held file's reason begins; a line `EDGES_WAITING` on the server is
/// asked again at each scan that can reach it.
pub const REFUSED: &str = "refused: ";
pub const UNREADABLE: &str = "unreadable: ";
pub const EDGES: &str = "edges: ";
pub const EDGES_WAITING: &str = "edges, waiting: ";

/// Moves with the event cursor and with every change to the copy's rows,
/// local or pulled, so a name that matched no item, or several, is looked up
/// again only after something that can change its answer.
pub fn copy_moment(conn: &Connection) -> Result<String, CoreError> {
    let cursor = crate::store::meta_get(conn, crate::store::META_EVENT_CURSOR)?;
    let revision = crate::store::copy_revision(conn)?;
    Ok(format!("{}/{revision}", cursor.unwrap_or_default()))
}

/// `OR IGNORE` keeps the first sighting, so a folder scanning every second
/// still reaches the grace.
pub fn journal_missing(conn: &Connection, path: &str, item_id: &str) -> Result<(), CoreError> {
    conn.execute_cached(
        "INSERT OR IGNORE INTO folder_journal
           (path, item_id, missing_since, identity, content_hash)
         SELECT ?1, ?2, ?3, f.identity, f.content_hash
         FROM (SELECT 1) LEFT JOIN folder_files f ON f.path = ?1 AND f.item_id = ?2",
        params![
            path,
            item_id,
            crate::store::iso_at(crate::clock::system_time())
        ],
    )?;
    Ok(())
}

/// A row that outlives its question becomes a delete nobody asked for.
pub fn journal_clear(conn: &Connection, path: &str, item_id: &str) -> Result<(), CoreError> {
    conn.execute_cached(
        "DELETE FROM folder_journal WHERE path = ?1 AND item_id = ?2",
        [path, item_id],
    )?;
    Ok(())
}

pub fn journal_is_carried(conn: &Connection, path: &str, item_id: &str) -> Result<bool, CoreError> {
    Ok(conn
        .prepare_cached(
            "SELECT 1 FROM folder_journal WHERE path = ?1 AND item_id = ?2 AND kept = 'carried'",
        )?
        .exists([path, item_id])?)
}

/// Records that the file at `carrier` carries the missing file at `path`,
/// and where given the carrier's `identity` as the binding's. Its grace
/// starts again once no file carries it (`journal_uncarried`).
pub fn journal_carried(
    conn: &Connection,
    path: &str,
    item_id: &str,
    carrier: &str,
    identity: Option<&str>,
) -> Result<(), CoreError> {
    if let Some(identity) = identity {
        conn.execute_cached(
            "UPDATE folder_files SET identity = ?3 WHERE path = ?1 AND item_id = ?2",
            params![path, item_id, identity],
        )?;
    }
    conn.execute_cached(
        "INSERT INTO folder_journal
           (path, item_id, missing_since, kept, reason, identity, content_hash)
         SELECT ?1, ?2, ?3, 'carried', ?4, f.identity, f.content_hash
         FROM (SELECT 1) LEFT JOIN folder_files f ON f.path = ?1 AND f.item_id = ?2
         WHERE true
         ON CONFLICT (path, item_id) DO UPDATE SET
           kept = 'carried', reason = excluded.reason,
           identity = coalesce(excluded.identity, identity)",
        params![
            path,
            item_id,
            crate::store::iso_at(crate::clock::system_time()),
            carrier
        ],
    )?;
    Ok(())
}

/// Journals as missing from now a file no other file carries any longer.
pub fn journal_uncarried(conn: &Connection, path: &str, item_id: &str) -> Result<(), CoreError> {
    conn.execute_cached(
        "DELETE FROM folder_journal WHERE path = ?1 AND item_id = ?2 AND kept = 'carried'",
        [path, item_id],
    )?;
    journal_missing(conn, path, item_id)
}

/// Why a sweep kept a missing file's binding.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Kept {
    /// Moved to a folder that knows the file only by this binding, and that
    /// has not taken it yet.
    Arriving,
    /// Whether it was deleted or moved cannot be told, and why: held, with
    /// no delete and no file written, until the person settles it
    /// (`Folder::settle_held`), a file comes back at its path, or its item
    /// leaves. No pass that cannot read the file's directory ends it.
    Unsure(Unsure),
    /// The file at this path, which the scan holds for its name or skips,
    /// carries its identity or its item's ID.
    Carried(String),
}

/// Why a missing file was held and which other directories it still waits on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Unsure {
    pub reason: String,
    /// `None` for a hold saved before holds recorded them.
    pub waits_on: Option<Vec<PathBuf>>,
}

impl Unsure {
    /// Held for a reason no other folder's state gave.
    pub fn why(reason: impl Into<String>) -> Unsure {
        Unsure {
            reason: reason.into(),
            waits_on: Some(Vec::new()),
        }
    }

    pub fn on(reason: impl Into<String>, waits_on: Vec<PathBuf>) -> Unsure {
        Unsure {
            reason: reason.into(),
            waits_on: Some(waits_on),
        }
    }

    pub fn waits_on(&self, dir: &Path) -> bool {
        self.waits_on
            .as_ref()
            .is_some_and(|dirs| dirs.iter().any(|waited| waited == dir))
    }
}

/// A journaled delete.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Journaled {
    pub path: String,
    pub item_id: String,
    pub missing_since: String,
    /// What the last sweep that looked decided, where it kept the binding.
    pub kept: Option<Kept>,
    pub identity: Option<String>,
    pub content_hash: Option<String>,
}

impl Journaled {
    pub fn carried(&self) -> bool {
        matches!(self.kept, Some(Kept::Carried(_)))
    }

    /// Kept until a look at the other folders finds the folder it went to
    /// has taken it.
    pub fn looked_for(&self) -> bool {
        matches!(self.kept, Some(Kept::Arriving))
    }

    pub fn held(&self) -> bool {
        matches!(self.kept, Some(Kept::Unsure(_)))
    }
}

/// Records what a sweep decided for a journaled file whose binding it kept,
/// or with `None` that it is any pull's to write.
pub fn journal_keep(
    conn: &Connection,
    path: &str,
    item_id: &str,
    kept: Option<&Kept>,
) -> Result<(), CoreError> {
    let (kind, reason, waits_on) = match kept {
        Some(Kept::Arriving) => (Some("arriving"), None, None),
        Some(Kept::Unsure(unsure)) => (
            Some("unsure"),
            Some(unsure.reason.as_str()),
            unsure
                .waits_on
                .as_ref()
                .map(serde_json::to_string)
                .transpose()
                .map_err(|error| CoreError::Store(error.to_string()))?,
        ),
        Some(Kept::Carried(carrier)) => (Some("carried"), Some(carrier.as_str()), None),
        None => (None, None, None),
    };
    conn.execute_cached(
        "UPDATE folder_journal SET kept = ?3, reason = ?4, waits_on = ?5
         WHERE path = ?1 AND item_id = ?2",
        params![path, item_id, kind, reason, waits_on],
    )?;
    Ok(())
}

pub fn journaled_at(
    conn: &Connection,
    path: &str,
    item_id: &str,
) -> Result<Option<Journaled>, CoreError> {
    Ok(conn
        .prepare_cached(&format!(
            "SELECT {JOURNALED} FROM folder_journal WHERE path = ?1 AND item_id = ?2"
        ))?
        .query_row([path, item_id], journaled_row)
        .optional()?)
}

const JOURNALED: &str =
    "path, item_id, missing_since, kept, reason, identity, content_hash, waits_on";

fn journaled_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Journaled> {
    let reason: Option<String> = row.get(4)?;
    Ok(Journaled {
        path: row.get(0)?,
        item_id: row.get(1)?,
        missing_since: row.get(2)?,
        kept: match row.get::<_, Option<String>>(3)?.as_deref() {
            Some("arriving") => Some(Kept::Arriving),
            Some("carried") => Some(Kept::Carried(reason.unwrap_or_default())),
            Some(_) => Some(Kept::Unsure(Unsure {
                reason: reason.unwrap_or_default(),
                // Unreadable, it waits on nothing a forget can name.
                waits_on: row
                    .get::<_, Option<String>>(7)?
                    .map(|json| serde_json::from_str(&json).unwrap_or_default()),
            })),
            None => None,
        },
        identity: row.get(5)?,
        content_hash: row.get(6)?,
    })
}

/// Every journaled delete, by path and item.
pub fn journaled(conn: &Connection) -> Result<Vec<Journaled>, CoreError> {
    let mut statement = conn.prepare(&format!(
        "SELECT {JOURNALED} FROM folder_journal ORDER BY path, item_id"
    ))?;
    let rows = statement.query_map([], journaled_row)?;
    let mut journaled = Vec::new();
    for row in rows {
        journaled.push(row?);
    }
    Ok(journaled)
}

/// A digest of what the folder keeps of its files: each binding but when it
/// was last seen, the journal, and the folder's entries in `meta` but its
/// health and its rate-limit wait, which a pass writes whatever it finds.
pub fn record_digest(conn: &Connection) -> Result<[u8; 32], CoreError> {
    use rusqlite::types::ValueRef;
    use sha2::{Digest, Sha256};
    let mut digest = Sha256::new();
    let mut take = |sql: &str, params: &[&dyn rusqlite::ToSql]| -> Result<(), CoreError> {
        let mut statement = conn.prepare(sql)?;
        let columns = statement.column_count();
        let mut rows = statement.query(params)?;
        while let Some(row) = rows.next()? {
            for column in 0..columns {
                // Tagged and length-prefixed, so no two rows read as one.
                let (tag, bytes): (u8, Vec<u8>) = match row.get_ref(column)? {
                    ValueRef::Null => (0, Vec::new()),
                    ValueRef::Integer(value) => (1, value.to_le_bytes().to_vec()),
                    ValueRef::Real(value) => (2, value.to_le_bytes().to_vec()),
                    ValueRef::Text(value) => (3, value.to_vec()),
                    ValueRef::Blob(value) => (4, value.to_vec()),
                };
                digest.update([tag]);
                digest.update((bytes.len() as u64).to_le_bytes());
                digest.update(&bytes);
            }
        }
        digest.update([0xff]);
        Ok(())
    };
    take(
        "SELECT path, item_id, identity, content_hash, presentation, blob, written_hash, links, edge_lines, edit_line, held, own, writes FROM folder_files ORDER BY path",
        &[],
    )?;
    take(
        "SELECT path, item_id, missing_since, kept, reason, identity, content_hash, waits_on
         FROM folder_journal ORDER BY path, item_id",
        &[],
    )?;
    take(
        "SELECT key, value FROM meta WHERE key >= ?1 AND key < ?2 AND key NOT IN (?3, ?4) ORDER BY key",
        &[
            &"folder_",
            &crate::store::prefix_end("folder_"),
            &super::health::META,
            &super::watch::SEND_AGAIN_AT,
        ],
    )?;
    Ok(digest.finalize().into())
}

pub fn bound_count(conn: &Connection) -> Result<usize, CoreError> {
    let count: i64 =
        conn.query_row_cached("SELECT COUNT(*) FROM folder_files", [], |row| row.get(0))?;
    Ok(usize::try_from(count).unwrap_or(0))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Removal {
    Disk,
    Pull,
}

impl Removal {
    fn key(self) -> &'static str {
        match self {
            Removal::Disk => "folder_paused_disk",
            Removal::Pull => "folder_paused_pull",
        }
    }
}

pub fn paused(conn: &Connection, removal: Removal) -> Result<Vec<String>, CoreError> {
    list(conn, removal.key())
}

fn list(conn: &Connection, key: &str) -> Result<Vec<String>, CoreError> {
    Ok(crate::store::meta_get(conn, key)?
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default())
}

const PAUSED_ADDITIONS: &str = "folder_paused_add";

/// The new files the last scan held back for confirmation, which no file's
/// binding shows: a paused file is not bound until it is let go.
pub fn paused_additions(conn: &Connection) -> Result<Vec<String>, CoreError> {
    list(conn, PAUSED_ADDITIONS)
}

pub fn set_paused_additions(conn: &Connection, paths: &[String]) -> Result<(), CoreError> {
    set_list(conn, PAUSED_ADDITIONS, paths)
}

const HELD_OUTSIDE: &str = "folder_held_outside";

/// The new files the last scan held because the query would not hold them
/// and the folder holds such files (`outside_query: hold`). They have no item
/// and no binding.
pub fn held_outside(conn: &Connection) -> Result<Vec<String>, CoreError> {
    list(conn, HELD_OUTSIDE)
}

pub fn set_held_outside(conn: &Connection, paths: &[String]) -> Result<(), CoreError> {
    set_list(conn, HELD_OUTSIDE, paths)
}

const PAUSED_BASE: &str = "folder_paused_add_base";

/// How many new files the window held when the standing pause began.
pub fn paused_base(conn: &Connection) -> Result<usize, CoreError> {
    Ok(crate::store::meta_get(conn, PAUSED_BASE)?
        .and_then(|text| text.parse().ok())
        .unwrap_or_default())
}

pub fn set_paused_base(conn: &Connection, base: usize) -> Result<(), CoreError> {
    if crate::store::meta_get(conn, PAUSED_BASE)?.as_deref() == Some(base.to_string().as_str()) {
        return Ok(());
    }
    crate::store::meta_set(conn, PAUSED_BASE, &base.to_string())
}

pub fn clear_paused_base(conn: &Connection) -> Result<(), CoreError> {
    crate::store::meta_delete(conn, PAUSED_BASE)
}

const ADDITIONS_SENT: &str = "folder_additions_sent";

/// How long a sent new file counts towards the addition threshold.
pub const ADDITIONS_WINDOW_MS: i64 = 10 * 60_000;

/// The new files the folder sent lately, by the minute (since the epoch) it
/// sent them in, so a drop is judged by how fast it arrives and the record
/// stays small however many files come.
pub fn additions_sent(conn: &Connection) -> Result<Vec<(i64, usize)>, CoreError> {
    Ok(crate::store::meta_get(conn, ADDITIONS_SENT)?
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default())
}

/// Without the minutes that fell out of the window at `now_ms`, and without
/// those after the current minute, which a clock set back leaves behind, and
/// how many files the rest hold.
pub fn within_window(sent: &mut Vec<(i64, usize)>, now_ms: i64) -> usize {
    let now_minute = now_ms.div_euclid(60_000);
    sent.retain(|(minute, _)| {
        *minute <= now_minute && (minute + 1) * 60_000 > now_ms - ADDITIONS_WINDOW_MS
    });
    sent.iter().map(|(_, count)| count).sum()
}

/// Adds `count` files sent at `now_ms` to a window.
pub fn record_sent(sent: &mut Vec<(i64, usize)>, now_ms: i64, count: usize) {
    let minute = now_ms.div_euclid(60_000);
    match sent.iter_mut().find(|(at, _)| *at == minute) {
        Some((_, total)) => *total += count,
        None => sent.push((minute, count)),
    }
}

pub fn set_additions_sent(conn: &Connection, sent: &[(i64, usize)]) -> Result<(), CoreError> {
    if sent.is_empty() {
        return crate::store::meta_delete(conn, ADDITIONS_SENT);
    }
    let json = serde_json::to_string(sent)?;
    if crate::store::meta_get(conn, ADDITIONS_SENT)?.as_deref() == Some(json.as_str()) {
        return Ok(());
    }
    crate::store::meta_set(conn, ADDITIONS_SENT, &json)
}

const ADDITIONS_ALLOWED: &str = "folder_additions_allowed";

/// The files the folder held back that a person has confirmed, taken by the
/// next scan.
pub fn additions_allowed(conn: &Connection) -> Result<Vec<String>, CoreError> {
    list(conn, ADDITIONS_ALLOWED)
}

pub fn set_additions_allowed(conn: &Connection, paths: &[String]) -> Result<(), CoreError> {
    set_list(conn, ADDITIONS_ALLOWED, paths)
}

const ADDITIONS_GATED: &str = "folder_additions_gated";

/// Whether the folder has had its first scan after its first sync, which no
/// threshold counts. A folder that holds files has had it already.
pub fn additions_gated(conn: &Connection) -> Result<bool, CoreError> {
    Ok(crate::store::meta_get(conn, ADDITIONS_GATED)?.is_some() || bound_count(conn)? > 0)
}

pub fn gate_additions(conn: &Connection) -> Result<(), CoreError> {
    if crate::store::meta_get(conn, ADDITIONS_GATED)?.is_none() {
        crate::store::meta_set(conn, ADDITIONS_GATED, "1")?;
    }
    Ok(())
}

/// The file metadata last recorded by a scan or pull.
pub fn stat_of(conn: &Connection, path: &str) -> Result<Option<String>, CoreError> {
    Ok(conn
        .query_row_cached(
            "SELECT stat FROM folder_stats WHERE path = ?1",
            [path],
            |row| row.get(0),
        )
        .optional()?)
}

/// Forgets the file metadata recorded at `path`, so the next scan reads the
/// file there.
pub(crate) fn forget_stat(conn: &Connection, path: &str) -> Result<(), CoreError> {
    conn.execute_cached("DELETE FROM folder_stats WHERE path = ?1", [path])?;
    Ok(())
}

/// With `whole`, every row is replaced, so a row outlives its file only
/// until the next full pass.
pub fn set_stats(
    conn: &Connection,
    stats: &[(String, String)],
    whole: bool,
) -> Result<(), CoreError> {
    // One commit, not one per file of a large folder.
    let tx = conn.unchecked_transaction()?;
    if whole {
        tx.execute_cached("DELETE FROM folder_stats", [])?;
    }
    for (path, stat) in stats {
        tx.execute_cached(
            "INSERT INTO folder_stats (path, stat) VALUES (?1, ?2)
             ON CONFLICT (path) DO UPDATE SET stat = excluded.stat",
            [path, stat],
        )?;
    }
    tx.commit()?;
    Ok(())
}

/// Each file the server answered names an item it does not show, by path,
/// with the id it named and the hash of the bytes that named it.
pub fn unheld(conn: &Connection) -> Result<HashMap<String, (String, String)>, CoreError> {
    let mut statement =
        conn.prepare_cached("SELECT path, item_id, content_hash FROM folder_unheld")?;
    let rows = statement
        .query_map([], |row| Ok((row.get(0)?, (row.get(1)?, row.get(2)?))))?
        .collect::<Result<_, _>>()?;
    Ok(rows)
}

/// Records `answered`, each a file read this pass whose id the server does
/// not show, and drops the row in `known` of every other file in `read`.
pub fn set_unheld(
    conn: &Connection,
    known: &HashMap<String, (String, String)>,
    read: &[&str],
    answered: &HashMap<&str, (&str, &str)>,
) -> Result<(), CoreError> {
    let tx = conn.unchecked_transaction()?;
    for path in read {
        let was = known
            .get(*path)
            .map(|(item_id, hash)| (item_id.as_str(), hash.as_str()));
        match answered.get(path) {
            Some(&now) if was != Some(now) => {
                tx.execute_cached(
                    "INSERT INTO folder_unheld (path, item_id, content_hash) VALUES (?1, ?2, ?3)
                     ON CONFLICT (path) DO UPDATE SET
                       item_id = excluded.item_id, content_hash = excluded.content_hash",
                    [path, now.0, now.1],
                )?;
            }
            None if was.is_some() => {
                tx.execute_cached("DELETE FROM folder_unheld WHERE path = ?1", [path])?;
            }
            _ => {}
        }
    }
    tx.commit()?;
    Ok(())
}

/// Drops the row of each file the walk did not find.
pub fn prune_unheld(
    conn: &Connection,
    found: &std::collections::HashSet<String>,
) -> Result<(), CoreError> {
    for path in unheld(conn)?.into_keys() {
        if !found.contains(&path) {
            conn.execute_cached("DELETE FROM folder_unheld WHERE path = ?1", [path])?;
        }
    }
    Ok(())
}

pub fn set_paused(conn: &Connection, removal: Removal, paths: &[String]) -> Result<(), CoreError> {
    set_list(conn, removal.key(), paths)
}

/// A list kept in one `meta` row, written only where it changed, since a
/// watch sets it on every pass.
fn set_list(conn: &Connection, key: &str, list: &[String]) -> Result<(), CoreError> {
    if self::list(conn, key)? == list {
        return Ok(());
    }
    if list.is_empty() {
        return crate::store::meta_delete(conn, key);
    }
    crate::store::meta_set(conn, key, &serde_json::to_string(list)?)
}

/// The items the last pull left in place because the query no longer
/// matches them, so a status read needs no pull of its own.
const UNMATCHED: &str = "folder_unmatched";

pub fn unmatched(conn: &Connection) -> Result<Vec<String>, CoreError> {
    list(conn, UNMATCHED)
}

pub fn set_unmatched(conn: &Connection, ids: &[String]) -> Result<(), CoreError> {
    set_list(conn, UNMATCHED, ids)
}

/// The items made from a file of this folder whose state the query's states
/// did not hold when they were made, and that no pull has seen in those
/// states since. Their files are the person's, kept and counted unmatched,
/// until the item is first in a state the query holds.
const OUTSIDE_STATE: &str = "folder_new_outside_state";

pub fn new_outside_state(conn: &Connection) -> Result<Vec<String>, CoreError> {
    list(conn, OUTSIDE_STATE)
}

pub fn set_new_outside_state(conn: &Connection, ids: &[String]) -> Result<(), CoreError> {
    set_list(conn, OUTSIDE_STATE, ids)
}

#[cfg(test)]
mod tests {
    use std::collections::{HashMap, HashSet};

    use super::{BOUND_COLUMNS, bindings, prune_unheld, set_unheld, unheld};

    #[test]
    fn keeps_where_a_file_left_only_while_an_unsent_write_moves_or_deletes_it() {
        use crate::model::WriteKind;
        let core = crate::Core::open_in_memory(None).unwrap();
        let conn = core.conn().unwrap();
        let queue = |kind: WriteKind, item: &str, payload: &str| {
            let edge = matches!(kind, WriteKind::UpdateEdge);
            crate::store::enqueue(
                &conn,
                &crate::store::NewWrite {
                    kind,
                    item_id: Some(item),
                    to_id: edge.then_some("folder"),
                    edge_id: edge.then_some("placement"),
                    namespace: None,
                    tag: None,
                    blob: None,
                    base_version: Some(1),
                    payload,
                    depends_on: &[],
                },
            )
            .unwrap()
        };
        let moved = r#"{"properties":{"path":"next.md"}}"#;
        let answer = |verdict: &str| {
            conn.execute("UPDATE queue SET verdict = ?1", [verdict])
                .unwrap();
        };
        let note = |item: &str, path: &str| super::note_left(&conn, "folder", item, path).unwrap();
        let left = |item: &str| super::left_at(&conn).unwrap().get(item).cloned();

        note("a", "first.md");
        queue(WriteKind::UpdateEdge, "a", moved);
        note("a", "second.md");
        assert_eq!(left("a").as_deref(), Some("first.md"));
        note("b", "other.md");
        assert_eq!(left("a").as_deref(), Some("first.md"));

        // An answered move counts for nothing, though an edit after it waits.
        answer("accepted");
        queue(WriteKind::UpdateItem, "a", "{}");
        note("a", "second.md");
        assert_eq!(left("a").as_deref(), Some("second.md"));
        assert_eq!(left("b"), None);

        // A delete waiting keeps the row as a move does.
        queue(WriteKind::DeleteItem, "a", "{}");
        note("a", "third.md");
        assert_eq!(left("a").as_deref(), Some("second.md"));

        // A dead write is not sent, and a placement naming no path moves nothing.
        answer("dead");
        queue(WriteKind::UpdateEdge, "a", r#"{"properties":{"form":{}}}"#);
        note("a", "fourth.md");
        assert_eq!(left("a").as_deref(), Some("fourth.md"));
    }

    #[test]
    fn keeps_an_unheld_answer_until_its_file_changes_is_bound_or_goes() {
        let conn = crate::store::open_in_memory().unwrap();
        let answered = HashMap::from([("a.md", ("one", "h1")), ("b.md", ("two", "h2"))]);
        set_unheld(&conn, &HashMap::new(), &["a.md", "b.md", "c.md"], &answered).unwrap();
        let known = unheld(&conn).unwrap();
        assert_eq!(known.len(), 2);

        // `a.md` changed and was answered again; `b.md` is bound now.
        let answered = HashMap::from([("a.md", ("one", "h3"))]);
        set_unheld(&conn, &known, &["a.md", "b.md"], &answered).unwrap();
        assert_eq!(
            unheld(&conn).unwrap(),
            HashMap::from([("a.md".to_string(), ("one".to_string(), "h3".to_string()))])
        );

        prune_unheld(&conn, &HashSet::from(["c.md".to_string()])).unwrap();
        assert!(unheld(&conn).unwrap().is_empty());
    }

    #[test]
    fn a_record_of_lines_or_writes_that_does_not_read_is_refused_not_read_as_empty() {
        let conn = crate::store::open_in_memory().unwrap();
        let row = |lines: &str, writes: &str| {
            conn.execute("DELETE FROM folder_files", []).unwrap();
            conn.execute(
                "INSERT INTO folder_files (path, item_id, content_hash, links, edge_lines, writes, seen_at)
                 VALUES ('a.md', 'item', 'h', '[]', ?1, ?2, 'then')",
                [lines, writes],
            )
            .unwrap();
        };
        let line = r#"[{"edge_type":"parent-of","end":"to","other":"shelf"}]"#;
        // The witness: this build's records, and the column's default, read.
        row(line, "{}");
        let bound = super::bound_at(&conn, "a.md").unwrap().unwrap();
        assert_eq!(bound.lines.len(), 1);
        assert_eq!(bound.writes, super::Writes::default());
        assert_eq!(super::unreadable_record(&conn).unwrap(), None);

        for (lines, writes) in [
            (
                r#"[{"edge_type":"parent-of","end":"target","other":"shelf"}]"#,
                "{}",
            ),
            (
                "[]",
                r#"{"save":1,"queued":[],"refused":[{"change":{"edge":{"line":{"edge_type":"parent-of","end":"source","other":"shelf"},"shown":true}},"save":1,"reason":"r"}]}"#,
            ),
        ] {
            row(lines, writes);
            let error = super::bound_at(&conn, "a.md").unwrap_err().to_string();
            assert!(error.contains("a.md"), "{error}");
            assert!(super::every_bound(&conn).is_err());
            assert_eq!(
                super::unreadable_record(&conn).unwrap().as_deref(),
                Some("a.md")
            );
        }
    }

    fn digest_of_only_row(conn: &rusqlite::Connection) -> (String, super::Binding) {
        let mut all = bindings(conn).unwrap();
        assert_eq!(all.len(), 1);
        all.drain().next().unwrap()
    }

    #[test]
    fn a_binding_changes_with_each_bound_column_and_not_with_when_it_was_seen() {
        let conn = crate::store::open_in_memory().unwrap();
        let columns: Vec<&str> = BOUND_COLUMNS.split(", ").collect();

        // The query digests every column of the table but `seen_at`.
        let mut table: Vec<String> = conn
            .prepare("SELECT name FROM pragma_table_info('folder_files') WHERE name <> 'seen_at'")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        let mut named: Vec<String> = columns.iter().map(|name| name.to_string()).collect();
        table.sort();
        named.sort();
        assert_eq!(named, table);

        let row = |conn: &rusqlite::Connection| {
            conn.execute("DELETE FROM folder_files", []).unwrap();
            conn.execute(
                "INSERT INTO folder_files (path, item_id, identity, content_hash, written_hash, links, edge_lines, edit_line, held, own, writes, presentation, blob, embeds, seen_at)
                 VALUES ('a.md', 'item', 'id', 'hash', NULL, '[]', '[]', 1, NULL, NULL, '{}', NULL, NULL, NULL, 'then')",
                [],
            )
            .unwrap();
        };
        row(&conn);
        let (_, before) = digest_of_only_row(&conn);

        for column in &columns {
            row(&conn);
            let changed = if *column == "edit_line" {
                "2"
            } else {
                "'changed'"
            };
            conn.execute(&format!("UPDATE folder_files SET {column} = {changed}"), [])
                .unwrap();
            let (_, after) = digest_of_only_row(&conn);
            assert_ne!(
                after, before,
                "changing {column} left the binding as it was"
            );
        }

        // A value that is the same text in a different column, or a null
        // beside a value, is a change too.
        row(&conn);
        conn.execute("UPDATE folder_files SET held = 'x'", [])
            .unwrap();
        let (_, held) = digest_of_only_row(&conn);
        row(&conn);
        conn.execute("UPDATE folder_files SET own = 'x'", [])
            .unwrap();
        assert_ne!(digest_of_only_row(&conn).1, held);

        row(&conn);
        conn.execute("UPDATE folder_files SET seen_at = 'now'", [])
            .unwrap();
        assert_eq!(digest_of_only_row(&conn).1, before);
    }
}
