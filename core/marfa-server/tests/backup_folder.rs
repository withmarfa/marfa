//! Backups to a folder the owner names: what the folder holds, how a run meets a folder that is
//! gone, full or left half written, and a restore from the folder alone.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Method, Request, StatusCode, header};
use marfa_server::app::App;
use marfa_server::http::{control, public};
use marfa_server::settings::{Accepted, Environment, Settings};
use serde_json::{Value, json};
use tempfile::TempDir;
use tower::ServiceExt;

const DAY_MS: u64 = 24 * 3_600_000;

struct Instance {
    data: TempDir,
    app: Arc<App>,
    public: Router,
    control: Router,
    writer: String,
}

fn settings(data: &Path, folder: &Path, more: &[(&str, &str)]) -> Accepted {
    let database = data.join("marfa.db");
    let blobs = data.join("blobs");
    let socket = data.join("s.sock");
    let blobs_set = more.iter().any(|(name, _)| *name == "MARFA_BLOB_PATH");
    let mut pairs = vec![("MARFA_DATABASE_PATH", database.to_str().unwrap())];
    if !blobs_set {
        pairs.push(("MARFA_BLOB_PATH", blobs.to_str().unwrap()));
    }
    pairs.extend([
        ("MARFA_CONTROL_SOCKET", socket.to_str().unwrap()),
        ("MARFA_BACKUP_PATH", folder.to_str().unwrap()),
        ("MARFA_BACKUP_INTERVAL_SECONDS", "31536000"),
        ("MARFA_TEST_HOOKS", "true"),
        ("MARFA_RATE_LIMIT_ENABLED", "false"),
    ]);
    pairs.extend_from_slice(more);
    Settings::read(Environment::from_pairs(&pairs)).unwrap()
}

impl Instance {
    async fn start(folder: &Path) -> Instance {
        Instance::start_in(TempDir::new().unwrap(), folder).await
    }

