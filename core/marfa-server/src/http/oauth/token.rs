use std::sync::Arc;

use axum::extract::State;
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::{Map, Value};

use super::problem_answer;
use crate::app::App;
use crate::app::auth::Visit;
use crate::app::oauth::token::Form;
use crate::app::oauth::{register as registration, revoke as revocation, token};
use crate::http::answer::{Answer, json_answer};
use crate::http::body::JsonBody;

async fn form_of(
    headers: &HeaderMap,
    body: JsonBody,
) -> Result<Form, crate::http::answer::Stopped> {
    Ok(Form {
        pairs: body.form_pairs().await?,
        authorization: headers.contains_key(header::AUTHORIZATION),
    })
}

pub async fn exchange(
    State(app): State<Arc<App>>,
    visit: Visit,
    headers: HeaderMap,
    body: JsonBody,
) -> Answer {
    let form = form_of(&headers, body).await?;
    match token::exchange(&app, form, &visit).await? {
        Ok(answer) => Ok(json_answer(StatusCode::OK, &Value::Object(answer))),
        Err(problem) => problem_answer(&problem),
    }
}

pub async fn revoke(
    State(app): State<Arc<App>>,
    visit: Visit,
    headers: HeaderMap,
    body: JsonBody,
) -> Answer {
    let form = form_of(&headers, body).await?;
    match revocation::revoke(&app, form, &visit).await? {
        Ok(()) => Ok(json_answer(StatusCode::OK, &Map::new())),
        Err(problem) => problem_answer(&problem),
    }
}

pub async fn register(State(app): State<Arc<App>>, visit: Visit, body: JsonBody) -> Answer {
    let sent = body.read().await?;
    match registration::register(&app, sent.bytes(), &visit).await? {
        Ok(answer) => Ok(json_answer(StatusCode::CREATED, &Value::Object(answer))),
        Err(refused) => Ok(json_answer(StatusCode::BAD_REQUEST, &refused.to_json())),
    }
}

pub async fn register_preflight(asked: HeaderMap) -> Response {
    let mut response = StatusCode::NO_CONTENT.into_response();
    let posting = asked
        .get(header::ACCESS_CONTROL_REQUEST_METHOD)
        .is_some_and(|method| method == "POST");
    if posting {
        let headers = response.headers_mut();
        headers.insert(
            header::ACCESS_CONTROL_ALLOW_ORIGIN,
            HeaderValue::from_static("*"),
        );
        headers.insert(
            header::ACCESS_CONTROL_ALLOW_METHODS,
            HeaderValue::from_static("POST"),
        );
        headers.insert(
            header::ACCESS_CONTROL_ALLOW_HEADERS,
            HeaderValue::from_static("Content-Type"),
        );
    }
    response
}
