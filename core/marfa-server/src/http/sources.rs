//! `GET /sources`, and `GET` and `PATCH /source`.

use std::sync::Arc;

use axum::extract::State;
use axum::http::{StatusCode, Uri};
use serde_json::json;

use super::answer::{Answer, json_answer};
use super::body::JsonBody;
use super::query;
use crate::app::App;
use crate::app::access::Caller;
use crate::app::refusal::{Code, Refusal, Result};
use crate::app::sources::{self, Change, FIELDS};

fn named_code(uri: &Uri) -> Result<String> {
    query::only(uri, &["source"])?;
    let code = query::pairs(uri)?
        .into_iter()
        .find_map(|(name, value)| (name == "source").then_some(value))
        .ok_or_else(|| {
            Refusal::new(Code::MissingRequiredField, "source is required.")
                .with_detail("field", "source")
        })?;
    sources::check_code(&code)?;
    Ok(code)
}

pub async fn list(State(app): State<Arc<App>>, caller: Caller, uri: Uri) -> Answer {
    query::only(&uri, &[])?;
    let data = sources::list(&app, &caller).await?;
    Ok(json_answer(
        StatusCode::OK,
        &json!({ "data": data, "next_cursor": null }),
    ))
}

pub async fn read(State(app): State<Arc<App>>, caller: Caller, uri: Uri) -> Answer {
    let source = sources::read(&app, &caller, named_code(&uri)?).await?;
    Ok(json_answer(StatusCode::OK, &source))
}

pub async fn update(
    State(app): State<Arc<App>>,
    caller: Caller,
    uri: Uri,
    body: JsonBody,
) -> Answer {
    let named = named_code(&uri);
    if let Ok(code) = &named {
        caller.require_may_name(code)?;
    }
    let sent = body.object(&FIELDS).await?;
    let code = named?;
    let change = Change::from_body(&sent)?;
    let source = sources::update(&app, &caller, code, change).await?;
    Ok(json_answer(StatusCode::OK, &source))
}
