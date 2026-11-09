mod limit;
pub mod reap;
mod request;
mod secret;
mod usage;

use std::sync::Arc;

use rusqlite::{OptionalExtension, Row, Transaction, params};
use serde_json::{Map, Value, json};

use super::App;
use super::connectors;
use super::access::{Axis, Caller, Change, Grants, OwnLevers, Permission, Standing};
use super::items::reading;
use super::refusal::{Code, Refusal, Result};
use super::unit::Unit;
pub use limit::Limiter;
pub use request::{MINT_FIELDS, Mint, UPDATE_FIELDS, Update};
pub use secret::hash as digest_of;
pub use usage::Usage;
pub(crate) use usage::queue as queue_use;

const SELECT: &str = "SELECT k.*, (SELECT json_group_array(source) FROM \
     (SELECT source FROM api_key_sources WHERE key_id = k.id ORDER BY position)) AS claims \
     FROM api_keys k";
const LIVE: &str = "k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > ?1)";
pub(crate) const REVOKED: &str = "key.revoke";
pub(crate) const UPDATED: &str = "key.update";

#[derive(Clone, Debug)]
pub struct Key {
    pub id: String,
    pub label: String,
    pub source: String,
    pub default_tier: String,
    pub oauth_client_id: Option<String>,
    pub grants: Grants,
    pub levers: OwnLevers,
    pub standing: Standing,
    pub created_at: String,
    pub expires_at: Option<String>,
    pub last_used_at: Option<String>,
}

impl Key {
    pub fn to_json(&self) -> Map<String, Value> {
        let permissions: Vec<&str> = self
            .grants
            .permissions
            .iter()
            .map(|permission| permission.word())
            .collect();
        let mut out = Map::new();
        out.insert("id".into(), self.id.as_str().into());
        out.insert("label".into(), self.label.as_str().into());
        out.insert("source".into(), self.source.as_str().into());
        out.insert("sources".into(), json!(self.grants.sources));
        out.insert("permissions".into(), json!(permissions));
        if let Some(client) = &self.oauth_client_id {
            out.insert("oauth_client_id".into(), client.as_str().into());
        }
        out.insert("default_tier".into(), self.default_tier.as_str().into());
        for axis in [
            Axis::Type,
            Axis::Extension,
            Axis::Edge,
            Axis::Metadata,
            Axis::Profile,
        ] {
            out.insert(axis.field().into(), self.grants.map(axis).to_json());
        }
        if let Some(levers) = self.levers.readable() {
            out.insert("enforcement_override".into(), levers.to_json());
        }
        out.insert("created_at".into(), self.created_at.as_str().into());
        out.insert("expires_at".into(), self.expires_at.as_deref().into());
        out.insert("last_used_at".into(), self.last_used_at.as_deref().into());
        out
    }
}

/// A stored value that does not read grants nothing.
fn stored_object(row: &Row<'_>, column: &str) -> rusqlite::Result<Map<String, Value>> {
    let text: Option<String> = row.get(column)?;
    Ok(text
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default())
}

fn stored_list(row: &Row<'_>, column: &str) -> rusqlite::Result<Vec<String>> {
    let text: String = row.get(column)?;
    Ok(serde_json::from_str(&text).unwrap_or_default())
}

fn from_row(row: &Row<'_>) -> rusqlite::Result<Key> {
    let mut maps = [const { None }; 5];
    for axis in Axis::ALL {
        maps[axis as usize] = Some(super::access::Map::from_stored(stored_object(
            row,
            axis.field(),
        )?));
    }
    Ok(Key {
        id: row.get("id")?,
        label: row.get("label")?,
        source: row.get("source")?,
        default_tier: row.get("default_tier")?,
        oauth_client_id: row.get("oauth_client_id")?,
        grants: Grants {
            permissions: stored_list(row, "permissions")?
                .iter()
                .filter_map(|word| Permission::from_word(word))
                .collect(),
            maps: maps.map(Option::unwrap_or_default),
            sources: stored_list(row, "claims")?,
        },
        levers: OwnLevers::from_row(row.get("enforcement_override")?),
        standing: Standing::default(),
        created_at: row.get("created_at")?,
        expires_at: row.get("expires_at")?,
        last_used_at: row.get("last_used_at")?,
    })
}

pub fn live_by_id(tx: &Transaction<'_>, id: &str, at: &str) -> Result<Option<Key>> {
    Ok(tx
        .query_row(
            &format!("{SELECT} WHERE {LIVE} AND k.id = ?2"),
            [at, id],
            from_row,
        )
        .optional()?)
}

