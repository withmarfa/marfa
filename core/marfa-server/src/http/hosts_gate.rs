//! A connector host's key reaches only the doors that ask for one.

use std::sync::Arc;

use axum::extract::{MatchedPath, Request, State};
use axum::middleware::Next;
use axum::response::Response;

use super::answer::refusal_answer;
use super::caller::{bears_token, identify};
use super::doors::{Asks, Credentials};
use crate::app::App;
use crate::app::refusal::{Code, Refusal};

#[derive(Clone)]
pub struct Gate {
    pub app: Arc<App>,
    pub credentials: Arc<Credentials>,
}

pub async fn kept(State(gate): State<Gate>, request: Request, next: Next) -> Response {
    if !bears_token(request.headers()) {
        return next.run(request).await;
    }
    let (mut parts, body) = request.into_parts();
    let asks = parts
        .extensions
        .get::<MatchedPath>()
        .and_then(|matched| {
            gate.credentials
                .get(&(parts.method.clone(), matched.as_str()))
        })
        .map(|(asks, _)| *asks);
    if asks != Some(Asks::Host)
        && let Ok(Some(caller)) = identify(&mut parts, &gate.app).await
        && caller.host_id().is_some()
    {
        return refusal_answer(&Refusal::new(
            Code::Forbidden,
            "A connector host's key reaches only GET /connector-hosts/self and POST /connector-hosts/self/connectors/{plugin}/key.",
        ));
    }
    next.run(Request::from_parts(parts, body)).await
}
