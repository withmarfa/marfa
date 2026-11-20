use std::sync::Arc;

use arc_swap::ArcSwap;
use rusqlite::Transaction;
use serde_json::{Value, json};

use super::Visit;
use super::owner::said_name;
use super::session::{self, ENDED, Session};
use crate::app::App;
use crate::app::access::{Caller, Permission};
use crate::app::catalog::Catalog;
use crate::app::clock::Stamp;
use crate::app::keys::{self, Key};
use crate::app::oauth::grants;
use crate::app::oauth::store::Consent;
use crate::app::refusal::{Code, Refusal, Result};
use crate::app::unit::Unit;
use crate::settings::registry::GRANT_INACTIVITY_DAYS;

#[derive(Clone, Debug)]
pub struct SignIn {
    id: String,
    kind: &'static str,
    name: String,
    created: Stamp,
    created_at: String,
    last_used_at: Option<String>,
    expires_at: Option<String>,
    client_ip: Option<String>,
    user_agent: Option<String>,
    minted_by: Option<String>,
}

impl SignIn {
    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "kind": self.kind,
            "name": self.name,
            "created_at": self.created_at,
            "last_used_at": self.last_used_at,
            "expires_at": self.expires_at,
            "client_ip": self.client_ip,
            "user_agent": self.user_agent,
            "minted_by": self.minted_by,
        })
    }
}

fn browser(session: &Session, client_ip: Option<String>) -> SignIn {
    SignIn {
        id: session.id.clone(),
        kind: "browser",
        name: session.name(),
        created: session.created_at,
        created_at: session.created_at.text(),
        last_used_at: Some(session.last_used_at.text()),
        expires_at: Some(session.expires_at.text()),
        client_ip,
        user_agent: session.user_agent.clone(),
        minted_by: None,
    }
}

fn app_of(tx: &Transaction<'_>, consent: &Consent, inactivity_days: u64) -> Result<SignIn> {
    Ok(SignIn {
        id: consent.grant_id.clone(),
        kind: "app",
        name: grants::sign_in_name(tx, consent)?,
        created: consent.updated_at,
        created_at: grants::granted_at(consent),
        last_used_at: consent.last_used_at.map(Stamp::text),
        expires_at: grants::boundary(consent, inactivity_days)?,
        client_ip: None,
        user_agent: None,
        minted_by: None,
    })
}

fn key_of(key: &Key, apps: &[Consent]) -> Result<SignIn> {
    let minted_by = key.oauth_client_id.as_ref().and_then(|client| {
        apps.iter()
            .find(|consent| consent.client_id == *client)
            .map(|consent| consent.grant_id.clone())
    });
    Ok(SignIn {
        id: key.id.clone(),
        kind: "key",
        name: key.shown_name().to_string(),
        created: Stamp::read(&key.created_at)?,
        created_at: key.created_at.clone(),
        last_used_at: key.last_used_at.clone(),
        expires_at: key.expires_at.clone(),
        client_ip: None,
        user_agent: None,
        minted_by,
    })
}

pub(crate) fn inactivity_days(app: &App) -> u64 {
    app.settings.live().get(GRANT_INACTIVITY_DAYS)
}

pub async fn list(app: &App, caller: &Caller) -> Result<Vec<SignIn>> {
    let caller = caller.clone();
    let days = inactivity_days(app);
    let at = app.clock.stamp();
    app.db
        .read(move |tx| {
            caller
                .current(tx, &at)?
                .require(Permission::SignInsManage)?;
            let mut found = Vec::new();
            for (session, client_ip) in session::all_live(tx, Stamp::read(&at)?)? {
                found.push(browser(&session, client_ip));
            }
            let apps = grants::all_of_owner(tx)?;
            for consent in &apps {
                found.push(app_of(tx, consent, days)?);
            }
            for key in keys::all_live(tx, &at)? {
                found.push(key_of(&key, &apps)?);
            }
            found.sort_by(|left, right| (left.created, &left.id).cmp(&(right.created, &right.id)));
            Ok(found)
        })
        .await
}

enum Named {
    Browser(Box<Session>),
    App(Box<Consent>),
    Key(Box<Key>),
    Nothing,
}

impl Named {
    fn read(tx: &Transaction<'_>, id: &str, at: &str) -> Result<Named> {
        if let Some(session) = session::live_by_id(tx, id, Stamp::read(at)?)? {
            return Ok(Named::Browser(Box::new(session)));
        }
        if let Some(consent) = grants::of_owner(tx, id)? {
            return Ok(Named::App(Box::new(consent)));
        }
        Ok(keys::live_by_id(tx, id, at)?.map_or(Named::Nothing, |key| Named::Key(Box::new(key))))
    }
}

fn no_such_sign_in() -> Refusal {
    Refusal::new(Code::SignInNotFound, "No live sign-in has this ID.")
}

fn to_end(tx: &Transaction<'_>, id: &str, with_keys: bool, at: &str) -> Result<Named> {
    match Named::read(tx, id, at)? {
        Named::Nothing => Err(no_such_sign_in()),
        named @ Named::App(_) => Ok(named),
        _ if with_keys => Err(Refusal::validation(
            "revoke_keys applies only to an app; this ID names a browser or a key.",
        )),
        named => Ok(named),
    }
}

