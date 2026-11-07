//! `/config` as a person or an app meets it: rules across settings, the
//! confirmation a changed sign-in address asks for, and what the settings list
//! leaves out. The contract's fixtures hold the rest.

use std::sync::Arc;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Method, Request, StatusCode, header};
use marfa_server::app::access::Caller;
use marfa_server::app::{App, instance};
use marfa_server::db::Write;
use marfa_server::http::control;
use marfa_server::settings::registry::MAX_REQUEST_BYTES;
use marfa_server::settings::{Environment, Settings};
use serde_json::{Value, json};
use tempfile::TempDir;
use tower::ServiceExt;

struct Instance {
    _dir: TempDir,
    app: Arc<App>,
    control: Router,
}

struct Reply {
    status: StatusCode,
    body: Value,
    text: String,
}

impl Reply {
    fn code(&self) -> &str {
        self.body["error"]["code"].as_str().unwrap_or("")
    }

    fn error_paths(&self) -> Vec<String> {
        self.body["error"]["details"]["errors"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|entry| entry["path"].as_str().map(str::to_string))
            .collect()
    }
}

impl Instance {
    async fn start(extra: &[(&str, &str)]) -> Instance {
        let dir = TempDir::new().unwrap();
        let database = dir.path().join("marfa.db");
        let blobs = dir.path().join("blobs");
        let socket = dir.path().join("s.sock");
        let mut pairs = vec![
            ("SQLITE_PATH", database.to_str().unwrap()),
            ("BLOB_PATH", blobs.to_str().unwrap()),
            ("MARFA_CONTROL_SOCKET", socket.to_str().unwrap()),
            ("RATE_LIMIT_ENABLED", "false"),
        ];
        pairs.extend_from_slice(extra);
        let settings = Settings::read(Environment::from_pairs(&pairs)).unwrap();
        let app = App::start(settings).await.unwrap();
        Instance {
            _dir: dir,
            control: control(app.clone()),
            app,
        }
    }

