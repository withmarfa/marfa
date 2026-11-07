//! Who is asking: a key named by `Authorization: Bearer`, or the private
//! local command on the control socket, which holds every permission.

use axum::extract::FromRequestParts;
use axum::http::header::AUTHORIZATION;
use axum::http::request::Parts;
use hmac::{Hmac, KeyInit, Mac};
use serde_json::{Map, Value, json};
use sha2::Sha256;

use crate::app::App;
use crate::clock;
use crate::error::{ApiError, ApiResult};
use crate::observe::{RequestContext, Transport};
use crate::storage::keys::{self, Key};

/// Every permission a key may hold, in the contract's order.
pub const PERMISSIONS: [&str; 12] = [
    "audit.read",
    "blobs.manage",
    "config.manage",
    "connectors.manage",
    "grants.manage",
    "instance.maintain",
    "instance.read",
    "items.purge",
    "keys.manage",
    "keys.mint",
    "schema.write",
    "webhooks.manage",
];

const KEY_PREFIX: &str = "marfa_k1_";

pub enum Caller {
    /// The private local command, on the control socket with no key.
    Local,
    Key(Box<Key>),
}

impl FromRequestParts<App> for Caller {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, app: &App) -> Result<Caller, ApiError> {
        let context = parts.extensions.get::<RequestContext>().cloned();
        let transport = context
            .as_ref()
            .map_or(Transport::Http, |context| context.transport);
        let Some(token) = bearer(parts) else {
            return match transport {
                Transport::LocalSocket => Ok(Caller::Local),
                Transport::Http => Err(ApiError::unauthorized()),
            };
        };
        if !token.starts_with(KEY_PREFIX) {
            return Err(ApiError::unauthorized());
        }
        let hash = hash_key(app.settings.api_key_salt.as_deref(), &token);
        let now = clock::now_stamp();
        let key = app
            .db
            .read(move |conn| Ok(keys::by_hash(conn, &hash, &now)?))
            .await?
            .ok_or_else(ApiError::unauthorized)?;
        if let Some(context) = context {
            let _ = context.notes.key_id.set(key.id.clone());
        }
        Ok(Caller::Key(Box::new(key)))
    }
}

fn bearer(parts: &Parts) -> Option<String> {
    let value = parts.headers.get(AUTHORIZATION)?.to_str().ok()?.trim();
    let (scheme, token) = value.split_once(' ')?;
    (scheme.eq_ignore_ascii_case("bearer") && !token.trim().is_empty())
        .then(|| token.trim().to_string())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Level {
    None,
    Read,
    Write,
}

impl Level {
    pub fn parse(word: &str) -> Option<Level> {
        match word {
            "none" => Some(Level::None),
            "read" => Some(Level::Read),
            "write" => Some(Level::Write),
            _ => None,
        }
    }

    pub fn word(self) -> &'static str {
        match self {
            Level::None => "none",
            Level::Read => "read",
            Level::Write => "write",
        }
    }
}

impl Caller {
    pub fn key(&self) -> Option<&Key> {
        match self {
            Caller::Local => None,
            Caller::Key(key) => Some(key),
        }
    }

    /// Refuses a key that lacks `permission`. The local command holds all.
    pub fn require(&self, permission: &'static str) -> ApiResult<()> {
        match self {
            Caller::Local => Ok(()),
            Caller::Key(key) if key.permissions.iter().any(|held| held == permission) => Ok(()),
            Caller::Key(_) => Err(ApiError::forbidden(format!(
                "This operation requires the {permission} permission."
            ))
            .with(json!({ "required_scope": permission }))),
        }
    }

    pub fn type_level(&self, type_id: &str) -> Level {
        match self {
            Caller::Local => Level::Write,
            Caller::Key(key) => type_level(&key.maps.types, type_id),
        }
    }

    /// Refuses where the caller's grant on `type_id` is below `level`.
    pub fn require_type(&self, type_id: &str, level: Level) -> ApiResult<()> {
        if self.type_level(type_id) >= level {
            return Ok(());
        }
        Err(ApiError::new(
            axum::http::StatusCode::FORBIDDEN,
            "type_not_permitted",
            format!(
                "This credential may not {} items of type {type_id}.",
                level.word()
            ),
        )
        .with(json!({ "grant": { "kind": "type", "name": type_id, "level": level.word() } })))
    }
}

/// A type map's level for `type_id`: the exact entry, else the longest
/// subtree wildcard (`a.b.*` covers `a.b` and every type under it), else
/// `*`. A pattern names its own subtree root the same way.
pub fn type_level(map: &Map<String, Value>, type_id: &str) -> Level {
    let level = |value: &Value| value.as_str().and_then(Level::parse);
    if let Some(found) = map.get(type_id).and_then(level) {
        return found;
    }
    let root = type_id.strip_suffix(".*").unwrap_or(type_id);
    map.iter()
        .filter_map(|(pattern, value)| {
            let covered = pattern.strip_suffix(".*")?;
            let covers = root == covered
                || root
                    .strip_prefix(covered)
                    .is_some_and(|rest| rest.starts_with('.'));
            covers.then(|| (covered.len(), level(value)))
        })
        .max_by_key(|(length, _)| *length)
        .and_then(|(_, found)| found)
        .or_else(|| map.get("*").and_then(level))
        .unwrap_or(Level::None)
}

/// A flat map's level for `name`: the exact entry, else `*`.
pub fn flat_level(map: &Map<String, Value>, name: &str) -> Level {
    let level = |value: &Value| value.as_str().and_then(Level::parse);
    map.get(name)
        .and_then(level)
        .or_else(|| map.get("*").and_then(level))
        .unwrap_or(Level::None)
}

pub fn hash_key(salt: Option<&str>, key: &str) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(salt.unwrap_or("").as_bytes())
        .expect("HMAC takes a key of any length");
    mac.update(key.as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

pub fn new_key() -> Result<String, ApiError> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|error| ApiError::internal(format!("no randomness: {error}")))?;
    Ok(format!("{KEY_PREFIX}{}", hex::encode(bytes)))
}
