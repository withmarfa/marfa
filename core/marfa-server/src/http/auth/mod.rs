//! The doors of signing in, of setup and of the owner.

pub mod cookies;
mod origin;
mod owner;
mod pages;
mod setup;
mod sign_in;

use std::convert::Infallible;
use std::sync::Arc;

use axum::Router;
use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use axum::http::{HeaderValue, StatusCode, header};
use axum::middleware::from_fn;
use axum::response::Response;
use axum::routing::{get, post};
use serde_json::{Map, Value};

use super::Routes;
use super::answer::Stopped;
use super::no_store;
use super::observe::RequestContext;
use crate::app::App;
use crate::app::auth::{Visit, carries_sessions};
use crate::app::refusal::{Code, Refusal};

const USER_AGENT_CHARS: usize = 512;

impl FromRequestParts<Arc<App>> for Visit {
    type Rejection = Infallible;

    async fn from_request_parts(parts: &mut Parts, _: &Arc<App>) -> Result<Visit, Infallible> {
        let user_agent = parts
            .headers
            .get(header::USER_AGENT)
            .and_then(|value| value.to_str().ok())
            .map(|value| value.chars().take(USER_AGENT_CHARS).collect());
        let address = parts
            .extensions
            .get::<RequestContext>()
            .and_then(|context| context.caller_address);
        Ok(Visit {
            address,
            user_agent,
        })
    }
}

fn redirect(status: StatusCode, location: &str) -> Result<Response, Stopped> {
    let location = HeaderValue::from_str(location)
        .map_err(|_| Refusal::internal("a redirect did not form"))?;
    let mut response = Response::new(axum::body::Body::empty());
    *response.status_mut() = status;
    response.headers_mut().insert(header::LOCATION, location);
    Ok(response)
}

fn with_cookie(mut response: Response, cookie: HeaderValue) -> Response {
    response.headers_mut().append(header::SET_COOKIE, cookie);
    response
}

/// Refuses a door a browser could only use unsafely at this address.
fn require_safe_transport(app: &App) -> Result<(), Refusal> {
    if carries_sessions(&app.addresses().sign_in()) {
        return Ok(());
    }
    Err(Refusal::new(
        Code::Forbidden,
        "Owner setup and sign-in require HTTPS, except on this machine.",
    ))
}

/// A field a door requires as text.
fn text_field<'b>(body: &'b Map<String, Value>, field: &str) -> Result<&'b str, Refusal> {
    body.get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| Refusal::validation(format!("Provide `{field}` as text.")))
}

/// The doors of the owner, on the public and the private socket.
pub fn owner_doors() -> Routes {
    Router::new()
        .route(
            "/owner",
            get(owner::read).post(owner::claim).patch(owner::update),
        )
        .route_layer(from_fn(no_store))
}

/// The doors a browser signs in and sets up through.
pub fn doors() -> Routes {
    Router::new()
        .route("/auth/sign-in", get(pages::sign_in).post(sign_in::form))
        .route("/auth/error", get(pages::error))
        .route("/auth/device", get(pages::device))
        .route("/setup", get(pages::setup))
        .route("/auth/sign-in/email", post(sign_in::email))
        .route("/auth/get-session", get(sign_in::get_session))
        .route("/auth/sign-out", post(sign_in::sign_out))
        .route("/auth/change-password", post(sign_in::change_password))
        .route("/auth/revoke-sessions", post(sign_in::revoke_sessions))
        .route(
            "/auth/revoke-other-sessions",
            post(sign_in::revoke_other_sessions),
        )
        .route("/auth/confirm", post(sign_in::confirm))
        .route("/setup/exchange", post(setup::exchange))
        .route("/setup/claim", post(setup::claim))
        .route_layer(from_fn(no_store))
}
