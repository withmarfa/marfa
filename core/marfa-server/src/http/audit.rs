use std::sync::Arc;

use axum::extract::State;
use axum::http::{StatusCode, Uri};
use serde_json::json;

use super::answer::{Answer, json_answer};
use super::query;
use crate::app::App;
use crate::app::access::{Caller, Permission};
use crate::app::audit::{self, Filter};

const PARAMETERS: [&str; 9] = [
    "action",
    "resource_type",
    "resource_id",
    "kind",
    "q",
    "created_after",
    "created_before",
    "limit",
    "cursor",
];

pub async fn list(State(app): State<Arc<App>>, caller: Caller, uri: Uri) -> Answer {
    caller.require(Permission::AuditRead)?;
    query::only(&uri, &PARAMETERS)?;
    let filter = Filter::from_query(&query::pairs(&uri)?)?;
    let (data, next_cursor) = app.db.read(move |tx| audit::page(tx, &filter)).await?;
    Ok(json_answer(
        StatusCode::OK,
        &json!({ "data": data, "next_cursor": next_cursor }),
    ))
}
