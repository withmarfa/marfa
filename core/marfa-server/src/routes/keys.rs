//! API keys: mint, list, read the caller's own, revoke.

use axum::Router;
use axum::extract::{Path, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use rusqlite::TransactionBehavior;
use serde_json::{Map, Value, json};

use crate::app::App;
use crate::auth::{self, Caller, Level, PERMISSIONS};
use crate::body::JsonBody;
use crate::clock;
use crate::error::{ApiError, ApiResult};
use crate::storage::keys::{self, Key, Maps};
use crate::write::audit;

const MINT_FIELDS: [&str; 12] = [
    "label",
    "source",
    "sources",
    "permissions",
    "default_tier",
    "type_permissions",
    "edge_permissions",
    "extension_permissions",
    "metadata_permissions",
    "profile_permissions",
    "enforcement_override",
    "expires_at",
];

const MAX_CLAIMS: usize = 1000;
const MAX_CLAIM_LENGTH: usize = 200;
const MAX_LABEL_LENGTH: usize = 200;

pub fn router() -> Router<App> {
    Router::new()
        .route("/keys", post(mint).get(list))
        .route("/keys/current", get(current))
        .route("/keys/{id}", delete(revoke))
}

/// One permission map in a mint's body: its field, the axis a refusal
/// names, and the levels it takes.
struct MapField {
    field: &'static str,
    axis: &'static str,
    takes_none: bool,
}

const MAP_FIELDS: [MapField; 5] = [
    MapField {
        field: "type_permissions",
        axis: "type",
        takes_none: true,
    },
    MapField {
        field: "edge_permissions",
        axis: "edge",
        takes_none: false,
    },
    MapField {
        field: "extension_permissions",
        axis: "extension",
        takes_none: false,
    },
    MapField {
        field: "metadata_permissions",
        axis: "metadata",
        takes_none: false,
    },
    MapField {
        field: "profile_permissions",
        axis: "profile",
        takes_none: false,
    },
];

fn map_of<'a>(maps: &'a Maps, field: &str) -> &'a Map<String, Value> {
    match field {
        "type_permissions" => &maps.types,
        "edge_permissions" => &maps.edges,
        "extension_permissions" => &maps.extensions,
        "metadata_permissions" => &maps.metadata,
        _ => &maps.profile,
    }
}

fn map_of_mut<'a>(maps: &'a mut Maps, field: &str) -> &'a mut Map<String, Value> {
    match field {
        "type_permissions" => &mut maps.types,
        "edge_permissions" => &mut maps.edges,
        "extension_permissions" => &mut maps.extensions,
        "metadata_permissions" => &mut maps.metadata,
        _ => &mut maps.profile,
    }
}

async fn mint(State(app): State<App>, caller: Caller, body: JsonBody) -> ApiResult<Response> {
    caller.require("keys.mint")?;
    let body = body.object(&MINT_FIELDS).await?;
    let request = MintRequest::read(&body)?;
    let creator = caller.key().cloned();

    let named_any = request.permissions.is_some()
        || request.sources.is_some()
        || request.maps.iter().any(Option::is_some);
    let (permissions, mut maps, sources) = match (&creator, named_any) {
        (None, false) => (
            PERMISSIONS.iter().map(|p| p.to_string()).collect(),
            Maps::everything(),
            Vec::new(),
        ),
        (Some(creator), false) => (
            creator.permissions.clone(),
            creator.maps.clone(),
            creator.sources.clone(),
        ),
        (_, true) => (
            request.permissions.clone().unwrap_or_default(),
            Maps::default(),
            request.sources.clone().unwrap_or_default(),
        ),
    };
    if named_any {
        for (spec, map) in MAP_FIELDS.iter().zip(&request.maps) {
            *map_of_mut(&mut maps, spec.field) = map.clone().unwrap_or_default();
        }
    }

    if let Some(creator) = &creator {
        refuse_beyond(creator, &permissions, &maps, &sources, &request)?;
    }

    let plaintext = auth::new_key()?;
    let hash = auth::hash_key(app.settings.api_key_salt.as_deref(), &plaintext);
    let key = Key {
        id: uuid::Uuid::now_v7().to_string(),
        label: request.label,
        source: request.source,
        sources,
        permissions,
        default_tier: request.default_tier.unwrap_or_else(|| "library".into()),
        maps,
        created_at: clock::now_stamp(),
        expires_at: request.expires_at,
        last_used_at: None,
    };
    let actor = creator
        .as_ref()
        .map_or_else(|| "local".to_string(), |creator| creator.id.clone());
    let key = app
        .db
        .write(move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            if keys::source_taken(&tx, &key.source)? {
                return Err(ApiError::conflict(
                    "conflict",
                    format!(
                        "A live key already writes under the source \"{}\".",
                        key.source
                    ),
                )
                .with(json!({ "source": key.source })));
            }
            keys::insert(&tx, &key, &hash)?;
            audit(
                &tx,
                "key.mint",
                &actor,
                "api_key",
                &key.id,
                json!({ "label": key.label, "source": key.source }),
            )?;
            tx.commit()?;
            Ok(key)
        })
        .await?;
    let mut answer = key.to_json();
    answer["key"] = plaintext.into();
    let mut response = (StatusCode::CREATED, axum::Json(answer)).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(response)
}

