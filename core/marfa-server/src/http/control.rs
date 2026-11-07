//! Doors only the private control socket serves.

use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use serde_json::json;

use super::answer::{Answer, json_answer};
use super::body::JsonBody;
use crate::app::access::Caller;
use crate::app::{App, instance};

const CLAIM_FIELDS: [&str; 3] = ["email", "password", "name"];

pub async fn setup_status(State(app): State<Arc<App>>) -> Answer {
    let claimed = instance::claimed(&app).await?;
    Ok(json_answer(StatusCode::OK, &json!({ "claimed": claimed })))
}

/// Marks the instance claimed. There is no sign-in here for what the body
/// names to serve, so none of it is kept.
pub async fn setup_claim(State(app): State<Arc<App>>, caller: Caller, body: JsonBody) -> Answer {
    caller.require_direct()?;
    body.object(&CLAIM_FIELDS).await?;
    instance::claim(&app, &caller).await?;
    Ok(json_answer(
        StatusCode::CREATED,
        &json!({ "claimed": true }),
    ))
}
