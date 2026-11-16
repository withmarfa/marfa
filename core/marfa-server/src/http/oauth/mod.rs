mod authorize;
mod device;
mod discovery;
mod grants;
mod token;

use std::sync::Arc;

use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use axum::http::{HeaderMap, StatusCode};
use axum::middleware::from_fn;

use super::Routes;
use super::answer::{Answer, Stopped, json_answer};
use super::auth::origin::{self, Source};
use super::caller::browser_owner;
use super::cors;
use super::doors::{Asks, Doors, get, patch, post};
use super::no_store;
use crate::app::App;
use crate::app::access::Caller;
use crate::app::auth::own_origins;
use crate::app::oauth::Problem;
use crate::app::oauth::offer::Post;
use crate::app::refusal::Refusal;

/// A cross-site form is refused before the session is read.
struct Browser(Option<Caller>);

impl FromRequestParts<Arc<App>> for Browser {
    type Rejection = Stopped;

    async fn from_request_parts(parts: &mut Parts, app: &Arc<App>) -> Result<Browser, Stopped> {
        if !parts.method.is_safe() {
            require_own_form(app, &parts.headers)?;
        }
        Ok(Browser(browser_owner(parts, app).await?))
    }
}

fn problem_answer(problem: &Problem) -> Answer {
    let status = StatusCode::from_u16(problem.status)
        .map_err(|_| Refusal::internal("a refusal had no status"))?;
    Ok(json_answer(status, &problem.to_json()))
}

/// A post that names no origin came from no page, so it is let through.
fn require_own_form(app: &App, headers: &HeaderMap) -> Result<(), Refusal> {
    match origin::said_by_form(headers, &own_origins(app)) {
        Source::Elsewhere => Err(origin::not_our_page()),
        Source::Own | Source::Unsaid => Ok(()),
    }
}

struct Fields(Vec<(String, String)>);

impl Fields {
    fn get(&self, name: &str) -> Option<&str> {
        self.0
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }

    fn all(&self, name: &str) -> Vec<String> {
        self.0
            .iter()
            .filter(|(key, _)| key == name)
            .map(|(_, value)| value.clone())
            .collect()
    }

    fn post(&self) -> Post {
        Post {
            access: self.get("access").map(str::to_string),
            scopes: self.all("scopes"),
            types: self.all("types"),
        }
    }
}

pub fn grant_doors() -> Routes {
    Doors::new()
        .route("/grants", get(grants::list))
        .route("/grants/{id}", patch(grants::narrow).delete(grants::revoke))
        .route_layer(from_fn(no_store))
}

pub fn doors() -> Routes {
    let held = Doors::new()
        .route("/oauth/authorize", get(authorize::begin))
        .route(
            "/auth/consent",
            get(authorize::screen).post(authorize::decide),
        )
        .route("/oauth/token", post(token::exchange))
        .route("/oauth/revoke", post(token::revoke))
        .route("/oauth/device-authorization", post(device::code))
        .route("/auth/device", post(device::enter))
        .route(
            "/auth/device/consent",
            get(device::screen).post(device::answer),
        )
        .route_layer(from_fn(no_store));
    let open = Doors::new()
        .route(
            "/oauth/register",
            post(token::register)
                .options(cors::register_preflight)
                .layer(from_fn(no_store)),
        )
        .route(
            "/.well-known/oauth-authorization-server",
            get(discovery::authorization_server),
        )
        .route(
            "/.well-known/oauth-protected-resource",
            get(discovery::protected_resource),
        )
        .route(
            "/.well-known/oauth-protected-resource/{*path}",
            get(discovery::protected_resource_at),
        )
        .route_layer(from_fn(cors::every_origin));
    held.merge(open).asking(Asks::Nothing)
}
