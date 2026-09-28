//! The mapping and the journal: what the folder remembers between runs.

use rusqlite::{Connection, OptionalExtension, params};

use super::fields::OwnBase;
use crate::error::CoreError;
use crate::store::now_iso;

/// One file the folder has bound to an item.
#[derive(Debug, Clone, PartialEq)]
pub struct Bound {
    pub path: String,
    pub item_id: String,
    /// Device, inode and birth time. Null where the filesystem gave none
    /// (`folders.md` 16).
    pub identity: Option<String>,
    pub content_hash: String,
    /// The bytes the folder itself last wrote at this path, hashed; `None`
    /// where the last agreement was a scan's read. A pull removes only a
    /// file it wrote (`folders.md` 32).
    pub written_hash: Option<String>,
    /// The item ids the links in those bytes named, as the folder last read
    /// or wrote them. Empty where the file named none.
    pub links: Vec<String>,
    /// The targets whose rendered link the person took out, for an edge the
    /// folder keeps (`folders.md` 33). A pull renders no link for them.
    pub declined: Vec<String>,
    /// The newest version line an edit of this device's has spent, 0 where
    /// its file carried none; `None` where no edit went.
    pub edit_line: Option<i64>,
    /// Why the bytes at `content_hash` went unsent or were refused, where
    /// they were: a pull leaves such a file as it is (`folders.md` 9, 10).
    pub held: Option<String>,
    /// The own fields the folder last wrote or read in this file, and what
    /// another machine moved at that version line without a version step.
    pub own: Option<OwnBase>,
    /// The queue ids of the writes these bytes made, so a refusal of an
    /// earlier save's write holds nothing (`folders.md` 9).
    pub queued: Vec<String>,
}

/// What the folder last agreed with, for the bytes of a file. Equality is
/// all it answers.
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
/// against this device's own (`folders.md` 37): the file reads as changed,
/// and its next edit is said to be read at `version`.
pub fn untaken_read_at(version: i64) -> String {
    format!("{UNTAKEN_READ_PREFIX}{version}")
}

const UNTAKEN_READ_PREFIX: &str = "read@";

/// The version a binding's untaken bytes were read at.
pub fn untaken_read_version(content_hash: &str) -> Option<i64> {
    content_hash
        .strip_prefix(UNTAKEN_READ_PREFIX)
        .and_then(|version| version.parse().ok())
}

/// Binds a file, and pins its row so the copy keeps it whatever the search
/// says of it (`device.md` 1, `folders.md` 32).
pub fn bind(conn: &Connection, bound: &Bound) -> Result<(), CoreError> {
    let before = bound_at(conn, &bound.path)?;
    crate::store::pin(conn, &bound.item_id)?;
    conn.execute(
        "INSERT INTO folder_files (path, item_id, identity, content_hash, written_hash, links, declined_links, edit_line, held, own, queued, seen_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
         ON CONFLICT (path) DO UPDATE SET
           item_id = excluded.item_id,
           identity = excluded.identity,
           content_hash = excluded.content_hash,
           written_hash = excluded.written_hash,
           links = excluded.links,
           declined_links = excluded.declined_links,
           edit_line = excluded.edit_line,
           held = excluded.held,
           own = excluded.own,
           queued = excluded.queued,
           seen_at = excluded.seen_at",
        params![
            bound.path,
            bound.item_id,
            bound.identity,
            bound.content_hash,
            bound.written_hash,
            serde_json::to_string(&bound.links).unwrap_or_else(|_| "[]".into()),
            serde_json::to_string(&bound.declined).unwrap_or_else(|_| "[]".into()),
            bound.edit_line,
            bound.held,
            bound
                .own
                .as_ref()
                .and_then(|own| serde_json::to_string(own).ok()),
            serde_json::to_string(&bound.queued).unwrap_or_else(|_| "[]".into()),
            now_iso()
        ],
    )?;
    if let Some(before) = before {
        unpin_if_unbound(conn, &before.item_id)?;
    }
    Ok(())
}

pub fn unbind(conn: &Connection, path: &str) -> Result<(), CoreError> {
    let before = bound_at(conn, path)?;
    conn.execute("DELETE FROM folder_files WHERE path = ?1", [path])?;
    if let Some(before) = before {
        unpin_if_unbound(conn, &before.item_id)?;
    }
    Ok(())
}

