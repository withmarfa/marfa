//! A confirmation binds ending a browser sign-in, an app or a passkey to what its preview showed,
//! and the act runs in the write that spends it.

use std::sync::Arc;

use rusqlite::Transaction;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::confirm::{self, Bound};
use super::connector::{self, Confirmed};
use super::{revoke, webhook};
use crate::app::access::{Caller, Permission};
use crate::app::auth::session::ENDED;
use crate::app::auth::sign_ins::{self, Held};
use crate::app::auth::{Visit, passkeys};
use crate::app::oauth::grants;
use crate::app::oauth::store::Consent;
use crate::app::refusal::{Code, Refusal, Result};
use crate::app::unit::Unit;
use crate::app::{App, keys, webhooks};

pub const TOOL: &str = "marfa_end_sign_in";

/// What a call names: a sign-in, which is a browser, an app or a key, or a passkey.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Named {
    SignIn,
    Passkey,
}

/// What a preview found the call names, which its token is signed for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Browser,
    App,
    Passkey,
}

impl Kind {
    pub fn word(self) -> &'static str {
        match self {
            Kind::Browser => "browser",
            Kind::App => "app",
            Kind::Passkey => "passkey",
        }
    }

    fn action(self) -> &'static str {
        match self {
            Kind::Browser => ENDED,
            Kind::App => grants::REVOKED,
            Kind::Passkey => passkeys::REMOVED,
        }
    }

    fn target(self, id: &str, revoke_keys: bool) -> String {
        let named = match self {
            Kind::Browser => format!("browser {id}"),
            Kind::App => format!("app {id} {revoke_keys}"),
            Kind::Passkey => format!("passkey {id}"),
        };
        confirm::ids_digest(&[named])
    }
}

/// An app as ending it would leave things.
pub struct AppEnding {
    pub sign_in: Value,
    pub scopes: Vec<String>,
    pub webhooks: Vec<Value>,
    /// The keys that end with the app, when the call asks for that.
    pub keys: Option<Vec<Value>>,
    /// The app's live keys, which keep working unless the call asks to end them.
    pub keys_held: usize,
    pub token_chains: usize,
    /// Whether the act ends the credential making the call.
    pub ends_caller: bool,
}

pub enum Ending {
    Browser { sign_in: Value, digest: String },
    App { app: Box<AppEnding>, digest: String },
    Passkey { passkey: Value, digest: String },
    /// A key, which `marfa_revoke_key` revokes.
    Key,
}

impl Ending {
    fn kind(&self) -> Option<Kind> {
        match self {
            Ending::Browser { .. } => Some(Kind::Browser),
            Ending::App { .. } => Some(Kind::App),
            Ending::Passkey { .. } => Some(Kind::Passkey),
            Ending::Key => None,
        }
    }

    fn digest(&self) -> Option<&str> {
        match self {
            Ending::Browser { digest, .. }
            | Ending::App { digest, .. }
            | Ending::Passkey { digest, .. } => Some(digest),
            Ending::Key => None,
        }
    }
}

fn hashed(value: &Value) -> String {
    hex::encode(Sha256::digest(value.to_string().as_bytes()))
}

fn sorted(mut list: Vec<String>) -> Vec<String> {
    list.sort_unstable();
    list
}

fn only_an_app() -> Refusal {
    Refusal::validation("revoke_keys applies only to an app; this ID names a browser or a passkey.")
}

fn ends_caller(caller: &Caller, consent: &Consent, revoke_keys: bool) -> bool {
    match caller {
        Caller::App { grant, .. } => grant.client_id == consent.client_id,
        Caller::Key(key) => {
            revoke_keys && key.oauth_client_id.as_deref() == Some(consent.client_id.as_str())
        }
        _ => false,
    }
}

/// Token chains are left out: an app refreshes them as it works.
fn app_ending(
    tx: &Transaction<'_>,
    caller: &Caller,
    sign_in: Value,
    consent: &Consent,
    revoke_keys: bool,
    at: &str,
) -> Result<Ending> {
    let scopes = sorted(consent.scopes.literals().to_vec());
    let destinations = sorted(grants::destinations(tx, consent)?);
    let version = grants::item_version(tx, consent)?;
    let hooks = webhooks::of_grant(tx, &consent.grant_id)?;
    let mut bound_hooks: Vec<(String, String)> = hooks
        .iter()
        .map(|hook| (hook.id.clone(), webhook::held_digest(hook)))
        .collect();
    bound_hooks.sort_unstable();
    let held = keys::all_of_app(tx, &consent.client_id, at)?;
    let bound_keys = revoke_keys.then(|| {
        let mut bound: Vec<(String, String)> = held
            .iter()
            .map(|key| (key.id.clone(), revoke::digest_of(key)))
            .collect();
        bound.sort_unstable();
        bound
    });
    let digest = hashed(&json!({
        "client_id": consent.client_id,
        "version": version,
        "scopes": scopes,
        "destinations": destinations,
        "webhooks": bound_hooks,
        "keys": bound_keys,
    }));
    let app = AppEnding {
        sign_in,
        scopes: consent.scopes.literals().to_vec(),
        webhooks: hooks
            .iter()
            .map(|hook| {
                json!({
                    "id": hook.id,
                    "url": hook.url,
                    "events": hook.events,
                    "type_filter": hook.type_filter,
                    "active": hook.active,
                })
            })
            .collect(),
        keys: revoke_keys.then(|| {
            held.iter()
                .map(|key| json!({ "id": key.id, "label": key.label, "source": key.source }))
                .collect()
        }),
        keys_held: held.len(),
        token_chains: grants::token_chains(tx, consent)?,
        ends_caller: ends_caller(caller, consent, revoke_keys),
    };
    Ok(Ending::App {
        app: Box::new(app),
        digest,
    })
}

