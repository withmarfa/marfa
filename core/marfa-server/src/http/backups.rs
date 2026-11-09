//! `/backups`: the owner lists the backups in the object store, takes one now, and restores one
//! the server reads from the store itself.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::{StatusCode, Uri};
use serde_json::json;

use super::answer::{Answer, json_answer};
use super::query;
use crate::app::App;
use crate::app::access::Caller;

pub async fn list(State(app): State<Arc<App>>, caller: Caller, uri: Uri) -> Answer {
    caller.require_direct()?;
    query::only(&uri, &[])?;
    let data = app.list_backups(&caller).await?;
    Ok(json_answer(
        StatusCode::OK,
        &json!({ "data": data, "next_cursor": null }),
    ))
}

pub async fn run(State(app): State<Arc<App>>, caller: Caller, uri: Uri) -> Answer {
    caller.require_direct()?;
    query::only(&uri, &[])?;
    let answer = app.run_backup(&caller).await?;
    Ok(json_answer(StatusCode::OK, &answer))
}

pub async fn restore(
    State(app): State<Arc<App>>,
    caller: Caller,
    Path(name): Path<String>,
    uri: Uri,
) -> Answer {
    caller.require_direct()?;
    let started_at = app.clock.stamp();
    caller.require_recent(&started_at)?;
    query::only(&uri, &[])?;
    let answer = app.restore_backup(&caller, started_at, &name).await?;
    Ok(json_answer(StatusCode::OK, &answer))
}
