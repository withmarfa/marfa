//! `GET /search` over items and table rows.

use std::collections::HashMap;

use marfa_rules::search::{MARK_CLOSE, MARK_OPEN, fts_phrases, snippet_html};
use serde_json::{Value as Json, json};

use super::compile::{Ask, Sql, judge, selection};
use super::cursor::{Secret, refused};
use super::order::{Order, Sort};
use super::reach::Reach;
use crate::app::App;
use crate::app::access::Caller;
use crate::app::catalog::Catalog;
use crate::app::items::{self, Many, Reader, reading};
use crate::app::refusal::Result;
use crate::app::tables;
use marfa_rules::query::SortDirection;

const DEPTH: i64 = 10_000;
const SNIPPET_TOKENS: i64 = 32;

#[derive(Clone, Debug)]
pub struct Search {
    pub q: String,
    pub ask: Ask,
    pub sort: Sort,
    pub limit: i64,
    pub cursor: Option<String>,
    pub include: Vec<String>,
}

struct Source {
    fts: &'static str,
    from: &'static str,
    /// What `from` reads from for an ask that only the columns of the index's own item table can judge.
    narrow_from: &'static str,
    /// The length in tokens of a hit's entry where the join holds it, for the narrow and the wide `from`; NULL where FTS5 reads it.
    lengths: (&'static str, &'static str),
    named: &'static str,
    /// Every entry of an item `i`, for a reach to narrow.
    corpus: &'static str,
    /// The count and length in tokens of the entries of `corpus`, for a reach to narrow.
    totals: &'static str,
}

const SOURCES: [Source; 2] = [
    Source {
        fts: "items_fts",
        from: "items_fts CROSS JOIN items_fts_sizes z ON z.seq = items_fts.rowid \
             CROSS JOIN items i ON i.seq = z.seq",
        narrow_from: "items_fts CROSS JOIN items_fts_sizes i ON i.seq = items_fts.rowid",
        lengths: ("i.tokens", "z.tokens"),
        named: "0 AS hit, i.seq AS seq, NULL AS tname, NULL AS rid, NULL AS entry, NULL AS columns",
        corpus: "items_fts CROSS JOIN items_fts_sizes i ON i.seq = items_fts.rowid",
        totals: "SELECT coalesce(sum(i.entries), 0), coalesce(sum(i.tokens), 0) \
             FROM items_fts_totals i",
    },
    Source {
        fts: "rows_fts",
        from: tables::search::HITS_FROM,
        narrow_from: tables::search::HITS_FROM,
        lengths: ("NULL", "NULL"),
        named: "1 AS hit, i.seq AS seq, s.table_name AS tname, m.id AS rid, m.seq AS entry, \
             s.searched_by AS columns",
        corpus: tables::search::CORPUS_FROM,
        totals: tables::search::CORPUS_TOTALS,
    },
];

fn totals_sql(source: &Source, reach: &Reach) -> Sql {
    let mut sql = Sql::new(&format!("{} WHERE ", source.totals));
    reach.clause(&mut sql, "i", false);
    sql
}

fn hits_sql(source: &Source, reach: &Reach, phrase: &str) -> Sql {
    let mut sql = Sql::new(&format!(
        "SELECT count(*) FROM {} WHERE {} MATCH ",
        source.corpus, source.fts
    ));
    sql.bind(phrase.to_string());
    sql.push(" AND ");
    reach.clause(&mut sql, "i", false);
    sql
}

/// The statements that read each index's corpus, for a test to read.
#[cfg(test)]
pub(super) fn corpus_sqls(reach: &Reach) -> Vec<Sql> {
    SOURCES
        .iter()
        .flat_map(|source| {
            [
                totals_sql(source, reach),
                hits_sql(source, reach, "\"word\""),
            ]
        })
        .collect()
}

fn counts(read: &Reader<'_, '_>, sql: &Sql, columns: usize) -> Result<Vec<i64>> {
    let mut statement = read.tx.prepare_cached(&sql.text)?;
    Ok(
        statement.query_row(rusqlite::params_from_iter(&sql.values), |row| {
            (0..columns).map(|at| row.get(at)).collect()
        })?,
    )
}