/// What an ID names that a caller may end, read for a preview.
pub(crate) enum Held {
    /// The token's digest never changes while the session lasts.
    Browser {
        shown: SignIn,
        token_digest: String,
    },
    App {
        shown: SignIn,
        consent: Box<Consent>,
    },
    Key,
}

/// A browser sign-in needs `sign_ins.manage`, and an app it or `grants.manage`, as
/// `DELETE /owner/sign-ins/{id}` and `DELETE /oauth/grants/{id}` each allow.
pub(crate) fn held(
    tx: &Transaction<'_>,
    caller: &Caller,
    id: &str,
    at: &str,
    days: u64,
) -> Result<Held> {
    let app = |consent: Consent| -> Result<Held> {
        Ok(Held::App {
            shown: app_of(tx, &consent, days)?,
            consent: Box::new(consent),
        })
    };
    if !caller.holds(Permission::SignInsManage) {
        caller.require(Permission::GrantsManage)?;
        return app(grants::of_owner(tx, id)?.ok_or_else(grants::no_such_grant)?);
    }
    if let Some((session, client_ip, token_digest)) =
        session::live_held_by_id(tx, id, Stamp::read(at)?)?
    {
        return Ok(Held::Browser {
            shown: browser(&session, client_ip),
            token_digest,
        });
    }
    if let Some(consent) = grants::of_owner(tx, id)? {
        return app(consent);
    }
    match keys::live_by_id(tx, id, at)? {
        Some(_) => Ok(Held::Key),
        None => Err(no_such_sign_in()),
    }
}

/// `DELETE /owner/sign-ins/{id}` in the caller's transaction; answers how many keys it ended.
pub(crate) fn end_in(
    unit: &Unit<'_, '_>,
    cache: &ArcSwap<Catalog>,
    id: &str,
    with_keys: bool,
    visit: &Visit,
) -> Result<usize> {
    unit.caller.require(Permission::SignInsManage)?;
    match to_end(unit.tx(), id, with_keys, &unit.at)? {
        Named::Browser(session) => session::ended(
            unit.tx(),
            &unit.at,
            &unit.caller,
            visit,
            &session.id,
            &session.owner_id,
            false,
        )
        .map(|()| 0),
        Named::App(consent) => grants::withdraw(unit, cache, &consent, with_keys),
        Named::Key(key) => keys::end_for_owner(unit, &key.id).map(|()| 0),
        Named::Nothing => Err(no_such_sign_in()),
    }
}

pub async fn end(
    app: &Arc<App>,
    caller: &Caller,
    id: String,
    with_keys: bool,
    visit: Visit,
) -> Result<()> {
    let asking = caller.clone();
    let looked_for = id.clone();
    let at = app.clock.stamp();
    let action = app
        .db
        .read(move |tx| {
            asking
                .current(tx, &at)?
                .require(Permission::SignInsManage)?;
            Ok(match to_end(tx, &looked_for, with_keys, &at)? {
                Named::Key(_) => keys::REVOKED,
                Named::App(_) => grants::REVOKED,
                _ => ENDED,
            })
        })
        .await?;
    let cache = app.catalog_handle();
    app.write(caller, action, move |unit| {
        end_in(unit, &cache, &id, with_keys, &visit).map(drop)
    })
    .await
}

fn to_rename(tx: &Transaction<'_>, id: &str, at: &str) -> Result<Named> {
    match Named::read(tx, id, at)? {
        Named::Nothing => Err(no_such_sign_in()),
        Named::Browser(_) => Err(Refusal::validation(
            "A browser's name comes from the browser, so it can't be renamed.",
        )),
        named => Ok(named),
    }
}

pub fn new_name(text: &str) -> Result<String> {
    said_name(text, "Give the sign-in a name.")
}

pub async fn rename(app: &Arc<App>, caller: &Caller, id: String, name: String) -> Result<SignIn> {
    let asking = caller.clone();
    let looked_for = id.clone();
    let at = app.clock.stamp();
    let action = app
        .db
        .read(move |tx| {
            asking
                .current(tx, &at)?
                .require(Permission::SignInsManage)?;
            Ok(match to_rename(tx, &looked_for, &at)? {
                Named::Key(_) => keys::UPDATED,
                _ => grants::RENAMED,
            })
        })
        .await?;
    let cache = app.catalog_handle();
    let days = inactivity_days(app);
    app.write(caller, action, move |unit| {
        unit.caller.require(Permission::SignInsManage)?;
        let tx = unit.tx();
        match to_rename(tx, &id, &unit.at)? {
            Named::App(consent) => {
                grants::rename(unit, &cache, &consent, &name)?;
                app_of(tx, &consent, days)
            }
            Named::Key(mut key) => {
                keys::relabel_for_owner(unit, &mut key, &name)?;
                key_of(&key, &grants::all_of_owner(tx)?)
            }
            Named::Browser(_) | Named::Nothing => Err(no_such_sign_in()),
        }
    })
    .await
}