fn ending(
    tx: &Transaction<'_>,
    caller: &Caller,
    named: Named,
    id: &str,
    revoke_keys: bool,
    at: &str,
    days: u64,
) -> Result<Ending> {
    if named == Named::Passkey {
        let (listed, credential_id) = passkeys::held(tx, caller, id)?;
        if revoke_keys {
            return Err(only_an_app());
        }
        let digest = hashed(&json!([listed.id, credential_id, listed.host, listed.name]));
        return Ok(Ending::Passkey {
            passkey: listed.to_json(),
            digest,
        });
    }
    match sign_ins::held(tx, caller, id, at, days)? {
        Held::Browser { .. } if revoke_keys => Err(only_an_app()),
        Held::Browser {
            shown,
            token_digest,
        } => Ok(Ending::Browser {
            sign_in: shown.to_json(),
            digest: hashed(&json!([id, token_digest])),
        }),
        Held::App { shown, consent } => {
            app_ending(tx, caller, shown.to_json(), &consent, revoke_keys, at)
        }
        Held::Key => Ok(Ending::Key),
    }
}

/// What the call names as the caller may end it.
pub async fn preview(
    app: &App,
    caller: &Caller,
    named: Named,
    id: String,
    revoke_keys: bool,
) -> Result<Ending> {
    let caller = caller.clone();
    let at = app.clock.stamp();
    let days = sign_ins::inactivity_days(app);
    app.db
        .read(move |tx| {
            let caller = caller.current(tx, &at)?;
            ending(tx, &caller, named, &id, revoke_keys, &at, days)
        })
        .await
}

/// The confirmation for what the preview read; none for a key, which this tool does not end.
pub fn token(
    app: &App,
    caller: &Caller,
    id: &str,
    revoke_keys: bool,
    ending: &Ending,
) -> Result<Option<confirm::Token>> {
    let (Some(kind), Some(digest)) = (ending.kind(), ending.digest()) else {
        return Ok(None);
    };
    connector::issue(app, caller, TOOL, &kind.target(id, revoke_keys), digest).map(Some)
}

/// A sign-in or passkey that is no longer there reads as gone; a refusal of the caller stands.
pub fn read_now<T>(read: Result<T>) -> Result<Option<T>> {
    match read {
        Ok(found) => Ok(Some(found)),
        Err(Refusal {
            code: Code::SignInNotFound | Code::GrantNotFound | Code::PasskeyNotFound,
            ..
        }) => Ok(None),
        Err(refused) => Err(refused),
    }
}

/// Ends what the token was signed for. The token's target says which kind the preview found,
/// so the kind is known before anything the call names is read.
pub async fn end_confirmed(
    app: &Arc<App>,
    caller: &Caller,
    (named, id, revoke_keys): (Named, String, bool),
    bound: Bound,
    visit: Visit,
) -> Result<(Option<Kind>, Confirmed)> {
    let credential = caller.credential_handle();
    let kinds: &[Kind] = match named {
        Named::SignIn => &[Kind::Browser, Kind::App],
        Named::Passkey => &[Kind::Passkey],
    };
    let mut signed = None;
    for kind in kinds {
        let target = kind.target(&id, revoke_keys);
        if app.mcp.signer.holds_target(TOOL, &credential, &target, &bound)? {
            signed = Some((*kind, target));
            break;
        }
    }
    let Some((kind, target)) = signed else {
        return Ok((None, Confirmed::Stale));
    };
    let cache = app.catalog_handle();
    let days = sign_ins::inactivity_days(app);
    let reading = id.clone();
    let confirmed = connector::confirmed(
        app,
        caller,
        (TOOL, kind.action(), target),
        bound,
        move |unit| {
            let read = ending(
                unit.tx(),
                &unit.caller,
                named,
                &reading,
                revoke_keys,
                &unit.at,
                days,
            );
            Ok(read_now(read)?
                .filter(|ending| ending.kind() == Some(kind))
                .and_then(|ending| ending.digest().map(str::to_string)))
        },
        move |unit: &Unit<'_, '_>| {
            let ended = match kind {
                Kind::Browser => sign_ins::end_in(unit, &cache, &id, false, &visit)?,
                Kind::App if unit.caller.holds(Permission::SignInsManage) => {
                    sign_ins::end_in(unit, &cache, &id, revoke_keys, &visit)?
                }
                Kind::App => grants::revoke_in(unit, &cache, &id, revoke_keys)?,
                Kind::Passkey => {
                    passkeys::remove_in(unit, &id)?;
                    0
                }
            };
            Ok(i64::try_from(ended).unwrap_or(i64::MAX))
        },
    )
    .await?;
    Ok((Some(kind), confirmed))
}
