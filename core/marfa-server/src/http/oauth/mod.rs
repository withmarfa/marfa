mod authorize;
mod device;
mod discovery;
mod grants;
mod origins;
mod token;

use std::sync::Arc;

use axum::Router;
use axum::extract::{FromRequestParts, Request};
use axum::http::request::Parts;
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::middleware::{Next, from_fn};
use axum::response::Response;
use axum::routing::{get, patch, post};

pub(super) use origins::page_origins;

use super::Routes;
use super::answer::{Answer, Stopped, json_answer};
use super::auth::origin::{self, Source};
use super::caller::browser_owner;
use super::no_store;
use crate::app::App;
use crate::app::access::Caller;
use crate::app::auth::form_origins;
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
    match origin::said_by_form(headers, &form_origins(app)) {
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

async fn any_origin(request: Request, next: Next) -> Response {
    let preflight = request.method() == Method::OPTIONS;
    let mut response = next.run(request).await;
    if !preflight {
        response.headers_mut().insert(
            header::ACCESS_CONTROL_ALLOW_ORIGIN,
            HeaderValue::from_static("*"),
        );
    }
    response
}

pub fn grant_doors() -> Routes {
    Router::new()
        .route("/auth/grants", get(grants::list))
        .route(
            "/auth/grants/{id}",
            patch(grants::narrow).delete(grants::revoke),
        )
        .route_layer(from_fn(no_store))
}

pub fn doors() -> Routes {
    let held = Router::new()
        .route("/auth/oauth2/authorize", get(authorize::begin))
        .route("/auth/authorize", get(authorize::screen))
        .route("/auth/authorize/decision", post(authorize::decide))
        .route("/auth/oauth2/token", post(token::exchange))
        .route("/auth/oauth2/revoke", post(token::revoke))
        .route("/auth/device/code", post(device::code))
        .route("/auth/device", post(device::enter))
        .route(
            "/auth/device/consent",
            get(device::screen).post(device::answer),
        )
        .route_layer(from_fn(no_store));
    let open = Router::new()
        .route(
            "/auth/oauth2/register",
            post(token::register)
                .options(token::register_preflight)
                .layer(from_fn(no_store)),
        )
        .route(
            "/.well-known/oauth-authorization-server/auth",
            get(discovery::authorization_server),
        )
        .route(
            "/auth/.well-known/oauth-authorization-server",
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
        .route_layer(from_fn(any_origin));
    held.merge(open)
}
