//! A throwaway instance the router tests send requests to.

use std::sync::Arc;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::extract::Request;
use axum::http::{Method, header};
use serde_json::{Value, json};
use tempfile::TempDir;
use tower::ServiceExt;

use super::{control, public};
use crate::app::App;
use crate::settings::{Environment, Settings};

pub struct Instance {
    _dir: TempDir,
    pub app: Arc<App>,
    pub public: Router,
    pub control: Router,
    /// A key holding no permission.
    pub key: String,
}

pub async fn start() -> Instance {
    let dir = TempDir::new().unwrap();
    let (database, blobs) = (dir.path().join("marfa.db"), dir.path().join("blobs"));
    let socket = dir.path().join("s.sock");
    let settings = Settings::read(Environment::from_pairs(&[
        ("MARFA_DATABASE_PATH", database.to_str().unwrap()),
        ("MARFA_BLOB_PATH", blobs.to_str().unwrap()),
        ("MARFA_CONTROL_SOCKET", socket.to_str().unwrap()),
        ("MARFA_RATE_LIMIT_ENABLED", "false"),
    ]))
    .unwrap();
    let app = App::start(settings).await.unwrap();
    let private = control(app.clone());
    let minted = private
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/keys")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({"label": "bare", "source": "bare", "permissions": []}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let bytes = to_bytes(minted.into_body(), usize::MAX).await.unwrap();
    let key = serde_json::from_slice::<Value>(&bytes).unwrap()["key"]
        .as_str()
        .unwrap()
        .to_owned();
    Instance {
        _dir: dir,
        public: public(app.clone()),
        control: private,
        app,
        key,
    }
}
