use axum::Router;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::get;

use crate::app::App;
use crate::health::{self, Status};

pub fn router() -> Router<App> {
    Router::new().route("/health", get(check))
}

async fn check(State(app): State<App>) -> impl IntoResponse {
    let (status, body) = health::check(&app).await;
    let code = if status == Status::Down {
        StatusCode::SERVICE_UNAVAILABLE
    } else {
        StatusCode::OK
    };
    (code, axum::Json(body))
}
