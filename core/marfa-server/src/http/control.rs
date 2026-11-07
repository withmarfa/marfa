//! Doors only the private control socket serves.

use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use serde_json::{Value, json};

use super::answer::{Answer, json_answer};
use super::body::JsonBody;
use crate::app::keys::{self, MINT_FIELDS};
use crate::app::{App, instance};

const CLAIM_FIELDS: [&str; 3] = ["email", "password", "name"];

pub async fn setup_status(State(app): State<Arc<App>>) -> Answer {
    let claimed = instance::claimed(&app).await?;
    Ok(json_answer(StatusCode::OK, &json!({ "claimed": claimed })))
}

/// Marks the instance claimed. There is no sign-in here for what the body
/// names to serve, so none of it is kept.
pub async fn setup_claim(State(app): State<Arc<App>>, body: JsonBody) -> Answer {
    body.object(&CLAIM_FIELDS).await?;
    instance::claim(&app).await?;
    Ok(json_answer(
        StatusCode::CREATED,
        &json!({ "claimed": true }),
    ))
}

pub async fn mint_key(State(app): State<Arc<App>>, body: JsonBody) -> Answer {
    let body = body.object(&MINT_FIELDS).await?;
    let (key, secret) = keys::mint(&app, &body).await?;
    let mut answer = key.to_json();
    answer.insert("key".into(), secret.into());
    Ok(json_answer(StatusCode::CREATED, &Value::Object(answer)))
}