    async fn start_in(data: TempDir, folder: &Path) -> Instance {
        let app = App::start(settings(data.path(), folder, &[]))
            .await
            .unwrap();
        let mut instance = Instance {
            public: public(app.clone()),
            control: control(app.clone()),
            app,
            data,
            writer: String::new(),
        };
        let (status, minted) = instance
            .local(
                Method::POST,
                "/keys",
                Some(json!({
                    "label": "writer",
                    "source": format!("writer-{}", uuid::Uuid::now_v7()),
                    "permissions": ["items.purge"],
                    "type_permissions": { "*": "write" },
                })),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{minted}");
        instance.writer = minted["key"].as_str().unwrap().to_string();
        instance
    }

    async fn send(
        &self,
        router: &Router,
        request: axum::http::request::Builder,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let (request, body) = match body {
            Some(body) => (
                request.header(header::CONTENT_TYPE, "application/json"),
                Body::from(body.to_string()),
            ),
            None => (request, Body::empty()),
        };
        let response = router
            .clone()
            .oneshot(request.body(body).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    async fn local(&self, method: Method, path: &str, body: Option<Value>) -> (StatusCode, Value) {
        let request = Request::builder().method(method).uri(path);
        self.send(&self.control, request, body).await
    }

    async fn as_writer(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let request = Request::builder()
            .method(method)
            .uri(path)
            .header(header::AUTHORIZATION, format!("Bearer {}", self.writer));
        self.send(&self.public, request, body).await
    }

    fn id(&self) -> String {
        self.app.instance_id.clone()
    }

    /// Uploads `bytes` and names them in a `core.file` item, leaving replication to its job.
    async fn file(&self, bytes: &[u8]) -> (String, String) {
        let request = Request::builder()
            .method(Method::POST)
            .uri("/blobs")
            .header(header::CONTENT_TYPE, "text/plain")
            .header(header::AUTHORIZATION, format!("Bearer {}", self.writer))
            .body(Body::from(bytes.to_vec()))
            .unwrap();
        let response = self.public.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let uploaded: Value = serde_json::from_slice(&body).unwrap();
        let hash = uploaded["hash"].as_str().unwrap().to_string();
        let (status, made) = self
            .as_writer(
                Method::POST,
                "/items",
                Some(json!({
                    "type": "core.file",
                    "properties": { "blob_ref": hash, "mime_type": "text/plain" },
                })),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{made}");
        (hash, made["item"]["id"].as_str().unwrap().to_string())
    }

    async fn note(&self, title: &str) -> String {
        let (status, made) = self
            .as_writer(
                Method::POST,
                "/items",
                Some(json!({ "type": "core.note", "properties": { "title": title } })),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{made}");
        made["item"]["id"].as_str().unwrap().to_string()
    }

    async fn unname(&self, item: &str) {
        let (status, body) = self
            .as_writer(Method::DELETE, &format!("/items/{item}"), None)
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let (status, body) = self
            .as_writer(Method::POST, &format!("/items/{item}/purge"), None)
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
    }

    async fn back_up(&self) -> (StatusCode, Value) {
        self.local(Method::POST, "/backups", None).await
    }

    async fn health(&self) -> Value {
        let (status, body) = self.local(Method::GET, "/health", None).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        body["backups"].clone()
    }

    async fn run(&self, job: &str) -> Value {
        let (status, body) = self
            .local(Method::POST, &format!("/housekeeping/{job}/run"), None)
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        body
    }

    async fn bytes_of(&self, hash: &str) -> Option<Vec<u8>> {
        let request = Request::builder()
            .method(Method::GET)
            .uri(format!("/blobs/{hash}"))
            .header(header::AUTHORIZATION, format!("Bearer {}", self.writer))
            .body(Body::empty())
            .unwrap();
        let response = self.public.clone().oneshot(request).await.unwrap();
        if response.status() != StatusCode::OK {
            return None;
        }
        Some(
            to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap()
                .to_vec(),
        )
    }

    async fn restore(&self, instance: &str, name: &str) -> (StatusCode, Value) {
        self.local(
            Method::POST,
            &format!("/backups/{instance}/{name}/restore"),
            None,
        )
        .await
    }
}

/// Where a files area under `folder` keeps `hash`; with no instance, the disk store at `folder`.
fn copy_of(folder: &Path, instance: &str, hash: &str) -> PathBuf {
    let hex = hash.trim_start_matches("sha256:");
    let area = match instance {
        "" => folder.to_path_buf(),
        instance => folder.join("files").join(instance),
    };
    area.join(&hex[0..4]).join(hex)
}

/// The manifest of the backup file at `path`, its tar's first entry.
fn manifest_of(path: &Path) -> Value {
    let tar = fs::read(path).unwrap();
    assert_eq!(&tar[..13], b"manifest.json");
    let octal = String::from_utf8_lossy(&tar[124..136]);
    let size =
        usize::from_str_radix(octal.trim_matches(|c: char| c == '\0' || c == ' '), 8).unwrap();
    serde_json::from_slice(&tar[512..512 + size]).unwrap()
}

fn names_in(folder: &Path) -> Vec<String> {
    let mut names: Vec<String> = match fs::read_dir(folder) {
        Ok(entries) => entries
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect(),
        Err(_) => Vec::new(),
    };
    names.sort();
    names
}

#[tokio::test]
async fn a_backup_holds_each_file_once_and_restores_whole_into_a_fresh_install_elsewhere() {
    let folder = TempDir::new().unwrap();
    let origin = Instance::start(folder.path()).await;
    let note = origin.note("kept in the folder").await;
    let (replicated, _) = origin.file(b"a file replication copied first").await;
    origin.run("blob-replicate").await;
    assert!(copy_of(folder.path(), &origin.id(), &replicated).is_file());
    let (kept, file_item) = origin.file(b"a file the backup copies itself").await;
    assert!(!copy_of(folder.path(), &origin.id(), &kept).exists());

    let (status, body) = origin.back_up().await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let name = body["backup"]["name"].as_str().unwrap().to_string();
    let own = folder.path().join("backups").join(origin.id());
    assert_eq!(names_in(&own), std::slice::from_ref(&name));
    for (hash, bytes) in [
        (&kept, &b"a file the backup copies itself"[..]),
        (&replicated, &b"a file replication copied first"[..]),
    ] {
        assert_eq!(
            fs::read(copy_of(folder.path(), &origin.id(), hash)).unwrap(),
            bytes
        );
    }
    let health = origin.health().await;
    assert_eq!(health["status"], "ok", "{health}");
    assert_eq!(health["destination"], "folder", "{health}");

    // A second backup copies nothing again.
    let (status, body) = origin.back_up().await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let area = folder.path().join("files").join(origin.id());
    let copies: usize = names_in(&area)
        .iter()
        .filter(|name| name.len() == 4)
        .map(|shard| names_in(&area.join(shard)).len())
        .sum();
    assert_eq!(copies, 2);

    let fresh = Instance::start(folder.path()).await;
    assert_ne!(fresh.id(), origin.id());
    let (status, listed) = fresh.local(Method::GET, "/backups", None).await;
    assert_eq!(status, StatusCode::OK, "{listed}");
    assert!(
        listed["data"]
            .as_array()
            .unwrap()
            .iter()
            .any(|backup| backup["name"] == name.as_str() && backup["instance_id"] == origin.id()),
        "{listed}"
    );
    let origin_id = origin.id();
    drop(origin);
    let (status, answer) = fresh.restore(&origin_id, &name).await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    assert_eq!(answer["blobs_missing"], json!([]), "{answer}");
    for item in [&note, &file_item] {
        let (status, body) = fresh
            .as_writer(Method::GET, &format!("/items/{item}"), None)
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
    }
    assert_eq!(
        fresh.bytes_of(&kept).await.unwrap(),
        b"a file the backup copies itself"
    );
    assert_eq!(
        fresh.bytes_of(&replicated).await.unwrap(),
        b"a file replication copied first"
    );
}

#[tokio::test]
async fn a_folder_gone_at_a_run_fails_it_without_making_it_and_the_next_run_once_it_is_back_succeeds()
 {
    let parent = TempDir::new().unwrap();
    let folder = parent.path().join("disk");
    fs::create_dir(&folder).unwrap();
    let instance = Instance::start(&folder).await;
    instance.note("before the disk went").await;

    let away = parent.path().join("away");
    fs::rename(&folder, &away).unwrap();
    let (status, body) = instance.back_up().await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
    assert!(!folder.exists());
    let health = instance.health().await;
    assert_eq!(health["status"], "failing", "{health}");
    assert_eq!(health["failures"], 1, "{health}");

    // An empty mount point is not the folder either, and nothing is made in it.
    fs::create_dir(&folder).unwrap();
    let (status, body) = instance.back_up().await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
    assert!(names_in(&folder).is_empty());
    let replicated = instance.run("blob-replicate").await;
    assert_eq!(replicated["result"]["copied"], 0, "{replicated}");
    assert!(names_in(&folder).is_empty());

    fs::remove_dir(&folder).unwrap();
    fs::rename(&away, &folder).unwrap();
    let (status, body) = instance.back_up().await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let health = instance.health().await;
    assert_eq!(health["status"], "ok", "{health}");
    assert_eq!(health["failures"], 0, "{health}");
}

#[tokio::test]
async fn a_full_disk_mid_archive_or_mid_file_leaves_nothing_half_written_and_the_next_run_succeeds()
{
    let folder = TempDir::new().unwrap();
    let instance = Instance::start(folder.path()).await;
    instance.note("a note").await;
    let own = folder.path().join("backups").join(instance.id());
    let tmp = folder.path().join("files").join(instance.id()).join("tmp");

    instance
        .app
        .faults
        .set("fail:backup-folder-write", None)
        .unwrap();
    let (status, body) = instance.back_up().await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
    assert!(
        body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("No space left on device"),
        "{body}"
    );
    assert!(names_in(&own).is_empty(), "{:?}", names_in(&own));
    assert_eq!(instance.health().await["status"], "failing");

    let (file, _) = instance
        .file(&b"a file larger than one chunk ".repeat(20_000))
        .await;
    instance.app.faults.clear(None);
    instance
        .app
        .faults
        .set("fail:backup-folder-write", Some("1"))
        .unwrap();
    let (status, body) = instance.back_up().await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
    assert!(
        body["error"]["message"].as_str().unwrap().contains(&file),
        "{body}"
    );
    assert!(names_in(&own).is_empty(), "{:?}", names_in(&own));
    // The staged copy goes on a blocking task once its write fails.
    for _ in 0..100 {
        if names_in(&tmp).is_empty() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    assert!(names_in(&tmp).is_empty(), "{:?}", names_in(&tmp));
    assert!(!copy_of(folder.path(), &instance.id(), &file).exists());
    assert_eq!(instance.health().await["failures"], 2);

    instance.app.faults.clear(None);
    let (status, body) = instance.back_up().await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(names_in(&own).len(), 1);
    assert!(copy_of(folder.path(), &instance.id(), &file).is_file());
    assert_eq!(instance.health().await["status"], "ok");
}

#[tokio::test]
async fn what_a_process_that_ended_left_half_written_is_cleared_by_the_next_run_and_never_listed() {
    let folder = TempDir::new().unwrap();
    let instance = Instance::start(folder.path()).await;
    let (status, body) = instance.back_up().await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let name = body["backup"]["name"].as_str().unwrap().to_string();
    let own = folder.path().join("backups").join(instance.id());
    let tmp = folder.path().join("files").join(instance.id()).join("tmp");
    let left = format!(".{name}.0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b.partial");
    fs::write(own.join(&left), b"half a backup").unwrap();
    let staged = uuid::Uuid::new_v7(uuid::Timestamp::from_unix(
        uuid::NoContext,
        1_700_000_000,
        0,
    ));
    fs::write(tmp.join(staged.to_string()), b"half a file").unwrap();

    let (status, listed) = instance.local(Method::GET, "/backups", None).await;
    assert_eq!(status, StatusCode::OK, "{listed}");
    assert_eq!(listed["data"].as_array().unwrap().len(), 1, "{listed}");

    instance.note("a change").await;
    let (status, body) = instance.back_up().await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(!own.join(&left).exists());
    assert!(names_in(&tmp).is_empty(), "{:?}", names_in(&tmp));
    assert_eq!(names_in(&own).len(), 2);
}

#[tokio::test]
async fn a_backup_being_written_is_never_listed_until_it_is_whole() {
    let folder = TempDir::new().unwrap();
    let instance = Arc::new(Instance::start(folder.path()).await);
    instance.note("a note").await;
    instance.app.faults.set("hold:backup:put", None).unwrap();
    let running = instance.clone();
    let run = tokio::spawn(async move { running.back_up().await });
    let began = std::time::Instant::now();
    while !instance
        .app
        .faults
        .list()
        .iter()
        .any(|fault| fault.waiting > 0)
    {
        assert!(began.elapsed() < std::time::Duration::from_secs(10));
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    let own = folder.path().join("backups").join(instance.id());
    let written = names_in(&own);
    assert_eq!(written.len(), 1, "{written:?}");
    assert!(written[0].starts_with('.'), "{written:?}");
    let (status, listed) = instance.local(Method::GET, "/backups", None).await;
    assert_eq!(status, StatusCode::OK, "{listed}");
    assert_eq!(listed["data"], json!([]), "{listed}");

    instance.app.faults.clear(Some("hold:backup:put"));
    let (status, body) = run.await.unwrap();
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        names_in(&own),
        [body["backup"]["name"].as_str().unwrap().to_string()]
    );
}

#[tokio::test]
async fn a_restore_missing_a_files_copy_names_it_and_restores_nothing() {
    let folder = TempDir::new().unwrap();
    let origin = Instance::start(folder.path()).await;
    let note = origin.note("not restored alone").await;
    let (lost, _) = origin.file(b"a copy someone deleted").await;
    let (status, body) = origin.back_up().await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let name = body["backup"]["name"].as_str().unwrap().to_string();
    let origin_id = origin.id();
    fs::remove_file(copy_of(folder.path(), &origin_id, &lost)).unwrap();
    drop(origin);

    let fresh = Instance::start(folder.path()).await;
    let (status, refused) = fresh.restore(&origin_id, &name).await;
    assert_eq!(status, StatusCode::CONFLICT, "{refused}");
    assert_eq!(
        refused["error"]["code"], "backup_files_missing",
        "{refused}"
    );
    assert_eq!(
        refused["error"]["details"]["missing_blobs"],
        json!([lost]),
        "{refused}"
    );
    assert!(
        refused["error"]["message"]
            .as_str()
            .unwrap()
            .contains(&lost),
        "{refused}"
    );
    let (status, body) = fresh
        .as_writer(Method::GET, &format!("/items/{note}"), None)
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
}

#[tokio::test]
async fn a_file_deleted_after_a_backup_named_it_stays_in_the_folder_until_thinning_drops_that_backup()
 {
    let folder = TempDir::new().unwrap();
    let instance = Instance::start(folder.path()).await;
    let (status, body) = instance
        .local(
            Method::PATCH,
            "/config",
            Some(json!({ "blob_cleanup_grace_seconds": 0 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (file, item) = instance.file(b"named only by the first backup").await;
    let (status, body) = instance.back_up().await;
    assert_eq!(status, StatusCode::OK, "{body}");
    instance.unname(&item).await;
    let copy = copy_of(folder.path(), &instance.id(), &file);

    let on_disk = copy_of(&instance.data.path().join("blobs"), "", &file);
    for _ in 0..2 {
        instance.run("blob-orphans").await;
    }
    assert!(copy.is_file());
    assert!(on_disk.is_file());

    instance.app.clock.pause(true);
    instance.app.clock.advance(40 * DAY_MS).unwrap();
    let (status, body) = instance.back_up().await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["removed"], 1, "{body}");
    for _ in 0..2 {
        instance.run("blob-orphans").await;
    }
    assert!(!copy.exists());
    assert!(!on_disk.exists());
}

#[tokio::test]
async fn a_recorded_folder_missing_at_start_leaves_the_start_alone_and_fails_each_backup() {
    let parent = TempDir::new().unwrap();
    let folder = parent.path().join("disk");
    fs::create_dir(&folder).unwrap();
    let first = Instance::start(&folder).await;
    let (status, body) = first.back_up().await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let Instance { data, .. } = first;

    let away = parent.path().join("away");
    fs::rename(&folder, &away).unwrap();
    let again = Instance::start_in(data, &folder).await;
    let (status, body) = again.back_up().await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
    assert!(!folder.exists());
    assert_eq!(again.health().await["status"], "failing");

    fs::rename(&away, &folder).unwrap();
    let (status, body) = again.back_up().await;
    assert_eq!(status, StatusCode::OK, "{body}");
}

#[tokio::test]
async fn the_server_refuses_to_start_with_both_destinations_or_a_folder_it_would_lose_or_cannot_find()
 {
    let data = TempDir::new().unwrap();
    let elsewhere = TempDir::new().unwrap();
    let both = Settings::read(Environment::from_pairs(&[
        ("MARFA_BACKUP_PATH", elsewhere.path().to_str().unwrap()),
        ("S3_BUCKET", "bucket"),
    ]));
    let refused = both.err().unwrap().lines.join("\n");
    assert!(
        refused.contains("S3_BUCKET") && refused.contains("MARFA_BACKUP_PATH"),
        "{refused}"
    );
    let relative = Settings::read(Environment::from_pairs(&[("MARFA_BACKUP_PATH", "backups")]));
    assert!(relative.is_err());

    let inside = data.path().join("backups");
    fs::create_dir_all(&inside).unwrap();
    let refused = App::start(settings(data.path(), &inside, &[]))
        .await
        .err()
        .unwrap()
        .message;
    assert!(refused.contains("inside the data directory"), "{refused}");

    let blobs = elsewhere.path().join("blobs");
    let inside = blobs.join("backups");
    fs::create_dir_all(&inside).unwrap();
    let refused = App::start(settings(
        data.path(),
        &inside,
        &[("MARFA_BLOB_PATH", blobs.to_str().unwrap())],
    ))
    .await
    .err()
    .unwrap()
    .message;
    assert!(refused.contains("inside the blob folder"), "{refused}");

    let missing = elsewhere.path().join("not mounted");
    let refused = App::start(settings(data.path(), &missing, &[]))
        .await
        .err()
        .unwrap()
        .message;
    assert!(refused.contains("does not exist"), "{refused}");
    assert!(!missing.exists());
}

#[tokio::test]
async fn a_file_no_store_can_read_is_recorded_lost_and_the_backup_still_goes_ahead() {
    let folder = TempDir::new().unwrap();
    let origin = Instance::start(folder.path()).await;
    let note = origin.note("backed up beside a lost file").await;
    let (lost, _) = origin.file(b"a file whose only copy went").await;
    let (kept, _) = origin.file(b"a file still on the disk").await;
    origin.app.faults.set("lose:blob", Some(&lost)).unwrap();

    let (status, body) = origin.back_up().await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["outcome"], "put", "{body}");
    assert_eq!(body["blobs_lost"], json!([lost]), "{body}");
    let name = body["backup"]["name"].as_str().unwrap().to_string();
    let file = folder.path().join("backups").join(origin.id()).join(&name);
    let manifest = manifest_of(&file);
    assert_eq!(manifest["file_count"], 2, "{manifest}");
    let files = files_listed(&fs::read(&file).unwrap());
    assert_eq!(listed(&files, &lost)["state"], "lost", "{files:?}");
    assert_eq!(listed(&files, &kept)["state"], "not_carried", "{files:?}");
    assert!(copy_of(folder.path(), &origin.id(), &kept).is_file());
    assert!(!copy_of(folder.path(), &origin.id(), &lost).exists());
    let health = origin.health().await;
    assert_eq!(health["status"], "failing", "{health}");
    assert_eq!(health["last_backup"], name.as_str(), "{health}");
    assert!(
        health["last_error"].as_str().unwrap().contains(&lost),
        "{health}"
    );

    let fresh = Instance::start(folder.path()).await;
    let (status, answer) = fresh.restore(&origin.id(), &name).await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    assert_eq!(answer["blobs_missing"], json!([lost]), "{answer}");
    let (status, body) = fresh
        .as_writer(Method::GET, &format!("/items/{note}"), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        fresh.bytes_of(&kept).await.unwrap(),
        b"a file still on the disk"
    );

    origin.app.faults.clear(None);
    let (status, body) = origin.back_up().await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["blobs_lost"], json!([]), "{body}");
    assert!(copy_of(folder.path(), &origin.id(), &lost).is_file());
    assert_eq!(origin.health().await["status"], "ok");
}

#[tokio::test]
async fn a_read_that_fails_is_not_a_lost_file_but_an_altered_copy_is() {
    let folder = TempDir::new().unwrap();
    let origin = Instance::start(folder.path()).await;
    let (unread, _) = origin.file(b"a file the disk cannot read just now").await;
    origin
        .app
        .faults
        .set("damage:blob-unreadable", Some(&unread))
        .unwrap();
    let (status, body) = origin.back_up().await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
    assert!(
        body["error"]["message"].as_str().unwrap().contains(&unread),
        "{body}"
    );
    let backups = folder.path().join("backups").join(origin.id());
    assert!(names_in(&backups).is_empty());
    origin.app.faults.clear(None);

    let (altered, _) = origin.file(b"a file whose only copy changed").await;
    origin
        .app
        .faults
        .set("damage:blob", Some(&altered))
        .unwrap();
    let (status, body) = origin.back_up().await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["blobs_lost"], json!([altered]), "{body}");
    assert!(copy_of(folder.path(), &origin.id(), &unread).is_file());
    assert!(!copy_of(folder.path(), &origin.id(), &altered).exists());
}

#[tokio::test]
async fn a_restore_that_lacks_a_copy_refuses_before_it_reads_any_file() {
    let folder = TempDir::new().unwrap();
    let origin = Instance::start(folder.path()).await;
    let (gone, _) = origin.file(b"a copy someone deleted").await;
    let (other, _) = origin.file(b"a copy still in the folder").await;
    let (status, body) = origin.back_up().await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let name = body["backup"]["name"].as_str().unwrap().to_string();
    fs::remove_file(copy_of(folder.path(), &origin.id(), &gone)).unwrap();

    let fresh = Instance::start(folder.path()).await;
    let (status, refused) = fresh.restore(&origin.id(), &name).await;
    assert_eq!(status, StatusCode::CONFLICT, "{refused}");
    assert_eq!(
        refused["error"]["details"]["missing_blobs"],
        json!([gone]),
        "{refused}"
    );
    let blobs = fresh.data.path().join("blobs");
    assert!(!copy_of(&blobs, "", &other).exists());
    // The refused archive's spool is removed after the answer.
    let tmp = blobs.join("tmp");
    for _ in 0..250 {
        if names_in(&tmp).is_empty() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    assert_eq!(names_in(&tmp), Vec::<String>::new());
}

#[tokio::test]
async fn a_restore_that_meets_a_copy_altered_to_the_same_size_names_it_and_places_nothing() {
    let folder = TempDir::new().unwrap();
    let origin = Instance::start(folder.path()).await;
    let note = origin.note("not restored past an altered copy").await;
    let (altered, _) = origin.file(b"a copy someone changed").await;
    let (other, _) = origin.file(b"a copy still whole").await;
    let (status, body) = origin.back_up().await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let name = body["backup"]["name"].as_str().unwrap().to_string();
    let copy = copy_of(folder.path(), &origin.id(), &altered);
    let mut bytes = fs::read(&copy).unwrap();
    bytes[0] ^= 0xff;
    fs::write(&copy, &bytes).unwrap();

    let fresh = Instance::start(folder.path()).await;
    let (status, refused) = fresh.restore(&origin.id(), &name).await;
    assert_eq!(status, StatusCode::CONFLICT, "{refused}");
    assert_eq!(
        refused["error"]["code"], "backup_files_missing",
        "{refused}"
    );
    assert_eq!(
        refused["error"]["details"]["missing_blobs"],
        json!([altered]),
        "{refused}"
    );
    let blobs = fresh.data.path().join("blobs");
    assert!(copy_of(folder.path(), &origin.id(), &other).is_file());
    assert!(!copy_of(&blobs, "", &other).exists());
    assert!(!copy_of(&blobs, "", &altered).exists());
    assert!(fresh.bytes_of(&other).await.is_none());
    let (status, body) = fresh
        .as_writer(Method::GET, &format!("/items/{note}"), None)
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
}

#[tokio::test]
async fn a_rollback_reads_only_the_files_the_disk_lacks_and_needs_room_only_for_them() {
    let folder = TempDir::new().unwrap();
    let instance = Instance::start(folder.path()).await;
    let (status, body) = instance
        .local(
            Method::PATCH,
            "/config",
            Some(json!({ "disk_reserve_bytes": 100_000 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let big = vec![b'x'; 1_000_000];
    let (held, _) = instance.file(&big).await;
    let (status, body) = instance.back_up().await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let name = body["backup"]["name"].as_str().unwrap().to_string();

    instance
        .app
        .faults
        .set("free:blobs", Some("300000"))
        .unwrap();
    let (status, answer) = instance.restore(&instance.id(), &name).await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    assert_eq!(answer["blobs_missing"], json!([]), "{answer}");
    assert_eq!(instance.bytes_of(&held).await.unwrap(), big);
}

#[tokio::test]
async fn a_replaced_disk_is_refused_until_the_owner_adopts_it_and_then_backs_up_afresh() {
    let parent = TempDir::new().unwrap();
    let folder = parent.path().join("disk");
    fs::create_dir(&folder).unwrap();
    let instance = Instance::start(&folder).await;
    let (file, _) = instance.file(b"a file the old disk held").await;
    let (status, body) = instance.back_up().await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, stores) = instance.local(Method::GET, "/blobs/stores", None).await;
    assert_eq!(status, StatusCode::OK, "{stores}");
    let old = stores["data"]
        .as_array()
        .unwrap()
        .iter()
        .find(|store| store["kind"] == "folder")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();

    let (status, refused) = instance
        .local(Method::POST, "/backups/folder/adopt", None)
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{refused}");

    fs::rename(&folder, parent.path().join("old disk")).unwrap();
    let (status, refused) = instance
        .local(Method::POST, "/backups/folder/adopt", None)
        .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{refused}");
    assert!(!folder.exists());

    fs::create_dir(&folder).unwrap();
    let (status, refused) = instance.back_up().await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{refused}");
    let says = refused["error"]["message"].as_str().unwrap();
    assert!(says.contains("marfa backups folder adopt"), "{refused}");
    let health = instance.health().await;
    assert!(
        health["last_error"]
            .as_str()
            .unwrap()
            .contains("marfa backups folder adopt"),
        "{health}"
    );

    let (status, adopted) = instance
        .local(Method::POST, "/backups/folder/adopt", None)
        .await;
    assert_eq!(status, StatusCode::OK, "{adopted}");
    assert_eq!(adopted["replaced_store_id"], old.as_str(), "{adopted}");
    assert_eq!(adopted["backups_forgotten"], 1, "{adopted}");
    let new = adopted["store_id"].as_str().unwrap().to_string();
    assert_ne!(new, old);
    let (_, stores) = instance.local(Method::GET, "/blobs/stores", None).await;
    let of = |id: &str| {
        stores["data"]
            .as_array()
            .unwrap()
            .iter()
            .find(|store| store["id"] == id)
            .cloned()
            .unwrap()
    };
    assert!(of(&old)["detached_at"].is_string(), "{stores}");
    assert!(of(&new)["detached_at"].is_null(), "{stores}");
    assert_eq!(of(&new)["locator"], of(&old)["locator"], "{stores}");
    let (status, copies) = instance
        .local(Method::GET, &format!("/blobs/{file}/copies"), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{copies}");
    assert!(
        copies["data"]
            .as_array()
            .unwrap()
            .iter()
            .all(|copy| copy["store_id"] != old.as_str()),
        "{copies}"
    );
    assert_eq!(
        instance.bytes_of(&file).await.unwrap(),
        b"a file the old disk held"
    );

    let (status, body) = instance.back_up().await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(copy_of(&folder, &instance.id(), &file).is_file());
    assert_eq!(instance.health().await["status"], "ok");

    let Instance { data, .. } = instance;
    let again = Instance::start_in(data, &folder).await;
    let (status, body) = again.back_up().await;
    assert_eq!(status, StatusCode::OK, "{body}");
}

#[tokio::test]
async fn an_adopt_that_cannot_mark_the_folder_says_the_old_store_was_forgotten_and_adopts_once_it_is_writable()
 {
    use std::os::unix::fs::PermissionsExt;

    let parent = TempDir::new().unwrap();
    let folder = parent.path().join("disk");
    fs::create_dir(&folder).unwrap();
    let instance = Instance::start(&folder).await;
    let (file, _) = instance.file(b"a file the old disk held").await;
    let (status, body) = instance.back_up().await;
    assert_eq!(status, StatusCode::OK, "{body}");
    fs::rename(&folder, parent.path().join("old disk")).unwrap();
    fs::create_dir(&folder).unwrap();
    fs::set_permissions(&folder, fs::Permissions::from_mode(0o555)).unwrap();

    let (status, refused) = instance
        .local(Method::POST, "/backups/folder/adopt", None)
        .await;
    fs::set_permissions(&folder, fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{refused}");
    assert_eq!(
        refused["error"]["code"], "blob_store_unavailable",
        "{refused}"
    );
    let says = refused["error"]["message"].as_str().unwrap();
    assert!(says.contains("were forgotten"), "{refused}");
    assert!(says.contains("writable"), "{refused}");
    assert!(says.contains("marfa backups folder adopt"), "{refused}");
    assert!(!says.contains("is not there"), "{refused}");

    let (status, adopted) = instance
        .local(Method::POST, "/backups/folder/adopt", None)
        .await;
    assert_eq!(status, StatusCode::OK, "{adopted}");
    assert_eq!(adopted["backups_forgotten"], 0, "{adopted}");
    let (status, body) = instance.back_up().await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(copy_of(&folder, &instance.id(), &file).is_file());
}

impl Instance {
    /// The attention entries of kind `backup`, by reference.
    async fn backup_concerns(&self) -> Vec<Value> {
        let (status, body) = self.local(Method::GET, "/attention", None).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        body["data"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|concern| concern["kind"] == "backup")
            .cloned()
            .collect()
    }

    async fn backup_references(&self) -> Vec<String> {
        self.backup_concerns()
            .await
            .iter()
            .map(|concern| concern["reference"].as_str().unwrap().to_string())
            .collect()
    }

    async fn attention_kinds(&self) -> Vec<String> {
        let (_, body) = self.local(Method::GET, "/attention", None).await;
        body["data"]
            .as_array()
            .unwrap()
            .iter()
            .map(|concern| concern["kind"].as_str().unwrap().to_string())
            .collect()
    }
}

#[tokio::test]
async fn a_folder_whose_disk_goes_away_is_said_at_once_with_the_files_that_wait_and_clears_once_it_is_back()
 {
    let parent = TempDir::new().unwrap();
    let folder = parent.path().join("disk");
    fs::create_dir(&folder).unwrap();
    let instance = Instance::start(&folder).await;
    let (file, _) = instance.file(b"a file waiting for its second copy").await;

    let health = instance.health().await;
    assert_eq!(health["status"], "ok", "{health}");
    assert_eq!(health["store_error"], Value::Null, "{health}");
    assert!(instance.backup_concerns().await.is_empty());

    let away = parent.path().join("away");
    fs::rename(&folder, &away).unwrap();
    let health = instance.health().await;
    assert_eq!(health["status"], "failing", "{health}");
    assert!(
        health["store_error"]
            .as_str()
            .unwrap()
            .contains("is not there"),
        "{health}"
    );
    let concerns = instance.backup_concerns().await;
    assert_eq!(concerns.len(), 1, "{concerns:?}");
    assert_eq!(concerns[0]["reference"], "store");
    assert_eq!(concerns[0]["title"], "The backup folder is not there");

    // A backup run that fails for the same folder is part of the same entry.
    let (status, body) = instance.back_up().await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
    assert_eq!(instance.backup_references().await, ["store"]);
    let concerns = instance.backup_concerns().await;
    assert!(
        concerns[0]["description"]
            .as_str()
            .unwrap()
            .contains("The last backup run failed too."),
        "{concerns:?}"
    );

    let replicated = instance.run("blob-replicate").await;
    assert_eq!(replicated["outcome"], "error", "{replicated}");
    assert_eq!(replicated["result"]["copied"], 0, "{replicated}");
    assert_eq!(replicated["result"]["remaining"], 1, "{replicated}");
    let health = instance.health().await;
    assert_eq!(health["copies_waiting"], 1, "{health}");
    let concerns = instance.backup_concerns().await;
    assert!(
        concerns[0]["description"]
            .as_str()
            .unwrap()
            .contains("1 file waits for its second copy"),
        "{concerns:?}"
    );
    assert!(
        !instance
            .attention_kinds()
            .await
            .contains(&"job".to_string()),
        "the failed replication is told once"
    );
    let (status, body) = instance.local(Method::GET, "/health", None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["status"], "degraded", "{body}");

    fs::rename(&away, &folder).unwrap();
    let replicated = instance.run("blob-replicate").await;
    assert_eq!(replicated["outcome"], "ok", "{replicated}");
    assert_eq!(replicated["result"]["remaining"], 0, "{replicated}");
    assert!(copy_of(&folder, &instance.id(), &file).is_file());
    let health = instance.health().await;
    assert_eq!(health["store_error"], Value::Null, "{health}");
    assert_eq!(health["copies_waiting"], 0, "{health}");
    // The folder answers again, so the failed run is told as its own entry until one is put.
    assert_eq!(instance.backup_references().await, ["run"]);
    let (status, body) = instance.back_up().await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let health = instance.health().await;
    assert_eq!(health["status"], "ok", "{health}");
    assert!(instance.backup_concerns().await.is_empty());
}

#[tokio::test]
async fn a_files_area_that_comes_back_without_its_staging_folder_takes_the_waiting_copy_in_the_next_run()
 {
    let parent = TempDir::new().unwrap();
    let folder = parent.path().join("disk");
    fs::create_dir(&folder).unwrap();
    let instance = Instance::start(&folder).await;
    instance.file(b"a file made before the disk went").await;

    let away = parent.path().join("away");
    fs::rename(&folder, &away).unwrap();
    let (waiting, _) = instance.file(b"a file made while the disk was away").await;
    let replicated = instance.run("blob-replicate").await;
    assert_eq!(replicated["outcome"], "error", "{replicated}");

    // The disk returns with its files area intact but its staging folder gone.
    fs::rename(&away, &folder).unwrap();
    let staging = folder.join("files").join(instance.id()).join("tmp");
    fs::remove_dir(&staging).unwrap();

    let replicated = instance.run("blob-replicate").await;
    assert_eq!(replicated["outcome"], "ok", "{replicated}");
    assert_eq!(replicated["result"]["remaining"], 0, "{replicated}");
    assert!(copy_of(&folder, &instance.id(), &waiting).is_file());
    let health = instance.health().await;
    assert_eq!(health["store_error"], Value::Null, "{health}");
    assert_eq!(health["copies_waiting"], 0, "{health}");
    assert!(staging.is_dir());
}

#[cfg(debug_assertions)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_folder_whose_mount_hangs_is_told_as_not_answering_within_the_health_deadline() {
    let folder = TempDir::new().unwrap();
    let instance = Instance::start(folder.path()).await;
    instance.app.faults.set("hold:disk-probe", None).unwrap();
    let began = std::time::Instant::now();
    let health = instance.health().await;
    assert!(began.elapsed() < std::time::Duration::from_millis(2_900));
    assert_eq!(health["status"], "failing", "{health}");
    assert!(
        health["store_error"]
            .as_str()
            .unwrap()
            .contains("did not answer in time"),
        "{health}"
    );
    let concerns = instance.backup_concerns().await;
    assert_eq!(concerns.len(), 1, "{concerns:?}");
    assert_eq!(concerns[0]["title"], "The backup folder is not answering");

    // The witness: once the mount answers, the same folder is quiet again.
    instance.app.faults.clear(Some("hold:disk-probe"));
    let mut quiet = false;
    for _ in 0..50 {
        if instance.health().await["store_error"].is_null() {
            quiet = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    assert!(quiet, "the folder was never told as answering again");
}

#[tokio::test]
async fn a_folder_with_nothing_waiting_and_a_clean_backup_says_nothing_in_attention() {
    let folder = TempDir::new().unwrap();
    let instance = Instance::start(folder.path()).await;
    instance.file(b"copied").await;
    let (status, body) = instance.back_up().await;
    assert_eq!(status, StatusCode::OK, "{body}");
    instance.run("blob-replicate").await;
    let health = instance.health().await;
    assert_eq!(health["status"], "ok", "{health}");
    assert!(instance.attention_kinds().await.is_empty());
}

#[tokio::test]
async fn a_backup_taken_by_hand_that_failed_is_in_attention_until_the_next_one_is_put() {
    let parent = TempDir::new().unwrap();
    let folder = parent.path().join("disk");
    fs::create_dir(&folder).unwrap();
    let instance = Instance::start(&folder).await;
    instance.note("kept").await;

    let away = parent.path().join("away");
    fs::rename(&folder, &away).unwrap();
    let (status, body) = instance.back_up().await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
    // While the folder is gone the failed run and the folder are one fault, told once.
    assert_eq!(instance.backup_references().await, ["store"]);

    // Once it answers, the failed run stands on its own until a later one is put.
    fs::rename(&away, &folder).unwrap();
    assert_eq!(instance.backup_references().await, ["run"]);
    let (status, body) = instance.back_up().await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(instance.backup_concerns().await.is_empty());
}

#[tokio::test]
async fn a_backup_that_lost_a_file_is_in_attention_as_a_run_that_lost_files() {
    let folder = TempDir::new().unwrap();
    let instance = Instance::start(folder.path()).await;
    let (file, _) = instance.file(b"a file every store loses").await;
    for path in [
        copy_of(&instance.data.path().join("blobs"), "", &file),
        copy_of(folder.path(), &instance.id(), &file),
    ] {
        let _ = fs::remove_file(path);
    }
    let (status, body) = instance.back_up().await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let concerns = instance.backup_concerns().await;
    assert_eq!(concerns.len(), 1, "{concerns:?}");
    assert_eq!(concerns[0]["reference"], "run");
    assert!(
        concerns[0]["description"]
            .as_str()
            .unwrap()
            .contains("without 1 file"),
        "{concerns:?}"
    );
}

#[tokio::test]
async fn backups_turned_off_by_interval_are_told_apart_from_having_no_destination() {
    let folder = TempDir::new().unwrap();
    let data = TempDir::new().unwrap();
    let app = App::start(settings(
        data.path(),
        folder.path(),
        &[("MARFA_BACKUP_INTERVAL_SECONDS", "0")],
    ))
    .await
    .unwrap();
    let instance = Instance {
        public: public(app.clone()),
        control: control(app.clone()),
        app,
        data,
        writer: String::new(),
    };
    let health = instance.health().await;
    assert_eq!(health["status"], "off", "{health}");
    assert_eq!(health["reason"], "turned_off", "{health}");
    assert_eq!(health["destination"], "folder", "{health}");
    let concerns = instance.backup_concerns().await;
    assert_eq!(concerns.len(), 1, "{concerns:?}");
    assert_eq!(concerns[0]["reference"], "turned_off");
    assert_eq!(concerns[0]["title"], "Scheduled backups are turned off");
}

/// The lines of the archive's `files.ndjson.gz`, which follows its manifest.
fn files_listed(tar: &[u8]) -> Vec<Value> {
    use std::io::Read;
    let mut at = 0;
    loop {
        let block = &tar[at..at + 512];
        let end = block[..100].iter().position(|byte| *byte == 0).unwrap_or(100);
        let octal = String::from_utf8_lossy(&block[124..136]);
        let size =
            usize::from_str_radix(octal.trim_matches(|c: char| c == '\0' || c == ' '), 8).unwrap();
        if &block[..end] == b"files.ndjson.gz" {
            let mut text = String::new();
            flate2::read::GzDecoder::new(&tar[at + 512..at + 512 + size])
                .read_to_string(&mut text)
                .unwrap();
            return text.lines().map(|line| serde_json::from_str(line).unwrap()).collect();
        }
        at += 512 + size.div_ceil(512) * 512;
    }
}

fn listed<'a>(files: &'a [Value], hash: &str) -> &'a Value {
    files.iter().find(|line| line["hash"] == hash).unwrap()
}
