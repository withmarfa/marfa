//! `GET /connectors`. This server registers no connectors, so every reader's
//! page is empty.

use axum::Json;
use axum::Router;
use axum::routing::get;
use serde_json::{Value, json};

use crate::app::App;
use crate::auth::Caller;

pub fn router() -> Router<App> {
    Router::new().route("/connectors", get(list))
}

async fn list(_caller: Caller) -> Json<Value> {
    Json(json!({ "data": [], "next_cursor": null }))
}
