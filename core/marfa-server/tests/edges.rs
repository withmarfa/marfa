//! The write on an edge's target that a cascade asks for, door by door, and writes that meet each other.

use std::sync::Arc;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Method, Request, StatusCode, header};
use marfa_server::app::App;
use marfa_server::http::{control, public};
use marfa_server::settings::{Environment, Settings};
use rusqlite::{Connection, OpenFlags, params};
use serde_json::{Value, json};
use tempfile::TempDir;
use tower::ServiceExt;

struct Instance {
    dir: TempDir,
    _app: Arc<App>,
    public: Router,
    control: Router,
    owner: String,
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

    fn refused(&self, status: StatusCode, code: &str) {
        assert_eq!((self.status, self.code()), (status, code), "{}", self.text);
    }

    fn landed(&self, status: StatusCode) -> &Value {
        assert_eq!(self.status, status, "{}", self.text);
        &self.body
    }
}

async fn send(
    router: Router,
    token: Option<&str>,
    method: Method,
    path: &str,
    body: Option<Value>,
) -> Reply {
    let mut builder = Request::builder().method(method).uri(path);
    if let Some(token) = token {
        builder = builder.header(header::AUTHORIZATION, format!("Bearer {token}"));
    }
    let sent = match body {
        Some(body) => builder
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string())),
        None => builder.body(Body::empty()),
    };
    let response = router.oneshot(sent.unwrap()).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let text = String::from_utf8(bytes.to_vec()).unwrap();
    Reply {
        status,
        body: serde_json::from_str(&text).unwrap_or(Value::Null),
        text,
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
            ("RATE_LIMIT_ENABLED", "false"),
        ];
        let settings = Settings::read(Environment::from_pairs(&pairs)).unwrap();
        let app = App::start(settings).await.unwrap();
        let mut instance = Instance {
            public: public(app.clone()),
            control: control(app.clone()),
            _app: app,
            dir,
            owner: String::new(),
        };
        let grants = json!({
            "label": "owner",
            "source": "owner",
            "permissions": ["items.purge", "schema.write"],
            "type_permissions": { "*": "write" },
            "edge_permissions": { "*": "write" },
            "metadata_permissions": { "edge_types": "write" },
        });
        instance.owner = instance.mint(grants).await;
        instance
    }

    async fn mint(&self, grants: Value) -> String {
        let minted = send(
            self.control.clone(),
            None,
            Method::POST,
            "/keys",
            Some(grants),
        )
        .await;
        minted.landed(StatusCode::CREATED)["key"]
            .as_str()
            .unwrap()
            .to_string()
    }

    async fn local(&self, method: Method, path: &str, body: Option<Value>) -> Reply {
        send(self.public.clone(), Some(&self.owner), method, path, body).await
    }

    async fn call(&self, token: &str, method: Method, path: &str, body: Value) -> Reply {
        send(self.public.clone(), Some(token), method, path, Some(body)).await
    }

    async fn key(&self, source: &str, types: Value) -> String {
        let body = json!({
            "label": source,
            "source": source,
            "permissions": [],
            "type_permissions": types,
            "edge_permissions": { "*": "write" },
            "metadata_permissions": { "edge_types": "write" },
        });
        self.mint(body).await
    }

    async fn item(&self, type_id: &str, properties: Value) -> String {
        let body = json!({ "type": type_id, "properties": properties });
        let made = self.local(Method::POST, "/items", Some(body)).await;
        made.landed(StatusCode::CREATED)["item"]["id"]
            .as_str()
            .unwrap()
            .to_string()
    }

    async fn note(&self) -> String {
        self.item("core.note", json!({ "body": "a note" })).await
    }

    async fn task(&self) -> String {
        self.item("core.task", json!({ "title": "a task" })).await
    }

    async fn edge(&self, source: &str, target: &str, edge_type: &str) -> Value {
        let body = json!({ "source_id": source, "target_id": target, "edge_type": edge_type });
        let made = self.local(Method::POST, "/edges", Some(body)).await;
        made.landed(StatusCode::CREATED)["edge"].clone()
    }

    fn db(&self) -> Connection {
        let file = self.dir.path().join("marfa.db");
        Connection::open_with_flags(file, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap()
    }

    fn edges_of(&self, edge_type: &str) -> i64 {
        self.db()
            .query_row(
                "SELECT count(*) FROM edges WHERE edge_type = ?1",
                params![edge_type],
                |row| row.get(0),
            )
            .unwrap()
    }
}

