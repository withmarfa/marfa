use std::sync::Arc;

use axum::extract::{Path, Request, State};
use axum::http::{StatusCode, Uri};
use axum::middleware::Next;
use axum::response::Response;
use serde_json::json;

use super::answer::{Answer, json_answer, refusal_answer};
use super::body::JsonBody;
use super::caller::identify;
use super::listing::{Params, whole_limit};
use super::query;
use crate::app::App;
use crate::app::access::{Caller, unauthorized};
use crate::app::webhooks::{self, CREATE_FIELDS, Create, UPDATE_FIELDS, Update};

/// A subscription belongs to the key or app that registered it, so a browser's session, which
/// is neither, reaches none.
pub async fn not_a_session(State(app): State<Arc<App>>, request: Request, next: Next) -> Response {
    let (mut parts, body) = request.into_parts();
    if matches!(identify(&mut parts, &app).await, Ok(Some(Caller::Owner(_)))) {
        return refusal_answer(&unauthorized());
    }
    next.run(Request::from_parts(parts, body)).await
}

pub async fn create(State(app): State<Arc<App>>, caller: Caller, body: JsonBody) -> Answer {
    caller.webhook_maker()?;
    let request = Create::from_body(&body.object(&CREATE_FIELDS).await?)?;
    let created = webhooks::create(&app, &caller, request).await?;
    Ok(json_answer(StatusCode::CREATED, &created))
}

pub async fn list(State(app): State<Arc<App>>, caller: Caller, uri: Uri) -> Answer {
    caller.webhook_reach()?;
    query::only(&uri, &[])?;
    Ok(json_answer(
        StatusCode::OK,
        &webhooks::list(&app, &caller).await?,
    ))
}

pub async fn get(
    State(app): State<Arc<App>>,
    caller: Caller,
    Path(id): Path<String>,
    uri: Uri,
) -> Answer {
    caller.webhook_reach()?;
    query::only(&uri, &[])?;
    Ok(json_answer(
        StatusCode::OK,
        &webhooks::get(&app, &caller, id).await?,
    ))
}

pub async fn update(
    State(app): State<Arc<App>>,
    caller: Caller,
    Path(id): Path<String>,
    body: JsonBody,
) -> Answer {
    caller.webhook_maker()?;
    let request = Update::from_body(&body.object(&UPDATE_FIELDS).await?)?;
    let updated = webhooks::update(&app, &caller, id, request).await?;
    Ok(json_answer(StatusCode::OK, &updated))
}

pub async fn delete(State(app): State<Arc<App>>, caller: Caller, Path(id): Path<String>) -> Answer {
    caller.webhook_maker()?;
    webhooks::delete(&app, &caller, id).await?;
    Ok(json_answer(StatusCode::OK, &json!({ "ok": true })))
}

pub async fn deliveries(
    State(app): State<Arc<App>>,
    caller: Caller,
    Path(id): Path<String>,
    uri: Uri,
) -> Answer {
    caller.webhook_reach()?;
    let params = Params::read(&uri, &["limit", "cursor"], false)?;
    let limit = whole_limit(&params, 50, 200)?;
    let page = webhooks::deliveries(&app, &caller, id, limit, params.one("cursor")?).await?;
    Ok(json_answer(StatusCode::OK, &page))
}

pub async fn redeliver(
    State(app): State<Arc<App>>,
    caller: Caller,
    Path((id, delivery_id)): Path<(String, String)>,
) -> Answer {
    caller.webhook_reach()?;
    let delivery = webhooks::redeliver(&app, &caller, id, delivery_id).await?;
    Ok(json_answer(StatusCode::ACCEPTED, &delivery))
}
