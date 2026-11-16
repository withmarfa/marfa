use std::sync::Arc;

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, Uri, header};
use serde_json::{Map, Value};

use super::problem_answer;
use crate::app::App;
use crate::app::auth::Visit;
use crate::app::oauth::client::{ErrorCode, RegistrationError};
use crate::app::oauth::token::Form;
use crate::app::oauth::{register as registration, revoke as revocation, token};
use crate::http::answer::{Answer, json_answer};
use crate::http::body::JsonBody;
use crate::http::caller::bears_token;
use crate::http::query;

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

pub async fn register(
    State(app): State<Arc<App>>,
    visit: Visit,
    headers: HeaderMap,
    uri: Uri,
    body: JsonBody,
) -> Answer {
    query::only(&uri, &[])?;
    if !body.declares_plain_json() {
        let refused = RegistrationError::metadata("Send the registration as application/json.");
        return Ok(json_answer(StatusCode::BAD_REQUEST, &refused.to_json()));
    }
    let sent = body.read().await?;
    let bearer = bears_token(&headers);
    match registration::register(&app, sent.bytes(), bearer, &visit).await? {
        Ok(answer) => Ok(json_answer(StatusCode::CREATED, &Value::Object(answer))),
        Err(refused) => {
            let status = match refused.error {
                ErrorCode::InvalidToken => StatusCode::UNAUTHORIZED,
                _ => StatusCode::BAD_REQUEST,
            };
            Ok(json_answer(status, &refused.to_json()))
        }
    }
}
