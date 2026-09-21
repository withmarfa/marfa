//! The mapping and the journal: what the folder remembers between runs.

use rusqlite::{Connection, OptionalExtension, params};

use crate::error::CoreError;
use crate::store::now_iso;

/// One file the folder has bound to an item.
#[derive(Debug, Clone, PartialEq)]
pub struct Bound {
    pub path: String,
    pub item_id: String,
    /// Null where the filesystem gave none: a rename cannot be followed and
    /// the file becomes a new item rather than a guess (`folders.md` 8).
    pub identity: Option<String>,
    pub content_hash: String,
    /// The item ids the links in those bytes named, as the folder last read
    /// or wrote them. Empty where the file named none.
    pub links: Vec<String>,
    /// The targets whose rendered link the person took out, where the edge
    /// is of a kind the folder could not have made and so keeps
    /// (`folders.md` 27). A pull renders no link for them.
    pub declined: Vec<String>,
}

/// What the folder last agreed with, for the bytes of a file.
///
/// A hash rather than the bytes: the mapping is read on every scan and a
/// folder holding a second copy of every file it watches would be a second
/// copy to keep in step. The comparison it serves is equality and nothing
/// else.
pub fn hash(bytes: &[u8]) -> String {
    // FNV-1a, 64-bit. Written out because this is not a security boundary —
    // it answers "are these the bytes the folder wrote", and the file it is
    // asked about is one the folder already has open.
    let mut sum: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes {
        sum ^= u64::from(*byte);
        sum = sum.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{sum:016x}")
}

pub fn bind(conn: &Connection, bound: &Bound) -> Result<(), CoreError> {
    conn.execute(
        "INSERT INTO folder_files (path, item_id, identity, content_hash, links, declined_links, seen_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT (path) DO UPDATE SET
           item_id = excluded.item_id,
           identity = excluded.identity,
           content_hash = excluded.content_hash,
           links = excluded.links,
           declined_links = excluded.declined_links,
           seen_at = excluded.seen_at",
        params![
            bound.path,
            bound.item_id,
            bound.identity,
            bound.content_hash,
            serde_json::to_string(&bound.links).unwrap_or_else(|_| "[]".into()),
            serde_json::to_string(&bound.declined).unwrap_or_else(|_| "[]".into()),
            now_iso()
        ],
    )?;
    Ok(())
}

pub fn unbind(conn: &Connection, path: &str) -> Result<(), CoreError> {
    conn.execute("DELETE FROM folder_files WHERE path = ?1", [path])?;
    Ok(())
}

pub fn bound_at(conn: &Connection, path: &str) -> Result<Option<Bound>, CoreError> {
    Ok(conn
        .query_row(
            "SELECT path, item_id, identity, content_hash, links, declined_links FROM folder_files WHERE path = ?1",
            [path],
            read_bound,
        )
        .optional()?)
}

/// The file this identity was last bound to, wherever it now sits.
///
/// What follows a rename: the path changed and the identity did not, so the
/// item the old path named is the item the new path names.
pub fn bound_to_identity(conn: &Connection, identity: &str) -> Result<Option<Bound>, CoreError> {
    Ok(conn
        .query_row(
            "SELECT path, item_id, identity, content_hash, links, declined_links FROM folder_files WHERE identity = ?1",
            [identity],
            read_bound,
        )
        .optional()?)
}

pub fn bound_to_item(conn: &Connection, item_id: &str) -> Result<Option<Bound>, CoreError> {
    Ok(conn
        .query_row(
            "SELECT path, item_id, identity, content_hash, links, declined_links FROM folder_files WHERE item_id = ?1",
            [item_id],
            read_bound,
        )
        .optional()?)
}

pub fn every_bound(conn: &Connection) -> Result<Vec<Bound>, CoreError> {
    let mut statement = conn.prepare(
        "SELECT path, item_id, identity, content_hash, links, declined_links FROM folder_files ORDER BY path",
    )?;
    let rows = statement.query_map([], read_bound)?;
    let mut bound = Vec::new();
    for row in rows {
        bound.push(row?);
    }
    Ok(bound)
}

fn read_bound(row: &rusqlite::Row<'_>) -> rusqlite::Result<Bound> {
    let links: String = row.get(4)?;
    let declined: String = row.get(5)?;
    Ok(Bound {
        path: row.get(0)?,
        item_id: row.get(1)?,
        identity: row.get(2)?,
        content_hash: row.get(3)?,
        // A row nobody can read as a list names no links, which makes the
        // folder keep every edge rather than remove one it cannot account for.
        links: serde_json::from_str(&links).unwrap_or_default(),
        // And declines none, which makes the pull render every link: the
        // person removes one again rather than losing one for good.
        declined: serde_json::from_str(&declined).unwrap_or_default(),
    })
}

/// Records a file as missing, if it is not already.
///
/// The moment is kept from the first sighting and not refreshed: the grace
/// runs from when the file went, so a folder scanning every second does not
/// push the delete out of reach for ever.
pub fn journal_missing(conn: &Connection, path: &str, item_id: &str) -> Result<(), CoreError> {
    conn.execute(
        "INSERT OR IGNORE INTO folder_journal (path, item_id, missing_since)
         VALUES (?1, ?2, ?3)",
        params![path, item_id, now_iso()],
    )?;
    Ok(())
}

/// Takes a path out of the journal: the file is there after all.
///
/// Called from all three places that can learn it — a scan that found it
/// under its own name, a scan that followed it to a new one, and a pull that
/// is about to write it.
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