/// The row stays held until a catch-up or hydration lets it go, as any
/// unpinned row outside the slice does (`device.md` 1).
fn unpin_if_unbound(conn: &Connection, item_id: &str) -> Result<(), CoreError> {
    if bound_to_item(conn, item_id)?.is_none() {
        crate::store::unpin(conn, item_id)?;
    }
    Ok(())
}

pub fn bound_at(conn: &Connection, path: &str) -> Result<Option<Bound>, CoreError> {
    Ok(conn
        .query_row(
            "SELECT path, item_id, identity, content_hash, written_hash, links, declined_links, edit_line, held, own, queued FROM folder_files WHERE path = ?1",
            [path],
            read_bound,
        )
        .optional()?)
}

pub fn bound_to_item(conn: &Connection, item_id: &str) -> Result<Option<Bound>, CoreError> {
    Ok(conn
        .query_row(
            "SELECT path, item_id, identity, content_hash, written_hash, links, declined_links, edit_line, held, own, queued FROM folder_files WHERE item_id = ?1",
            [item_id],
            read_bound,
        )
        .optional()?)
}

pub fn every_bound(conn: &Connection) -> Result<Vec<Bound>, CoreError> {
    let mut statement = conn.prepare(
        "SELECT path, item_id, identity, content_hash, written_hash, links, declined_links, edit_line, held, own, queued FROM folder_files ORDER BY path",
    )?;
    let rows = statement.query_map([], read_bound)?;
    let mut bound = Vec::new();
    for row in rows {
        bound.push(row?);
    }
    Ok(bound)
}

fn read_bound(row: &rusqlite::Row<'_>) -> rusqlite::Result<Bound> {
    let links: String = row.get(5)?;
    let declined: String = row.get(6)?;
    Ok(Bound {
        path: row.get(0)?,
        item_id: row.get(1)?,
        identity: row.get(2)?,
        content_hash: row.get(3)?,
        written_hash: row.get(4)?,
        // Unreadable, it names no links, so no edge is removed for it; and
        // declines none, so the pull renders every link.
        links: serde_json::from_str(&links).unwrap_or_default(),
        declined: serde_json::from_str(&declined).unwrap_or_default(),
        edit_line: row.get(7)?,
        held: row.get(8)?,
        // Unreadable, it remembers nothing written, and no own line is sent.
        own: row
            .get::<_, Option<String>>(9)?
            .and_then(|own| serde_json::from_str(&own).ok()),
        queued: serde_json::from_str(&row.get::<_, String>(10)?).unwrap_or_default(),
    })
}

/// Holds the file whose bytes queued `write`, for `reason`, and spends no
/// line on it: a refused edit landed nothing the file could be current with.
pub fn hold_for(conn: &Connection, write: &str, reason: &str) -> Result<(), CoreError> {
    for bound in every_bound(conn)? {
        if bound.queued.iter().any(|queued| queued == write) {
            conn.execute(
                "UPDATE folder_files SET held = ?2, edit_line = NULL WHERE path = ?1",
                params![bound.path, reason],
            )?;
        }
    }
    Ok(())
}

/// How a held file's reason begins, for bytes the server or the core refused
/// and for frontmatter that did not parse.
pub const REFUSED: &str = "refused: ";
pub const UNREADABLE: &str = "unreadable: ";

/// Records a file as missing, if it is not already. The moment is the first
/// sighting, so a folder scanning every second still reaches the grace.
pub fn journal_missing(conn: &Connection, path: &str, item_id: &str) -> Result<(), CoreError> {
    conn.execute(
        "INSERT OR IGNORE INTO folder_journal (path, item_id, missing_since)
         VALUES (?1, ?2, ?3)",
        params![path, item_id, now_iso()],
    )?;
    Ok(())
}

/// Takes a path out of the journal. A row that outlives its question becomes
/// a delete nobody asked for.
pub fn journal_clear(conn: &Connection, path: &str) -> Result<(), CoreError> {
    conn.execute("DELETE FROM folder_journal WHERE path = ?1", [path])?;
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
