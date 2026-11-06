//! `GET /`: the instance's description, or a page for a browser.

use axum::Router;
use axum::extract::State;
use axum::http::{HeaderMap, HeaderValue, header};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::get;
use serde_json::json;

use crate::app::App;
use crate::error::ApiResult;
use crate::storage::instance;

/// The features this server serves, each with at least one door.
const FEATURES: [&str; 3] = ["items", "keys", "types"];

pub fn router() -> Router<App> {
    Router::new().route("/", get(describe))
}

async fn describe(State(app): State<App>, headers: HeaderMap) -> ApiResult<Response> {
    let name = app
        .db
        .read(|conn| Ok(instance::get(conn, "name")?))
        .await?
        .unwrap_or_else(|| "Marfa".into());
    let mut response = if prefers_html(&headers) {
        Html(page(&name)).into_response()
    } else {
        axum::Json(json!({
            "name": name,
            "version": env!("CARGO_PKG_VERSION"),
            "instance_id": app.instance_id,
            "contract": 0,
            "features": FEATURES,
        }))
        .into_response()
    };
    response
        .headers_mut()
        .insert(header::VARY, HeaderValue::from_static("Accept"));
    Ok(response)
}

/// Whether `Accept` ranks `text/html` above JSON. A tie answers JSON.
fn prefers_html(headers: &HeaderMap) -> bool {
    let Some(accept) = headers
        .get(header::ACCEPT)
        .and_then(|value| value.to_str().ok())
    else {
        return false;
    };
    let mut html = 0.0_f64;
    let mut json = 0.0_f64;
    for range in accept.split(',') {
        let mut parts = range.split(';');
        let media = parts.next().unwrap_or("").trim().to_ascii_lowercase();
        let quality = parts
            .filter_map(|parameter| parameter.trim().strip_prefix("q="))
            .find_map(|q| q.trim().parse::<f64>().ok())
            .unwrap_or(1.0);
        match media.as_str() {
            "text/html" => html = html.max(quality),
            "application/json" | "application/*" | "*/*" => json = json.max(quality),
            _ => {}
        }
    }
    html > 0.0 && html > json
}

fn page(name: &str) -> String {
    let name = name
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");
    format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>{name}</title></head>\
         <body><h1>{name}</h1><p>This Marfa instance is running.</p></body></html>"
    )
}
