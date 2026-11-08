//! The doors under `/config`.

use std::sync::Arc;

use axum::extract::State;
use axum::http::{StatusCode, Uri};

use super::answer::{Answer, json_answer};
use super::body::JsonBody;
use super::query;
use crate::app::App;
use crate::app::access::{Caller, Permission};
use crate::app::config::{self, CHECK_FIELDS, Mode, Request};

pub async fn read(State(app): State<Arc<App>>, caller: Caller, uri: Uri) -> Answer {
    caller.require(Permission::ConfigManage)?;
    query::only(&uri, &[])?;
    Ok(json_answer(StatusCode::OK, &config::read(&app).await?))
}

async fn write(app: Arc<App>, caller: Caller, uri: Uri, body: JsonBody, mode: Mode) -> Answer {
    caller.require(Permission::ConfigManage)?;
    query::only(&uri, &[])?;
    let body = body.open_object().await?;
    let request = Request::from_body(mode, &body, &config::fields())?;
    let answer = config::update(&app, &caller, request).await?;
    Ok(json_answer(StatusCode::OK, &answer))
}

pub async fn put(State(app): State<Arc<App>>, caller: Caller, uri: Uri, body: JsonBody) -> Answer {
    write(app, caller, uri, body, Mode::Put).await
}

pub async fn patch(
    State(app): State<Arc<App>>,
    caller: Caller,
    uri: Uri,
    body: JsonBody,
) -> Answer {
    write(app, caller, uri, body, Mode::Patch).await
}

pub async fn address_check(
    State(app): State<Arc<App>>,
    caller: Caller,
    uri: Uri,
    body: JsonBody,
) -> Answer {
    caller.require(Permission::ConfigManage)?;
    query::only(&uri, &[])?;
    let body = body.open_object().await?;
    let request = Request::from_body(Mode::Patch, &body, &CHECK_FIELDS)?;
    Ok(json_answer(
        StatusCode::OK,
        &config::check(&app, request).await?,
    ))
}

pub async fn settings(State(app): State<Arc<App>>, caller: Caller, uri: Uri) -> Answer {
    if !caller.holds(Permission::ConfigManage) {
        caller.require(Permission::InstanceRead)?;
    }
    query::only(&uri, &[])?;
    Ok(json_answer(StatusCode::OK, &config::listing(&app).await?))
}