/// A mint by a key may give no more than that key holds.
fn refuse_beyond(
    creator: &Key,
    permissions: &[String],
    maps: &Maps,
    sources: &[String],
    request: &MintRequest,
) -> ApiResult<()> {
    if let Some(beyond) = permissions
        .iter()
        .find(|permission| !creator.permissions.contains(permission))
    {
        return Err(beyond_reach(beyond));
    }
    for spec in &MAP_FIELDS {
        let held = map_of(&creator.maps, spec.field);
        let requested = map_of(maps, spec.field);
        let level = |map: &Map<String, Value>, name: &str| {
            if spec.axis == "type" {
                auth::type_level(map, name)
            } else {
                auth::flat_level(map, name)
            }
        };
        // Each name either map names: a `none` the creator holds is a
        // denial a wider wildcard asked for must not lift.
        for name in requested.keys().chain(held.keys()) {
            let asked = level(requested, name);
            if asked > level(held, name) {
                return Err(beyond_reach(&format!(
                    "{}:{name}:{}",
                    spec.axis,
                    asked.word()
                )));
            }
        }
    }
    let grantable = |source: &String| *source == creator.source || creator.sources.contains(source);
    if let Some(beyond) = sources.iter().find(|source| !grantable(source)) {
        return Err(ApiError::forbidden(format!(
            "This credential does not claim the source \"{beyond}\", so it cannot give a key a source it may not write under itself."
        ))
        .with(json!({ "source": beyond })));
    }
    if let (Some(asked), Some(held)) = (&request.expires_at, &creator.expires_at)
        && asked > held
    {
        return Err(ApiError::forbidden(
            "A key cannot outlive the key that mints it.",
        ));
    }
    Ok(())
}

fn beyond_reach(scope: &str) -> ApiError {
    ApiError::forbidden(format!(
        "This credential does not hold {scope}, so it cannot give a key reach it does not hold itself."
    ))
    .with(json!({ "required_scope": scope }))
}

struct MintRequest {
    label: String,
    source: String,
    sources: Option<Vec<String>>,
    permissions: Option<Vec<String>>,
    default_tier: Option<String>,
    maps: [Option<Map<String, Value>>; 5],
    expires_at: Option<String>,
}

