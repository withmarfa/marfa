//! What moves a reach, and what leaves it, read from the instance's own counter.

use std::sync::Arc;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Method, Request, StatusCode, header};
use marfa_server::app::App;
use marfa_server::app::access::{Caller, reach::Judge};
use marfa_server::http::{control, public};
use marfa_server::settings::{Environment, Settings};
use serde_json::{Value, json};
use tempfile::TempDir;
use tower::ServiceExt;

struct Instance {
    dir: TempDir,
    app: Arc<App>,
    public: Router,
    control: Router,
    owner: String,
}

struct Reply {
    status: StatusCode,
    body: Value,
}

fn request(method: Method, path: &str, token: Option<&str>, body: Option<Value>) -> Request<Body> {
    let mut builder = Request::builder().method(method).uri(path);
    if let Some(token) = token {
        builder = builder.header(header::AUTHORIZATION, format!("Bearer {token}"));
    }
    match body {
        Some(body) => builder
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .unwrap(),
        None => builder.body(Body::empty()).unwrap(),
    }
}

async fn send(router: &Router, request: Request<Body>) -> Reply {
    let response = router.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    Reply {
        status,
        body: serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    }
}

impl Instance {
    async fn start() -> Instance {
        Instance::open(TempDir::new().unwrap(), None).await
    }

    async fn open(dir: TempDir, owner: Option<String>) -> Instance {
        let database = dir.path().join("marfa.db");
        let blobs = dir.path().join("blobs");
        let socket = dir.path().join("s.sock");
        let pairs = [
            ("SQLITE_PATH", database.to_str().unwrap()),
            ("BLOB_PATH", blobs.to_str().unwrap()),
            ("MARFA_CONTROL_SOCKET", socket.to_str().unwrap()),
            ("RATE_LIMIT_ENABLED", "false"),
        ];
        let settings = Settings::read(Environment::from_pairs(&pairs)).unwrap();
        let app = App::start(settings).await.unwrap();
        let mut instance = Instance {
            dir,
            public: public(app.clone()),
            control: control(app.clone()),
            app,
            owner: owner.clone().unwrap_or_default(),
        };
        if owner.is_some() {
            return instance;
        }
        let minted = send(
            &instance.control,
            request(
                Method::POST,
                "/keys",
                None,
                Some(json!({
                    "label": "owner",
                    "source": "owner",
                    "permissions": ["schema.write"],
                    "type_permissions": { "*": "write" },
                    "edge_permissions": { "*": "write" },
                    "metadata_permissions": { "edge_types": "write", "types": "write" },
                })),
            ),
        )
        .await;
        assert_eq!(minted.status, StatusCode::CREATED, "{}", minted.body);
        instance.owner = minted.body["key"].as_str().unwrap().to_string();
        instance
    }

    async fn restart(self) -> Instance {
        self.app.db.close().await;
        let Instance { dir, owner, .. } = self;
        Instance::open(dir, Some(owner)).await
    }

    async fn local(&self, method: Method, path: &str, body: Option<Value>) -> Reply {
        let reply = send(&self.public, request(method, path, Some(&self.owner), body)).await;
        assert!(
            reply.status.is_success() || reply.status == StatusCode::CONFLICT,
            "{path}: {} {}",
            reply.status,
            reply.body
        );
        reply
    }

    /// The reach of the private local process, read in a snapshot of its own.
    async fn reach(&self) -> String {
        let judge = Judge::of(&self.app);
        let clock = self.app.clock.clone();
        self.app
            .db
            .read(move |tx| {
                let caller = Caller::local().current(tx, &clock.stamp())?;
                judge.reach(tx, &caller)
            })
            .await
            .unwrap()
    }

    async fn note(&self, body: &str) -> Value {
        let made = self
            .local(
                Method::POST,
                "/items",
                Some(json!({ "type": "core.note", "properties": { "body": body } })),
            )
            .await;
        made.body["item"].clone()
    }

    async fn edge(&self, source: &str, target: &str) -> Value {
        let made = self
            .local(
                Method::POST,
                "/edges",
                Some(json!({ "source_id": source, "target_id": target, "edge_type": "acme.pairs" })),
            )
            .await;
        made.body["edge"].clone()
    }

