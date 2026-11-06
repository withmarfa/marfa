//! `POST /items` and `GET /items/{id}`.

use axum::Router;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use marfa_core::server as core;
use serde_json::{Map, Value, json};

use crate::app::App;
use crate::auth::{Caller, Level};
use crate::body::JsonBody;
use crate::error::{ApiError, ApiResult};
use crate::storage::items;
use crate::write::{self, ItemWrite, Mode};

const CREATE_FIELDS: [&str; 14] = [
    "type",
    "properties",
    "id",
    "state",
    "occurred_at",
    "source",
    "source_id",
    "mode",
    "version",
    "tier",
    "capture_latitude",
    "capture_longitude",
    "tags",
    "edges",
];

pub fn router() -> Router<App> {
    Router::new()
        .route("/items", post(create))
        .route("/items/{id}", get(read))
}

async fn create(
    State(app): State<App>,
    caller: Caller,
    body: JsonBody,
) -> ApiResult<impl IntoResponse> {
    if caller.key().is_some_and(|key| key.maps.types.is_empty()) {
        return Err(no_content_map());
    }
    let body = body.object(&CREATE_FIELDS).await?;
    let request = read_create(&body)?;
    let written = write::write_item(&app, &caller, request).await?;
    Ok((written.status(), axum::Json(written.to_json())))
}

async fn read(
    State(app): State<App>,
    caller: Caller,
    Path(id): Path<String>,
) -> ApiResult<impl IntoResponse> {
    if caller.key().is_some_and(|key| key.maps.types.is_empty()) {
        return Err(no_content_map());
    }
    core::validate_id("id", &id)?;
    let found = app
        .db
        .read(move |conn| {
            let Some(item) = items::by_id(conn, &id)? else {
                return Ok(None);
            };
            let tags = items::tags(conn, &item.id)?;
            Ok(Some((item, tags)))
        })
        .await?;
    match found {
        Some((item, tags)) if item.is_live() && caller.type_level(&item.type_id) >= Level::Read => {
            Ok(axum::Json(json!({
                "item": item.to_json(),
                "metadata": items::metadata(&item.id, &tags),
            })))
        }
        _ => Err(ApiError::new(
            StatusCode::NOT_FOUND,
            "item_not_found",
            "No item with this id.",
        )),
    }
}

fn no_content_map() -> ApiError {
    ApiError::new(
        StatusCode::FORBIDDEN,
        "type_not_permitted",
        "This key holds no grant on any type.",
    )
}

fn read_create(body: &Map<String, Value>) -> ApiResult<ItemWrite> {
    let type_id = match body.get("type") {
        None | Some(Value::Null) => {
            return Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                "missing_required_field",
                "type: Required field is missing.",
            )
            .with(json!({ "field": "type" })));
        }
        Some(Value::String(type_id)) if well_formed_type(type_id) => type_id.clone(),
        Some(_) => return Err(ApiError::field("type", "Must be a type identifier.")),
    };
    let properties = match body.get("properties") {
        None | Some(Value::Null) => Map::new(),
        Some(Value::Object(properties)) => properties.clone(),
        Some(_) => return Err(ApiError::field("properties", "Must be an object.")),
    };
    let text = |field: &str| -> ApiResult<Option<String>> {
        match body.get(field) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(text)) if !text.is_empty() => Ok(Some(text.clone())),
            Some(_) => Err(ApiError::field(field, "Must be text.")),
        }
    };
    let id = text("id")?;
    if let Some(id) = &id {
        core::validate_id("id", id)?;
    }
    let state = match text("state")?.as_deref() {
        None => None,
        Some(state @ ("active" | "archived")) => Some(state.to_string()),
        Some(_) => return Err(ApiError::field("state", "Must be active or archived.")),
    };
    let occurred_at = match text("occurred_at")? {
        None => None,
        Some(at) => Some(
            core::normalize_time(&at, "occurred_at")
                .map_err(|error| ApiError::from(error).with(json!({ "field": "occurred_at" })))?,
        ),
    };
    let mode = match text("mode")?.as_deref() {
        None | Some("upsert") => Mode::Upsert,
        Some("create_only") => Mode::CreateOnly,
        Some(_) => return Err(ApiError::field("mode", "Must be upsert or create_only.")),
    };
    let tier = match text("tier")?.as_deref() {
        None => None,
        Some(tier @ ("library" | "feed")) => Some(tier.to_string()),
        Some(_) => return Err(ApiError::field("tier", "Must be library or feed.")),
    };
    let coordinate = |field: &str, bound: f64| -> ApiResult<Option<f64>> {
        match body.get(field) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::Number(number)) => match number.as_f64() {
                Some(value) if (-bound..=bound).contains(&value) => Ok(Some(value)),
                _ => Err(ApiError::field(
                    field,
                    format!("Must be between -{bound} and {bound}."),
                )),
            },
            Some(_) => Err(ApiError::field(field, "Must be a number.")),
        }
    };
    let capture_latitude = coordinate("capture_latitude", 90.0)?;
    let capture_longitude = coordinate("capture_longitude", 180.0)?;
    if capture_latitude.is_some() != capture_longitude.is_some() {
        return Err(ApiError::validation(
            "capture_latitude and capture_longitude are given together.",
        ));
    }
    let tags = match body.get("tags") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(values)) => values
            .iter()
            .enumerate()
            .map(|(at, value)| {
                value
                    .as_str()
                    .map(str::to_string)
                    .ok_or_else(|| ApiError::field(&format!("tags[{at}]"), "Must be text."))
            })
            .collect::<ApiResult<_>>()?,
        Some(_) => return Err(ApiError::field("tags", "Must be an array of text.")),
    };
    match body.get("version") {
        None | Some(Value::Null) => {}
        Some(Value::Number(number)) if number.as_u64().is_some_and(|version| version >= 1) => {}
        Some(_) => {
            return Err(ApiError::field(
                "version",
                "Must be a positive whole number.",
            ));
        }
    }
    match body.get("edges") {
        None | Some(Value::Null) => {}
        Some(Value::Object(edges)) if edges.is_empty() => {}
        Some(_) => {
            return Err(ApiError::field(
                "edges",
                "This server does not write edges yet.",
            ));
        }
    }
    Ok(ItemWrite {
        type_id,
        properties,
        id,
        state,
        occurred_at,
        source: text("source")?,
        source_id: text("source_id")?,
        mode,
        tier,
        capture_latitude,
        capture_longitude,
        tags,
    })
}

/// Lowercase dotted segments, each starting with a letter.
fn well_formed_type(type_id: &str) -> bool {
    !type_id.is_empty()
        && type_id.split('.').all(|segment| {
            segment.starts_with(|c: char| c.is_ascii_lowercase())
                && segment
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
        })
}
