use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::{StatusCode, Uri};

use super::answer::{Answer, json_answer};
use super::body::JsonBody;
use super::query;
use crate::app::App;
use crate::app::access::Caller;
use crate::app::connector_settings;

pub async fn list(
    State(app): State<Arc<App>>,
    caller: Caller,
    Path(name): Path<String>,
    uri: Uri,
) -> Answer {
    query::only(&uri, &[])?;
    Ok(json_answer(
        StatusCode::OK,
        &connector_settings::list(&app, &caller, name).await?,
    ))
}

pub async fn set(
    State(app): State<Arc<App>>,
    caller: Caller,
    Path(name): Path<String>,
    uri: Uri,
    body: JsonBody,
) -> Answer {
    query::only(&uri, &[])?;
    connector_settings::require_manager(&caller)?;
    let changes = body.open_object().await?;
    Ok(json_answer(
        StatusCode::OK,
        &connector_settings::set(&app, &caller, name, changes).await?,
    ))
}

pub async fn own(
    State(app): State<Arc<App>>,
    caller: Caller,
    Path(id): Path<String>,
    uri: Uri,
) -> Answer {
    query::only(&uri, &[])?;
    Ok(json_answer(
        StatusCode::OK,
        &connector_settings::own(&app, &caller, id).await?,
    ))
}
