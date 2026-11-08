use std::sync::Arc;

use axum::extract::State;
use axum::http::{StatusCode, Uri};

use super::answer::{Answer, json_answer};
use super::query;
use crate::app::access::Caller;
use crate::app::{App, overview};

pub async fn read(State(app): State<Arc<App>>, caller: Caller, uri: Uri) -> Answer {
    query::only(&uri, &[])?;
    Ok(json_answer(
        StatusCode::OK,
        &overview::read(&app, &caller).await?,
    ))
}
