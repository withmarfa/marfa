//! What `PATCH /config` does to the store backups go to: that the store in use follows the last
//! committed settings however writes overlap, that a store that cannot be recorded is not left
//! looking like the one the settings name, and that a write that names no other store never waits
//! for one being taken.

#[allow(dead_code)]
mod fake_s3;

use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Method, Request, StatusCode, header};
use marfa_server::app::App;
use marfa_server::app::blobs::Kept;
use marfa_server::http::{control, public};
use marfa_server::settings::{Environment, Settings};
use serde_json::{Value, json};
use tempfile::TempDir;
use tower::ServiceExt;

use fake_s3::FakeS3;

const BUCKET: &str = "marfa";

struct Instance {
    _dir: TempDir,
    app: Arc<App>,
    control: Router,
    public: Router,
    writer: String,
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

impl Instance {
    async fn start() -> Instance {
        let dir = TempDir::new().unwrap();
        let database = dir.path().join("marfa.db");
        let blobs = dir.path().join("blobs");
        let socket = dir.path().join("s.sock");
        let pairs = [
            ("MARFA_DATABASE_PATH", database.to_str().unwrap()),
            ("MARFA_BLOB_PATH", blobs.to_str().unwrap()),
            ("MARFA_CONTROL_SOCKET", socket.to_str().unwrap()),
            ("MARFA_TEST_HOOKS", "true"),
            ("MARFA_RATE_LIMIT_ENABLED", "false"),
            ("MARFA_ALLOW_PRIVATE_ADDRESSES", "true"),
            ("MARFA_BACKUP_INTERVAL_SECONDS", "0"),
        ];
        let settings = Settings::read(Environment::from_pairs(&pairs)).unwrap();
        let app = App::start(settings).await.unwrap();
        let mut instance = Instance {
            control: control(app.clone()),
            public: public(app.clone()),
            app,
            _dir: dir,
            writer: String::new(),
        };
        let minted = instance
            .local(
                Method::POST,
                "/keys",
                Body::from(
                    json!({
                        "label": "writer",
                        "source": "writer",
                        "permissions": ["blobs.manage"],
                        "type_permissions": { "*": "write" },
                    })
                    .to_string(),
                ),
                "application/json",
            )
            .await;
        assert_eq!(minted.status, StatusCode::CREATED, "{}", minted.body);
        instance.writer = minted.body["key"].as_str().unwrap().to_string();
        instance
    }

    async fn local(&self, method: Method, path: &str, body: Body, kind: &str) -> Reply {
        call(&self.control, None, method, path, body, kind).await
    }

    async fn get(&self, path: &str) -> Reply {
        self.local(Method::GET, path, Body::empty(), "application/json")
            .await
    }

    async fn post(&self, path: &str) -> Reply {
        self.local(Method::POST, path, Body::empty(), "application/json")
            .await
    }

    async fn patch(&self, body: Value) -> Reply {
        patch(&self.control, body).await
    }

