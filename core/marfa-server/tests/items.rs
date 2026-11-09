//! Where an item write's transaction ends, and what a retry sees.

use std::collections::BTreeMap;
use std::future::Future;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{HeaderMap, Method, Request, StatusCode, header};
use marfa_rules::conflict::copy_id;
use marfa_server::app::App;
use marfa_server::http::listening::{PUBLIC_HEADER_READ_TIMEOUT, Tcp};
use marfa_server::http::{control, public, serve};
use marfa_server::settings::{Environment, Settings};
use rusqlite::{Connection, OpenFlags};
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::net::TcpListener;
use tower::ServiceExt;

struct Instance {
    dir: TempDir,
    app: Arc<App>,
    public: Router,
    control: Router,
}

struct Reply {
    status: StatusCode,
    text: String,
    headers: HeaderMap,
}

impl Reply {
    fn json(&self) -> Value {
        serde_json::from_str(&self.text).unwrap_or(Value::Null)
    }

    fn code(&self) -> String {
        self.json()["error"]["code"]
            .as_str()
            .unwrap_or("")
            .to_string()
    }
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
struct Written {
    items: i64,
    versions: i64,
    events: i64,
    audits: i64,
}

async fn send(router: Router, request: Request<Body>) -> Reply {
    let response = router.oneshot(request).await.unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    Reply {
        status,
        text: String::from_utf8(bytes.to_vec()).unwrap(),
        headers,
    }
}

fn request(
    method: Method,
    path: &str,
    token: Option<&str>,
    body: Option<String>,
    idempotency_key: Option<&str>,
) -> Request<Body> {
    let mut builder = Request::builder().method(method).uri(path);
    if let Some(token) = token {
        builder = builder.header(header::AUTHORIZATION, format!("Bearer {token}"));
    }
    if let Some(key) = idempotency_key {
        builder = builder.header("idempotency-key", key);
    }
    match body {
        Some(body) => builder
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body))
            .unwrap(),
        None => builder.body(Body::empty()).unwrap(),
    }
}

impl Instance {
    async fn start() -> Instance {
        let dir = TempDir::new().unwrap();
        let database = dir.path().join("marfa.db");
        let blobs = dir.path().join("blobs");
        let socket = dir.path().join("s.sock");
        let pairs = vec![
            ("MARFA_DATABASE_PATH", database.to_str().unwrap()),
            ("MARFA_BLOB_PATH", blobs.to_str().unwrap()),
            ("MARFA_CONTROL_SOCKET", socket.to_str().unwrap()),
            ("MARFA_TEST_HOOKS", "true"),
            ("MARFA_RATE_LIMIT_ENABLED", "false"),
        ];
        let settings = Settings::read(Environment::from_pairs(&pairs)).unwrap();
        let app = App::start(settings).await.unwrap();
        Instance {
            public: public(app.clone()),
            control: control(app.clone()),
            app,
            dir,
        }
    }

    async fn local(&self, method: Method, path: &str, body: Value) -> Reply {
        let sent = request(method, path, None, Some(body.to_string()), None);
        send(self.control.clone(), sent).await
    }

    async fn key(&self, source: &str, types: Value) -> (String, String) {
        self.key_with(source, json!({ "type_permissions": types }))
            .await
    }

    async fn key_with(&self, source: &str, grants: Value) -> (String, String) {
        let mut body = json!({ "label": source, "source": source, "permissions": [] });
        body.as_object_mut()
            .unwrap()
            .extend(grants.as_object().unwrap().clone());
        let minted = self.local(Method::POST, "/keys", body).await;
        assert_eq!(minted.status, StatusCode::CREATED, "{}", minted.text);
        let minted = minted.json();
        (
            minted["id"].as_str().unwrap().to_string(),
            minted["key"].as_str().unwrap().to_string(),
        )
    }

    async fn grant(&self, key_id: &str, types: Value) {
        let path = format!("/keys/{key_id}");
        let body = json!({ "type_permissions": types });
        let changed = self.local(Method::PATCH, &path, body).await;
        assert_eq!(changed.status, StatusCode::OK, "{}", changed.text);
    }

    async fn call(&self, token: &str, method: Method, path: &str, body: Value) -> Reply {
        self.text(token, method, path, &body.to_string()).await
    }

    async fn text(&self, token: &str, method: Method, path: &str, body: &str) -> Reply {
        let sent = request(method, path, Some(token), Some(body.to_string()), None);
        send(self.public.clone(), sent).await
    }

    async fn get(&self, token: &str, path: &str) -> Reply {
        let sent = request(Method::GET, path, Some(token), None, None);
        send(self.public.clone(), sent).await
    }

    async fn keyed(&self, token: &str, path: &str, key: &str, body: &Value) -> Reply {
        let sent = request(
            Method::POST,
            path,
            Some(token),
            Some(body.to_string()),
            Some(key),
        );
        send(self.public.clone(), sent).await
    }

    async fn note(&self, token: &str, body: &str) -> Value {
        let made = self
            .call(
                token,
                Method::POST,
                "/items",
                json!({ "type": "core.note", "properties": { "body": body } }),
            )
            .await;
        assert_eq!(made.status, StatusCode::CREATED, "{}", made.text);
        made.json()["item"].clone()
    }

