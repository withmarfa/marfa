//! One router per door group, merged. The control socket serves every door
//! the public listener does, plus `/_control`.

mod connectors;
mod control;
mod health;
mod items;
mod keys;
mod root;
mod types;

use std::any::Any;

use axum::Router;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use tower_http::catch_panic::CatchPanicLayer;

use crate::app::App;
use crate::error::ApiError;
use crate::observe::{self, Transport};

pub fn router(app: App, transport: Transport) -> Router {
    let mut routes = Router::new()
        .merge(root::router())
        .merge(health::router())
        .merge(keys::router())
        .merge(types::router())
        .merge(items::router())
        .merge(connectors::router());
    if transport == Transport::LocalSocket {
        routes = routes.merge(control::router());
    }
    routes
        .route_layer(middleware::from_fn_with_state(app.clone(), same_instance))
        .route_layer(middleware::from_fn(observe::remember_route))
        .fallback(unmatched)
        .method_not_allowed_fallback(unmatched)
        .layer(CatchPanicLayer::custom(panicked))
        .layer(middleware::from_fn(move |request, next| {
            observe::observe(transport, request, next)
        }))
        .with_state(app)
}

/// A write that names another instance in `X-Marfa-Instance-Id` reached
/// the wrong instance at this address.
async fn same_instance(State(app): State<App>, request: Request, next: Next) -> Response {
    let write = matches!(
        *request.method(),
        Method::POST | Method::PUT | Method::PATCH | Method::DELETE
    );
    let named = request
        .headers()
        .get("x-marfa-instance-id")
        .and_then(|value| value.to_str().ok());
    if write
        && let Some(named) = named
        && marfa_core::server::validate_id("X-Marfa-Instance-Id", named).is_ok()
        && named != app.instance_id
    {
        return ApiError::conflict(
            "instance_changed",
            "This write names another instance than the one at this address.",
        )
        .into_response();
    }
    next.run(request).await
}

async fn unmatched(method: Method, headers: HeaderMap) -> ApiError {
    if method == Method::GET && headers.contains_key("x-marfa-reach") {
        return ApiError::new(
            StatusCode::BAD_REQUEST,
            "validation_error",
            "X-Marfa-Reach is read only by the doors that take it.",
        );
    }
    ApiError::not_found()
}

fn panicked(_: Box<dyn Any + Send + 'static>) -> Response {
    ApiError::internal("a handler panicked").into_response()
}
