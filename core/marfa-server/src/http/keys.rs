use std::sync::Arc;

use axum::extract::{Path, Request, State};
use axum::http::{HeaderValue, StatusCode, Uri, header};
use axum::middleware::Next;
use axum::response::Response;
use serde_json::{Value, json};

use super::answer::{Answer, json_answer, refusal_answer};
use super::body::JsonBody;
use super::caller::identify;
use super::query;
use crate::app::App;
use crate::app::access::{Caller, Permission};
use crate::app::keys::{self, MINT_FIELDS, Mint, UPDATE_FIELDS, Update};
use crate::app::refusal::{Code, Refusal};
use crate::settings::registry::{
    RATE_LIMIT_ENABLED, RATE_LIMIT_KEYS_REQUESTS, RATE_LIMIT_WINDOW_MS,
};

const LIMIT_HEADER: &str = "x-ratelimit-limit";

/// Takes one key operation from the caller's allowance, shared by every door that
/// reaches the key operations, and answers the seconds to wait when none is left.
pub fn key_operation_wait(app: &App, caller: &Caller) -> Option<u64> {
    let live = app.settings.live();
    if !live.get(RATE_LIMIT_ENABLED) {
        return None;
    }
    app.key_limit.take(
        &caller.credential_handle(),
        app.clock.now_ms(),
        live.get(RATE_LIMIT_KEYS_REQUESTS),
        live.get(RATE_LIMIT_WINDOW_MS),
    )
}

pub async fn limited(State(app): State<Arc<App>>, request: Request, next: Next) -> Response {
    let live = app.settings.live();
    if !live.get(RATE_LIMIT_ENABLED) {
        return next.run(request).await;
    }
    let cap = live.get(RATE_LIMIT_KEYS_REQUESTS);
    let (mut parts, body) = request.into_parts();
    let wait = identify(&mut parts, &app)
        .await
        .ok()
        .flatten()
        .and_then(|caller| key_operation_wait(&app, &caller));
    let mut response = match wait {
        Some(seconds) => {
            let mut refused = refusal_answer(&Refusal::new(
                Code::RateLimited,
                "Too many requests to the key operations; try again later.",
            ));
            refused
                .headers_mut()
                .insert(header::RETRY_AFTER, HeaderValue::from(seconds));
            refused
        }
        None => next.run(Request::from_parts(parts, body)).await,
    };
    response
        .headers_mut()
        .insert(LIMIT_HEADER, HeaderValue::from(cap));
    response
}

pub async fn mint(State(app): State<Arc<App>>, caller: Caller, body: JsonBody) -> Answer {
    caller.require(Permission::KeysMint)?;
    let request = Mint::from_body(&body.object(&MINT_FIELDS).await?)?;
    let (key, secret) = keys::mint(&app, &caller, request).await?;
    let mut answer = key.to_json();
    answer.insert("key".into(), secret.into());
    let mut response = json_answer(StatusCode::CREATED, &Value::Object(answer));
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(response)
}

pub async fn list(State(app): State<Arc<App>>, caller: Caller, uri: Uri) -> Answer {
    caller.require_key_door()?;
    query::only(&uri, &[])?;
    let keys = keys::list(&app, &caller).await?;
    let data: Vec<_> = keys.iter().map(keys::Key::to_json).collect();
    Ok(json_answer(
        StatusCode::OK,
        &json!({ "data": data, "next_cursor": null }),
    ))
}

pub async fn current(State(app): State<Arc<App>>, caller: Caller, uri: Uri) -> Answer {
    let key = keys::current(&app, &caller).await?;
    let Some(key) = key else {
        return Err(Refusal::new(Code::Forbidden, "This credential is not a key.").into());
    };
    query::only(&uri, &[])?;
    Ok(json_answer(StatusCode::OK, &Value::Object(key)))
}

pub async fn update(
    State(app): State<Arc<App>>,
    caller: Caller,
    Path(id): Path<String>,
    body: JsonBody,
) -> Answer {
    caller.require_key_door()?;
    keys::check_id(&id)?;
    let request = Update::from_body(&body.object(&UPDATE_FIELDS).await?)?;
    let key = keys::update(&app, &caller, id, request).await?;
    Ok(json_answer(StatusCode::OK, &Value::Object(key.to_json())))
}

pub async fn revoke(State(app): State<Arc<App>>, caller: Caller, Path(id): Path<String>) -> Answer {
    caller.require_key_door()?;
    keys::check_id(&id)?;
    keys::revoke(&app, &caller, id).await?;
    Ok(json_answer(StatusCode::OK, &json!({ "ok": true })))
}
