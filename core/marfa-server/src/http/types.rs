use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::{StatusCode, Uri};
use serde_json::json;

use super::answer::{Answer, json_answer};
use super::body::JsonBody;
use super::query;
use crate::app::App;
use crate::app::access::{Caller, Door, SchemaKind};
use crate::app::types;

const ICON_FIELDS: [&str; 1] = ["icon"];

pub async fn list(State(app): State<Arc<App>>, _caller: Caller, uri: Uri) -> Answer {
    query::only(&uri, &[])?;
    let data = types::list(&app).await?;
    Ok(json_answer(
        StatusCode::OK,
        &json!({ "data": data, "next_cursor": null }),
    ))
}

pub async fn read(
    State(app): State<Arc<App>>,
    _caller: Caller,
    Path(id): Path<String>,
    uri: Uri,
) -> Answer {
    query::only(&uri, &[])?;
    Ok(json_answer(StatusCode::OK, &types::get(&app, id).await?))
}

pub async fn normalize(State(app): State<Arc<App>>, _caller: Caller, body: JsonBody) -> Answer {
    let answer = types::normalize(&app, body.open_object().await?).await?;
    Ok(json_answer(StatusCode::OK, &answer))
}

pub async fn register(State(app): State<Arc<App>>, caller: Caller, body: JsonBody) -> Answer {
    caller.require_door(SchemaKind::Types, Door::Register)?;
    let created = types::register(&app, &caller, body.open_object().await?).await?;
    Ok(json_answer(
        StatusCode::CREATED,
        &json!({ "type": created }),
    ))
}

pub async fn replace(
    State(app): State<Arc<App>>,
    caller: Caller,
    Path(id): Path<String>,
    body: JsonBody,
) -> Answer {
    caller.require_door(SchemaKind::Types, Door::Replace)?;
    let replaced = types::replace(&app, &caller, id, body.open_object().await?).await?;
    Ok(json_answer(StatusCode::OK, &json!({ "type": replaced })))
}

pub async fn delete(
    State(app): State<Arc<App>>,
    caller: Caller,
    Path(id): Path<String>,
    uri: Uri,
) -> Answer {
    caller.require_door(SchemaKind::Types, Door::Change)?;
    query::only(&uri, &["force"])?;
    let force = query::flag(&uri, "force")?.unwrap_or(false);
    types::delete(&app, &caller, id, force).await?;
    Ok(json_answer(StatusCode::OK, &json!({ "ok": true })))
}

pub async fn set_icon(
    State(app): State<Arc<App>>,
    caller: Caller,
    Path(id): Path<String>,
    body: JsonBody,
) -> Answer {
    caller.require_door(SchemaKind::Types, Door::Change)?;
    let body = body.object(&ICON_FIELDS).await?;
    let answered = types::set_icon(&app, &caller, id, body).await?;
    Ok(json_answer(StatusCode::OK, &json!({ "type": answered })))
}

pub async fn clear_icon(
    State(app): State<Arc<App>>,
    caller: Caller,
    Path(id): Path<String>,
) -> Answer {
    caller.require_door(SchemaKind::Types, Door::Change)?;
    let answered = types::clear_icon(&app, &caller, id).await?;
    Ok(json_answer(StatusCode::OK, &json!({ "type": answered })))
}

pub async fn retired(State(app): State<Arc<App>>, caller: Caller, uri: Uri) -> Answer {
    query::only(&uri, &[])?;
    let data = types::retired(&app, &caller).await?;
    Ok(json_answer(
        StatusCode::OK,
        &json!({ "data": data, "next_cursor": null }),
    ))
}

pub async fn remove_retired(
    State(app): State<Arc<App>>,
    caller: Caller,
    Path(id): Path<String>,
) -> Answer {
    let removed = types::remove_retired(&app, &caller, id).await?;
    Ok(json_answer(StatusCode::OK, &removed))
}
