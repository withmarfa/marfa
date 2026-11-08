use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Method, Request, StatusCode, header};
use marfa_server::app::stored::{self, Change};
use marfa_server::app::{App, housekeeping, webhooks};
use marfa_server::db::Write;
use marfa_server::http::{control, public};
use marfa_server::settings::{Environment, Settings};
use rusqlite::{Connection, OpenFlags};
use serde_json::{Value, json};
use tempfile::TempDir;
use tower::ServiceExt;

const SECOND: u64 = 1_000;
const HOUR: u64 = 3_600 * SECOND;
const DAY: u64 = 24 * HOUR;

struct Instance {
    dir: TempDir,
    app: Arc<App>,
    public: Router,
    control: Router,
    writer: String,
}

impl Instance {
    async fn start(settings: &[(&str, &str)]) -> Instance {
        let dir = TempDir::new().unwrap();
        let database = dir.path().join("marfa.db");
        let blobs = dir.path().join("blobs");
        let socket = dir.path().join("s.sock");
        let mut pairs = vec![
            ("MARFA_DATABASE_PATH", database.to_str().unwrap()),
            ("MARFA_BLOB_PATH", blobs.to_str().unwrap()),
            ("MARFA_CONTROL_SOCKET", socket.to_str().unwrap()),
            ("MARFA_TEST_HOOKS", "true"),
            ("MARFA_RATE_LIMIT_ENABLED", "false"),
        ];
        pairs.extend_from_slice(settings);
        let settings = Settings::read(Environment::from_pairs(&pairs)).unwrap();
        let app = App::start(settings).await.unwrap();
        app.clock.pause(true);
        webhooks::start(&app);
        let mut instance = Instance {
            public: public(app.clone()),
            control: control(app.clone()),
            app,
            dir,
            writer: String::new(),
        };
        let body = json!({
            "label": "writer",
            "source": "writer",
            "permissions": ["schema.write", "items.purge"],
            "type_permissions": { "*": "write" },
            "edge_permissions": { "*": "write" },
            "metadata_permissions": { "types": "write" },
        });
        let minted = instance.ok(Method::POST, "/keys", body).await;
        instance.writer = minted["key"].as_str().unwrap().to_string();
        instance
    }

