//! `rows_fts`, the searchable text of each row: kept by every row write and rebuilt after a type change.

use marfa_rules::schema::{MAX_SEARCHABLE_COLUMNS, searchable_columns};
use marfa_rules::search::{MARK_CLOSE, MARK_OPEN};
use rusqlite::{OptionalExtension, Transaction, params, params_from_iter};
use serde_json::{Map, Value};

use super::store;
use crate::app::refusal::Result;
use crate::db::rank;

// Binned rows stay indexed but cannot match.
pub(crate) const HITS_FROM: &str = "rows_fts CROSS JOIN row_search m ON m.seq = rows_fts.rowid \
     CROSS JOIN table_summaries s ON s.seq = m.table_seq AND s.searched_by IS NOT NULL \
     CROSS JOIN items i ON i.seq = s.item_seq AND i.state <> 'trashed'";

/// Every entry of an item `i`, whatever its state or its table's rebuild, for a reach to narrow.
pub(crate) const CORPUS_FROM: &str = "rows_fts CROSS JOIN row_search m ON m.seq = rows_fts.rowid \
     CROSS JOIN table_summaries s ON s.seq = m.table_seq \
     CROSS JOIN items i ON i.seq = s.item_seq";

/// The count and length of the entries of `CORPUS_FROM`, for a reach to narrow.
pub(crate) const CORPUS_TOTALS: &str = "SELECT coalesce(sum(s.indexed), 0), \
     coalesce(sum(s.indexed_tokens), 0) FROM table_summaries s JOIN items i ON i.seq = s.item_seq";

/// Whether a purged item's entries are still indexed, which no reach covers.
pub(crate) fn purge_pending(tx: &Transaction<'_>) -> Result<bool> {
    Ok(tx
        .prepare_cached("SELECT EXISTS (SELECT 1 FROM table_rows_purging)")?
        .query_row([], |row| row.get(0))?)
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Searched(Vec<String>);

impl Searched {
    pub(crate) fn of(columns: &Map<String, Value>) -> Searched {
        Searched(searchable_columns(columns))
    }

    pub(crate) fn signature(&self) -> String {
        self.0.join(",")
    }

    pub(crate) fn from_signature(signature: &str) -> Searched {
        Searched(
            signature
                .split(',')
                .filter(|column| !column.is_empty())
                .take(MAX_SEARCHABLE_COLUMNS)
                .map(str::to_string)
                .collect(),
        )
    }

    // A value written as an item's ID stays excluded after its column is retyped.
    fn texts<'v>(
        &self,
        values: &'v Map<String, Value>,
        refs: &Map<String, Value>,
    ) -> Option<[Option<&'v str>; MAX_SEARCHABLE_COLUMNS]> {
        let mut texts = [None; MAX_SEARCHABLE_COLUMNS];
        for (at, column) in self.0.iter().enumerate() {
            if refs.contains_key(column) {
                continue;
            }
            texts[at] = values
                .get(column)
                .and_then(Value::as_str)
                .filter(|text| !text.is_empty());
        }
        texts.iter().any(Option::is_some).then_some(texts)
    }
}

fn entry(tx: &Transaction<'_>, table: i64, id: &str) -> Result<Option<i64>> {
    Ok(tx
        .prepare_cached("SELECT seq FROM row_search WHERE table_seq = ?1 AND id = ?2")?
        .query_row(params![table, id], |row| row.get(0))
        .optional()?)
}

fn held_texts(tx: &Transaction<'_>, seq: i64) -> Result<Vec<Option<String>>> {
    Ok(tx
        .prepare_cached("SELECT c0, c1, c2, c3, c4, c5, c6, c7 FROM rows_fts WHERE rowid = ?1")?
        .query_row([seq], |row| {
            (0..MAX_SEARCHABLE_COLUMNS).map(|at| row.get(at)).collect()
        })
        .optional()?
        .unwrap_or_default())
}

fn unindex(tx: &Transaction<'_>, seq: i64) -> Result<()> {
    tx.prepare_cached("DELETE FROM rows_fts WHERE rowid = ?1")?
        .execute([seq])?;
    Ok(())
}

