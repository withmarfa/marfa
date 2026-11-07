//! The only place that names axum.

pub mod answer;
mod audit;
pub mod body;
mod bulk;
mod caller;
mod caller_address;
mod config;
mod control;
mod edge_types;
mod edges;
mod health;
mod housekeeping;
mod items;
mod keys;
pub mod listening;
mod listing;
mod lookup;
pub mod observe;
mod page;
mod query;
mod root;
mod sources;
mod test_hooks;
mod trash;
mod types;
mod views;

use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::extract::{MatchedPath, Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::middleware::{self, Next, from_fn, from_fn_with_state};
use axum::response::Response;
use axum::routing::{delete, get, patch, post, put};
use tower_http::catch_panic::CatchPanicLayer;

use crate::app::App;
use crate::app::access::{Caller, unauthorized};
use crate::app::refusal::{Code, Refusal};
use crate::listener::Declaration;
use answer::{panicked, refusal_answer};
use caller::identify;
pub use listening::serve;
use observe::{Observed, Unmatched, observe as observe_request, remember_route};

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

/// The instance's own authority holds no type map, and every content door
/// answers within one.
async fn within_a_map(State(app): State<Arc<App>>, request: Request, next: Next) -> Response {
    let (mut parts, body) = request.into_parts();
    if matches!(identify(&mut parts, &app).await, Ok(Some(Caller::Local))) {
        return refusal_answer(&unauthorized());
    }
    next.run(Request::from_parts(parts, body)).await
}

fn item_doors(app: Arc<App>) -> Routes {
    Router::new()
        .route("/items", post(items::create).get(listing::items))
        .route("/items/stats", get(listing::stats))
        .route("/search", get(listing::search))
        .route("/views", post(views::create))
        .route("/views/{id}", patch(views::update).delete(views::delete))
        .route("/views/{id}/items", get(views::items))
        .route("/items/bulk", post(bulk::write))
        .route("/items/bulk-get", post(items::bulk_get))
        .route("/items/titles", post(items::titles))
        .route("/items/lookup", post(lookup::lookup))
        .route("/items/tombstones", post(lookup::settle))
        .route("/items/trash", post(trash::trash))
        .route("/items/trash-preview", post(trash::preview))
        .route(
            "/items/{id}",
            get(items::read).patch(items::update).delete(trash::delete),
        )
        .route("/items/{id}/transition", post(trash::transition))
        .route("/items/{id}/restore", post(trash::restore))
        .route("/items/{id}/purge", post(trash::purge))
        .route("/items/{id}/versions", get(items::versions))
        .route("/items/{id}/edges", get(edges::outbound))
        .route("/items/{id}/backrefs", get(edges::backrefs))
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
        .route("/edges", post(edges::create).get(edges::list))
        .route("/edges/bulk", post(edges::write_page))
        .route(
            "/edges/{id}",
            get(edges::read).patch(edges::update).delete(edges::delete),
        )
        .route_layer(from_fn_with_state(app, within_a_map))
}

/// The doors the instance's own authority reaches by the name of an item,
/// never its content.
fn owner_item_doors() -> Routes {
    Router::new()
        .route("/items/summaries", get(trash::summaries))
        .route("/items/summaries/{id}/trash", post(trash::owner_trash))
        .route("/items/summaries/{id}/restore", post(trash::owner_restore))
        .route("/items/summaries/{id}/purge", post(trash::owner_purge))
        .route("/trash", get(trash::bin))
        .route("/trash/empty", post(trash::empty))
}

fn config_doors() -> Routes {
    Router::new()
        .route(
            "/config",
            get(config::read).put(config::put).patch(config::patch),
        )
        .route("/config/address-check", post(config::address_check))
        .route("/config/settings", get(config::settings))
}

fn shared(app: Arc<App>) -> Routes {
    Router::new()
        .route("/", get(root::describe))
        .route("/health", get(health::answer))
        .route("/openapi.json", get(root::document))
        .route("/audit", get(audit::list))
        .route("/housekeeping", get(housekeeping::list))
        .route("/housekeeping/{name}/run", post(housekeeping::run))
        .route("/sources", get(sources::list))
        .route("/source", get(sources::read).patch(sources::update))
        .merge(schema_doors())
        .merge(key_doors(app.clone()))
        .merge(item_doors(app))
        .merge(owner_item_doors())
        .merge(config_doors())
}

fn finished(routes: Routes, app: Arc<App>, listener: Declaration) -> Router {
    let observed = Observed {
        app: app.clone(),
        listener: Arc::new(listener),
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
    let listener = app.settings.start.public_listener.clone();
    public_on(app, listener)
}

/// The public doors, for a listener that declares itself.
pub fn public_on(app: Arc<App>, listener: Declaration) -> Router {
    finished(shared(app.clone()), app, listener)
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
    finished(routes, app, Declaration::control()).layer(middleware::from_fn(no_store))
}
