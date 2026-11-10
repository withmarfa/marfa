//! The registries of types and edge types at the doors.

use std::path::PathBuf;
use std::sync::Arc;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Method, Request, StatusCode, header};
use marfa_server::app::App;
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
}

struct Reply {
    status: StatusCode,
    body: Value,
}

impl Reply {
    fn code(&self) -> &str {
        self.body["error"]["code"].as_str().unwrap_or("")
    }
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
        Instance::open(TempDir::new().unwrap()).await
    }

    async fn open(dir: TempDir) -> Instance {
        let database = dir.path().join("marfa.db");
        let blobs = dir.path().join("blobs");
        let socket = dir.path().join("s.sock");
        let pairs = [
            ("MARFA_DATABASE_PATH", database.to_str().unwrap()),
            ("MARFA_BLOB_PATH", blobs.to_str().unwrap()),
            ("MARFA_CONTROL_SOCKET", socket.to_str().unwrap()),
            ("MARFA_RATE_LIMIT_ENABLED", "false"),
        ];
        let settings = Settings::read(Environment::from_pairs(&pairs)).unwrap();
        let app = App::start(settings).await.unwrap();
        Instance {
            dir,
            public: public(app.clone()),
            control: control(app.clone()),
            app,
        }
    }

    async fn restart(self, change: impl FnOnce(&rusqlite::Connection)) -> Instance {
        self.app.db.close().await;
        let Instance { dir, .. } = self;
        let database: PathBuf = dir.path().join("marfa.db");
        change(&rusqlite::Connection::open(database).unwrap());
        Instance::open(dir).await
    }

    async fn local(&self, method: Method, path: &str, body: Option<Value>) -> Reply {
        send(&self.control, request(method, path, None, body)).await
    }

    async fn call(&self, token: &str, method: Method, path: &str, body: Option<Value>) -> Reply {
        send(&self.public, request(method, path, Some(token), body)).await
    }

    async fn key(&self, body: Value) -> String {
        let minted = self.local(Method::POST, "/keys", Some(body)).await;
        assert_eq!(minted.status, StatusCode::CREATED, "{}", minted.body);
        minted.body["key"].as_str().unwrap().to_string()
    }

    async fn register(&self, body: Value) -> Reply {
        self.local(Method::POST, "/types", Some(body)).await
    }

    async fn type_ids(&self) -> Vec<String> {
        let listed = self.local(Method::GET, "/types", None).await;
        assert_eq!(listed.status, StatusCode::OK, "{}", listed.body);
        let rows = listed.body["data"].as_array().unwrap();
        rows.iter()
            .map(|row| row["id"].as_str().unwrap().to_string())
            .collect()
    }
}

fn simple(id: &str) -> Value {
    json!({ "id": id, "fields": { "note": { "type": "string" } } })
}

fn child(id: &str, parent: &str, fields: Value) -> Value {
    json!({ "id": id, "parent": parent, "fields": fields })
}

#[tokio::test]
async fn registrations_racing_for_one_id_leave_one_type_and_refuse_the_other() {
    let instance = Instance::start().await;
    let first = instance.register(simple("acme.race"));
    let second = instance.register(simple("acme.race"));
    let (first, second) = tokio::join!(first, second);

    let mut statuses = [first.status, second.status];
    statuses.sort();
    assert_eq!(statuses, [StatusCode::CREATED, StatusCode::CONFLICT]);
    let refused = if first.status == StatusCode::CREATED {
        &second
    } else {
        &first
    };
    assert_eq!(refused.code(), "type_already_exists");
    let ids = instance.type_ids().await;
    assert_eq!(ids.iter().filter(|id| *id == "acme.race").count(), 1);
}

#[tokio::test]
async fn an_identifier_the_grammar_refuses_is_refused_and_stores_nothing() {
    let instance = Instance::start().await;
    let before = instance.type_ids().await;
    let long = format!("acme.{}", "a".repeat(130));
    for (id, status, code) in [
        ("Not Valid", StatusCode::BAD_REQUEST, "validation_error"),
        ("nodots", StatusCode::BAD_REQUEST, "validation_error"),
        (long.as_str(), StatusCode::BAD_REQUEST, "validation_error"),
        ("core.mine", StatusCode::FORBIDDEN, "forbidden"),
        ("system.mine", StatusCode::FORBIDDEN, "forbidden"),
    ] {
        let refused = instance.register(simple(id)).await;
        assert_eq!(refused.status, status, "{id}: {}", refused.body);
        assert_eq!(refused.code(), code, "{id}");
    }
    let missing = instance.register(json!({ "id": "acme.bare" })).await;
    assert_eq!(missing.code(), "missing_required_field");
    assert_eq!(missing.body["error"]["details"]["field"], "fields");
    assert_eq!(instance.type_ids().await, before);
}