    fn written(&self) -> Written {
        let file = self.dir.path().join("marfa.db");
        let db = Connection::open_with_flags(file, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let count = |sql: &str| db.query_row(sql, [], |row| row.get(0)).unwrap();
        Written {
            items: count("SELECT count(*) FROM items"),
            versions: count("SELECT count(*) FROM item_versions"),
            events: count("SELECT count(*) FROM event_log"),
            audits: count("SELECT count(*) FROM audit_log WHERE action LIKE 'item.%'"),
        }
    }

    fn count(&self, sql: &str) -> i64 {
        let file = self.dir.path().join("marfa.db");
        let db = Connection::open_with_flags(file, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        db.query_row(sql, [], |row| row.get(0)).unwrap()
    }

    /// Named from the schema so a table added later is read.
    fn tables(&self) -> BTreeMap<String, i64> {
        let file = self.dir.path().join("marfa.db");
        let db = Connection::open_with_flags(file, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let mut named = db
            .prepare(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
            )
            .unwrap();
        let names: Vec<String> = named
            .query_map([], |row| row.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        names
            .into_iter()
            .map(|name| {
                let sql = format!("SELECT count(*) FROM \"{name}\"");
                let rows = db.query_row(&sql, [], |row| row.get(0)).unwrap();
                (name, rows)
            })
            .collect()
    }

    async fn held(
        self: &Arc<Self>,
        action: &str,
        token: &str,
        method: Method,
        path: &str,
        body: Value,
        between: impl Future<Output = Reply>,
    ) -> Reply {
        self.app.faults.set("hold:write", Some(action)).unwrap();
        let waiting = {
            let (instance, token, path) = (self.clone(), token.to_string(), path.to_string());
            tokio::spawn(async move { instance.call(&token, method, &path, body).await })
        };
        self.when_held().await;
        let landed = between.await;
        assert_eq!(landed.status, StatusCode::OK, "{}", landed.text);
        self.app.faults.clear(Some("hold:write"));
        waiting.await.unwrap()
    }

    async fn when_held(&self) {
        for _ in 0..500 {
            if self.app.faults.list().iter().any(|fault| fault.waiting > 0) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
        panic!("no write reached the hold");
    }
}

fn notes(level: &str) -> Value {
    json!({ "core.note": level })
}

#[tokio::test]
async fn writes_racing_on_one_natural_key_land_on_one_row() {
    let instance = Arc::new(Instance::start().await);
    let (_, token) = instance.key("race", json!({ "*": "write" })).await;
    let body = json!({
        "type": "core.note",
        "source_id": "one",
        "properties": { "body": "raced" },
    });
    let mut racing = Vec::new();
    for _ in 0..8 {
        let (instance, token, body) = (instance.clone(), token.clone(), body.clone());
        racing.push(tokio::spawn(async move {
            instance.call(&token, Method::POST, "/items", body).await
        }));
    }
    let mut created = 0;
    let mut ids = Vec::new();
    for answer in racing {
        let answer = answer.await.unwrap();
        assert!(answer.status.is_success(), "{}", answer.text);
        created += i32::from(answer.status == StatusCode::CREATED);
        ids.push(answer.json()["item"]["id"].clone());
    }
    assert_eq!(created, 1);
    assert!(ids.iter().all(|id| *id == ids[0]));
    assert_eq!(instance.written().items, 1);
}

#[tokio::test]
async fn a_key_narrowed_while_its_write_waits_writes_nothing() {
    let instance = Arc::new(Instance::start().await);
    let (id, token) = instance.key("narrowed", notes("write")).await;
    let body = json!({ "type": "core.note", "properties": { "body": "held" } });
    for narrowed in [false, true] {
        let before = instance.written();
        instance
            .app
            .faults
            .set("hold:write", Some("item.create"))
            .unwrap();
        let waiting = {
            let (instance, token, body) = (instance.clone(), token.clone(), body.clone());
            tokio::spawn(async move { instance.call(&token, Method::POST, "/items", body).await })
        };
        instance.when_held().await;
        if narrowed {
            instance.grant(&id, notes("read")).await;
        }
        instance.app.faults.clear(Some("hold:write"));
        let answer = waiting.await.unwrap();
        if narrowed {
            assert_eq!(answer.status, StatusCode::FORBIDDEN, "{}", answer.text);
            assert_eq!(answer.code(), "type_not_permitted");
            assert_eq!(instance.written(), before);
        } else {
            assert_eq!(answer.status, StatusCode::CREATED, "{}", answer.text);
            assert_eq!(instance.written().items, before.items + 1);
        }
    }
}

#[tokio::test]
async fn a_stale_write_under_another_source_is_refused_before_its_merge() {
    let instance = Instance::start().await;
    let (_, owner) = instance.key("owner", notes("write")).await;
    let (_, other) = instance.key("other", notes("write")).await;
    let item = instance.note(&owner, "first").await;
    let path = format!("/items/{}", item["id"].as_str().unwrap());
    let moved = json!({ "version": 1, "properties": { "body": "second" } });
    let answer = instance.call(&owner, Method::PATCH, &path, moved).await;
    assert_eq!(answer.status, StatusCode::OK, "{}", answer.text);

    let before = instance.written();
    let stale = json!({
        "version": 1,
        "source_id": "taken-over",
        "properties": { "title": "merged" },
    });
    let refused = instance
        .call(&other, Method::PATCH, &path, stale.clone())
        .await;
    assert_eq!(refused.status, StatusCode::FORBIDDEN, "{}", refused.text);
    assert_eq!(refused.json()["error"]["details"]["source"], "owner");
    assert_eq!(instance.written(), before);

    let merged = instance.call(&owner, Method::PATCH, &path, stale).await;
    assert_eq!(merged.status, StatusCode::OK, "{}", merged.text);
    assert_eq!(merged.json()["item"]["properties"]["title"], "merged");
    assert_eq!(merged.json()["item"]["properties"]["body"], "second");
}

#[tokio::test]
async fn a_retype_its_destination_refuses_changes_nothing() {
    let instance = Instance::start().await;
    let (_, token) = instance.key("mover", json!({ "*": "write" })).await;
    let registered = instance
        .local(
            Method::POST,
            "/types",
            json!({
                "id": "user.strict",
                "version": 1,
                "fields": { "must": { "type": "string", "required": true } },
            }),
        )
        .await;
    assert_eq!(
        registered.status,
        StatusCode::CREATED,
        "{}",
        registered.text
    );
    let item = instance.note(&token, "unmoved").await;
    let path = format!("/items/{}", item["id"].as_str().unwrap());

    let before = instance.written();
    let move_to = json!({ "type": "user.strict", "retype": true, "version": 1 });
    let refused = instance.call(&token, Method::PATCH, &path, move_to).await;
    assert_eq!(refused.status, StatusCode::BAD_REQUEST, "{}", refused.text);
    assert_eq!(refused.code(), "invalid_properties");
    assert_eq!(instance.written(), before);
    let read = instance.get(&token, &path).await.json();
    assert_eq!(read["item"]["type"], "core.note");
    assert_eq!(read["item"]["version"], 1);
}

#[tokio::test]
async fn a_stale_move_onto_a_row_moved_since_is_refused_naming_type() {
    let instance = Instance::start().await;
    let (_, token) = instance.key("movers", json!({ "*": "write" })).await;
    let third = json!({
        "id": "user.third",
        "version": 1,
        "fields": { "title": { "type": "string" } },
    });
    let registered = instance.local(Method::POST, "/types", third).await;
    assert_eq!(
        registered.status,
        StatusCode::CREATED,
        "{}",
        registered.text
    );
    let item = instance.note(&token, "contested").await;
    let path = format!("/items/{}", item["id"].as_str().unwrap());

    let first = json!({ "type": "core.bookmark", "retype": true, "version": 1 });
    let answer = instance.call(&token, Method::PATCH, &path, first).await;
    assert_eq!(answer.status, StatusCode::OK, "{}", answer.text);

    let before = instance.written();
    let second = json!({ "type": "user.third", "retype": true, "version": 1 });
    let answer = instance.call(&token, Method::PATCH, &path, second).await;
    assert_eq!(answer.status, StatusCode::CONFLICT, "{}", answer.text);
    assert_eq!(answer.code(), "version_conflict");
    assert!(answer.text.contains(r#""type""#), "{}", answer.text);
    assert_eq!(instance.written(), before);
    let read = instance.get(&token, &path).await.json();
    assert_eq!(read["item"]["type"], "core.bookmark");
}

#[tokio::test]
async fn a_move_to_the_type_held_steps_nothing_and_an_equal_write_steps_once() {
    let instance = Instance::start().await;
    let (_, token) = instance.key("still", notes("write")).await;
    let item = instance.note(&token, "same").await;
    let path = format!("/items/{}", item["id"].as_str().unwrap());

    let before = instance.written();
    let same_type = json!({ "type": "core.note", "retype": true, "version": 1 });
    let answer = instance.call(&token, Method::PATCH, &path, same_type).await;
    assert_eq!(answer.status, StatusCode::OK, "{}", answer.text);
    assert_eq!(answer.json()["item"]["version"], 1);
    assert_eq!(instance.written().events, before.events);
    assert_eq!(instance.written().versions, before.versions);

    let equal = json!({ "version": 1, "properties": { "body": "same" } });
    let answer = instance.call(&token, Method::PATCH, &path, equal).await;
    assert_eq!(answer.status, StatusCode::OK, "{}", answer.text);
    assert_eq!(answer.json()["item"]["version"], 2);
    assert_eq!(instance.written().events, before.events + 1);
}

#[tokio::test]
async fn a_failed_commit_leaves_no_row_event_audit_or_version() {
    let instance = Instance::start().await;
    let (_, token) = instance.key("failing", notes("write")).await;
    let item = instance.note(&token, "kept").await;
    let path = format!("/items/{}", item["id"].as_str().unwrap());
    let update = json!({ "version": 1, "properties": { "body": "lost" } });
    let create = json!({ "type": "core.note", "properties": { "body": "lost" } });

    for fault in ["fail:commit", "fail:audit"] {
        for (action, method, door, body) in [
            ("item.update", Method::PATCH, path.as_str(), &update),
            ("item.create", Method::POST, "/items", &create),
        ] {
            let before = instance.written();
            instance.app.faults.set(fault, Some(action)).unwrap();
            let answer = instance.call(&token, method, door, body.clone()).await;
            instance.app.faults.clear(Some(fault));
            assert!(answer.status.is_server_error(), "{}", answer.text);
            assert_eq!(instance.written(), before, "{fault} on {action}");
        }
    }
    let read = instance.get(&token, &path).await.json();
    assert_eq!(read["item"]["properties"]["body"], "kept");

    let before = instance.written();
    let answer = instance.call(&token, Method::PATCH, &path, update).await;
    assert_eq!(answer.status, StatusCode::OK, "{}", answer.text);
    let after = instance.written();
    assert_eq!(after.events, before.events + 1);
    assert_eq!(after.versions, before.versions + 1);
    assert_eq!(after.audits, before.audits + 1);
}

#[tokio::test]
async fn a_replay_answers_the_first_write_while_the_key_may_still_read_it() {
    let instance = Instance::start().await;
    let (id, token) = instance.key("replay", notes("write")).await;
    let body = json!({ "type": "core.note", "properties": { "body": "first" } });

    let first = instance.keyed(&token, "/items", "one", &body).await;
    assert_eq!(first.status, StatusCode::CREATED, "{}", first.text);
    let item_id = first.json()["item"]["id"].as_str().unwrap().to_string();
    let path = format!("/items/{item_id}");
    let moved = json!({ "version": 1, "properties": { "body": "second" } });
    let answer = instance.call(&token, Method::PATCH, &path, moved).await;
    assert_eq!(answer.status, StatusCode::OK, "{}", answer.text);

    let before = instance.written();
    let again = instance.keyed(&token, "/items", "one", &body).await;
    assert_eq!(again.status, StatusCode::CREATED);
    assert_eq!(again.text, first.text);
    assert!(again.headers.contains_key("idempotency-replayed"));

    instance.grant(&id, json!({ "core.task": "read" })).await;
    let hidden = instance.keyed(&token, "/items", "one", &body).await;
    assert_eq!(hidden.status, StatusCode::NOT_FOUND, "{}", hidden.text);
    assert_eq!(hidden.code(), "item_not_found");
    assert!(!hidden.text.contains(&item_id));

    instance.grant(&id, notes("write")).await;
    let restored = instance.keyed(&token, "/items", "one", &body).await;
    assert_eq!(restored.text, first.text);
    assert_eq!(instance.written(), before);
}

#[tokio::test]
async fn a_key_whose_first_commit_failed_writes_once_when_it_is_sent_again() {
    let instance = Instance::start().await;
    let (_, token) = instance.key("retry", notes("write")).await;
    let body = json!({ "type": "core.note", "properties": { "body": "again" } });

    instance
        .app
        .faults
        .set("fail:commit", Some("item.create"))
        .unwrap();
    let failed = instance.keyed(&token, "/items", "retried", &body).await;
    instance.app.faults.clear(Some("fail:commit"));
    assert!(failed.status.is_server_error(), "{}", failed.text);
    assert_eq!(instance.written().items, 0);

    let landed = instance.keyed(&token, "/items", "retried", &body).await;
    assert_eq!(landed.status, StatusCode::CREATED, "{}", landed.text);
    let repeat = instance.keyed(&token, "/items", "retried", &body).await;
    assert_eq!(repeat.text, landed.text);
    assert_eq!(instance.written().items, 1);
}

#[tokio::test]
async fn a_value_reads_back_byte_for_byte_as_it_was_made_canonical() {
    let instance = Instance::start().await;
    let (_, token) = instance.key("numbers", notes("write")).await;
    let body = r#"{"type":"core.note","properties":{
        "body":"x","zebra":0.1,"apple":1.5e300,"big":9007199254740991,"whole":1.0,
        "nested":{"z":1,"a":[1e2,{"y":2,"b":"\u0000"}]}}}"#;
    let made = instance.text(&token, Method::POST, "/items", body).await;
    assert_eq!(made.status, StatusCode::CREATED, "{}", made.text);
    let path = format!("/items/{}", made.json()["item"]["id"].as_str().unwrap());

    let first = instance.get(&token, &path).await;
    let second = instance.get(&token, &path).await;
    assert_eq!(first.text, second.text);
    let start = first.text.find(r#""properties":"#).unwrap();
    assert!(
        first.text[start..].starts_with(
            r#""properties":{"body":"x","zebra":0.1,"apple":1.5e+300,"big":9007199254740991,"whole":1,"nested":{"z":1,"a":[100,{"y":2,"b":"\u0000"}]}}"#
        ),
        "{}",
        first.text
    );
}

#[tokio::test]
async fn a_value_the_contract_refuses_writes_nothing() {
    let instance = Instance::start().await;
    let (_, token) = instance.key("refused", notes("write")).await;
    let before = instance.written();
    let property = |value: &str| {
        format!(r#"{{"type":"core.note","properties":{{"body":"x","held":{value}}}}}"#)
    };
    for (value, code) in [
        ("9007199254740993", "invalid_properties"),
        ("-0", "invalid_properties"),
        ("1e400", "validation_error"),
        (r#""\ud800""#, "validation_error"),
        (r#""\u0000""#, "invalid_properties"),
    ] {
        let sent = property(value);
        let answer = instance.text(&token, Method::POST, "/items", &sent).await;
        assert_eq!(
            answer.status,
            StatusCode::BAD_REQUEST,
            "{value}: {}",
            answer.text
        );
        assert_eq!(answer.code(), code, "{value}: {}", answer.text);
    }
    let nested = format!(
        r#"{{"type":"core.note","properties":{{"body":"x","held":{}1{}}}}}"#,
        "[".repeat(65),
        "]".repeat(65)
    );
    let answer = instance.text(&token, Method::POST, "/items", &nested).await;
    assert_eq!(answer.status, StatusCode::BAD_REQUEST, "{}", answer.text);
    for (sent, code) in [
        ("[1]", "validation_error"),
        (r#""text""#, "validation_error"),
        (
            r#"{"type":"core.note","properties":{"body":"x"},"nope":1}"#,
            "validation_error",
        ),
    ] {
        let answer = instance.text(&token, Method::POST, "/items", sent).await;
        assert_eq!(
            answer.status,
            StatusCode::BAD_REQUEST,
            "{sent}: {}",
            answer.text
        );
        assert_eq!(answer.code(), code, "{sent}: {}", answer.text);
    }
    assert_eq!(instance.written(), before);
}

#[tokio::test]
async fn a_property_of_a_million_units_is_taken_and_one_more_is_not() {
    let instance = Instance::start().await;
    let (_, token) = instance.key("long", notes("write")).await;
    for (length, status) in [
        (1_000_000, StatusCode::CREATED),
        (1_000_001, StatusCode::BAD_REQUEST),
    ] {
        let body = json!({
            "type": "core.note",
            "properties": { "body": "x".repeat(length) },
        });
        let answer = instance.call(&token, Method::POST, "/items", body).await;
        assert_eq!(answer.status, status, "{length}");
    }
}

#[tokio::test]
async fn an_item_written_before_its_type_changed_still_takes_a_write() {
    let instance = Instance::start().await;
    let (_, token) = instance.key("evolved", json!({ "*": "write" })).await;
    let first = json!({
        "id": "user.evolved",
        "version": 1,
        "fields": { "title": { "type": "string" } },
    });
    let registered = instance.local(Method::POST, "/types", first).await;
    assert_eq!(
        registered.status,
        StatusCode::CREATED,
        "{}",
        registered.text
    );
    let made = instance
        .call(
            &token,
            Method::POST,
            "/items",
            json!({ "type": "user.evolved", "properties": { "title": "old" } }),
        )
        .await;
    assert_eq!(made.status, StatusCode::CREATED, "{}", made.text);
    let path = format!("/items/{}", made.json()["item"]["id"].as_str().unwrap());

    let second = json!({
        "version": 2,
        "fields": {
            "title": { "type": "string" },
            "added": { "type": "string" },
        },
    });
    let evolved = instance
        .local(Method::PUT, "/types/user.evolved", second)
        .await;
    assert_eq!(evolved.status, StatusCode::OK, "{}", evolved.text);

    let write = json!({ "version": 1, "properties": { "added": "new" } });
    let answer = instance.call(&token, Method::PATCH, &path, write).await;
    assert_eq!(answer.status, StatusCode::OK, "{}", answer.text);
    assert_eq!(answer.json()["item"]["properties"]["title"], "old");
    assert_eq!(answer.json()["item"]["properties"]["added"], "new");
}

#[tokio::test]
async fn a_field_made_searchable_reaches_the_rows_past_the_first_page() {
    let instance = Instance::start().await;
    let (_, token) = instance.key("paged", json!({ "*": "write" })).await;
    let marked = |searchable: bool, version: i64| {
        json!({
            "id": "user.paged",
            "version": version,
            "fields": { "word": { "type": "string", "searchable": searchable } },
        })
    };
    let registered = instance
        .local(Method::POST, "/types", marked(false, 1))
        .await;
    assert_eq!(
        registered.status,
        StatusCode::CREATED,
        "{}",
        registered.text
    );
    let items: Vec<Value> = (0..1_500)
        .map(|at| {
            let word = if at == 1_499 { "lastword" } else { "plain" };
            json!({ "type": "user.paged", "properties": { "word": word } })
        })
        .collect();
    let page = json!({ "atomic": false, "items": items });
    let loaded = instance
        .call(&token, Method::POST, "/items/bulk", page)
        .await;
    assert_eq!(loaded.status, StatusCode::OK, "{}", loaded.text);
    let hits = async || {
        let found = instance.get(&token, "/search?q=lastword").await;
        assert_eq!(found.status, StatusCode::OK, "{}", found.text);
        found.json()["data"].as_array().unwrap().len()
    };
    assert_eq!(hits().await, 0);

    let changed = instance
        .local(Method::PUT, "/types/user.paged", marked(true, 2))
        .await;
    assert_eq!(changed.status, StatusCode::OK, "{}", changed.text);
    for _ in 0..500 {
        if hits().await == 1 {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("The last row never reached the search index.");
}

#[tokio::test]
async fn a_refusal_that_leaves_the_body_unread_still_reaches_the_client() {
    let instance = Instance::start().await;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let router = public(instance.app.clone());
    let server = tokio::spawn(serve(
        Tcp::new(listener, "public"),
        router,
        std::future::pending(),
        PUBLIC_HEADER_READ_TIMEOUT,
    ));

    let answers = tokio::task::spawn_blocking(move || {
        let body = vec![b'x'; 2 * 1024 * 1024];
        let head = format!(
            "POST /items HTTP/1.1\r\nhost: local\r\ncontent-type: application/json\r\n\
             connection: close\r\ncontent-length: {}\r\n\r\n",
            body.len()
        );
        (0..50)
            .map(|_| {
                let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
                stream.write_all(head.as_bytes()).unwrap();
                let sent = stream.write_all(&body);
                let mut answer = Vec::new();
                let read = stream.read_to_end(&mut answer);
                (sent.is_ok(), read.is_ok(), answer)
            })
            .collect::<Vec<_>>()
    })
    .await
    .unwrap();
    server.abort();
    for (sent, read, answer) in answers {
        let text = String::from_utf8_lossy(&answer);
        assert!(sent && read, "sent {sent}, read {read}: {text}");
        assert!(text.starts_with("HTTP/1.1 4"), "{text}");
    }
}

fn purger(level: &str) -> Value {
    json!({ "permissions": ["items.purge"], "type_permissions": notes(level) })
}

fn linked_doc(id: &str) -> Value {
    json!({
        "id": id,
        "fields": { "body": { "type": "string" }, "url": { "type": "string" } },
        "link_field": "url",
    })
}

fn doc(source_id: &str, url: &str) -> Value {
    json!({
        "type": "acme.doc",
        "source_id": source_id,
        "properties": { "body": "kept", "url": url },
        "tags": ["shared"],
    })
}

async fn made(instance: &Instance, token: &str, body: Value) -> (String, String) {
    let answer = instance.call(token, Method::POST, "/items", body).await;
    assert_eq!(answer.status, StatusCode::CREATED, "{}", answer.text);
    let id = answer.json()["item"]["id"].as_str().unwrap().to_string();
    let path = format!("/items/{id}");
    (id, path)
}

async fn register_doc(instance: &Instance) {
    let registered = instance
        .local(Method::POST, "/types", linked_doc("acme.doc"))
        .await;
    assert_eq!(
        registered.status,
        StatusCode::CREATED,
        "{}",
        registered.text
    );
}

async fn binned(instance: &Instance, token: &str, path: &str) {
    let answer = instance.call(token, Method::DELETE, path, json!({})).await;
    assert_eq!(answer.status, StatusCode::OK, "{}", answer.text);
}

#[tokio::test]
async fn a_bin_and_an_update_of_one_version_land_only_the_first() {
    let instance = Arc::new(Instance::start().await);
    let (_, token) = instance.key("race", notes("write")).await;
    let update = json!({ "version": 1, "properties": { "body": "moved" } });

    let (_, path) = made(
        &instance,
        &token,
        json!({ "type": "core.note", "properties": { "body": "kept" } }),
    )
    .await;
    let at_one = format!("{path}?version=1");
    let bin = instance.call(&token, Method::DELETE, &at_one, json!({}));
    let lost = instance
        .held(
            "item.update",
            &token,
            Method::PATCH,
            &path,
            update.clone(),
            bin,
        )
        .await;
    assert_eq!(lost.status, StatusCode::NOT_FOUND, "{}", lost.text);
    assert_eq!(lost.json()["error"]["details"]["trashed"], true);
    let body = instance.count("SELECT json_extract(properties, '$.body') = 'kept' FROM items");
    assert_eq!(body, 1);

    let (_, path) = made(
        &instance,
        &token,
        json!({ "type": "core.note", "properties": { "body": "kept" } }),
    )
    .await;
    let at_one = format!("{path}?version=1");
    let moved = instance.call(&token, Method::PATCH, &path, update);
    let lost = instance
        .held(
            "item.delete",
            &token,
            Method::DELETE,
            &at_one,
            json!({}),
            moved,
        )
        .await;
    assert_eq!(lost.status, StatusCode::CONFLICT, "{}", lost.text);
    let read = instance.get(&token, &path).await.json();
    assert_eq!(read["item"]["version"], 2);
    assert_eq!(read["item"]["state"], "active");
}

#[tokio::test]
async fn a_row_in_the_bin_keeps_its_keys_and_outlives_its_type() {
    let instance = Instance::start().await;
    register_doc(&instance).await;
    let (_, token) = instance
        .key_with(
            "bin",
            json!({
                "permissions": ["schema.write"],
                "type_permissions": { "acme.doc": "write" },
            }),
        )
        .await;
    let (id, path) = made(&instance, &token, doc("held", "held-url")).await;
    binned(&instance, &token, &path).await;

    let mut taker = doc("held", "other-url");
    taker["mode"] = json!("create_only");
    let refused = instance.call(&token, Method::POST, "/items", taker).await;
    assert_eq!(refused.status, StatusCode::CONFLICT, "{}", refused.text);
    let body = doc("other", "held-url");
    let refused = instance.call(&token, Method::POST, "/items", body).await;
    assert_eq!(refused.status, StatusCode::CONFLICT, "{}", refused.text);
    assert_eq!(refused.code(), "link_taken");
    assert_eq!(refused.json()["error"]["details"]["existing_id"], id);

    let gone = instance
        .call(
            &token,
            Method::DELETE,
            "/types/acme.doc?force=true",
            json!({}),
        )
        .await;
    assert_eq!(gone.status, StatusCode::OK, "{}", gone.text);
    let back = format!("{path}/restore");
    let restored = instance.call(&token, Method::POST, &back, json!({})).await;
    assert_eq!(restored.status, StatusCode::OK, "{}", restored.text);
    let read = instance.get(&token, &path).await.json();
    assert_eq!(read["item"]["state"], "active");
    assert_eq!(read["item"]["properties"]["url"], "held-url");
}

#[tokio::test]
async fn a_purge_changes_each_table_by_what_it_removed_and_no_other() {
    let instance = Instance::start().await;
    register_doc(&instance).await;
    let (_, token) = instance
        .key_with(
            "purge",
            json!({
                "permissions": ["items.purge"],
                "type_permissions": { "acme.doc": "write" },
                "extension_permissions": { "notes-app": "write" },
            }),
        )
        .await;
    let (id, path) = made(&instance, &token, doc("gone", "gone-url")).await;
    let (_, kept) = made(&instance, &token, doc("kept", "kept-url")).await;
    for item in [&path, &kept] {
        let namespace = format!("{item}/extensions/notes-app");
        let extended = instance
            .call(&token, Method::PUT, &namespace, json!({ "pinned": true }))
            .await;
        assert_eq!(extended.status, StatusCode::OK, "{}", extended.text);
    }
    let update = json!({ "version": 1, "properties": { "body": "second" } });
    let moved = instance.call(&token, Method::PATCH, &path, update).await;
    assert_eq!(moved.status, StatusCode::OK, "{}", moved.text);
    binned(&instance, &token, &path).await;

    let of_row = |table: &str| {
        instance.count(&format!(
            "SELECT count(*) FROM {table} WHERE item_seq = (SELECT seq FROM items WHERE id = '{id}')"
        ))
    };
    let (tags, extensions, versions) = (
        of_row("item_tags"),
        of_row("item_extensions"),
        of_row("item_versions"),
    );
    assert_eq!((tags, extensions, versions), (1, 1, 1));
    let mut expected = instance.tables();

    let purging = format!("{path}/purge");
    let purged = instance
        .call(&token, Method::POST, &purging, json!({}))
        .await;
    assert_eq!(purged.status, StatusCode::OK, "{}", purged.text);

    for (table, change) in [
        ("items", -1),
        ("item_tags", -tags),
        ("item_extensions", -extensions),
        ("item_versions", -versions),
        ("link_tombstones", 1),
        ("natural_key_tombstones", 1),
        ("event_log", 1),
        ("audit_log", 1),
    ] {
        *expected.get_mut(table).unwrap() += change;
    }
    assert_eq!(instance.tables(), expected);
    assert_eq!(
        instance.count("SELECT count(*) FROM pragma_foreign_key_check"),
        0
    );
    assert_eq!(instance.get(&token, &kept).await.status, StatusCode::OK);
}

#[tokio::test]
async fn a_purge_takes_a_row_once_and_only_from_the_bin() {
    let instance = Instance::start().await;
    let (_, token) = instance.key_with("purge", purger("write")).await;
    let item = instance.note(&token, "once").await;
    let path = format!("/items/{}", item["id"].as_str().unwrap());
    let (purging, back) = (format!("{path}/purge"), format!("{path}/restore"));

    let live = instance
        .call(&token, Method::POST, &purging, json!({}))
        .await;
    assert_eq!(live.status, StatusCode::BAD_REQUEST, "{}", live.text);
    assert_eq!(live.code(), "invalid_transition");
    assert_eq!(instance.get(&token, &path).await.status, StatusCode::OK);

    binned(&instance, &token, &path).await;
    let first = instance.keyed(&token, &purging, "once", &json!({})).await;
    assert_eq!(first.status, StatusCode::OK, "{}", first.text);
    assert_eq!(instance.written().items, 0);

    let before = instance.written();
    let replay = instance.keyed(&token, &purging, "once", &json!({})).await;
    assert_eq!(replay.text, first.text);
    assert!(replay.headers.contains_key("idempotency-replayed"));

    for door in [&purging, &back] {
        let refused = instance.call(&token, Method::POST, door, json!({})).await;
        assert_eq!(refused.status, StatusCode::NOT_FOUND, "{}", refused.text);
        assert_eq!(refused.code(), "item_not_found");
    }
    assert_eq!(instance.written(), before);
}

#[tokio::test]
async fn a_digest_made_stale_after_its_preview_bins_nothing() {
    let instance = Instance::start().await;
    let (_, token) = instance.key("stale", notes("write")).await;
    let item = instance.note(&token, "previewed").await;
    let id = item["id"].as_str().unwrap();
    let path = format!("/items/{id}");
    let ids = json!({ "ids": [id] });

    let preview = instance
        .call(&token, Method::POST, "/items/trash-preview", ids.clone())
        .await;
    assert_eq!(preview.status, StatusCode::OK, "{}", preview.text);
    let digest = preview.json()["digest"].clone();
    let update = json!({ "version": 1, "properties": { "body": "moved on" } });
    let moved = instance.call(&token, Method::PATCH, &path, update).await;
    assert_eq!(moved.status, StatusCode::OK, "{}", moved.text);

    let stale = json!({ "ids": [id], "digest": digest });
    let refused = instance
        .call(&token, Method::POST, "/items/trash", stale)
        .await;
    assert_eq!(refused.code(), "trash_plan_changed", "{}", refused.text);
    assert_eq!(instance.get(&token, &path).await.status, StatusCode::OK);

    let fresh = json!({ "ids": [id], "digest": refused.json()["error"]["details"]["digest"] });
    let taken = instance
        .call(&token, Method::POST, "/items/trash", fresh)
        .await;
    assert_eq!(taken.status, StatusCode::OK, "{}", taken.text);
    let hidden = instance.get(&token, &path).await;
    assert_eq!(hidden.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn a_write_that_fails_keeps_the_tombstone_it_would_have_cleared() {
    let instance = Instance::start().await;
    let (_, token) = instance.key_with("tomb", purger("write")).await;
    let body = json!({
        "type": "core.note",
        "source_id": "returning",
        "properties": { "body": "back" },
    });
    let (_, path) = made(&instance, &token, body.clone()).await;
    binned(&instance, &token, &path).await;
    let purging = format!("{path}/purge");
    let purged = instance
        .call(&token, Method::POST, &purging, json!({}))
        .await;
    assert_eq!(purged.status, StatusCode::OK, "{}", purged.text);
    let tombstones = "SELECT count(*) FROM natural_key_tombstones";
    assert_eq!(instance.count(tombstones), 1);

    for fault in ["fail:commit", "fail:audit"] {
        instance.app.faults.set(fault, Some("item.create")).unwrap();
        let failed = instance
            .call(&token, Method::POST, "/items", body.clone())
            .await;
        instance.app.faults.clear(Some(fault));
        assert!(failed.status.is_server_error(), "{}", failed.text);
        assert_eq!(instance.count(tombstones), 1, "{fault}");
    }

    made(&instance, &token, body).await;
    assert_eq!(instance.count(tombstones), 0);
}

fn page_of(count: usize) -> Vec<Value> {
    (0..count)
        .map(|at| json!({ "type": "core.note", "properties": { "body": format!("entry {at}") } }))
        .collect()
}

#[tokio::test]
async fn a_best_effort_page_keeps_the_entries_around_the_one_that_failed() {
    let instance = Instance::start().await;
    let (_, token) = instance.key("best", notes("write")).await;
    let mut items = page_of(600);
    items[500] = json!({ "type": "core.note", "properties": { "body": 7 } });
    let page = json!({ "atomic": false, "items": items });

    let answer = instance
        .call(&token, Method::POST, "/items/bulk", page)
        .await;
    assert_eq!(answer.status, StatusCode::OK, "{}", answer.text);
    let answer = answer.json();
    let results = answer["results"].as_array().unwrap();
    assert_eq!(results.len(), 600);
    assert_eq!(results[500]["outcome"], "errored");
    assert_eq!(results[500]["index"], 500);
    assert_eq!(results[499]["outcome"], "created");
    assert_eq!(results[501]["outcome"], "created");
    let written = instance.written();
    assert_eq!((written.items, written.events), (599, 599));
}

#[tokio::test]
async fn an_atomic_page_whose_last_entry_fails_writes_nothing() {
    let instance = Instance::start().await;
    let (_, token) = instance.key("atomic", notes("write")).await;
    let mut items = page_of(50);
    let before = instance.written();
    let good = items[49].clone();
    items[49] = json!({ "type": "core.note", "properties": { "body": 7 } });

    let page = json!({ "items": items.clone() });
    let refused = instance
        .call(&token, Method::POST, "/items/bulk", page)
        .await;
    assert_eq!(refused.status, StatusCode::BAD_REQUEST, "{}", refused.text);
    assert_eq!(refused.code(), "bulk_atomic_rollback");
    assert_eq!(refused.json()["error"]["details"]["index"], 49);
    assert_eq!(instance.written(), before);

    items[49] = good;
    let page = json!({ "items": items });
    let landed = instance
        .call(&token, Method::POST, "/items/bulk", page)
        .await;
    assert_eq!(landed.status, StatusCode::OK, "{}", landed.text);
    assert_eq!(instance.written().items, 50);
}

#[tokio::test]
async fn a_tag_or_property_name_the_rules_refuse_refuses_the_whole_page() {
    let instance = Instance::start().await;
    let (_, token) = instance.key("text", notes("write")).await;
    let before = instance.written();
    let long = "a".repeat(129);
    for (atomic, fields) in [
        (true, json!({ "tags": [""] })),
        (true, json!({ "tags": ["   "] })),
        (false, json!({ "tags": [long] })),
        (true, json!({ "properties": { "": 1 } })),
    ] {
        let mut entry = json!({ "type": "core.note" });
        entry
            .as_object_mut()
            .unwrap()
            .extend(fields.as_object().unwrap().clone());
        let page = json!({ "atomic": atomic, "items": [entry] });
        let refused = instance
            .call(&token, Method::POST, "/items/bulk", page)
            .await;
        assert_eq!(refused.status, StatusCode::BAD_REQUEST, "{}", refused.text);
        assert_eq!(refused.code(), "validation_error", "{}", refused.text);
    }
    assert_eq!(instance.written(), before);
}

#[tokio::test]
async fn a_page_naming_one_natural_key_twice_lands_on_one_row() {
    let instance = Instance::start().await;
    let (_, token) = instance.key("twice", notes("write")).await;
    for (atomic, source_id) in [(true, "atomic"), (false, "best")] {
        let entry = |body: &str| {
            json!({
                "type": "core.note",
                "source_id": source_id,
                "properties": { "body": body },
            })
        };
        let page = json!({ "atomic": atomic, "items": [entry("first"), entry("second")] });
        let answer = instance
            .call(&token, Method::POST, "/items/bulk", page)
            .await;
        assert_eq!(answer.status, StatusCode::OK, "{}", answer.text);
        let answer = answer.json();
        let results = answer["results"].as_array().unwrap();
        assert_eq!(results[0]["outcome"], "created");
        assert_eq!(results[1]["outcome"], "updated");
        assert_eq!(results[0]["id"], results[1]["id"]);
        let path = format!("/items/{}", results[0]["id"].as_str().unwrap());
        let read = instance.get(&token, &path).await.json();
        assert_eq!(read["item"]["properties"]["body"], "second");
        assert_eq!(read["item"]["version"], 2);
    }
    assert_eq!(instance.written().items, 2);
}

#[tokio::test]
async fn a_system_row_stays_out_of_the_bin_where_a_note_goes_in() {
    let instance = Instance::start().await;
    let (_, token) = instance.key("system", json!({ "*": "write" })).await;
    let id = "01900000-0000-7000-8000-000000000001";
    let file = instance.dir.path().join("marfa.db");
    Connection::open(file)
        .unwrap()
        .execute(
            "INSERT INTO items (id, type, state, source, properties, version, schema_version, \
             occurred_at, created_at, updated_at) VALUES (?1, 'system.folder', 'active', 'system', \
             jsonb('{}'), 1, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', \
             '2026-01-01T00:00:00.000Z')",
            [id],
        )
        .unwrap();

    let path = format!("/items/{id}");
    let refused = instance
        .call(&token, Method::DELETE, &path, json!({}))
        .await;
    assert_eq!(refused.status, StatusCode::FORBIDDEN, "{}", refused.text);
    assert_eq!(refused.code(), "type_not_permitted");
    let state = format!("SELECT count(*) FROM items WHERE id = '{id}' AND state = 'active'");
    assert_eq!(instance.count(&state), 1);

    let item = instance.note(&token, "binned").await;
    binned(
        &instance,
        &token,
        &format!("/items/{}", item["id"].as_str().unwrap()),
    )
    .await;
}

#[tokio::test]
async fn a_key_that_may_only_read_and_a_state_nothing_has_move_nothing() {
    let instance = Instance::start().await;
    let (_, writer) = instance.key("writer", notes("write")).await;
    let (_, reader) = instance.key_with("reader", purger("read")).await;
    let item = instance.note(&writer, "held").await;
    let path = format!("/items/{}", item["id"].as_str().unwrap());
    let moving = format!("{path}/transition");

    let unknown = json!({ "state": "shredded" });
    let refused = instance.call(&writer, Method::POST, &moving, unknown).await;
    assert_eq!(refused.status, StatusCode::BAD_REQUEST, "{}", refused.text);
    assert_eq!(refused.code(), "validation_error");

    let before = instance.written();
    let binning = json!({ "state": "trashed" });
    for (method, door, body) in [
        (Method::DELETE, path.clone(), json!({})),
        (Method::POST, moving.clone(), binning.clone()),
        (Method::POST, format!("{path}/restore"), json!({})),
        (Method::POST, format!("{path}/purge"), json!({})),
    ] {
        let refused = instance.call(&reader, method, &door, body).await;
        assert_eq!(
            refused.status,
            StatusCode::FORBIDDEN,
            "{door}: {}",
            refused.text
        );
        assert_eq!(refused.code(), "type_not_permitted");
    }
    assert_eq!(instance.written(), before);

    let moved = instance.call(&writer, Method::POST, &moving, binning).await;
    assert_eq!(moved.status, StatusCode::OK, "{}", moved.text);
}

#[tokio::test]
async fn a_row_placed_at_a_copys_id_cannot_take_the_losing_edit() {
    let marfa = Instance::start().await;
    let (key_id, token) = marfa.key("copies", json!({ "core.note": "write" })).await;
    let note = |body: &str, id: Option<&str>| {
        let mut made = json!({ "type": "core.note", "properties": { "body": body } });
        if let Some(id) = id {
            made["id"] = json!(id);
        }
        made
    };
    let made = marfa
        .call(&token, Method::POST, "/items", note("first", None))
        .await
        .json();
    let id = made["item"]["id"].as_str().unwrap().to_string();
    let path = format!("/items/{id}");
    let winner = json!({ "properties": { "body": "winner" }, "version": 1 });
    let won = marfa.call(&token, Method::PATCH, &path, winner).await;
    assert_eq!(won.status, StatusCode::OK, "{}", won.text);

    let guessed = copy_id(&id, 1, &format!("{key_id}\0retry"));
    let placed = marfa
        .call(
            &token,
            Method::POST,
            "/items",
            note("unrelated", Some(&guessed)),
        )
        .await;
    assert_eq!(placed.status, StatusCode::CREATED, "{}", placed.text);

    let loser = json!({ "properties": { "body": "the losing edit" }, "version": 1 });
    let sent = request(
        Method::PATCH,
        &format!("{path}?conflict=auto"),
        Some(&token),
        Some(loser.to_string()),
        Some("retry"),
    );
    let resolved = send(marfa.public.clone(), sent).await;
    assert_eq!(resolved.status, StatusCode::OK, "{}", resolved.text);
    let answer = resolved.json();
    let copy = answer["conflict_resolution"]["conflicted_copy_id"]
        .as_str()
        .unwrap();
    assert_ne!(copy, guessed);
    let kept = marfa.get(&token, &format!("/items/{copy}")).await.json();
    assert_eq!(kept["item"]["properties"]["body"], "the losing edit");
}

#[tokio::test]
async fn a_search_score_says_nothing_of_rows_the_key_cannot_read() {
    let marfa = Instance::start().await;
    let (_, reader) = marfa.key("notes", json!({ "core.note": "write" })).await;
    let (_, other) = marfa.key("tasks", json!({ "core.task": "write" })).await;
    for body in ["canary", "canary and a few more words besides"] {
        let made = json!({ "type": "core.note", "properties": { "body": body } });
        let made = marfa.call(&reader, Method::POST, "/items", made).await;
        assert_eq!(made.status, StatusCode::CREATED, "{}", made.text);
    }
    for _ in 0..5 {
        let filler = json!({ "type": "core.task", "properties": { "title": "elsewhere" } });
        let filler = marfa.call(&other, Method::POST, "/items", filler).await;
        assert_eq!(filler.status, StatusCode::CREATED, "{}", filler.text);
    }
    let task = json!({ "type": "core.task", "properties": { "title": "canary" } });
    let task = marfa
        .call(&other, Method::POST, "/items", task)
        .await
        .json();
    let task_id = task["item"]["id"].as_str().unwrap().to_string();
    let scores = async || -> Vec<Value> {
        let found = marfa.get(&reader, "/search?q=canary").await;
        assert_eq!(found.status, StatusCode::OK, "{}", found.text);
        found.json()["data"]
            .as_array()
            .unwrap()
            .iter()
            .map(|hit| hit["relevance_score"].clone())
            .collect()
    };
    let before = scores().await;
    assert_eq!(before.len(), 2);
    assert!(before[0].as_f64().unwrap() > before[1].as_f64().unwrap());

    let renamed = json!({ "properties": { "title": "unrelated" }, "version": 1 });
    let renamed = marfa
        .call(&other, Method::PATCH, &format!("/items/{task_id}"), renamed)
        .await;
    assert_eq!(renamed.status, StatusCode::OK, "{}", renamed.text);
    assert_eq!(scores().await, before);
    let worst_first = marfa
        .get(&reader, "/search?q=canary&direction=asc&limit=1")
        .await;
    assert_eq!(worst_first.status, StatusCode::OK, "{}", worst_first.text);
    let shown = worst_first.json()["data"][0]["relevance_score"].clone();
    assert_eq!(shown, before[1]);
}
