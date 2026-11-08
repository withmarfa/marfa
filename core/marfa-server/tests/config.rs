//! `/config` as a person or an app meets it: rules across settings, the confirmation a
//! changed sign-in address asks for, and what the settings list leaves out.

use std::sync::Arc;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Method, Request, StatusCode, header};
use marfa_server::app::auth::configured_origins;
use marfa_server::app::{App, instance, stored};
use marfa_server::db::Write;
use marfa_server::http::{control, public};
use marfa_server::settings::registry::MAX_REQUEST_BYTES;
use marfa_server::settings::{Environment, Settings};
use serde_json::{Value, json};
use tempfile::TempDir;
use tower::ServiceExt;

struct Instance {
    _dir: TempDir,
    app: Arc<App>,
    control: Router,
    public: Router,
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
    async fn claim(&self) {
        self.app
            .db
            .write(Write::own(), |tx| {
                instance::mark_claimed(tx, "2026-01-01T00:00:00.000Z", "owner")
            })
            .await
            .unwrap();
    }

    async fn claim_with(&self, sessions: u32, apps: u32) {
        let now = self.app.clock.now_ms() / 1000;
        self.app
            .db
            .write(Write::own(), move |tx| {
                tx.execute(
                    "INSERT INTO auth_user (id, name, email, created_at, updated_at) \
                     VALUES ('owner', 'Owner', 'owner@example.com', 1, 1)",
                    [],
                )?;
                instance::mark_claimed(tx, "2026-01-01T00:00:00.000Z", "owner")?;
                let session = |id: String, expires_at: i64| {
                    tx.execute(
                        "INSERT INTO auth_session \
                         (id, token, user_id, created_at, updated_at, expires_at) \
                         VALUES (?1, ?1, 'owner', 1, 1, ?2)",
                        rusqlite::params![id, expires_at],
                    )
                };
                let consent = |id: String, withdrawn_at: Option<i64>| {
                    tx.execute(
                        "INSERT INTO auth_oauth_client (client_id, auth_method, \
                         application_type, redirect_uris, grant_types, response_types, scopes, \
                         contacts, created_at) \
                         VALUES (?1, 'none', 'native', '[]', '[]', '[]', '[]', '[]', 1)",
                        [&id],
                    )?;
                    tx.execute(
                        "INSERT INTO auth_oauth_consent (client_id, user_id, grant_id, scopes, \
                         created_at, updated_at, withdrawn_at) \
                         VALUES (?1, 'owner', ?1, '[]', 1, 1, ?2)",
                        rusqlite::params![id, withdrawn_at],
                    )
                };
                for number in 0..sessions {
                    session(format!("live-{number}"), now + 1_000)?;
                }
                session("expired".to_string(), now - 1)?;
                for number in 0..apps {
                    consent(format!("app-{number}"), None)?;
                }
                consent("withdrawn".to_string(), Some(1))?;
                Ok(())
            })
            .await
            .unwrap();
    }

    async fn start(extra: &[(&str, &str)]) -> Instance {
        let dir = TempDir::new().unwrap();
        let database = dir.path().join("marfa.db");
        let blobs = dir.path().join("blobs");
        let socket = dir.path().join("s.sock");
        let mut pairs = vec![
            ("MARFA_DATABASE_PATH", database.to_str().unwrap()),
            ("MARFA_BLOB_PATH", blobs.to_str().unwrap()),
            ("MARFA_CONTROL_SOCKET", socket.to_str().unwrap()),
            ("MARFA_RATE_LIMIT_ENABLED", "false"),
        ];
        pairs.extend_from_slice(extra);
        let settings = Settings::read(Environment::from_pairs(&pairs)).unwrap();
        let app = App::start(settings).await.unwrap();
        Instance {
            _dir: dir,
            control: control(app.clone()),
            public: public(app.clone()),
            app,
        }
    }

