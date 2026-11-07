//! `POST /auth/oauth2/revoke`. A token that is unknown, foreign or already
//! ended answers as a revoked one does, so the door tells nobody which it was.

use std::sync::Arc;

use serde_json::json;

use super::grant;
use super::store;
use super::token::{Form, checked_client};
use super::tokens::{looks_like_access_token, looks_like_refresh_token};
use super::{Answered, Problem};
use crate::app::App;
use crate::app::access::Caller;
use crate::app::audit::{self, Entry};
use crate::app::auth::Visit;
use crate::app::keys::digest_of;
use crate::app::refusal::Result;

const TOKEN_REVOKED: &str = "auth.credentials.revoked";
const GRANT_REVOKED: &str = "auth.grant.revoked";

pub async fn revoke(app: &Arc<App>, form: Form, visit: &Visit) -> Result<Answered<()>> {
    let Some(token) = form.get("token").map(str::to_string) else {
        return Ok(Err(Problem::new("invalid_request", "Name the token.")));
    };
    let client = match checked_client(app, &form).await? {
        Ok(client) => client,
        Err(problem) => return Ok(Err(problem)),
    };
    let digest = digest_of(&app.settings.start.api_key_salt, &token)?;
    let ip = visit.client_ip();
    if looks_like_access_token(&token) {
        app.write(&Caller::Server, TOKEN_REVOKED, move |unit| {
            let tx = unit.tx();
            let Some(found) = store::access_token_by_digest(tx, &digest)?
                .filter(|found| found.client_id == client.id)
            else {
                return Ok(());
            };
            store::delete_access_token(tx, &found.id)?;
            audit::record_from(
                tx,
                &unit.at,
                None,
                ip.as_deref(),
                Entry {
                    action: TOKEN_REVOKED,
                    resource_type: "oauth_client",
                    resource_id: Some(&client.id),
                    details: Some(json!({ "client_id": client.id, "user_id": found.user_id })),
                },
            )
        })
        .await?;
    } else if looks_like_refresh_token(&token) {
        let cache = app.catalog_handle();
        app.write(&Caller::Server, GRANT_REVOKED, move |unit| {
            let tx = unit.tx();
            let Some(found) = store::refresh_token_by_digest(tx, &digest)?.filter(|found| {
                found.client_id == client.id
                    && found.rotated_at.is_none()
                    && found.ended_at.is_none()
            }) else {
                return Ok(());
            };
            if !grant::end(unit, &cache, &client.id, &found.user_id)? {
                return Ok(());
            }
            audit::record_from(
                tx,
                &unit.at,
                None,
                ip.as_deref(),
                Entry {
                    action: GRANT_REVOKED,
                    resource_type: "oauth_grant",
                    resource_id: Some(&client.id),
                    details: Some(json!({ "client_id": client.id, "user_id": found.user_id })),
                },
            )
        })
        .await?;
    }
    Ok(Ok(()))
}