    async fn moves(&self, work: impl std::future::Future<Output = ()>) -> bool {
        let before = self.reach().await;
        work.await;
        self.reach().await != before
    }
}

fn simple(id: &str, parent: Option<&str>) -> Value {
    let mut body = json!({ "id": id, "fields": { "note": { "type": "string" } } });
    if let Some(parent) = parent {
        body["parent"] = json!(parent);
    }
    body
}

#[tokio::test]
async fn a_reach_is_sixty_four_lowercase_hexadecimal_characters_that_one_instance_repeats() {
    let instance = Instance::start().await;
    let reach = instance.reach().await;
    assert_eq!(reach.len(), 64);
    assert!(reach.bytes().all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f')));
    assert_eq!(reach, instance.reach().await);
    let other = Instance::start().await;
    assert_ne!(reach, other.reach().await);
}

#[tokio::test]
async fn a_retype_moves_the_reach_and_a_write_that_keeps_the_type_does_not() {
    let instance = Instance::start().await;
    let note = instance.note("first").await;
    let id = note["id"].as_str().unwrap().to_string();
    let path = format!("/items/{id}");

    assert!(
        !instance
            .moves(async {
                let kept = instance
                    .local(
                        Method::PATCH,
                        &path,
                        Some(json!({ "version": note["version"], "properties": { "body": "again" } })),
                    )
                    .await;
                assert_eq!(kept.status, StatusCode::OK);
                let same = instance
                    .local(
                        Method::PATCH,
                        &path,
                        Some(json!({
                            "version": kept.body["item"]["version"],
                            "type": "core.note",
                            "retype": true,
                            "properties": { "body": "same type" },
                        })),
                    )
                    .await;
                assert_eq!(same.status, StatusCode::OK, "{}", same.body);
                instance.note("another").await;
            })
            .await,
        "a write that moves no item to another type leaves the reach"
    );

    let current = instance.local(Method::GET, &path, None).await.body["item"]["version"].clone();
    assert!(
        instance
            .moves(async {
                let moved = instance
                    .local(
                        Method::PATCH,
                        &path,
                        Some(json!({
                            "version": current,
                            "type": "core.bookmark",
                            "retype": true,
                            "properties": { "url": "https://example.com/a" },
                        })),
                    )
                    .await;
                assert_eq!(moved.status, StatusCode::OK, "{}", moved.body);
            })
            .await,
        "an item moved to another type moves the reach"
    );
}

#[tokio::test]
async fn a_retype_in_a_bulk_write_moves_the_reach() {
    let instance = Instance::start().await;
    let note = instance.note("bulk").await;
    assert!(
        instance
            .moves(async {
                let moved = instance
                    .local(
                        Method::POST,
                        "/items/bulk",
                        Some(json!({ "retype": true, "items": [{
                            "id": note["id"],
                            "type": "core.bookmark",
                            "properties": { "url": "https://example.com/b" },
                        }] })),
                    )
                    .await;
                assert_eq!(moved.status, StatusCode::OK, "{}", moved.body);
            })
            .await
    );
}

#[tokio::test]
async fn an_edge_moves_the_reach_when_its_source_moves_and_not_when_only_its_target_does() {
    let instance = Instance::start().await;
    let (a, b, c) = (
        instance.note("a").await,
        instance.note("b").await,
        instance.note("c").await,
    );
    let (a, b, c) = (
        a["id"].as_str().unwrap(),
        b["id"].as_str().unwrap(),
        c["id"].as_str().unwrap(),
    );
    instance
        .local(
            Method::POST,
            "/edge-types",
            Some(json!({
                "id": "acme.pairs",
                "label": "Pairs",
                "reverse_name": "acme.paired-by",
                "reverse_label": "Paired by",
                "cardinality": "one-to-one",
            })),
        )
        .await;
    let mut edge = None;
    assert!(
        !instance
            .moves(async {
                edge = Some(instance.edge(a, b).await);
            })
            .await,
        "an edge written moves nothing"
    );
    let edge = edge.unwrap();
    let path = format!("/edges/{}", edge["id"].as_str().unwrap());
    let mut version = edge["version"].clone();
    assert!(
        !instance
            .moves(async {
                let moved = instance
                    .local(
                        Method::PATCH,
                        &path,
                        Some(json!({ "version": version, "target_id": c })),
                    )
                    .await;
                assert_eq!(moved.status, StatusCode::OK, "{}", moved.body);
                version = moved.body["edge"]["version"].clone();
            })
            .await,
        "a target move leaves the reach"
    );
    assert!(
        instance
            .moves(async {
                let moved = instance
                    .local(
                        Method::PATCH,
                        &path,
                        Some(json!({ "version": version, "source_id": b })),
                    )
                    .await;
                assert_eq!(moved.status, StatusCode::OK, "{}", moved.body);
            })
            .await,
        "a source move changes it"
    );
}

#[tokio::test]
async fn a_type_registered_given_another_parent_or_deleted_moves_the_reach() {
    let instance = Instance::start().await;
    assert!(
        instance
            .moves(async {
                instance
                    .local(Method::POST, "/types", Some(simple("acme.top", None)))
                    .await;
            })
            .await,
        "a registration"
    );
    instance
        .local(Method::POST, "/types", Some(simple("acme.other", None)))
        .await;
    instance
        .local(Method::POST, "/types", Some(simple("acme.leaf", Some("acme.top"))))
        .await;
    assert!(
        !instance
            .moves(async {
                let mut kept = simple("acme.leaf", Some("acme.top"));
                kept["label"] = json!("Leaf");
                instance.local(Method::PUT, "/types/acme.leaf", Some(kept)).await;
            })
            .await,
        "a replacement that keeps the parent"
    );
    assert!(
        instance
            .moves(async {
                instance
                    .local(
                        Method::PUT,
                        "/types/acme.leaf",
                        Some(simple("acme.leaf", Some("acme.other"))),
                    )
                    .await;
            })
            .await,
        "a replacement that gives another parent"
    );
    assert!(
        instance
            .moves(async {
                instance.local(Method::DELETE, "/types/acme.leaf", None).await;
            })
            .await,
        "a deletion"
    );
}

#[tokio::test]
async fn an_edge_type_registered_or_deleted_moves_the_reach_and_one_widened_does_not() {
    let instance = Instance::start().await;
    let body = json!({
        "id": "acme.cites",
        "label": "Cites",
        "reverse_name": "acme.cited-by",
        "reverse_label": "Cited by",
        "cardinality": "many-to-many",
        "source_type_constraints": ["core.note"],
    });
    assert!(
        instance
            .moves(async {
                instance.local(Method::POST, "/edge-types", Some(body.clone())).await;
            })
            .await
    );
    let mut widened = body.clone();
    widened["evolve_constraints"] = json!(true);
    widened["source_type_constraints"] = json!(["core.note", "core.task"]);
    assert!(
        !instance
            .moves(async {
                instance.local(Method::POST, "/edge-types", Some(widened)).await;
            })
            .await
    );
    assert!(
        instance
            .moves(async {
                instance.local(Method::DELETE, "/edge-types/acme.cites", None).await;
            })
            .await
    );
}

#[tokio::test]
async fn a_write_that_is_refused_leaves_the_reach_as_it_was() {
    let instance = Instance::start().await;
    let note = instance.note("refused").await;
    let before = instance.reach().await;
    let refused = send(
        &instance.public,
        request(
            Method::PATCH,
            &format!("/items/{}", note["id"].as_str().unwrap()),
            Some(&instance.owner),
            Some(json!({ "version": note["version"], "type": "core.task", "retype": true, "properties": { "body": "no title" } })),
        ),
    )
    .await;
    assert!(refused.status.is_client_error(), "{}", refused.body);
    assert_eq!(before, instance.reach().await);
}

#[tokio::test]
async fn the_reach_is_the_same_after_a_restart() {
    let instance = Instance::start().await;
    let note = instance.note("durable").await;
    instance
        .local(
            Method::PATCH,
            &format!("/items/{}", note["id"].as_str().unwrap()),
            Some(json!({
                "version": note["version"],
                "type": "core.bookmark",
                "retype": true,
                "properties": { "url": "https://example.com/c" },
            })),
        )
        .await;
    let before = instance.reach().await;
    let again = instance.restart().await;
    assert_eq!(before, again.reach().await);
}
