//! A tool's answer to an app whose owner did not sign in recently enough for what it asked.

use crate::app::App;
use crate::app::access::Caller;
use crate::app::oauth::store;
use crate::app::refusal::{Code, Refusal};
use crate::db::Write;
use crate::http::mcp::results::Stop;

const SIGN_IN_AGAIN: &str = "Ask the person to sign in to this app's connection again (re-authenticate it, not only reconnect): Marfa asks them to sign in, and the new connection may make this change. Nothing changed.";

/// Marks the app's renewal when the refusal is a step-up challenge.
pub async fn refused(app: &App, caller: &Caller, refusal: Refusal) -> Stop {
    if refusal.code != Code::InsufficientUserAuthentication {
        return refusal.into();
    }
    ask_sign_in_again(app, caller).await;
    Stop::refused(refusal).with("next", SIGN_IN_AGAIN)
}

/// An MCP client cannot follow a challenge with `max_age`, so the app's next authorization asks
/// for a sign-in made after this refusal instead.
async fn ask_sign_in_again(app: &App, caller: &Caller) {
    let Caller::App { grant, .. } = caller else {
        return;
    };
    let (client_id, owner_id) = (grant.client_id.clone(), grant.owner_id.clone());
    let signed_in = grant.authenticated_at;
    let clock = app.clock.clone();
    let asked = app
        .db
        .write(Write::own(), move |tx| {
            store::ask_login_after(tx, &client_id, &owner_id, signed_in, clock.instant())
        })
        .await;
    if let Err(refused) = asked {
        tracing::warn!(
            code = refused.code.wire(),
            "The app's sign-in could not be marked for renewal"
        );
    }
}