/// BM25's statistics for each index, as `bm25_within` takes them after the table, or none where FTS5's own are the caller's.
pub(super) struct Ranking(pub(super) [Option<Vec<i64>>; 2]);

impl Ranking {
    fn of(read: &Reader<'_, '_>, reach: &Reach, phrases: &[String]) -> Result<Ranking> {
        if !reach.is_whole() || tables::search::purge_pending(read.tx)? {
            return Self::within(read, reach, phrases);
        }
        // The items' own statistics are FTS5's, given here so that each hit's length comes from the join.
        let mut items = counts(read, &Sql::new(SOURCES[0].totals), 2)?;
        for phrase in phrases {
            let mut sql = Sql::new("SELECT count(*) FROM items_fts WHERE items_fts MATCH ");
            sql.bind(phrase.clone());
            let hits = counts(read, &sql, 1)?;
            items.extend(hits.into_iter().filter(|hits| *hits > 0));
        }
        Ok(Ranking([Some(items), None]))
    }

    fn within(read: &Reader<'_, '_>, reach: &Reach, phrases: &[String]) -> Result<Ranking> {
        let mut within = [None, None];
        for (source, arguments) in SOURCES.iter().zip(&mut within) {
            let mut held = counts(read, &totals_sql(source, reach), 2)?;
            for phrase in phrases {
                let hits = counts(read, &hits_sql(source, reach, phrase), 1)?;
                // FTS5 drops a wordless phrase; one with no hit in reach leaves no row to rank.
                held.extend(hits.into_iter().filter(|hits| *hits > 0));
            }
            *arguments = Some(held);
        }
        Ok(Ranking(within))
    }

    fn rank(&self, source: &Source, at: usize, narrow: bool) -> Sql {
        let Some(held) = &self.0[at] else {
            return Sql::new(&format!("bm25({})", source.fts));
        };
        let length = if narrow {
            source.lengths.0
        } else {
            source.lengths.1
        };
        let mut sql = Sql::new(&format!("bm25_within({}", source.fts));
        for (place, argument) in held.iter().enumerate() {
            if place == 2 {
                sql.push(&format!(", {length}"));
            }
            sql.push(", ");
            sql.bind(*argument);
        }
        if held.len() <= 2 {
            sql.push(&format!(", {length}"));
        }
        sql.push(")");
        sql
    }
}

/// Whether a hit's type, source and state judge the ask, with nothing of the item itself to read.
fn narrow(ask: &Ask) -> bool {
    ask.filter.is_none()
        && ask.tags.is_empty()
        && ask.beneath.is_none()
        && ask.tier.is_none()
        && ask.occurred_after.is_none()
        && ask.occurred_before.is_none()
        && ask.updated_after.is_none()
        && ask.updated_before.is_none()
}

fn matched(
    sql: &mut Sql,
    source: &Source,
    reach: &Reach,
    ask: &Ask,
    catalog: &Catalog,
    (expression, narrow): (&str, bool),
) -> Result<()> {
    let from = if narrow {
        source.narrow_from
    } else {
        source.from
    };
    sql.push(&format!(" FROM {from} WHERE {} MATCH ", source.fts));
    sql.bind(expression.to_string());
    sql.push(" AND ");
    sql.append(&selection(reach, ask, catalog, false)?);
    Ok(())
}

