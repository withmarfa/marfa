//! `GET /housekeeping` and `POST /housekeeping/{name}/run`.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::{StatusCode, Uri};
use serde_json::json;

use super::answer::{Answer, json_answer};
use super::query;
use crate::app::App;
use crate::app::access::{Caller, Permission};
use crate::app::housekeeping;
use crate::app::refusal::Refusal;

fn well_formed(name: &str) -> bool {
    let mut bytes = name.bytes();
    bytes.next().is_some_and(|byte| byte.is_ascii_lowercase())
        && bytes.all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

pub async fn list(State(app): State<Arc<App>>, caller: Caller, uri: Uri) -> Answer {
    caller.require(Permission::InstanceRead)?;
    query::only(&uri, &[])?;
    let data = housekeeping::list(&app).await?;
    Ok(json_answer(
        StatusCode::OK,
        &json!({ "data": data, "next_cursor": null }),
    ))
}

/// The caller is judged here and nowhere after: the run is the server's, so a
/// key revoked once it is admitted does not stop it.
pub async fn run(
    State(app): State<Arc<App>>,
    caller: Caller,
    Path(name): Path<String>,
    uri: Uri,
) -> Answer {
    caller.require(Permission::InstanceMaintain)?;
    query::only(&uri, &[])?;
    if !well_formed(&name) {
        return Err(
            Refusal::validation(format!("\"{name}\" is not a housekeeping job's name"))
                .with_detail("field", "name")
                .into(),
        );
    }
    let ended = housekeeping::run_now(&app, &name).await?;
    Ok(json_answer(StatusCode::OK, &ended.to_json()))
}
