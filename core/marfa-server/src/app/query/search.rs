//! `GET /search` over items and table rows.

use std::collections::HashMap;

use marfa_rules::search::{MARK_CLOSE, MARK_OPEN, fts_expression, snippet_html};
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
use crate::db::rank::Corpus;
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
    named: &'static str,
    corpus: &'static str,
}

const SOURCES: [Source; 2] = [
    Source {
        fts: "items_fts",
        from: "items_fts CROSS JOIN items i ON i.seq = items_fts.rowid",
        named: "0 AS hit, i.seq AS seq, NULL AS tname, NULL AS rid, NULL AS entry, NULL AS columns",
        corpus: "items_fts_docsize d JOIN items i ON i.seq = d.id",
    },
    Source {
        fts: "rows_fts",
        from: tables::search::HITS_FROM,
        named: "1 AS hit, i.seq AS seq, s.table_name AS tname, m.id AS rid, m.seq AS entry, \
             s.searched_by AS columns",
        corpus: tables::search::CORPUS_FROM,
    },
];

fn corpus_sql(source: &Source, reach: &Reach) -> Sql {
    let mut sql = Sql::new(&format!("SELECT d.id, d.sz FROM {} WHERE ", source.corpus));
    reach.clause(&mut sql, "i", false);
    sql
}

/// Each index's corpus, for a test to read.
#[cfg(test)]
pub(super) fn corpus_sqls(reach: &Reach) -> Vec<Sql> {
    SOURCES
        .iter()
        .map(|source| corpus_sql(source, reach))
        .collect()
}

/// BM25's statistics, from the entries of each index whose item the caller may read.
pub(super) enum Ranking {
    /// Every entry is within reach, so FTS5's own statistics are the caller's.
    Whole,
    Within([Vec<u8>; 2]),
}

impl Ranking {
    fn of(read: &Reader<'_, '_>, reach: &Reach) -> Result<Ranking> {
        if reach.is_whole() && !tables::search::purge_pending(read.tx)? {
            return Ok(Ranking::Whole);
        }
        let mut corpora = [Vec::new(), Vec::new()];
        for (source, corpus) in SOURCES.iter().zip(&mut corpora) {
            let sql = corpus_sql(source, reach);
            let mut statement = read.tx.prepare(&sql.text)?;
            let mut found = statement.query(rusqlite::params_from_iter(&sql.values))?;
            *corpus = Corpus::gather(&mut found)?.encoded();
        }
        Ok(Ranking::Within(corpora))
    }

    fn rank(&self, at: usize) -> Sql {
        let fts = SOURCES[at].fts;
        match self {
            Ranking::Whole => Sql::new(&format!("bm25({fts})")),
            Ranking::Within(corpora) => {
                let mut sql = Sql::new(&format!("bm25_within({fts}, "));
                sql.bind(corpora[at].clone());
                sql.push(")");
                sql
            }
        }
    }
}

fn matched(
    sql: &mut Sql,
    source: &Source,
    reach: &Reach,
    ask: &Ask,
    catalog: &Catalog,
    expression: &str,
) -> Result<()> {
    sql.push(&format!(
        " FROM {} WHERE {} MATCH ",
        source.from, source.fts
    ));
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
        let rank = ranking.rank(at);
        sql.push(&format!("SELECT {}, ", source.named));
        sql.append(&rank);
        sql.push(" AS rank, ");
        order.ranked_by(&rank).columns(&mut sql);
        sql.push(" AS id");
        matched(&mut sql, source, reach, ask, catalog, expression)?;
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
        sql.push("SELECT ");
        sql.append(&ranking.rank(at));
        sql.push(" AS rank");
        matched(&mut sql, source, reach, ask, &read.catalog, expression)?;
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
    let Some(expression) = fts_expression(&search.q) else {
        return Ok("{\"data\":[],\"next_cursor\":null}".to_string());
    };
    let take = (search.limit + 1).min(DEPTH - offset);
    let ranking = Ranking::of(read, &reach)?;
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