#[tokio::test]
async fn a_parent_that_is_missing_or_would_close_a_cycle_is_refused() {
    let instance = Instance::start().await;
    let orphan = instance
        .register(child("acme.orphan", "acme.nothing", json!({})))
        .await;
    assert!(orphan.status.is_client_error(), "{}", orphan.body);
    assert!(
        !instance
            .type_ids()
            .await
            .contains(&"acme.orphan".to_string())
    );

    assert_eq!(
        instance.register(simple("acme.top")).await.status,
        StatusCode::CREATED
    );
    let made = instance
        .register(child("acme.leaf", "acme.top", json!({})))
        .await;
    assert_eq!(made.status, StatusCode::CREATED, "{}", made.body);
    let looped = instance
        .local(
            Method::PUT,
            "/types/acme.top",
            Some(child(
                "acme.top",
                "acme.leaf",
                json!({ "note": { "type": "string" } }),
            )),
        )
        .await;
    assert_eq!(looped.status, StatusCode::BAD_REQUEST, "{}", looped.body);
    let held = instance.local(Method::GET, "/types/acme.top", None).await;
    assert!(
        held.body.get("parent").is_none_or(Value::is_null),
        "{}",
        held.body
    );
}

#[tokio::test]
async fn a_field_may_not_shadow_an_inherited_one_with_another_shape() {
    let instance = Instance::start().await;
    instance.register(simple("acme.base")).await;
    let refused = instance
        .register(child(
            "acme.sub",
            "acme.base",
            json!({ "note": { "type": "integer" } }),
        ))
        .await;
    assert_eq!(refused.code(), "inheritance_violation", "{}", refused.body);
    assert!(refused.body["error"]["details"]["errors"].is_array());
    assert!(!instance.type_ids().await.contains(&"acme.sub".to_string()));
}

#[tokio::test]
async fn a_definition_at_the_request_limit_is_stored_and_one_past_it_is_refused() {
    let instance = Instance::start().await;
    let mut fields = serde_json::Map::new();
    let mut size = 0;
    let mut n = 0;
    while size < 1_000_000 {
        let name = format!("f{n}");
        size += name.len() + r#""":{"type":"string"},"#.len();
        fields.insert(name, json!({ "type": "string" }));
        n += 1;
    }
    let big = json!({ "id": "acme.big", "fields": fields });
    assert!(big.to_string().len() < 1024 * 1024);
    let stored = instance.register(big).await;
    assert_eq!(stored.status, StatusCode::CREATED, "{}", stored.body);
    let read = instance.local(Method::GET, "/types/acme.big", None).await;
    assert_eq!(read.body["fields"].as_object().unwrap().len(), n);

    let huge = json!({ "id": "acme.huge", "fields": { "note": { "type": "string", "description": "x".repeat(1024 * 1024) } } });
    let refused = instance.register(huge).await;
    assert_eq!(refused.status, StatusCode::PAYLOAD_TOO_LARGE);
    assert!(!instance.type_ids().await.contains(&"acme.huge".to_string()));
}

#[tokio::test]
async fn a_field_nested_inside_a_field_is_refused_and_a_body_nested_too_deep_to_read_is_too() {
    let instance = Instance::start().await;
    let mut shape = json!({ "type": "string" });
    for _ in 0..60 {
        shape = json!({ "type": "array", "items": shape });
    }
    let deep = instance
        .register(json!({ "id": "acme.deep", "fields": { "nest": shape } }))
        .await;
    assert_eq!(deep.status, StatusCode::BAD_REQUEST, "{}", deep.body);
    assert_eq!(deep.code(), "invalid_schema");
    let too_deep = format!(
        r#"{{"id":"acme.deeper","fields":{{"n":{}"x"{}}}}}"#,
        r#"{"a":"#.repeat(500),
        "}".repeat(500)
    );
    let refused = send(
        &instance.control,
        Request::builder()
            .method(Method::POST)
            .uri("/types")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(too_deep))
            .unwrap(),
    )
    .await;
    assert_eq!(refused.status, StatusCode::BAD_REQUEST, "{}", refused.body);
    assert_eq!(
        instance.local(Method::GET, "/types", None).await.status,
        StatusCode::OK
    );
}