pub(super) fn search_sql(
    reach: &Reach,
    ask: &Ask,
    catalog: &Catalog,
    expression: &str,
    ranking: &Ranking,
    order: &Order,
    (take, offset): (i64, i64),
) -> Result<Sql> {
    let mut sql = Sql::new("SELECT hit, seq, rank, tname, rid, entry, columns FROM (");
    for (at, source) in SOURCES.iter().enumerate() {
        if at > 0 {
            sql.push(" UNION ALL ");
        }
        let narrow = narrow(ask) && order.ranks_alone();
        let rank = ranking.rank(source, at, narrow);
        sql.push(&format!("SELECT {}, ", source.named));
        sql.append(&rank);
        sql.push(" AS rank, ");
        order.columns(&mut sql);
        sql.push(" AS id");
        matched(&mut sql, source, reach, ask, catalog, (expression, narrow))?;
    }
    sql.push(")");
    order.order_by_named(&mut sql, "id");
    sql.push(", hit, tname, rid LIMIT ");
    sql.bind(take);
    sql.push(" OFFSET ");
    sql.bind(offset);
    Ok(sql)
}

fn best_rank(
    read: &Reader<'_, '_>,
    reach: &Reach,
    ask: &Ask,
    expression: &str,
    ranking: &Ranking,
) -> Result<Option<f64>> {
    let mut sql = Sql::new("SELECT min(rank) FROM (");
    for (at, source) in SOURCES.iter().enumerate() {
        if at > 0 {
            sql.push(" UNION ALL ");
        }
        let narrow = narrow(ask);
        sql.push("SELECT ");
        sql.append(&ranking.rank(source, at, narrow));
        sql.push(" AS rank");
        matched(
            &mut sql,
            source,
            reach,
            ask,
            &read.catalog,
            (expression, narrow),
        )?;
    }
    sql.push(")");
    let mut statement = read.tx.prepare_cached(&sql.text)?;
    Ok(statement.query_row(rusqlite::params_from_iter(&sql.values), |row| row.get(0))?)
}

fn relevance(rank: f64, top: Option<f64>) -> f64 {
    const PLACES: f64 = 1e9;
    match top {
        Some(top) if top < 0.0 && rank < 0.0 => ((rank / top) * PLACES).round() / PLACES,
        _ => 1.0,
    }
}

fn snippets(read: &Reader<'_, '_>, expression: &str, seqs: &[i64]) -> Result<HashMap<i64, String>> {
    if seqs.is_empty() {
        return Ok(HashMap::new());
    }
    let mut sql = Sql::new("SELECT rowid, snippet(items_fts, -1, ");
    sql.bind(MARK_OPEN.to_string());
    sql.push(", ");
    sql.bind(MARK_CLOSE.to_string());
    sql.push(", '...', ");
    sql.bind(SNIPPET_TOKENS);
    sql.push(") FROM items_fts WHERE items_fts MATCH ");
    sql.bind(expression.to_string());
    sql.push(" AND rowid IN (");
    for (at, seq) in seqs.iter().enumerate() {
        if at > 0 {
            sql.push(", ");
        }
        sql.bind(*seq);
    }
    sql.push(")");
    let mut statement = read.tx.prepare(&sql.text)?;
    let found = statement.query_map(rusqlite::params_from_iter(&sql.values), |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
    })?;
    Ok(found.collect::<rusqlite::Result<_>>()?)
}

struct Hit {
    seq: i64,
    rank: f64,
    row: Option<RowHit>,
}

struct RowHit {
    table: String,
    id: String,
    entry: i64,
    columns: String,
}

fn hit_of(row: &rusqlite::Row<'_>) -> rusqlite::Result<Hit> {
    let named = match row.get::<_, i64>(0)? {
        0 => None,
        _ => Some(RowHit {
            table: row.get(3)?,
            id: row.get(4)?,
            entry: row.get(5)?,
            columns: row.get(6)?,
        }),
    };
    Ok(Hit {
        seq: row.get(1)?,
        rank: row.get(2)?,
        row: named,
    })
}

fn excerpt_field(raw: Option<&str>) -> String {
    raw.map(snippet_html)
        .filter(|html| !html.is_empty())
        .map(|html| format!(",\"snippet_html\":{}", Json::from(html)))
        .unwrap_or_default()
}

