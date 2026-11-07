//! The doors under `/edge-types`.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::{StatusCode, Uri};
use serde_json::json;

use super::answer::{Answer, json_answer};
use super::body::JsonBody;
use super::query;
use crate::app::App;
use crate::app::access::{Caller, Door, SchemaKind};
use crate::app::edge_types;

pub async fn list(State(app): State<Arc<App>>, _caller: Caller, uri: Uri) -> Answer {
    query::only(&uri, &[])?;
    let data = edge_types::list(&app).await?;
    Ok(json_answer(
        StatusCode::OK,
        &json!({ "data": data, "next_cursor": null }),
    ))
}

pub async fn register(State(app): State<Arc<App>>, caller: Caller, body: JsonBody) -> Answer {
    caller.require_door(SchemaKind::EdgeTypes, Door::Register)?;
    let (created, edge_type) =
        edge_types::register(&app, &caller, body.open_object().await?).await?;
    let status = if created {
        StatusCode::CREATED
    } else {
        StatusCode::OK
    };
    Ok(json_answer(status, &json!({ "edge_type": edge_type })))
}

pub async fn delete(
    State(app): State<Arc<App>>,
    caller: Caller,
    Path(id): Path<String>,
    uri: Uri,
) -> Answer {
    caller.require_door(SchemaKind::EdgeTypes, Door::Change)?;
    query::only(&uri, &["force"])?;
    query::flag(&uri, "force")?;
    edge_types::delete(&app, &caller, id).await?;
    Ok(json_answer(StatusCode::OK, &json!({ "ok": true })))
}