#[tokio::test]
async fn a_key_with_only_the_types_map_may_add_an_optional_field_and_no_more() {
    let instance = Instance::start().await;
    let created = instance
        .register(json!({
            "id": "acme.note",
            "fields": { "title": { "type": "string" }, "body": { "type": "string" } },
        }))
        .await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.body);
    let key = instance
        .key(json!({
            "label": "writer",
            "source": "writer",
            "permissions": [],
            "metadata_permissions": { "types": "write" },
            "type_permissions": { "acme.note": "write" },
        }))
        .await;

    let widened = json!({
        "id": "acme.note",
        "fields": {
            "title": { "type": "string" },
            "body": { "type": "string" },
            "extra": { "type": "string" },
        },
    });
    let added = instance
        .call(&key, Method::PUT, "/types/acme.note", Some(widened))
        .await;
    assert_eq!(added.status, StatusCode::OK, "{}", added.body);

    let narrowed = json!({ "id": "acme.note", "fields": { "title": { "type": "string" } } });
    let refused = instance
        .call(
            &key,
            Method::PUT,
            "/types/acme.note",
            Some(narrowed.clone()),
        )
        .await;
    assert_eq!(refused.status, StatusCode::FORBIDDEN, "{}", refused.body);
    assert_eq!(
        refused.body["error"]["details"]["required_scope"],
        "schema.write"
    );
    let held = instance.local(Method::GET, "/types/acme.note", None).await;
    assert_eq!(held.body["fields"].as_object().unwrap().len(), 3);

    let by_owner = instance
        .local(Method::PUT, "/types/acme.note", Some(narrowed))
        .await;
    assert_eq!(by_owner.status, StatusCode::OK, "{}", by_owner.body);

    let elsewhere = instance
        .call(&key, Method::POST, "/types", Some(simple("acme.other")))
        .await;
    assert_eq!(elsewhere.code(), "type_not_permitted", "{}", elsewhere.body);
}

#[tokio::test]
async fn a_definition_an_unreadable_fault_names_is_refused_to_a_read_and_replaced_by_a_write() {
    let instance = Instance::start().await;
    instance.register(simple("acme.fine")).await;
    instance.register(simple("acme.damaged")).await;
    instance
        .app
        .faults
        .set("unreadable:type-definition", Some("acme.damaged"))
        .unwrap();

    let read = instance
        .local(Method::GET, "/types/acme.damaged", None)
        .await;
    assert_eq!(read.status, StatusCode::CONFLICT, "{}", read.body);
    assert_eq!(read.code(), "type_chain_unresolvable");
    assert_eq!(read.body["error"]["details"]["type_id"], "acme.damaged");
    let other = instance.local(Method::GET, "/types/acme.fine", None).await;
    assert_eq!(other.status, StatusCode::OK, "{}", other.body);

    let replaced = instance
        .local(
            Method::PUT,
            "/types/acme.damaged",
            Some(simple("acme.damaged")),
        )
        .await;
    assert_eq!(replaced.status, StatusCode::OK, "{}", replaced.body);

    instance.app.faults.clear(None);
    let readable = instance
        .local(Method::GET, "/types/acme.damaged", None)
        .await;
    assert_eq!(readable.status, StatusCode::OK, "{}", readable.body);
}