fn row_fields(read: &Reader<'_, '_>, expression: &str, row: &RowHit) -> Result<String> {
    let excerpt =
        tables::search::excerpt(read.tx, row.entry, &row.columns, expression, SNIPPET_TOKENS)?;
    let column = match &excerpt {
        Some((column, _)) => column.clone(),
        None => row
            .columns
            .split(',')
            .next()
            .unwrap_or_default()
            .to_string(),
    };
    let named = json!({ "table": row.table, "id": row.id, "column": column });
    Ok(format!(
        "{},\"row\":{named}",
        excerpt_field(excerpt.as_ref().map(|(_, raw)| raw.as_str()))
    ))
}

fn offset_of(secret: &Secret, scope: &str, cursor: Option<&str>) -> Result<i64> {
    let Some(cursor) = cursor else {
        return Ok(0);
    };
    secret
        .open(scope, cursor)?
        .as_i64()
        .filter(|offset| (0..DEPTH).contains(offset))
        .ok_or_else(refused)
}

fn page(read: &Reader<'_, '_>, secret: &Secret, search: &Search) -> Result<String> {
    let reach = Reach::of(read)?;
    judge(read, &search.ask)?;
    let order = Order::search(&search.sort);
    let scope = json!([
        "search",
        read.caller.credential_handle(),
        search.q,
        search.ask.scope(),
        order.spelled,
        search.include,
    ])
    .to_string();
    let offset = offset_of(secret, &scope, search.cursor.as_deref())?;
    let Some(phrases) = fts_phrases(&search.q) else {
        return Ok("{\"data\":[],\"next_cursor\":null}".to_string());
    };
    let expression = phrases.join(" ");
    let take = (search.limit + 1).min(DEPTH - offset);
    let ranking = Ranking::of(read, &reach, &phrases)?;
    let sql = search_sql(
        &reach,
        &search.ask,
        &read.catalog,
        &expression,
        &ranking,
        &order,
        (take, offset),
    )?;
    let mut statement = read.tx.prepare_cached(&sql.text)?;
    let ranked: Vec<Hit> = statement
        .query_map(rusqlite::params_from_iter(&sql.values), hit_of)?
        .collect::<rusqlite::Result<_>>()?;
    let best_first = search.sort.field.is_none()
        && !matches!(search.sort.direction, Some(SortDirection::Ascending));
    let top = match ranked.first() {
        Some(hit) if best_first && offset == 0 => Some(hit.rank),
        Some(_) => best_rank(read, &reach, &search.ask, &expression, &ranking)?,
        None => None,
    };
    let more = ranked.len() as i64 > search.limit;
    let next = offset + search.limit;
    let shown = &ranked[..ranked.len().min(search.limit as usize)];
    let seqs: Vec<i64> = shown.iter().map(|hit| hit.seq).collect();
    let own: Vec<i64> = shown
        .iter()
        .filter(|hit| hit.row.is_none())
        .map(|hit| hit.seq)
        .collect();
    read.hydrating();
    let excerpts = snippets(read, &expression, &own)?;
    let include = Many {
        metadata: true,
        ..Many::default()
    };
    let mut data = Vec::with_capacity(shown.len());
    for ((item, metadata), hit) in items::listed_rows(read, &seqs, &include)?
        .into_iter()
        .zip(shown)
    {
        let score = Json::from(relevance(hit.rank, top)).to_string();
        let tail = match &hit.row {
            Some(row) => row_fields(read, &expression, row)?,
            None => excerpt_field(excerpts.get(&hit.seq).map(String::as_str)),
        };
        data.push(format!(
            "{{\"item\":{item},\"metadata\":{},\"relevance_score\":{score}{tail}}}",
            metadata.unwrap_or_else(|| "null".to_string())
        ));
    }
    let next_cursor = if more && next < DEPTH {
        Json::from(secret.issue(&scope, &json!(next))?).to_string()
    } else {
        "null".to_string()
    };
    Ok(format!(
        "{{\"data\":[{}],\"next_cursor\":{next_cursor}}}",
        data.join(",")
    ))
}

pub async fn search(app: &App, caller: &Caller, search: Search) -> Result<String> {
    let secret = app.cursor_secret.clone();
    reading(app, caller, move |read| page(read, &secret, &search)).await
}
