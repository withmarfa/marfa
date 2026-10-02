use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use super::edge_types::End;
use super::fields::OwnBase;
use crate::error::CoreError;
use crate::model::ItemState;
use crate::store::now_iso;

#[derive(Debug, Clone, PartialEq)]
pub struct Bound {
    pub path: String,
    pub item_id: String,
    /// Device, inode and birth time; `None` where the filesystem gave none.
    pub identity: Option<String>,
    pub content_hash: String,
    /// The bytes the folder itself last wrote at this path, hashed; `None`
    /// where the last agreement was a scan's read. A pull removes only a
    pub written_hash: Option<String>,
    /// The item ids the file's links named when last read or written.
    pub links: Vec<String>,
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

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Writes {
    /// Counts the file's saves, so a later one's landing can supersede.
    pub save: i64,
    pub queued: Vec<Queued>,
    pub refused: Vec<Refused>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Queued {
    pub id: String,
    pub save: i64,
    /// The version line an edit spends, kept apart until it is answered so a
    /// refusal takes back only its own.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<i64>,
}

impl Bound {
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
    /// An edge a line made (`shown`) or took out.
    Edge {
        line: Line,
        shown: bool,
    },
}

impl Change {
    pub fn supersedes(&self, refused: &Change) -> bool {
        match (self, refused) {
            (Change::Edit, Change::Edit) | (Change::State(_), Change::State(_)) => true,
            (
                Change::AddTag(tag) | Change::RemoveTag(tag),
                Change::AddTag(was) | Change::RemoveTag(was),
            ) => tag == was,
            (Change::Edge { line, .. }, Change::Edge { line: was, .. }) => line == was,
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

pub fn hash(bytes: &[u8]) -> String {
    // FNV-1a, 64-bit: not a security boundary.
    let mut sum: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes {
        sum ^= u64::from(*byte);
        sum = sum.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{sum:016x}")
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

/// Also pins the item's row, so the copy keeps it whatever the search says
/// of it.
pub fn bind(conn: &Connection, bound: &Bound) -> Result<(), CoreError> {
    let before = bound_at(conn, &bound.path)?;
    crate::store::pin(conn, &bound.item_id)?;
    conn.execute(
        "INSERT INTO folder_files (path, item_id, identity, content_hash, written_hash, links, edge_lines, edit_line, held, own, writes, seen_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
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
           seen_at = excluded.seen_at",
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
            now_iso()
        ],
    )?;
    if let Some(before) = before {
        unpin_if_unheld(conn, &before.item_id)?;
    }
    Ok(())
}

pub fn unbind(conn: &Connection, path: &str) -> Result<(), CoreError> {
    let before = bound_at(conn, path)?;
    conn.execute("DELETE FROM folder_files WHERE path = ?1", [path])?;
    if let Some(before) = before {
        unpin_if_unheld(conn, &before.item_id)?;
    }
    Ok(())
}

/// A binding lets its pin go unless a line still holds the row, which then
/// holds the pin as its own.
pub fn unpin_if_unheld(conn: &Connection, item_id: &str) -> Result<(), CoreError> {
    if bound_to_item(conn, item_id)?.is_some() {
        return Ok(());
    }
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

/// Lets a line's hold go, and the pin with it where the folder made it and
/// no binding holds it.
pub fn release_edge_end(conn: &Connection, id: &str, made: bool) -> Result<(), CoreError> {
    crate::store::meta_delete(conn, &format!("{EDGE_END}{id}"))?;
    if made && bound_to_item(conn, id)?.is_none() {
        crate::store::unpin(conn, id)?;
    }
    Ok(())
}

pub fn bound_at(conn: &Connection, path: &str) -> Result<Option<Bound>, CoreError> {
    Ok(conn
        .query_row(
            "SELECT path, item_id, identity, content_hash, written_hash, links, edge_lines, edit_line, held, own, writes FROM folder_files WHERE path = ?1",
            [path],
            read_bound,
        )
        .optional()?)
}

pub fn bound_to_item(conn: &Connection, item_id: &str) -> Result<Option<Bound>, CoreError> {
    Ok(conn
        .query_row(
            "SELECT path, item_id, identity, content_hash, written_hash, links, edge_lines, edit_line, held, own, writes FROM folder_files WHERE item_id = ?1",
            [item_id],
            read_bound,
        )
        .optional()?)
}

pub fn bound_paths(conn: &Connection) -> Result<Vec<(String, String)>, CoreError> {
    let mut statement = conn.prepare("SELECT path, item_id FROM folder_files ORDER BY path")?;
    let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn every_bound(conn: &Connection) -> Result<Vec<Bound>, CoreError> {
    bound_where(conn, "", [])
}

pub fn bound_with_identity(conn: &Connection, identity: &str) -> Result<Vec<Bound>, CoreError> {
    bound_where(conn, "WHERE identity = ?1", [identity])
}

pub fn bound_with_hash(conn: &Connection, content_hash: &str) -> Result<Vec<Bound>, CoreError> {
    bound_where(conn, "WHERE content_hash = ?1", [content_hash])
}

fn bound_where<P: rusqlite::Params>(
    conn: &Connection,
    clause: &str,
    params: P,
) -> Result<Vec<Bound>, CoreError> {
    let mut statement = conn.prepare(&format!(
        "SELECT path, item_id, identity, content_hash, written_hash, links, edge_lines, edit_line, held, own, writes FROM folder_files {clause} ORDER BY path",
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
    let lines: String = row.get(6)?;
    Ok(Bound {
        path: row.get(0)?,
        item_id: row.get(1)?,
        identity: row.get(2)?,
        content_hash: row.get(3)?,
        written_hash: row.get(4)?,
        // Unreadable, it names no links or lines, so no edge is removed for it.
        links: serde_json::from_str(&links).unwrap_or_default(),
        lines: serde_json::from_str(&lines).unwrap_or_default(),
        edit_line: row.get(7)?,
        held: row.get(8)?,
        // Unreadable, it remembers nothing written, and no own line is sent.
        own: row
            .get::<_, Option<String>>(9)?
            .and_then(|own| serde_json::from_str(&own).ok()),
        writes: serde_json::from_str(&row.get::<_, String>(10)?).unwrap_or_default(),
    })
}

/// How a held file's reason begins; a line `EDGES_WAITING` on the server is
/// asked again at each scan that can reach it.
pub const REFUSED: &str = "refused: ";
pub const UNREADABLE: &str = "unreadable: ";
pub const EDGES: &str = "edges: ";
pub const EDGES_WAITING: &str = "edges, waiting: ";

/// `OR IGNORE` keeps the first sighting, so a folder scanning every second
/// still reaches the grace.
pub fn journal_missing(conn: &Connection, path: &str, item_id: &str) -> Result<(), CoreError> {
    conn.execute(
        "INSERT OR IGNORE INTO folder_journal (path, item_id, missing_since)
         VALUES (?1, ?2, ?3)",
        params![path, item_id, now_iso()],
    )?;
    Ok(())
}

/// A row that outlives its question becomes a delete nobody asked for.
pub fn journal_clear(conn: &Connection, path: &str) -> Result<(), CoreError> {
    conn.execute("DELETE FROM folder_journal WHERE path = ?1", [path])?;
    Ok(())
}

pub fn journal_clear_for(conn: &Connection, path: &str, item_id: &str) -> Result<(), CoreError> {
    conn.execute(
        "DELETE FROM folder_journal WHERE path = ?1 AND item_id = ?2",
        [path, item_id],
    )?;
    Ok(())
}

/// Every journaled delete: the path, the item and when it was first missing.
pub fn journaled(conn: &Connection) -> Result<Vec<(String, String, String)>, CoreError> {
    let mut statement =
        conn.prepare("SELECT path, item_id, missing_since FROM folder_journal ORDER BY path")?;
    let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
    let mut journaled = Vec::new();
    for row in rows {
        journaled.push(row?);
    }
    Ok(journaled)
}

pub fn bound_count(conn: &Connection) -> Result<usize, CoreError> {
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM folder_files", [], |row| row.get(0))?;
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

/// The size and time a file had when the scan last read it.
pub fn stat_of(conn: &Connection, path: &str) -> Result<Option<String>, CoreError> {
    Ok(conn
        .query_row(
            "SELECT stat FROM folder_stats WHERE path = ?1",
            [path],
            |row| row.get(0),
        )
        .optional()?)
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
        tx.execute("DELETE FROM folder_stats", [])?;
    }
    for (path, stat) in stats {
        tx.execute(
            "INSERT INTO folder_stats (path, stat) VALUES (?1, ?2)
             ON CONFLICT (path) DO UPDATE SET stat = excluded.stat",
            [path, stat],
        )?;
    }
    tx.commit()?;
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

/// The items the last pull left in place because the search no longer
/// matches them, so a status read needs no pull of its own.
const UNMATCHED: &str = "folder_unmatched";

pub fn unmatched(conn: &Connection) -> Result<Vec<String>, CoreError> {
    list(conn, UNMATCHED)
}

pub fn set_unmatched(conn: &Connection, ids: &[String]) -> Result<(), CoreError> {
    set_list(conn, UNMATCHED, ids)
}
