//! A backup operation decides its destination from the committed settings, not from the store
//! the server has attached by then.

#[allow(dead_code)]
mod fake_s3;

use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Method, Request, StatusCode, header};
use marfa_server::app::App;
use marfa_server::app::blobs::Kept;
use marfa_server::http::control;
use marfa_server::settings::{Environment, Settings};
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::sync::oneshot;
use tower::ServiceExt;

use fake_s3::{FakeS3, Mode};

const BUCKET: &str = "marfa";
const ABSENT: &str =
    "/backups/0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b/20261109T101530.250Z.json/restore";

struct Instance {
    _dir: TempDir,
    app: Arc<App>,
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

impl Instance {
    async fn start() -> Arc<Instance> {
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
        Arc::new(Instance {
            control: control(app.clone()),
            app,
            _dir: dir,
        })
    }

    async fn send(&self, method: Method, path: &str, body: Body) -> Reply {
        let request = Request::builder()
            .method(method)
            .uri(path)
            .header(header::CONTENT_TYPE, "application/json")
            .body(body)
            .unwrap();
        let response = self.control.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        Reply { status, body }
    }

    async fn list(&self) -> Reply {
        self.send(Method::GET, "/backups", Body::empty()).await
    }

    async fn take(&self) -> Reply {
        self.send(Method::POST, "/backups", Body::empty()).await
    }

    async fn restore(&self) -> Reply {
        self.send(Method::POST, ABSENT, Body::empty()).await
    }

    async fn patch(&self, body: Value) -> Reply {
        self.send(Method::PATCH, "/config", Body::from(body.to_string()))
            .await
    }

