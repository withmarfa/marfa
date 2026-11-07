//! The only place that names axum.

pub mod answer;
mod audit;
pub mod body;
mod caller;
mod control;
mod edge_types;
mod health;
mod items;
mod keys;
pub mod observe;
mod page;
pub mod pages;
mod query;
mod root;
mod sources;
mod test_hooks;
mod types;

use std::future::Future;
use std::sync::Arc;

use axum::body::Body;
use axum::extract::{MatchedPath, Request};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::middleware::{self, Next, from_fn, from_fn_with_state};
use axum::response::Response;
use axum::routing::{delete, get, patch, post, put};
use axum::{Router, serve};
use tokio::net::{TcpListener, UnixListener};
use tower_http::catch_panic::CatchPanicLayer;

use crate::app::App;
use crate::app::refusal::{Code, Refusal};
use answer::{panicked, refusal_answer};
use observe::{Observed, Transport, Unmatched, observe as observe_request, remember_route};

type Routes = Router<Arc<App>>;

/// What a path or method no operation serves is answered.
async fn unmatched(method: Method, headers: HeaderMap) -> Response {
    let mut response = if method == Method::OPTIONS {
        let mut empty = Response::new(Body::empty());
        *empty.status_mut() = StatusCode::NO_CONTENT;
        empty
    } else if method == Method::GET && headers.contains_key("x-marfa-reach") {
        refusal_answer(&Refusal::validation(
            "No operation at this path takes X-Marfa-Reach.",
        ))
    } else {
        refusal_answer(&Refusal::new(
            Code::NotFound,
            "No operation serves this request.",
        ))
    };
    response.extensions_mut().insert(Unmatched);
    response
}

/// The doors `X-Marfa-Reach` may name, as their routes are written.
const REACH_DOORS: [&str; 9] = [
    "/items",
    "/items/{id}",
    "/items/{id}/edges",
    "/edges",
    "/edges/{id}",
    "/types",
    "/edge-types",
    "/keys/current",
    "/events",
];

async fn reach_where_taken(request: Request, next: Next) -> Response {
    let takes_it = request
        .extensions()
        .get::<MatchedPath>()
        .is_some_and(|route| REACH_DOORS.contains(&route.as_str()));
    if request.method() == Method::GET
        && request.headers().contains_key("x-marfa-reach")
        && !takes_it
    {
        return refusal_answer(&Refusal::validation(
            "No operation at this path takes X-Marfa-Reach.",
        ));
    }
    next.run(request).await
}

fn key_doors(app: Arc<App>) -> Routes {
    Router::new()
        .route("/keys", post(keys::mint).get(keys::list))
        .route("/keys/current", get(keys::current))
        .route("/keys/{id}", patch(keys::update).delete(keys::revoke))
        .route_layer(from_fn_with_state(app, keys::limited))
}

fn schema_doors() -> Routes {
    Router::new()
        .route("/types", get(types::list).post(types::register))
        .route("/types/normalize", post(types::normalize))
        .route(
            "/types/{id}",
            get(types::read).put(types::replace).delete(types::delete),
        )
        .route(
            "/types/{id}/icon",
            put(types::set_icon).delete(types::clear_icon),
        )
        .route("/platform-types/retired", get(types::retired))
        .route("/platform-types/{id}", delete(types::remove_retired))
        .route(
            "/edge-types",
            get(edge_types::list).post(edge_types::register),
        )
        .route("/edge-types/{id}", delete(edge_types::delete))
}

fn item_doors() -> Routes {
    Router::new()
        .route("/items", post(items::create))
        .route("/items/bulk-get", post(items::bulk_get))
        .route("/items/titles", post(items::titles))
        .route("/items/{id}", get(items::read).patch(items::update))
        .route("/items/{id}/versions", get(items::versions))
        .route(
            "/items/{id}/metadata",
            get(items::metadata).put(items::set_metadata),
        )
        .route("/items/{id}/tags", post(items::add_tags))
        .route("/items/{id}/tags/{tag}", delete(items::remove_tag))
        .route("/items/{id}/extensions", get(items::extensions))
        .route(
            "/items/{id}/extensions/{namespace}",
            get(items::extension)
                .put(items::set_extension)
                .delete(items::clear_extension),
        )
        .route("/metadata/tags", get(items::tags))
}

fn shared(app: Arc<App>) -> Routes {
    Router::new()
        .route("/", get(root::describe))
        .route("/health", get(health::answer))
        .route("/openapi.json", get(root::document))
        .route("/audit", get(audit::list))
        .route("/sources", get(sources::list))
        .route("/source", get(sources::read).patch(sources::update))
        .merge(schema_doors())
        .merge(key_doors(app))
        .merge(item_doors())
}

fn finished(routes: Routes, app: Arc<App>, transport: Transport) -> Router {
    let observed = Observed {
        app: app.clone(),
        transport,
    };
    routes
        .method_not_allowed_fallback(unmatched)
        .route_layer(from_fn_with_state(app.clone(), body::checked))
        .route_layer(from_fn(reach_where_taken))
        .route_layer(from_fn(remember_route))
        .fallback(unmatched)
        .layer(CatchPanicLayer::custom(panicked))
        .layer(from_fn_with_state(observed, observe_request))
        .with_state(app)
}

pub fn public(app: Arc<App>) -> Router {
    finished(shared(app.clone()), app, Transport::Http)
}

async fn no_store(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

pub fn control(app: Arc<App>) -> Router {
    let mut routes = shared(app.clone())
        .route("/_control/setup/status", get(control::setup_status))
        .route("/_control/setup/claim", post(control::setup_claim));
    if app.settings.start.test_hooks {
        routes = routes
            .route(
                "/_control/test/clock",
                get(test_hooks::read_clock).post(test_hooks::move_clock),
            )
            .route(
                "/_control/test/faults",
                get(test_hooks::read_faults)
                    .put(test_hooks::set_fault)
                    .delete(test_hooks::clear_faults),
            );
    }
    finished(routes, app, Transport::LocalSocket).layer(middleware::from_fn(no_store))
}

pub async fn serve_public(
    listener: TcpListener,
    app: Arc<App>,
    stop: impl Future<Output = ()> + Send + 'static,
) -> std::io::Result<()> {
    serve(listener, public(app).into_make_service())
        .with_graceful_shutdown(stop)
        .await
}

pub async fn serve_control(
    listener: UnixListener,
    app: Arc<App>,
    stop: impl Future<Output = ()> + Send + 'static,
) -> std::io::Result<()> {
    serve(listener, control(app).into_make_service())
        .with_graceful_shutdown(stop)
        .await
}
