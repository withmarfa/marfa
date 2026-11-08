use std::sync::Arc;

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};

use super::setup::{admit_claim, make_claim};
use super::{cookies, with_cookie};
use crate::app::App;
use crate::app::access::Caller;
use crate::app::auth::Visit;
use crate::app::auth::owner::{self, UPDATE_FIELDS, Update};
use crate::http::answer::{Answer, json_answer};
use crate::http::body::JsonBody;

pub async fn read(State(app): State<Arc<App>>, caller: Caller) -> Answer {
    caller.require_direct()?;
    let found = owner::find(&app).await?.ok_or_else(owner::not_found)?;
    Ok(json_answer(
        StatusCode::OK,
        &found.to_json(app.addresses().sign_in().origin()),
    ))
}

pub async fn claim(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    visit: Visit,
    body: JsonBody,
) -> Answer {
    admit_claim(&app, &headers, &visit).await?;
    let fields = body.open_object().await?;
    let (found, session) = make_claim(&app, &headers, visit, fields).await?;
    let mut answer = json_answer(
        StatusCode::CREATED,
        &found.to_json(app.addresses().sign_in().origin()),
    );
    if cookies::holds_setup(&headers) {
        answer = with_cookie(answer, cookies::setup_ended(&app.addresses().sign_in())?);
    }
    if let Some(session) = session {
        answer = with_cookie(answer, session);
    }
    Ok(answer)
}

pub async fn update(
    State(app): State<Arc<App>>,
    caller: Caller,
    visit: Visit,
    body: JsonBody,
) -> Answer {
    caller.require_direct()?;
    let body = body.object(&UPDATE_FIELDS).await?;
    let change = Update::from_body(&body)?;
    let found = owner::update(&app, &caller, change, visit).await?;
    Ok(json_answer(
        StatusCode::OK,
        &found.to_json(app.addresses().sign_in().origin()),
    ))
}