    async fn call(&self, method: Method, path: &str, body: Option<Value>) -> Reply {
        let mut builder = Request::builder().method(method).uri(path);
        let body = match body {
            Some(body) => {
                builder = builder.header(header::CONTENT_TYPE, "application/json");
                Body::from(body.to_string())
            }
            None => Body::empty(),
        };
        let response = self
            .control
            .clone()
            .oneshot(builder.body(body).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let text = String::from_utf8_lossy(&bytes).into_owned();
        Reply {
            status,
            body: serde_json::from_slice(&bytes).unwrap_or(Value::Null),
            text,
        }
    }

    async fn patch(&self, body: Value) -> Reply {
        self.call(Method::PATCH, "/config", Some(body)).await
    }

    async fn config(&self) -> Value {
        self.call(Method::GET, "/config", None).await.body
    }
}

#[tokio::test]
async fn a_clear_that_exposes_a_default_breaking_a_rule_is_refused_and_changes_nothing() {
    let instance = Instance::start(&[]).await;
    let windows = json!({
        "version_recent_days": 10,
        "version_daily_snapshot_days": 20,
        "version_weekly_snapshot_days": 30,
    });
    assert_eq!(instance.patch(windows).await.status, StatusCode::OK);
    let held = instance.config().await;

    let order = instance.patch(json!({ "version_recent_days": 25 })).await;
    assert_eq!(order.code(), "validation_error");
    assert_eq!(order.error_paths(), ["version_daily_snapshot_days"]);

    // The default 90 that clearing the daily window exposes is past the weekly 30.
    let exposed = instance
        .patch(json!({ "version_daily_snapshot_days": null }))
        .await;
    assert_eq!(exposed.error_paths(), ["version_weekly_snapshot_days"]);
    assert_eq!(instance.config().await, held);
}

#[tokio::test]
async fn reporting_is_turned_on_only_where_a_receiver_is_set() {
    let bare = Instance::start(&[]).await;
    for field in ["heartbeat_enabled", "error_reporting_enabled"] {
        let refused = bare.patch(json!({ field: true })).await;
        assert_eq!(refused.error_paths(), [field], "{field}");
        assert_eq!(
            bare.patch(json!({ field: false })).await.status,
            StatusCode::OK
        );
    }
    let heard = Instance::start(&[("MARFA_HEARTBEAT_URL", "https://beat.example/x")]).await;
    assert_eq!(
        heard
            .patch(json!({ "heartbeat_enabled": true }))
            .await
            .status,
        StatusCode::OK
    );
}

#[tokio::test]
async fn a_value_of_the_wrong_kind_or_size_is_named_and_a_null_in_a_put_is_refused() {
    let instance = Instance::start(&[]).await;
    for (field, value) in [
        ("max_request_bytes", json!("30")),
        ("max_request_bytes", json!(9_007_199_254_740_993_u64)),
        ("max_request_bytes", json!(1.5)),
        ("rate_limit_enabled", json!("yes")),
        ("addresses", json!("https://a.example")),
        ("audit_retention_days", json!(null)),
    ] {
        let refused = instance
            .call(Method::PUT, "/config", Some(json!({ field: value })))
            .await;
        assert_eq!(refused.code(), "validation_error", "{field}");
        assert_eq!(refused.error_paths(), [field], "{field}");
    }
    let stale = instance
        .call(
            Method::PUT,
            "/config",
            Some(json!({ "instance_id": "someone-else" })),
        )
        .await;
    assert_eq!(stale.error_paths(), ["instance_id"]);
}

#[tokio::test]
async fn a_setting_whose_area_is_not_built_is_not_known() {
    let instance = Instance::start(&[]).await;
    let refused = instance
        .patch(json!({
            "inbound_handled_retention_days": 5,
            "grant_inactivity_days": 0,
            "enrichment_enabled": false,
        }))
        .await;
    assert_eq!(
        refused.body["error"]["details"]["unknown_body_fields"],
        json!([
            "enrichment_enabled",
            "grant_inactivity_days",
            "inbound_handled_retention_days"
        ])
    );
}

#[tokio::test]
async fn two_patches_at_once_both_land() {
    let instance = Instance::start(&[]).await;
    let (first, second) = tokio::join!(
        instance.patch(json!({ "audit_retention_days": 31 })),
        instance.patch(json!({ "trash_retention_days": 30 })),
    );
    assert_eq!(
        (first.status, second.status),
        (StatusCode::OK, StatusCode::OK)
    );
    let held = instance.config().await;
    assert_eq!(
        (
            held["audit_retention_days"].clone(),
            held["trash_retention_days"].clone()
        ),
        (json!(31), json!(30))
    );
}

#[tokio::test]
async fn a_sign_in_change_on_a_claimed_instance_asks_first_and_a_tidier_spelling_does_not() {
    let instance = Instance::start(&[]).await;
    // The first write of the setting needs no confirmation, even once claimed.
    instance::claim(&instance.app, &Caller::Local)
        .await
        .unwrap();
    let first = instance
        .patch(json!({ "sign_in_address": "https://a.example" }))
        .await;
    assert_eq!(first.status, StatusCode::OK, "{}", first.text);
    assert_eq!(first.body["addresses"], json!(["https://a.example"]));

    let same = instance
        .patch(json!({ "sign_in_address": "HTTPS://A.Example:443/" }))
        .await;
    assert_eq!(same.status, StatusCode::OK, "{}", same.text);
    assert_eq!(same.body["sign_in_address"], "https://a.example");

    let asked = instance
        .patch(json!({ "sign_in_address": "https://b.example" }))
        .await;
    assert_eq!(asked.status, StatusCode::CONFLICT);
    assert_eq!(asked.code(), "sign_in_address_change_unconfirmed");
    let codes: Vec<_> = asked.body["error"]["details"]["consequences"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["code"].as_str().unwrap())
        .collect();
    assert_eq!(
        codes,
        [
            "browser_sessions_end",
            "passkeys_unusable",
            "apps_sign_in_again"
        ]
    );
    assert_eq!(
        instance.config().await["sign_in_address"],
        "https://a.example"
    );

    let confirmed = instance
        .patch(json!({
            "sign_in_address": "https://b.example",
            "confirm_sign_in_address_change": true,
        }))
        .await;
    assert_eq!(confirmed.status, StatusCode::OK, "{}", confirmed.text);
    assert_eq!(
        confirmed.body["addresses"],
        json!(["https://a.example", "https://b.example"])
    );
    assert_eq!(
        instance.app.addresses().sign_in().origin(),
        "https://b.example"
    );
}

#[tokio::test]
async fn an_address_check_says_what_would_happen_and_writes_nothing() {
    let instance = Instance::start(&[]).await;
    instance::claim(&instance.app, &Caller::Local)
        .await
        .unwrap();
    instance
        .patch(json!({ "sign_in_address": "https://a.example" }))
        .await;
    let held = instance.config().await;
    let audited = audit_rows(&instance).await;

    let checked = instance
        .call(
            Method::POST,
            "/config/address-check",
            Some(json!({ "sign_in_address": "https://b.example", "addresses": ["https://b.example"] })),
        )
        .await;
    assert_eq!(checked.status, StatusCode::OK, "{}", checked.text);
    assert_eq!(checked.body["requires_confirmation"], true);
    let codes: Vec<_> = checked.body["consequences"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["code"].as_str().unwrap())
        .collect();
    assert!(codes.contains(&"address_removed"), "{codes:?}");
    assert!(checked.body["consequences"][0]["count"].is_null());

    assert_eq!(instance.config().await, held);
    assert_eq!(audit_rows(&instance).await, audited);
    assert_eq!(
        instance.app.addresses().sign_in().origin(),
        "https://a.example"
    );
}

async fn audit_rows(instance: &Instance) -> i64 {
    instance
        .app
        .db
        .read(|tx| Ok(tx.query_row("SELECT count(*) FROM audit_log", [], |row| row.get(0))?))
        .await
        .unwrap()
}

#[tokio::test]
async fn the_settings_list_never_prints_a_secret_and_shows_a_row_that_no_longer_reads() {
    let secret = "salt-that-must-not-print";
    let hook = "https://hooks.example/token-that-must-not-print";
    let instance = Instance::start(&[("API_KEY_SALT", secret), ("ERROR_WEBHOOK_URL", hook)]).await;

    instance
        .app
        .db
        .write(Write::own(), |tx| {
            tx.execute(
                "INSERT INTO settings (key, value) VALUES ('audit_retention_days', 'soon')",
                [],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    let rows = instance
        .app
        .db
        .read(marfa_server::app::stored::rows)
        .await
        .unwrap();
    instance.app.settings.apply_stored(&rows);

    let listed = instance.call(Method::GET, "/config/settings", None).await;
    assert_eq!(listed.status, StatusCode::OK, "{}", listed.text);
    assert!(!listed.text.contains(secret) && !listed.text.contains("token-that-must-not-print"));
    let named = |name: &str| {
        listed.body["start_only"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["name"] == name)
            .cloned()
            .unwrap()
    };
    assert_eq!(named("API_KEY_SALT")["set"], true);
    assert_eq!(named("MARFA_HEARTBEAT_URL")["set"], false);

    let line = listed.body["data"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["key"] == "audit_retention_days")
        .cloned()
        .unwrap();
    assert_eq!(line["unreadable"], true);
    assert_eq!(line["stored"], "soon");
    assert_eq!(line["value"], 90);

    let mended = instance.patch(json!({ "audit_retention_days": 31 })).await;
    assert_eq!(mended.status, StatusCode::OK, "{}", mended.text);
    let listed = instance.call(Method::GET, "/config/settings", None).await;
    let line = listed.body["data"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["key"] == "audit_retention_days")
        .unwrap();
    assert!(line.get("unreadable").is_none());
    assert_eq!(
        (line["stored"].clone(), line["value"].clone()),
        (json!(31), json!(31))
    );
}

#[tokio::test]
async fn a_commit_that_failed_reads_the_live_settings_again_from_the_database() {
    let instance = Instance::start(&[]).await;
    // A row the database holds and the live settings do not, as a commit that
    // landed without being acknowledged would leave.
    instance
        .app
        .db
        .write(Write::own(), |tx| {
            tx.execute(
                "INSERT INTO settings (key, value) VALUES ('max_request_bytes', '2048')",
                [],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    assert_eq!(
        instance.app.settings.live().get(MAX_REQUEST_BYTES),
        1_048_576
    );

    let faults = &instance.app.faults;
    faults.set("fail:commit", Some("config.update")).unwrap();
    let unknown = instance.patch(json!({ "audit_retention_days": 31 })).await;
    assert_eq!(unknown.status, StatusCode::INTERNAL_SERVER_ERROR);
    faults.clear(None);

    assert_eq!(instance.app.settings.live().get(MAX_REQUEST_BYTES), 2048);
    assert!(
        instance
            .config()
            .await
            .get("audit_retention_days")
            .is_none()
    );
}
