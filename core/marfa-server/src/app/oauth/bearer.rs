use std::sync::Arc;

use rusqlite::Connection;

use super::grants;
use super::scope::to_grants;
use super::store::{self, AccessToken, Consent, ms_of};
use crate::app::App;
use crate::app::access::{Caller, OwnLevers, Standing};
use crate::app::keys::{Key, digest_of, queue_use};
use crate::app::refusal::Result;

const DEFAULT_TIER: &str = "library";
const USE_EVERY_MS: i64 = 60_000;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Granted {
    pub client_id: String,
    pub user_id: String,
    /// The `system.connection` item the grant is shown as.
    pub grant_id: String,
}

/// A token's own scopes are what it reaches, which may be fewer than its grant holds.
fn caller_of(tx: &Connection, token: AccessToken, now: i64) -> Result<Option<(Caller, Consent)>> {
    if token.expires_at <= now {
        return Ok(None);
    }
    let consent = store::consent(tx, &token.client_id, &token.user_id)?;
    let (Some(consent), Some(client)) = (
        consent.filter(Consent::stands),
        store::client(tx, &token.client_id)?,
    ) else {
        return Ok(None);
    };
    let key = Key {
        label: client.name(),
        source: grants::source_of(&token.client_id, &token.user_id),
        default_tier: DEFAULT_TIER.to_string(),
        oauth_client_id: Some(token.client_id.clone()),
        grants: to_grants(&token.scopes),
        levers: OwnLevers::Unset,
        standing: Standing::default(),
        created_at: store::stamp_of(token.created_at),
        expires_at: None,
        last_used_at: None,
        id: token.id,
    };
    let grant = Granted {
        client_id: token.client_id,
        user_id: token.user_id,
        grant_id: consent.grant_id.clone(),
    };
    Ok(Some((
        Caller::App {
            key: Box::new(key),
            grant: Box::new(grant),
        },
        consent,
    )))
}

pub fn live_by_id(tx: &Connection, id: &str, at: &str) -> Result<Option<Caller>> {
    let Some(token) = store::access_token_by_id(tx, id)? else {
        return Ok(None);
    };
    Ok(caller_of(tx, token, ms_of(at)?)?.map(|(caller, _)| caller))
}

pub async fn authenticate(app: &Arc<App>, token: &str) -> Result<Option<Caller>> {
    if !super::tokens::looks_like_access_token(token) {
        return Ok(None);
    }
    let digest = digest_of(&app.settings.start.key_salt, token)?;
    let now = app.clock.now_ms();
    let found = app
        .db
        .read(move |tx| {
            let Some(token) = store::access_token_by_digest(tx, &digest)? else {
                return Ok(None);
            };
            caller_of(tx, token, now)
        })
        .await?;
    let Some((caller, consent)) = found else {
        return Ok(None);
    };
    let due = consent
        .last_used_at
        .is_none_or(|last| last <= now - USE_EVERY_MS);
    if due {
        let client_id = consent.client_id;
        let user_id = consent.user_id;
        queue_use(app, &consent.grant_id, move |tx| {
            store::note_consent_used(tx, &client_id, &user_id, now)
        });
    }
    Ok(Some(caller))
}
