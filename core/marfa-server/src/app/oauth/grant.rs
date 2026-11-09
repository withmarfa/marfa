//! Each change writes the consent and its `system.connection` item in the caller's transaction,
//! so neither is ever seen without the other.

use arc_swap::ArcSwap;
use rusqlite::{Connection, OptionalExtension};
use serde_json::{Map, Value, json};
use uuid::Uuid;

use super::scope::{ScopeSet, combined};
use super::store::{self, Client, Consent, ms_of};
use crate::app::catalog::Catalog;
use crate::app::items::write::{Change, Put, Update, apply_server_own};
use crate::app::refusal::{Refusal, Result};
use crate::app::unit::Unit;
use crate::app::webhooks;

const TYPE: &str = "system.connection";
pub(super) const CONSENT_SOURCE: &str = "marfa/oauth2/consent";
pub(super) const DEVICE_SOURCE: &str = "marfa/oauth/device";
/// The grant has its own entry, and its item another by what was done to it.
pub(super) const GRANT_WRITE: &str = "item.create";
pub(super) const GRANT_CREATED: &str = "auth.grant.created";

#[derive(Clone, Debug)]
pub struct Stood {
    pub grant_id: String,
    pub scopes: ScopeSet,
    pub created: bool,
}

fn version_of(unit: &Unit<'_, '_>, id: &str) -> Result<Option<i64>> {
    Ok(unit
        .tx()
        .query_row("SELECT version FROM items WHERE id = ?1", [id], |row| {
            row.get(0)
        })
        .optional()?)
}

fn shown(tx: &Connection, id: &str) -> Result<Option<Map<String, Value>>> {
    let text: Option<String> = tx
        .query_row(
            "SELECT json(properties) FROM items WHERE id = ?1",
            [id],
            |row| row.get(0),
        )
        .optional()?;
    text.map(|text| {
        serde_json::from_str(&text).map_err(|_| Refusal::internal("a grant's item did not read"))
    })
    .transpose()
}

pub(super) fn shown_scopes(tx: &Connection, id: &str) -> Result<Option<ScopeSet>> {
    Ok(shown(tx, id)?.map(|fields| {
        fields
            .get("scopes")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .collect()
    }))
}

pub(super) fn own_name(tx: &Connection, id: &str) -> Result<Option<String>> {
    Ok(shown(tx, id)?
        .as_ref()
        .and_then(|fields| fields.get("name"))
        .and_then(Value::as_str)
        .map(str::to_string))
}

