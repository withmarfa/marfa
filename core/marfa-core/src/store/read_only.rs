//! The rows last held to the server's `read_only`.

use super::meta::{META_READ_ONLY_READ, meta_get, meta_set};
use super::stamps::set_beneath;
use crate::error::CoreError;
use crate::model::{Item, Subject};
use rusqlite::{Connection, params};
use std::collections::HashMap;

/// Records when the copy last asked the server for `read_only`, whatever
/// the answer covered.
pub(crate) fn mark_read_only_read(conn: &Connection) -> Result<(), CoreError> {
    let at = crate::clock::system_time()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    meta_set(conn, META_READ_ONLY_READ, &at.to_string())
}

/// Whether the copy has gone `every` or longer since its rows were held to
/// the server's `read_only`. A time ahead of the clock says nothing of how
/// long it has been, so it owes one too.
pub(crate) fn read_only_owed(
    conn: &Connection,
    every: std::time::Duration,
) -> Result<bool, CoreError> {
    let at = meta_get(conn, META_READ_ONLY_READ)?
        .and_then(|at| at.parse().ok())
        .and_then(|at| std::time::UNIX_EPOCH.checked_add(std::time::Duration::from_secs(at)));
    let Some(at) = at else {
        return Ok(true);
    };
    Ok(crate::clock::system_time()
        .duration_since(at)
        .map_or(true, |since| since >= every))
}

/// A row of each source and type the copy holds that the server can answer,
/// the `skip`-th of them: one it has taken (`items/bulk-get-omits`), outside the
/// bin (`items/bulk-get`), and with no write waiting, which may have retyped it
/// here or be a row the server no longer holds.
pub(crate) fn read_only_samples(
    conn: &Connection,
    skip: usize,
) -> Result<Vec<ReadOnlySample>, CoreError> {
    let mut statement = conn.prepare_cached(
        "SELECT held.source, held.type,
                (SELECT id FROM items AS row
                  WHERE row.source = held.source AND row.type = held.type
                    AND row.version > 0 AND row.state <> 'trashed'
                    AND row.id NOT IN (SELECT id FROM beneath WHERE subject = 'item')
                  LIMIT 1 OFFSET ?1)
           FROM (SELECT DISTINCT source, type FROM items) AS held",
    )?;
    let samples = statement
        .query_map([skip as i64], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get::<_, Option<String>>(2)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(samples
        .into_iter()
        .filter_map(|(source, r#type, id)| {
            Some(ReadOnlySample {
                id: id?,
                source,
                r#type,
            })
        })
        .collect())
}

/// A row a look at `read_only` asks the server of, and the source and type it
/// answers for.
pub(crate) struct ReadOnlySample {
    pub(crate) id: String,
    pub(crate) source: String,
    pub(crate) r#type: String,
}

/// What the server answers of `read_only`, by source and type.
pub(crate) type ReadOnlyKnown = HashMap<(String, String), bool>;

/// Holds up to `page` rows of a source and type past `after` to `read_only`,
/// answering how many changed and where the next page starts, `None` once no
/// row is left. Only `read_only` moves: a row's version, its fields and its
/// waiting writes stay as they are, and a row the server has not taken keeps
/// its false. A row with writes waiting is `hold_read_only_beneath`'s.
pub(crate) fn hold_read_only_page(
    conn: &Connection,
    (source, r#type): (&str, &str),
    read_only: bool,
    after: i64,
    page: usize,
) -> Result<(u64, Option<i64>), CoreError> {
    let last: Option<i64> = conn
        .prepare_cached(
            "SELECT max(at) FROM (
               SELECT rowid AS at FROM items
                WHERE source = ?1 AND type = ?2 AND read_only = ?3 AND rowid > ?4
                ORDER BY rowid LIMIT ?5)",
        )?
        .query_row(
            params![source, r#type, !read_only, after, page as i64],
            |row| row.get(0),
        )?;
    let Some(last) = last else {
        return Ok((0, None));
    };
    let changed = conn
        .prepare_cached(
            "UPDATE items SET read_only = ?1
              WHERE source = ?2 AND type = ?3 AND read_only = ?4
                AND rowid > ?5 AND rowid <= ?6 AND version > 0
                AND id NOT IN (SELECT id FROM beneath WHERE subject = 'item')",
        )?
        .execute(params![read_only, source, r#type, !read_only, after, last])?;
    Ok((changed as u64, Some(last)))
}

/// Holds up to `page` rows with writes waiting, past the id `after`, to what
/// `known` says of the row beneath them, which is the server's and names the
/// server's type where a waiting write retypes it. Answers how many rows of
/// `items` changed and where the next page starts, `None` once no row is left.
pub(crate) fn hold_read_only_beneath(
    conn: &Connection,
    known: &ReadOnlyKnown,
    after: &str,
    page: usize,
) -> Result<(u64, Option<String>), CoreError> {
    let beneath: Vec<(String, String)> = conn
        .prepare_cached(
            "SELECT id, row FROM beneath WHERE subject = 'item' AND id > ?1
              ORDER BY id LIMIT ?2",
        )?
        .query_map(params![after, page as i64], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })?
        .collect::<rusqlite::Result<_>>()?;
    let last = beneath.last().map(|(id, _)| id.clone());
    let mut row =
        conn.prepare_cached("UPDATE items SET read_only = ?1 WHERE id = ?2 AND read_only <> ?1")?;
    let mut changed = 0;
    for (id, kept) in beneath {
        // What reads this row reports one it cannot read.
        let Ok(mut held) = serde_json::from_str::<Item>(&kept) else {
            continue;
        };
        let Some(&read_only) = known.get(&(held.source.clone(), held.r#type.clone())) else {
            continue;
        };
        if held.read_only != read_only {
            held.read_only = read_only;
            set_beneath(conn, Subject::Item, &id, &serde_json::to_string(&held)?)?;
        }
        changed += row.execute(params![read_only, id])? as u64;
    }
    Ok((changed, last))
}
