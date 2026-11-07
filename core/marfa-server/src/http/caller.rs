//! Who a request comes from. What that caller may do is decided in `access`.

use std::sync::Arc;

use axum::extract::{FromRequestParts, OptionalFromRequestParts};
use axum::http::header::AUTHORIZATION;
use axum::http::request::Parts;
use axum::http::{HeaderMap, HeaderValue};

use super::answer::Stopped;
use super::observe::{RequestContext, Transport};
use crate::app::App;
use crate::app::access::{Caller, unauthorized};
use crate::app::keys;
use crate::app::refusal::Result;

#[derive(Clone)]
struct Identified(Result<Option<Caller>>);

enum Presented<'a> {
    Nothing,
    Token(&'a str),
    Unreadable,
}

fn token_in(value: &HeaderValue) -> Option<&str> {
    let (scheme, token) = value.to_str().ok()?.trim().split_once(' ')?;
    let token = token.trim();
    (scheme.eq_ignore_ascii_case("bearer") && !token.is_empty()).then_some(token)
}

fn presented(headers: &HeaderMap) -> Presented<'_> {
    let mut values = headers.get_all(AUTHORIZATION).iter();
    match (values.next(), values.next()) {
        (None, _) => Presented::Nothing,
        (Some(value), None) => token_in(value).map_or(Presented::Unreadable, Presented::Token),
        (Some(_), Some(_)) => Presented::Unreadable,
    }
}

async fn read_credential(parts: &Parts, app: &Arc<App>) -> Result<Option<Caller>> {
    let context = parts.extensions.get::<RequestContext>();
    let local = context.is_some_and(|context| context.transport == Transport::LocalSocket);
    let key = match presented(&parts.headers) {
        Presented::Nothing => return Ok(local.then_some(Caller::Local)),
        Presented::Unreadable => return Ok(None),
        Presented::Token(token) => keys::authenticate(app, token).await?,
    };
    if let (Some(key), Some(context)) = (&key, context) {
        let _ = context.notes.key_id.set(key.id.clone());
    }
    Ok(key.map(|key| Caller::Key(Box::new(key))))
}

/// The request's caller, read once however many layers ask. A credential
/// that does not verify is nobody, on the control socket too.
pub async fn identify(parts: &mut Parts, app: &Arc<App>) -> Result<Option<Caller>> {
    if let Some(Identified(known)) = parts.extensions.get::<Identified>() {
        return known.clone();
    }
    let found = read_credential(parts, app).await;
    parts.extensions.insert(Identified(found.clone()));
    found
}

impl FromRequestParts<Arc<App>> for Caller {
    type Rejection = Stopped;

    async fn from_request_parts(
        parts: &mut Parts,
        app: &Arc<App>,
    ) -> std::result::Result<Caller, Stopped> {
        identify(parts, app)
            .await?
            .ok_or_else(|| unauthorized().into())
    }
}

impl OptionalFromRequestParts<Arc<App>> for Caller {
    type Rejection = Stopped;

    /// An open door answers whatever the credential's state, so a credential
    /// it could not check counts for nothing.
    async fn from_request_parts(
        parts: &mut Parts,
        app: &Arc<App>,
    ) -> std::result::Result<Option<Caller>, Stopped> {
        Ok(identify(parts, app).await.unwrap_or(None))
    }
}
