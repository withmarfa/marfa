//! The doors under `/cloud`.

use std::sync::Arc;

use axum::extract::State;
use axum::http::{StatusCode, Uri};
use serde_json::{Map, Value};

use super::answer::{Answer, json_answer};
use super::body::JsonBody;
use super::query;
use crate::app::App;
use crate::app::access::{Caller, Permission};
use crate::app::cloud::{self, SignIn};
use crate::app::refusal::{Refusal, Result};

const CONFIRM: &str = "confirm_sign_in_address_change";

fn asked(body: &Map<String, Value>) -> Result<(SignIn, bool)> {
    let sign_in = match body.get("sign_in_address") {
        None => SignIn::Move,
        Some(Value::String(word)) if word == "move" => SignIn::Move,
        Some(Value::String(word)) if word == "keep" => SignIn::Keep,
        Some(_) => {
            return Err(Refusal::invalid_at(
                "/sign_in_address",
                "Send sign_in_address as \"move\" or \"keep\".",
            ));
        }
    };
    let confirmed = match body.get(CONFIRM) {
        None => false,
        Some(Value::Bool(confirmed)) => *confirmed,
        Some(_) => {
            return Err(Refusal::invalid_at(
                "/confirm_sign_in_address_change",
                "Send confirm_sign_in_address_change as true or false.",
            ));
        }
    };
    Ok((sign_in, confirmed))
}

pub async fn start(
    State(app): State<Arc<App>>,
    caller: Caller,
    uri: Uri,
    body: JsonBody,
) -> Answer {
    caller.require(Permission::ConfigManage)?;
    query::only(&uri, &[])?;
    let body = body.object(&["sign_in_address", CONFIRM]).await?;
    let (sign_in, confirmed) = asked(&body)?;
    Ok(json_answer(
        StatusCode::CREATED,
        &cloud::start(&app, &caller, sign_in, confirmed).await?,
    ))
}

pub async fn read(State(app): State<Arc<App>>, caller: Caller, uri: Uri) -> Answer {
    caller.require(Permission::ConfigManage)?;
    query::only(&uri, &[])?;
    Ok(json_answer(StatusCode::OK, &cloud::read(&app).await?))
}

pub async fn unlink(State(app): State<Arc<App>>, caller: Caller, uri: Uri) -> Answer {
    caller.require(Permission::ConfigManage)?;
    query::only(&uri, &[CONFIRM])?;
    let confirmed = query::flag(&uri, CONFIRM)?.unwrap_or(false);
    Ok(json_answer(
        StatusCode::OK,
        &cloud::unlink(&app, &caller, confirmed).await?,
    ))
}
