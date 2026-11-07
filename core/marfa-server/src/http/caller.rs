//! Who a request comes from. What that caller may do is decided in `access`.

use std::sync::Arc;

use axum::extract::{FromRequestParts, OptionalFromRequestParts};
use axum::http::header::{AUTHORIZATION, ORIGIN};
use axum::http::request::Parts;
use axum::http::{HeaderMap, HeaderValue, Method};

use super::answer::Stopped;
use super::auth::cookies;
use super::observe::{RequestContext, Transport};
use crate::app::access::{Caller, unauthorized};
use crate::app::addresses::Address;
use crate::app::auth::{self, session};
use crate::app::refusal::{Code, Refusal, Result};
use crate::app::{App, keys};

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

/// A request that changes state on a cookie alone must have come from this
/// instance's own pages, and the session must travel where a browser keeps it
/// safe. A refused request has not used the session.
fn check_browser_request(parts: &Parts, address: &Address) -> Result<()> {
    if !auth::carries_sessions(address) {
        return Err(Refusal::new(
            Code::Forbidden,
            "Owner sign-in requires HTTPS, except on this machine.",
        ));
    }
    let safe = matches!(parts.method, Method::GET | Method::HEAD | Method::OPTIONS);
    let own = parts
        .headers
        .get(ORIGIN)
        .is_some_and(|origin| origin.as_bytes() == address.origin().as_bytes());
    if safe || own {
        return Ok(());
    }
    Err(Refusal::new(
        Code::Forbidden,
        "Owner requests must come from this instance's origin",
    ))
}

async fn owner_by_cookie(
    parts: &Parts,
    app: &Arc<App>,
    context: Option<&RequestContext>,
) -> Result<Option<Caller>> {
    let address = app.addresses().sign_in();
    let Some(token) = cookies::session_token(&parts.headers, &address) else {
        return Ok(None);
    };
    let Some(session) = session::find(app, token).await? else {
        return Ok(None);
    };
    check_browser_request(parts, &address)?;
    let Some(seen) = session::seen(app, session).await? else {
        return Ok(None);
    };
    if let Some(context) = context {
        let _ = context
            .notes
            .key_id
            .set(format!("owner:{}", seen.session.id));
        if seen.recorded && seen.session.remembered {
            let _ = context
                .notes
                .renewal
                .set(cookies::session(&address, token, true)?);
        }
    }
    Ok(Some(Caller::Owner(Box::new(seen.session))))
}

async fn read_credential(parts: &Parts, app: &Arc<App>) -> Result<Option<Caller>> {
    let context = parts.extensions.get::<RequestContext>();
    let local = context.is_some_and(|context| context.transport == Transport::LocalSocket);
    let key = match presented(&parts.headers) {
        Presented::Nothing if local => return Ok(Some(Caller::Local)),
        Presented::Nothing => return owner_by_cookie(parts, app, context).await,
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