#[tokio::test]
async fn a_stored_definition_the_program_cannot_read_is_kept_and_does_not_stop_the_start() {
    let instance = Instance::start().await;
    instance.register(simple("acme.fine")).await;
    instance.register(simple("acme.broken")).await;
    let instance = instance
        .restart(|database| {
            database
                .execute(
                    "UPDATE types SET definition = '{\"id\":\"acme.broken\",\"fields\":7}' WHERE id = 'acme.broken'",
                    [],
                )
                .unwrap();
        })
        .await;

    let ids = instance.type_ids().await;
    assert!(ids.contains(&"acme.fine".to_string()));
    assert!(!ids.contains(&"acme.broken".to_string()));
    let read = instance
        .local(Method::GET, "/types/acme.broken", None)
        .await;
    assert_eq!(read.status, StatusCode::CONFLICT, "{}", read.body);
    assert_eq!(read.code(), "type_chain_unresolvable");
    assert_eq!(read.body["error"]["details"]["type_id"], "acme.broken");
    let again = instance.register(simple("acme.broken")).await;
    assert_eq!(again.code(), "type_already_exists");
    let kept: String = {
        let stored = instance.app.db.read(|tx| {
            Ok(tx.query_row(
                "SELECT definition FROM types WHERE id = 'acme.broken'",
                [],
                |row| row.get::<_, String>(0),
            )?)
        });
        stored.await.unwrap()
    };
    assert_eq!(kept, r#"{"id":"acme.broken","fields":7}"#);

    let replaced = instance
        .local(
            Method::PUT,
            "/types/acme.broken",
            Some(simple("acme.broken")),
        )
        .await;
    assert_eq!(replaced.status, StatusCode::OK, "{}", replaced.body);
    let readable = instance
        .local(Method::GET, "/types/acme.broken", None)
        .await;
    assert_eq!(readable.status, StatusCode::OK, "{}", readable.body);
}

#[tokio::test]
async fn an_edge_type_registers_widens_by_evolution_and_deletes() {
    let instance = Instance::start().await;
    let body = json!({
        "id": "acme.cites",
        "label": "Cites",
        "reverse_name": "acme.cited-by",
        "reverse_label": "Cited by",
        "cardinality": "many-to-many",
        "source_type_constraints": ["core.note"],
    });
    let created = instance
        .local(Method::POST, "/edge-types", Some(body.clone()))
        .await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.body);
    let twice = instance
        .local(Method::POST, "/edge-types", Some(body.clone()))
        .await;
    assert_eq!(twice.status, StatusCode::CONFLICT, "{}", twice.body);
    let ids = |listed: &Reply| -> Vec<String> {
        listed.body["data"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| row["id"].as_str().unwrap().to_string())
            .collect()
    };
    assert!(
        ids(&instance.local(Method::GET, "/edge-types", None).await)
            .contains(&"acme.cites".to_string())
    );

    let mut evolve = body.clone();
    evolve["evolve_constraints"] = json!(true);
    evolve["source_type_constraints"] = json!(["core.note", "core.task"]);
    let widened = instance
        .local(Method::POST, "/edge-types", Some(evolve))
        .await;
    assert_eq!(widened.status, StatusCode::OK, "{}", widened.body);
    let mut lost = body.clone();
    lost["evolve_constraints"] = json!(true);
    lost["cardinality"] = json!("one-to-one");
    let refused = instance
        .local(Method::POST, "/edge-types", Some(lost))
        .await;
    assert_eq!(refused.status, StatusCode::CONFLICT, "{}", refused.body);

    let shipped = instance
        .local(Method::DELETE, "/edge-types/about", None)
        .await;
    assert!(shipped.status.is_client_error(), "{}", shipped.body);
    let gone = instance
        .local(Method::DELETE, "/edge-types/acme.cites", None)
        .await;
    assert!(gone.status.is_success(), "{}", gone.body);
    assert!(
        !ids(&instance.local(Method::GET, "/edge-types", None).await)
            .contains(&"acme.cites".to_string())
    );
    let absent = instance
        .local(Method::DELETE, "/edge-types/acme.cites", None)
        .await;
    assert_eq!(absent.code(), "edge_type_not_found");
}

fn ledger(tables: Value) -> Value {
    json!({ "id": "acme.ledger", "fields": { "title": { "type": "string" } }, "tables": tables })
}

fn lines() -> Value {
    json!({ "lines": { "label": "Lines", "columns": {
        "amount": { "type": "number", "adds_up": "sum" },
        "memo": { "type": "string", "searchable": true },
    } } })
}

fn refused_paths(reply: &Reply) -> Vec<String> {
    reply.body["error"]["details"]["errors"]
        .as_array()
        .map(|errors| {
            errors
                .iter()
                .map(|error| error["field"].as_str().unwrap_or("").to_string())
                .collect()
        })
        .unwrap_or_default()
}

