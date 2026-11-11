//! Keeps `items_fts` true: triggers name the rows a write touched, and the write settles them before it commits.

use std::collections::{HashMap, HashSet};

use marfa_rules::catalog::{Catalog as Rules, Indexing};
use marfa_rules::search::{FtsText, fts_tags, fts_text};
use rusqlite::{OptionalExtension, Transaction, params};

use super::{parsed, rows};
use crate::app::refusal::Result;
use crate::db::rank;

const INDEXED_STATES: [&str; 3] = ["active", "archived", "revoked"];

/// One write holds the writer for one page of a reindex.
pub const REINDEX_PAGE: usize = 1_000;

struct Indexings<'a> {
    rules: &'a Rules,
    held: HashMap<String, Indexing>,
}

impl Indexings<'_> {
    fn of(&mut self, type_id: &str) -> &Indexing {
        self.held
            .entry(type_id.to_string())
            .or_insert_with(|| self.rules.indexing(type_id))
    }
}

fn remove(tx: &Transaction<'_>, seq: i64) -> Result<()> {
    tx.prepare_cached("DELETE FROM items_fts WHERE rowid = ?1")?
        .execute([seq])?;
    tx.prepare_cached("DELETE FROM items_fts_sizes WHERE seq = ?1")?
        .execute([seq])?;
    Ok(())
}

fn sized(tx: &Transaction<'_>, seq: i64) -> Result<()> {
    let sizes: Vec<u8> = tx
        .prepare_cached("SELECT sz FROM items_fts_docsize WHERE id = ?1")?
        .query_row([seq], |row| row.get(0))?;
    tx.prepare_cached(
        "INSERT INTO items_fts_sizes (seq, id, type, state, source, tokens) \
         SELECT seq, id, type, state, source, ?2 FROM items WHERE seq = ?1",
    )?
    .execute(params![seq, rank::tokens_of(&sizes)?])?;
    Ok(())
}

fn held_text(tx: &Transaction<'_>, seq: i64) -> Result<Option<(FtsText, String)>> {
    let mut statement = tx.prepare_cached(
        "SELECT title, body, description, name, extra, tags FROM items_fts WHERE rowid = ?1",
    )?;
    Ok(statement
        .query_row([seq], |row| {
            Ok((
                FtsText {
                    title: row.get(0)?,
                    body: row.get(1)?,
                    description: row.get(2)?,
                    name: row.get(3)?,
                    extra: row.get(4)?,
                },
                row.get(5)?,
            ))
        })
        .optional()?)
}

fn refresh(tx: &Transaction<'_>, indexings: &mut Indexings<'_>, seq: i64) -> Result<()> {
    let Some(row) = rows::indexed(tx, seq)?.filter(|row| row.state != "trashed") else {
        return remove(tx, seq);
    };
    let text = fts_text(&parsed(&row.properties)?, indexings.of(&row.type_id));
    let tags = fts_tags(&rows::tags(tx, seq)?);
    let held = held_text(tx, seq)?;
    if held
        .as_ref()
        .is_some_and(|(held, held_tags)| *held == text && *held_tags == tags)
    {
        return Ok(());
    }
    if held.is_some() {
        remove(tx, seq)?;
    }
    tx.prepare_cached(
        "INSERT INTO items_fts (rowid, title, body, description, name, extra, tags) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    )?
    .execute(params![
        seq,
        text.title,
        text.body,
        text.description,
        text.name,
        text.extra,
        tags
    ])?;
    sized(tx, seq)
}

pub(super) fn settle(tx: &Transaction<'_>, rules: &Rules) -> Result<()> {
    let pending: Vec<i64> = tx
        .prepare_cached("SELECT seq FROM items_fts_pending")?
        .query_map([], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    if pending.is_empty() {
        return Ok(());
    }
    let mut indexings = Indexings {
        rules,
        held: HashMap::new(),
    };
    for seq in pending {
        refresh(tx, &mut indexings, seq)?;
    }
    tx.prepare_cached("DELETE FROM items_fts_pending")?
        .execute([])?;
    Ok(())
}

pub fn queue_changed(tx: &Transaction<'_>, before: &Rules, after: &Rules) -> Result<()> {
    let named: HashSet<&str> = before
        .declared()
        .chain(after.declared())
        .map(|(type_id, _)| type_id)
        .collect();
    for type_id in named {
        if before.indexing(type_id) == after.indexing(type_id) {
            continue;
        }
        for state in INDEXED_STATES {
            tx.prepare_cached(
                "INSERT INTO items_fts_stale (type, state, after_seq) VALUES (?1, ?2, 0) \
                 ON CONFLICT (type, state) DO UPDATE SET after_seq = 0",
            )?
            .execute([type_id, state])?;
        }
    }
    Ok(())
}

pub fn reindex_page(tx: &Transaction<'_>, rules: &Rules, budget: usize) -> Result<bool> {
    let mut indexings = Indexings {
        rules,
        held: HashMap::new(),
    };
    let mut left = budget;
    while left > 0 {
        let queued: Option<(String, String, i64)> = tx
            .prepare_cached("SELECT type, state, after_seq FROM items_fts_stale LIMIT 1")?
            .query_row([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .optional()?;
        let Some((type_id, state, after)) = queued else {
            return Ok(false);
        };
        let page = rows::seqs_of(tx, &type_id, &state, after, left)?;
        for seq in &page {
            refresh(tx, &mut indexings, *seq)?;
        }
        if page.len() < left {
            tx.prepare_cached("DELETE FROM items_fts_stale WHERE type = ?1 AND state = ?2")?
                .execute([&type_id, &state])?;
        } else if let Some(last) = page.last() {
            tx.prepare_cached(
                "UPDATE items_fts_stale SET after_seq = ?3 WHERE type = ?1 AND state = ?2",
            )?
            .execute(params![type_id, state, last])?;
        }
        left -= page.len();
    }
    Ok(tx
        .prepare_cached("SELECT EXISTS (SELECT 1 FROM items_fts_stale)")?
        .query_row([], |row| row.get(0))?)
}
