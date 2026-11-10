//! The doors to an item's tables. What the store decides happens in `app::tables`.

use std::sync::Arc;

use axum::extract::State;
use axum::http::{StatusCode, Uri};

use super::answer::{Answer, text_answer};
use super::body::JsonBody;
use super::items::{Named, check_item_id, invalid_field};
use super::query;
use crate::app::App;
use crate::app::access::Caller;
use crate::app::refusal::Result;
use crate::app::tables::{self, Page};

const BATCH_FIELDS: [&str; 1] = ["operations"];
const PAGE_KEYS: [&str; 5] = ["limit", "cursor", "filter", "sort", "direction"];

pub async fn list(
    State(app): State<Arc<App>>,
    caller: Caller,
    Named(id): Named<String>,
    uri: Uri,
) -> Answer {
    caller.require_reach()?;
    query::only(&uri, &[])?;
    check_item_id(&id)?;
    Ok(text_answer(
        StatusCode::OK,
        tables::list(&app, &caller, id).await?,
    ))
}

pub async fn write(
    State(app): State<Arc<App>>,
    caller: Caller,
    Named((id, table)): Named<(String, String)>,
    uri: Uri,
    body: JsonBody,
) -> Answer {
    caller.require_reach()?;
    query::only(&uri, &[])?;
    check_item_id(&id)?;
    let sent = body.object(&BATCH_FIELDS).await?;
    let ops = tables::operations(sent.get("operations"), tables::MAX_OPERATIONS)?;
    let answer = tables::write(&app, &caller, id, table, ops).await?;
    Ok(text_answer(StatusCode::OK, answer))
}

fn one(uri: &Uri, name: &str) -> Result<Option<String>> {
    Ok(query::pairs(uri)?
        .into_iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value))
}

fn page_of(uri: &Uri) -> Result<Page> {
    query::only(uri, &PAGE_KEYS)?;
    let limit = one(uri, "limit")?
        .map(|limit| {
            limit
                .parse::<i64>()
                .map_err(|_| invalid_field("limit", "limit is a whole number from 1 to 1000."))
        })
        .transpose()?;
    let descending = match one(uri, "direction")?.as_deref() {
        None | Some("asc") => false,
        Some("desc") => true,
        Some(_) => return Err(invalid_field("direction", "direction is asc or desc.")),
    };
    Ok(Page {
        limit,
        cursor: one(uri, "cursor")?,
        filter: one(uri, "filter")?,
        sort: one(uri, "sort")?,
        descending,
    })
}

pub async fn rows(
    State(app): State<Arc<App>>,
    caller: Caller,
    Named((id, table)): Named<(String, String)>,
    uri: Uri,
) -> Answer {
    caller.require_reach()?;
    let page = page_of(&uri)?;
    check_item_id(&id)?;
    let answer = tables::page(&app, &caller, id, table, page).await?;
    Ok(text_answer(StatusCode::OK, answer))
}

pub async fn row(
    State(app): State<Arc<App>>,
    caller: Caller,
    Named((id, table, row)): Named<(String, String, String)>,
    uri: Uri,
) -> Answer {
    caller.require_reach()?;
    query::only(&uri, &[])?;
    check_item_id(&id)?;
    let answer = tables::get(&app, &caller, id, table, row).await?;
    Ok(text_answer(StatusCode::OK, answer))
}

pub async fn totals(
    State(app): State<Arc<App>>,
    caller: Caller,
    Named((id, table)): Named<(String, String)>,
    uri: Uri,
) -> Answer {
    caller.require_reach()?;
    query::only(&uri, &["filter"])?;
    check_item_id(&id)?;
    let answer = tables::totals(&app, &caller, id, table, one(&uri, "filter")?).await?;
    Ok(text_answer(StatusCode::OK, answer))
}

pub async fn batches(
    State(app): State<Arc<App>>,
    caller: Caller,
    Named((id, table)): Named<(String, String)>,
    uri: Uri,
) -> Answer {
    caller.require_reach()?;
    query::only(&uri, &["limit", "cursor"])?;
    let limit = one(&uri, "limit")?
        .map(|limit| {
            limit
                .parse::<i64>()
                .map_err(|_| invalid_field("limit", "limit is a whole number from 1 to 1000."))
        })
        .transpose()?;
    check_item_id(&id)?;
    let answer = tables::batches(&app, &caller, id, table, limit, one(&uri, "cursor")?).await?;
    Ok(text_answer(StatusCode::OK, answer))
}

pub async fn undo(
    State(app): State<Arc<App>>,
    caller: Caller,
    Named((id, table, batch)): Named<(String, String, String)>,
    uri: Uri,
) -> Answer {
    caller.require_reach()?;
    query::only(&uri, &[])?;
    check_item_id(&id)?;
    let answer = tables::undo(&app, &caller, id, table, batch).await?;
    Ok(text_answer(StatusCode::OK, answer))
}