    async fn send(
        &self,
        method: Method,
        path: &str,
        body: Value,
        key: Option<&str>,
    ) -> (StatusCode, Value) {
        let mut request = Request::builder()
            .method(method)
            .uri(path)
            .header(header::CONTENT_TYPE, "application/json");
        if let Some(key) = key {
            request = request.header("idempotency-key", key);
        }
        let doors = if ["/items", "/types", "/edges"]
            .iter()
            .any(|door| path.starts_with(door))
        {
            request = request.header(header::AUTHORIZATION, format!("Bearer {}", self.writer));
            &self.public
        } else {
            &self.control
        };
        let request = request.body(Body::from(body.to_string())).unwrap();
        let response = doors.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    async fn ok(&self, method: Method, path: &str, body: Value) -> Value {
        let (status, answer) = self.send(method, path, body, None).await;
        assert!(status.is_success(), "{path}: {status} {answer}");
        answer
    }

    async fn run(&self, job: &str) -> Value {
        if job == "event-log-cleanup" {
            self.scheduled().await;
        }
        let path = format!("/housekeeping/{job}/run");
        let run = self.ok(Method::POST, &path, json!({})).await;
        assert_eq!(run["outcome"], "ok", "{run}");
        run["result"].clone()
    }

    async fn job(&self, name: &str) -> Value {
        let list = self.ok(Method::GET, "/housekeeping", Value::Null).await;
        let jobs = list["data"].as_array().unwrap();
        let found = jobs.iter().find(|job| job["name"] == name);
        found
            .unwrap_or_else(|| panic!("{name} is not listed"))
            .clone()
    }

    async fn item(&self, body: Value) -> String {
        let made = self.ok(Method::POST, "/items", body).await;
        made["item"]["id"].as_str().unwrap().to_string()
    }

    async fn note(&self) -> String {
        self.item(json!({ "type": "core.note", "properties": { "body": "kept" } }))
            .await
    }

    async fn binned(&self, count: usize) -> Vec<String> {
        let mut ids = Vec::with_capacity(count);
        for _ in 0..count {
            let id = self.note().await;
            let path = format!("/items/{id}");
            self.ok(Method::DELETE, &path, Value::Null).await;
            ids.push(id);
        }
        ids
    }

    async fn sql(&self, statements: String) {
        self.app
            .db
            .write(Write::own(), move |tx| Ok(tx.execute_batch(&statements)?))
            .await
            .unwrap();
    }

    fn forward(&self, ms: u64) {
        self.app.clock.advance(ms).unwrap();
    }

    fn count(&self, sql: &str) -> i64 {
        let file = self.dir.path().join("marfa.db");
        let db = Connection::open_with_flags(file, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        db.query_row(sql, [], |row| row.get(0)).unwrap()
    }

    fn state(&self, id: &str) -> String {
        let file = self.dir.path().join("marfa.db");
        let db = Connection::open_with_flags(file, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        db.query_row("SELECT state FROM items WHERE id = ?1", [id], |row| {
            row.get(0)
        })
        .unwrap()
    }

    async fn store(&self, key: &str, value: &str) {
        let change = Change {
            key: key.to_string(),
            value: Some(value.to_string()),
        };
        stored::change(&self.app, Write::own(), vec![change])
            .await
            .unwrap();
    }

    async fn when(&self, what: &str, holds: impl AsyncFn(&Instance) -> bool) {
        let began = Instant::now();
        while began.elapsed() < Duration::from_secs(4) {
            if holds(self).await {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("{what} did not happen");
    }

    /// The event log keeps what the webhook sender has not passed.
    async fn scheduled(&self) {
        self.when("the webhook sender to pass the log", async |instance| {
            instance.count(
                "SELECT count(*) FROM webhook_position \
                 WHERE event_id = (SELECT COALESCE(MAX(id), 0) FROM event_log)",
            ) == 1
        })
        .await;
    }

    async fn when_held(&self) {
        self.when("a hold", async |instance| {
            let faults = instance.app.faults.list();
            faults.iter().any(|fault| fault.waiting > 0)
        })
        .await;
    }
}

#[tokio::test]
async fn trash_purge_takes_a_binned_item_a_second_past_its_retention() {
    let instance = Instance::start(&[("MARFA_TRASH_RETENTION_DAYS", "2")]).await;
    let id = instance.note().await;
    let path = format!("/items/{id}");
    instance.ok(Method::DELETE, &path, Value::Null).await;

    instance.forward(2 * DAY - SECOND);
    assert_eq!(instance.run("trash-purge").await["deleted"], 0);
    assert_eq!(instance.state(&id), "trashed");

    instance.forward(2 * SECOND);
    assert_eq!(instance.run("trash-purge").await["deleted"], 1);
    assert_eq!(instance.count("SELECT count(*) FROM items"), 0);
    let audited = "SELECT count(*) FROM audit_log WHERE action = 'items.trash_purged'";
    assert_eq!(instance.count(audited), 1);
    let announced = "SELECT count(*) FROM event_log WHERE event_type = 'item.purged'";
    assert_eq!(instance.count(announced), 1);
}

#[tokio::test]
async fn trash_purge_leaves_an_active_item_of_any_age() {
    let instance = Instance::start(&[("MARFA_TRASH_RETENTION_DAYS", "2")]).await;
    let id = instance.note().await;
    instance.forward(400 * DAY);
    assert_eq!(instance.run("trash-purge").await["deleted"], 0);
    assert_eq!(instance.state(&id), "active");
}

#[tokio::test]
async fn trash_purge_reads_the_retention_inside_its_write() {
    let instance = Instance::start(&[("MARFA_TRASH_RETENTION_DAYS", "2")]).await;
    let id = instance.note().await;
    let path = format!("/items/{id}");
    instance.ok(Method::DELETE, &path, Value::Null).await;
    instance.forward(3 * DAY);

    let faults = &instance.app.faults;
    faults
        .set("hold:write", Some("items.trash_purged"))
        .unwrap();
    let app = instance.app.clone();
    let run = tokio::spawn(async move { housekeeping::run_now(&app, "trash-purge").await });
    instance.when_held().await;
    instance.store("trash_retention_days", "0").await;
    instance.app.faults.clear(Some("hold:write"));

    let ended = run.await.unwrap().unwrap();
    assert_eq!(ended.outcome, "ok");
    assert_eq!(instance.state(&id), "trashed");
}

#[tokio::test]
async fn audit_cleanup_takes_an_entry_a_second_past_its_retention() {
    let instance = Instance::start(&[("MARFA_AUDIT_RETENTION_DAYS", "2")]).await;
    instance.note().await;
    let held = instance.count("SELECT count(*) FROM audit_log");
    assert!(held > 0);

    instance.forward(2 * DAY - SECOND);
    instance.note().await;
    assert_eq!(instance.run("audit-cleanup").await["deleted"], 0);

    let later = instance.count("SELECT count(*) FROM audit_log") - held;
    instance.forward(2 * SECOND);
    assert_eq!(instance.run("audit-cleanup").await["deleted"], held);
    assert_eq!(instance.count("SELECT count(*) FROM audit_log"), later);
}

#[tokio::test]
async fn event_log_cleanup_takes_entries_a_second_past_the_retention_and_never_the_newest() {
    let instance = Instance::start(&[("MARFA_EVENT_LOG_RETENTION_HOURS", "2")]).await;
    let body = json!({ "type": "core.note", "properties": { "body": "keyed" } });
    let (status, _) = instance
        .send(Method::POST, "/items", body, Some("the-key"))
        .await;
    assert_eq!(status, StatusCode::CREATED);
    let held = instance.count("SELECT count(*) FROM event_log");
    assert!(held > 0);

    instance.forward(2 * HOUR - SECOND);
    instance.note().await;
    let result = instance.run("event-log-cleanup").await;
    assert_eq!(result, json!({ "deleted": 0, "purged_records": 0 }));

    instance.forward(2 * SECOND);
    let result = instance.run("event-log-cleanup").await;
    assert_eq!(result, json!({ "deleted": held, "purged_records": 1 }));
    assert_eq!(
        instance.count("SELECT count(*) FROM idempotency_records"),
        0
    );

    instance.forward(400 * DAY);
    instance.run("event-log-cleanup").await;
    assert_eq!(instance.count("SELECT count(*) FROM event_log"), 1);
}

#[tokio::test]
async fn event_log_cleanup_keeps_what_the_webhook_sender_has_not_passed() {
    let instance = Instance::start(&[("MARFA_EVENT_LOG_RETENTION_HOURS", "2")]).await;
    instance.note().await;
    instance.scheduled().await;
    instance
        .app
        .faults
        .set("hold:webhook-schedule", None)
        .unwrap();
    instance.note().await;
    instance.note().await;
    instance.when_held().await;
    let passed = instance.count("SELECT event_id FROM webhook_position");
    let held = instance.count("SELECT count(*) FROM event_log");
    assert!(passed < held);

    instance.forward(3 * HOUR);
    let path = "/housekeeping/event-log-cleanup/run";
    let run = instance.ok(Method::POST, path, json!({})).await;
    assert_eq!(run["result"]["deleted"], passed);
    assert_eq!(instance.count("SELECT MIN(id) FROM event_log"), passed + 1);

    instance.app.faults.clear(Some("hold:webhook-schedule"));
    assert_eq!(
        instance.run("event-log-cleanup").await["deleted"],
        held - passed - 1
    );
}

#[tokio::test]
async fn event_log_cleanup_keeps_an_old_entry_behind_a_newer_one() {
    let instance = Instance::start(&[("MARFA_EVENT_LOG_RETENTION_HOURS", "2")]).await;
    instance.note().await;
    instance.note().await;
    instance.note().await;
    let held = instance.count("SELECT count(*) FROM event_log");
    let file = instance.dir.path().join("marfa.db");
    let db = Connection::open(file).unwrap();
    let late = "2999-01-01T00:00:00.000Z";
    db.execute(
        "UPDATE event_log SET at = ?1 WHERE id = (SELECT MIN(id) FROM event_log)",
        [late],
    )
    .unwrap();
    drop(db);

    instance.forward(3 * HOUR);
    assert_eq!(instance.run("event-log-cleanup").await["deleted"], 0);
    assert_eq!(instance.count("SELECT count(*) FROM event_log"), held);
}

#[tokio::test]
async fn revoked_key_reap_takes_a_key_a_second_past_its_thirty_days() {
    let instance = Instance::start(&[]).await;
    let body = json!({ "label": "ended", "source": "ended", "permissions": [] });
    let minted = instance.ok(Method::POST, "/keys", body).await;
    let body = json!({ "label": "live", "source": "live", "permissions": [] });
    instance.ok(Method::POST, "/keys", body).await;
    let path = format!("/keys/{}", minted["id"].as_str().unwrap());
    instance.ok(Method::DELETE, &path, Value::Null).await;
    let held = instance.count("SELECT count(*) FROM api_keys");

    instance.forward(30 * DAY - SECOND);
    assert_eq!(instance.run("revoked-key-reap").await["deleted"], 0);

    instance.forward(2 * SECOND);
    assert_eq!(instance.run("revoked-key-reap").await["deleted"], 1);
    assert_eq!(instance.count("SELECT count(*) FROM api_keys"), held - 1);
    let audited = "SELECT count(*) FROM audit_log WHERE action = 'keys.purged'";
    assert_eq!(instance.count(audited), 1);
}

async fn expiring(instance: &Instance) -> &'static str {
    let body = json!({
        "id": "user.expiring",
        "fields": { "title": { "type": "string" } },
        "retention_policy": { "feed_days": 2 },
    });
    instance.ok(Method::POST, "/types", body).await;
    "user.expiring"
}

fn feed_item(type_id: &str, tier: &str) -> Value {
    json!({ "type": type_id, "tier": tier, "properties": { "title": "entry" } })
}

#[tokio::test]
async fn feed_expiry_bins_an_item_a_second_past_its_window() {
    let instance = Instance::start(&[]).await;
    let type_id = expiring(&instance).await;
    let id = instance.item(feed_item(type_id, "feed")).await;
    let library = instance.item(feed_item(type_id, "library")).await;

    instance.forward(2 * DAY - SECOND);
    let result = instance.run("feed-expiry").await;
    assert_eq!(result, json!({ "moved": 0, "held": 0 }));
    assert_eq!(instance.state(&id), "active");

    instance.forward(2 * SECOND);
    let result = instance.run("feed-expiry").await;
    assert_eq!(result, json!({ "moved": 1, "held": 0 }));
    assert_eq!(instance.state(&id), "trashed");
    assert_eq!(instance.state(&library), "active");
    let audited = "SELECT count(*) FROM audit_log WHERE action = 'items.feed_expired'";
    assert_eq!(instance.count(audited), 1);
    let announced = format!(
        "SELECT count(*) FROM event_log WHERE event_type = 'item.deleted' AND item_id = '{id}'"
    );
    assert_eq!(instance.count(&announced), 1);

    let path = format!("/items/{id}/restore");
    instance.ok(Method::POST, &path, json!({})).await;
    instance.forward(400 * DAY);
    assert_eq!(instance.run("feed-expiry").await["moved"], 0);
    assert_eq!(instance.state(&id), "active");
}

#[tokio::test]
async fn feed_expiry_moves_every_expired_item_of_a_type_in_one_run() {
    let instance = Instance::start(&[]).await;
    let type_id = expiring(&instance).await;
    for _ in 0..101 {
        instance.item(feed_item(type_id, "feed")).await;
    }
    instance.forward(3 * DAY);
    assert_eq!(instance.run("feed-expiry").await["moved"], 101);
}

async fn edge(instance: &Instance, edge_type: &str, source: &str, target: &str) {
    let body = json!({ "source_id": source, "target_id": target, "edge_type": edge_type });
    instance.ok(Method::POST, "/edges", body).await;
}

#[tokio::test]
async fn feed_expiry_takes_a_cascade_only_when_all_of_it_has_expired() {
    let instance = Instance::start(&[]).await;
    let type_id = expiring(&instance).await;
    let parent = instance.item(feed_item(type_id, "feed")).await;
    let child = instance.item(feed_item(type_id, "feed")).await;
    let holding = instance.item(feed_item(type_id, "feed")).await;
    let kept = instance.item(feed_item(type_id, "library")).await;
    edge(&instance, "parent-of", &parent, &child).await;
    edge(&instance, "parent-of", &holding, &kept).await;

    instance.forward(3 * DAY);
    let result = instance.run("feed-expiry").await;
    assert_eq!(result, json!({ "moved": 2, "held": 1 }));
    assert_eq!(instance.state(&parent), "trashed");
    assert_eq!(instance.state(&child), "trashed");
    assert_eq!(instance.state(&holding), "active");
    assert_eq!(instance.state(&kept), "active");
}

#[tokio::test]
async fn feed_expiry_goes_past_a_whole_chunk_it_holds_back() {
    let instance = Instance::start(&[]).await;
    let type_id = expiring(&instance).await;
    let mut held = Vec::new();
    for _ in 0..100 {
        let id = instance.item(feed_item(type_id, "feed")).await;
        let kept = instance.item(feed_item(type_id, "library")).await;
        edge(&instance, "parent-of", &id, &kept).await;
        held.push(id);
    }
    let behind = instance.item(feed_item(type_id, "feed")).await;

    instance.forward(3 * DAY);
    let result = instance.run("feed-expiry").await;
    assert_eq!(result, json!({ "moved": 1, "held": 100 }));
    assert_eq!(instance.state(&behind), "trashed");
    assert_eq!(instance.state(&held[0]), "active");
}

#[tokio::test]
async fn trash_purge_removes_edges_and_the_parts_that_went_with_a_host() {
    let instance = Instance::start(&[("MARFA_TRASH_RETENTION_DAYS", "1")]).await;
    let host = instance.note().await;
    let part = instance.note().await;
    let other = instance.note().await;
    edge(&instance, "comments-on", &part, &host).await;
    edge(&instance, "derived-from", &other, &host).await;
    instance
        .ok(Method::DELETE, &format!("/items/{host}"), json!({}))
        .await;
    assert_eq!(instance.state(&part), "trashed");

    instance.forward(2 * DAY);
    assert_eq!(instance.run("trash-purge").await["deleted"], 2);
    let left = format!("SELECT count(*) FROM items WHERE id IN ('{host}', '{part}')");
    assert_eq!(instance.count(&left), 0);
    assert_eq!(instance.count("SELECT count(*) FROM edges"), 0);
    assert_eq!(instance.state(&other), "active");
}

#[tokio::test]
async fn trash_purge_walks_past_rows_it_cannot_take_and_tries_them_on_the_next_run() {
    let instance = Instance::start(&[("MARFA_TRASH_RETENTION_DAYS", "1")]).await;
    let held = instance.binned(201).await;
    let last_held = instance.count("SELECT max(seq) FROM items");
    instance.forward(HOUR);
    let behind = instance.binned(2).await;
    instance
        .sql(format!(
            "CREATE TRIGGER held BEFORE DELETE ON items WHEN OLD.seq <= {last_held} \
             BEGIN SELECT RAISE(ABORT, 'held'); END"
        ))
        .await;
    instance.forward(2 * DAY);

    let first = instance.run("trash-purge").await;
    assert_eq!(first, json!({ "deleted": 2, "passed_over": 201 }));
    assert_eq!(instance.state(&held[0]), "trashed");
    let gone = format!("SELECT count(*) FROM items WHERE id = '{}'", behind[1]);
    assert_eq!(instance.count(&gone), 0);
    let job = instance.job("trash-purge").await;
    assert_eq!(job["next_run_at"], job["last_finished_at"]);

    let second = instance.run("trash-purge").await;
    assert_eq!(second, json!({ "deleted": 0, "passed_over": 201 }));
    let job = instance.job("trash-purge").await;
    assert_ne!(job["next_run_at"], job["last_finished_at"]);

    instance.sql("DROP TRIGGER held".to_string()).await;
    assert_eq!(instance.run("trash-purge").await, json!({ "deleted": 200 }));
}

#[tokio::test]
async fn trash_purge_ends_in_error_when_every_row_fails_with_one() {
    let instance = Instance::start(&[("MARFA_TRASH_RETENTION_DAYS", "1")]).await;
    let held = instance.binned(2).await;
    instance
        .sql(
            "CREATE TABLE gone (x); \
             CREATE TRIGGER broken BEFORE DELETE ON items BEGIN INSERT INTO gone VALUES (1); END; \
             DROP TABLE gone"
                .to_string(),
        )
        .await;
    instance.forward(2 * DAY);

    let ended = housekeeping::run_now(&instance.app, "trash-purge")
        .await
        .unwrap();
    assert_eq!(ended.outcome, "error", "{:?}", ended.result);
    assert_eq!(instance.state(&held[0]), "trashed");
}

#[tokio::test]
async fn a_zero_retention_keeps_every_kind_of_record() {
    let zero = [
        ("MARFA_TRASH_RETENTION_DAYS", "0"),
        ("MARFA_AUDIT_RETENTION_DAYS", "0"),
        ("MARFA_EVENT_LOG_RETENTION_HOURS", "0"),
    ];
    let instance = Instance::start(&zero).await;
    let id = instance.note().await;
    let path = format!("/items/{id}");
    instance.ok(Method::DELETE, &path, Value::Null).await;
    instance.note().await;
    let audits = instance.count("SELECT count(*) FROM audit_log");
    let events = instance.count("SELECT count(*) FROM event_log");

    instance.forward(36_000 * DAY);
    assert_eq!(instance.run("trash-purge").await["deleted"], 0);
    assert_eq!(instance.run("audit-cleanup").await["deleted"], 0);
    assert_eq!(instance.run("event-log-cleanup").await["deleted"], 0);
    assert_eq!(instance.state(&id), "trashed");
    assert_eq!(instance.count("SELECT count(*) FROM audit_log"), audits);
    assert_eq!(instance.count("SELECT count(*) FROM event_log"), events);
}

#[tokio::test]
async fn the_largest_retention_gives_a_cutoff_that_takes_nothing_inside_it() {
    let largest = [
        ("MARFA_TRASH_RETENTION_DAYS", "36500"),
        ("MARFA_AUDIT_RETENTION_DAYS", "36500"),
        ("MARFA_EVENT_LOG_RETENTION_HOURS", "876000"),
    ];
    let instance = Instance::start(&largest).await;
    let id = instance.note().await;
    let path = format!("/items/{id}");
    instance.ok(Method::DELETE, &path, Value::Null).await;
    instance.note().await;

    instance.forward(36_499 * DAY);
    assert_eq!(instance.run("trash-purge").await["deleted"], 0);
    assert_eq!(instance.run("audit-cleanup").await["deleted"], 0);
    assert_eq!(instance.run("event-log-cleanup").await["deleted"], 0);
    assert_eq!(instance.state(&id), "trashed");
}

#[tokio::test]
async fn thinning_leaves_the_head_and_the_snapshots_the_policy_keeps() {
    let instance = Instance::start(&[("MARFA_VERSION_MAX_VERSIONS", "1")]).await;
    let id = instance.note().await;
    let path = format!("/items/{id}");
    for (version, body) in [(1, "two"), (2, "three"), (3, "four")] {
        let edit = json!({ "version": version, "properties": { "body": body } });
        instance.ok(Method::PATCH, &path, edit).await;
    }
    let snapshots = "SELECT count(*) FROM item_versions";
    assert_eq!(instance.count(snapshots), 3);

    let result = instance.run("version-thinning").await;
    assert_eq!(result, json!({ "pruned": 2, "items": 1 }));
    assert_eq!(instance.count(snapshots), 1);
    let head = instance.ok(Method::GET, &path, Value::Null).await;
    assert_eq!(head["item"]["properties"]["body"], "four");
    let audited = "SELECT count(*) FROM audit_log WHERE action = 'item.versions_thinned'";
    assert_eq!(instance.count(audited), 1);
}

#[tokio::test]
async fn a_second_run_of_a_running_job_is_refused_and_another_job_runs() {
    let instance = Instance::start(&[]).await;
    let held = "hold:housekeeping:audit-cleanup";
    instance.app.faults.set(held, None).unwrap();
    let app = instance.app.clone();
    let first = tokio::spawn(async move { housekeeping::run_now(&app, "audit-cleanup").await });
    instance.when_held().await;
    assert!(instance.job("audit-cleanup").await["running_since"].is_string());

    let path = "/housekeeping/audit-cleanup/run";
    let (status, answer) = instance.send(Method::POST, path, json!({}), None).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(answer["error"]["code"], "housekeeping_job_running");
    instance.run("trash-purge").await;

    instance.app.faults.clear(Some(held));
    assert_eq!(first.await.unwrap().unwrap().outcome, "ok");
    assert!(instance.job("audit-cleanup").await["running_since"].is_null());
}

#[tokio::test]
async fn the_doors_answer_a_name_this_build_does_not_run() {
    let instance = Instance::start(&[]).await;
    let path = "/housekeeping/no-such-job/run";
    let (status, answer) = instance.send(Method::POST, path, json!({}), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(answer["error"]["code"], "housekeeping_job_not_found");

    let path = "/housekeeping/heartbeat/run";
    let (status, _) = instance.send(Method::POST, path, json!({}), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "no URL leaves heartbeat out");

    let path = "/housekeeping/Not%20A%20Job/run";
    let (status, _) = instance.send(Method::POST, path, json!({}), None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn a_schedule_row_of_another_build_stays_and_is_not_listed() {
    let instance = Instance::start(&[]).await;
    let file = instance.dir.path().join("marfa.db");
    let db = Connection::open(file).unwrap();
    db.execute(
        "INSERT INTO housekeeping_jobs (name, next_run_at) VALUES ('gone-job', 'not a date')",
        [],
    )
    .unwrap();
    drop(db);

    housekeeping::prepare(&instance.app).await.unwrap();
    let list = instance.ok(Method::GET, "/housekeeping", Value::Null).await;
    let names = list["data"].as_array().unwrap();
    assert!(names.iter().any(|job| job["name"] == "audit-cleanup"));
    assert!(names.iter().all(|job| job["name"] != "gone-job"));
    let still = "SELECT count(*) FROM housekeeping_jobs WHERE next_run_at = 'not a date'";
    assert_eq!(instance.count(still), 1);
}

#[tokio::test]
async fn start_clears_an_unfinished_run_and_moves_no_schedule_later() {
    let instance = Instance::start(&[]).await;
    let file = instance.dir.path().join("marfa.db");
    let db = Connection::open(file).unwrap();
    db.execute(
        "UPDATE housekeeping_jobs SET running_since = next_run_at WHERE name = 'audit-cleanup'",
        [],
    )
    .unwrap();
    drop(db);
    let before = instance.job("audit-cleanup").await;
    assert!(before["running_since"].is_string());

    instance.forward(400 * DAY);
    housekeeping::prepare(&instance.app).await.unwrap();

    let after = instance.job("audit-cleanup").await;
    assert!(after["running_since"].is_null());
    assert_eq!(after["next_run_at"], before["next_run_at"]);
}

#[tokio::test]
async fn the_scheduler_follows_a_shortened_interval_and_repairs_a_schedule() {
    let instance = Instance::start(&[
        ("MARFA_HOUSEKEEPING_POLL_INTERVAL_MS", "5"),
        ("MARFA_AUDIT_CLEANUP_INTERVAL_MS", "31536000000"),
        ("MARFA_TRASH_PURGE_INTERVAL_MS", "31536000000"),
    ])
    .await;
    instance.app.clock.pause(false);
    instance.forward(0);
    let far = "UPDATE housekeeping_jobs SET next_run_at = '2999-01-01T00:00:00.000Z' \
               WHERE name = 'audit-cleanup'";
    let unreadable = "UPDATE housekeeping_jobs SET next_run_at = 'not a date' \
                      WHERE name = 'trash-purge'";
    let db = Connection::open(instance.dir.path().join("marfa.db")).unwrap();
    db.execute(far, []).unwrap();
    db.execute(unreadable, []).unwrap();
    drop(db);

    housekeeping::start(&instance.app);
    instance
        .when("a run from an unreadable schedule", async |instance| {
            instance.job("trash-purge").await["last_outcome"] == "ok"
        })
        .await;
    let audit = instance.job("audit-cleanup").await;
    assert!(audit["last_started_at"].is_null(), "{audit}");

    instance.store("audit_cleanup_interval_ms", "20").await;
    instance
        .when("a run on the shortened interval", async |instance| {
            instance.job("audit-cleanup").await["last_outcome"] == "ok"
        })
        .await;

    instance.app.housekeeping.stop();
    let began = Instant::now();
    instance
        .app
        .housekeeping
        .settle(Duration::from_secs(7))
        .await;
    assert!(began.elapsed() < Duration::from_secs(2));
}

#[tokio::test]
async fn a_job_the_contract_paces_lists_its_fixed_interval() {
    let instance = Instance::start(&[]).await;
    assert_eq!(
        instance.job("revoked-grant-purge").await["interval_ms"],
        3_600_000
    );
    assert_eq!(
        instance.job("grant-inactivity-retirement").await["interval_ms"],
        86_400_000
    );
    instance
        .store("auth_session_cleanup_interval_ms", "60000")
        .await;
    assert_eq!(
        instance.job("auth-session-cleanup").await["interval_ms"],
        60_000
    );
}
