//! The only place that names axum.

pub mod answer;
mod audit;
mod auth;
mod blobs;
pub mod body;
mod bulk;
pub mod caller;
mod caller_address;
mod compression;
mod conditional;
mod config;
mod control;
#[cfg(test)]
mod document;
mod doors;
mod edge_types;
mod edges;
mod events;
mod folders;
mod health;
mod housekeeping;
mod items;
mod keys;
pub mod listening;
mod listing;
mod lookup;
mod oauth;
pub mod observe;
pub mod pages;
mod profile;
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
use axum::extract::{Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::middleware::{self, Next, from_fn, from_fn_with_state};
use axum::response::Response;
use tower_http::catch_panic::CatchPanicLayer;

use crate::app::App;
use crate::app::access::{Caller, unauthorized};
use crate::app::refusal::{Code, Refusal};
use crate::listener::Declaration;
use answer::{panicked, refusal_answer};
use caller::identify;
pub use listening::serve;
use observe::{Observed, Unmatched, observe as observe_request, remember_route};

use doors::{Doors, delete, get, patch, post, put};

type Routes = Doors;

async fn unmatched(method: Method, headers: HeaderMap) -> Response {
    let mut response = if method == Method::OPTIONS {
        let mut empty = Response::new(Body::empty());
        *empty.status_mut() = StatusCode::NO_CONTENT;
        empty
    } else if method == Method::GET && headers.contains_key(conditional::REACH_HEADER) {
        refusal_answer(&Refusal::validation(
            "No operation at this path takes X-Marfa-Reach.",
        ))
    } else {
        refusal_answer(&Refusal::new(Code::NotFound, "Not found"))
    };
    response.extensions_mut().insert(Unmatched);
    response
}

fn key_doors(app: Arc<App>) -> Routes {
    Doors::new()
        .route("/keys", post(keys::mint).get(keys::list))
        .route("/keys/current", get(keys::current))
        .route("/keys/{id}", patch(keys::update).delete(keys::revoke))
        .route_layer(from_fn_with_state(app, keys::limited))
}

fn schema_doors() -> Routes {
    Doors::new()
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

/// The instance's own authority, a browser's or the local command's, holds no
/// type map, and every content door answers within one.
async fn within_a_map(State(app): State<Arc<App>>, request: Request, next: Next) -> Response {
    let (mut parts, body) = request.into_parts();
    if matches!(
        identify(&mut parts, &app).await,
        Ok(Some(Caller::Local(_) | Caller::Owner(_)))
    ) {
        return refusal_answer(&unauthorized());
    }
    next.run(Request::from_parts(parts, body)).await
}

/// Counts admit a browser's session and no local command.
async fn not_local(State(app): State<Arc<App>>, request: Request, next: Next) -> Response {
    let (mut parts, body) = request.into_parts();
    if matches!(identify(&mut parts, &app).await, Ok(Some(Caller::Local(_)))) {
        return refusal_answer(&unauthorized());
    }
    next.run(Request::from_parts(parts, body)).await
}

fn count_doors(app: Arc<App>) -> Routes {
    Doors::new()
        .route("/items/stats", get(listing::stats))
        .route_layer(from_fn_with_state(app, not_local))
}

fn item_doors(app: Arc<App>) -> Routes {
    Doors::new()
        .route("/items", post(items::create).get(listing::items))
        .route("/search", get(listing::search))
        .route("/events", get(events::open))
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

fn folder_doors() -> Routes {
    Doors::new()
        .route("/folders", post(folders::create).get(folders::inventory))
        .route("/folders/{id}", patch(folders::update))
        .route("/folders/{id}/revoke", post(folders::revoke))
        .route(
            "/folders/{id}/status",
            put(folders::report).get(folders::status),
        )
}

fn blob_doors() -> Routes {
    Doors::new()
        .route("/blobs", post(blobs::upload))
        .route("/blobs/stores", get(blobs::stores))
        .route("/blobs/{hash}", get(blobs::download).head(blobs::head))
        .route("/blobs/{hash}/url", get(blobs::url))
        .route("/blobs/{hash}/copies", get(blobs::copies))
        .route(
            "/blobs/{hash}/fetch",
            get(blobs::fetch).head(blobs::fetch_head),
        )
}

fn owner_item_doors() -> Routes {
    Doors::new()
        .route("/items/summaries", get(trash::summaries))
        .route("/items/summaries/{id}/trash", post(trash::owner_trash))
        .route("/items/summaries/{id}/restore", post(trash::owner_restore))
        .route("/items/summaries/{id}/purge", post(trash::owner_purge))
        .route("/trash", get(trash::bin))
        .route("/trash/empty", post(trash::empty))
}

fn profile_doors() -> Routes {
    Doors::new()
        .route("/owner/picture", get(profile::read).put(profile::put_owner))
        .route("/profile", patch(profile::update))
        .route("/profile/picture", put(profile::put_profile))
}

fn config_doors() -> Routes {
    Doors::new()
        .route(
            "/config",
            get(config::read).put(config::put).patch(config::patch),
        )
        .route("/config/address-check", post(config::address_check))
        .route("/config/settings", get(config::settings))
}

fn shared(app: Arc<App>) -> Routes {
    Doors::new()
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
        .merge(item_doors(app.clone()))
        .merge(folder_doors())
        .merge(blob_doors())
        .merge(count_doors(app))
        .merge(owner_item_doors())
        .merge(auth::owner_doors())
        .merge(profile_doors())
        .merge(oauth::grant_doors())
        .merge(config_doors())
}

fn finished(routes: Routes, app: Arc<App>, listener: Declaration) -> Router {
    let observed = Observed {
        app: app.clone(),
        listener: Arc::new(listener),
    };
    let router = routes
        .into_router()
        .method_not_allowed_fallback(unmatched)
        .route_layer(from_fn_with_state(app.clone(), body::checked))
        .route_layer(from_fn_with_state(app.clone(), conditional::judged))
        .route_layer(from_fn(remember_route))
        .fallback(unmatched)
        .layer(CatchPanicLayer::custom(panicked))
        .layer(from_fn_with_state(observed, observe_request))
        .with_state(app);
    compression::gzip_json(router)
}

pub fn public(app: Arc<App>) -> Router {
    let listener = app.settings.start.public_listener.clone();
    public_on(app, listener)
}

fn public_doors(app: Arc<App>) -> Routes {
    shared(app).merge(auth::doors()).merge(oauth::doors())
}

pub fn public_on(app: Arc<App>, listener: Declaration) -> Router {
    finished(public_doors(app.clone()), app.clone(), listener)
        .layer(from_fn_with_state(app, oauth::page_origins))
}

pub(crate) async fn no_store(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

fn control_doors(app: &Arc<App>) -> Routes {
    let mut routes = shared(app.clone())
        .route("/_control/setup/status", get(control::setup_status))
        .route("/_control/setup/claim", post(control::setup_claim))
        .route("/_control/setup/code", post(control::setup_code))
        .route("/_control/setup/ticket", post(control::setup_ticket))
        .route("/_control/owner/recover", post(control::recover_owner))
        .route(
            "/_control/owner/passkeys/add-url",
            get(auth::passkeys::add_url),
        );
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
    routes
}

pub fn control(app: Arc<App>) -> Router {
    finished(control_doors(&app), app, Declaration::control())
        .layer(middleware::from_fn(no_store))
        .layer(from_fn_with_state(
            body::CONTROL_BODY_DEADLINE,
            body::due_within,
        ))
}
