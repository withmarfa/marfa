use std::sync::Arc;

use axum::extract::State;
use axum::http::{HeaderMap, HeaderValue, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use serde_json::json;

use super::answer::{Answer, asks_for_html, json_answer};
use super::pages::{self, Notice};
use super::query;
use crate::app::{App, instance};
use crate::settings::registry::MAX_REQUEST_BYTES;

/// A feature is advertised only when its door is served.
const FEATURES: &[(&str, &str)] = &[
    ("items", "GET /items"),
    ("search", "GET /search"),
    ("blobs", "GET /blobs/{hash}"),
    ("types", "GET /types"),
    ("keys", "GET /keys"),
    ("bulk", "POST /items/bulk"),
    ("oauth", "GET /.well-known/oauth-authorization-server/auth"),
    ("owner", "POST /owner"),
    ("extensions", "GET /items/{id}/extensions"),
    ("events", "GET /events"),
    ("type_crud", "POST /types"),
    ("audit", "GET /audit"),
    ("edges", "POST /edges"),
    ("connectors", "GET /connectors"),
    ("inbound_webhooks", "POST /connectors/{id}/endpoints"),
    ("webhooks", "GET /webhooks"),
    ("export", "GET /export"),
    ("metrics", "GET /metrics"),
    ("restore", "POST /restore"),
];

pub(super) const DOCUMENT: &str = include_str!("../../../../openapi.json");

#[cfg(feature = "test-hooks")]
pub async fn document(State(app): State<Arc<App>>) -> Answer {
    if app.settings.start.contract_version.is_none() {
        return Ok(([(header::CONTENT_TYPE, "application/json")], DOCUMENT).into_response());
    }
    let mut document: serde_json::Value = serde_json::from_str(DOCUMENT).map_err(|_| {
        crate::app::refusal::Refusal::internal("the published document did not parse")
    })?;
    document["info"]["version"] = app.contract().to_string().into();
    Ok(json_answer(StatusCode::OK, &document))
}

#[cfg(not(feature = "test-hooks"))]
pub async fn document() -> Answer {
    Ok(([(header::CONTENT_TYPE, "application/json")], DOCUMENT).into_response())
}

async fn answer(app: &App, uri: &Uri, headers: &HeaderMap) -> Answer {
    query::only(uri, &[])?;
    let name = instance::name(app).await?;
    let accept = headers
        .get(header::ACCEPT)
        .and_then(|value| value.to_str().ok());
    if asks_for_html(accept) {
        return Ok(pages::notice(&Notice::running(&name))?.into_response());
    }
    Ok(json_answer(
        StatusCode::OK,
        &json!({
            "name": name,
            "version": instance::VERSION,
            "instance_id": app.instance_id,
            "contract": app.contract(),
            "features": FEATURES.iter().map(|(name, _)| name).collect::<Vec<_>>(),
            "max_request_bytes": app.settings.live().get(MAX_REQUEST_BYTES),
        }),
    ))
}

pub async fn describe(State(app): State<Arc<App>>, uri: Uri, headers: HeaderMap) -> Response {
    let mut response = answer(&app, &uri, &headers).await.into_response();
    response
        .headers_mut()
        .insert(header::VARY, HeaderValue::from_static("Accept"));
    response
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;
    use std::sync::Arc;

    use tempfile::TempDir;

    use super::FEATURES;
    use crate::app::App;
    use crate::http::public_doors;
    use crate::settings::{Environment, Settings};

    #[tokio::test]
    async fn every_feature_names_a_door_the_public_listener_serves() {
        let dir = TempDir::new().unwrap();
        let (database, blobs) = (dir.path().join("marfa.db"), dir.path().join("blobs"));
        let socket = dir.path().join("s.sock");
        let settings = Settings::read(Environment::from_pairs(&[
            ("MARFA_DATABASE_PATH", database.to_str().unwrap()),
            ("MARFA_BLOB_PATH", blobs.to_str().unwrap()),
            ("MARFA_CONTROL_SOCKET", socket.to_str().unwrap()),
        ]))
        .unwrap();
        let app: Arc<App> = App::start(settings).await.unwrap();
        let served: BTreeSet<String> = public_doors(app)
            .served()
            .into_iter()
            .map(|door| format!("{} {}", door.method, door.path))
            .collect();
        let unserved: Vec<_> = FEATURES
            .iter()
            .filter(|(_, door)| !served.contains(*door))
            .collect();
        assert!(unserved.is_empty(), "advertised with no door: {unserved:?}");
        let names: BTreeSet<_> = FEATURES.iter().map(|(name, _)| name).collect();
        assert_eq!(names.len(), FEATURES.len(), "a feature is named twice");
        assert!(
            served.contains("GET /items"),
            "the witness: the table reads"
        );
    }
}
