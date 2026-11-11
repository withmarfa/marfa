use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::{StatusCode, Uri};
use axum::response::Response;
use serde_json::json;

use super::answer::{Answer, json_answer};
use super::body::JsonBody;
use super::items::invalid_field;
use super::listing::{Params, whole_limit};
use super::query;
use crate::app::App;
use crate::app::access::Caller;
use crate::app::connectors::{self, Batch, Lookup, Register, Replace, Run, Take, Window, released};

const PAGE: i64 = 50;
const MOST: i64 = 200;

pub async fn register(
    State(app): State<Arc<App>>,
    caller: Caller,
    uri: Uri,
    body: JsonBody,
) -> Answer {
    caller.require_registering_key()?;
    query::only(&uri, &[])?;
    let request = Register::parse(&body.open_object().await?)?;
    let (created, registration) = connectors::register(&app, &caller, request).await?;
    let status = if created {
        StatusCode::CREATED
    } else {
        StatusCode::OK
    };
    Ok(json_answer(status, &registration))
}

pub async fn list(State(app): State<Arc<App>>, caller: Caller, uri: Uri) -> Answer {
    query::only(&uri, &[])?;
    let listed = connectors::list(&app, &caller).await?;
    Ok(json_answer(StatusCode::OK, &listed))
}

pub async fn read(
    State(app): State<Arc<App>>,
    caller: Caller,
    Path(id): Path<String>,
    uri: Uri,
) -> Answer {
    query::only(&uri, &[])?;
    let registration = connectors::read(&app, &caller, id).await?;
    Ok(json_answer(StatusCode::OK, &registration))
}

pub async fn remove(
    State(app): State<Arc<App>>,
    caller: Caller,
    Path(id): Path<String>,
    uri: Uri,
) -> Answer {
    query::only(&uri, &[])?;
    connectors::remove(&app, &caller, id).await?;
    Ok(ok())
}

pub async fn heartbeat(
    State(app): State<Arc<App>>,
    caller: Caller,
    Path(id): Path<String>,
    uri: Uri,
) -> Answer {
    query::only(&uri, &[])?;
    let beat = connectors::heartbeat(&app, &caller, id).await?;
    Ok(json_answer(StatusCode::OK, &beat))
}

pub async fn report_run(
    State(app): State<Arc<App>>,
    caller: Caller,
    Path(id): Path<String>,
    uri: Uri,
    body: JsonBody,
) -> Answer {
    query::only(&uri, &[])?;
    let run = Run::parse(&body.open_object().await?)?;
    let reported = connectors::report_run(&app, &caller, id, run).await?;
    Ok(json_answer(StatusCode::CREATED, &reported))
}

pub async fn runs(
    State(app): State<Arc<App>>,
    caller: Caller,
    Path(id): Path<String>,
    uri: Uri,
) -> Answer {
    let params = Params::read(&uri, &["limit", "cursor"], false)?;
    let limit = whole_limit(&params, PAGE, MOST)?;
    let window = Window::open(
        &app,
        format!("connector-runs:{id}"),
        limit,
        params.one("cursor")?,
    )?;
    let page = connectors::runs(&app, &caller, id, window).await?;
    Ok(json_answer(StatusCode::OK, &page))
}

pub async fn take_hold(
    State(app): State<Arc<App>>,
    caller: Caller,
    Path(id): Path<String>,
    uri: Uri,
    body: JsonBody,
) -> Answer {
    query::only(&uri, &[])?;
    let request = Take::parse(&body.open_object().await?)?;
    let hold = connectors::take_hold(&app, &caller, id, request).await?;
    Ok(json_answer(StatusCode::OK, &hold))
}

pub async fn release_hold(
    State(app): State<Arc<App>>,
    caller: Caller,
    Path(id): Path<String>,
    uri: Uri,
) -> Answer {
    let params = Params::read(&uri, &["process"], false)?;
    let process = released(params.one("process")?)?;
    connectors::release_hold(&app, &caller, id, process).await?;
    Ok(ok())
}

pub async fn state(
    State(app): State<Arc<App>>,
    caller: Caller,
    Path(id): Path<String>,
    uri: Uri,
) -> Answer {
    query::only(&uri, &[])?;
    let held = connectors::state(&app, &caller, id).await?;
    Ok(json_answer(StatusCode::OK, &held))
}

pub async fn replace_state(
    State(app): State<Arc<App>>,
    caller: Caller,
    Path(id): Path<String>,
    uri: Uri,
    body: JsonBody,
) -> Answer {
    query::only(&uri, &[])?;
    let request = Replace::parse(&body.open_object().await?)?;
    let written = connectors::replace_state(&app, &caller, id, request).await?;
    Ok(json_answer(StatusCode::OK, &written))
}

pub async fn clear_state(
    State(app): State<Arc<App>>,
    caller: Caller,
    Path(id): Path<String>,
    uri: Uri,
) -> Answer {
    query::only(&uri, &[])?;
    connectors::clear_state(&app, &caller, id).await?;
    Ok(ok())
}

pub async fn write_agreements(
    State(app): State<Arc<App>>,
    caller: Caller,
    Path(id): Path<String>,
    uri: Uri,
    body: JsonBody,
) -> Answer {
    query::only(&uri, &[])?;
    let request = Batch::parse(&body.open_object().await?)?;
    let written = connectors::write_agreements(&app, &caller, id, request).await?;
    Ok(json_answer(StatusCode::OK, &written))
}

pub async fn lookup_agreements(
    State(app): State<Arc<App>>,
    caller: Caller,
    Path(id): Path<String>,
    uri: Uri,
    body: JsonBody,
) -> Answer {
    query::only(&uri, &[])?;
    let request = Lookup::parse(&body.open_object().await?)?;
    let found = connectors::lookup_agreements(&app, &caller, id, request).await?;
    Ok(json_answer(StatusCode::OK, &found))
}

pub async fn list_agreements(
    State(app): State<Arc<App>>,
    caller: Caller,
    Path(id): Path<String>,
    uri: Uri,
) -> Answer {
    let params = Params::read(&uri, &["waiting", "limit", "cursor"], false)?;
    let waiting = match params.one("waiting")? {
        None => None,
        Some("true") => Some(true),
        Some("false") => Some(false),
        Some(_) => return Err(invalid_field("waiting", "waiting is true or false.").into()),
    };
    let limit = whole_limit(&params, PAGE, MOST)?;
    let scope = format!(
        "connector-agreements:{id}:{}",
        waiting.map_or("all", |waiting| if waiting { "waiting" } else { "settled" })
    );
    let window = Window::open(&app, scope, limit, params.one("cursor")?)?;
    let page = connectors::list_agreements(&app, &caller, id, waiting, window).await?;
    Ok(json_answer(StatusCode::OK, &page))
}

fn ok() -> Response {
    json_answer(StatusCode::OK, &json!({ "ok": true }))
}
