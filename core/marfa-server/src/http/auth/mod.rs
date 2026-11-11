pub mod cookies;
pub(super) mod origin;
mod owner;
mod pages;
pub mod passkeys;
mod setup;
mod sign_in;
mod sign_ins;

use std::convert::Infallible;
use std::sync::Arc;

use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use axum::http::{HeaderValue, StatusCode, header};
use axum::middleware::from_fn;
use axum::response::Response;
use serde_json::{Map, Value};

use super::Routes;
use super::answer::Stopped;
use super::doors::{Doors, get, patch, post};
use super::no_store;
use super::observe::RequestContext;
use crate::app::App;
use crate::app::auth::{Visit, carries_sessions, require_set_address};
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
        let context = parts.extensions.get::<RequestContext>();
        Ok(Visit {
            peer: context.and_then(|context| context.peer),
            address: context.and_then(|context| context.caller_address),
            user_agent,
        })
    }
}

pub(super) fn redirect(status: StatusCode, location: &str) -> Result<Response, Stopped> {
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

fn require_safe_transport(app: &App) -> Result<(), Refusal> {
    if carries_sessions(&app.addresses().sign_in()) {
        return Ok(());
    }
    Err(Refusal::new(
        Code::Forbidden,
        "Owner setup and sign-in require HTTPS, except on this machine.",
    ))
}

fn require_safe_caller(app: &App, visit: &Visit) -> Result<(), Refusal> {
    require_safe_transport(app)?;
    require_set_address(app, visit)
}

fn text_field<'b>(body: &'b Map<String, Value>, field: &str) -> Result<&'b str, Refusal> {
    body.get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| Refusal::validation(format!("Provide `{field}` as text.")))
}

pub fn owner_doors() -> Routes {
    Doors::new()
        .route(
            "/owner",
            get(owner::read).post(owner::claim).patch(owner::update),
        )
        .route("/owner/passkeys", get(passkeys::list))
        .route(
            "/owner/passkeys/{id}",
            patch(passkeys::rename).delete(passkeys::remove),
        )
        .route("/owner/sign-ins", get(sign_ins::list))
        .route(
            "/owner/sign-ins/{id}",
            patch(sign_ins::rename).delete(sign_ins::end),
        )
        .route_layer(from_fn(no_store))
}

pub fn doors() -> Routes {
    Doors::new()
        .route("/auth/sign-in", get(pages::sign_in).post(sign_in::sign_in))
        .route("/auth/error", get(pages::error))
        .route("/auth/device", get(pages::device))
        .route("/setup", get(pages::setup))
        .route("/auth/sign-out", post(sign_in::sign_out))
        .route("/auth/confirm", post(sign_in::confirm))
        .route(
            "/auth/passkeys/registration/options",
            post(passkeys::registration_options),
        )
        .route("/auth/passkeys/registration", post(passkeys::register))
        .route(
            "/auth/passkeys/sign-in/options",
            post(passkeys::sign_in_options),
        )
        .route("/auth/passkeys/sign-in", post(passkeys::sign_in))
        .route("/auth/owner/passkeys", get(passkeys::page))
        .route("/setup/exchange", post(setup::exchange))
        .route("/setup/claim", post(setup::claim))
        .route_layer(from_fn(no_store))
}