impl MintRequest {
    fn read(body: &Map<String, Value>) -> ApiResult<MintRequest> {
        let mut errors: Vec<Value> = Vec::new();
        let mut refuse = |path: &str, message: &str| {
            errors.push(json!({ "path": path, "message": message }));
        };
        let text = |field: &str| body.get(field).and_then(Value::as_str).map(str::trim);

        let label = match text("label") {
            Some(label) if !label.is_empty() && label.chars().count() <= MAX_LABEL_LENGTH => {
                label.to_string()
            }
            _ => {
                refuse("label", "Must be text of 1 to 200 characters.");
                String::new()
            }
        };
        let source = match text("source") {
            Some(source) if !source.is_empty() && source.chars().count() <= MAX_CLAIM_LENGTH => {
                source.to_string()
            }
            _ => {
                refuse("source", "Must be text of 1 to 200 characters.");
                String::new()
            }
        };
        let permissions = match body.get("permissions") {
            None => None,
            Some(Value::Array(values)) => {
                let mut held = Vec::new();
                for (at, value) in values.iter().enumerate() {
                    match value.as_str() {
                        Some(permission) if PERMISSIONS.contains(&permission) => {
                            if !held.iter().any(|p: &String| p == permission) {
                                held.push(permission.to_string());
                            }
                        }
                        _ => refuse(&format!("permissions[{at}]"), "Not a permission."),
                    }
                }
                Some(held)
            }
            Some(_) => {
                refuse("permissions", "Must be an array of permissions.");
                None
            }
        };
        let sources = match body.get("sources") {
            None => None,
            Some(Value::Array(values)) => {
                if values.len() > MAX_CLAIMS {
                    refuse("sources", "Must hold at most 1000 sources.");
                }
                let mut claims: Vec<String> = Vec::new();
                for (at, value) in values.iter().enumerate() {
                    let claim = value.as_str().map(str::trim).unwrap_or("");
                    let lowered = claim.to_ascii_lowercase();
                    if claim.is_empty() || claim.chars().count() > MAX_CLAIM_LENGTH {
                        refuse(
                            &format!("sources[{at}]"),
                            "Must be text of 1 to 200 characters.",
                        );
                    } else if lowered.starts_with("oauth:") || lowered.starts_with("restored:") {
                        refuse(
                            &format!("sources[{at}]"),
                            "Sources starting oauth: or restored: are the server's own.",
                        );
                    } else if !claims.iter().any(|held| held == claim) {
                        claims.push(claim.to_string());
                    }
                }
                Some(claims)
            }
            Some(_) => {
                refuse("sources", "Must be an array of sources.");
                None
            }
        };
        let default_tier = match body.get("default_tier") {
            None | Some(Value::Null) => None,
            Some(Value::String(tier)) if tier == "library" || tier == "feed" => Some(tier.clone()),
            Some(_) => {
                refuse("default_tier", "Must be library or feed.");
                None
            }
        };
        let mut maps: [Option<Map<String, Value>>; 5] = Default::default();
        for (spec, slot) in MAP_FIELDS.iter().zip(maps.iter_mut()) {
            match body.get(spec.field) {
                None => {}
                Some(Value::Object(entries)) => {
                    for (name, level) in entries {
                        let taken = level
                            .as_str()
                            .and_then(Level::parse)
                            .is_some_and(|level| level != Level::None || spec.takes_none);
                        if !taken {
                            let levels = if spec.takes_none {
                                "read, write or none"
                            } else {
                                "read or write"
                            };
                            refuse(
                                &format!("{}.{name}", spec.field),
                                &format!("Must be {levels}."),
                            );
                        }
                    }
                    *slot = Some(entries.clone());
                }
                Some(_) => refuse(spec.field, "Must be an object of levels."),
            }
        }
        if body.contains_key("enforcement_override") {
            refuse(
                "enforcement_override",
                "This server does not serve enforcement overrides yet.",
            );
        }
        let expires_at = match body.get("expires_at") {
            None | Some(Value::Null) => None,
            Some(Value::String(at)) => match marfa_core::server::normalize_time(at, "expires_at") {
                Ok(at) if at > clock::now_stamp() => Some(at),
                _ => {
                    refuse("expires_at", "Must be a time ahead of now.");
                    None
                }
            },
            Some(_) => {
                refuse("expires_at", "Must be a time ahead of now.");
                None
            }
        };
        if !errors.is_empty() {
            let message = errors
                .iter()
                .map(|error| {
                    format!(
                        "{}: {}",
                        error["path"].as_str().unwrap_or(""),
                        error["message"].as_str().unwrap_or("")
                    )
                })
                .collect::<Vec<_>>()
                .join("; ");
            return Err(ApiError::validation(message).with(json!({ "errors": errors })));
        }
        Ok(MintRequest {
            label,
            source,
            sources,
            permissions,
            default_tier,
            maps,
            expires_at,
        })
    }
}

fn require_key_reader(caller: &Caller) -> ApiResult<()> {
    if caller.require("keys.manage").is_ok() {
        return Ok(());
    }
    caller.require("keys.mint").map_err(|_| {
        ApiError::forbidden("This operation requires the keys.manage or keys.mint permission.")
            .with(json!({ "required_scope": "keys.manage" }))
    })
}

async fn list(State(app): State<App>, caller: Caller) -> ApiResult<impl IntoResponse> {
    require_key_reader(&caller)?;
    let live = app.db.read(|conn| Ok(keys::live(conn)?)).await?;
    let data: Vec<Value> = live.iter().map(Key::to_json).collect();
    Ok(axum::Json(json!({ "data": data, "next_cursor": null })))
}

async fn current(caller: Caller) -> ApiResult<impl IntoResponse> {
    let Some(key) = caller.key() else {
        return Err(ApiError::validation(
            "The local command carries no key; send one with Authorization: Bearer.",
        ));
    };
    Ok(axum::Json(json!({
        "id": key.id,
        "source": key.source,
        "sources": key.sources,
        "permissions": key.permissions,
        "default_tier": key.default_tier,
        "type_permissions": key.maps.types,
        "edge_permissions": key.maps.edges,
        "extension_permissions": key.maps.extensions,
        "metadata_permissions": key.maps.metadata,
        "profile_permissions": key.maps.profile,
    })))
}

async fn revoke(
    State(app): State<App>,
    caller: Caller,
    Path(id): Path<String>,
) -> ApiResult<impl IntoResponse> {
    require_key_reader(&caller)?;
    marfa_core::server::validate_id("id", &id)?;
    let actor = caller
        .key()
        .map_or_else(|| "local".to_string(), |key| key.id.clone());
    app.db
        .write(move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            if !keys::revoke(&tx, &id, &clock::now_stamp())? {
                return Err(ApiError::new(
                    StatusCode::NOT_FOUND,
                    "api_key_not_found",
                    "No live key has this id.",
                ));
            }
            audit(&tx, "key.revoke", &actor, "api_key", &id, json!({}))?;
            tx.commit()?;
            Ok(())
        })
        .await?;
    Ok(axum::Json(json!({ "ok": true })))
}
