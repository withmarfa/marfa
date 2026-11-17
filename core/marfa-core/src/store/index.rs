//! The full-text index of the rows the copy holds.

use super::fts_text;
use super::open::with_journals_in_memory;
use super::reads::{split_properties, tags_for_index};
use crate::error::CoreError;
use crate::model::ItemState;
use marfa_rules::catalog::Indexing;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Map, Value};

pub(super) fn reindex(conn: &Connection) -> Result<(), CoreError> {
    reindex_where(conn, None)
}

/// Indexes the row `id` again from what the copy holds, as `reindex` does for
/// every row. Nothing changes when the copy holds no such row.
pub fn reindex_item(conn: &Connection, id: &str) -> Result<(), CoreError> {
    reindex_where(conn, Some(id))
}

fn reindex_where(conn: &Connection, only: Option<&str>) -> Result<(), CoreError> {
    let catalog = crate::catalog::load(conn)?;
    let held: Vec<(i64, String, String, String, String)> = conn
        .prepare(
            "SELECT seq, id, type, state, properties FROM items
             WHERE ?1 IS NULL OR id = ?1",
        )?
        .query_map([only], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            ))
        })?
        .collect::<Result<_, _>>()?;
    for (seq, id, type_id, state, properties) in held {
        let (properties, _) = split_properties(&properties);
        index_row(
            conn,
            seq,
            &id,
            &state,
            &properties,
            &catalog.indexing(&type_id),
        )?;
    }
    Ok(())
}

pub(super) fn index_row(
    conn: &Connection,
    seq: i64,
    id: &str,
    state: &str,
    properties: &Map<String, Value>,
    indexing: &Indexing,
) -> Result<(), CoreError> {
    let text = (ItemState::from_str_checked(state)? != ItemState::Trashed)
        .then(|| fts_text(properties, indexing));
    if let Some(text) = hold_index(seq, text) {
        write_index(conn, seq, id, text)?;
    }
    Ok(())
}

/// Replaces the index entry of the row at `seq`.
fn write_index(conn: &Connection, seq: i64, id: &str, text: IndexEntry) -> Result<(), CoreError> {
    conn.prepare_cached("DELETE FROM items_fts WHERE rowid = ?1")?
        .execute([seq])?;
    if let Some(text) = text {
        let tags = tags_for_index(conn, id)?;
        conn.prepare_cached(
            "INSERT INTO items_fts (rowid, title, body, description, name, extra, tags)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        )?
        .execute(params![
            seq,
            text.title,
            text.body,
            text.description,
            text.name,
            text.extra,
            tags.join(" ")
        ])?;
    }
    Ok(())
}

/// What a row is indexed by, or `None` for a row left out of the index.
type IndexEntry = Option<marfa_rules::search::FtsText>;

thread_local! {
    /// The entries a page write holds back, by the row's `seq`.
    static HELD_INDEX: std::cell::RefCell<Option<std::collections::BTreeMap<i64, IndexEntry>>> =
        const { std::cell::RefCell::new(None) };
}

/// Holds the entry back while a page write is open on this thread, answering
/// `None`; hands it back to be written at once otherwise.
fn hold_index(seq: i64, text: IndexEntry) -> Option<IndexEntry> {
    HELD_INDEX.with(|held| match held.borrow_mut().as_mut() {
        Some(held) => {
            held.insert(seq, text);
            None
        }
        None => Some(text),
    })
}

/// Ends the hold at the end of the page write, whether it succeeded or not.
struct IndexHold;

impl IndexHold {
    fn begin() -> Self {
        HELD_INDEX.with(|held| *held.borrow_mut() = Some(std::collections::BTreeMap::new()));
        IndexHold
    }

    /// Writes the held entries together, for the rows the copy still holds. The
    /// index flushes its pending rows as a segment at each statement that can
    /// fail partway, so one entry per row would make a segment per row.
    fn write(&self, conn: &Connection) -> Result<(), CoreError> {
        let held = HELD_INDEX
            .with(|held| held.borrow_mut().as_mut().map(std::mem::take))
            .unwrap_or_default();
        let mut id = conn.prepare_cached("SELECT id FROM items WHERE seq = ?1")?;
        for (seq, text) in held {
            match id
                .query_row([seq], |row| row.get::<_, String>(0))
                .optional()?
            {
                Some(id) => write_index(conn, seq, &id, text)?,
                None => {
                    conn.prepare_cached("DELETE FROM items_fts WHERE rowid = ?1")?
                        .execute([seq])?;
                }
            }
        }
        Ok(())
    }
}

impl Drop for IndexHold {
    fn drop(&mut self) {
        HELD_INDEX.with(|held| *held.borrow_mut() = None);
    }
}

/// `with_journals_in_memory` for a page of a server's rows, which indexes the
/// rows once the page is written.
pub(crate) fn with_page_write<T>(
    conn: &mut Connection,
    write: impl FnOnce(&rusqlite::Transaction) -> Result<T, CoreError>,
) -> Result<T, CoreError> {
    with_journals_in_memory(conn, |tx| {
        let hold = IndexHold::begin();
        let written = write(tx)?;
        hold.write(tx)?;
        Ok(written)
    })
}
