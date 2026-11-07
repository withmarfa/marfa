//! `GET /items`. The filters and the order come from the core's query code;
//! the page is a keyset over that order, which the core, paging by offset,
//! does not offer.

use axum::Router;
use axum::extract::{RawQuery, State};
use axum::response::IntoResponse;
use axum::routing::get;
use marfa_core::server::{self as core, Sort, SortDirection, SortField};
use serde_json::{Value, json};

use super::narrow::{self, Pairs, Reach};
use crate::app::App;
use crate::auth::Caller;
use crate::error::{ApiError, ApiResult};
use crate::storage::items;

const DECLARED: [&str; 16] = [
    "type",
    "state",
    "source",
    "tier",
    "tags",
    "filter",
    "beneath",
    "sort",
    "direction",
    "occurred_after",
    "occurred_before",
    "updated_after",
    "updated_before",
    "limit",
    "cursor",
    "include",
];

const DEFAULT_LIMIT: usize = 50;
const MAX_LIMIT: usize = 500;

pub fn router() -> Router<App> {
    Router::new().route("/items", get(list))
}

async fn list(
    State(app): State<App>,
    caller: Caller,
    RawQuery(raw): RawQuery,
) -> ApiResult<impl IntoResponse> {
    let reach = Reach::of(&caller, &app.catalog);
    if caller.key().is_some() {
        reach.reads_some()?;
    }
    let pairs = Pairs::parse(raw.as_deref())?;
    pairs.declared(&DECLARED, true)?;
    pairs.nothing_empty()?;
    let mut filters = narrow::read_filters(&pairs, true)?;
    let include = narrow::include(&pairs)?;
    let limit = narrow::limit(pairs.get("limit"), DEFAULT_LIMIT, MAX_LIMIT, true)?;
    let sort = named_sort(&pairs, &filters)?;
    let sort = core::list_order(&filters, sort)?;
    let cursor = pairs.get("cursor").map(narrow::unseal).transpose()?;
    filters.limit = Some(limit as u32);

    let metadata = include.contains("metadata");
    let catalog = app.catalog.clone();
    let page = app
        .db
        .read(move |conn| {
            let (mut clauses, mut values) = core::list_narrowing(conn, &catalog, &filters)?;
            if let Some(types) = &filters.types {
                reach.permits(&catalog, types)?;
            }
            reach.clauses(
                filters.types.as_deref(),
                &include,
                &mut clauses,
                &mut values,
            );
            let expression = core::sort_expression(&sort.field)?;
            let key = format!("{}:{}", sort.field, sort.direction.as_sql());
            let mut values: Vec<_> = values.iter().map(narrow::bind).collect();
            if let Some(cursor) = &cursor {
                keyset(&sort, &expression, &key, cursor, &mut clauses, &mut values)?;
            }
            let where_sql = if clauses.is_empty() {
                "1 = 1".to_string()
            } else {
                clauses.join(" AND ")
            };
            let extra = matches!(sort.field, SortField::Property(_)).then_some(expression.as_str());
            let mut rows = items::select(
                conn,
                &where_sql,
                &core::order_terms(&sort)?,
                extra,
                limit + 1,
                &values,
            )?;
            let more = rows.len() > limit;
            rows.truncate(limit);
            let next = match (more, rows.last()) {
                (true, Some((last, sort_value))) => {
                    Some(narrow::seal(&cursor_of(&sort, &key, last, sort_value)))
                }
                _ => None,
            };
            let mut data = Vec::with_capacity(rows.len());
            for (item, _) in &rows {
                if metadata {
                    let tags = items::tags(conn, &item.id)?;
                    data.push(json!({
                        "item": item.to_json(),
                        "metadata": items::metadata(&item.id, &tags),
                    }));
                } else {
                    data.push(item.to_json());
                }
            }
            Ok((data, next))
        })
        .await?;
    Ok(axum::Json(json!({ "data": page.0, "next_cursor": page.1 })))
}

fn named_sort(pairs: &Pairs, filters: &core::ListFilters) -> ApiResult<Option<Sort>> {
    let field = pairs
        .get("sort")
        .map(|sort| sort.parse::<SortField>())
        .transpose()
        .map_err(|_| {
            ApiError::field(
                "sort",
                "Must be created_at, updated_at, occurred_at or properties.<field>.",
            )
        })?;
    let direction = pairs
        .get("direction")
        .map(|direction| match direction {
            "asc" => Ok(SortDirection::Ascending),
            "desc" => Ok(SortDirection::Descending),
            _ => Err(ApiError::field("direction", "Must be asc or desc.")),
        })
        .transpose()?;
    Ok(Sort::named(field, direction, filters))
}

/// The row-value or expanded comparison that continues after `cursor`.
fn keyset(
    sort: &Sort,
    expression: &str,
    key: &str,
    cursor: &serde_json::Map<String, Value>,
    clauses: &mut Vec<String>,
    values: &mut Vec<rusqlite::types::Value>,
) -> ApiResult<()> {
    let refused = || ApiError::validation("Invalid pagination cursor");
    if cursor.get("k").and_then(Value::as_str) != Some(key) {
        return Err(ApiError::validation(
            "This cursor was issued by another listing or ordering and cannot be continued here.",
        ));
    }
    let id = cursor
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(refused)?;
    let value = cursor.get("v").ok_or_else(refused)?;
    let descending = sort.direction == SortDirection::Descending;
    let before = if descending { "<" } else { ">" };
    match &sort.field {
        SortField::Property(_) => match value {
            Value::Null => {
                clauses.push(format!("({expression} IS NULL AND items.id > ?)"));
                values.push(rusqlite::types::Value::Text(id.to_string()));
            }
            Value::Number(_) | Value::String(_) => {
                clauses.push(format!(
                    "({expression} {before} ? OR ({expression} = ? AND items.id > ?) OR {expression} IS NULL)"
                ));
                values.push(narrow::bind(value));
                values.push(narrow::bind(value));
                values.push(rusqlite::types::Value::Text(id.to_string()));
            }
            _ => return Err(refused()),
        },
        _ => {
            let Value::String(at) = value else {
                return Err(refused());
            };
            clauses.push(format!("({expression}, items.id) {before} (?, ?)"));
            values.push(rusqlite::types::Value::Text(at.clone()));
            values.push(rusqlite::types::Value::Text(id.to_string()));
        }
    }
    Ok(())
}

fn cursor_of(
    sort: &Sort,
    key: &str,
    last: &items::ItemRow,
    sort_value: &rusqlite::types::Value,
) -> Value {
    let value = match &sort.field {
        SortField::Property(_) => match sort_value {
            rusqlite::types::Value::Integer(number) => json!(number),
            rusqlite::types::Value::Real(number) => json!(number),
            rusqlite::types::Value::Text(text) => json!(text),
            _ => Value::Null,
        },
        SortField::CreatedAt => json!(last.created_at),
        SortField::UpdatedAt => json!(last.updated_at),
        SortField::OccurredAt => json!(last.occurred_at),
        SortField::TrashedAt => json!(last.trashed_at.as_ref().unwrap_or(&last.updated_at)),
    };
    json!({ "k": key, "v": value, "id": last.id })
}