    fn prefix_in_use(&self) -> Option<String> {
        match self.app.blobs.kept()? {
            Kept::Bucket { prefix, .. } => Some(prefix),
            Kept::Folder(_) => None,
        }
    }
}

fn bucket_named(s3: &FakeS3, prefix: &str) -> Value {
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

/// Sets the bucket under `prefix` while its attach is held at the first look at the store, and
/// answers once that attach has begun, so the settings name a store that is not yet attached.
async fn set_while_attaching(
    instance: &Instance,
    s3: &FakeS3,
    prefix: &str,
) -> oneshot::Sender<()> {
    let (release, arrived) = s3.hold_marker();
    let set = instance.patch(bucket_named(s3, prefix)).await;
    assert_eq!(set.status, StatusCode::OK, "{}", set.body);
    arrived.await.unwrap();
    release
}

#[derive(Clone, Copy, Debug)]
enum Operation {
    List,
    Take,
    Restore,
}

async fn run(instance: &Instance, operation: Operation) -> Reply {
    match operation {
        Operation::List => instance.list().await,
        Operation::Take => instance.take().await,
        Operation::Restore => instance.restore().await,
    }
}

async fn waits_for_the_store_the_settings_name(operation: Operation, answers: StatusCode) {
    let s3 = FakeS3::start().await;
    let instance = Instance::start().await;
    let release = set_while_attaching(&instance, &s3, "named").await;

    let asking = tokio::spawn({
        let instance = instance.clone();
        async move { run(&instance, operation).await }
    });
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(
        !asking.is_finished(),
        "{operation:?} answered before the store the settings name was taken"
    );
    release.send(()).unwrap();

    let reply = asking.await.unwrap();
    assert_eq!(reply.status, answers, "{operation:?}: {}", reply.body);
    assert_eq!(instance.prefix_in_use().as_deref(), Some("named"));
    assert_eq!(
        s3.requests(&Method::GET, &marker_of("named")),
        1,
        "{operation:?} began another attach of the store already being taken"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_list_right_after_the_settings_name_an_object_store_waits_for_it() {
    waits_for_the_store_the_settings_name(Operation::List, StatusCode::OK).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_backup_right_after_the_settings_name_an_object_store_waits_for_it() {
    waits_for_the_store_the_settings_name(Operation::Take, StatusCode::OK).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_restore_right_after_the_settings_name_an_object_store_waits_for_it() {
    waits_for_the_store_the_settings_name(Operation::Restore, StatusCode::NOT_FOUND).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_write_that_names_no_other_store_neither_waits_for_an_attach_under_way_nor_starts_another()
 {
    let s3 = FakeS3::start().await;
    let instance = Instance::start().await;
    let release = set_while_attaching(&instance, &s3, "slow").await;

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

    assert_eq!(instance.list().await.status, StatusCode::OK);
    assert_eq!(instance.prefix_in_use().as_deref(), Some("slow"));
    assert_eq!(s3.requests(&Method::GET, &marker_of("slow")), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_bucket_the_settings_no_longer_name_is_not_listed() {
    let s3 = FakeS3::start().await;
    let instance = Instance::start().await;
    let release = set_while_attaching(&instance, &s3, "first").await;
    release.send(()).unwrap();
    assert_eq!(instance.list().await.status, StatusCode::OK);

    let release = set_while_attaching(&instance, &s3, "second").await;
    let removed = instance.patch(json!({ "object_store_bucket": "" })).await;
    assert_eq!(removed.status, StatusCode::OK, "{}", removed.body);
    let listing = tokio::spawn({
        let instance = instance.clone();
        async move { instance.list().await }
    });
    release.send(()).unwrap();

    let listed = listing.await.unwrap();
    assert_eq!(listed.status, StatusCode::CONFLICT, "{}", listed.body);
    assert_eq!(listed.code(), "no_backup_destination");
    assert_eq!(instance.prefix_in_use(), None);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn two_quick_changes_of_the_destination_and_then_a_list_use_the_last() {
    let s3 = FakeS3::start().await;
    let instance = Instance::start().await;
    let release = set_while_attaching(&instance, &s3, "older").await;
    let newer = instance.patch(bucket_named(&s3, "newer")).await;
    assert_eq!(newer.status, StatusCode::OK, "{}", newer.body);
    let listing = tokio::spawn({
        let instance = instance.clone();
        async move { instance.list().await }
    });
    release.send(()).unwrap();

    let listed = listing.await.unwrap();
    assert_eq!(listed.status, StatusCode::OK, "{}", listed.body);
    assert_eq!(instance.prefix_in_use().as_deref(), Some("newer"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_store_that_cannot_be_taken_is_a_503_and_is_taken_again_by_the_next_operation() {
    let s3 = FakeS3::start().await;
    let instance = Instance::start().await;
    s3.set_mode(Mode::AllNotFound);
    let set = instance.patch(bucket_named(&s3, "later")).await;
    assert_eq!(set.status, StatusCode::OK, "{}", set.body);

    for operation in [Operation::List, Operation::Take, Operation::Restore] {
        let refused = run(&instance, operation).await;
        assert_eq!(
            refused.status,
            StatusCode::SERVICE_UNAVAILABLE,
            "{operation:?}"
        );
        assert_eq!(refused.code(), "blob_store_unavailable", "{operation:?}");
    }
    assert_eq!(instance.prefix_in_use(), None);

    s3.set_mode(Mode::Normal);
    assert_eq!(instance.list().await.status, StatusCode::OK);
    assert_eq!(instance.prefix_in_use().as_deref(), Some("later"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_backup_folder_the_settings_name_is_the_destination_of_the_next_operation() {
    let instance = Instance::start().await;
    let folder = TempDir::new().unwrap();
    let set = instance
        .patch(json!({ "backup_path": folder.path() }))
        .await;
    assert_eq!(set.status, StatusCode::OK, "{}", set.body);
    assert_eq!(instance.list().await.status, StatusCode::OK);

    let removed = instance.patch(json!({ "backup_path": "" })).await;
    assert_eq!(removed.status, StatusCode::OK, "{}", removed.body);
    for operation in [Operation::List, Operation::Take, Operation::Restore] {
        let refused = run(&instance, operation).await;
        assert_eq!(refused.status, StatusCode::CONFLICT, "{operation:?}");
        assert_eq!(refused.code(), "no_backup_destination", "{operation:?}");
    }

    let again = instance
        .patch(json!({ "backup_path": folder.path() }))
        .await;
    assert_eq!(again.status, StatusCode::OK, "{}", again.body);
    let restored = instance.restore().await;
    assert_eq!(restored.status, StatusCode::NOT_FOUND, "{}", restored.body);
    assert_eq!(restored.code(), "backup_not_found");
}