#[tokio::test]
async fn a_type_declares_tables_and_reads_lists_and_normalizes_them() {
    let instance = Instance::start().await;
    let created = instance.register(ledger(lines())).await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.body);
    assert_eq!(
        created.body["type"]["tables"]["lines"]["columns"]["amount"]["adds_up"],
        "sum"
    );

    let read = instance
        .local(Method::GET, "/types/acme.ledger", None)
        .await;
    assert_eq!(read.body["tables"]["lines"]["label"], "Lines");
    assert_eq!(
        read.body["tables"]["lines"]["columns"]["memo"]["label"],
        "Memo"
    );
    assert_eq!(
        read.body["tables"]["lines"]["columns"]["memo"]["searchable"],
        true
    );

    let listed = instance.local(Method::GET, "/types", None).await;
    let row = listed.body["data"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["id"] == "acme.ledger")
        .unwrap();
    assert!(row["tables"]["lines"]["columns"]["amount"].is_object());

    let judged = instance
        .local(Method::POST, "/types/normalize", Some(ledger(lines())))
        .await;
    assert_eq!(judged.status, StatusCode::OK, "{}", judged.body);
    assert_eq!(
        judged.body["type"]["tables"]["lines"]["columns"]["amount"]["required"],
        false
    );
    assert_eq!(
        judged.body["type"]["tables"]["lines"]["columns"]["memo"]["searchable"],
        true
    );
    assert_eq!(
        judged.body["type"]["tables"]["lines"]["columns"]["amount"]["searchable"],
        false
    );
}

#[tokio::test]
async fn a_table_a_type_cannot_hold_is_refused_at_registration_and_stores_nothing() {
    let instance = Instance::start().await;
    let cases = [
        (
            json!({ "lines": { "colums": { "a": { "type": "string" } }, "columns": { "a": { "type": "string" } } } }),
            "tables.lines.colums",
        ),
        (
            json!({ "lines": { "columns": { "a": { "type": "decimal" } } } }),
            "tables.lines.columns.a.type",
        ),
        (
            json!({ "lines": { "columns": { "a": { "type": "string", "adds_up": "sum" } } } }),
            "tables.lines.columns.a.adds_up",
        ),
        (
            json!({ "lines": { "columns": { "a": { "type": "item", "type_constraints": ["acme.nothing"] } } } }),
            "tables.lines.columns.a.type_constraints",
        ),
        (
            json!({ "lines": { "columns": {} } }),
            "tables.lines.columns",
        ),
    ];
    for (tables, field) in cases {
        let refused = instance.register(ledger(tables)).await;
        assert_eq!(refused.status, StatusCode::BAD_REQUEST, "{}", refused.body);
        assert_eq!(refused.code(), "invalid_schema");
        assert_eq!(
            refused_paths(&refused),
            vec![field.to_string()],
            "{}",
            refused.body
        );
    }
    let crowded: serde_json::Map<String, Value> = (0..33)
        .map(|n| {
            (
                format!("t{n}"),
                json!({ "columns": { "a": { "type": "string" } } }),
            )
        })
        .collect();
    let refused = instance.register(ledger(Value::Object(crowded))).await;
    assert_eq!(refused_paths(&refused), vec!["tables".to_string()]);
    let wide: serde_json::Map<String, Value> = (0..65)
        .map(|n| (format!("c{n}"), json!({ "type": "string" })))
        .collect();
    let refused = instance
        .register(ledger(json!({ "lines": { "columns": wide } })))
        .await;
    assert_eq!(
        refused_paths(&refused),
        vec!["tables.lines.columns".to_string()]
    );
    assert!(
        !instance
            .type_ids()
            .await
            .contains(&"acme.ledger".to_string())
    );
}

#[tokio::test]
async fn a_subtype_inherits_tables_and_may_not_declare_one_again() {
    let instance = Instance::start().await;
    assert_eq!(
        instance.register(ledger(lines())).await.status,
        StatusCode::CREATED
    );
    let mut sub = child("acme.sub", "acme.ledger", json!({}));
    sub["tables"] = json!({ "extra": { "columns": { "n": { "type": "integer" } } } });
    let made = instance.register(sub).await;
    assert_eq!(made.status, StatusCode::CREATED, "{}", made.body);
    let read = instance.local(Method::GET, "/types/acme.sub", None).await;
    let tables = read.body["tables"].as_object().unwrap();
    assert!(tables.contains_key("lines") && tables.contains_key("extra"));

    let mut again = child("acme.again", "acme.ledger", json!({}));
    again["tables"] = json!({ "lines": { "columns": { "other": { "type": "string" } } } });
    let refused = instance.register(again).await;
    assert_eq!(refused.code(), "inheritance_violation", "{}", refused.body);
    assert_eq!(refused_paths(&refused), vec!["tables.lines".to_string()]);

    let mut restated = child("acme.restated", "acme.ledger", json!({}));
    restated["tables"] = read_back_tables(&instance, "acme.ledger").await;
    let kept = instance.register(restated).await;
    assert_eq!(kept.status, StatusCode::CREATED, "{}", kept.body);
    let listed = instance.local(Method::GET, "/types", None).await;
    let row = listed.body["data"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["id"] == "acme.restated")
        .unwrap();
    assert!(row.get("tables").is_none(), "{row}");
}

