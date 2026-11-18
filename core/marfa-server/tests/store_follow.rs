//! The store beside the disk ends up as the one the latest committed settings name: an attach
//! the settings moved past is never used, a record and its swap happen together, and a record or
//! reload that failed is mended by the replication job.

#[allow(dead_code)]
mod fake_s3;
#[allow(dead_code)]
mod support;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Method, Request, StatusCode, header};
use marfa_server::app::access::Caller;
use marfa_server::app::blobs::{MARKER, Retry, lock_blobs};
use marfa_server::app::{App, housekeeping};
use marfa_server::http::control;
use marfa_server::settings::{Environment, Settings};
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::sync::oneshot;
use tower::ServiceExt;

use fake_s3::{FakeS3, Mode};

const BUCKET: &str = "marfa";

struct Instance {
    _dir: TempDir,
    app: Arc<App>,
    control: Router,
}

struct Reply {
    status: StatusCode,
    body: Value,
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

    async fn send(&self, method: Method, path: &str, body: Option<Value>) -> Reply {
        let request = Request::builder()
            .method(method)
            .uri(path)
            .header(header::CONTENT_TYPE, "application/json")
            .body(body.map_or_else(Body::empty, |body| Body::from(body.to_string())))
            .unwrap();
        let response = self.control.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        Reply { status, body }
    }

    async fn patch(&self, body: Value) -> Reply {
        self.send(Method::PATCH, "/config", Some(body)).await
    }

    async fn name(&self, body: Value) {
        let set = self.patch(body).await;
        assert_eq!(set.status, StatusCode::OK, "{}", set.body);
    }

    /// Waits for every follow asked for so far, as the replication job's first step does.
    async fn settle(&self) {
        self.app.follow_stores(Retry::Settle).await.unwrap();
    }

    async fn replicate(&self) {
        housekeeping::run_now(&self.app, &Caller::Server, "blob-replicate")
            .await
            .unwrap();
    }

    /// Where the store beside the disk is in use: its locator, or `disk` for none.
    fn in_use(&self) -> String {
        if let Some(s3) = self.app.blobs.s3() {
            return s3.locator().to_string();
        }
        if let Some(folder) = self.app.blobs.folder() {
            return folder.files().root().display().to_string();
        }
        "disk".to_string()
    }

    /// The locators of every store beside the disk, each with whether it is attached.
    async fn recorded(&self) -> Vec<(String, bool)> {
        let listed = self.send(Method::GET, "/blobs/stores", None).await;
        assert_eq!(listed.status, StatusCode::OK, "{}", listed.body);
        listed.body["data"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|store| store["kind"] != "disk")
            .map(|store| {
                (
                    store["locator"].as_str().unwrap().to_string(),
                    store["detached_at"].is_null(),
                )
            })
            .collect()
    }

    async fn attached(&self) -> Vec<String> {
        self.recorded()
            .await
            .into_iter()
            .filter_map(|(locator, attached)| attached.then_some(locator))
            .collect()
    }

    fn area(&self, folder: &Path) -> PathBuf {
        folder.join("files").join(&self.app.instance_id)
    }

