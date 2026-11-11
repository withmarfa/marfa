use marfa_rules::query::SortField;
use rusqlite::Transaction;
use rusqlite::types::Value;
use serde_json::{Map, Value as Json, json};

use super::compile::{Ask, Sql, judge, selection};
use super::cursor::Position;
use super::order::{Order, Sort};
use super::reach::Reach;
use super::sorted::{self, Reading};
use crate::app::App;
use crate::app::access::Caller;
use crate::app::catalog::{self, Snapshot};
use crate::app::items::{self, Many, Reader, reading, sort_keys};
use crate::app::refusal::Result;
use crate::db::Write;

#[derive(Clone, Debug)]
pub struct Listing {
    pub ask: Ask,
    pub sort: Sort,
    pub limit: i64,
    pub cursor: Option<String>,
    pub include: Many,
}

#[derive(Clone, Copy, Debug)]
pub enum By {
    State,
    Type,
    Source,
}

impl By {
    fn column(self) -> &'static str {
        match self {
            By::State => "i.state",
            By::Type => "i.type",
            By::Source => "i.source",
        }
    }
}

pub(super) struct Found {
    pub seq: i64,
    pub position: Position,
}

pub(super) fn page_sql(
    selected: &Sql,
    ask: &Ask,
    order: &Order,
    position: Option<&Position>,
    limit: i64,
) -> Sql {
    let mut sql = Sql::new("SELECT i.seq, ");
    order.columns(&mut sql);
    sql.push(&format!(" FROM {} WHERE ", order.table(ask)));
    sql.append(selected);
    if let Some(position) = position {
        sql.push(" AND ");
        order.after(&mut sql, position);
    }
    order.order_by(&mut sql);
    sql.push(" LIMIT ");
    sql.bind(limit + 1);
    sql
}

pub(super) fn found(tx: &Transaction<'_>, sql: &Sql, width: usize) -> Result<Vec<Found>> {
    let mut statement = tx.prepare_cached(&sql.text)?;
    let rows = statement.query_map(rusqlite::params_from_iter(&sql.values), |row| {
        let keys = (1..=width)
            .map(|at| row.get::<_, Value>(at))
            .collect::<rusqlite::Result<Vec<Value>>>()?;
        Ok(Found {
            seq: row.get(0)?,
            position: Position {
                keys,
                id: row.get(width + 1)?,
            },
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

pub(super) fn answered(
    read: &Reader<'_, '_>,
    mut rows: Vec<Found>,
    limit: i64,
    next: impl Fn(&Position) -> Result<String>,
    shown: impl Fn(&[i64]) -> Result<Vec<String>>,
) -> Result<String> {
    let more = rows.len() as i64 > limit;
    rows.truncate(limit as usize);
    let next_cursor = match rows.last().filter(|_| more) {
        Some(last) => Json::from(next(&last.position)?).to_string(),
        None => "null".to_string(),
    };
    let seqs: Vec<i64> = rows.iter().map(|row| row.seq).collect();
    read.hydrating();
    Ok(format!(
        "{{\"data\":[{}],\"next_cursor\":{next_cursor}}}",
        shown(&seqs)?.join(",")
    ))
}

pub async fn list(app: &App, caller: &Caller, listing: Listing) -> Result<String> {
    let secret = app.cursor_secret.clone();
    let (page, add) = reading(app, caller, move |read| {
        let reach = Reach::of(read)?;
        let Listing {
            ask,
            sort,
            limit,
            cursor,
            include,
        } = &listing;
        judge(read, ask)?;
        let order = Order::listing(sort, ask);
        let scope = json!([
            "items",
            read.caller.credential_handle(),
            ask.scope(),
            order.spelled
        ])
        .to_string();
        let position = cursor
            .as_deref()
            .map(|cursor| {
                let payload = secret.open(&scope, cursor)?;
                Position::from_payload(&payload, order.width())
            })
            .transpose()?;
        let served = match &sort.field {
            Some(SortField::Property(name)) => {
                Some((name, sorted::reading(read, &reach, ask, name)?))
            }
            _ => None,
        };
        let (rows, add) = match served {
            Some((name, Reading::Keys(type_id))) => {
                let selected = selection(&reach, ask, &read.catalog, true)?;
                let descending = order.keys.first().is_some_and(|key| key.descending);
                let pair = (type_id.as_str(), name.as_str());
                let rows = sorted::page(
                    read.tx,
                    &selected,
                    pair,
                    descending,
                    position.as_ref(),
                    *limit,
                )?;
                (rows, None)
            }
            other => {
                let add = match other {
                    Some((name, Reading::Scan(Some(type_id)))) => Some((type_id, name.to_string())),
                    _ => None,
                };
                let selected = selection(&reach, ask, &read.catalog, order.walked())?;
                let sql = page_sql(&selected, ask, &order, position.as_ref(), *limit);
                (found(read.tx, &sql, order.width())?, add)
            }
        };
        let page = answered(
            read,
            rows,
            *limit,
            |last| secret.issue(&scope, &last.payload()),
            |seqs| items::listed(read, seqs, include),
        )?;
        Ok((page, add))
    })
    .await?;
    if let Some((type_id, name)) = add {
        keep_sort_keys(app, type_id, name).await;
    }
    Ok(page)
}

/// A refusal here costs a later listing its speed and nothing else, so the listing that asked does not fail.
async fn keep_sort_keys(app: &App, type_id: String, name: String) {
    let cache = app.catalog_handle();
    let added = app
        .db
        .write(Write::own(), move |tx| {
            let catalog = catalog::current(&cache, tx, Snapshot::Pending)?;
            sort_keys::add(tx, &catalog.rules, &type_id, &name)
        })
        .await;
    match added {
        Ok(true) => app.reindexing.notify_one(),
        Ok(false) => {}
        Err(refusal) => {
            tracing::warn!(
                code = refusal.code.wire(),
                "Keys for a property sort were not added"
            );
        }
    }
}

pub(super) fn stats_sql(
    reach: &Reach,
    ask: &Ask,
    read_catalog: &crate::app::catalog::Catalog,
    by: By,
) -> Result<Sql> {
    let mut sql = Sql::new(&format!(
        "SELECT {}, COUNT(*) FROM items i WHERE ",
        by.column()
    ));
    sql.append(&selection(reach, ask, read_catalog, false)?);
    sql.push(" GROUP BY 1");
    Ok(sql)
}

pub async fn stats(app: &App, caller: &Caller, ask: Ask, by: By) -> Result<Map<String, Json>> {
    reading(app, caller, move |read| {
        let reach = Reach::of(read)?;
        judge(read, &ask)?;
        let sql = stats_sql(&reach, &ask, &read.catalog, by)?;
        let mut statement = read.tx.prepare_cached(&sql.text)?;
        let counts = statement.query_map(rusqlite::params_from_iter(&sql.values), |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?;
        counts
            .map(|count| {
                let (bucket, count) = count?;
                Ok((bucket, Json::from(count)))
            })
            .collect()
    })
    .await
}
