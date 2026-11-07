//! The type registry, read only: the core's shipped catalog as the server
//! holds it. Open to every credential.

use axum::Router;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::get;
use marfa_core::CoreError;
use serde_json::{Map, Value, json};

use crate::app::App;
use crate::auth::Caller;
use crate::error::{ApiError, ApiResult};
use crate::storage::catalog;

pub fn router() -> Router<App> {
    Router::new()
        .route("/types", get(list))
        .route("/types/{id}", get(read))
        .route("/edge-types", get(list_edge_types))
}

/// Every type this server holds is one Marfa ships.
fn provenance() -> Value {
    json!({ "origin": "platform", "created_by": null })
}

async fn list(State(app): State<App>, _caller: Caller) -> ApiResult<impl IntoResponse> {
    let rows = app.db.read(|conn| Ok(catalog::type_rows(conn)?)).await?;
    let data: Vec<Value> = rows
        .into_iter()
        .map(|mut definition| {
            let own_roles = definition
                .get("roles")
                .cloned()
                .unwrap_or_else(|| json!([]));
            definition.insert("provenance".into(), provenance());
            definition.insert("own_roles".into(), own_roles);
            Value::Object(definition)
        })
        .collect();
    Ok(axum::Json(json!({ "data": data, "next_cursor": null })))
}

async fn read(
    State(app): State<App>,
    _caller: Caller,
    Path(id): Path<String>,
) -> ApiResult<impl IntoResponse> {
    let answer = app
        .db
        .read(move |conn| {
            let resolved = match marfa_core::server::item_type(conn, &id) {
                Ok(resolved) => resolved,
                Err(CoreError::NotFound { .. }) => {
                    return Err(ApiError::new(
                        StatusCode::NOT_FOUND,
                        "type_not_found",
                        format!("No type {id} is registered."),
                    ));
                }
                Err(other) => return Err(other.into()),
            };
            let declared = catalog::type_rows(conn)?
                .into_iter()
                .find(|row| row.get("id").and_then(Value::as_str) == Some(id.as_str()))
                .unwrap_or_default();
            Ok(registered(declared, resolved))
        })
        .await?;
    Ok(axum::Json(answer))
}

/// The type as declared, with what it inherits resolved by the core: every
/// field of its chain, each display hint from the nearest type that sets
/// it, and its plural.
fn registered(mut definition: Map<String, Value>, resolved: marfa_core::ItemType) -> Value {
    let fields: Map<String, Value> = resolved
        .fields
        .into_iter()
        .map(|field| (field.name, field.definition))
        .collect();
    definition.insert("fields".into(), Value::Object(fields));
    let mut hints = Map::new();
    if let Some(title) = resolved.title_field {
        hints.insert("title_field".into(), title.into());
    }
    if let Some(body) = resolved.body_field {
        hints.insert("body_field".into(), body.into());
    }
    hints.insert("name_from_body".into(), resolved.name_from_body.into());
    if let Some(icon) = resolved.icon {
        hints.insert("icon".into(), icon.into());
    }
    definition.insert("display_hints".into(), Value::Object(hints));
    definition.insert("plural".into(), resolved.plural.into());
    definition.insert("roles".into(), json!(resolved.roles));
    definition.insert("provenance".into(), provenance());
    Value::Object(definition)
}

async fn list_edge_types(State(app): State<App>, _caller: Caller) -> ApiResult<impl IntoResponse> {
    let data = app
        .db
        .read(|conn| Ok(catalog::edge_type_rows(conn)?))
        .await?;
    Ok(axum::Json(json!({ "data": data, "next_cursor": null })))
}
