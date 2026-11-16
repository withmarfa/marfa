use std::sync::Arc;

use axum::extract::State;
use axum::http::{StatusCode, Uri};

use super::answer::{Answer, json_answer};
use super::query;
use crate::app::App;
use crate::app::access::{Caller, Permission};
use crate::app::updates;

pub async fn read(State(app): State<Arc<App>>, caller: Caller, uri: Uri) -> Answer {
    caller.require(Permission::InstanceRead)?;
    query::only(&uri, &[])?;
    Ok(json_answer(StatusCode::OK, &updates::status(&app).await?))
}

/// The update is the server's once admitted, so revoking the key does not stop it.
pub async fn start(State(app): State<Arc<App>>, caller: Caller, uri: Uri) -> Answer {
    caller.require(Permission::InstanceMaintain)?;
    query::only(&uri, &[])?;
    Ok(json_answer(
        StatusCode::ACCEPTED,
        &updates::start(&app).await?,
    ))
}