async fn read_back_tables(instance: &Instance, id: &str) -> Value {
    let read = instance
        .local(Method::GET, &format!("/types/{id}"), None)
        .await;
    read.body["tables"].clone()
}

#[tokio::test]
async fn a_replacement_keeps_tables_it_names_and_drops_those_it_leaves_out_for_a_schema_writer_only()
 {
    let instance = Instance::start().await;
    assert_eq!(
        instance.register(ledger(lines())).await.status,
        StatusCode::CREATED
    );
    let key = instance
        .key(json!({
            "label": "writer",
            "source": "writer",
            "permissions": [],
            "metadata_permissions": { "types": "write" },
            "type_permissions": { "acme.ledger": "write" },
        }))
        .await;
    let put = |tables: Option<Value>| {
        let mut body = json!({ "id": "acme.ledger", "fields": { "title": { "type": "string" } } });
        if let Some(tables) = tables {
            body["tables"] = tables;
        }
        body
    };
    let mut wider = lines();
    wider["lines"]["columns"]["note"] = json!({ "type": "string" });
    wider["audit"] = json!({ "columns": { "at": { "type": "datetime", "required": true } } });
    let added = instance
        .call(
            &key,
            Method::PUT,
            "/types/acme.ledger",
            Some(put(Some(wider))),
        )
        .await;
    assert_eq!(added.status, StatusCode::OK, "{}", added.body);
    assert!(added.body["type"]["tables"]["audit"].is_object());

    let mut required = lines();
    required["lines"]["columns"]["note"] = json!({ "type": "string", "required": true });
    required["audit"] = json!({ "columns": { "at": { "type": "datetime", "required": true } } });
    let refused = instance
        .call(
            &key,
            Method::PUT,
            "/types/acme.ledger",
            Some(put(Some(required))),
        )
        .await;
    assert_eq!(refused.status, StatusCode::FORBIDDEN, "{}", refused.body);
    assert_eq!(
        refused.body["error"]["details"]["required_scope"],
        "schema.write"
    );
    assert_eq!(
        refused.body["error"]["details"]["changes"],
        json!(["tables.lines.columns.note"])
    );

    let mut kind = lines();
    kind["lines"]["columns"]["amount"] = json!({ "type": "string" });
    let refused = instance
        .call(
            &key,
            Method::PUT,
            "/types/acme.ledger",
            Some(put(Some(kind))),
        )
        .await;
    assert_eq!(refused.status, StatusCode::FORBIDDEN, "{}", refused.body);

    let left_out = instance
        .call(&key, Method::PUT, "/types/acme.ledger", Some(put(None)))
        .await;
    assert_eq!(left_out.status, StatusCode::FORBIDDEN, "{}", left_out.body);
    let held = instance
        .local(Method::GET, "/types/acme.ledger", None)
        .await;
    assert_eq!(held.body["tables"].as_object().unwrap().len(), 2);

    let by_owner = instance
        .local(Method::PUT, "/types/acme.ledger", Some(put(None)))
        .await;
    assert_eq!(by_owner.status, StatusCode::OK, "{}", by_owner.body);
    assert!(
        by_owner.body["type"].get("tables").is_none(),
        "{}",
        by_owner.body
    );
}

#[tokio::test]
async fn a_definition_read_as_served_is_written_back_with_no_label_it_did_not_have() {
    let instance = Instance::start().await;
    assert_eq!(
        instance.register(ledger(lines())).await.status,
        StatusCode::CREATED
    );
    let mut sent = json!({ "id": "acme.ledger", "fields": { "title": { "type": "string" } } });
    sent["tables"] = read_back_tables(&instance, "acme.ledger").await;
    let replaced = instance
        .local(Method::PUT, "/types/acme.ledger", Some(sent))
        .await;
    assert_eq!(replaced.status, StatusCode::OK, "{}", replaced.body);
    let listed = instance.local(Method::GET, "/types", None).await;
    let row = listed.body["data"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["id"] == "acme.ledger")
        .unwrap();
    assert_eq!(row["tables"]["lines"]["label"], "Lines");
    assert!(
        row["tables"]["lines"]["columns"]["amount"]
            .get("label")
            .is_none(),
        "{row}"
    );
}
