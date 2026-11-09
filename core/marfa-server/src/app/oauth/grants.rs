use std::sync::Arc;

use arc_swap::ArcSwap;
use rusqlite::{Connection, Transaction};
use serde_json::{Value, json};

use super::grant;
use super::redirect::web_origins;
use super::revoke::GRANT_REVOKED;
use super::scope::{ScopeSet, first_uncovered};
use super::store::{self, Client, Consent, ms_of, stamp_of};
use super::sweep::MS_PER_DAY;
use crate::app::access::{Caller, Permission};
use crate::app::auth::names;
use crate::app::catalog::Catalog;
use crate::app::refusal::{Code, Refusal, Result};
use crate::app::unit::Unit;
use crate::app::{App, instance, keys};

const COMMAND_LINE_SOFTWARE_ID: &str = "so.marfa.cli";
const APP_SOURCE_PREFIX: &str = "oauth:";
const NARROWED: &str = "auth.grant.narrowed";
pub(crate) const RENAMED: &str = "auth.grant.rename";
pub(crate) const REVOKED: &str = GRANT_REVOKED;

fn no_such_grant() -> Refusal {
    Refusal::new(Code::OauthGrantNotFound, "No live app grant has this ID.")
}

pub(crate) fn of_owner(tx: &Transaction<'_>, id: &str) -> Result<Option<Consent>> {
    match instance::owner_id(tx)? {
        Some(owner) => store::standing_grant(tx, id, &owner),
        None => Ok(None),
    }
}

pub(crate) fn all_of_owner(tx: &Transaction<'_>) -> Result<Vec<Consent>> {
    match instance::owner_id(tx)? {
        Some(owner) => store::standing_consents(tx, &owner),
        None => Ok(Vec::new()),
    }
}

pub(crate) fn granted_at(consent: &Consent) -> String {
    stamp_of(consent.updated_at)
}

pub(crate) fn boundary(consent: &Consent, inactivity_days: u64) -> Option<String> {
    let days = i64::try_from(inactivity_days)
        .ok()
        .filter(|days| *days > 0)?;
    let from = consent.last_used_at.unwrap_or(consent.updated_at);
    Some(stamp_of(from + days * MS_PER_DAY))
}

pub(crate) fn sign_in_name(tx: &Connection, consent: &Consent) -> Result<String> {
    let client = store::client(tx, &consent.client_id)?;
    let own = grant::own_name(tx, &consent.grant_id)?;
    let registered = client
        .as_ref()
        .and_then(|client| client.registration.client_name.as_deref());
    Ok(names::usable(own.as_deref())
        .or_else(|| names::usable(registered))
        .unwrap_or(&consent.client_id)
        .to_string())
}

pub(crate) fn source_of(client_id: &str, user_id: &str) -> String {
    format!("{APP_SOURCE_PREFIX}{client_id}:{user_id}")
}

/// A client's ID can hold a colon; a person's cannot.
pub(crate) fn name_of_source(tx: &Connection, source: &str) -> Result<Option<String>> {
    let Some((client_id, user_id)) = source
        .strip_prefix(APP_SOURCE_PREFIX)
        .and_then(|named| named.rsplit_once(':'))
    else {
        return Ok(None);
    };
    match store::consent(tx, client_id, user_id)?.filter(Consent::stands) {
        Some(consent) => sign_in_name(tx, &consent).map(Some),
        None => Ok(None),
    }
}

fn kind_of(client: Option<&Client>, origins: &[String]) -> &'static str {
    let software = client.and_then(|client| client.registration.software_id.as_deref());
    if software == Some(COMMAND_LINE_SOFTWARE_ID) {
        "cli"
    } else if origins.is_empty() {
        "app"
    } else {
        "web"
    }
}

fn listed(tx: &Connection, consent: &Consent) -> Result<Value> {
    let client = store::client(tx, &consent.client_id)?;
    let origins = client.as_ref().map_or_else(Vec::new, |client| {
        let registration = &client.registration;
        web_origins(registration.application_type, &registration.redirect_uris)
    });
    let client_name = client
        .as_ref()
        .and_then(|client| names::usable(client.registration.client_name.as_deref()));
    Ok(json!({
        "id": consent.grant_id,
        "kind": kind_of(client.as_ref(), &origins),
        "client_id": consent.client_id,
        "client_name": client_name,
        "origins": origins,
        "scopes": consent.scopes.literals(),
        "status": "active",
        "granted_at": granted_at(consent),
        "last_used_at": consent.last_used_at.map(stamp_of),
    }))
}

