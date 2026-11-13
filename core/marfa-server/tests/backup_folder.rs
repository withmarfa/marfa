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
        let app = App::start(settings(data.path(), folder, &[])).await.unwrap();
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
    let (kept, file_item) = origin.file(b"a file the backup copies itself").await;
    let (replicated, _) = origin.file(b"a file replication copied first").await;
    origin.run("blob-replicate").await;
    assert!(copy_of(folder.path(), &origin.id(), &replicated).is_file());

    let (status, body) = origin.back_up().await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let name = body["backup"]["name"].as_str().unwrap().to_string();
    let own = folder.path().join("backups").join(origin.id());
    assert_eq!(names_in(&own), [name.clone()]);
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
        .set("fail:backup-folder-write", Some("2"))
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
async fn what_a_process_that_ended_left_half_written_is_cleared_by_the_next_run_and_never_listed()
{
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
    assert_eq!(refused["error"]["code"], "backup_files_missing", "{refused}");
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
    let relative = Settings::read(Environment::from_pairs(&[(
        "MARFA_BACKUP_PATH",
        "backups",
    )]));
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
