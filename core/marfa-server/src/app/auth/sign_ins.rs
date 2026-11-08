use std::sync::Arc;

use rusqlite::Transaction;
use serde_json::{Value, json};

use super::owner::checked_name;
use super::session::{self, ENDED, Session};
use super::{Visit, names, seconds_of, stamp_of};
use crate::app::App;
use crate::app::access::Caller;
use crate::app::keys::{self, Key};
use crate::app::oauth::grants;
use crate::app::oauth::store::{Consent, ms_of};
use crate::app::refusal::{Code, Refusal, Result};
use crate::settings::registry::GRANT_INACTIVITY_DAYS;

const MS_PER_SECOND: i64 = 1_000;

#[derive(Clone, Debug)]
pub struct SignIn {
    id: String,
    kind: &'static str,
    name: String,
    created_ms: i64,
    created_at: String,
    last_used_at: Option<String>,
    expires_at: Option<String>,
    ip_address: Option<String>,
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
            "ip_address": self.ip_address,
            "user_agent": self.user_agent,
            "minted_by": self.minted_by,
        })
    }
}

fn browser(session: &Session, ip_address: Option<String>) -> SignIn {
    SignIn {
        id: session.id.clone(),
        kind: "browser",
        name: session.name(),
        created_ms: session.created_at * MS_PER_SECOND,
        created_at: stamp_of(session.created_at),
        last_used_at: Some(stamp_of(session.updated_at)),
        expires_at: Some(stamp_of(session.expires_at)),
        ip_address,
        user_agent: session.user_agent.clone(),
        minted_by: None,
    }
}

fn app_of(tx: &Transaction<'_>, consent: &Consent, inactivity_days: u64) -> Result<SignIn> {
    Ok(SignIn {
        id: consent.grant_id.clone(),
        kind: "app",
        name: grants::sign_in_name(tx, consent)?,
        created_ms: consent.updated_at,
        created_at: grants::granted_at(consent),
        last_used_at: consent.last_used_at.map(crate::app::oauth::store::stamp_of),
        expires_at: grants::boundary(consent, inactivity_days),
        ip_address: None,
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
        name: names::usable(Some(&key.label))
            .unwrap_or(&key.id)
            .to_string(),
        created_ms: ms_of(&key.created_at)?,
        created_at: key.created_at.clone(),
        last_used_at: key.last_used_at.clone(),
        expires_at: key.expires_at.clone(),
        ip_address: None,
        user_agent: None,
        minted_by,
    })
}

fn inactivity_days(app: &App) -> u64 {
    app.settings.live().get(GRANT_INACTIVITY_DAYS)
}

pub async fn list(app: &App, caller: &Caller) -> Result<Vec<SignIn>> {
    let caller = caller.clone();
    let days = inactivity_days(app);
    let at = app.clock.stamp();
    app.db
        .read(move |tx| {
            caller.current(tx, &at)?;
            let mut found = Vec::new();
            for (session, ip_address) in session::all_live(tx, seconds_of(&at)?)? {
                found.push(browser(&session, ip_address));
            }
            let apps = grants::all_of_owner(tx)?;
            for consent in &apps {
                found.push(app_of(tx, consent, days)?);
            }
            for key in keys::all_live(tx, &at)? {
                found.push(key_of(&key, &apps)?);
            }
            found.sort_by(|left, right| {
                (left.created_ms, &left.id).cmp(&(right.created_ms, &right.id))
            });
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
        if let Some(session) = session::live_by_id(tx, id, seconds_of(at)?)? {
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

fn to_end(tx: &Transaction<'_>, id: &str, at: &str) -> Result<Named> {
    match Named::read(tx, id, at)? {
        Named::Nothing => Err(no_such_sign_in()),
        named => Ok(named),
    }
}

pub async fn end(app: &Arc<App>, caller: &Caller, id: String, visit: Visit) -> Result<()> {
    let asking = caller.clone();
    let looked_for = id.clone();
    let at = app.clock.stamp();
    let action = app
        .db
        .read(move |tx| {
            asking.current(tx, &at)?;
            Ok(match to_end(tx, &looked_for, &at)? {
                Named::Key(_) => keys::REVOKED,
                Named::App(_) => grants::REVOKED,
                _ => ENDED,
            })
        })
        .await?;
    let cache = app.catalog_handle();
    app.write(caller, action, move |unit| {
        match to_end(unit.tx(), &id, &unit.at)? {
            Named::Browser(session) => session::ended(
                unit.tx(),
                &unit.at,
                &unit.caller,
                &visit,
                &session.id,
                &session.user_id,
                false,
            ),
            Named::App(consent) => grants::withdraw(unit, &cache, &consent),
            Named::Key(key) => keys::end_for_owner(unit, &key.id),
            Named::Nothing => Err(no_such_sign_in()),
        }
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
    checked_name(text)?.ok_or_else(|| Refusal::validation("Give the sign-in a name."))
}

pub async fn rename(app: &Arc<App>, caller: &Caller, id: String, name: String) -> Result<SignIn> {
    let asking = caller.clone();
    let looked_for = id.clone();
    let at = app.clock.stamp();
    let action = app
        .db
        .read(move |tx| {
            asking.current(tx, &at)?;
            Ok(match to_rename(tx, &looked_for, &at)? {
                Named::Key(_) => keys::UPDATED,
                _ => grants::RENAMED,
            })
        })
        .await?;
    let cache = app.catalog_handle();
    let days = inactivity_days(app);
    app.write(caller, action, move |unit| {
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
