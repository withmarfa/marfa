use rusqlite::types::Value;
use serde_json::{Map, Value as Json, json};

use super::compile::{Ask, Sql, judge, selection};
use super::cursor::Position;
use super::order::{Order, Sort};
use super::reach::Reach;
use crate::app::App;
use crate::app::access::Caller;
use crate::app::items::{self, Many, Reader, reading};
use crate::app::refusal::Result;

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

pub(super) fn found(read: &Reader<'_, '_>, sql: &Sql, width: usize) -> Result<Vec<Found>> {
    let mut statement = read.tx.prepare_cached(&sql.text)?;
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
    reading(app, caller, move |read| {
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
        let selected = selection(&reach, ask, &read.catalog, order.walked())?;
        let sql = page_sql(&selected, ask, &order, position.as_ref(), *limit);
        let rows = found(read, &sql, order.width())?;
        answered(
            read,
            rows,
            *limit,
            |last| secret.issue(&scope, &last.payload()),
            |seqs| items::listed(read, seqs, include),
        )
    })
    .await
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