/// `core.task` is the row the key only reads, and `core.note` the one it writes.
#[tokio::test]
async fn an_edge_that_cascades_takes_write_on_its_targets_type_at_every_door() {
    let instance = Instance::start().await;
    let reader = instance
        .key(
            "reader",
            json!({ "core.note": "write", "core.task": "read" }),
        )
        .await;
    let writer = instance
        .key(
            "writer",
            json!({ "core.note": "write", "core.task": "write" }),
        )
        .await;
    let task = instance.task().await;
    let note = instance.note().await;
    let refused = |answer: &Reply| answer.refused(StatusCode::FORBIDDEN, "type_not_permitted");
    let edge = json!({ "source_id": note, "target_id": task, "edge_type": "parent-of" });

    refused(
        &instance
            .call(&reader, Method::POST, "/edges", edge.clone())
            .await,
    );

    let atomic = json!({ "atomic": true, "edges": [edge.clone()] });
    let page = instance
        .call(&reader, Method::POST, "/edges/bulk", atomic)
        .await;
    assert_eq!(page.status, StatusCode::FORBIDDEN, "{}", page.text);
    assert_eq!(page.body["error"]["details"]["code"], "type_not_permitted");

    let spread = json!({ "atomic": false, "edges": [edge.clone()] });
    let page = instance
        .call(&reader, Method::POST, "/edges/bulk", spread)
        .await;
    assert_eq!(
        page.landed(StatusCode::OK)["results"][0]["error"]["code"],
        "type_not_permitted"
    );

    let kind = json!({
        "id": "user.owns",
        "label": "Owns",
        "cardinality": "many-to-one",
        "cascade_on_delete": "cascade",
    });
    instance
        .local(Method::POST, "/edge-types", Some(kind))
        .await
        .landed(StatusCode::CREATED);
    let other = instance.note().await;
    let held = instance.edge(&note, &other, "user.owns").await;
    let moved = json!({ "version": held["version"], "target_id": task });
    let path = format!("/edges/{}", held["id"].as_str().unwrap());
    refused(
        &instance
            .call(&reader, Method::PATCH, &path, moved.clone())
            .await,
    );

    let inline = json!({
        "type": "core.note",
        "properties": { "body": "inline" },
        "edges": { "parent-of": [task] },
    });
    refused(
        &instance
            .call(&reader, Method::POST, "/items", inline.clone())
            .await,
    );

    let free = instance.note().await;
    let free_path = format!("/items/{free}");
    let body = json!({ "version": 1, "edges": { "parent-of": [task] } });
    refused(
        &instance
            .call(&reader, Method::PATCH, &free_path, body)
            .await,
    );

    let entry = json!({ "items": [inline.clone()] });
    let page = instance
        .call(&reader, Method::POST, "/items/bulk", entry)
        .await;
    assert_eq!(page.status, StatusCode::FORBIDDEN, "{}", page.text);
    assert_eq!(page.body["error"]["details"]["code"], "type_not_permitted");

    assert_eq!(instance.edges_of("parent-of"), 0);

    instance
        .call(&writer, Method::PATCH, &path, moved)
        .await
        .landed(StatusCode::OK);
    instance
        .call(&writer, Method::POST, "/edges", edge)
        .await
        .landed(StatusCode::CREATED);
}

#[tokio::test]
async fn registering_a_cascade_over_stored_edges_takes_write_on_their_targets() {
    let instance = Instance::start().await;
    let reader = instance
        .key(
            "reader",
            json!({ "core.note": "write", "core.task": "read" }),
        )
        .await;
    let writer = instance
        .key(
            "writer",
            json!({ "core.note": "write", "core.task": "write" }),
        )
        .await;
    let definition = |cascade: &str| {
        json!({
            "id": "user.holds",
            "label": "Holds",
            "cardinality": "many-to-many",
            "cascade_on_delete": cascade,
        })
    };
    let (note, task) = (instance.note().await, instance.task().await);
    instance
        .call(&writer, Method::POST, "/edge-types", definition("orphan"))
        .await
        .landed(StatusCode::CREATED);
    instance.edge(&note, &task, "user.holds").await;
    instance
        .local(Method::DELETE, "/edge-types/user.holds?force=true", None)
        .await
        .landed(StatusCode::OK);

    let refused = instance
        .call(&reader, Method::POST, "/edge-types", definition("cascade"))
        .await;
    refused.refused(StatusCode::FORBIDDEN, "type_not_permitted");
    assert!(!refused.text.contains("core.task"), "{}", refused.text);

    instance
        .call(&writer, Method::POST, "/edge-types", definition("cascade"))
        .await
        .landed(StatusCode::CREATED);
}

