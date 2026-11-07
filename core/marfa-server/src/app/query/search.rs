//! `GET /search`. The match, the caller's reach and the row's narrowing are one
//! query, so a row outside the reach is never counted, ranked or answered.

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

/// How deep a search reads.
const DEPTH: i64 = 10_000;
const SNIPPET_TOKENS: i64 = 32;

/// A page of `GET /search`.
#[derive(Clone, Debug)]
pub struct Search {
    pub q: String,
    pub ask: Ask,
    pub sort: Sort,
    pub limit: i64,
    pub cursor: Option<String>,
    pub include: Vec<String>,
}

pub(super) fn search_sql(
    reach: &Reach,
    ask: &Ask,
    catalog: &Catalog,
    expression: &str,
    order: &Order,
    take: i64,
    offset: i64,
) -> Result<Sql> {
    let mut sql = Sql::new("SELECT i.seq, bm25(items_fts), ");
    order.columns(&mut sql);
    sql.push(
        " FROM items_fts CROSS JOIN items i ON i.seq = items_fts.rowid \
         WHERE items_fts MATCH ",
    );
    sql.bind(expression.to_string());
    sql.push(" AND ");
    sql.append(&selection(reach, ask, catalog, false)?);
    order.order_by(&mut sql);
    sql.push(" LIMIT ");
    sql.bind(take);
    sql.push(" OFFSET ");
    sql.bind(offset);
    Ok(sql)
}

fn snippets(read: &Reader<'_, '_>, expression: &str, seqs: &[i64]) -> Result<HashMap<i64, String>> {
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
    let sql = search_sql(
        &reach,
        &search.ask,
        &read.catalog,
        &expression,
        &order,
        take,
        offset,
    )?;
    let mut statement = read.tx.prepare_cached(&sql.text)?;
    let ranked: Vec<(i64, f64)> = statement
        .query_map(rusqlite::params_from_iter(&sql.values), |row| {
            Ok((row.get(0)?, row.get(1)?))
        })?
        .collect::<rusqlite::Result<_>>()?;
    let more = ranked.len() as i64 > search.limit;
    let next = offset + search.limit;
    let shown = &ranked[..ranked.len().min(search.limit as usize)];
    let seqs: Vec<i64> = shown.iter().map(|(seq, _)| *seq).collect();
    read.hydrating();
    let excerpts = snippets(read, &expression, &seqs)?;
    let include = Many {
        metadata: true,
        ..Many::default()
    };
    let data: Vec<String> = items::listed_rows(read, &seqs, &include)?
        .into_iter()
        .zip(shown)
        .map(|((item, metadata), (seq, rank))| {
            let score = Json::from(rank.abs()).to_string();
            let excerpt = excerpts
                .get(seq)
                .map(|raw| snippet_html(raw))
                .filter(|html| !html.is_empty())
                .map(|html| format!(",\"snippet_html\":{}", Json::from(html)))
                .unwrap_or_default();
            format!(
                "{{\"item\":{item},\"metadata\":{},\"relevance_score\":{score}{excerpt}}}",
                metadata.unwrap_or_else(|| "null".to_string())
            )
        })
        .collect();
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
