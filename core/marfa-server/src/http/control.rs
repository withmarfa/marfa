//! Doors only the private control socket serves.

use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use serde_json::{Value, json};

use super::answer::{Answer, json_answer};
use super::body::JsonBody;
use crate::app::App;
use crate::app::access::Caller;
use crate::app::auth::Visit;
use crate::app::auth::claim::{self, Proof};
use crate::app::auth::owner::{self, Details};
use crate::app::refusal::Refusal;

const CLAIM_FIELDS: [&str; 4] = ["username", "password", "name", "email"];
const RECOVER_FIELDS: [&str; 1] = ["password"];

pub async fn setup_status(State(app): State<Arc<App>>, _: Caller) -> Answer {
    let status = claim::status(&app).await?;
    Ok(json_answer(
        StatusCode::OK,
        &json!({
            "claimed": status.claimed,
            "owner_id": status.owner_id,
            "generation": status.generation,
        }),
    ))
}

pub async fn setup_code(State(app): State<Arc<App>>, caller: Caller) -> Answer {
    let (code, generation) = claim::issue_code(&app, &caller).await?;
    Ok(json_answer(
        StatusCode::OK,
        &json!({ "code": code, "generation": generation }),
    ))
}

pub async fn setup_ticket(State(app): State<Arc<App>>, caller: Caller) -> Answer {
    let (ticket, expires_at) = claim::issue_ticket(&app, &caller).await?;
    let origin = app.addresses().sign_in().origin().to_string();
    Ok(json_answer(
        StatusCode::OK,
        &json!({
            "ticket": ticket,
            "url": format!("{origin}/setup#handoff={ticket}"),
            "expires_at": expires_at,
        }),
    ))
}

pub async fn setup_claim(State(app): State<Arc<App>>, caller: Caller, body: JsonBody) -> Answer {
    caller.require_local()?;
    let body = body.object(&CLAIM_FIELDS).await?;
    let text = |field: &str| body.get(field).and_then(Value::as_str);
    let username = text("username").ok_or_else(owner::incomplete_claim)?;
    let password = text("password").ok_or_else(owner::incomplete_claim)?;
    let name = owner::optional_text(&body, "name")?;
    let email = owner::optional_email(&body)?;
    let details = Details::new(username, email, name, password.to_string())?;
    let owner = claim::claim(&app, details, Proof::Local, Visit::default()).await?;
    Ok(json_answer(
        StatusCode::CREATED,
        &owner.to_json(app.addresses().sign_in().origin()),
    ))
}

pub async fn recover_owner(State(app): State<Arc<App>>, caller: Caller, body: JsonBody) -> Answer {
    caller.require_local()?;
    let body = body.object(&RECOVER_FIELDS).await?;
    let password = body
        .get("password")
        .and_then(Value::as_str)
        .ok_or_else(|| Refusal::validation("Provide the new password."))?;
    owner::recover(&app, password.to_string()).await?;
    Ok(json_answer(StatusCode::OK, &json!({ "recovered": true })))
}
