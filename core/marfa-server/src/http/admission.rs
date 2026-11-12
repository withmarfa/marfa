//! Which credentials a group of doors takes. A credential a door ignores is none.

use std::sync::Arc;

use axum::extract::{Request, State};
use axum::http::{Extensions, HeaderMap};
use axum::middleware::Next;
use axum::response::Response;

use super::answer::refusal_answer;
use super::caller::{bears_token, identify, refused};
use super::observe::RequestContext;
use crate::app::App;
use crate::app::access::{Caller, unauthorized};
use crate::listener::Transport;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Admission {
    /// Every credential that verifies.
    Any,
    /// The local command holds no type map, so it is no credential here.
    Mapped,
    /// A token presented, or the private socket.
    Presented,
}

impl Admission {
    /// Whether a door of this group takes the credential a request presents.
    pub fn admits(self, caller: Option<&Caller>, headers: &HeaderMap, on_socket: bool) -> bool {
        match self {
            Admission::Any => true,
            Admission::Mapped => !matches!(caller, Some(Caller::Local(_))),
            Admission::Presented => on_socket || bears_token(headers),
        }
    }
}

pub fn on_socket(extensions: &Extensions) -> bool {
    extensions
        .get::<RequestContext>()
        .is_some_and(|context| context.transport == Transport::LocalSocket)
}

pub async fn admit(
    State((app, rule)): State<(Arc<App>, Admission)>,
    request: Request,
    next: Next,
) -> Response {
    let (mut parts, body) = request.into_parts();
    let caller = match rule {
        Admission::Presented => None,
        _ => identify(&mut parts, &app).await.ok().flatten(),
    };
    if !rule.admits(
        caller.as_ref(),
        &parts.headers,
        on_socket(&parts.extensions),
    ) {
        let refusal = match caller {
            None => refused(&parts),
            Some(_) => unauthorized(),
        };
        return refusal_answer(&refusal);
    }
    next.run(Request::from_parts(parts, body)).await
}
