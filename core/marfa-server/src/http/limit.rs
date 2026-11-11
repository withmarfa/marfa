//! The general limit: one allowance for each key or app, across every operation it calls.

use std::sync::Arc;

use axum::extract::{Request, State};
use axum::middleware::Next;
use axum::response::Response;

use super::answer::refusal_answer;
use super::caller::{bears_token, identify};
use crate::app::App;
use crate::app::access::Caller;
use crate::app::limiter::{Lane, REQUESTS, retry_seconds};
use crate::app::refusal::{Code, Refusal};
use crate::settings::registry::{RATE_LIMIT_ENABLED, RATE_LIMIT_REQUESTS};

pub async fn requests(State(app): State<Arc<App>>, request: Request, next: Next) -> Response {
    let live = app.settings.live();
    if !live.get(RATE_LIMIT_ENABLED) || !bears_token(request.headers()) {
        return next.run(request).await;
    }
    let (mut parts, body) = request.into_parts();
    let wait = match identify(&mut parts, &app).await {
        Ok(Some(caller @ (Caller::Key(_) | Caller::App { .. }))) => {
            let lane = Lane::credential(
                REQUESTS,
                &caller.credential_handle(),
                live.get(RATE_LIMIT_REQUESTS),
                live.rate_limit_window_ms(),
            );
            app.limiter.admit(app.clock.now_ms(), &[lane])
        }
        _ => None,
    };
    match wait {
        Some(wait) => refusal_answer(
            &Refusal::new(
                Code::RateLimited,
                "Too many requests from this credential; try again later.",
            )
            .with_detail("retry_after", retry_seconds(wait)),
        ),
        None => next.run(Request::from_parts(parts, body)).await,
    }
}