/// The live keys whose type map names `type_id` outright, as `(id, label)`. An app's keys are its grant's.
pub fn naming_type(tx: &Transaction<'_>, type_id: &str, at: &str) -> Result<Vec<(String, String)>> {
    let mut statement = tx.prepare(&format!(
        "SELECT k.id, k.label FROM api_keys k WHERE {LIVE} AND k.oauth_client_id IS NULL \
         AND EXISTS (SELECT 1 FROM json_each(k.type_permissions) WHERE key = ?2) \
         ORDER BY k.created_at, k.id"
    ))?;
    let rows = statement.query_map([at, type_id], |row| Ok((row.get(0)?, row.get(1)?)))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// Whether the key is neither revoked nor expired at `at`.
pub fn stands(tx: &Transaction<'_>, id: &str, at: &str) -> Result<bool> {
    Ok(tx.query_row(
        "SELECT EXISTS (SELECT 1 FROM api_keys k WHERE k.id = ?2 AND k.revoked_at IS NULL \
         AND (k.expires_at IS NULL OR k.expires_at > ?1))",
        [at, id],
        |row| row.get(0),
    )?)
}

/// A key's label for as long as its row is kept, revoked or not.
pub fn label(tx: &Transaction<'_>, id: &str) -> Result<Option<String>> {
    Ok(tx
        .query_row("SELECT label FROM api_keys WHERE id = ?1", [id], |row| {
            row.get(0)
        })
        .optional()?)
}

/// A key not revoked, whether or not its life has ended.
pub fn unrevoked_by_id(tx: &Transaction<'_>, id: &str) -> Result<Option<Key>> {
    Ok(tx
        .query_row(
            &format!("{SELECT} WHERE k.revoked_at IS NULL AND k.id = ?1"),
            [id],
            from_row,
        )
        .optional()?)
}

fn unknown(tx: &Transaction<'_>, caller: &Caller, id: &str) -> Result<Refusal> {
    let revoked: bool = tx.query_row(
        "SELECT EXISTS (SELECT 1 FROM api_keys WHERE id = ?1 AND revoked_at IS NOT NULL)",
        [id],
        |row| row.get(0),
    )?;
    let message = if revoked && caller.manages_keys() {
        format!("Key {id} was already revoked")
    } else {
        format!("Key {id} not found")
    };
    Ok(Refusal::new(Code::ApiKeyNotFound, message))
}

pub(crate) fn reached(tx: &Transaction<'_>, caller: &Caller, id: &str, at: &str) -> Result<Key> {
    match live_by_id(tx, id, at)? {
        Some(key) if caller.reaches(&key) => Ok(key),
        _ => Err(unknown(tx, caller, id)?),
    }
}

fn store_claims(tx: &Transaction<'_>, id: &str, claims: &[String]) -> Result<()> {
    tx.execute("DELETE FROM api_key_sources WHERE key_id = ?1", [id])?;
    let mut insert = tx.prepare_cached(
        "INSERT INTO api_key_sources (key_id, source, position) VALUES (?1, ?2, ?3)",
    )?;
    for (position, source) in claims.iter().enumerate() {
        insert.execute(params![id, source, position as i64])?;
    }
    Ok(())
}

fn permissions_text(grants: &Grants) -> String {
    let words: Vec<&str> = grants.permissions.iter().map(|held| held.word()).collect();
    json!(words).to_string()
}

fn insert(tx: &Transaction<'_>, key: &Key, hash: &str) -> Result<()> {
    let [types, edges, extensions, metadata, profile] =
        Axis::ALL.map(|axis| key.grants.map(axis).to_json().to_string());
    tx.execute(
        "INSERT INTO api_keys (id, hash, label, source, default_tier, oauth_client_id, \
         permissions, type_permissions, edge_permissions, extension_permissions, \
         metadata_permissions, profile_permissions, enforcement_override, created_at, expires_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
        params![
            key.id,
            hash,
            key.label,
            key.source,
            key.default_tier,
            key.oauth_client_id,
            permissions_text(&key.grants),
            types,
            edges,
            extensions,
            metadata,
            profile,
            key.levers.row_text(),
            key.created_at,
            key.expires_at,
        ],
    )?;
    store_claims(tx, &key.id, &key.grants.sources)
}

fn replace(tx: &Transaction<'_>, key: &Key) -> Result<()> {
    let [types, edges, extensions, metadata, profile] =
        Axis::ALL.map(|axis| key.grants.map(axis).to_json().to_string());
    tx.execute(
        "UPDATE api_keys SET label = ?2, default_tier = ?3, permissions = ?4, \
         type_permissions = ?5, edge_permissions = ?6, extension_permissions = ?7, \
         metadata_permissions = ?8, profile_permissions = ?9, enforcement_override = ?10, \
         expires_at = ?11 WHERE id = ?1",
        params![
            key.id,
            key.label,
            key.default_tier,
            permissions_text(&key.grants),
            types,
            edges,
            extensions,
            metadata,
            profile,
            key.levers.row_text(),
            key.expires_at,
        ],
    )?;
    store_claims(tx, &key.id, &key.grants.sources)
}

fn claimed_by_a_live_key(tx: &Transaction<'_>, source: &str, at: &str) -> Result<bool> {
    Ok(tx.query_row(
        &format!(
            "SELECT EXISTS (SELECT 1 FROM api_key_sources s JOIN api_keys k ON k.id = s.key_id \
             WHERE {LIVE} AND s.source = ?2)"
        ),
        [at, source],
        |row| row.get(0),
    )?)
}

/// Frees `source` from holders past their end, which nothing else could revoke,
/// and refuses it if a live key still holds it.
fn take_source(unit: &Unit<'_, '_>, source: &str) -> Result<()> {
    let lapsed: Vec<String> = unit
        .tx()
        .prepare(
            "SELECT id FROM api_keys WHERE source = ?1 AND revoked_at IS NULL \
             AND expires_at <= ?2",
        )?
        .query_map([source, &unit.at], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    for id in lapsed {
        unit.tx().execute(
            "UPDATE api_keys SET revoked_at = ?2 WHERE id = ?1",
            [&id, &unit.at],
        )?;
        unit.audit_also(
            "key.revoke",
            "key",
            &id,
            Some(json!({ "reason": "expired", "source": source })),
        )?;
    }
    let held: bool = unit.tx().query_row(
        "SELECT EXISTS (SELECT 1 FROM api_keys WHERE source = ?1 AND revoked_at IS NULL)",
        [source],
        |row| row.get(0),
    )?;
    if held {
        return Err(Refusal::new(
            Code::Conflict,
            format!("Another key holds the source {source} as its own."),
        )
        .with_detail("source", source));
    }
    Ok(())
}

fn require_ahead(expires_at: Option<&str>, at: &str) -> Result<()> {
    match expires_at {
        Some(expires_at) if expires_at <= at => Err(request::bad_expiry(expires_at)),
        _ => Ok(()),
    }
}

pub async fn mint(app: &App, caller: &Caller, request: Mint) -> Result<(Key, String)> {
    let plain = secret::new_secret()?;
    let hash = secret::hash(&app.settings.start.key_salt, &plain)?;
    let key = app
        .write(caller, "key.create", move |unit| {
            let caller = &unit.caller;
            caller.require_recent(&unit.at)?;
            caller.require(Permission::KeysMint)?;
            if request.levers.is_some() {
                caller.require(Permission::ConfigManage)?;
            }
            let grants = if request.families.names_any() {
                request.families.over(&Grants::default())
            } else {
                caller.whole_set()
            };
            let inherited = caller.key().and_then(|maker| maker.expires_at.clone());
            let expires_at = request.expires_at.unwrap_or(inherited);
            require_ahead(expires_at.as_deref(), &unit.at)?;
            caller.check_ceiling(&grants)?;
            caller.check_life(expires_at.as_deref())?;
            caller.check_own_source(
                &request.source,
                claimed_by_a_live_key(unit.tx(), &request.source, &unit.at)?,
            )?;
            take_source(unit, &request.source)?;
            caller.check_held_source(
                &request.source,
                connectors::source_held(unit.tx(), &request.source)?,
            )?;
            let key = Key {
                id: uuid::Uuid::now_v7().to_string(),
                label: request.label,
                source: request.source,
                default_tier: request.default_tier,
                oauth_client_id: caller.key().and_then(|maker| maker.oauth_client_id.clone()),
                grants,
                levers: request.levers.flatten().into(),
                standing: Standing::default(),
                created_at: unit.at.clone(),
                expires_at,
                last_used_at: None,
            };
            insert(unit.tx(), &key, &hash)?;
            unit.audit("key", &key.id, Some(json!({ "actor": caller.audit_id() })))?;
            Ok(key)
        })
        .await?;
    Ok((key, plain))
}

pub async fn update(app: &App, caller: &Caller, id: String, request: Update) -> Result<Key> {
    app.write(caller, UPDATED, move |unit| {
        unit.caller.require_recent(&unit.at)?;
        unit.caller.require_key_door()?;
        let mut key = reached(unit.tx(), &unit.caller, &id, &unit.at)?;
        let grants = request.families.over(&key.grants);
        if let Some(wanted) = &request.expires_at {
            require_ahead(wanted.as_deref(), &unit.at)?;
        }
        unit.caller.check_update(
            &key,
            &Change {
                grants: &grants,
                life: request.expires_at.as_ref().map(Option::as_deref),
                levers: request.levers.as_ref().map(Option::as_ref),
                narrow_only: request.narrow_only,
            },
        )?;
        key.grants = grants;
        if let Some(label) = request.label {
            key.label = label;
        }
        if let Some(tier) = request.default_tier {
            key.default_tier = tier;
        }
        if let Some(levers) = request.levers {
            key.levers = levers.into();
        }
        if let Some(expires_at) = request.expires_at {
            key.expires_at = expires_at;
        }
        replace(unit.tx(), &key)?;
        unit.audit("key", &key.id, Some(json!({ "fields": request.fields })))?;
        Ok(key)
    })
    .await
}

pub(crate) fn end(unit: &Unit<'_, '_>, id: &str) -> Result<()> {
    unit.tx().execute(
        "UPDATE api_keys SET revoked_at = ?2 WHERE id = ?1",
        [id, &unit.at],
    )?;
    unit.audit_also(REVOKED, "key", id, None)
}

pub(crate) fn end_for_owner(unit: &Unit<'_, '_>, id: &str) -> Result<()> {
    end(unit, id)
}

/// Includes keys those keys minted. Whoever ended the app decides this, whatever keys they reach.
pub(crate) fn end_all_of_app(unit: &Unit<'_, '_>, client_id: &str) -> Result<()> {
    let ids = unit
        .tx()
        .prepare(&format!(
            "SELECT k.id FROM api_keys k WHERE {LIVE} AND k.oauth_client_id = ?2"
        ))?
        .query_map([unit.at.as_str(), client_id], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<String>>>()?;
    for id in &ids {
        end(unit, id)?;
    }
    Ok(())
}

pub(crate) fn relabel_for_owner(unit: &Unit<'_, '_>, key: &mut Key, label: &str) -> Result<()> {
    key.label = label.to_string();
    replace(unit.tx(), key)?;
    unit.audit_also(
        UPDATED,
        "key",
        &key.id,
        Some(json!({ "fields": ["label"] })),
    )
}

pub(crate) fn all_live(tx: &Transaction<'_>, at: &str) -> Result<Vec<Key>> {
    Ok(tx
        .prepare(&format!(
            "{SELECT} WHERE {LIVE} ORDER BY k.created_at, k.id"
        ))?
        .query_map([at], from_row)?
        .collect::<rusqlite::Result<_>>()?)
}

pub async fn revoke(app: &App, caller: &Caller, id: String) -> Result<()> {
    app.write(caller, REVOKED, move |unit| {
        unit.caller.require_recent(&unit.at)?;
        unit.caller.require_key_door()?;
        let key = reached(unit.tx(), &unit.caller, &id, &unit.at)?;
        end(unit, &key.id)
    })
    .await
}

pub async fn list(app: &App, caller: &Caller) -> Result<Vec<Key>> {
    let caller = caller.clone();
    let at = app.clock.stamp();
    app.db
        .read(move |tx| {
            let caller = caller.current(tx, &at)?;
            caller.require_key_door()?;
            let keys = all_live(tx, &at)?;
            Ok(keys.into_iter().filter(|key| caller.reaches(key)).collect())
        })
        .await
}

/// Only a key credential has a current-key answer.
pub async fn current(app: &App, caller: &Caller) -> Result<Option<Map<String, Value>>> {
    reading(app, caller, |read| {
        Ok(match &read.caller {
            Caller::Key(key) => Some(key.to_json()),
            _ => None,
        })
    })
    .await
}

pub async fn authenticate(app: &Arc<App>, token: &str) -> Result<Option<Key>> {
    if !secret::looks_like_a_key(token) {
        return Ok(None);
    }
    let hash = secret::hash(&app.settings.start.key_salt, token)?;
    let at = app.clock.stamp();
    let key = app
        .db
        .read(move |tx| {
            Ok(tx
                .query_row(
                    &format!("{SELECT} WHERE {LIVE} AND k.hash = ?2"),
                    [at, hash],
                    from_row,
                )
                .optional()?)
        })
        .await?;
    if let Some(key) = &key {
        usage::note(app, key);
    }
    Ok(key)
}

pub fn check_id(id: &str) -> Result<()> {
    marfa_rules::validation::id("id", id)
        .map_err(|_| Refusal::validation("id is not a valid key ID."))
}
