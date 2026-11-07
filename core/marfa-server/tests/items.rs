//! Where an item write's transaction ends, and what a retry sees. The
//! contract's fixtures hold the rest.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{HeaderMap, Method, Request, StatusCode, header};
use marfa_server::app::App;
use marfa_server::http::{control, public, serve_public};
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

/// What a transaction leaves behind, row by row.
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
            ("SQLITE_PATH", database.to_str().unwrap()),
            ("BLOB_PATH", blobs.to_str().unwrap()),
            ("MARFA_CONTROL_SOCKET", socket.to_str().unwrap()),
            ("MARFA_TEST_HOOKS", "true"),
            ("RATE_LIMIT_ENABLED", "false"),
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

    /// A key that writes under its own source, as `(id, secret)`.
    async fn key(&self, source: &str, types: Value) -> (String, String) {
        let body = json!({
            "label": source,
            "source": source,
            "permissions": [],
            "type_permissions": types,
        });
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

    // The witness: the same stale write merges for a key that may make it.
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

    // The witness: the same write, with no fault, leaves each of them.
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
async fn a_refusal_that_leaves_the_body_unread_still_reaches_the_client() {
    let instance = Instance::start().await;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let app = instance.app.clone();
    let server = tokio::spawn(serve_public(listener, app, std::future::pending()));

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
