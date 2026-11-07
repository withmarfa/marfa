//! Who is asking: a key named by `Authorization: Bearer`, the private local
//! command on the control socket, or nobody.

use axum::extract::FromRequestParts;
use axum::http::header::AUTHORIZATION;
use axum::http::request::Parts;
use std::sync::Arc;

use super::answer::Stopped;
use super::observe::{RequestContext, Transport};
use crate::app::App;
use crate::app::keys::{self, Key};

pub enum Caller {
    Local,
    Key(Box<Key>),
    Nobody,
}

fn bearer(parts: &Parts) -> Option<&str> {
    let value = parts.headers.get(AUTHORIZATION)?.to_str().ok()?.trim();
    let (scheme, token) = value.split_once(' ')?;
    let token = token.trim();
    (scheme.eq_ignore_ascii_case("bearer") && !token.is_empty()).then_some(token)
}

impl FromRequestParts<Arc<App>> for Caller {
    type Rejection = Stopped;

    /// A credential that cannot be verified makes nobody of its bearer, on
    /// an open door. A door that needs one refuses that itself.
    async fn from_request_parts(parts: &mut Parts, app: &Arc<App>) -> Result<Caller, Stopped> {
        let context = parts.extensions.get::<RequestContext>().cloned();
        let local = context
            .as_ref()
            .is_some_and(|context| context.transport == Transport::LocalSocket);
        let Some(token) = bearer(parts) else {
            return Ok(if local { Caller::Local } else { Caller::Nobody });
        };
        let Ok(Some(key)) = keys::authenticate(app, token).await else {
            return Ok(Caller::Nobody);
        };
        if let Some(context) = context {
            let _ = context.notes.key_id.set(key.id.clone());
        }
        Ok(Caller::Key(Box::new(key)))
    }
}
