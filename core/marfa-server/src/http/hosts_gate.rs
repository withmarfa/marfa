//! A connector host's key reaches only the doors that ask for one; elsewhere it is no credential.

use std::sync::Arc;

use axum::extract::{MatchedPath, Request, State};
use axum::middleware::Next;
use axum::response::Response;

use super::answer::refusal_answer;
use super::caller::bearer;
use super::doors::{Asks, Credentials};
use crate::app::App;
use crate::app::access::unauthorized;
use crate::app::keys;

#[derive(Clone)]
pub struct Gate {
    pub app: Arc<App>,
    pub credentials: Arc<Credentials>,
}

pub async fn kept(State(gate): State<Gate>, request: Request, next: Next) -> Response {
    let Some(token) = bearer(request.headers()) else {
        return next.run(request).await;
    };
    let asks = request
        .extensions()
        .get::<MatchedPath>()
        .and_then(|matched| {
            gate.credentials
                .get(&(request.method().clone(), matched.as_str()))
        })
        .map(|(asks, _)| *asks);
    // Read without counting a use, so a door that reads no key never marks one used.
    if asks != Some(Asks::Host) && keys::is_host_key(&gate.app, token).await.unwrap_or(false) {
        return refusal_answer(&unauthorized());
    }
    next.run(request).await
}