pub(super) fn index(
    tx: &Transaction<'_>,
    table: i64,
    id: &str,
    searched: &Searched,
    values: &Map<String, Value>,
    refs: &Map<String, Value>,
) -> Result<()> {
    let held = entry(tx, table, id)?;
    let Some(texts) = searched.texts(values, refs) else {
        return match held {
            Some(seq) => forget_entry(tx, seq),
            None => Ok(()),
        };
    };
    let seq = match held {
        Some(seq) => {
            let same = held_texts(tx, seq)?
                .iter()
                .map(Option::as_deref)
                .eq(texts.iter().copied());
            if same {
                return Ok(());
            }
            unindex(tx, seq)?;
            seq
        }
        None => tx
            .prepare_cached("INSERT INTO row_search (table_seq, id) VALUES (?1, ?2) RETURNING seq")?
            .query_row(params![table, id], |row| row.get(0))?,
    };
    let mut statement = tx.prepare_cached(
        "INSERT INTO rows_fts (rowid, c0, c1, c2, c3, c4, c5, c6, c7) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
    )?;
    let mut bound: Vec<rusqlite::types::Value> = vec![seq.into()];
    bound.extend(
        texts
            .iter()
            .map(|text| text.map_or(rusqlite::types::Value::Null, |text| text.to_string().into())),
    );
    statement.execute(params_from_iter(bound))?;
    let sizes: Vec<u8> = tx
        .prepare_cached("SELECT sz FROM rows_fts_docsize WHERE id = ?1")?
        .query_row([seq], |row| row.get(0))?;
    tx.prepare_cached("UPDATE row_search SET tokens = ?2 WHERE seq = ?1")?
        .execute(params![seq, rank::tokens_of(&sizes)?])?;
    Ok(())
}

fn forget_entry(tx: &Transaction<'_>, seq: i64) -> Result<()> {
    unindex(tx, seq)?;
    tx.prepare_cached("DELETE FROM row_search WHERE seq = ?1")?
        .execute([seq])?;
    Ok(())
}

pub(super) fn forget(tx: &Transaction<'_>, table: i64, id: &str) -> Result<()> {
    match entry(tx, table, id)? {
        Some(seq) => forget_entry(tx, seq),
        None => Ok(()),
    }
}

pub(super) struct Indexing {
    pub table_seq: i64,
    pub table: String,
    pub row_count: i64,
    pub searched_by: Option<String>,
    /// The columns a rebuild under way brings the entries to.
    pub rebuilding: Option<String>,
}

fn indexings(
    tx: &Transaction<'_>,
    filter: &str,
    key: &dyn rusqlite::ToSql,
) -> Result<Vec<Indexing>> {
    let mut statement = tx.prepare_cached(&format!(
        "SELECT s.seq, s.table_name, s.row_count, s.searched_by, q.target \
         FROM table_summaries s LEFT JOIN table_rows_reindexing q ON q.table_seq = s.seq \
         WHERE {filter}"
    ))?;
    let found = statement.query_map([key], |row| {
        Ok(Indexing {
            table_seq: row.get(0)?,
            table: row.get(1)?,
            row_count: row.get(2)?,
            searched_by: row.get(3)?,
            rebuilding: row.get(4)?,
        })
    })?;
    Ok(found.collect::<rusqlite::Result<_>>()?)
}

pub(super) fn indexings_of_item(tx: &Transaction<'_>, seq: i64) -> Result<Vec<Indexing>> {
    indexings(tx, "s.item_seq = ?1", &seq)
}

pub(super) fn indexings_of_type(tx: &Transaction<'_>, type_id: &str) -> Result<Vec<Indexing>> {
    indexings(
        tx,
        "s.item_seq IN (SELECT seq FROM items WHERE type = ?1)",
        &type_id,
    )
}

fn settled_as(tx: &Transaction<'_>, table: i64, signature: Option<&str>) -> Result<()> {
    tx.prepare_cached("UPDATE table_summaries SET searched_by = ?2 WHERE seq = ?1")?
        .execute(params![table, signature])?;
    Ok(())
}

/// Indexes up to `limit` rows of `table` after `after` by `searched`, answering the last taken.
fn index_rows(
    tx: &Transaction<'_>,
    table: i64,
    searched: &Searched,
    after: &str,
    limit: i64,
) -> Result<(i64, Option<String>)> {
    let rows = store::rows_after(tx, table, after, limit)?;
    for row in &rows {
        index(tx, table, &row.id, searched, &row.values, &row.refs)?;
    }
    Ok((rows.len() as i64, rows.last().map(|row| row.id.clone())))
}