    /// An archive of what the instance holds, which restores to another instance.
    async fn archive(&self) -> Vec<u8> {
        let key = Some(self.writer.as_str());
        let exported = call(
            &self.public,
            key,
            Method::GET,
            "/export?format=archive",
            Body::empty(),
            "application/json",
        )
        .await;
        assert_eq!(exported.status, StatusCode::OK, "{}", exported.body);
        exported.body["bytes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|byte| byte.as_u64().unwrap() as u8)
            .collect()
    }

    fn arm(&self, fault: &str) {
        self.app.faults.set(fault, None).unwrap();
    }

    async fn when_held(&self) {
        let began = Instant::now();
        while began.elapsed() < Duration::from_secs(10) {
            if self.app.faults.list().iter().any(|fault| fault.waiting > 0) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("nothing was held");
    }
}

async fn patch(router: &Router, body: Value) -> Reply {
    call(
        router,
        None,
        Method::PATCH,
        "/config",
        Body::from(body.to_string()),
        "application/json",
    )
    .await
}

async fn call(
    router: &Router,
    key: Option<&str>,
    method: Method,
    path: &str,
    body: Body,
    kind: &str,
) -> Reply {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header(header::CONTENT_TYPE, kind);
    if let Some(key) = key {
        request = request.header(header::AUTHORIZATION, format!("Bearer {key}"));
    }
    let response = router
        .clone()
        .oneshot(request.body(body).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let body = serde_json::from_slice(&bytes).unwrap_or_else(
        |_| json!({ "bytes": bytes.iter().map(|byte| u64::from(*byte)).collect::<Vec<_>>() }),
    );
    Reply { status, body }
}

/// The settings that point `PATCH /config` at the store, under `prefix`.
fn names(s3: &FakeS3, prefix: &str) -> Value {
    let settings: serde_json::Map<String, Value> = s3
        .settings(BUCKET, prefix)
        .into_iter()
        .filter(|(name, _)| name != "MARFA_ALLOW_PRIVATE_ADDRESSES")
        .map(|(name, value)| {
            let key = name.strip_prefix("MARFA_").unwrap().to_lowercase();
            (key, Value::String(value))
        })
        .collect();
    Value::Object(settings)
}

fn marker_of(prefix: &str) -> String {
    format!("/{BUCKET}/{prefix}/blobs/.marfa-store")
}

fn prefix_in_use(instance: &Instance) -> Option<String> {
    match instance.app.blobs.kept()? {
        Kept::Bucket { prefix, .. } => Some(prefix),
        Kept::Folder(_) => None,
    }
}

async fn wait_for(what: &str, mut done: impl AsyncFnMut() -> bool) {
    let began = Instant::now();
    while !done().await {
        assert!(began.elapsed() < Duration::from_secs(10), "{what}");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_bucket_a_later_write_removed_is_not_taken_by_the_attach_an_earlier_one_began() {
    let s3 = FakeS3::start().await;
    let instance = Arc::new(Instance::start().await);
    let (release, arrived) = s3.hold_marker();
    let older = tokio::spawn({
        let (instance, body) = (instance.clone(), names(&s3, "older"));
        async move { instance.patch(body).await }
    });
    arrived.await.unwrap();

    let newer = tokio::spawn({
        let instance = instance.clone();
        async move { instance.patch(json!({ "object_store_bucket": "" })).await }
    });
    wait_for("the removal to commit", async || {
        let config = instance.get("/config").await;
        config.body["object_store_bucket"]
            .as_str()
            .unwrap_or("")
            .is_empty()
    })
    .await;
    release.send(()).unwrap();

    let (older, newer) = (older.await.unwrap(), newer.await.unwrap());
    assert_eq!(older.status, StatusCode::OK, "{}", older.body);
    assert_eq!(newer.status, StatusCode::OK, "{}", newer.body);
    assert_eq!(prefix_in_use(&instance), None);
    let listed = instance.get("/backups").await;
    assert_eq!(listed.status, StatusCode::CONFLICT, "{}", listed.body);
    assert_eq!(listed.code(), "no_backup_destination");
    // The witness: the same attach, with nothing removing the bucket, is the destination.
    let again = instance.patch(names(&s3, "older")).await;
    assert_eq!(again.status, StatusCode::OK, "{}", again.body);
    assert_eq!(instance.get("/backups").await.status, StatusCode::OK);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_restore_that_holds_the_writer_leaves_the_store_the_settings_name_troubled_until_it_ends()
{
    let s3 = FakeS3::start().await;
    let origin = Instance::start().await;
    let archive = origin.archive().await;
    let instance = Arc::new(Instance::start().await);
    let (release, arrived) = s3.hold_marker();
    let setting = tokio::spawn({
        let (instance, body) = (instance.clone(), names(&s3, "restoring"));
        async move { instance.patch(body).await }
    });
    arrived.await.unwrap();
    instance.arm("hold:restore:before-commit");
    let restoring = tokio::spawn({
        let instance = instance.clone();
        async move {
            instance
                .local(
                    Method::POST,
                    "/restore",
                    Body::from(archive),
                    "application/x-tar",
                )
                .await
        }
    });
    instance.when_held().await;
    release.send(()).unwrap();

    let set = setting.await.unwrap();
    assert_eq!(set.status, StatusCode::OK, "{}", set.body);
    let config = instance.get("/config").await;
    assert_eq!(config.body["object_store_bucket"], BUCKET);
    // The store the settings name could not be recorded, so it is not the old one that is used.
    let refused = instance.get("/backups").await;
    assert_eq!(refused.status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(refused.code(), "blob_store_unavailable");

    instance.app.faults.clear(None);
    let restored = restoring.await.unwrap();
    assert_eq!(restored.status, StatusCode::OK, "{}", restored.body);
    wait_for("the store the settings name to be in use", async || {
        instance.get("/backups").await.status == StatusCode::OK
    })
    .await;
    assert_eq!(prefix_in_use(&instance).as_deref(), Some("restoring"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_store_that_could_not_be_recorded_is_troubled_and_taken_again_by_the_next_backup() {
    let s3 = FakeS3::start().await;
    let instance = Arc::new(Instance::start().await);
    let (release, arrived) = s3.hold_marker();
    let setting = tokio::spawn({
        let (instance, body) = (instance.clone(), names(&s3, "unrecorded"));
        async move { instance.patch(body).await }
    });
    arrived.await.unwrap();
    instance.arm("refuse:write");
    release.send(()).unwrap();
    let set = setting.await.unwrap();
    assert_eq!(set.status, StatusCode::OK, "{}", set.body);

    let refused = instance.get("/backups").await;
    assert_eq!(refused.status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(refused.code(), "blob_store_unavailable");
    assert!(
        refused.body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("could not be recorded"),
        "{}",
        refused.body
    );

    instance.app.faults.clear(None);
    let taken = instance.post("/backups").await;
    assert_eq!(taken.status, StatusCode::OK, "{}", taken.body);
    assert_eq!(prefix_in_use(&instance).as_deref(), Some("unrecorded"));
    assert_eq!(instance.get("/backups").await.status, StatusCode::OK);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_write_that_names_no_other_store_neither_waits_for_an_attach_under_way_nor_starts_another()
 {
    let s3 = FakeS3::start().await;
    let instance = Arc::new(Instance::start().await);
    let (release, arrived) = s3.hold_marker();
    let setting = tokio::spawn({
        let (instance, body) = (instance.clone(), names(&s3, "slow"));
        async move { instance.patch(body).await }
    });
    arrived.await.unwrap();

    let began = Instant::now();
    let unrelated = tokio::time::timeout(
        Duration::from_secs(2),
        instance.patch(json!({ "backup_interval_seconds": 3600 })),
    )
    .await
    .expect("the unrelated write waited for the attach");
    assert_eq!(unrelated.status, StatusCode::OK, "{}", unrelated.body);
    assert!(began.elapsed() < Duration::from_secs(2));
    release.send(()).unwrap();

    let set = setting.await.unwrap();
    assert_eq!(set.status, StatusCode::OK, "{}", set.body);
    assert_eq!(prefix_in_use(&instance).as_deref(), Some("slow"));
    assert_eq!(
        s3.requests(&Method::GET, &marker_of("slow")),
        1,
        "the unrelated write began another attach"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_write_that_names_another_store_while_one_is_taken_is_answered_once_that_one_is_in_use() {
    let s3 = FakeS3::start().await;
    let instance = Arc::new(Instance::start().await);
    let (release, arrived) = s3.hold_marker();
    let first = tokio::spawn({
        let (instance, body) = (instance.clone(), names(&s3, "first"));
        async move { instance.patch(body).await }
    });
    arrived.await.unwrap();
    let second = tokio::spawn({
        let (instance, body) = (instance.clone(), names(&s3, "second"));
        async move { instance.patch(body).await }
    });
    wait_for("the second write to commit", async || {
        instance.get("/config").await.body["object_store_prefix"] == "second"
    })
    .await;
    release.send(()).unwrap();

    for reply in [first.await.unwrap(), second.await.unwrap()] {
        assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    }
    assert_eq!(prefix_in_use(&instance).as_deref(), Some("second"));
}
