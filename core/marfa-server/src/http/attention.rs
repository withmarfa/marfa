//! `GET /attention`: what needs the owner's eye.

use std::sync::Arc;

use axum::extract::State;
use axum::http::{StatusCode, Uri};

use super::answer::{Answer, json_answer};
use super::query;
use crate::app::App;
use crate::app::access::{Caller, Permission};
use crate::app::attention;

pub async fn list(State(app): State<Arc<App>>, caller: Caller, uri: Uri) -> Answer {
    caller.require(Permission::InstanceRead)?;
    query::only(&uri, &[])?;
    Ok(json_answer(StatusCode::OK, &attention::read(&app).await))
}