    async fn call(&self, method: Method, path: &str, body: Option<Value>) -> Reply {
        let builder = Request::builder().method(method).uri(path);
        self.send(&self.control, builder, body).await
    }

    async fn manager(&self) -> String {
        let body = json!({ "label": "m", "source": "m", "permissions": ["config.manage"] });
        let minted = self.call(Method::POST, "/keys", Some(body)).await;
        minted.body["key"].as_str().unwrap().to_string()
    }

    async fn as_key(&self, key: &str, method: Method, body: Value) -> Reply {
        let builder = Request::builder()
            .method(method)
            .uri("/config")
            .header(header::AUTHORIZATION, format!("Bearer {key}"));
        self.send(&self.public, builder, Some(body)).await
    }

    async fn send(
        &self,
        doors: &Router,
        mut builder: axum::http::request::Builder,
        body: Option<Value>,
    ) -> Reply {
        let body = match body {
            Some(body) => {
                builder = builder.header(header::CONTENT_TYPE, "application/json");
                Body::from(body.to_string())
            }
            None => Body::empty(),
        };
        let response = doors
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

    async fn spoil(&self, key: &'static str, text: &'static str) {
        self.app
            .db
            .write(Write::own(), move |tx| {
                tx.execute(
                    "INSERT INTO settings (key, value) VALUES (?1, ?2)",
                    [key, text],
                )?;
                Ok(())
            })
            .await
            .unwrap();
        let rows = self.app.db.read(stored::rows).await.unwrap();
        self.app.settings.apply_stored(&rows);
    }

    async fn row(&self, key: &str) -> Option<String> {
        let rows = self.app.db.read(stored::rows).await.unwrap();
        rows.into_iter()
            .find(|(name, _)| name == key)
            .map(|(_, text)| text)
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
async fn cors_origins_seed_from_a_comma_list_and_change_as_a_list() {
    let seed = [
        ("MARFA_TEST_HOOKS", "true"),
        ("MARFA_CORS_ORIGINS", "https://a.example, https://b.example"),
    ];
    let instance = Instance::start(&seed).await;
    assert_eq!(
        configured_origins(&instance.app),
        ["https://a.example", "https://b.example"]
    );
    let changed = instance
        .patch(json!({ "cors_origins": ["https://c.example"] }))
        .await;
    assert_eq!(changed.status, StatusCode::OK, "{}", changed.text);
    assert_eq!(configured_origins(&instance.app), ["https://c.example"]);

    let refused = instance
        .patch(json!({ "cors_origins": ["not an origin"] }))
        .await;
    assert_eq!(refused.status, StatusCode::BAD_REQUEST, "{}", refused.text);
    assert_eq!(configured_origins(&instance.app), ["https://c.example"]);
}

#[tokio::test]
async fn a_setting_whose_area_is_not_built_is_not_known() {
    let instance = Instance::start(&[]).await;
    let refused = instance
        .patch(json!({ "inbound_handled_retention_days": 5 }))
        .await;
    assert_eq!(
        refused.body["error"]["details"]["unknown_body_fields"],
        json!(["inbound_handled_retention_days"])
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
async fn a_key_losing_config_manage_while_its_write_waits_writes_nothing() {
    let instance = Instance::start(&[]).await;
    let body = json!({ "label": "m", "source": "m", "permissions": ["config.manage"] });
    let minted = instance.call(Method::POST, "/keys", Some(body)).await;
    let id = minted.body["id"].as_str().unwrap().to_string();
    let key = minted.body["key"].as_str().unwrap().to_string();
    for (method, body) in [
        (Method::PATCH, json!({ "name": "Late" })),
        (Method::PUT, json!({ "name": "Late" })),
    ] {
        instance
            .app
            .faults
            .set("hold:write", Some("config.update"))
            .unwrap();
        let write = instance.as_key(&key, method, body);
        let narrow = async {
            for _ in 0..500 {
                if instance.app.faults.list().iter().any(|f| f.waiting > 0) {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(2)).await;
            }
            let path = format!("/keys/{id}");
            let held = json!({ "permissions": ["instance.read"] });
            let narrowed = instance.call(Method::PATCH, &path, Some(held)).await;
            assert_eq!(narrowed.status, StatusCode::OK, "{}", narrowed.text);
            instance.app.faults.clear(Some("hold:write"));
        };
        let (written, ()) = tokio::join!(write, narrow);
        assert_eq!(written.status, StatusCode::FORBIDDEN, "{}", written.text);
        assert_eq!(instance.config().await.get("name"), None);
        let path = format!("/keys/{id}");
        let restored = json!({ "permissions": ["config.manage"] });
        let restored = instance.call(Method::PATCH, &path, Some(restored)).await;
        assert_eq!(restored.status, StatusCode::OK, "{}", restored.text);
    }
    let audited = instance
        .call(Method::GET, "/audit?action=config.update", None)
        .await;
    assert_eq!(audited.body["data"], json!([]), "{}", audited.text);

    let landed = instance
        .as_key(&key, Method::PATCH, json!({ "name": "Late" }))
        .await;
    assert_eq!(landed.status, StatusCode::OK, "{}", landed.text);
    assert_eq!(instance.config().await["name"], "Late");
}

#[tokio::test]
async fn a_sign_in_change_on_a_claimed_instance_asks_first_and_a_tidier_spelling_does_not() {
    let instance = Instance::start(&[]).await;
    let before_claim = instance
        .patch(json!({ "sign_in_address": "https://a.example" }))
        .await;
    assert_eq!(before_claim.status, StatusCode::OK, "{}", before_claim.text);
    assert_eq!(before_claim.body["addresses"], json!(["https://a.example"]));
    instance.claim_with(1, 1).await;

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
    assert_eq!(codes, ["browser_sessions_end", "apps_sign_in_again"]);
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
async fn the_first_stored_sign_in_address_of_a_claimed_instance_asks_first() {
    let instance = Instance::start(&[]).await;
    instance.claim().await;
    let body = json!({ "sign_in_address": "https://a.example" });
    let asked = instance.patch(body.clone()).await;
    assert_eq!(asked.code(), "sign_in_address_change_unconfirmed");
    assert_eq!(instance.row("sign_in_address").await, None);

    let checked = instance
        .call(Method::POST, "/config/address-check", Some(body))
        .await;
    assert_eq!(checked.body["requires_confirmation"], true);

    let loopback = instance.app.addresses().sign_in().origin().to_string();
    let unmoved = instance.patch(json!({ "sign_in_address": loopback })).await;
    assert_eq!(unmoved.status, StatusCode::OK, "{}", unmoved.text);
}

#[tokio::test]
async fn only_direct_authority_changes_the_trusted_origins() {
    let instance = Instance::start(&[]).await;
    let key = instance.manager().await;
    let page = "https://page.example";

    let asked = json!({ "cors_origins": [page] });
    let first = instance.as_key(&key, Method::PATCH, asked.clone()).await;
    assert_eq!(first.status, StatusCode::FORBIDDEN, "{}", first.text);
    assert_eq!(instance.row("cors_origins").await, None);

    let local = instance.patch(asked).await;
    assert_eq!(local.status, StatusCode::OK, "{}", local.text);

    let tidier = json!({ "cors_origins": ["HTTPS://Page.Example:443/"] });
    let tidier = instance.as_key(&key, Method::PATCH, tidier).await;
    assert_eq!(tidier.status, StatusCode::OK, "{}", tidier.text);

    for (method, body) in [
        (
            Method::PATCH,
            json!({ "cors_origins": [page, "https://b.example"] }),
        ),
        (Method::PATCH, json!({ "cors_origins": null })),
        (Method::PUT, json!({})),
    ] {
        let refused = instance.as_key(&key, method, body).await;
        assert_eq!(refused.status, StatusCode::FORBIDDEN, "{}", refused.text);
    }
    let other = json!({ "max_request_bytes": 2_000_000 });
    let other = instance.as_key(&key, Method::PATCH, other).await;
    assert_eq!(other.status, StatusCode::OK, "{}", other.text);
}

#[tokio::test]
async fn only_direct_authority_moves_the_sign_in_address() {
    let instance = Instance::start(&[]).await;
    let key = instance.manager().await;
    let a = "https://a.example";
    let own = instance.app.addresses().sign_in().origin().to_string();

    let confirmed = json!({ "sign_in_address": a, "confirm_sign_in_address_change": true });
    let first = instance.as_key(&key, Method::PATCH, confirmed).await;
    assert_eq!(first.status, StatusCode::FORBIDDEN, "{}", first.text);
    assert_eq!(first.code(), "forbidden");
    assert_eq!(instance.row("sign_in_address").await, None);
    assert_eq!(instance.row("addresses").await, None);

    let shape = json!({ "sign_in_address": "marfa.example" });
    let shape = instance.as_key(&key, Method::PATCH, shape).await;
    assert_eq!(shape.code(), "validation_error", "{}", shape.text);

    let local = instance.patch(json!({ "sign_in_address": a })).await;
    assert_eq!(local.status, StatusCode::OK, "{}", local.text);

    let tidier = json!({ "sign_in_address": "HTTPS://A.Example:443/" });
    let tidier = instance.as_key(&key, Method::PATCH, tidier).await;
    assert_eq!(tidier.status, StatusCode::OK, "{}", tidier.text);

    // The list holds the computer's own address too, so that clearing the
    // sign-in address below leaves a whole list and only authority refuses it.
    let list = json!({ "addresses": [a, "https://b.example", own] });
    let list = instance.as_key(&key, Method::PATCH, list).await;
    assert_eq!(list.status, StatusCode::OK, "{}", list.text);

    let moved = json!({ "sign_in_address": "https://b.example" });
    for (method, body) in [
        (Method::PATCH, moved),
        (Method::PATCH, json!({ "sign_in_address": null })),
        (Method::PUT, json!({})),
    ] {
        let label = format!("{method} {body}");
        let refused = instance.as_key(&key, method, body).await;
        assert_eq!(
            refused.status,
            StatusCode::FORBIDDEN,
            "{label}: {}",
            refused.text
        );
    }
    assert_eq!(instance.app.addresses().sign_in().origin(), a);
}

#[tokio::test]
async fn the_addresses_are_judged_against_the_sign_in_address_in_force_stored_or_not() {
    let instance = Instance::start(&[]).await;
    let own = instance.app.addresses().sign_in().origin().to_string();
    assert_eq!(instance.row("sign_in_address").await, None);

    // No sign-in address is stored, so the computer's own address is the one in
    // force, and a list that leaves it out is not whole.
    let elsewhere = json!({ "addresses": ["https://a.example"] });
    let refused = instance.patch(elsewhere).await;
    assert_eq!(refused.code(), "validation_error", "{}", refused.text);
    assert_eq!(refused.error_paths(), ["addresses"]);
    assert_eq!(instance.row("addresses").await, None);

    // The witness: the same list with that address in it is stored.
    let whole = json!({ "addresses": [own, "https://a.example"] });
    let stored = instance.patch(whole).await;
    assert_eq!(stored.status, StatusCode::OK, "{}", stored.text);

    // Clearing the list leaves the sign-in address standing alone, which is whole.
    let cleared = instance.patch(json!({ "addresses": null })).await;
    assert_eq!(cleared.status, StatusCode::OK, "{}", cleared.text);
    assert_eq!(instance.row("addresses").await, None);
}

#[tokio::test]
async fn a_write_that_would_overwrite_an_unreadable_address_list_must_name_it() {
    let instance = Instance::start(&[]).await;
    instance.spoil("addresses", "not a list").await;

    let a = "https://a.example";
    for (method, body) in [
        (Method::PATCH, json!({ "sign_in_address": a })),
        (Method::PUT, json!({ "sign_in_address": a })),
        (Method::PUT, json!({})),
    ] {
        let refused = instance.call(method, "/config", Some(body)).await;
        assert_eq!(refused.code(), "validation_error", "{}", refused.text);
        assert_eq!(refused.error_paths(), ["addresses"]);
    }
    let elsewhere = instance.patch(json!({ "name": "Kept" })).await;
    assert_eq!(elsewhere.status, StatusCode::OK, "{}", elsewhere.text);
    assert_eq!(
        instance.row("addresses").await.as_deref(),
        Some("not a list")
    );

    let own = instance.app.addresses().sign_in().origin().to_string();
    let mended = instance.patch(json!({ "addresses": [a, own] })).await;
    assert_eq!(mended.status, StatusCode::OK, "{}", mended.text);
    assert_eq!(mended.body["addresses"], json!([a, own]));
    assert!(instance.app.settings.live().unreadable().is_empty());
}

#[tokio::test]
async fn a_put_that_would_remove_unreadable_levers_must_name_them() {
    let instance = Instance::start(&[]).await;
    let damaged = "{ not levers";
    instance.spoil("enforcement", damaged).await;

    for body in [json!({}), json!({ "name": "Kept" })] {
        let refused = instance.call(Method::PUT, "/config", Some(body)).await;
        assert_eq!(refused.code(), "validation_error", "{}", refused.text);
        assert_eq!(refused.error_paths(), ["enforcement"]);
    }
    let elsewhere = instance.patch(json!({ "name": "Kept" })).await;
    assert_eq!(elsewhere.status, StatusCode::OK, "{}", elsewhere.text);
    assert_eq!(instance.row("enforcement").await.as_deref(), Some(damaged));

    let body = json!({ "enforcement": {} });
    let mended = instance.call(Method::PUT, "/config", Some(body)).await;
    assert_eq!(mended.status, StatusCode::OK, "{}", mended.text);
    assert_eq!(instance.row("enforcement").await.as_deref(), Some("{}"));

    let readable = instance.call(Method::PUT, "/config", Some(json!({}))).await;
    assert_eq!(readable.status, StatusCode::OK, "{}", readable.text);
    assert_eq!(instance.row("enforcement").await, None);
}

#[tokio::test]
async fn unreadable_levers_show_in_the_settings_and_on_health_until_mended() {
    let instance = Instance::start(&[]).await;
    let damaged = "{ not levers";
    instance.spoil("enforcement", damaged).await;

    let levers_line = async || {
        let listed = instance.call(Method::GET, "/config/settings", None).await;
        listed.body["data"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["key"] == "enforcement")
            .cloned()
    };
    let unreadable = async || {
        let health = instance.call(Method::GET, "/health", None).await;
        health.body["housekeeping"]["unreadable_settings"].clone()
    };
    let line = levers_line().await.expect("a line for the levers");
    assert_eq!(line["unreadable"], true);
    assert_eq!(line["stored"], damaged);
    assert_eq!(unreadable().await, json!(["enforcement"]));

    let mended = instance.patch(json!({ "enforcement": null })).await;
    assert_eq!(mended.status, StatusCode::OK, "{}", mended.text);
    assert_eq!(instance.row("enforcement").await, None);
    assert_eq!(levers_line().await, None);
    assert_eq!(unreadable().await, json!([]));
}

#[tokio::test]
async fn a_cap_too_small_for_any_body_is_mended_on_the_control_socket() {
    let instance = Instance::start(&[]).await;
    let key = instance.manager().await;
    let set = instance.patch(json!({ "max_request_bytes": 2 })).await;
    assert_eq!(set.status, StatusCode::OK, "{}", set.text);

    let mending = json!({ "max_request_bytes": 1_048_576 });
    let public = instance.as_key(&key, Method::PATCH, mending.clone()).await;
    assert_eq!(
        public.status,
        StatusCode::PAYLOAD_TOO_LARGE,
        "{}",
        public.text
    );

    let past_the_default = json!({ "name": "n".repeat(1_048_576) });
    let refused = instance.patch(past_the_default).await;
    assert_eq!(refused.status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(instance.app.settings.live().get(MAX_REQUEST_BYTES), 2);

    let mended = instance.patch(mending.clone()).await;
    assert_eq!(mended.status, StatusCode::OK, "{}", mended.text);
    let public = instance.as_key(&key, Method::PATCH, mending).await;
    assert_eq!(public.status, StatusCode::OK, "{}", public.text);
}

#[tokio::test]
async fn a_sign_in_change_counts_the_browsers_and_apps_it_reaches() {
    let instance = Instance::start(&[]).await;
    instance
        .patch(json!({ "sign_in_address": "https://a.example" }))
        .await;
    instance.claim_with(2, 3).await;

    let checked = instance
        .call(
            Method::POST,
            "/config/address-check",
            Some(json!({ "sign_in_address": "https://b.example" })),
        )
        .await;
    assert_eq!(checked.status, StatusCode::OK, "{}", checked.text);
    let counts: Vec<_> = checked.body["consequences"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| (entry["code"].as_str().unwrap(), entry["count"].clone()))
        .collect();
    assert_eq!(
        counts[..2],
        [
            ("browser_sessions_end", json!(2)),
            ("apps_sign_in_again", json!(3))
        ],
    );
}

#[tokio::test]
async fn a_sign_in_change_says_nothing_of_browsers_or_apps_it_reaches_none_of() {
    let instance = Instance::start(&[]).await;
    instance
        .patch(json!({ "sign_in_address": "https://a.example" }))
        .await;
    instance.claim_with(0, 0).await;

    let checked = instance
        .call(
            Method::POST,
            "/config/address-check",
            Some(json!({ "sign_in_address": "https://b.example" })),
        )
        .await;
    assert_eq!(checked.status, StatusCode::OK, "{}", checked.text);
    let codes: Vec<_> = checked.body["consequences"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["code"].as_str().unwrap())
        .collect();
    assert!(!codes.contains(&"browser_sessions_end"), "{codes:?}");
    assert!(!codes.contains(&"apps_sign_in_again"), "{codes:?}");
}

#[tokio::test]
async fn an_address_check_says_what_would_happen_and_writes_nothing() {
    let instance = Instance::start(&[]).await;
    instance
        .patch(json!({ "sign_in_address": "https://a.example" }))
        .await;
    instance.claim().await;
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
    let instance = Instance::start(&[
        ("MARFA_KEY_SALT", secret),
        ("MARFA_ERROR_WEBHOOK_URL", hook),
    ])
    .await;

    instance.spoil("audit_retention_days", "soon").await;

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
    assert_eq!(named("MARFA_KEY_SALT")["set"], true);
    assert_eq!(named("MARFA_HEARTBEAT_URL")["set"], false);
    assert_eq!(named("MARFA_ERROR_WEBHOOK_TIMEOUT_MS")["secret"], false);

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

#[tokio::test]
async fn the_root_answers_the_request_cap_as_it_stands_with_no_restart() {
    let instance = Instance::start(&[]).await;
    let cap = |reply: Reply| reply.body["max_request_bytes"].clone();

    let before = instance.call(Method::GET, "/", None).await;
    assert_eq!(
        cap(before),
        json!(instance.app.settings.live().get(MAX_REQUEST_BYTES))
    );

    let set = instance.patch(json!({ "max_request_bytes": 2048 })).await;
    assert_eq!(set.status, StatusCode::OK, "{}", set.text);
    assert_eq!(
        cap(instance.call(Method::GET, "/", None).await),
        json!(2048)
    );
}
