//! Which property sorts are read from `item_sort_keys`, and the walk that gives existing items their keys.

use marfa_rules::query::property_sort_expression;
use rusqlite::{OptionalExtension, Transaction, params};

use crate::app::refusal::Result;

/// A type with fewer items sorts faster by reading them all than by keeping keys for each write.
pub const MIN_ITEMS: i64 = 20_000;

/// Each pair costs every write to its type, so the number a server keeps is bounded.
const MAX_PAIRS: i64 = 16;

/// Items one write gives keys to.
const FILL_PAGE: i64 = 5_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Standing {
    Absent,
    Filling,
    Ready,
}

pub fn standing(tx: &Transaction<'_>, type_id: &str, name: &str) -> Result<Standing> {
    let ready: Option<i64> = tx
        .prepare_cached("SELECT ready FROM sort_indexes WHERE type = ?1 AND name = ?2")?
        .query_row([type_id, name], |row| row.get(0))
        .optional()?;
    Ok(match ready {
        None => Standing::Absent,
        Some(0) => Standing::Filling,
        Some(_) => Standing::Ready,
    })
}

pub fn large(tx: &Transaction<'_>, type_id: &str) -> Result<bool> {
    let held: i64 = tx
        .prepare_cached("SELECT COUNT(*) FROM (SELECT 1 FROM items WHERE type = ?1 LIMIT ?2)")?
        .query_row(params![type_id, MIN_ITEMS], |row| row.get(0))?;
    Ok(held >= MIN_ITEMS)
}

/// Adds a pair to the ones kept, and says whether it did; `fill_page` keys the items already written.
pub fn add(tx: &Transaction<'_>, type_id: &str, name: &str) -> Result<bool> {
    if standing(tx, type_id, name)? != Standing::Absent {
        return Ok(false);
    }
    let pairs: i64 = tx.query_row("SELECT COUNT(*) FROM sort_indexes", [], |row| row.get(0))?;
    if pairs >= MAX_PAIRS || !large(tx, type_id)? {
        return Ok(false);
    }
    tx.prepare_cached("INSERT INTO sort_indexes (type, name) VALUES (?1, ?2)")?
        .execute([type_id, name])?;
    Ok(true)
}

/// One page of the walk for the first pair not yet ready, and whether any pair is still not.
pub fn fill_page(tx: &Transaction<'_>) -> Result<bool> {
    let pair: Option<(String, String, i64)> = tx
        .prepare_cached(
            "SELECT type, name, filled_through FROM sort_indexes WHERE ready = 0 LIMIT 1",
        )?
        .query_row([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .optional()?;
    let Some((type_id, name, after)) = pair else {
        return Ok(false);
    };
    let last: Option<i64> = tx
        .prepare_cached(
            "SELECT MAX(seq) FROM (SELECT seq FROM items NOT INDEXED \
             WHERE seq > ?1 AND type = ?2 ORDER BY seq LIMIT ?3)",
        )?
        .query_row(params![after, type_id, FILL_PAGE], |row| row.get(0))?;
    let Some(last) = last else {
        tx.prepare_cached("UPDATE sort_indexes SET ready = 1 WHERE type = ?1 AND name = ?2")?
            .execute([&type_id, &name])?;
        return more(tx);
    };
    let path = format!("$.{name}");
    let value = format!(
        "COALESCE({}, X'')",
        property_sort_expression("properties", "?2")
    );
    tx.prepare_cached(&format!(
        "INSERT OR IGNORE INTO item_sort_keys (type, name, value, id, seq) \
         SELECT type, ?3, {value}, id, seq FROM items NOT INDEXED \
         WHERE seq > ?4 AND seq <= ?5 AND type = ?1"
    ))?
    .execute(params![type_id, path, name, after, last])?;
    tx.prepare_cached("UPDATE sort_indexes SET filled_through = ?3 WHERE type = ?1 AND name = ?2")?
        .execute(params![type_id, name, last])?;
    Ok(true)
}

fn more(tx: &Transaction<'_>) -> Result<bool> {
    Ok(tx.query_row(
        "SELECT EXISTS (SELECT 1 FROM sort_indexes WHERE ready = 0)",
        [],
        |row| row.get(0),
    )?)
}
