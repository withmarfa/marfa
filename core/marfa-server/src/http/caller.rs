//! Who a request comes from. What that caller may do is decided in `access`.

use std::sync::Arc;

use axum::extract::{FromRequestParts, OptionalFromRequestParts};
use axum::http::header::{AUTHORIZATION, ORIGIN};
use axum::http::request::Parts;
use axum::http::{HeaderMap, HeaderValue, Method};

use super::admission::{Admission, on_socket};
use super::answer::Stopped;
use super::doors::Asks;
use super::auth::cookies;
use super::observe::RequestContext;
use crate::app::access::{self, Caller, unauthorized};
use crate::app::addresses::Address;
use crate::app::auth::{self, session};
use crate::app::oauth::{self, tokens};
use crate::app::refusal::{Code, Refusal, Result};
use crate::app::{App, keys};
use crate::listener::Transport;

#[derive(Clone)]
struct Identified(Result<Option<Caller>>);

/// The session a cookie named, read once whichever asks first.
#[derive(Clone)]
struct Named(Option<session::Session>);

/// The request bore a stored key past its `expires_at`, which this holds.
#[derive(Clone)]
struct Expired(String);

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

pub fn bears_token(headers: &HeaderMap) -> bool {
    matches!(presented(headers), Presented::Token(_))
}

/// A request that changes state on a cookie alone must have come from this
/// instance's own pages. A refused request has not used the session.
fn check_browser_request(parts: &Parts, address: &Address) -> Result<()> {
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

#[derive(Clone, Copy, PartialEq)]
enum Origin {
    Judged,
    LeftToTheDoor,
}

async fn owner_by_cookie(
    parts: &Parts,
    app: &Arc<App>,
    context: Option<&RequestContext>,
    origin: Origin,
) -> Result<Option<Caller>> {
    let address = app.addresses().sign_in();
    let Some(token) = cookies::session_token(&parts.headers, &address) else {
        return Ok(None);
    };
    let named = match parts.extensions.get::<Named>() {
        Some(Named(named)) => named.clone(),
        None => session::find(app, token).await?,
    };
    let Some(session) = named else {
        return Ok(None);
    };
    if !auth::carries_sessions(&address) {
        return Err(Refusal::new(
            Code::Forbidden,
            "Owner sign-in requires HTTPS, except on this machine.",
        ));
    }
    if origin == Origin::Judged {
        check_browser_request(parts, &address)?;
    }
    let Some(seen) = session::seen(app, session).await? else {
        return Ok(None);
    };
    if let Some(context) = context {
        let _ = context
            .notes
            .key_id
            .set(format!("owner:{}", seen.session.id));
        if seen.recorded {
            let _ = context
                .notes
                .renewal
                .set(cookies::session(&address, token)?);
        }
    }
    Ok(Some(Caller::Owner(Box::new(seen.session))))
}

async fn read_credential(parts: &mut Parts, app: &Arc<App>) -> Result<Option<Caller>> {
    let context = parts.extensions.get::<RequestContext>();
    let local = context.is_some_and(|context| context.transport == Transport::LocalSocket);
    let mut expired = None;
    let caller = match presented(&parts.headers) {
        Presented::Nothing if local => return Ok(Some(Caller::local())),
        Presented::Nothing => return Ok(None),
        Presented::Unreadable => return Ok(None),
        Presented::Token(token) if tokens::looks_like_access_token(token) => {
            oauth::authenticate(app, token).await?
        }
        Presented::Token(token) => match keys::authenticate(app, token).await? {
            keys::Presented::Live(key) => Some(Caller::Key(key)),
            keys::Presented::Expired(at) => {
                expired = Some(Expired(at));
                None
            }
            keys::Presented::Unknown => None,
        },
    };
    if let (Some(id), Some(context)) = (caller.as_ref().and_then(Caller::audit_id), context) {
        let _ = context.notes.key_id.set(id);
    }
    if let Some(expired) = expired {
        parts.extensions.insert(expired);
    }
    Ok(caller)
}

/// The form's door checks its origin. A request that presents a credential is no browser's.
pub async fn browser_owner(parts: &Parts, app: &Arc<App>) -> Result<Option<Caller>> {
    if !matches!(presented(&parts.headers), Presented::Nothing) {
        return Ok(None);
    }
    let context = parts.extensions.get::<RequestContext>();
    owner_by_cookie(parts, app, context, Origin::LeftToTheDoor).await
}

/// The live session a browser's cookie names, read without counting a use. A fault reads as none.
pub async fn browser_session(parts: &Parts, app: &Arc<App>) -> Option<session::Session> {
    if !matches!(presented(&parts.headers), Presented::Nothing) {
        return None;
    }
    let address = app.addresses().sign_in();
    let token = cookies::session_token(&parts.headers, &address)?;
    if !auth::carries_sessions(&address) {
        return None;
    }
    session::find(app, token).await.ok().flatten()
}

/// Only sign-in page routes may accept the owner's session cookie.
pub struct OnPage(pub Option<Caller>);

impl FromRequestParts<Arc<App>> for OnPage {
    type Rejection = Stopped;

    async fn from_request_parts(
        parts: &mut Parts,
        app: &Arc<App>,
    ) -> std::result::Result<OnPage, Stopped> {
        let context = parts.extensions.get::<RequestContext>();
        let local = context.is_some_and(|context| context.transport == Transport::LocalSocket);
        if local || !matches!(presented(&parts.headers), Presented::Nothing) {
            return Ok(OnPage(identify(parts, app).await?));
        }
        Ok(OnPage(
            owner_by_cookie(parts, app, context, Origin::Judged).await?,
        ))
    }
}

async fn names_session(parts: &mut Parts, app: &Arc<App>) -> Result<bool> {
    let address = app.addresses().sign_in();
    let Some(token) = cookies::session_token(&parts.headers, &address) else {
        return Ok(false);
    };
    let named = session::find(app, token).await?;
    let found = named.is_some();
    parts.extensions.insert(Named(named));
    Ok(found)
}

/// Whether a request presents what its door asks before the body is read. The door still
/// decides what the caller may do.
pub async fn presents(
    parts: &mut Parts,
    app: &Arc<App>,
    asks: Asks,
    admission: Option<Admission>,
) -> Result<()> {
    let socket = on_socket(&parts.extensions);
    let by_cookie = !socket && matches!(presented(&parts.headers), Presented::Nothing);
    match asks {
        Asks::Nothing => Ok(()),
        Asks::Session if by_cookie => match names_session(parts, app).await? {
            true => Ok(()),
            false => Err(unauthorized()),
        },
        Asks::Session | Asks::Credential => match identify(parts, app).await? {
            Some(caller)
                if admission
                    .is_none_or(|rule| rule.admits(Some(&caller), &parts.headers, socket)) =>
            {
                Ok(())
            }
            Some(_) => Err(unauthorized()),
            None if asks == Asks::Session => Err(unauthorized()),
            None => Err(refused(parts)),
        },
    }
}

/// What a door that needs a credential answers a request it found none on.
pub fn refused(parts: &Parts) -> Refusal {
    match parts.extensions.get::<Expired>() {
        Some(Expired(at)) => access::expired(at),
        None => unauthorized(),
    }
}

/// Read once however many layers ask. A credential that does not verify is nobody, on the
/// control socket too.
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
        match identify(parts, app).await? {
            Some(caller) => Ok(caller),
            None => Err(refused(parts).into()),
        }
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