    /// Returns once a hold fault has a waiter.
    async fn reached(&self, hold: &str) {
        for _ in 0..500 {
            let waiting = self
                .app
                .faults
                .list()
                .iter()
                .any(|fault| fault.name == hold && fault.waiting > 0);
            if waiting {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("nothing reached {hold}");
    }

    /// Returns once a follow that met `fault` has ended in doubt, before any later follow runs.
    async fn failed_on(&self, fault: &str) {
        for _ in 0..500 {
            if self.fired(fault) > 0 && !self.app.blobs.settled() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("no follow failed on {fault}");
    }

    fn fired(&self, fault: &str) -> u64 {
        self.app
            .faults
            .list()
            .iter()
            .find(|listed| listed.name == fault)
            .map_or(0, |listed| u64::from(listed.fired))
    }
}

fn bucket(s3: &FakeS3, prefix: &str) -> Value {
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

fn locator(prefix: &str) -> String {
    format!("s3://{BUCKET}/{prefix}")
}

fn marker_of(prefix: &str) -> String {
    format!("/{BUCKET}/{prefix}/blobs/.marfa-store")
}

/// Names the bucket under `prefix` and returns once its attach waits on the marker read.
async fn name_while_attaching(
    instance: &Instance,
    s3: &FakeS3,
    prefix: &str,
) -> oneshot::Sender<()> {
    let (release, arrived) = s3.hold_marker();
    instance.name(bucket(s3, prefix)).await;
    arrived.await.unwrap();
    release
}

/// A folder the settings may name as `backup_path`.
fn folder_in(parent: &TempDir, name: &str) -> PathBuf {
    let folder = parent.path().join(name);
    fs::create_dir(&folder).unwrap();
    folder
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_store_named_again_while_another_attaches_stays_in_use() {
    let s3 = FakeS3::start().await;
    let instance = Instance::start().await;
    instance.name(bucket(&s3, "a")).await;
    instance.settle().await;
    assert_eq!(instance.in_use(), locator("a"));

    let release = name_while_attaching(&instance, &s3, "b").await;
    instance.name(bucket(&s3, "a")).await;
    release.send(()).unwrap();
    instance.settle().await;
    instance.settle().await;

    assert_eq!(instance.in_use(), locator("a"));
    assert_eq!(instance.attached().await, [locator("a")]);
    assert!(
        !instance
            .recorded()
            .await
            .iter()
            .any(|(at, attached)| *at == locator("b") && *attached),
        "{:?}",
        instance.recorded().await
    );
    // The witness that b can be attached: named alone, it is.
    instance.name(bucket(&s3, "b")).await;
    instance.settle().await;
    assert_eq!(instance.in_use(), locator("b"));
    assert_eq!(instance.attached().await, [locator("b")]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_third_store_named_while_another_attaches_is_used_and_the_second_never_is() {
    let s3 = FakeS3::start().await;
    let instance = Instance::start().await;
    instance.name(bucket(&s3, "a")).await;
    instance.settle().await;

    let release = name_while_attaching(&instance, &s3, "b").await;
    instance.name(bucket(&s3, "c")).await;
    release.send(()).unwrap();
    instance.settle().await;

    assert_eq!(instance.in_use(), locator("c"));
    assert_eq!(instance.attached().await, [locator("c")]);
    let recorded = instance.recorded().await;
    assert!(
        !recorded.iter().any(|(at, _)| *at == locator("b")),
        "{recorded:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn naming_the_store_being_attached_again_attaches_it_once() {
    let s3 = FakeS3::start().await;
    let instance = Instance::start().await;
    let release = name_while_attaching(&instance, &s3, "b").await;
    instance.name(bucket(&s3, "b")).await;
    release.send(()).unwrap();
    instance.settle().await;

    assert_eq!(instance.in_use(), locator("b"));
    assert_eq!(s3.requests(&Method::GET, &marker_of("b")), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_backup_request_dropped_mid_attach_still_records_and_uses_the_store() {
    let s3 = FakeS3::start().await;
    let instance = Instance::start().await;
    s3.set_mode(Mode::AllNotFound);
    instance.name(bucket(&s3, "b")).await;
    instance.settle().await;
    assert!(instance.app.blobs.trouble().is_some());
    assert_eq!(instance.in_use(), "disk");

    s3.set_mode(Mode::Normal);
    let (release, arrived) = s3.hold_marker();
    let asking = tokio::spawn({
        let instance = instance.clone();
        async move { instance.send(Method::POST, "/backups", None).await }
    });
    arrived.await.unwrap();
    asking.abort();
    let _ = asking.await;
    release.send(()).unwrap();
    instance.settle().await;

    assert_eq!(instance.in_use(), locator("b"));
    assert!(instance.app.blobs.trouble().is_none());
    assert_eq!(instance.attached().await, [locator("b")]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_record_that_rolls_back_keeps_the_old_store_and_the_replication_job_records_again() {
    let s3 = FakeS3::start().await;
    let instance = Instance::start().await;
    instance.name(bucket(&s3, "a")).await;
    instance.settle().await;

    instance.app.faults.set("fail:stores-record", None).unwrap();
    instance.name(bucket(&s3, "b")).await;
    instance.failed_on("fail:stores-record").await;
    assert_eq!(instance.in_use(), locator("a"));
    assert_eq!(instance.attached().await, [locator("a")]);
    assert!(!instance.app.blobs.settled());

    instance.app.faults.clear(None);
    instance.replicate().await;
    assert_eq!(instance.in_use(), locator("b"));
    assert_eq!(instance.attached().await, [locator("b")]);
    assert!(instance.app.blobs.settled());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_record_that_lands_and_reports_failure_is_mended_by_the_replication_job() {
    let s3 = FakeS3::start().await;
    let instance = Instance::start().await;
    instance.name(bucket(&s3, "a")).await;
    instance.settle().await;

    instance
        .app
        .faults
        .set("fail:stores-record-lost", None)
        .unwrap();
    instance.name(bucket(&s3, "b")).await;
    instance.failed_on("fail:stores-record-lost").await;
    // The record landed, so it names b while a stays in use.
    assert_eq!(instance.in_use(), locator("a"));
    assert_eq!(instance.attached().await, [locator("b")]);
    assert!(!instance.app.blobs.settled());

    instance.app.faults.clear(None);
    instance.replicate().await;
    assert_eq!(instance.in_use(), locator("b"));
    assert_eq!(instance.attached().await, [locator("b")]);
    assert!(instance.app.blobs.settled());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_uncertain_record_of_the_store_in_use_is_written_again_and_a_backup_waits_for_it() {
    let s3 = FakeS3::start().await;
    let instance = Instance::start().await;
    instance.name(bucket(&s3, "a")).await;
    instance.settle().await;

    instance
        .app
        .faults
        .set("fail:stores-record-lost", None)
        .unwrap();
    instance.name(bucket(&s3, "b")).await;
    instance.failed_on("fail:stores-record-lost").await;
    assert_eq!(instance.attached().await, [locator("b")]);

    // Named again, a is in use already, and only its record is wrong.
    instance.app.faults.set("fail:stores-record", None).unwrap();
    instance.name(bucket(&s3, "a")).await;
    instance.failed_on("fail:stores-record").await;
    assert_eq!(instance.in_use(), locator("a"));
    assert_eq!(instance.attached().await, [locator("b")]);
    assert!(!instance.app.blobs.settled());

    instance.app.faults.set("fail:stores-record", None).unwrap();
    let refused = instance.send(Method::POST, "/backups", None).await;
    assert_eq!(
        refused.status,
        StatusCode::SERVICE_UNAVAILABLE,
        "{}",
        refused.body
    );
    assert_eq!(refused.body["error"]["code"], "blob_store_unavailable");
    assert_eq!(instance.fired("fail:stores-record"), 1);

    instance.app.faults.clear(None);
    let taken = instance.send(Method::POST, "/backups", None).await;
    assert_eq!(taken.status, StatusCode::OK, "{}", taken.body);
    assert_eq!(instance.in_use(), locator("a"));
    assert_eq!(instance.attached().await, [locator("a")]);
    assert!(instance.app.blobs.settled());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_store_that_cannot_be_used_is_tried_once_by_each_follow() {
    let s3 = FakeS3::start().await;
    let instance = Instance::start().await;
    s3.set_mode(Mode::AllNotFound);
    instance.name(bucket(&s3, "b")).await;
    instance.settle().await;
    assert!(instance.app.blobs.trouble().is_some());
    assert_eq!(s3.requests(&Method::GET, &marker_of("b")), 1);

    // The replication job settles without trying the store again.
    instance.replicate().await;
    assert_eq!(s3.requests(&Method::GET, &marker_of("b")), 1);

    instance.app.follow_stores(Retry::Trouble).await.unwrap();
    assert_eq!(s3.requests(&Method::GET, &marker_of("b")), 2);
    assert!(instance.app.blobs.trouble().is_some());

    s3.set_mode(Mode::Normal);
    instance.app.follow_stores(Retry::Trouble).await.unwrap();
    assert_eq!(instance.in_use(), locator("b"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_folder_the_settings_move_past_while_it_is_attached_is_let_go() {
    let parent = TempDir::new().unwrap();
    let first = folder_in(&parent, "first");
    let passed = folder_in(&parent, "passed");
    let instance = Instance::start().await;
    instance.name(json!({ "backup_path": first })).await;
    instance.settle().await;

    instance.app.faults.set("hold:stores-record", None).unwrap();
    instance.name(json!({ "backup_path": passed })).await;
    instance.reached("hold:stores-record").await;
    // The witness that the attach took the folder: another server could not open it now.
    assert!(lock_blobs(&instance.area(&passed)).is_err());
    instance.name(json!({ "backup_path": first })).await;
    instance.app.faults.clear(None);
    instance.settle().await;

    assert_eq!(
        instance.in_use(),
        instance.area(&first).display().to_string()
    );
    assert!(lock_blobs(&instance.area(&passed)).is_ok());
    assert!(lock_blobs(&instance.area(&first)).is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_change_staged_between_a_record_and_its_swap_stops_the_swap() {
    let parent = TempDir::new().unwrap();
    let first = folder_in(&parent, "first");
    let passed = folder_in(&parent, "passed");
    let instance = Instance::start().await;
    instance.name(json!({ "backup_path": first })).await;
    instance.settle().await;
    let before = instance.app.blobs.folder().unwrap();

    instance.app.faults.set("hold:stores-swap", None).unwrap();
    instance.name(json!({ "backup_path": passed })).await;
    instance.reached("hold:stores-swap").await;
    assert_eq!(
        instance.attached().await,
        [instance.area(&passed).display().to_string()]
    );
    // The settings write does not wait for the held follow.
    let back = tokio::time::timeout(
        Duration::from_secs(5),
        instance.patch(json!({ "backup_path": first })),
    )
    .await
    .expect("the settings write waited for the follow");
    assert_eq!(back.status, StatusCode::OK, "{}", back.body);
    instance.app.faults.clear(None);
    instance.settle().await;

    let after = instance.app.blobs.folder().unwrap();
    assert!(Arc::ptr_eq(&before, &after), "the passed folder was swapped in");
    assert_eq!(
        instance.attached().await,
        [instance.area(&first).display().to_string()]
    );
    assert!(instance.app.blobs.settled());
    assert!(lock_blobs(&instance.area(&passed)).is_ok());

    // The witness that the swap is made when no change is staged after the record.
    instance.app.faults.set("hold:stores-swap", None).unwrap();
    instance.name(json!({ "backup_path": passed })).await;
    instance.reached("hold:stores-swap").await;
    instance.app.faults.clear(None);
    instance.settle().await;
    assert_eq!(
        instance.in_use(),
        instance.area(&passed).display().to_string()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_follow_reads_the_committed_settings_when_the_live_ones_lag() {
    let s3 = FakeS3::start().await;
    let instance = Instance::start().await;
    instance.name(bucket(&s3, "a")).await;
    instance.settle().await;

    support::commit_unpublished(&instance.app, "object_store_prefix", "c").await;
    instance.app.follow_stores(Retry::Trouble).await.unwrap();
    assert_eq!(instance.in_use(), locator("c"));
    instance.app.follow_stores(Retry::Trouble).await.unwrap();
    assert_eq!(instance.in_use(), locator("c"));
    assert_eq!(s3.requests(&Method::GET, &marker_of("a")), 1);
    assert_eq!(s3.requests(&Method::GET, &marker_of("c")), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failed_reload_is_mended_by_the_replication_job_before_the_stores_count_as_settled() {
    let s3 = FakeS3::start().await;
    let instance = Instance::start().await;
    instance.name(bucket(&s3, "a")).await;
    instance.settle().await;

    // A commit that landed and was never made live, then a write of unknown outcome whose
    // reload fails.
    support::commit_unpublished(&instance.app, "object_store_prefix", "b").await;
    instance
        .app
        .faults
        .set("fail:commit", Some("config.update"))
        .unwrap();
    instance.app.faults.set("fail:settings-reload", None).unwrap();
    let unknown = instance
        .patch(json!({ "backup_interval_seconds": 3600 }))
        .await;
    assert!(!unknown.status.is_success(), "{}", unknown.body);
    assert_eq!(instance.fired("fail:settings-reload"), 1);
    assert!(!instance.app.blobs.settled());
    let live = || {
        instance
            .app
            .settings
            .live()
            .get(marfa_server::settings::registry::OBJECT_STORE_PREFIX)
    };
    assert_eq!(live().as_deref(), Some("a"));

    instance.app.faults.set("fail:settings-reload", None).unwrap();
    instance.replicate().await;
    assert_eq!(instance.fired("fail:settings-reload"), 1);
    assert_eq!(live().as_deref(), Some("a"));
    assert!(!instance.app.blobs.settled());

    instance.app.faults.clear(None);
    instance.replicate().await;
    assert_eq!(live().as_deref(), Some("b"));
    instance.settle().await;
    assert_eq!(instance.in_use(), locator("b"));
    assert!(instance.app.blobs.settled());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_settings_write_during_a_restore_is_refused_at_once_while_a_follow_waits_to_record() {
    let s3 = FakeS3::start().await;
    let instance = Instance::start().await;
    let minted = instance
        .send(
            Method::POST,
            "/keys",
            Some(json!({
                "label": "reader",
                "source": "reader",
                "type_permissions": { "*": "read" },
            })),
        )
        .await;
    assert_eq!(minted.status, StatusCode::CREATED, "{}", minted.body);
    let exported = Request::builder()
        .method(Method::GET)
        .uri("/export?format=archive")
        .header(
            header::AUTHORIZATION,
            format!("Bearer {}", minted.body["key"].as_str().unwrap()),
        )
        .body(Body::empty())
        .unwrap();
    let response = marfa_server::http::public(instance.app.clone())
        .oneshot(exported)
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let archive = to_bytes(response.into_body(), usize::MAX).await.unwrap();

    instance.app.faults.set("hold:stores-record", None).unwrap();
    instance.name(bucket(&s3, "b")).await;
    instance.reached("hold:stores-record").await;

    instance
        .app
        .faults
        .set("hold:restore:before-commit", None)
        .unwrap();
    let restoring = tokio::spawn({
        let instance = instance.clone();
        async move {
            let request = Request::builder()
                .method(Method::POST)
                .uri("/restore")
                .header(header::CONTENT_TYPE, "application/x-tar")
                .body(Body::from(archive))
                .unwrap();
            instance
                .control
                .clone()
                .oneshot(request)
                .await
                .unwrap()
                .status()
        }
    });
    instance.reached("hold:restore:before-commit").await;
    instance.app.faults.clear(Some("hold:stores-record"));
    tokio::time::sleep(Duration::from_millis(100)).await;

    let refused = tokio::time::timeout(
        Duration::from_secs(2),
        instance.patch(json!({ "backup_interval_seconds": 3600 })),
    )
    .await
    .expect("the settings write waited behind the restore");
    assert!(!refused.status.is_success(), "{}", refused.body);

    instance.app.faults.clear(None);
    let restored = restoring.await.unwrap();
    assert!(restored.is_success(), "{restored}");
    instance.replicate().await;
    assert_eq!(instance.in_use(), locator("b"));
    assert_eq!(instance.attached().await, [locator("b")]);
}

/// A backup folder whose disk was replaced: the same path, holding none of the server's files.
async fn replaced(instance: &Instance, parent: &TempDir) -> (PathBuf, String) {
    let folder = folder_in(parent, "disk");
    instance.name(json!({ "backup_path": folder })).await;
    instance.settle().await;
    let old = instance.app.blobs.folder().unwrap().files().id().to_string();
    fs::rename(&folder, parent.path().join("old disk")).unwrap();
    fs::create_dir(&folder).unwrap();
    (folder, old)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_adopt_refuses_once_the_settings_name_another_folder_while_it_runs() {
    let parent = TempDir::new().unwrap();
    let instance = Instance::start().await;
    let (folder, old) = replaced(&instance, &parent).await;
    let other = folder_in(&parent, "other");

    instance.app.faults.set("hold:stores-record", None).unwrap();
    let adopting = tokio::spawn({
        let instance = instance.clone();
        async move {
            instance
                .send(Method::POST, "/backups/folder/adopt", None)
                .await
        }
    });
    instance.reached("hold:stores-record").await;
    instance.name(json!({ "backup_path": other })).await;
    instance.app.faults.clear(None);
    let adopted = adopting.await.unwrap();
    assert_eq!(adopted.status, StatusCode::CONFLICT, "{}", adopted.body);
    instance.settle().await;

    assert_eq!(
        instance.in_use(),
        instance.area(&other).display().to_string()
    );
    assert_eq!(
        instance.attached().await,
        [instance.area(&other).display().to_string()]
    );
    let listed = instance.send(Method::GET, "/blobs/stores", None).await;
    let folders: Vec<&str> = listed.body["data"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|store| store["locator"] == instance.area(&folder).display().to_string())
        .map(|store| store["id"].as_str().unwrap())
        .collect();
    assert_eq!(folders, [old.as_str()]);

    // The witness that the folder could be adopted: named again, it is.
    instance.name(json!({ "backup_path": folder })).await;
    instance.settle().await;
    let adopted = instance
        .send(Method::POST, "/backups/folder/adopt", None)
        .await;
    assert_eq!(adopted.status, StatusCode::OK, "{}", adopted.body);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_adopt_whose_request_goes_away_after_its_record_still_claims_the_folder() {
    let parent = TempDir::new().unwrap();
    let instance = Instance::start().await;
    let (folder, old) = replaced(&instance, &parent).await;

    instance.app.faults.set("hold:stores-swap", None).unwrap();
    let adopting = tokio::spawn({
        let instance = instance.clone();
        async move {
            instance
                .send(Method::POST, "/backups/folder/adopt", None)
                .await
        }
    });
    instance.reached("hold:stores-swap").await;
    adopting.abort();
    let _ = adopting.await;

    // A follow waits for the adopt to end.
    let following = tokio::spawn({
        let instance = instance.clone();
        async move { instance.settle().await }
    });
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(!following.is_finished(), "a follow ran inside the adopt");
    instance.app.faults.clear(None);
    following.await.unwrap();

    let id = instance.app.blobs.folder().unwrap().files().id().to_string();
    assert_ne!(id, old);
    let marker = fs::read_to_string(instance.area(&folder).join(MARKER)).unwrap();
    assert_eq!(marker.trim(), id);
    let listed = instance.send(Method::GET, "/blobs/stores", None).await;
    let attached: Vec<&str> = listed.body["data"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|store| store["kind"] == "folder" && store["detached_at"].is_null())
        .map(|store| store["id"].as_str().unwrap())
        .collect();
    assert_eq!(attached, [id.as_str()]);
}
