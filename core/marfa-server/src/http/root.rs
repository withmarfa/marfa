//! `GET /`: the instance's description, or a page for a browser.

use std::sync::Arc;

use axum::extract::State;
use axum::http::{HeaderMap, HeaderValue, StatusCode, Uri, header};
use axum::response::{Html, IntoResponse, Response};
use serde_json::json;

use super::answer::{Answer, asks_for_html, escape_html, json_answer};
use super::query;
use crate::app::{App, instance};

fn page(name: &str) -> String {
    let name = escape_html(name);
    format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>{name}</title>\
         </head><body><h1>{name}</h1><p>This Marfa instance is running.</p></body></html>"
    )
}

async fn answer(app: &App, uri: &Uri, headers: &HeaderMap) -> Answer {
    query::only(uri, &[])?;
    let name = instance::name(app).await?;
    let accept = headers
        .get(header::ACCEPT)
        .and_then(|value| value.to_str().ok());
    if asks_for_html(accept) {
        return Ok(Html(page(&name)).into_response());
    }
    Ok(json_answer(
        StatusCode::OK,
        &json!({
            "name": name,
            "version": env!("CARGO_PKG_VERSION"),
            "instance_id": app.instance_id,
            "contract": app.contract(),
            "features": [],
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
