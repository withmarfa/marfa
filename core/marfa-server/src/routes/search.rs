//! `GET /search`. The filters come from the core's list query code, and the
//! full-text match, ranking and excerpt from its search code. A cursor is an
//! offset into the ranking, as on the TypeScript server.

use axum::Router;
use axum::extract::{RawQuery, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::get;
use marfa_core::server::{self as core, SearchOrder, Sort, SortDirection, SortField};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::narrow::{self, Pairs, Reach};
use crate::app::App;
use crate::auth::Caller;
use crate::error::{ApiError, ApiResult};
use crate::storage::items::{self, ItemRow};

const DECLARED: [&str; 16] = [
    "q",
    "type",
    "state",
    "source",
    "tier",
    "include",
    "tags",
    "limit",
    "cursor",
    "filter",
    "sort",
    "direction",
    "occurred_after",
    "occurred_before",
    "updated_after",
    "updated_before",
];

const DEFAULT_LIMIT: usize = 20;
const MAX_LIMIT: usize = 100;

/// How deep the ranking is read; a cursor at or past it is refused.
const MAX_DEPTH: usize = 10_000;

pub fn router() -> Router<App> {
    Router::new().route("/search", get(search))
}

async fn search(
    State(app): State<App>,
    caller: Caller,
    RawQuery(raw): RawQuery,
) -> ApiResult<impl IntoResponse> {
    let reach = Reach::of(&caller, &app.catalog);
    if caller.key().is_some() {
        reach.reads_some()?;
    }
    let pairs = Pairs::parse(raw.as_deref())?;
    pairs.declared(&DECLARED, false)?;
    pairs.nothing_empty()?;
    let query = match pairs.get("q") {
        None => {
            return Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                "missing_required_field",
                "q: Required field is missing.",
            )
            .with(json!({ "field": "q" })));
        }
        Some("") => return Err(ApiError::field("q", "Query parameter 'q' is required.")),
        Some(q) if q.contains('\0') => {
            return Err(ApiError::field("q", "Query parameter 'q' holds a NUL."));
        }
        Some(q) => q.trim().to_string(),
    };
    let filters = narrow::read_filters(&pairs, false)?;
    let include = narrow::include(&pairs)?;
    let limit = narrow::limit(pairs.get("limit"), DEFAULT_LIMIT, MAX_LIMIT, false)?;
    let order = order(&pairs)?;
    let fingerprint = fingerprint(&pairs);
    let offset = match pairs.get("cursor") {
        None => 0,
        Some(cursor) => offset_of(cursor, &fingerprint)?,
    };

    let catalog = app.catalog.clone();
    let (rows, more) = app
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
            let wanted = (limit + 1).min(MAX_DEPTH - offset);
            let mut hits = core::search_page(
                conn,
                &query,
                order,
                &clauses,
                values,
                wanted,
                offset,
                &mut core::Unreadable::Refuse,
            )?;
            let more = hits.len() > limit;
            hits.truncate(limit);
            let mut rows = Vec::with_capacity(hits.len());
            for hit in hits {
                rows.push(json!({
                    "item": ItemRow::from_core(&hit.item).to_json(),
                    "metadata": items::metadata(&hit.item.id, &hit.item.tags),
                    "relevance_score": hit.score,
                    "snippet_html": hit.snippet,
                }));
            }
            Ok((rows, more))
        })
        .await?;
    let next = offset + limit;
    let next_cursor = (more && next < MAX_DEPTH)
        .then(|| narrow::seal(&json!({ "v": next.to_string(), "id": fingerprint })));
    Ok(axum::Json(
        json!({ "data": rows, "next_cursor": next_cursor }),
    ))
}

fn order(pairs: &Pairs) -> ApiResult<SearchOrder> {
    let direction = match pairs.get("direction") {
        None => None,
        Some("asc") => Some(SortDirection::Ascending),
        Some("desc") => Some(SortDirection::Descending),
        Some(_) => return Err(ApiError::field("direction", "Must be asc or desc.")),
    };
    let direction_or_newest = direction.unwrap_or(SortDirection::Descending);
    match pairs.get("sort") {
        None | Some("relevance") => Ok(SearchOrder::Relevance(direction_or_newest)),
        Some(sort) => {
            let field = sort.parse::<SortField>().map_err(|_| {
                ApiError::field(
                    "sort",
                    "Must be relevance, created_at, updated_at, occurred_at or properties.<field>.",
                )
            })?;
            Ok(SearchOrder::Field(Sort {
                field,
                direction: direction_or_newest,
            }))
        }
    }
}

/// Everything that decides the ranking, as one short string, so a cursor
/// continues only the search that issued it. The order is read as it
/// resolves.
fn fingerprint(pairs: &Pairs) -> String {
    let mut ranking: Vec<(&str, &str)> = pairs
        .0
        .iter()
        .filter(|(name, _)| !matches!(name.as_str(), "cursor" | "limit") && !name.starts_with('_'))
        .map(|(name, value)| (name.as_str(), value.as_str()))
        .collect();
    for (name, default) in [("sort", "relevance"), ("direction", "desc")] {
        if !ranking.iter().any(|(held, _)| *held == name) {
            ranking.push((name, default));
        }
    }
    ranking.sort();
    let text = serde_json::to_string(&ranking).unwrap_or_default();
    hex::encode(Sha256::digest(text.as_bytes()))[..22].to_string()
}

fn offset_of(cursor: &str, fingerprint: &str) -> ApiResult<usize> {
    let cursor = narrow::unseal(cursor)?;
    if cursor.get("id").and_then(Value::as_str) != Some(fingerprint) {
        return Err(ApiError::validation(
            "This cursor was issued for a different search and cannot be continued here. Re-read the first page with the same parameters.",
        ));
    }
    cursor
        .get("v")
        .and_then(Value::as_str)
        .filter(|offset| !offset.is_empty() && offset.bytes().all(|byte| byte.is_ascii_digit()))
        .and_then(|offset| offset.parse::<usize>().ok())
        .filter(|offset| *offset < MAX_DEPTH)
        .ok_or_else(|| ApiError::validation("Invalid pagination cursor"))
}
