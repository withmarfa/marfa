//! The reference index every write keeps: which rows name a blob, and whether each lends.

use std::sync::Arc;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Method, Request, StatusCode, header};
use marfa_server::app::App;
use marfa_server::http::{control, public};
use marfa_server::settings::{Environment, Settings};
use rusqlite::{Connection, OpenFlags};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tempfile::TempDir;
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

/// One row of the index: the hash, the row kind, the namespace, the version and whether it lends.
type Reference = (String, String, String, i64, bool);

fn hash_of(bytes: &[u8]) -> String {
    format!("sha256:{}", hex::encode(Sha256::digest(bytes)))
}

fn bare(hash: &str) -> &str {
    hash.strip_prefix("sha256:").unwrap()
}

async fn send(router: &Router, request: Request<Body>) -> Reply {
    let response = router.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    Reply {
        status,
        text: String::from_utf8_lossy(&bytes).to_string(),
    }
}

fn request(method: Method, path: &str, token: Option<&str>, body: Option<Body>) -> Request<Body> {
    let mut builder = Request::builder().method(method).uri(path);
    if let Some(token) = token {
        builder = builder.header(header::AUTHORIZATION, format!("Bearer {token}"));
    }
    match body {
        Some(body) => builder
            .header(header::CONTENT_TYPE, "application/json")
            .body(body)
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
        let body = Body::from(body.to_string());
        send(&self.control, request(method, path, None, Some(body))).await
    }

    async fn key(&self, source: &str, grants: Value) -> (String, String) {
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

    async fn token(&self, source: &str, types: Value) -> String {
        self.key(source, json!({ "type_permissions": types }))
            .await
            .1
    }

    async fn call(&self, token: &str, method: Method, path: &str, body: Value) -> Reply {
        let body = Body::from(body.to_string());
        send(&self.public, request(method, path, Some(token), Some(body))).await
    }

    async fn keyed(&self, token: &str, key: &str, body: Value) -> Reply {
        let mut sent = request(
            Method::POST,
            "/items",
            Some(token),
            Some(Body::from(body.to_string())),
        );
        sent.headers_mut()
            .insert("idempotency-key", key.parse().unwrap());
        send(&self.public, sent).await
    }

    async fn upload(&self, token: &str, bytes: &[u8]) -> String {
        let sent = Request::builder()
            .method(Method::POST)
            .uri("/blobs")
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .body(Body::from(bytes.to_vec()))
            .unwrap();
        let stored = send(&self.public, sent).await;
        assert_eq!(stored.status, StatusCode::CREATED, "{}", stored.text);
        stored.json()["hash"].as_str().unwrap().to_string()
    }

    async fn reads(&self, token: &str, hash: &str) -> bool {
        let path = format!("/blobs/{hash}");
        let read = send(&self.public, request(Method::GET, &path, Some(token), None)).await;
        assert!(
            read.status == StatusCode::OK || read.code() == "blob_not_found",
            "{}",
            read.text
        );
        read.status == StatusCode::OK
    }

    async fn made(&self, token: &str, body: Value) -> Value {
        let made = self.call(token, Method::POST, "/items", body).await;
        assert_eq!(made.status, StatusCode::CREATED, "{}", made.text);
        made.json()["item"].clone()
    }

    async fn note(&self, token: &str, body: &str) -> String {
        let made = self
            .made(
                token,
                json!({ "type": "core.note", "properties": { "body": body } }),
            )
            .await;
        made["id"].as_str().unwrap().to_string()
    }

    fn db(&self) -> Connection {
        let file = self.dir.path().join("marfa.db");
        Connection::open_with_flags(file, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap()
    }

    /// The index rows of the item `id`, its namespaces and its versions.
    fn of_item(&self, id: &str) -> Vec<Reference> {
        self.select(
            "SELECT r.hash, r.kind, r.namespace, r.version, r.lends FROM blob_references r \
             JOIN items i ON i.seq = r.seq WHERE i.id = ?1 AND r.kind <> 'edge' \
             ORDER BY r.kind, r.namespace, r.version, r.hash",
            id,
        )
    }

    fn on_item(&self, id: &str) -> Vec<Reference> {
        let mut own = self.of_item(id);
        own.retain(|reference| reference.1 == "item");
        own
    }

    fn of_edge(&self, id: &str) -> Vec<Reference> {
        self.select(
            "SELECT r.hash, r.kind, r.namespace, r.version, r.lends FROM blob_references r \
             JOIN edges e ON e.seq = r.seq WHERE e.id = ?1 AND r.kind = 'edge' ORDER BY r.hash",
            id,
        )
    }

    fn select(&self, sql: &str, id: &str) -> Vec<Reference> {
        let db = self.db();
        let mut statement = db.prepare(sql).unwrap();
        statement
            .query_map([id], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            })
            .unwrap()
            .map(Result::unwrap)
            .collect()
    }

    fn count(&self, sql: &str) -> i64 {
        self.db().query_row(sql, [], |row| row.get(0)).unwrap()
    }

    fn references(&self) -> i64 {
        self.count("SELECT count(*) FROM blob_references")
    }

    fn items(&self) -> i64 {
        self.count("SELECT count(*) FROM items")
    }
}

fn item(hash: &str, lends: bool) -> Reference {
    (hash.to_string(), "item".into(), String::new(), 0, lends)
}

fn version(hash: &str, at: i64) -> Reference {
    (hash.to_string(), "version".into(), String::new(), at, false)
}

fn edge(hash: &str, lends: bool) -> Reference {
    (hash.to_string(), "edge".into(), String::new(), 0, lends)
}

fn sorted(mut references: Vec<Reference>) -> Vec<Reference> {
    references.sort();
    references
}

fn notes(level: &str) -> Value {
    json!({ "core.note": level })
}

fn file(hash: &str) -> Value {
    json!({
        "type": "core.file",
        "properties": {
            "title": "a.bin",
            "blob_ref": hash,
            "mime_type": "application/octet-stream",
            "size_bytes": 1,
        },
    })
}

#[tokio::test]
async fn a_digest_lends_only_where_its_writer_uploaded_it_or_could_read_it() {
    let marfa = Instance::start().await;
    let uploader = marfa.token("up", notes("write")).await;
    let reader = marfa.token("reader", notes("write")).await;
    let stranger = marfa.token("tasks", json!({ "core.task": "write" })).await;
    let hash = marfa.upload(&uploader, b"the bytes a note embeds").await;

    let task = marfa
        .made(
            &stranger,
            json!({ "type": "core.task", "properties": { "title": format!("see {hash}") } }),
        )
        .await;
    let task = task["id"].as_str().unwrap();
    assert_eq!(marfa.of_item(task), vec![item(&hash, false)]);
    assert!(!marfa.reads(&stranger, &hash).await);
    assert!(!marfa.reads(&reader, &hash).await);

    let uploaded = marfa.note(&uploader, &format!("![x]({hash})")).await;
    assert_eq!(marfa.of_item(&uploaded), vec![item(&hash, true)]);
    assert!(marfa.reads(&reader, &hash).await);
    assert!(!marfa.reads(&stranger, &hash).await);

    let read = marfa
        .note(&reader, &format!("again sha256%3A{}", bare(&hash)))
        .await;
    assert_eq!(marfa.of_item(&read), vec![item(&hash, true)]);
    assert_eq!(marfa.of_item(task), vec![item(&hash, false)]);
}

#[tokio::test]
async fn a_file_naming_bytes_its_writer_never_proved_is_refused_alike_and_leaves_nothing() {
    let marfa = Instance::start().await;
    let uploader = marfa.token("up", json!({ "core.note": "write" })).await;
    let writer = marfa.token("files", json!({ "core.file": "write" })).await;
    let held = marfa
        .upload(&uploader, b"bytes only the uploader proved")
        .await;
    let unheld = hash_of(b"bytes nobody uploaded");
    let (items, references) = (marfa.items(), marfa.references());

    let refused = marfa
        .call(&writer, Method::POST, "/items", file(&held))
        .await;
    let unknown = marfa
        .call(&writer, Method::POST, "/items", file(&unheld))
        .await;
    assert_eq!(refused.status, StatusCode::NOT_FOUND, "{}", refused.text);
    assert_eq!(refused.code(), "blob_not_found");
    assert_eq!(refused.text, unknown.text);
    assert_eq!((marfa.items(), marfa.references()), (items, references));

    let named_elsewhere = json!({
        "type": "core.file",
        "properties": {
            "title": format!("{held}.bin"),
            "blob_ref": "none",
            "mime_type": "application/octet-stream",
        },
    });
    let text = marfa.made(&writer, named_elsewhere).await;
    assert!(text["properties"].get("size_bytes").is_none());
    assert_eq!(
        marfa.of_item(text["id"].as_str().unwrap()),
        vec![item(&held, false)]
    );

    assert_eq!(
        marfa
            .upload(&writer, b"bytes only the uploader proved")
            .await,
        held
    );
    let taken = marfa.made(&writer, file(&held)).await;
    assert_eq!(taken["properties"]["size_bytes"], 30);
    assert_eq!(
        marfa.of_item(taken["id"].as_str().unwrap()),
        vec![item(&held, true)]
    );
}

#[tokio::test]
async fn a_size_of_another_shape_is_refused_and_a_file_that_lends_nothing_keeps_none() {
    let marfa = Instance::start().await;
    let owner = marfa.token("files", json!({ "core.file": "write" })).await;
    let hash = marfa.upload(&owner, b"twelve bytes").await;
    let mut wrong = file(&hash);
    wrong["properties"]["size_bytes"] = json!("12");
    let refused = marfa.call(&owner, Method::POST, "/items", wrong).await;
    assert_eq!(refused.status, StatusCode::BAD_REQUEST, "{}", refused.text);
    assert_eq!(refused.code(), "invalid_properties");

    let made = marfa.made(&owner, file(&hash)).await;
    assert_eq!(made["properties"]["size_bytes"], 12);
    let path = format!("/items/{}", made["id"].as_str().unwrap());
    let unnamed =
        json!({ "version": 1, "properties": { "blob_ref": bare(&hash), "size_bytes": 5 } });
    let updated = marfa.call(&owner, Method::PATCH, &path, unnamed).await;
    assert_eq!(updated.status, StatusCode::OK, "{}", updated.text);
    assert!(
        updated.json()["item"]["properties"]
            .get("size_bytes")
            .is_none()
    );
    assert_eq!(
        marfa.of_item(made["id"].as_str().unwrap()),
        vec![item(&hash, true), version(&hash, 1)]
    );
}

#[tokio::test]
async fn a_stale_write_and_its_keep_both_copy_credit_only_what_the_base_lacked() {
    let marfa = Instance::start().await;
    let grants =
        json!({ "type_permissions": notes("write"), "edge_permissions": { "*": "write" } });
    let first = marfa.key("first", grants.clone()).await.1;
    let second = marfa.key("second", grants).await.1;
    let kept = marfa.upload(&first, b"named by both versions").await;
    let dropped = marfa.upload(&first, b"named only by the base").await;
    assert_eq!(
        marfa.upload(&second, b"named only by the base").await,
        dropped
    );
    let fresh = marfa
        .upload(&second, b"named first by the stale write")
        .await;

    let id = marfa.note(&first, &format!("{kept} {dropped}")).await;
    for cover in [&kept, &fresh] {
        let target = marfa.note(&first, "target").await;
        let about = json!({
            "source_id": id,
            "target_id": target,
            "edge_type": "about",
            "properties": { "cover": cover },
        });
        let about = marfa.call(&first, Method::POST, "/edges", about).await;
        assert_eq!(about.status, StatusCode::CREATED, "{}", about.text);
    }
    let path = format!("/items/{id}");
    let won = json!({ "version": 1, "properties": { "body": format!("{kept} won") } });
    let won = marfa.call(&first, Method::PATCH, &path, won).await;
    assert_eq!(won.status, StatusCode::OK, "{}", won.text);

    let losing = format!("{kept} {dropped} {fresh}");
    let lost = json!({ "version": 1, "properties": { "body": losing } });
    let lost = marfa
        .call(
            &second,
            Method::PATCH,
            &format!("{path}?conflict=auto"),
            lost,
        )
        .await;
    assert_eq!(lost.status, StatusCode::OK, "{}", lost.text);
    let copy = lost.json()["conflict_resolution"]["conflicted_copy_id"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(
        sorted(marfa.of_item(&copy)),
        sorted(vec![
            item(&kept, true),
            item(&dropped, false),
            item(&fresh, true)
        ])
    );
    assert_eq!(marfa.on_item(&id), vec![item(&kept, true)]);
    let copied = marfa.select(
        "SELECT r.hash, r.kind, r.namespace, r.version, r.lends FROM blob_references r \
         JOIN edges e ON e.seq = r.seq WHERE e.source_id = ?1 AND r.kind = 'edge' ORDER BY r.hash",
        &copy,
    );
    assert_eq!(
        sorted(copied),
        sorted(vec![edge(&kept, true), edge(&fresh, false)])
    );

    let stale = json!({ "version": 1, "properties": { "title": format!("{dropped} {fresh}") } });
    let stale = marfa.call(&second, Method::PATCH, &path, stale).await;
    assert_eq!(stale.status, StatusCode::OK, "{}", stale.text);
    assert_eq!(
        sorted(marfa.on_item(&id)),
        sorted(vec![
            item(&kept, true),
            item(&dropped, false),
            item(&fresh, true)
        ])
    );
}

#[tokio::test]
async fn a_retype_keeps_each_digest_as_it_stood() {
    let marfa = Instance::start().await;
    let owner = marfa.token("all", json!({ "*": "write" })).await;
    let lending = marfa.upload(&owner, b"proved before the retype").await;
    let planted = hash_of(b"never uploaded");
    let id = marfa.note(&owner, &format!("{lending} {planted}")).await;
    assert_eq!(
        sorted(marfa.of_item(&id)),
        sorted(vec![item(&lending, true), item(&planted, false)])
    );

    let planted_bytes = marfa.upload(&owner, b"never uploaded").await;
    assert_eq!(planted_bytes, planted);
    let retype = json!({
        "version": 1,
        "type": "core.task",
        "retype": true,
        "properties": { "title": format!("{lending} {planted}") },
    });
    let moved = marfa
        .call(&owner, Method::PATCH, &format!("/items/{id}"), retype)
        .await;
    assert_eq!(moved.status, StatusCode::OK, "{}", moved.text);
    assert_eq!(moved.json()["item"]["type"], "core.task");
    assert_eq!(
        sorted(marfa.on_item(&id)),
        sorted(vec![item(&lending, true), item(&planted, false)])
    );
}

#[tokio::test]
async fn a_bulk_page_refuses_the_one_entry_and_an_atomic_page_stores_none_of_it() {
    let marfa = Instance::start().await;
    let uploader = marfa.token("up", notes("write")).await;
    let writer = marfa
        .token(
            "files",
            json!({ "core.file": "write", "core.note": "write" }),
        )
        .await;
    let theirs = marfa
        .upload(&uploader, b"bytes the writer never proved")
        .await;
    let own = marfa.upload(&writer, b"bytes the writer sent").await;
    let entries = json!([
        file(&own),
        file(&theirs),
        { "type": "core.note", "properties": { "body": theirs } },
    ]);

    let page = json!({ "atomic": true, "items": entries.clone() });
    let refused = marfa.call(&writer, Method::POST, "/items/bulk", page).await;
    assert!(refused.status.is_client_error(), "{}", refused.text);
    assert_eq!((marfa.items(), marfa.references()), (0, 0));

    let page = json!({ "atomic": false, "items": entries });
    let answer = marfa.call(&writer, Method::POST, "/items/bulk", page).await;
    assert_eq!(answer.status, StatusCode::OK, "{}", answer.text);
    let results = answer.json()["results"].clone();
    assert_eq!(results[0]["outcome"], "created", "{results}");
    assert_eq!(results[1]["outcome"], "errored", "{results}");
    assert_eq!(results[1]["error"]["code"], "blob_not_found", "{results}");
    assert_eq!(results[2]["outcome"], "created", "{results}");
    assert_eq!(marfa.items(), 2);
    assert_eq!(
        marfa.count("SELECT count(*) FROM blob_references WHERE lends = 1"),
        1
    );
    assert_eq!(
        marfa.count(&format!(
            "SELECT count(*) FROM blob_references WHERE hash = '{theirs}' AND lends = 0"
        )),
        1
    );
}

#[tokio::test]
async fn a_failed_write_leaves_the_index_as_it_was() {
    let marfa = Instance::start().await;
    let owner = marfa.token("owner", notes("write")).await;
    let first = marfa.upload(&owner, b"first").await;
    let second = marfa.upload(&owner, b"second").await;
    let id = marfa.note(&owner, &first).await;
    let path = format!("/items/{id}");
    let before = marfa.of_item(&id);
    let orphans = marfa.count("SELECT count(*) FROM blob_orphans");

    for fault in ["fail:commit", "fail:audit"] {
        for (action, method, door, body) in [
            (
                "item.update",
                Method::PATCH,
                path.as_str(),
                json!({ "version": 1, "properties": { "body": second } }),
            ),
            (
                "item.create",
                Method::POST,
                "/items",
                json!({ "type": "core.note", "properties": { "body": second } }),
            ),
        ] {
            let references = marfa.references();
            marfa.app.faults.set(fault, Some(action)).unwrap();
            let answer = marfa.call(&owner, method, door, body).await;
            marfa.app.faults.clear(Some(fault));
            assert!(answer.status.is_server_error(), "{}", answer.text);
            assert_eq!(marfa.references(), references, "{fault} on {action}");
            assert_eq!(marfa.of_item(&id), before, "{fault} on {action}");
            assert_eq!(marfa.count("SELECT count(*) FROM blob_orphans"), orphans);
        }
    }
    let update = json!({ "version": 1, "properties": { "body": second } });
    let landed = marfa.call(&owner, Method::PATCH, &path, update).await;
    assert_eq!(landed.status, StatusCode::OK, "{}", landed.text);
    assert_eq!(
        marfa.of_item(&id),
        vec![item(&second, true), version(&first, 1)]
    );
}

#[tokio::test]
async fn a_revoked_uploader_keeps_its_rows_lending_and_proves_nothing_after() {
    let marfa = Instance::start().await;
    let (uploader_id, uploader) = marfa
        .key("up", json!({ "type_permissions": notes("write") }))
        .await;
    let other = marfa.token("tasks", json!({ "core.task": "write" })).await;
    let reader = marfa.token("reader", notes("read")).await;
    let hash = marfa.upload(&uploader, b"bytes of a revoked key").await;
    let id = marfa.note(&uploader, &hash).await;

    let revoked = marfa
        .local(Method::DELETE, &format!("/keys/{uploader_id}"), json!({}))
        .await;
    assert!(revoked.status.is_success(), "{}", revoked.text);
    assert_eq!(marfa.of_item(&id), vec![item(&hash, true)]);
    assert!(marfa.reads(&reader, &hash).await);

    let task = marfa
        .made(
            &other,
            json!({ "type": "core.task", "properties": { "title": hash } }),
        )
        .await;
    assert_eq!(
        marfa.of_item(task["id"].as_str().unwrap()),
        vec![item(&hash, false)]
    );
}

#[tokio::test]
async fn an_edge_lends_through_a_source_in_the_bin_until_the_source_is_purged() {
    let marfa = Instance::start().await;
    let (_, owner) = marfa
        .key(
            "owner",
            json!({
                "permissions": ["items.purge"],
                "type_permissions": notes("write"),
                "edge_permissions": { "*": "write" },
            }),
        )
        .await;
    let reader = marfa
        .key(
            "reader",
            json!({ "type_permissions": notes("read"), "edge_permissions": { "*": "read" } }),
        )
        .await
        .1;
    let hash = marfa.upload(&owner, b"an edge's cover").await;
    let source = marfa.note(&owner, "source").await;
    let target = marfa.note(&owner, "target").await;
    let sent = json!({
        "source_id": source,
        "target_id": target,
        "edge_type": "about",
        "properties": { "cover": hash },
    });
    let made = marfa.call(&owner, Method::POST, "/edges", sent).await;
    assert_eq!(made.status, StatusCode::CREATED, "{}", made.text);
    let edge_id = made.json()["edge"]["id"].as_str().unwrap().to_string();
    assert_eq!(marfa.of_edge(&edge_id), vec![edge(&hash, true)]);

    let binned = marfa
        .call(
            &owner,
            Method::DELETE,
            &format!("/items/{source}"),
            json!({}),
        )
        .await;
    assert_eq!(binned.status, StatusCode::OK, "{}", binned.text);
    assert!(marfa.reads(&reader, &hash).await);

    let purged = marfa
        .call(
            &owner,
            Method::POST,
            &format!("/items/{source}/purge"),
            json!({}),
        )
        .await;
    assert_eq!(purged.status, StatusCode::OK, "{}", purged.text);
    assert_eq!(marfa.references(), 0);
    assert!(!marfa.reads(&reader, &hash).await);
}

#[tokio::test]
async fn an_edge_and_a_namespace_keep_the_standing_their_digests_entered_with() {
    let marfa = Instance::start().await;
    let (_, owner) = marfa
        .key(
            "owner",
            json!({
                "type_permissions": notes("write"),
                "edge_permissions": { "*": "write" },
                "extension_permissions": { "app": "write" },
            }),
        )
        .await;
    let (_, other) = marfa
        .key(
            "other",
            json!({
                "type_permissions": notes("write"),
                "edge_permissions": { "*": "write" },
                "extension_permissions": { "app": "write" },
            }),
        )
        .await;
    let lending = marfa.upload(&owner, b"proved by the owner").await;
    let planted = marfa.upload(&owner, b"planted by the other").await;
    let source = marfa.note(&owner, "source").await;
    let target = marfa.note(&owner, "target").await;
    let made = json!({
        "source_id": source,
        "target_id": target,
        "edge_type": "about",
        "properties": { "cover": lending },
    });
    let made = marfa.call(&owner, Method::POST, "/edges", made).await;
    assert_eq!(made.status, StatusCode::CREATED, "{}", made.text);
    let made = made.json()["edge"].clone();
    let edge_id = made["id"].as_str().unwrap();

    let patched = json!({
        "version": made["version"],
        "properties": { "cover": lending, "back": planted },
    });
    let patched = marfa
        .call(&other, Method::PATCH, &format!("/edges/{edge_id}"), patched)
        .await;
    assert_eq!(patched.status, StatusCode::OK, "{}", patched.text);
    assert_eq!(
        sorted(marfa.of_edge(edge_id)),
        sorted(vec![edge(&lending, true), edge(&planted, false)])
    );

    let namespace = format!("/items/{target}/extensions/app");
    let put = json!({ "a": lending, "b": format!("x {}", hash_of(b"unknown")) });
    let put = marfa.call(&other, Method::PUT, &namespace, put).await;
    assert_eq!(put.status, StatusCode::OK, "{}", put.text);
    let extension = |lends: bool, hash: &str| {
        (
            hash.to_string(),
            "extension".to_string(),
            "app".to_string(),
            0,
            lends,
        )
    };
    assert_eq!(
        sorted(marfa.of_item(&target)),
        sorted(vec![
            extension(true, &lending),
            extension(false, &hash_of(b"unknown"))
        ])
    );
    let cleared = marfa
        .call(&owner, Method::DELETE, &namespace, json!({}))
        .await;
    assert_eq!(cleared.status, StatusCode::OK, "{}", cleared.text);
    assert_eq!(marfa.of_item(&target), Vec::<Reference>::new());

    let gone = marfa
        .call(
            &owner,
            Method::DELETE,
            &format!("/edges/{edge_id}"),
            json!({}),
        )
        .await;
    assert!(gone.status.is_success(), "{}", gone.text);
    assert_eq!(marfa.of_edge(edge_id), Vec::<Reference>::new());
    assert_eq!(marfa.references(), 0);
}

#[tokio::test]
async fn a_version_names_what_its_item_named_lends_nothing_and_goes_with_the_purge() {
    let marfa = Instance::start().await;
    let (_, owner) = marfa
        .key(
            "owner",
            json!({ "permissions": ["items.purge"], "type_permissions": notes("write") }),
        )
        .await;
    let reader = marfa.token("reader", notes("read")).await;
    let old = marfa.upload(&owner, b"only the first version").await;
    let id = marfa.note(&owner, &old).await;
    let path = format!("/items/{id}");
    let moved = json!({ "version": 1, "properties": { "body": "nothing now" } });
    let moved = marfa.call(&owner, Method::PATCH, &path, moved).await;
    assert_eq!(moved.status, StatusCode::OK, "{}", moved.text);
    assert_eq!(marfa.of_item(&id), vec![version(&old, 1)]);
    assert!(!marfa.reads(&reader, &old).await);

    marfa.call(&owner, Method::DELETE, &path, json!({})).await;
    let purged = marfa
        .call(&owner, Method::POST, &format!("{path}/purge"), json!({}))
        .await;
    assert_eq!(purged.status, StatusCode::OK, "{}", purged.text);
    assert_eq!(marfa.references(), 0);
}

#[tokio::test]
async fn a_reference_takes_its_blob_off_the_orphan_report() {
    let marfa = Instance::start().await;
    let owner = marfa.token("owner", notes("write")).await;
    let hash = marfa.upload(&owner, b"reported, then named").await;
    let file = marfa.dir.path().join("marfa.db");
    Connection::open(file)
        .unwrap()
        .execute(
            "INSERT INTO blob_orphans (hash, reported_at) VALUES (?1, '2026-01-01T00:00:00.000Z')",
            [&hash],
        )
        .unwrap();
    assert_eq!(marfa.count("SELECT count(*) FROM blob_orphans"), 1);
    marfa.note(&owner, &hash).await;
    assert_eq!(marfa.count("SELECT count(*) FROM blob_orphans"), 0);
}

#[tokio::test]
async fn a_file_refused_for_its_bytes_keeps_no_answer_under_its_idempotency_key() {
    let marfa = Instance::start().await;
    let uploader = marfa.token("up", json!({ "core.file": "write" })).await;
    let writer = marfa.token("files", json!({ "core.file": "write" })).await;
    let hash = marfa
        .upload(&uploader, b"bytes the writer sends later")
        .await;

    let refused = marfa.keyed(&writer, "once", file(&hash)).await;
    assert_eq!(refused.code(), "blob_not_found", "{}", refused.text);
    marfa.upload(&writer, b"bytes the writer sends later").await;
    let taken = marfa.keyed(&writer, "once", file(&hash)).await;
    assert_eq!(taken.status, StatusCode::CREATED, "{}", taken.text);
    let replayed = marfa.keyed(&writer, "once", file(&hash)).await;
    assert_eq!(replayed.text, taken.text);
    assert_eq!(marfa.items(), 1);
}

#[tokio::test]
async fn a_lending_row_is_judged_by_the_types_it_has_now() {
    let marfa = Instance::start().await;
    let every = json!({ "*": "write" });
    let (_, owner) = marfa
        .key(
            "owner",
            json!({ "type_permissions": every, "edge_permissions": every }),
        )
        .await;
    let reader = |source: &'static str, types: Value| {
        marfa.key(
            source,
            json!({ "type_permissions": types, "edge_permissions": { "*": "read" } }),
        )
    };
    let notes = reader("notes", notes("read")).await.1;
    let tasks = reader("tasks", json!({ "core.task": "read" })).await.1;
    let retype = |id: String| {
        let owner = owner.clone();
        let marfa = &marfa;
        async move {
            let moved = json!({
                "version": 1,
                "type": "core.task",
                "retype": true,
                "properties": { "title": "now a task" },
            });
            let moved = marfa
                .call(&owner, Method::PATCH, &format!("/items/{id}"), moved)
                .await;
            assert_eq!(moved.status, StatusCode::OK, "{}", moved.text);
        }
    };
    let readers = async |hash: &str| {
        (
            marfa.reads(&notes, hash).await,
            marfa.reads(&tasks, hash).await,
        )
    };

    let own = marfa.upload(&owner, b"an item's own bytes").await;
    let item = marfa.note(&owner, &own).await;
    assert_eq!(readers(&own).await, (true, false));
    retype(item).await;
    assert_eq!(readers(&own).await, (false, true));

    let cover = marfa.upload(&owner, b"an edge's cover").await;
    let source = marfa.note(&owner, "source").await;
    let target = marfa.note(&owner, "target").await;
    let made = json!({
        "source_id": source,
        "target_id": target,
        "edge_type": "parent-of",
        "properties": { "cover": cover },
    });
    let made = marfa.call(&owner, Method::POST, "/edges", made).await;
    assert_eq!(made.status, StatusCode::CREATED, "{}", made.text);
    let made = made.json()["edge"].clone();
    assert_eq!(readers(&cover).await, (true, false));
    retype(source).await;
    assert_eq!(readers(&cover).await, (false, true));

    let moved_to = marfa.note(&owner, "another source").await;
    let moved = json!({ "version": made["version"], "source_id": moved_to });
    let path = format!("/edges/{}", made["id"].as_str().unwrap());
    let moved = marfa.call(&owner, Method::PATCH, &path, moved).await;
    assert_eq!(moved.status, StatusCode::OK, "{}", moved.text);
    assert_eq!(readers(&cover).await, (true, false));
}