#[tokio::test]
async fn two_writes_that_each_look_fine_cannot_close_a_cycle() {
    let instance = Instance::start().await;
    let token = instance
        .key("writer", json!({ "core.note": "write" }))
        .await;
    for round in 0..20 {
        let (a, b) = (instance.note().await, instance.note().await);
        let edge = |source: &str, target: &str| json!({ "source_id": source, "target_id": target, "edge_type": "supersedes" });
        let (first, second) = tokio::join!(
            instance.call(&token, Method::POST, "/edges", edge(&a, &b)),
            instance.call(&token, Method::POST, "/edges", edge(&b, &a)),
        );
        let mut statuses = [first.status.as_u16(), second.status.as_u16()];
        statuses.sort_unstable();
        assert_eq!(statuses, [201, 400], "round {round}");
    }
}

#[tokio::test]
async fn an_end_purged_while_an_edge_is_made_leaves_no_edge_behind() {
    let instance = Instance::start().await;
    for _ in 0..20 {
        let (note, target) = (instance.note().await, instance.note().await);
        let path = format!("/items/{target}");
        instance
            .local(Method::DELETE, &path, None)
            .await
            .landed(StatusCode::OK);
        let purge = format!("/items/{target}/purge");
        let edge = json!({ "source_id": note, "target_id": target, "edge_type": "part-of" });
        let (purged, made) = tokio::join!(
            instance.local(Method::POST, &purge, None),
            instance.local(Method::POST, "/edges", Some(edge)),
        );
        purged.landed(StatusCode::OK);
        assert!(matches!(made.status.as_u16(), 201 | 404), "{}", made.text);
    }
    let dangling: i64 = instance
        .db()
        .query_row(
            "SELECT count(*) FROM edges e LEFT JOIN items i ON i.id = e.target_id \
             WHERE i.id IS NULL",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(dangling, 0);
}

#[tokio::test]
async fn a_restore_after_one_end_was_purged_brings_back_the_rest() {
    let instance = Instance::start().await;
    let (parent, kept, gone) = (
        instance.note().await,
        instance.note().await,
        instance.note().await,
    );
    instance.edge(&parent, &kept, "parent-of").await;
    instance.edge(&parent, &gone, "parent-of").await;
    let path = format!("/items/{parent}");
    instance
        .local(Method::DELETE, &path, None)
        .await
        .landed(StatusCode::OK);
    let purge = format!("/items/{gone}/purge");
    instance
        .local(Method::POST, &purge, None)
        .await
        .landed(StatusCode::OK);
    let restore = format!("/items/{parent}/restore");
    instance
        .local(Method::POST, &restore, None)
        .await
        .landed(StatusCode::OK);

    let read = format!("/items/{kept}");
    let back = instance.local(Method::GET, &read, None).await;
    assert_eq!(back.landed(StatusCode::OK)["item"]["state"], "active");
    assert_eq!(instance.edges_of("parent-of"), 1);
}

#[tokio::test]
async fn a_bulk_entry_is_judged_on_the_entries_before_it() {
    let instance = Instance::start().await;
    let token = instance
        .key("writer", json!({ "core.note": "write" }))
        .await;
    let (a, b, c) = (
        instance.note().await,
        instance.note().await,
        instance.note().await,
    );
    let edge = |source: &str, target: &str| json!({ "source_id": source, "target_id": target, "edge_type": "parent-of" });
    let page = json!({ "atomic": true, "edges": [edge(&a, &b), edge(&b, &c), edge(&c, &a)] });
    let answer = instance
        .call(&token, Method::POST, "/edges/bulk", page)
        .await;
    assert_eq!(answer.status, StatusCode::BAD_REQUEST, "{}", answer.text);
    assert_eq!(answer.body["error"]["details"]["index"], 2);
    assert_eq!(answer.body["error"]["details"]["code"], "edge_cycle");
    assert_eq!(instance.edges_of("parent-of"), 0);

    let page = json!({ "atomic": false, "edges": [edge(&a, &b), edge(&b, &c), edge(&c, &a)] });
    let answer = instance
        .call(&token, Method::POST, "/edges/bulk", page)
        .await;
    let counts = &answer.landed(StatusCode::OK)["counts"];
    assert_eq!(
        (&counts["created"], &counts["errored"]),
        (&json!(2), &json!(1))
    );
    assert_eq!(instance.edges_of("parent-of"), 2);
}

#[tokio::test]
async fn a_bulk_write_fans_out_only_when_it_asks() {
    let instance = Instance::start().await;
    let marks = || -> Vec<(String, i64)> {
        let db = instance.db();
        let mut read = db
            .prepare("SELECT event_type, fanout FROM event_log ORDER BY id")
            .unwrap();
        read.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    };
    let parent = instance.note().await;
    let note = |body: &str| json!({ "type": "core.note", "properties": { "body": body }, "edges": { "references": [&parent] } });
    for (atomic, asked) in [
        (true, None),
        (false, Some(false)),
        (true, Some(true)),
        (false, Some(true)),
    ] {
        let mut page = json!({ "atomic": atomic, "items": [note("a")] });
        if let Some(asked) = asked {
            page["enable_fanout"] = json!(asked);
        }
        let answer = instance
            .local(Method::POST, "/items/bulk", Some(page))
            .await;
        assert_eq!(answer.landed(StatusCode::OK)["counts"]["created"], 1);
    }
    let (a, b) = (instance.note().await, instance.note().await);
    let edge = json!({ "source_id": a, "target_id": b, "edge_type": "references" });
    for (atomic, asked) in [(true, None), (false, Some(false)), (false, Some(true))] {
        let mut page = json!({ "atomic": atomic, "mode": "upsert", "edges": [&edge] });
        if let Some(asked) = asked {
            page["enable_fanout"] = json!(asked);
        }
        let answer = instance
            .local(Method::POST, "/edges/bulk", Some(page))
            .await;
        assert_eq!(answer.landed(StatusCode::OK)["counts"]["errored"], 0);
    }
    let page = json!({ "edges": [&edge], "enable_fanout": "yes" });
    instance
        .local(Method::POST, "/edges/bulk", Some(page))
        .await
        .refused(StatusCode::BAD_REQUEST, "validation_error");

    let held = [("item.created", 0), ("edge.created", 0)];
    let told = [("item.created", 1), ("edge.created", 1)];
    let mut expected = vec![("item.created", 1)];
    expected.extend(held.repeat(2));
    expected.extend(told.repeat(2));
    expected.extend([("item.created", 1), ("item.created", 1)]);
    expected.extend([
        ("edge.created", 0),
        ("edge.updated", 0),
        ("edge.updated", 1),
    ]);
    let expected: Vec<_> = expected
        .into_iter()
        .map(|(event_type, fanout)| (event_type.to_string(), fanout))
        .collect();
    assert_eq!(marks(), expected);
}

#[tokio::test]
async fn a_bulk_entry_with_an_inexact_integer_is_refused_by_its_position() {
    let instance = Instance::start().await;
    let token = instance
        .key("writer", json!({ "core.note": "write" }))
        .await;
    let (a, b) = (instance.note().await, instance.note().await);
    let edge = |properties: Value| json!({ "source_id": a, "target_id": b, "edge_type": "parent-of", "properties": properties });
    let page = json!({ "edges": [edge(json!({})), edge(json!({ "weight": 1_500_000_000_000_000_001u64 }))] });
    let answer = instance
        .call(&token, Method::POST, "/edges/bulk", page)
        .await;
    answer.refused(StatusCode::BAD_REQUEST, "invalid_properties");
    assert_eq!(answer.body["error"]["details"]["index"], 1);
    assert_eq!(
        answer.body["error"]["details"]["errors"][0]["field"],
        "weight"
    );
    assert_eq!(instance.edges_of("parent-of"), 0);
}

#[tokio::test]
async fn a_deep_chain_of_parents_moves_to_the_bin_and_back() {
    let instance = Instance::start().await;
    let mut chain = vec![instance.note().await];
    for _ in 0..300 {
        let next = instance.note().await;
        instance
            .edge(chain.last().unwrap(), &next, "parent-of")
            .await;
        chain.push(next);
    }
    let path = format!("/items/{}", chain[0]);
    instance
        .local(Method::DELETE, &path, None)
        .await
        .landed(StatusCode::OK);
    let binned: i64 = instance
        .db()
        .query_row(
            "SELECT count(*) FROM items WHERE state = 'trashed'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(binned, 301);
    let restore = format!("/items/{}/restore", chain[0]);
    instance
        .local(Method::POST, &restore, None)
        .await
        .landed(StatusCode::OK);
    let binned: i64 = instance
        .db()
        .query_row(
            "SELECT count(*) FROM items WHERE state = 'trashed'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(binned, 0);
}

#[tokio::test]
async fn the_log_marks_what_a_cascade_took_and_what_a_purge_removed() {
    let instance = Instance::start().await;
    let (parent, child) = (instance.note().await, instance.note().await);
    let edge = instance.edge(&parent, &child, "parent-of").await;
    let edge = edge["id"].as_str().unwrap();
    let logged = |event_type: &str, id: &str| -> Value {
        let payload: String = instance
            .db()
            .query_row(
                "SELECT payload FROM event_log WHERE event_type = ?1 \
                 AND (json_extract(payload, '$.item.id') = ?2 \
                      OR json_extract(payload, '$.edge.id') = ?2) \
                 ORDER BY id DESC LIMIT 1",
                params![event_type, id],
                |row| row.get(0),
            )
            .unwrap();
        serde_json::from_str(&payload).unwrap()
    };

    let path = format!("/items/{parent}");
    instance
        .local(Method::DELETE, &path, None)
        .await
        .landed(StatusCode::OK);
    let taken = logged("item.deleted", &child);
    assert_eq!(taken["item"]["trashed_with"], json!(parent));
    assert_eq!(taken["item"]["trashed_by_cascade"], json!(true));
    let named = logged("item.deleted", &parent);
    assert!(named["item"].get("trashed_with").is_none(), "{named}");

    let restore = format!("/items/{parent}/restore");
    instance
        .local(Method::POST, &restore, None)
        .await
        .landed(StatusCode::OK);
    assert_eq!(
        logged("item.restored", &child)["restored_with"],
        json!(parent)
    );
    assert!(
        logged("item.restored", &parent)
            .get("restored_with")
            .is_none()
    );

    instance
        .local(Method::DELETE, &path, None)
        .await
        .landed(StatusCode::OK);
    let purge = format!("/items/{parent}/purge");
    instance
        .local(Method::POST, &purge, None)
        .await
        .landed(StatusCode::OK);
    assert_eq!(logged("edge.deleted", edge)["purged_with"], json!(parent));
}

#[tokio::test]
async fn inline_edges_refused_after_the_item_row_leave_nothing_written() {
    let instance = Instance::start().await;
    let token = instance
        .key("writer", json!({ "core.note": "write" }))
        .await;
    let missing = "01a1b6a7-0000-7000-8000-000000000000";
    let body = json!({
        "type": "core.note",
        "properties": { "body": "kept out" },
        "edges": { "about": [missing] },
    });
    let answer = instance.call(&token, Method::POST, "/items", body).await;
    answer.refused(StatusCode::NOT_FOUND, "item_not_found");
    let rows: i64 = instance
        .db()
        .query_row(
            "SELECT count(*) FROM items WHERE source = 'writer'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(rows, 0);

    let note = instance.note().await;
    let path = format!("/items/{note}");
    let body = json!({
        "version": 1,
        "properties": { "body": "kept out" },
        "edges": { "about": [missing] },
    });
    let answer = instance.call(&token, Method::PATCH, &path, body).await;
    answer.refused(StatusCode::NOT_FOUND, "item_not_found");
    let read = instance.local(Method::GET, &path, None).await;
    let read = read.landed(StatusCode::OK);
    assert_eq!(read["item"]["version"], 1);
    assert_eq!(read["item"]["properties"]["body"], "a note");
}

#[tokio::test]
async fn a_part_listed_with_a_binned_host_and_a_live_one_stays_whatever_the_order() {
    let instance = Instance::start().await;
    for binned_first in [true, false] {
        let binned = instance.note().await;
        let live = instance.note().await;
        let gone = instance
            .local(Method::DELETE, &format!("/items/{binned}"), None)
            .await;
        assert!(gone.status.is_success(), "{}", gone.text);
        let hosts = if binned_first {
            json!([binned, live])
        } else {
            json!([live, binned])
        };
        let body = json!({
            "type": "core.note",
            "properties": { "body": "a part" },
            "edges": { "attached-to": hosts },
        });
        let made = instance.local(Method::POST, "/items", Some(body)).await;
        let part = made.landed(StatusCode::CREATED)["item"].clone();
        let id = part["id"].as_str().unwrap();
        let read = instance
            .local(Method::GET, &format!("/items/{id}"), None)
            .await;
        assert_eq!(read.landed(StatusCode::OK)["item"]["state"], "active");
    }
}