pub(super) fn reindex_whole(tx: &Transaction<'_>, table: i64, searched: &Searched) -> Result<()> {
    let mut after = String::new();
    loop {
        let (taken, last) =
            index_rows(tx, table, searched, &after, super::lifecycle::CLEANUP_PAGE)?;
        match last {
            Some(last) if taken == super::lifecycle::CLEANUP_PAGE => after = last,
            _ => break,
        }
    }
    tx.prepare_cached("DELETE FROM table_rows_reindexing WHERE table_seq = ?1")?
        .execute([table])?;
    settled_as(tx, table, Some(&searched.signature()))
}

/// Leaves the table's entries to `table-row-cleanup`, and its rows out of search until then.
pub(super) fn reindex_later(tx: &Transaction<'_>, table: i64, searched: &Searched) -> Result<()> {
    tx.prepare_cached(
        "INSERT INTO table_rows_reindexing (table_seq, target, after_id) VALUES (?1, ?2, NULL) \
         ON CONFLICT (table_seq) DO UPDATE SET target = ?2, after_id = NULL",
    )?
    .execute(params![table, searched.signature()])?;
    settled_as(tx, table, None)
}

/// Rebuilds the entries of up to `limit` rows of one table; `None` once no table waits.
pub(super) fn reindex_page(tx: &Transaction<'_>, limit: i64) -> Result<Option<i64>> {
    let Some((table, target, after)) = tx
        .prepare_cached(
            "SELECT table_seq, target, after_id FROM table_rows_reindexing \
             ORDER BY table_seq LIMIT 1",
        )?
        .query_row([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })
        .optional()?
    else {
        return Ok(None);
    };
    let searched = Searched::from_signature(&target);
    let (taken, last) = index_rows(tx, table, &searched, &after.unwrap_or_default(), limit)?;
    match last {
        Some(last) if taken == limit => {
            tx.prepare_cached(
                "UPDATE table_rows_reindexing SET after_id = ?2 WHERE table_seq = ?1",
            )?
            .execute(params![table, last])?;
        }
        _ => {
            tx.prepare_cached("DELETE FROM table_rows_reindexing WHERE table_seq = ?1")?
                .execute([table])?;
            settled_as(tx, table, Some(&target))?;
        }
    }
    Ok(Some(taken))
}

pub(crate) fn excerpt(
    tx: &Transaction<'_>,
    entry: i64,
    signature: &str,
    expression: &str,
    tokens: i64,
) -> Result<Option<(String, String)>> {
    let searched = Searched::from_signature(signature);
    let mut best: Option<(usize, String, String)> = None;
    let mut statement = tx.prepare_cached(
        "SELECT snippet(rows_fts, ?1, ?2, ?3, '...', ?4) FROM rows_fts \
         WHERE rows_fts MATCH ?5 AND rowid = ?6",
    )?;
    for (at, column) in searched.0.iter().enumerate() {
        let Some(text) = statement
            .query_row(
                params![
                    at as i64,
                    MARK_OPEN.to_string(),
                    MARK_CLOSE.to_string(),
                    tokens,
                    expression,
                    entry
                ],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten()
        else {
            continue;
        };
        let words = marked_words(&text);
        if words > 0 && best.as_ref().is_none_or(|(most, ..)| words > *most) {
            best = Some((words, column.clone(), text));
        }
    }
    Ok(best.map(|(_, column, text)| (column, text)))
}

/// One mark spans a whole phrase, so its words are counted, not the marks.
fn marked_words(excerpt: &str) -> usize {
    let (mut words, mut marked, mut in_word) = (0, false, false);
    for character in excerpt.chars() {
        match character {
            MARK_OPEN => marked = true,
            MARK_CLOSE => marked = false,
            _ if character.is_alphanumeric() => {
                if marked && !in_word {
                    words += 1;
                }
                in_word = true;
                continue;
            }
            _ => {}
        }
        in_word = false;
    }
    words
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_marked_phrase_counts_each_of_its_words() {
        let mark = |text: &str| format!("{MARK_OPEN}{text}{MARK_CLOSE}");
        assert_eq!(
            marked_words(&format!("{} and more", mark("alpha-beta-delta"))),
            3
        );
        assert_eq!(
            marked_words(&format!("{} then {}", mark("gamma"), mark("gamma"))),
            2
        );
        assert_eq!(marked_words("nothing marked"), 0);
    }
}
