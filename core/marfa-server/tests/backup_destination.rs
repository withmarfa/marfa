//! Backup operations use the destination immediately after its settings write answers.

#[allow(dead_code)]
mod fake_s3;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Method, Request, StatusCode, header};
use marfa_server::app::App;
use marfa_server::app::backups;
use marfa_server::app::blobs::Retry;
use marfa_server::http::control;
use marfa_server::settings::{Environment, Settings};
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::sync::oneshot;
use tower::ServiceExt;

use fake_s3::{FakeS3, Mode};

const BUCKET: &str = "marfa";
const ABSENT: &str = "20261109T101530.250Z.json";
const OTHER_INSTANCE: &str = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

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
        Instance::start_with("0").await
    }

    async fn start_with(interval: &str) -> Arc<Instance> {
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
            ("MARFA_BACKUP_INTERVAL_SECONDS", interval),
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

    async fn run(&self, operation: Operation) -> Reply {
        match operation {
            Operation::List => self.send(Method::GET, "/backups", None).await,
            Operation::Take => self.send(Method::POST, "/backups", None).await,
            Operation::Restore => self.restore(OTHER_INSTANCE, ABSENT).await,
            Operation::Adopt => self.send(Method::POST, "/backups/folder/adopt", None).await,
        }
    }

    async fn restore(&self, instance: &str, name: &str) -> Reply {
        let path = format!("/backups/{instance}/{name}/restore");
        self.send(Method::POST, &path, None).await
    }

    async fn patch(&self, body: Value) -> Reply {
        self.send(Method::PATCH, "/config", Some(body)).await
    }

    async fn name(&self, body: Value) {
        let set = self.patch(body).await;
        assert_eq!(set.status, StatusCode::OK, "{}", set.body);
    }

    /// The names of this instance's backups the next list answers with.
    async fn listed(&self) -> Vec<String> {
        let listed = self.run(Operation::List).await;
        assert_eq!(listed.status, StatusCode::OK, "{}", listed.body);
        listed.body["data"]
            .as_array()
            .unwrap()
            .iter()
            .map(|backup| backup["name"].as_str().unwrap().to_string())
            .collect()
    }

    /// Takes a backup in the very next request and answers its name.
    async fn took(&self) -> String {
        let taken = self.run(Operation::Take).await;
        assert_eq!(taken.status, StatusCode::OK, "{}", taken.body);
        assert_eq!(taken.body["outcome"], "put", "{}", taken.body);
        taken.body["backup"]["name"].as_str().unwrap().to_string()
    }

    /// Waits for every follow asked for so far.
    async fn settle(&self) {
        self.app.follow_stores(Retry::Settle).await.unwrap();
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

    /// Returns once a follow that met `fault` has ended in doubt.
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
}

#[derive(Clone, Copy, Debug)]
enum Operation {
    List,
    Take,
    Restore,
    Adopt,
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

fn backups_in(s3: &FakeS3, prefix: &str) -> Vec<String> {
    s3.objects_under(&format!("/{BUCKET}/{prefix}/backups/"))
}

fn folder_in(parent: &TempDir, name: &str) -> PathBuf {
    let folder = parent.path().join(name);
    fs::create_dir(&folder).unwrap();
    folder
}

/// The backups of `instance` that a backup folder holds.
fn backups_of(folder: &Path, instance: &str) -> usize {
    fs::read_dir(folder.join("backups").join(instance))
        .map(|entries| entries.count())
        .unwrap_or(0)
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

/// Starts `operation`, shows it has not answered while the attach is held, then releases it.
async fn answers_once_released(
    instance: &Arc<Instance>,
    operation: Operation,
    release: impl FnOnce(),
) -> Reply {
    let asking = tokio::spawn({
        let instance = instance.clone();
        async move { instance.run(operation).await }
    });
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(
        !asking.is_finished(),
        "{operation:?} answered before the store the settings name was taken"
    );
    release();
    asking.await.unwrap()
}

async fn the_next_operation_uses_the_object_store_just_named(operation: Operation, status: u16) {
    let s3 = FakeS3::start().await;
    let instance = Instance::start().await;
    let release = name_while_attaching(&instance, &s3, "named").await;

    let reply = answers_once_released(&instance, operation, || release.send(()).unwrap()).await;

    assert_eq!(
        reply.status.as_u16(),
        status,
        "{operation:?}: {}",
        reply.body
    );
    assert_eq!(instance.in_use(), locator("named"));
    assert_eq!(
        s3.requests(&Method::GET, &marker_of("named")),
        1,
        "{operation:?} began another attach of the store being taken"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_list_right_after_the_settings_name_an_object_store_uses_it() {
    the_next_operation_uses_the_object_store_just_named(Operation::List, 200).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_backup_right_after_the_settings_name_an_object_store_is_written_to_it() {
    the_next_operation_uses_the_object_store_just_named(Operation::Take, 200).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_restore_right_after_the_settings_name_an_object_store_reads_from_it() {
    the_next_operation_uses_the_object_store_just_named(Operation::Restore, 404).await;
}

async fn the_next_operation_uses_the_folder_just_named(operation: Operation, status: u16) -> Reply {
    let instance = Instance::start().await;
    let parent = TempDir::new().unwrap();
    let folder = folder_in(&parent, "backups");
    instance.app.faults.set("hold:stores-record", None).unwrap();
    instance.name(json!({ "backup_path": folder })).await;
    instance.reached("hold:stores-record").await;

    let reply = answers_once_released(&instance, operation, || {
        instance.app.faults.clear(Some("hold:stores-record"));
    })
    .await;

    assert_eq!(
        reply.status.as_u16(),
        status,
        "{operation:?}: {}",
        reply.body
    );
    let files = folder.join("files").join(&instance.app.instance_id);
    assert_eq!(instance.in_use(), files.display().to_string());
    reply
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_list_right_after_the_settings_name_a_folder_uses_it() {
    the_next_operation_uses_the_folder_just_named(Operation::List, 200).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_backup_right_after_the_settings_name_a_folder_is_written_to_it() {
    the_next_operation_uses_the_folder_just_named(Operation::Take, 200).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_restore_right_after_the_settings_name_a_folder_reads_from_it() {
    the_next_operation_uses_the_folder_just_named(Operation::Restore, 404).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_adopt_right_after_the_settings_name_a_folder_refuses_it_as_holding_this_instances_files()
 {
    let reply = the_next_operation_uses_the_folder_just_named(Operation::Adopt, 409).await;
    assert_eq!(reply.code(), "conflict", "{}", reply.body);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn each_store_answers_from_its_own_backups_when_the_settings_move_between_them() {
    let s3 = FakeS3::start().await;
    let instance = Instance::start().await;
    instance.name(bucket(&s3, "a")).await;
    let in_a = instance.took().await;
    instance.name(bucket(&s3, "b")).await;
    let in_b = instance.took().await;
    assert_ne!(in_a, in_b);
    assert_eq!(backups_in(&s3, "a").len(), 1, "{:?}", backups_in(&s3, "a"));
    assert_eq!(backups_in(&s3, "b").len(), 1, "{:?}", backups_in(&s3, "b"));
    assert!(backups_in(&s3, "a")[0].ends_with(&in_a));
    assert!(backups_in(&s3, "b")[0].ends_with(&in_b));

    let own = instance.app.instance_id.clone();
    assert_eq!(instance.listed().await, std::slice::from_ref(&in_b));
    let missing = instance.restore(&own, &in_a).await;
    assert_eq!(missing.status, StatusCode::NOT_FOUND, "{}", missing.body);
    assert_eq!(missing.code(), "backup_not_found");

    instance.name(bucket(&s3, "a")).await;
    assert_eq!(instance.listed().await, std::slice::from_ref(&in_a));
    let missing = instance.restore(&own, &in_b).await;
    assert_eq!(missing.status, StatusCode::NOT_FOUND, "{}", missing.body);
    let restored = instance.restore(&own, &in_a).await;
    assert_eq!(restored.status, StatusCode::OK, "{}", restored.body);
    assert_eq!(
        backups_in(&s3, "b").len(),
        1,
        "a take wrote to the wrong store"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_backup_taken_right_after_the_folder_changes_is_written_to_the_new_folder() {
    let instance = Instance::start().await;
    let parent = TempDir::new().unwrap();
    let (first, second) = (folder_in(&parent, "first"), folder_in(&parent, "second"));
    instance.name(json!({ "backup_path": first })).await;
    let in_first = instance.took().await;
    instance.name(json!({ "backup_path": second })).await;
    let in_second = instance.took().await;

    let own = &instance.app.instance_id;
    assert_eq!(backups_of(&first, own), 1);
    assert_eq!(backups_of(&second, own), 1);
    assert!(
        second
            .join("backups")
            .join(&instance.app.instance_id)
            .join(&in_second)
            .exists()
    );
    assert_eq!(instance.listed().await, [in_second]);
    instance.name(json!({ "backup_path": first })).await;
    assert_eq!(instance.listed().await, [in_first]);
}

async fn unset_with_a_detach_that_fails(operation: Operation, folder: bool) {
    let s3 = FakeS3::start().await;
    let instance = Instance::start().await;
    let parent = TempDir::new().unwrap();
    let (named, unset) = if folder {
        let path = folder_in(&parent, "backups");
        (json!({ "backup_path": path }), json!({ "backup_path": "" }))
    } else {
        (bucket(&s3, "a"), json!({ "object_store_bucket": "" }))
    };
    instance.name(named).await;
    instance.settle().await;
    let before = instance.in_use();
    assert_ne!(before, "disk");

    instance.app.faults.set("fail:stores-record", None).unwrap();
    instance.name(unset).await;
    instance.failed_on("fail:stores-record").await;
    // The detach did not record, so the store stays attached: the settings alone decide.
    assert_eq!(instance.in_use(), before);

    // Armed again, so that any follow the operation made would fail to record as well.
    instance.app.faults.set("fail:stores-record", None).unwrap();
    let refused = instance.run(operation).await;
    assert_eq!(
        refused.status,
        StatusCode::CONFLICT,
        "{operation:?}: {}",
        refused.body
    );
    assert_eq!(refused.code(), "no_backup_destination", "{operation:?}");
    assert_eq!(
        instance.fired("fail:stores-record"),
        0,
        "{operation:?} ran a follow although the settings name no store"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_list_after_a_failed_detach_of_the_object_store_is_no_destination() {
    unset_with_a_detach_that_fails(Operation::List, false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_backup_after_a_failed_detach_of_the_object_store_is_no_destination() {
    unset_with_a_detach_that_fails(Operation::Take, false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_restore_after_a_failed_detach_of_the_object_store_is_no_destination() {
    unset_with_a_detach_that_fails(Operation::Restore, false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_list_after_a_failed_detach_of_the_folder_is_no_destination() {
    unset_with_a_detach_that_fails(Operation::List, true).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_backup_after_a_failed_detach_of_the_folder_is_no_destination() {
    unset_with_a_detach_that_fails(Operation::Take, true).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_restore_after_a_failed_detach_of_the_folder_is_no_destination() {
    unset_with_a_detach_that_fails(Operation::Restore, true).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_adopt_after_a_failed_detach_of_the_folder_is_no_destination() {
    unset_with_a_detach_that_fails(Operation::Adopt, true).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_store_the_settings_no_longer_name_is_refused_at_once_while_an_attach_is_held() {
    let s3 = FakeS3::start().await;
    let instance = Instance::start().await;
    let release = name_while_attaching(&instance, &s3, "held").await;
    instance.name(json!({ "object_store_bucket": "" })).await;

    for operation in [Operation::List, Operation::Take, Operation::Restore] {
        let refused = tokio::time::timeout(Duration::from_secs(2), instance.run(operation))
            .await
            .unwrap_or_else(|_| panic!("{operation:?} waited for the attach"));
        assert_eq!(refused.status, StatusCode::CONFLICT, "{operation:?}");
        assert_eq!(refused.code(), "no_backup_destination", "{operation:?}");
    }
    release.send(()).unwrap();
    instance.settle().await;
    assert_eq!(instance.in_use(), "disk");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_backup_schedule_follows_the_settings_and_not_the_store_in_use() {
    let s3 = FakeS3::start().await;
    let instance = Instance::start_with("3600").await;
    assert!(!backups::scheduled(&instance.app));

    let release = name_while_attaching(&instance, &s3, "named").await;
    assert_eq!(instance.in_use(), "disk");
    assert!(backups::scheduled(&instance.app));
    release.send(()).unwrap();
    instance.settle().await;
    assert!(backups::scheduled(&instance.app));

    instance.name(json!({ "object_store_bucket": "" })).await;
    assert!(!backups::scheduled(&instance.app));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_object_store_that_cannot_be_used_is_a_503_and_is_tried_again_by_the_next_operation() {
    let s3 = FakeS3::start().await;
    let instance = Instance::start().await;
    s3.set_mode(Mode::AllNotFound);
    instance.name(bucket(&s3, "later")).await;

    for operation in [Operation::List, Operation::Take, Operation::Restore] {
        let refused = instance.run(operation).await;
        assert_eq!(
            refused.status,
            StatusCode::SERVICE_UNAVAILABLE,
            "{operation:?}: {}",
            refused.body
        );
        assert_eq!(refused.code(), "blob_store_unavailable", "{operation:?}");
    }
    assert_eq!(instance.in_use(), "disk");

    s3.set_mode(Mode::Normal);
    assert_eq!(instance.listed().await, Vec::<String>::new());
    assert_eq!(instance.in_use(), locator("later"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_follow_that_cannot_record_the_named_store_is_a_503_and_never_a_409() {
    let s3 = FakeS3::start().await;
    let instance = Instance::start().await;
    instance.name(bucket(&s3, "a")).await;
    instance.settle().await;

    instance.app.faults.set("fail:stores-record", None).unwrap();
    instance.name(bucket(&s3, "b")).await;
    instance.failed_on("fail:stores-record").await;

    for operation in [Operation::List, Operation::Take, Operation::Restore] {
        instance.app.faults.set("fail:stores-record", None).unwrap();
        let refused = instance.run(operation).await;
        assert_eq!(
            refused.status,
            StatusCode::SERVICE_UNAVAILABLE,
            "{operation:?}: {}",
            refused.body
        );
        assert_eq!(refused.code(), "blob_store_unavailable", "{operation:?}");
    }
    assert_eq!(instance.in_use(), locator("a"));

    instance.app.faults.clear(None);
    assert_eq!(instance.listed().await, Vec::<String>::new());
    assert_eq!(instance.in_use(), locator("b"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_list_dropped_mid_attach_still_records_and_uses_the_store_together() {
    let s3 = FakeS3::start().await;
    let instance = Instance::start().await;
    let release = name_while_attaching(&instance, &s3, "named").await;
    let asking = tokio::spawn({
        let instance = instance.clone();
        async move { instance.run(Operation::List).await }
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    asking.abort();
    let _ = asking.await;
    release.send(()).unwrap();
    instance.settle().await;

    assert_eq!(instance.in_use(), locator("named"));
    let recorded = instance.send(Method::GET, "/blobs/stores", None).await;
    let attached: Vec<&str> = recorded.body["data"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|store| store["kind"] != "disk" && store["detached_at"].is_null())
        .map(|store| store["locator"].as_str().unwrap())
        .collect();
    assert_eq!(attached, [locator("named")]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn quick_changes_of_the_destination_then_a_list_use_the_last_and_attach_no_middle_store() {
    let s3 = FakeS3::start().await;
    let instance = Instance::start().await;
    let release = name_while_attaching(&instance, &s3, "first").await;
    instance.name(bucket(&s3, "middle")).await;
    instance.name(bucket(&s3, "last")).await;

    let reply =
        answers_once_released(&instance, Operation::List, || release.send(()).unwrap()).await;

    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    assert_eq!(instance.in_use(), locator("last"));
    assert_eq!(s3.requests(&Method::GET, &marker_of("middle")), 0);
    // The witness that the middle store could be attached: named alone, it is.
    instance.name(bucket(&s3, "middle")).await;
    assert_eq!(instance.listed().await, Vec::<String>::new());
    assert_eq!(s3.requests(&Method::GET, &marker_of("middle")), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_adopt_with_no_destination_named_refuses_without_waiting_for_an_attach() {
    let s3 = FakeS3::start().await;
    let instance = Instance::start().await;
    let release = name_while_attaching(&instance, &s3, "held").await;
    let waiting = tokio::time::timeout(Duration::from_millis(300), instance.run(Operation::Adopt));
    assert!(
        waiting.await.is_err(),
        "an adopt answered while a named store was being taken"
    );

    instance.name(json!({ "object_store_bucket": "" })).await;
    let answer =
        tokio::time::timeout(Duration::from_millis(500), instance.run(Operation::Adopt)).await;
    release.send(()).unwrap();
    instance.settle().await;
    let answer = answer.expect("an adopt waited for an attach although the settings name nothing");
    assert_eq!(answer.status, StatusCode::CONFLICT, "{}", answer.body);
    assert_eq!(answer.code(), "no_backup_destination", "{}", answer.body);
}

/// A list whose follow ended before the settings named another store still decides from them.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_list_resumed_after_its_follow_answers_unavailable_for_a_store_named_since() {
    use marfa_server::app::access::Caller;
    use marfa_server::app::refusal::Code;
    use std::task::Poll;

    let s3 = FakeS3::start().await;
    let instance = Instance::start().await;
    let release = name_while_attaching(&instance, &s3, "first").await;
    let caller = Caller::local();
    let mut list = Box::pin(instance.app.list_backups(&caller));
    assert!(futures_util::poll!(list.as_mut()).is_pending());
    instance.name(json!({ "object_store_bucket": "" })).await;
    release.send(()).unwrap();
    instance.settle().await;
    assert_eq!(instance.in_use(), "disk");

    let release = name_while_attaching(&instance, &s3, "last").await;
    let answer = futures_util::poll!(list.as_mut());
    release.send(()).unwrap();
    let answer = match answer {
        Poll::Ready(answer) => answer,
        Poll::Pending => list.await,
    };
    instance.settle().await;
    let refused = answer.expect_err("a list answered from a store the settings no longer name");
    assert_eq!(refused.code, Code::BlobStoreUnavailable, "{refused:?}");
    assert_eq!(instance.listed().await, Vec::<String>::new());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn health_reports_no_destination_once_unset_even_when_the_detach_was_not_recorded() {
    let s3 = FakeS3::start().await;
    let instance = Instance::start().await;
    instance.name(bucket(&s3, "first")).await;
    instance.settle().await;
    let named = instance.send(Method::GET, "/health", None).await;
    assert_eq!(
        named.body["backups"]["destination"], "bucket",
        "{}",
        named.body
    );

    instance.app.faults.set("fail:stores-record", None).unwrap();
    instance.name(json!({ "object_store_bucket": "" })).await;
    instance.failed_on("fail:stores-record").await;
    assert_eq!(instance.in_use(), locator("first"));
    let health = instance.send(Method::GET, "/health", None).await;
    let backups = &health.body["backups"];
    assert_eq!(backups["status"], "off", "{}", health.body);
    assert_eq!(
        backups["reason"], "no_backup_destination",
        "{}",
        health.body
    );
    assert!(backups.get("destination").is_none(), "{}", health.body);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn health_reports_a_named_store_not_in_use_as_unusable_and_never_as_another_store() {
    let s3 = FakeS3::start().await;
    let instance = Instance::start().await;
    instance.name(bucket(&s3, "first")).await;
    instance.settle().await;

    instance.app.faults.set("fail:stores-record", None).unwrap();
    instance.name(bucket(&s3, "second")).await;
    instance.failed_on("fail:stores-record").await;
    assert_eq!(instance.in_use(), locator("first"));
    let health = instance.send(Method::GET, "/health", None).await;
    let backups = &health.body["backups"];
    assert_eq!(backups["status"], "failing", "{}", health.body);
    assert_eq!(backups["reason"], "destination_unusable", "{}", health.body);
    assert!(backups["store_error"].is_string(), "{}", health.body);
    assert!(backups.get("destination").is_none(), "{}", health.body);
}
