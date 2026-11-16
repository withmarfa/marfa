use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::{StatusCode, Uri};
use serde_json::json;

use super::answer::{Answer, json_answer};
use super::body::JsonBody;
use super::query;
use crate::app::App;
use crate::app::access::Caller;
use crate::app::sources::{self, Change, FIELDS};

pub async fn list(State(app): State<Arc<App>>, caller: Caller, uri: Uri) -> Answer {
    query::only(&uri, &[])?;
    let data = sources::list(&app, &caller).await?;
    Ok(json_answer(
        StatusCode::OK,
        &json!({ "data": data, "next_cursor": null }),
    ))
}

pub async fn read(
    State(app): State<Arc<App>>,
    caller: Caller,
    Path(code): Path<String>,
    uri: Uri,
) -> Answer {
    query::only(&uri, &[])?;
    sources::check_code(&code)?;
    let source = sources::read(&app, &caller, code).await?;
    Ok(json_answer(StatusCode::OK, &source))
}

pub async fn update(
    State(app): State<Arc<App>>,
    caller: Caller,
    Path(code): Path<String>,
    uri: Uri,
    body: JsonBody,
) -> Answer {
    query::only(&uri, &[])?;
    if sources::check_code(&code).is_ok() {
        caller.require_may_name(&code)?;
    }
    let sent = body.object(&FIELDS).await?;
    sources::check_code(&code)?;
    let change = Change::from_body(&sent)?;
    let source = sources::update(&app, &caller, code, change).await?;
    Ok(json_answer(StatusCode::OK, &source))
}