fn properties(pairs: Value) -> Map<String, Value> {
    match pairs {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

fn applied(unit: &Unit<'_, '_>, cache: &ArcSwap<Catalog>, change: Change) -> Result<()> {
    let action = change.action();
    let done = apply_server_own(&unit.under(action), cache, change)?;
    if done.status >= 400 {
        return Err(Refusal::internal("a grant's item did not write"));
    }
    Ok(())
}

fn create_item(
    unit: &Unit<'_, '_>,
    cache: &ArcSwap<Catalog>,
    client: &Client,
    grant_id: &str,
    scopes: &ScopeSet,
    source: &str,
) -> Result<()> {
    applied(
        unit,
        cache,
        Change::Put(Box::new(Put {
            type_id: TYPE.to_string(),
            id: Some(grant_id.to_string()),
            state: Some("active".to_string()),
            source: Some(source.to_string()),
            create_only: true,
            properties: Some(properties(json!({
                "kind": "app",
                "client_id": client.id,
                "scopes": scopes.literals(),
                "status": "active",
                "granted_at": unit.at,
            }))),
            ..Put::default()
        })),
    )
}

fn update_item(
    unit: &Unit<'_, '_>,
    cache: &ArcSwap<Catalog>,
    grant_id: &str,
    version: i64,
    fields: Map<String, Value>,
    clear: Vec<String>,
) -> Result<()> {
    applied(
        unit,
        cache,
        Change::Update(Box::new(Update {
            id: grant_id.to_string(),
            properties: Some(fields),
            clear,
            version,
            ..Update::default()
        })),
    )
}

/// Never reaches less than it does now.
pub(super) fn stand(
    unit: &Unit<'_, '_>,
    cache: &ArcSwap<Catalog>,
    client: &Client,
    user_id: &str,
    approved: &ScopeSet,
    source: &str,
) -> Result<Stood> {
    let tx = unit.tx();
    let now = ms_of(&unit.at)?;
    let Some(consent) = store::consent(tx, &client.id, user_id)? else {
        let grant_id = Uuid::now_v7().to_string();
        create_item(unit, cache, client, &grant_id, approved, source)?;
        store::insert_consent(
            tx,
            &Consent {
                client_id: client.id.clone(),
                user_id: user_id.to_string(),
                grant_id: grant_id.clone(),
                scopes: approved.clone(),
                created_at: now,
                updated_at: now,
                last_used_at: None,
                withdrawn_at: None,
            },
        )?;
        store::approve_destinations(tx, client, user_id)?;
        return Ok(Stood {
            grant_id,
            scopes: approved.clone(),
            created: true,
        });
    };
    let held = if consent.stands() {
        consent.scopes.clone()
    } else {
        ScopeSet::default()
    };
    let scopes = combined(&held, approved);
    if !consent.stands() || scopes != consent.scopes {
        match version_of(unit, &consent.grant_id)? {
            Some(version) => update_item(
                unit,
                cache,
                &consent.grant_id,
                version,
                properties(json!({
                    "scopes": scopes.literals(),
                    "status": "active",
                    "granted_at": unit.at,
                })),
                vec!["revoked_at".to_string()],
            )?,
            None => create_item(unit, cache, client, &consent.grant_id, &scopes, source)?,
        }
        store::renew_consent(tx, &client.id, user_id, &scopes, now)?;
    }
    store::approve_destinations(tx, client, user_id)?;
    Ok(Stood {
        grant_id: consent.grant_id,
        scopes,
        created: false,
    })
}

/// Returns whether a standing grant was ended.
pub(super) fn end(
    unit: &Unit<'_, '_>,
    cache: &ArcSwap<Catalog>,
    client_id: &str,
    user_id: &str,
) -> Result<bool> {
    let tx = unit.tx();
    let now = ms_of(&unit.at)?;
    let Some(consent) = store::consent(tx, client_id, user_id)?.filter(Consent::stands) else {
        return Ok(false);
    };
    store::end_grant_credentials(tx, client_id, user_id, now)?;
    store::withdraw_consent(tx, client_id, user_id, now)?;
    webhooks::forget_grant(tx, &consent.grant_id)?;
    if let Some(version) = version_of(unit, &consent.grant_id)? {
        update_item(
            unit,
            cache,
            &consent.grant_id,
            version,
            properties(json!({ "status": "revoked", "revoked_at": unit.at })),
            Vec::new(),
        )?;
    }
    Ok(true)
}

/// The caller has judged `scopes` to be no more than it reaches now.
pub(super) fn narrow(
    unit: &Unit<'_, '_>,
    cache: &ArcSwap<Catalog>,
    consent: &Consent,
    scopes: &ScopeSet,
) -> Result<()> {
    store::narrow_consent(unit.tx(), &consent.client_id, &consent.user_id, scopes)?;
    if let Some(version) = version_of(unit, &consent.grant_id)? {
        update_item(
            unit,
            cache,
            &consent.grant_id,
            version,
            properties(json!({ "scopes": scopes.literals() })),
            Vec::new(),
        )?;
    }
    Ok(())
}

pub(super) fn rename(
    unit: &Unit<'_, '_>,
    cache: &ArcSwap<Catalog>,
    consent: &Consent,
    name: &str,
) -> Result<()> {
    let version = version_of(unit, &consent.grant_id)?
        .ok_or_else(|| Refusal::internal("a standing grant has no item"))?;
    update_item(
        unit,
        cache,
        &consent.grant_id,
        version,
        properties(json!({ "name": name })),
        Vec::new(),
    )
}

pub(super) fn forget(
    unit: &Unit<'_, '_>,
    cache: &ArcSwap<Catalog>,
    client_id: &str,
    user_id: &str,
) -> Result<()> {
    let tx = unit.tx();
    let Some(consent) = store::consent(tx, client_id, user_id)? else {
        return Ok(());
    };
    if version_of(unit, &consent.grant_id)?.is_some() {
        let id = consent.grant_id;
        applied(
            unit,
            cache,
            Change::Delete {
                id: id.clone(),
                version: None,
            },
        )?;
        applied(unit, cache, Change::Purge { id, version: None })?;
    }
    store::remove_consent(tx, client_id, user_id)
}
