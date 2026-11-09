use std::sync::Arc;

use axum::extract::State;
use axum::http::{StatusCode, Uri};

use super::answer::{Answer, json_answer};
use super::query;
use crate::app::access::{Caller, Permission};
use crate::app::{App, metrics};

pub async fn read(State(app): State<Arc<App>>, caller: Caller, uri: Uri) -> Answer {
    caller.require(Permission::InstanceRead)?;
    query::only(&uri, &[])?;
    let found = metrics::read(&app).await?;
    Ok(json_answer(StatusCode::OK, &found))
}