pub async fn list(app: &App, caller: &Caller) -> Result<Vec<Value>> {
    let caller = caller.clone();
    let at = app.clock.stamp();
    app.db
        .read(move |tx| {
            let caller = caller.current(tx, &at)?;
            caller.require(Permission::GrantsManage)?;
            all_of_owner(tx)?
                .iter()
                .map(|consent| listed(tx, consent))
                .collect()
        })
        .await
}

fn same(left: &ScopeSet, right: &ScopeSet) -> bool {
    let sorted = |set: &ScopeSet| {
        let mut literals = set.literals().to_vec();
        literals.sort_unstable();
        literals
    };
    sorted(left) == sorted(right)
}

/// Judged at the moment the change commits, not when the person looked.
fn require_as_seen(tx: &Connection, consent: &Consent, expected: &ScopeSet) -> Result<()> {
    let shown = grant::shown_scopes(tx, &consent.grant_id)?;
    if same(&consent.scopes, expected) && shown.is_none_or(|shown| same(&shown, expected)) {
        return Ok(());
    }
    Err(Refusal::new(
        Code::Conflict,
        "This app's access changed. Read its access again before saving.",
    ))
}

fn end_chains_beyond(
    tx: &Connection,
    consent: &Consent,
    scopes: &ScopeSet,
    now: i64,
) -> Result<()> {
    let tokens = store::usable_tokens(tx, &consent.client_id, &consent.user_id)?;
    for (chain, held) in &tokens {
        if first_uncovered(scopes, held).is_some() {
            store::end_chain(tx, chain, now)?;
        }
    }
    Ok(())
}

#[derive(Debug)]
pub struct Narrowing {
    pub scopes: ScopeSet,
    pub expected: ScopeSet,
}

pub async fn narrow(
    app: &Arc<App>,
    caller: &Caller,
    id: String,
    asked: Narrowing,
) -> Result<ScopeSet> {
    let cache = app.catalog_handle();
    app.write(caller, NARROWED, move |unit| {
        unit.caller.require_local()?;
        let tx = unit.tx();
        let consent = of_owner(tx, &id)?.ok_or_else(no_such_grant)?;
        require_as_seen(tx, &consent, &asked.expected)?;
        if first_uncovered(&consent.scopes, &asked.scopes).is_some() {
            return Err(Refusal::new(
                Code::Forbidden,
                "Access can only be reduced. The app must ask again for more access.",
            ));
        }
        if same(&consent.scopes, &asked.scopes) {
            return Ok(consent.scopes);
        }
        end_chains_beyond(tx, &consent, &asked.scopes, ms_of(&unit.at)?)?;
        store::end_outstanding_codes(tx, &consent.client_id, &consent.user_id)?;
        grant::narrow(unit, &cache, &consent, &asked.scopes)?;
        unit.audit(
            "oauth_grant",
            &consent.client_id,
            Some(json!({
                "grant_item_id": consent.grant_id,
                "scopes": asked.scopes.literals(),
            })),
        )?;
        Ok(asked.scopes)
    })
    .await
}

pub(crate) fn withdraw(
    unit: &Unit<'_, '_>,
    cache: &ArcSwap<Catalog>,
    consent: &Consent,
    with_keys: bool,
) -> Result<()> {
    grant::end(unit, cache, &consent.client_id, &consent.user_id)?;
    unit.audit_also(
        REVOKED,
        "oauth_grant",
        &consent.client_id,
        Some(json!({
            "client_id": consent.client_id,
            "user_id": consent.user_id,
            "grant_item_id": consent.grant_id,
            "revoke_keys": with_keys,
        })),
    )?;
    if with_keys {
        keys::end_all_of_app(unit, &consent.client_id)?;
    }
    Ok(())
}

pub async fn revoke(app: &Arc<App>, caller: &Caller, id: String, with_keys: bool) -> Result<()> {
    let cache = app.catalog_handle();
    app.write(caller, REVOKED, move |unit| {
        unit.caller.require(Permission::GrantsManage)?;
        let consent = of_owner(unit.tx(), &id)?.ok_or_else(no_such_grant)?;
        withdraw(unit, &cache, &consent, with_keys)
    })
    .await
}

pub(crate) fn rename(
    unit: &Unit<'_, '_>,
    cache: &ArcSwap<Catalog>,
    consent: &Consent,
    name: &str,
) -> Result<()> {
    grant::rename(unit, cache, consent, name)?;
    unit.audit_also(
        RENAMED,
        "oauth_grant",
        &consent.client_id,
        Some(json!({ "grant_item_id": consent.grant_id })),
    )
}
