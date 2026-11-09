//! A confirmation binds a key revoke to the key as the preview showed it.

use std::sync::Arc;

use serde_json::Value;
use sha2::{Digest, Sha256};

use super::confirm::{self, Check};
use crate::app::App;
use crate::app::access::Caller;
use crate::app::keys::{self, Key};
use crate::app::refusal::{Code, Refusal, Result};

pub const TOOL: &str = "marfa_revoke_key";

pub enum Confirmed {
    Revoked,
    /// The token had been spent on this same key, which that call revoked.
    AlreadyRevoked,
    /// The token is not this credential's for the key as it is now.
    Stale,
}

/// The key as it reaches, which is all a revoke confirms: using the key does not change it.
fn digest_of(key: &Key) -> String {
    let mut shown = key.to_json();
    shown.remove("last_used_at");
    hex::encode(Sha256::digest(Value::Object(shown).to_string().as_bytes()))
}

fn subject_of(id: &str, key: &Key) -> String {
    confirm::subject_digest(&[id.to_string()], &digest_of(key))
}

/// The key as the caller may revoke it.
pub async fn preview(app: &App, caller: &Caller, id: &str) -> Result<Key> {
    keys::list(app, caller)
        .await?
        .into_iter()
        .find(|key| key.id == id)
        .ok_or_else(|| Refusal::new(Code::ApiKeyNotFound, format!("Key {id} not found")))
}

pub fn token_for(app: &App, caller: &Caller, key: &Key) -> Result<confirm::Token> {
    app.mcp.signer.issue(
        TOOL,
        &caller.credential_handle(),
        &subject_of(&key.id, key),
        app.clock.now_ms(),
    )
}

/// The token's expiry, signature and spend are judged, and the key read again, in the write that revokes.
pub async fn confirmed(
    app: &Arc<App>,
    caller: &Caller,
    id: String,
    token: &str,
) -> Result<Confirmed> {
    let Some(parsed) = confirm::parse(token) else {
        return Ok(Confirmed::Stale);
    };
    let credential = caller.credential_handle();
    let signer = app.mcp.signer.clone();
    let token = token.to_string();
    app.write(caller, keys::REVOKED, move |unit| {
        unit.caller.require_recent(&unit.at)?;
        unit.caller.require_key_door()?;
        let now_ms = unit.instant.ms();
        if parsed.expires_at_ms <= now_ms {
            return Ok(Confirmed::Stale);
        }
        confirm::sweep(unit.tx(), unit.instant)?;
        let named = confirm::ids_digest(std::slice::from_ref(&id));
        if let Some(spent) = confirm::spent(unit.tx(), &parsed.signature)? {
            return Ok(
                if spent.credential == credential && spent.ids_digest == named {
                    Confirmed::AlreadyRevoked
                } else {
                    Confirmed::Stale
                },
            );
        }
        let key = keys::reached(unit.tx(), &unit.caller, &id, &unit.at)?;
        let subject = subject_of(&id, &key);
        if signer.check(TOOL, &credential, &subject, &token, now_ms)? != Check::Valid {
            return Ok(Confirmed::Stale);
        }
        keys::end(unit, &key.id)?;
        confirm::spend(unit.tx(), &parsed, &credential, &named, 1)?;
        Ok(Confirmed::Revoked)
    })
    .await
}
