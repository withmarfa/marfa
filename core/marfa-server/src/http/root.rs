use std::sync::Arc;

use axum::extract::State;
use axum::http::{HeaderMap, HeaderValue, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};

use super::answer::{Answer, asks_for_html, json_answer};
use super::pages::{self, Notice};
use super::query;
use crate::app::refusal::Refusal;
use crate::app::{App, instance};
use crate::settings::registry::MAX_REQUEST_BYTES;

pub(super) const DOCUMENT: &str = include_str!("../../../../openapi.json");

pub async fn document(State(app): State<Arc<App>>) -> Answer {
    if app.settings.start.contract_version.is_none() {
        return Ok(([(header::CONTENT_TYPE, "application/json")], DOCUMENT).into_response());
    }
    let mut document: Value = serde_json::from_str(DOCUMENT)
        .map_err(|_| Refusal::internal("the published document did not parse"))?;
    document["info"]["version"] = app.contract().to_string().into();
    Ok(json_answer(StatusCode::OK, &document))
}

async fn answer(app: &App, uri: &Uri, headers: &HeaderMap) -> Answer {
    query::only(uri, &[])?;
    let name = instance::name(app).await?;
    let accept = headers
        .get(header::ACCEPT)
        .and_then(|value| value.to_str().ok());
    if asks_for_html(accept) {
        return Ok(pages::notice(&Notice::running(&name))?.into_response());
    }
    Ok(json_answer(
        StatusCode::OK,
        &json!({
            "name": name,
            "version": env!("CARGO_PKG_VERSION"),
            "instance_id": app.instance_id,
            "contract": app.contract(),
            "features": [],
            "max_request_bytes": app.settings.live().get(MAX_REQUEST_BYTES),
        }),
    ))
}

pub async fn describe(State(app): State<Arc<App>>, uri: Uri, headers: HeaderMap) -> Response {
    let mut response = answer(&app, &uri, &headers).await.into_response();
    response
        .headers_mut()
        .insert(header::VARY, HeaderValue::from_static("Accept"));
    response
}
