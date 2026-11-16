//! Backups in parts: what a backup sends when little has changed, what a restore checks before it
//! writes anything, and which parts clean-up keeps, in the backup folder and in an object store.

#[allow(dead_code)]
mod fake_s3;

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Read;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Method, Request, StatusCode, header};
use fake_s3::FakeS3;
use marfa_server::app::App;
use marfa_server::http::{control, public};
use marfa_server::settings::{Environment, Settings};
use serde_json::{Value, json};
use sha2::Digest;
use tempfile::TempDir;
use tower::ServiceExt;

const DAY_MS: u64 = 24 * 3_600_000;
const BUCKET: &str = "marfa";
const PREFIX: &str = "parts-test";
const ROWS: &str = "rows.ndjson.gz";

/// Where the backups go: a backup folder, or an object store under a prefix.
enum Place {
    Folder(TempDir),
    Bucket(FakeS3),
}

impl Place {
    async fn folder() -> Place {
        Place::Folder(TempDir::new().unwrap())
    }

    async fn bucket() -> Place {
        Place::Bucket(FakeS3::start().await)
    }

    fn settings(&self) -> Vec<(String, String)> {
        match self {
            Place::Folder(folder) => vec![(
                "MARFA_BACKUP_PATH".to_string(),
                folder.path().to_str().unwrap().to_string(),
            )],
            Place::Bucket(store) => store.settings(BUCKET, PREFIX),
        }
    }

    fn path(&self, area: &str, instance: &str, name: &str) -> PathBuf {
        let Place::Folder(folder) = self else {
            unreachable!()
        };
        folder.path().join(area).join(instance).join(name)
    }

    fn key(area: &str, instance: &str, name: &str) -> String {
        format!("/{BUCKET}/{PREFIX}/{area}/{instance}/{name}")
    }

    fn read(&self, area: &str, instance: &str, name: &str) -> Option<Vec<u8>> {
        match self {
            Place::Folder(_) => fs::read(self.path(area, instance, name)).ok(),
            Place::Bucket(store) => store.object(&Place::key(area, instance, name)),
        }
    }

    fn write(&self, area: &str, instance: &str, name: &str, bytes: &[u8]) {
        match self {
            Place::Folder(_) => fs::write(self.path(area, instance, name), bytes).unwrap(),
            Place::Bucket(store) => store.put_object(&Place::key(area, instance, name), bytes),
        }
    }

    fn remove(&self, area: &str, instance: &str, name: &str) {
        match self {
            Place::Folder(_) => fs::remove_file(self.path(area, instance, name)).unwrap(),
            Place::Bucket(store) => store.remove_object(&Place::key(area, instance, name)),
        }
    }

    /// The names of the files or objects in one instance's folder of `area`.
    fn names(&self, area: &str, instance: &str) -> BTreeSet<String> {
        match self {
            Place::Folder(folder) => match fs::read_dir(folder.path().join(area).join(instance)) {
                Ok(entries) => entries
                    .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
                    .collect(),
                Err(_) => BTreeSet::new(),
            },
            Place::Bucket(store) => {
                let under = format!("/{BUCKET}/{PREFIX}/{area}/{instance}/");
                store
                    .objects_under(&under)
                    .into_iter()
                    .map(|key| key[under.len()..].to_string())
                    .collect()
            }
        }
    }

    fn manifest(&self, instance: &str, name: &str) -> Value {
        serde_json::from_slice(&self.read("backups", instance, name).unwrap()).unwrap()
    }

    /// Each part this instance's folder of parts holds, by its hash, with its size.
    fn parts(&self, instance: &str) -> BTreeMap<String, u64> {
        self.names("backup-parts", instance)
            .into_iter()
            .map(|name| {
                let size = self.read("backup-parts", instance, &name).unwrap().len() as u64;
                (name.trim_end_matches(".ndjson.gz").to_string(), size)
            })
            .collect()
    }

    fn part(&self, instance: &str, sha256: &str) -> Vec<u8> {
        self.read("backup-parts", instance, &format!("{sha256}.ndjson.gz"))
            .unwrap()
    }
}

/// The parts a backup's manifest names, as `(entry, sha256, size_bytes)`.
fn named(manifest: &Value) -> Vec<(String, String, u64)> {
    manifest["parts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|part| {
            (
                part["entry"].as_str().unwrap().to_string(),
                part["sha256"].as_str().unwrap().to_string(),
                part["size_bytes"].as_u64().unwrap(),
            )
        })
        .collect()
}

/// The lines of gzip members laid end to end.
fn lines_of(gzipped: &[u8]) -> Vec<Value> {
    let mut text = String::new();
    flate2::read::MultiGzDecoder::new(gzipped)
        .read_to_string(&mut text)
        .unwrap();
    text.lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

/// A short stretch of text that compresses little, the same for the same seed.
fn text(seed: u64, length: usize) -> String {
    const LETTERS: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ";
    let mut state = seed.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1);
    (0..length)
        .map(|_| {
            state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            LETTERS[(state >> 33) as usize % LETTERS.len()] as char
        })
        .collect()
}

struct Instance {
    dir: TempDir,
    app: Arc<App>,
    public: Router,
    control: Router,
    writer: String,
}

struct Reply {
    status: StatusCode,
    body: Value,
    bytes: Vec<u8>,
}

impl Instance {
    async fn start(place: &Place) -> Instance {
        let dir = TempDir::new().unwrap();
        let database = dir.path().join("marfa.db");
        let blobs = dir.path().join("blobs");
        let socket = dir.path().join("s.sock");
        let more = place.settings();
        let mut pairs = vec![
            ("MARFA_DATABASE_PATH", database.to_str().unwrap()),
            ("MARFA_BLOB_PATH", blobs.to_str().unwrap()),
            ("MARFA_CONTROL_SOCKET", socket.to_str().unwrap()),
            ("MARFA_BACKUP_INTERVAL_SECONDS", "31536000"),
            ("MARFA_TEST_HOOKS", "true"),
            ("MARFA_RATE_LIMIT_ENABLED", "false"),
        ];
        pairs.extend(
            more.iter()
                .map(|(name, value)| (name.as_str(), value.as_str())),
        );
        let settings = Settings::read(Environment::from_pairs(&pairs)).unwrap();
        let app = App::start(settings).await.unwrap();
        let mut instance = Instance {
            public: public(app.clone()),
            control: control(app.clone()),
            app,
            dir,
            writer: String::new(),
        };
        let minted = instance
            .local(
                Method::POST,
                "/keys",
                Some(json!({
                    "label": "writer",
                    "source": "parts-writer",
                    "permissions": ["items.purge", "blobs.manage", "config.manage"],
                    "type_permissions": { "*": "write" },
                })),
            )
            .await;
        assert_eq!(minted.status, StatusCode::CREATED, "{}", minted.body);
        instance.writer = minted.body["key"].as_str().unwrap().to_string();
        instance
    }

    fn id(&self) -> String {
        self.app.instance_id.clone()
    }

    async fn send(
        &self,
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
        let bytes = to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap()
            .to_vec();
        Reply {
            status,
            body: serde_json::from_slice(&bytes).unwrap_or(Value::Null),
            bytes,
        }
    }

    async fn local(&self, method: Method, path: &str, body: Option<Value>) -> Reply {
        let body = body.map_or_else(Body::empty, |body| Body::from(body.to_string()));
        self.send(&self.control, None, method, path, body, "application/json")
            .await
    }

    async fn keyed(&self, method: Method, path: &str, body: Option<Value>) -> Reply {
        let body = body.map_or_else(Body::empty, |body| Body::from(body.to_string()));
        self.send(
            &self.public,
            Some(&self.writer),
            method,
            path,
            body,
            "application/json",
        )
        .await
    }

    async fn item(&self, type_id: &str, properties: Value) -> String {
        let made = self
            .keyed(
                Method::POST,
                "/items",
                Some(json!({ "type": type_id, "properties": properties })),
            )
            .await;
        assert_eq!(made.status, StatusCode::CREATED, "{}", made.body);
        made.body["item"]["id"].as_str().unwrap().to_string()
    }

    async fn file(&self, bytes: &[u8]) -> String {
        let uploaded = self
            .send(
                &self.public,
                Some(&self.writer),
                Method::POST,
                "/blobs",
                Body::from(bytes.to_vec()),
                "text/plain",
            )
            .await;
        assert_eq!(uploaded.status, StatusCode::CREATED, "{}", uploaded.body);
        let hash = uploaded.body["hash"].as_str().unwrap().to_string();
        self.item(
            "core.file",
            json!({ "blob_ref": hash, "mime_type": "text/plain" }),
        )
        .await;
        hash
    }

    /// Writes one batch to a conversation's messages and answers the batch's id.
    async fn rows(&self, conversation: &str, operations: Vec<Value>) -> String {
        let written = self
            .keyed(
                Method::POST,
                &format!("/items/{conversation}/tables/messages/rows"),
                Some(json!({ "operations": operations })),
            )
            .await;
        assert_eq!(written.status, StatusCode::OK, "{}", written.body);
        written.body["batch"].as_str().unwrap().to_string()
    }

    async fn back_up(&self) -> Value {
        let answer = self.local(Method::POST, "/backups", None).await;
        assert_eq!(answer.status, StatusCode::OK, "{}", answer.body);
        assert_eq!(answer.body["outcome"], "put", "{}", answer.body);
        answer.body
    }

    async fn restore(&self, instance: &str, name: &str, query: &str) -> Reply {
        self.local(
            Method::POST,
            &format!("/backups/{instance}/{name}/restore{query}"),
            None,
        )
        .await
    }

    async fn backups_health(&self) -> Value {
        let health = self.local(Method::GET, "/health", None).await;
        assert_eq!(health.status, StatusCode::OK, "{}", health.body);
        health.body["backups"].clone()
    }

    /// The references of the attention entries of kind `backup`.
    async fn backup_concerns(&self) -> Vec<String> {
        let listed = self.local(Method::GET, "/attention", None).await;
        assert_eq!(listed.status, StatusCode::OK, "{}", listed.body);
        listed.body["data"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|concern| concern["kind"] == "backup")
            .map(|concern| concern["reference"].as_str().unwrap().to_string())
            .collect()
    }

    async fn count(&self, sql: &'static str) -> i64 {
        self.app
            .db
            .read(move |tx| Ok(tx.query_row(sql, [], |row| row.get::<_, i64>(0))?))
            .await
            .unwrap()
    }

    /// When the server last read the part `sha256` whole or found it damaged.
    async fn hashed_at(&self, sha256: &str) -> Option<String> {
        let sha256 = sha256.to_string();
        self.app
            .db
            .read(move |tx| {
                Ok(tx
                    .query_row(
                        "SELECT hashed_at FROM backup_parts WHERE sha256 = ?1",
                        [&sha256],
                        |row| row.get::<_, Option<String>>(0),
                    )
                    .ok()
                    .flatten())
            })
            .await
            .unwrap()
    }

    /// The rows and items an archive export holds now, each as its lines.
    async fn exported(&self) -> BTreeMap<String, Vec<Value>> {
        let exported = self
            .send(
                &self.public,
                Some(&self.writer),
                Method::GET,
                "/export?format=archive",
                Body::empty(),
                "application/json",
            )
            .await;
        assert_eq!(exported.status, StatusCode::OK, "{}", exported.body);
        let mut held = BTreeMap::new();
        let tar = exported.bytes;
        let mut at = 0;
        while at + 512 <= tar.len() && tar[at..at + 512].iter().any(|byte| *byte != 0) {
            let block = &tar[at..at + 512];
            let end = block[..100]
                .iter()
                .position(|byte| *byte == 0)
                .unwrap_or(100);
            let name = String::from_utf8(block[..end].to_vec()).unwrap();
            let octal = String::from_utf8_lossy(&block[124..136]);
            let size =
                usize::from_str_radix(octal.trim_matches(|c: char| c == '\0' || c == ' '), 8)
                    .unwrap();
            if name.ends_with(".ndjson.gz") {
                held.insert(name, lines_of(&tar[at + 512..at + 512 + size]));
            }
            at += 512 + size.div_ceil(512) * 512;
        }
        held
    }
}

/// What a backup's parts hold of one entry, its parts read in order.
fn backed_up(place: &Place, instance: &str, manifest: &Value, entry: &str) -> Vec<Value> {
    named(manifest)
        .into_iter()
        .filter(|(named, _, _)| named == entry)
        .flat_map(|(_, sha256, _)| lines_of(&place.part(instance, &sha256)))
        .collect()
}

/// Notes, a file, one conversation whose messages fill a part of their own, and many small ones.
/// Answers the large conversation and the small ones.
async fn fill(instance: &Instance) -> (String, Vec<String>) {
    for at in 0..3 {
        instance
            .item("core.note", json!({ "title": format!("note {at}") }))
            .await;
    }
    instance.file(b"a file the items name").await;
    if instance.app.blobs.s3().is_some() {
        let run = instance
            .local(Method::POST, "/housekeeping/blob-replicate/run", None)
            .await;
        assert_eq!(run.status, StatusCode::OK, "{}", run.body);
        assert_eq!(run.body["result"]["remaining"], 0, "{}", run.body);
    }
    let large = instance.item("core.conversation", json!({})).await;
    for run in 0..7u64 {
        let operations = (0..150u64)
            .map(|at| {
                json!({ "op": "put", "id": uuid::Uuid::now_v7().to_string(), "values": {
                    "author": "ada",
                    "text": text(run * 1000 + at, 5000),
                    "sent_at": "2026-01-01T10:00:00Z",
                } })
            })
            .collect();
        instance.rows(&large, operations).await;
    }
    let mut small = Vec::new();
    for at in 0..30u64 {
        let conversation = instance.item("core.conversation", json!({})).await;
        let operations = (0..3u64)
            .map(|row| {
                json!({ "op": "put", "id": uuid::Uuid::now_v7().to_string(), "values": {
                    "author": "grace",
                    "text": text(at * 10 + row, 200),
                    "sent_at": "2026-01-01T11:00:00Z",
                } })
            })
            .collect();
        instance.rows(&conversation, operations).await;
        small.push(conversation);
    }
    (large, small)
}

/// The part of rows that holds the large conversation's messages alone.
fn large_part(place: &Place, instance: &str, manifest: &Value, large: &str) -> (String, u64) {
    named(manifest)
        .into_iter()
        .filter(|(entry, _, _)| entry == ROWS)
        .find(|(_, sha256, _)| {
            let lines = lines_of(&place.part(instance, sha256));
            !lines.is_empty() && lines.iter().all(|line| line["item_id"] == large)
        })
        .map(|(_, sha256, size)| (sha256, size))
        .expect("a part of the large table's rows alone")
}

fn sorted(mut lines: Vec<Value>) -> Vec<Value> {
    lines.sort_by_key(|line| line.to_string());
    lines
}

async fn only_changed_parts_are_sent_and_each_backup_restores_whole(place: Place) {
    let origin = Instance::start(&place).await;
    let id = origin.id();
    let (large, small) = fill(&origin).await;

    let first = origin.back_up().await;
    let first_name = first["backup"]["name"].as_str().unwrap().to_string();
    let first_manifest = place.manifest(&id, &first_name);
    let stored = place.parts(&id);
    let distinct: BTreeMap<String, u64> = named(&first_manifest)
        .into_iter()
        .map(|(_, sha256, size)| (sha256, size))
        .collect();
    assert_eq!(stored, distinct);
    assert_eq!(
        first["sent_bytes"],
        distinct.values().sum::<u64>(),
        "{first}"
    );
    let (large_sha, large_size) = large_part(&place, &id, &first_manifest, &large);
    assert!(large_size > 1_000_000, "{large_size}");
    let first_export = origin.exported().await;
    assert_eq!(
        sorted(backed_up(&place, &id, &first_manifest, ROWS)),
        sorted(first_export[ROWS].clone())
    );

    origin.app.clock.pause(true);
    origin.app.clock.advance(1000).unwrap();
    let again = origin.back_up().await;
    let again_name = again["backup"]["name"].as_str().unwrap().to_string();
    assert_ne!(again_name, first_name);
    assert_eq!(again["sent_bytes"], 0, "{again}");
    assert_eq!(
        named(&place.manifest(&id, &again_name)),
        named(&first_manifest)
    );
    assert_eq!(place.parts(&id), stored);

    origin
        .rows(
            &small[7],
            vec![
                json!({ "op": "put", "id": uuid::Uuid::now_v7().to_string(), "values": {
                "author": "grace", "text": "one more", "sent_at": "2026-01-01T12:00:00Z" } }),
            ],
        )
        .await;
    origin.app.clock.advance(1000).unwrap();
    let changed = origin.back_up().await;
    let changed_name = changed["backup"]["name"].as_str().unwrap().to_string();
    let changed_manifest = place.manifest(&id, &changed_name);
    assert_eq!(
        large_part(&place, &id, &changed_manifest, &large),
        (large_sha.clone(), large_size)
    );
    let new: BTreeMap<String, u64> = named(&changed_manifest)
        .into_iter()
        .filter(|(_, sha256, _)| !stored.contains_key(sha256))
        .map(|(_, sha256, size)| (sha256, size))
        .collect();
    assert!(!new.is_empty());
    let sent = changed["sent_bytes"].as_u64().unwrap();
    assert_eq!(sent, new.values().sum::<u64>(), "{changed}");
    assert!(sent < large_size, "{sent} of {large_size}");
    let changed_export = origin.exported().await;
    assert_eq!(
        sorted(backed_up(&place, &id, &changed_manifest, ROWS)),
        sorted(changed_export[ROWS].clone())
    );

    let listed = origin.local(Method::GET, "/backups", None).await;
    assert_eq!(listed.status, StatusCode::OK, "{}", listed.body);
    let sizes: BTreeMap<String, u64> = listed.body["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|backup| {
            (
                backup["name"].as_str().unwrap().to_string(),
                backup["size_bytes"].as_u64().unwrap(),
            )
        })
        .collect();
    let manifest_bytes = place.read("backups", &id, &changed_name).unwrap().len() as u64;
    let parts_bytes: u64 = named(&changed_manifest)
        .iter()
        .map(|(_, _, size)| size)
        .sum();
    assert_eq!(sizes[&changed_name], manifest_bytes + parts_bytes);

    for (name, export) in [
        (&first_name, &first_export),
        (&changed_name, &changed_export),
    ] {
        let fresh = Instance::start(&place).await;
        let restored = fresh.restore(&id, name, "").await;
        assert_eq!(restored.status, StatusCode::OK, "{}", restored.body);
        let held = fresh.exported().await;
        for entry in [
            "items.ndjson.gz",
            "versions.ndjson.gz",
            "edges.ndjson.gz",
            ROWS,
        ] {
            assert_eq!(
                sorted(held[entry].clone()),
                sorted(export[entry].clone()),
                "{entry}"
            );
        }
    }
}

#[tokio::test]
async fn only_changed_parts_are_sent_and_each_backup_restores_whole_from_a_folder() {
    only_changed_parts_are_sent_and_each_backup_restores_whole(Place::folder().await).await;
}

#[tokio::test]
async fn only_changed_parts_are_sent_and_each_backup_restores_whole_from_an_object_store() {
    only_changed_parts_are_sent_and_each_backup_restores_whole(Place::bucket().await).await;
}

#[tokio::test]
async fn every_kind_of_row_write_reaches_the_next_backup() {
    let place = Place::folder().await;
    let origin = Instance::start(&place).await;
    let id = origin.id();
    let (large, small) = fill(&origin).await;
    origin.back_up().await;
    origin.app.clock.pause(true);

    let row = uuid::Uuid::now_v7().to_string();
    let target = small[3].clone();
    let steps: Vec<(&str, Vec<Value>)> = vec![
        (
            "insert",
            vec![json!({ "op": "put", "id": row, "values": {
                "author": "ada", "text": "new", "sent_at": "2026-01-02T10:00:00Z" } })],
        ),
        (
            "replace",
            vec![json!({ "op": "put", "id": row, "values": {
                "author": "ada", "text": "replaced", "sent_at": "2026-01-02T10:00:00Z" } })],
        ),
        (
            "patch",
            vec![json!({ "op": "patch", "id": row, "values": { "text": "patched" } })],
        ),
        ("delete", vec![json!({ "op": "delete", "id": row })]),
    ];
    let mut last_batch = String::new();
    let mut before = check_reaches(&place, &origin, &id, "start").await;
    for (kind, operations) in steps {
        last_batch = origin.rows(&target, operations).await;
        let after = check_reaches(&place, &origin, &id, kind).await;
        assert_ne!(after, before, "{kind}");
        before = after;
    }

    let undone = origin
        .keyed(
            Method::POST,
            &format!("/items/{target}/tables/messages/batches/{last_batch}/undo"),
            Some(json!({})),
        )
        .await;
    assert_eq!(undone.status, StatusCode::OK, "{}", undone.body);
    let after = check_reaches(&place, &origin, &id, "undo").await;
    assert_ne!(after, before, "undo");
    before = after;

    let trashed = origin
        .keyed(Method::DELETE, &format!("/items/{target}"), None)
        .await;
    assert_eq!(trashed.status, StatusCode::OK, "{}", trashed.body);
    check_reaches(&place, &origin, &id, "trash").await;

    let restored = origin
        .keyed(Method::POST, &format!("/items/{target}/restore"), None)
        .await;
    assert_eq!(restored.status, StatusCode::OK, "{}", restored.body);
    check_reaches(&place, &origin, &id, "restore").await;

    for item in [&target, &large] {
        let trashed = origin
            .keyed(Method::DELETE, &format!("/items/{item}"), None)
            .await;
        assert_eq!(trashed.status, StatusCode::OK, "{}", trashed.body);
        let purged = origin
            .keyed(Method::POST, &format!("/items/{item}/purge"), None)
            .await;
        assert_eq!(purged.status, StatusCode::OK, "{}", purged.body);
    }
    let after = check_reaches(&place, &origin, &id, "purge").await;
    assert_ne!(after, before, "purge");
}

/// Backs up and checks the backup names the parts of rows a read that takes nothing again writes
/// now. Answers those parts.
async fn check_reaches(
    place: &Place,
    origin: &Instance,
    id: &str,
    kind: &str,
) -> Vec<(String, u64)> {
    origin.app.clock.advance(1000).unwrap();
    let answer = origin.back_up().await;
    let name = answer["backup"]["name"].as_str().unwrap();
    let backed: Vec<(String, u64)> = named(&place.manifest(id, name))
        .into_iter()
        .filter(|(entry, _, _)| entry == ROWS)
        .map(|(_, sha256, size)| (sha256, size))
        .collect();
    let read = origin
        .app
        .backup_archive("", std::collections::HashMap::new())
        .await
        .unwrap()
        .parts(&origin.app, &[])
        .await
        .unwrap();
    let whole: Vec<(String, u64)> = read
        .parts
        .iter()
        .filter(|out| out.part.entry == ROWS)
        .map(|out| (out.part.sha256.clone(), out.part.size_bytes))
        .collect();
    assert_eq!(backed, whole, "{kind}");
    backed
}

async fn a_restore_names_a_missing_or_altered_part_and_writes_nothing(place: Place) {
    let origin = Instance::start(&place).await;
    let id = origin.id();
    let (large, _) = fill(&origin).await;
    let answer = origin.back_up().await;
    let name = answer["backup"]["name"].as_str().unwrap().to_string();
    let manifest = place.manifest(&id, &name);
    let (large_sha, _) = large_part(&place, &id, &manifest, &large);
    let items_sha = named(&manifest)
        .into_iter()
        .find(|(entry, _, _)| entry == "items.ndjson.gz")
        .unwrap()
        .1;

    let fresh = Instance::start(&place).await;
    let (items, rows) = (
        fresh.count("SELECT count(*) FROM items").await,
        fresh.count("SELECT count(*) FROM table_rows").await,
    );
    let unchanged = || async {
        assert_eq!(fresh.count("SELECT count(*) FROM items").await, items);
        assert_eq!(fresh.count("SELECT count(*) FROM table_rows").await, rows);
    };

    let kept = place.part(&id, &large_sha);
    place.remove("backup-parts", &id, &format!("{large_sha}.ndjson.gz"));
    let refused = fresh.restore(&id, &name, "").await;
    assert_eq!(refused.status, StatusCode::CONFLICT, "{}", refused.body);
    assert_eq!(refused.body["error"]["code"], "backup_parts_missing");
    assert_eq!(
        refused.body["error"]["details"]["missing_parts"],
        json!([format!("{large_sha}.ndjson.gz")]),
        "{}",
        refused.body
    );
    unchanged().await;

    place.write(
        "backup-parts",
        &id,
        &format!("{large_sha}.ndjson.gz"),
        &kept,
    );
    let mut altered = place.part(&id, &items_sha);
    let last = altered.len() - 9;
    altered[last] ^= 0x01;
    place.write(
        "backup-parts",
        &id,
        &format!("{items_sha}.ndjson.gz"),
        &altered,
    );
    let refused = fresh.restore(&id, &name, "").await;
    assert_eq!(refused.status, StatusCode::CONFLICT, "{}", refused.body);
    assert_eq!(refused.body["error"]["code"], "backup_parts_missing");
    assert_eq!(
        refused.body["error"]["details"]["missing_parts"],
        json!([format!("{items_sha}.ndjson.gz")]),
        "{}",
        refused.body
    );
    unchanged().await;

    place.write(
        "backup-parts",
        &id,
        &format!("{items_sha}.ndjson.gz"),
        &origin_part(&origin, &place, &id, &items_sha).await,
    );
    let mut altered = kept.clone();
    let middle = altered.len() / 2;
    altered[middle] ^= 0x01;
    place.write(
        "backup-parts",
        &id,
        &format!("{large_sha}.ndjson.gz"),
        &altered,
    );
    let refused = fresh.restore(&id, &name, "").await;
    assert_eq!(refused.status, StatusCode::CONFLICT, "{}", refused.body);
    assert_eq!(refused.body["error"]["code"], "backup_parts_missing");
    assert_eq!(
        refused.body["error"]["details"]["missing_parts"],
        json!([format!("{large_sha}.ndjson.gz")]),
        "{}",
        refused.body
    );
    unchanged().await;

    place.write(
        "backup-parts",
        &id,
        &format!("{large_sha}.ndjson.gz"),
        &kept,
    );
    let written = place.read("backups", &id, &name).unwrap();
    let mut later = manifest.clone();
    later["version"] = json!(2);
    place.write("backups", &id, &name, &serde_json::to_vec(&later).unwrap());
    let refused = fresh.restore(&id, &name, "").await;
    assert_eq!(refused.status, StatusCode::BAD_REQUEST, "{}", refused.body);
    let message = refused.body["error"]["message"].as_str().unwrap();
    assert!(
        message.contains(&format!(
            "the manifest of the backup {name} from instance {id}"
        )) && message.contains("version 2"),
        "{message}"
    );
    unchanged().await;
    place.write("backups", &id, &name, &written);

    let restored = fresh.restore(&id, &name, "").await;
    assert_eq!(restored.status, StatusCode::OK, "{}", restored.body);
    assert!(fresh.count("SELECT count(*) FROM table_rows").await > rows);
}

/// The items part as the origin writes it again, which a forced backup stores under its hash.
async fn origin_part(origin: &Instance, place: &Place, id: &str, sha256: &str) -> Vec<u8> {
    place.remove("backup-parts", id, &format!("{sha256}.ndjson.gz"));
    origin.app.clock.pause(true);
    origin.app.clock.advance(1000).unwrap();
    origin.back_up().await;
    place.part(id, sha256)
}

#[tokio::test]
async fn a_restore_names_a_missing_or_altered_part_and_writes_nothing_from_a_folder() {
    a_restore_names_a_missing_or_altered_part_and_writes_nothing(Place::folder().await).await;
}

#[tokio::test]
async fn a_restore_names_a_missing_or_altered_part_and_writes_nothing_from_an_object_store() {
    a_restore_names_a_missing_or_altered_part_and_writes_nothing(Place::bucket().await).await;
}

async fn a_backup_that_fails_before_its_manifest_is_never_listed_and_the_next_sends_only_what_is_missing(
    place: Place,
) {
    let origin = Arc::new(Instance::start(&place).await);
    let id = origin.id();
    fill(&origin).await;
    origin.app.faults.set("hold:backup:put", None).unwrap();
    let running = origin.clone();
    let run = tokio::spawn(async move { running.local(Method::POST, "/backups", None).await });
    let began = std::time::Instant::now();
    while !origin
        .app
        .faults
        .list()
        .iter()
        .any(|fault| fault.waiting > 0)
    {
        assert!(began.elapsed() < Duration::from_secs(60));
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let (whole, writing): (BTreeSet<String>, BTreeSet<String>) = place
        .names("backup-parts", &id)
        .into_iter()
        .partition(|name| !name.starts_with('.'));
    assert!(!whole.is_empty());
    for name in &whole {
        let bytes = place.read("backup-parts", &id, name).unwrap();
        assert_eq!(
            format!("{}.ndjson.gz", hex::encode(sha2::Sha256::digest(&bytes))),
            *name
        );
    }
    match &place {
        Place::Folder(_) => {
            assert_eq!(writing.len(), 1, "{writing:?}");
            assert!(writing.iter().all(|name| name.ends_with(".partial")));
        }
        Place::Bucket(_) => assert!(writing.is_empty(), "{writing:?}"),
    }
    assert!(place.names("backups", &id).is_empty());
    let listed = origin.local(Method::GET, "/backups", None).await;
    assert_eq!(listed.body["data"], json!([]), "{}", listed.body);

    match &place {
        Place::Folder(_) => origin
            .app
            .faults
            .set("fail:backup-folder-write", None)
            .unwrap(),
        Place::Bucket(store) => store.refuse_writes(&format!("/{BUCKET}/{PREFIX}/backups/")),
    }
    origin.app.faults.clear(Some("hold:backup:put"));
    let failed = run.await.unwrap();
    assert_eq!(
        failed.status,
        StatusCode::SERVICE_UNAVAILABLE,
        "{}",
        failed.body
    );
    origin.app.faults.clear(None);
    if let Place::Bucket(store) = &place {
        store.allow_writes();
    }
    assert!(place.names("backups", &id).is_empty());
    let listed = origin.local(Method::GET, "/backups", None).await;
    assert_eq!(listed.body["data"], json!([]), "{}", listed.body);
    let stored = place.parts(&id);
    assert!(stored.len() > whole.len());
    for (sha256, size) in &stored {
        let bytes = place.part(&id, sha256);
        assert_eq!(bytes.len() as u64, *size);
        assert_eq!(hex::encode(sha2::Sha256::digest(&bytes)), *sha256);
    }

    let answer = origin.back_up().await;
    let name = answer["backup"]["name"].as_str().unwrap().to_string();
    assert_eq!(place.names("backups", &id), BTreeSet::from([name.clone()]));
    let manifest = place.manifest(&id, &name);
    let missing: u64 = named(&manifest)
        .into_iter()
        .filter(|(_, sha256, _)| !stored.contains_key(sha256))
        .map(|(_, sha256, size)| (sha256, size))
        .collect::<BTreeMap<_, _>>()
        .values()
        .sum::<u64>();
    assert_eq!(answer["sent_bytes"], missing, "{answer}");
    let restored = Instance::start(&place).await.restore(&id, &name, "").await;
    assert_eq!(restored.status, StatusCode::OK, "{}", restored.body);
}

#[tokio::test]
async fn a_backup_that_fails_before_its_manifest_is_never_listed_in_a_folder() {
    a_backup_that_fails_before_its_manifest_is_never_listed_and_the_next_sends_only_what_is_missing(
        Place::folder().await,
    )
    .await;
}

#[tokio::test]
async fn a_backup_that_fails_before_its_manifest_is_never_listed_in_an_object_store() {
    a_backup_that_fails_before_its_manifest_is_never_listed_and_the_next_sends_only_what_is_missing(
        Place::bucket().await,
    )
    .await;
}

async fn clean_up_deletes_only_parts_no_kept_backup_names(place: Place) {
    let origin = Instance::start(&place).await;
    let id = origin.id();
    let (_, small) = fill(&origin).await;
    origin.app.clock.pause(true);
    let mut removed = 0;
    let mut written = BTreeSet::new();
    for step in 0..12u64 {
        origin
            .rows(
                &small[(step % 30) as usize],
                vec![
                    json!({ "op": "put", "id": uuid::Uuid::now_v7().to_string(), "values": {
                    "author": "grace", "text": format!("step {step}"),
                    "sent_at": "2026-01-03T10:00:00Z" } }),
                ],
            )
            .await;
        origin.app.clock.advance(DAY_MS / 4).unwrap();
        let answer = origin.back_up().await;
        removed += answer["removed"].as_u64().unwrap();
        let name = answer["backup"]["name"].as_str().unwrap();
        written.extend(
            named(&place.manifest(&id, name))
                .into_iter()
                .map(|(_, sha256, _)| sha256),
        );
    }
    assert!(removed > 0, "thinning deleted no backup");

    let kept: BTreeSet<String> = place
        .names("backups", &id)
        .iter()
        .flat_map(|name| named(&place.manifest(&id, name)))
        .map(|(_, sha256, _)| sha256)
        .collect();
    let present: BTreeSet<String> = place.parts(&id).into_keys().collect();
    assert!(kept.is_subset(&present), "{:?}", kept.difference(&present));
    assert_eq!(present, kept);
    assert!(written.len() > kept.len(), "nothing was there to delete");

    let run = || async {
        let report = origin
            .local(Method::POST, "/housekeeping/backup/run", None)
            .await;
        assert_eq!(report.status, StatusCode::OK, "{}", report.body);
        report.body["result"].clone()
    };
    assert_eq!(run().await["outcome"], "unchanged");
    origin
        .rows(
            &small[29],
            vec![json!({ "op": "put", "id": uuid::Uuid::now_v7().to_string(), "values": {
                "author": "grace", "text": "a scheduled run", "sent_at": "2026-01-03T11:00:00Z" } })],
        )
        .await;
    origin.app.clock.advance(DAY_MS).unwrap();
    let report = run().await;
    assert_eq!(report["outcome"], "put", "{report}");
    assert!(report["sent_bytes"].as_u64().unwrap() > 0, "{report}");
    assert!(report["parts_removed"].as_u64().unwrap() > 0, "{report}");
    let present: BTreeSet<String> = place.parts(&id).into_keys().collect();
    let kept: BTreeSet<String> = place
        .names("backups", &id)
        .iter()
        .flat_map(|name| named(&place.manifest(&id, name)))
        .map(|(_, sha256, _)| sha256)
        .collect();
    assert_eq!(present, kept);
    for name in place.names("backups", &id) {
        let restored = Instance::start(&place).await.restore(&id, &name, "").await;
        assert_eq!(restored.status, StatusCode::OK, "{name}: {}", restored.body);
    }
}

#[tokio::test]
async fn clean_up_deletes_only_parts_no_kept_backup_names_in_a_folder() {
    clean_up_deletes_only_parts_no_kept_backup_names(Place::folder().await).await;
}

#[tokio::test]
async fn clean_up_deletes_only_parts_no_kept_backup_names_in_an_object_store() {
    clean_up_deletes_only_parts_no_kept_backup_names(Place::bucket().await).await;
}

#[tokio::test]
async fn a_manifest_whose_write_failed_keeps_its_parts_until_it_lands() {
    let place = Place::bucket().await;
    let Place::Bucket(store) = &place else {
        unreachable!()
    };
    let origin = Instance::start(&place).await;
    let id = origin.id();
    let (_, small) = fill(&origin).await;
    origin.back_up().await;
    origin.app.clock.pause(true);

    origin
        .rows(
            &small[0],
            vec![
                json!({ "op": "put", "id": uuid::Uuid::now_v7().to_string(), "values": {
                "author": "grace", "text": "only the late backup holds this",
                "sent_at": "2026-01-04T10:00:00Z" } }),
            ],
        )
        .await;
    let before = place.parts(&id);
    origin.app.clock.advance(1000).unwrap();
    store.late_write(&format!("/{BUCKET}/{PREFIX}/backups/"));
    let failed = origin.local(Method::POST, "/backups", None).await;
    assert_eq!(
        failed.status,
        StatusCode::SERVICE_UNAVAILABLE,
        "{}",
        failed.body
    );
    let late = store.late_keys();
    assert_eq!(late.len(), 1);
    let late_name = late[0].rsplit('/').next().unwrap().to_string();
    let only_late: BTreeSet<String> = place
        .parts(&id)
        .into_keys()
        .filter(|sha256| !before.contains_key(sha256))
        .collect();
    assert!(!only_late.is_empty());

    origin
        .rows(
            &small[0],
            vec![
                json!({ "op": "put", "id": uuid::Uuid::now_v7().to_string(), "values": {
                "author": "grace", "text": "a later change",
                "sent_at": "2026-01-04T11:00:00Z" } }),
            ],
        )
        .await;
    origin.app.clock.advance(1000).unwrap();
    let answer = origin.back_up().await;
    let name = answer["backup"]["name"].as_str().unwrap();
    let named_now: BTreeSet<String> = named(&place.manifest(&id, name))
        .into_iter()
        .map(|(_, sha256, _)| sha256)
        .collect();
    assert!(only_late.is_disjoint(&named_now));
    let present: BTreeSet<String> = place.parts(&id).into_keys().collect();
    assert!(only_late.is_subset(&present));

    store.land_late_writes();
    let restored = Instance::start(&place)
        .await
        .restore(&id, &late_name, "")
        .await;
    assert_eq!(restored.status, StatusCode::OK, "{}", restored.body);

    origin.app.clock.advance(1000).unwrap();
    origin.back_up().await;
    let present: BTreeSet<String> = place.parts(&id).into_keys().collect();
    assert!(only_late.is_subset(&present));
}

#[tokio::test]
async fn a_restore_asked_to_leave_out_missing_files_goes_ahead_without_them() {
    let place = Place::folder().await;
    let origin = Instance::start(&place).await;
    let id = origin.id();
    let hash = origin.file(b"a file whose copy someone deleted").await;
    let answer = origin.back_up().await;
    let name = answer["backup"]["name"].as_str().unwrap().to_string();
    let hex = hash.trim_start_matches("sha256:");
    fs::remove_file(place.path("files", &id, &format!("{}/{hex}", &hex[0..4]))).unwrap();

    let fresh = Instance::start(&place).await;
    let refused = fresh.restore(&id, &name, "").await;
    assert_eq!(refused.status, StatusCode::CONFLICT, "{}", refused.body);
    assert_eq!(refused.body["error"]["code"], "backup_files_missing");
    let message = refused.body["error"]["message"].as_str().unwrap();
    assert!(message.contains("--allow-missing-files"), "{message}");

    let restored = fresh.restore(&id, &name, "?allow_missing_files=true").await;
    assert_eq!(restored.status, StatusCode::OK, "{}", restored.body);
    assert_eq!(
        restored.body["blobs_missing"],
        json!([hash]),
        "{}",
        restored.body
    );

    for spelling in ["yes", "1", "TRUE", ""] {
        let unknown = fresh
            .restore(&id, &name, &format!("?allow_missing_files={spelling}"))
            .await;
        assert_eq!(unknown.status, StatusCode::BAD_REQUEST, "{}", unknown.body);
        assert_eq!(unknown.body["error"]["code"], "validation_error");
    }
}

fn sha_of(bytes: &[u8]) -> String {
    hex::encode(sha2::Sha256::digest(bytes))
}

fn part_name(sha256: &str) -> String {
    format!("{sha256}.ndjson.gz")
}

/// `bytes` with one byte in the middle changed, so the size stays the same.
fn altered(mut bytes: Vec<u8>) -> Vec<u8> {
    let middle = bytes.len() / 2;
    bytes[middle] ^= 0x01;
    bytes
}

/// The part a manifest names for `entry`, as `(sha256, size_bytes)`.
fn entry_part(manifest: &Value, entry: &str) -> (String, u64) {
    named(manifest)
        .into_iter()
        .find(|(named, _, _)| named == entry)
        .map(|(_, sha256, size)| (sha256, size))
        .unwrap()
}

fn missing_parts(refused: &Reply) -> BTreeSet<String> {
    assert_eq!(refused.status, StatusCode::CONFLICT, "{}", refused.body);
    assert_eq!(refused.body["error"]["code"], "backup_parts_missing");
    refused.body["error"]["details"]["missing_parts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|name| name.as_str().unwrap().to_string())
        .collect()
}

async fn a_part_altered_or_lost_in_the_destination_is_stored_again(place: Place) {
    let origin = Instance::start(&place).await;
    let id = origin.id();
    let (large, _) = fill(&origin).await;
    let first = origin.back_up().await;
    let first_name = first["backup"]["name"].as_str().unwrap().to_string();
    let manifest = place.manifest(&id, &first_name);
    let (large_sha, large_size) = large_part(&place, &id, &manifest, &large);
    let (items_sha, items_size) = entry_part(&manifest, "items.ndjson.gz");
    let (versions_sha, versions_size) = entry_part(&manifest, "versions.ndjson.gz");

    for sha256 in [&large_sha, &items_sha] {
        let bytes = altered(place.part(&id, sha256));
        place.write("backup-parts", &id, &part_name(sha256), &bytes);
    }
    place.remove("backup-parts", &id, &part_name(&versions_sha));
    for sha256 in [&large_sha, &items_sha] {
        assert_ne!(sha_of(&place.part(&id, sha256)), *sha256);
    }
    let refused = Instance::start(&place)
        .await
        .restore(&id, &first_name, "")
        .await;
    assert_eq!(
        missing_parts(&refused),
        BTreeSet::from([part_name(&versions_sha)])
    );

    origin.app.clock.pause(true);
    origin.app.clock.advance(1000).unwrap();
    let second = origin.back_up().await;
    let second_name = second["backup"]["name"].as_str().unwrap().to_string();
    assert_eq!(named(&place.manifest(&id, &second_name)), named(&manifest));
    assert_eq!(
        second["sent_bytes"],
        large_size + items_size + versions_size,
        "{second}"
    );
    for (sha256, size) in place.parts(&id) {
        let bytes = place.part(&id, &sha256);
        assert_eq!(bytes.len() as u64, size);
        assert_eq!(sha_of(&bytes), sha256);
    }
    let health = origin.backups_health().await;
    assert_eq!(health["damaged_parts"], 0, "{health}");
    assert_eq!(health["status"], "ok", "{health}");
    for name in [&first_name, &second_name] {
        let restored = Instance::start(&place).await.restore(&id, name, "").await;
        assert_eq!(restored.status, StatusCode::OK, "{name}: {}", restored.body);
    }
}

#[tokio::test]
async fn a_part_altered_or_lost_in_a_folder_is_stored_again() {
    a_part_altered_or_lost_in_the_destination_is_stored_again(Place::folder().await).await;
}

#[tokio::test]
async fn a_part_altered_or_lost_in_an_object_store_is_stored_again() {
    a_part_altered_or_lost_in_the_destination_is_stored_again(Place::bucket().await).await;
}

async fn a_damaged_part_the_origin_finds_shows_in_health_until_a_backup_stores_it_again(
    place: Place,
) {
    let origin = Instance::start(&place).await;
    let id = origin.id();
    for at in 0..3 {
        origin
            .item("core.note", json!({ "title": format!("note {at}") }))
            .await;
    }
    let answer = origin.back_up().await;
    let name = answer["backup"]["name"].as_str().unwrap().to_string();
    let (items_sha, items_size) = entry_part(&place.manifest(&id, &name), "items.ndjson.gz");
    let health = origin.backups_health().await;
    assert_eq!(health["damaged_parts"], 0, "{health}");
    assert_eq!(health["status"], "ok", "{health}");
    assert!(
        !origin
            .backup_concerns()
            .await
            .contains(&"parts_damaged".to_string())
    );

    let bytes = altered(place.part(&id, &items_sha));
    place.write("backup-parts", &id, &part_name(&items_sha), &bytes);
    let refused = origin.restore(&id, &name, "").await;
    assert_eq!(
        missing_parts(&refused),
        BTreeSet::from([part_name(&items_sha)])
    );
    let health = origin.backups_health().await;
    assert_eq!(health["damaged_parts"], 1, "{health}");
    assert_eq!(health["status"], "failing", "{health}");
    assert!(
        origin
            .backup_concerns()
            .await
            .contains(&"parts_damaged".to_string())
    );
    let public = origin
        .send(
            &origin.public,
            None,
            Method::GET,
            "/health",
            Body::empty(),
            "application/json",
        )
        .await;
    assert_eq!(
        public.body["backups"]["status"], "failing",
        "{}",
        public.body
    );
    assert!(
        public.body["backups"].get("damaged_parts").is_none(),
        "{}",
        public.body
    );

    origin.app.clock.pause(true);
    origin.app.clock.advance(1000).unwrap();
    let again = origin.back_up().await;
    assert_eq!(again["sent_bytes"], items_size, "{again}");
    let health = origin.backups_health().await;
    assert_eq!(health["damaged_parts"], 0, "{health}");
    assert_eq!(health["status"], "ok", "{health}");
    assert!(
        !origin
            .backup_concerns()
            .await
            .contains(&"parts_damaged".to_string())
    );
    let restored = Instance::start(&place).await.restore(&id, &name, "").await;
    assert_eq!(restored.status, StatusCode::OK, "{}", restored.body);
}

#[tokio::test]
async fn a_damaged_part_the_origin_finds_in_a_folder_shows_in_health_until_stored_again() {
    a_damaged_part_the_origin_finds_shows_in_health_until_a_backup_stores_it_again(
        Place::folder().await,
    )
    .await;
}

#[tokio::test]
async fn a_damaged_part_the_origin_finds_in_an_object_store_shows_in_health_until_stored_again() {
    a_damaged_part_the_origin_finds_shows_in_health_until_a_backup_stores_it_again(
        Place::bucket().await,
    )
    .await;
}

/// Health's status and reason as a request with no credential reads them.
async fn public_backups(instance: &Instance) -> Value {
    let public = instance
        .send(
            &instance.public,
            None,
            Method::GET,
            "/health",
            Body::empty(),
            "application/json",
        )
        .await;
    assert_eq!(public.status, StatusCode::OK, "{}", public.body);
    public.body["backups"].clone()
}

async fn turned_off_is_said_while_something_else_fails_backups(place: Place) {
    let origin = Instance::start(&place).await;
    let id = origin.id();
    origin.item("core.note", json!({ "title": "kept" })).await;
    let answer = origin.back_up().await;
    let name = answer["backup"]["name"].as_str().unwrap().to_string();
    let set = origin
        .local(
            Method::PATCH,
            "/config",
            Some(json!({ "backup_interval_seconds": 0 })),
        )
        .await;
    assert_eq!(set.status, StatusCode::OK, "{}", set.body);
    assert_eq!(
        public_backups(&origin).await,
        json!({ "status": "off", "reason": "turned_off" })
    );
    assert_eq!(origin.backup_concerns().await, ["turned_off"]);

    let (items_sha, _) = entry_part(&place.manifest(&id, &name), "items.ndjson.gz");
    let whole = place.part(&id, &items_sha);
    place.write(
        "backup-parts",
        &id,
        &part_name(&items_sha),
        &altered(whole.clone()),
    );
    missing_parts(&origin.restore(&id, &name, "").await);
    let health = origin.backups_health().await;
    assert_eq!(health["damaged_parts"], 1, "{health}");
    assert_eq!(
        public_backups(&origin).await,
        json!({ "status": "failing", "reason": "turned_off" })
    );
    let concerns = origin.backup_concerns().await;
    for reference in ["turned_off", "parts_damaged"] {
        assert!(concerns.contains(&reference.to_string()), "{concerns:?}");
    }
    place.write("backup-parts", &id, &part_name(&items_sha), &whole);
    origin.app.clock.pause(true);
    origin.app.clock.advance(1000).unwrap();
    origin.back_up().await;
    assert_eq!(origin.backups_health().await["damaged_parts"], 0);

    let Place::Folder(folder) = &place else {
        return;
    };
    let away = folder.path().with_extension("away");
    fs::rename(folder.path(), &away).unwrap();
    let gone = public_backups(&origin).await;
    let concerns = origin.backup_concerns().await;
    fs::rename(&away, folder.path()).unwrap();
    assert_eq!(gone, json!({ "status": "failing", "reason": "turned_off" }));
    for reference in ["turned_off", "store"] {
        assert!(concerns.contains(&reference.to_string()), "{concerns:?}");
    }

    assert_eq!(
        public_backups(&origin).await,
        json!({ "status": "off", "reason": "turned_off" })
    );
    origin
        .app
        .faults
        .set("fail:backup-folder-write", None)
        .unwrap();
    origin
        .item("core.note", json!({ "title": "unwritten" }))
        .await;
    origin.app.clock.advance(1000).unwrap();
    let failed = origin.local(Method::POST, "/backups", None).await;
    origin.app.faults.clear(None);
    assert_eq!(
        failed.status,
        StatusCode::SERVICE_UNAVAILABLE,
        "{}",
        failed.body
    );
    assert_eq!(
        public_backups(&origin).await,
        json!({ "status": "failing", "reason": "turned_off" })
    );
    let concerns = origin.backup_concerns().await;
    assert_eq!(concerns, ["turned_off", "run"]);
}

#[tokio::test]
async fn turned_off_is_said_while_a_part_is_damaged_or_the_folder_is_gone() {
    turned_off_is_said_while_something_else_fails_backups(Place::folder().await).await;
}

#[tokio::test]
async fn turned_off_is_said_while_a_part_in_an_object_store_is_damaged() {
    turned_off_is_said_while_something_else_fails_backups(Place::bucket().await).await;
}

#[tokio::test]
async fn an_object_store_part_is_trusted_by_the_etag_of_the_bytes_that_were_hashed() {
    let place = Place::bucket().await;
    let Place::Bucket(store) = &place else {
        unreachable!()
    };
    let origin = Instance::start(&place).await;
    let id = origin.id();
    origin.item("core.note", json!({ "title": "first" })).await;
    let first = origin.back_up().await;
    let first_name = first["backup"]["name"].as_str().unwrap().to_string();
    let (old_items, _) = entry_part(&place.manifest(&id, &first_name), "items.ndjson.gz");
    origin.app.clock.pause(true);
    origin.item("core.note", json!({ "title": "second" })).await;
    origin.app.clock.advance(1000).unwrap();
    origin.back_up().await;
    let key = Place::key("backup-parts", &id, &part_name(&old_items));
    let good = store.stored(&key).unwrap();
    store.put_object(&key, &altered(place.part(&id, &old_items)));
    let damaged = store.stored(&key).unwrap();

    // The listing gives the damaged object's ETag; a write lands before the check reads it.
    store.replace_before_next_get(&key, good);
    origin.app.clock.advance(1000).unwrap();
    origin.back_up().await;
    assert_eq!(origin.backups_health().await["damaged_parts"], 0);

    // The damaged bytes come back, as a write of the same bytes gives the same ETag.
    store.restore(&key, damaged);
    origin.app.clock.advance(1000).unwrap();
    origin.back_up().await;
    let health = origin.backups_health().await;
    assert_eq!(health["damaged_parts"], 1, "{health}");
    let refused = Instance::start(&place)
        .await
        .restore(&id, &first_name, "")
        .await;
    assert_eq!(
        missing_parts(&refused),
        BTreeSet::from([part_name(&old_items)])
    );
}

/// Changes one byte in the middle of each file the server has spooled, keeping its size.
fn alter_spools(instance: &Instance) -> usize {
    let mut altered_spools = 0;
    for entry in fs::read_dir(instance.dir.path().join("blobs").join("tmp")).unwrap() {
        let path = entry.unwrap().path();
        let bytes = fs::read(&path).unwrap();
        if path.is_file() && !bytes.is_empty() {
            fs::write(&path, altered(bytes)).unwrap();
            altered_spools += 1;
        }
    }
    altered_spools
}

async fn a_part_changed_on_the_servers_disk_before_it_is_stored_fails_the_backup(place: Place) {
    let origin = Arc::new(Instance::start(&place).await);
    let id = origin.id();
    fill(&origin).await;
    origin.app.faults.set("hold:backup:read", None).unwrap();
    let running = origin.clone();
    let run = tokio::spawn(async move { running.local(Method::POST, "/backups", None).await });
    until("the backup to hold", || {
        origin
            .app
            .faults
            .list()
            .iter()
            .any(|fault| fault.waiting > 0)
    })
    .await;
    assert!(alter_spools(&origin) > 0);
    origin.app.faults.clear(None);
    let refused = run.await.unwrap();
    assert_eq!(
        refused.status,
        StatusCode::INTERNAL_SERVER_ERROR,
        "{}",
        refused.body
    );
    assert!(place.names("backups", &id).is_empty());
    for (sha256, _) in place.parts(&id) {
        assert_eq!(sha_of(&place.part(&id, &sha256)), sha256);
    }
    let health = origin.backups_health().await;
    assert_eq!(health["failures"], 1, "{health}");
    assert!(health["store_error"].is_null(), "{health}");

    let put = origin.back_up().await;
    let name = put["backup"]["name"].as_str().unwrap().to_string();
    for (sha256, _) in place.parts(&id) {
        assert_eq!(sha_of(&place.part(&id, &sha256)), sha256);
    }
    let restored = Instance::start(&place).await.restore(&id, &name, "").await;
    assert_eq!(restored.status, StatusCode::OK, "{}", restored.body);
}

#[tokio::test]
async fn a_part_changed_on_the_servers_disk_before_it_reaches_a_folder_fails_the_backup() {
    a_part_changed_on_the_servers_disk_before_it_is_stored_fails_the_backup(Place::folder().await)
        .await;
}

#[tokio::test]
async fn a_part_changed_on_the_servers_disk_before_it_reaches_an_object_store_fails_the_backup() {
    a_part_changed_on_the_servers_disk_before_it_is_stored_fails_the_backup(Place::bucket().await)
        .await;
}

/// Writes `bytes` over the file at `path` in place, and gives it back the modified time it had.
fn rewrite_keeping_time(path: &std::path::Path, bytes: &[u8]) {
    let modified = fs::metadata(path).unwrap().modified().unwrap();
    fs::write(path, bytes).unwrap();
    fs::File::options()
        .write(true)
        .open(path)
        .unwrap()
        .set_modified(modified)
        .unwrap();
}

#[tokio::test]
async fn a_folder_part_is_read_when_its_size_time_or_inode_change_or_when_its_check_is_due() {
    let place = Place::folder().await;
    let origin = Instance::start(&place).await;
    let id = origin.id();
    let (large, _) = fill(&origin).await;
    let first = origin.back_up().await;
    let first_name = first["backup"]["name"].as_str().unwrap().to_string();
    let manifest = place.manifest(&id, &first_name);
    let (large_sha, large_size) = large_part(&place, &id, &manifest, &large);
    let (items_sha, items_size) = entry_part(&manifest, "items.ndjson.gz");
    origin.app.clock.pause(true);

    let large_path = place.path("backup-parts", &id, &part_name(&large_sha));
    let inode = std::os::unix::fs::MetadataExt::ino(&fs::metadata(&large_path).unwrap());
    rewrite_keeping_time(&large_path, &altered(place.part(&id, &large_sha)));
    assert_eq!(
        std::os::unix::fs::MetadataExt::ino(&fs::metadata(&large_path).unwrap()),
        inode
    );
    origin.app.clock.advance(1000).unwrap();
    let unread = origin.back_up().await;
    assert_eq!(unread["sent_bytes"], 0, "{unread}");
    let unread_name = unread["backup"]["name"].as_str().unwrap().to_string();
    let refused = Instance::start(&place)
        .await
        .restore(&id, &unread_name, "")
        .await;
    assert_eq!(
        missing_parts(&refused),
        BTreeSet::from([part_name(&large_sha)])
    );

    let items_path = place.path("backup-parts", &id, &part_name(&items_sha));
    fs::write(&items_path, altered(place.part(&id, &items_sha))).unwrap();
    origin.app.clock.advance(1000).unwrap();
    let touched = origin.back_up().await;
    assert_eq!(touched["sent_bytes"], items_size, "{touched}");

    origin.app.clock.advance(8 * DAY_MS).unwrap();
    let due = origin.back_up().await;
    assert_eq!(due["sent_bytes"], large_size, "{due}");
    for (sha256, _) in place.parts(&id) {
        assert_eq!(sha_of(&place.part(&id, &sha256)), sha256);
    }
    let due_name = due["backup"]["name"].as_str().unwrap().to_string();
    let restored = Instance::start(&place)
        .await
        .restore(&id, &due_name, "")
        .await;
    assert_eq!(restored.status, StatusCode::OK, "{}", restored.body);
}

#[tokio::test]
async fn an_object_store_part_is_taken_as_whole_only_while_it_keeps_the_etag_it_was_stored_with() {
    let place = Place::bucket().await;
    let Place::Bucket(store) = &place else {
        unreachable!()
    };
    let origin = Instance::start(&place).await;
    let id = origin.id();
    fill(&origin).await;
    let first = origin.back_up().await;
    let first_name = first["backup"]["name"].as_str().unwrap().to_string();
    let manifest = place.manifest(&id, &first_name);
    let (items_sha, _) = entry_part(&manifest, "items.ndjson.gz");
    let gets = |sha256: &str| {
        store.requests(
            &Method::GET,
            &Place::key("backup-parts", &id, &part_name(sha256)),
        )
    };
    let all_gets = || {
        named(&manifest)
            .iter()
            .map(|(_, sha256, _)| gets(sha256))
            .sum::<usize>()
    };
    origin.app.clock.pause(true);

    let before = all_gets();
    origin.app.clock.advance(1000).unwrap();
    let again = origin.back_up().await;
    assert_eq!(again["sent_bytes"], 0, "{again}");
    assert_eq!(all_gets(), before, "a part with its stored ETag was read");

    let bytes = place.part(&id, &items_sha);
    let read_before = gets(&items_sha);
    place.write("backup-parts", &id, &part_name(&items_sha), &bytes);
    origin.app.clock.advance(1000).unwrap();
    let rewritten = origin.back_up().await;
    assert_eq!(rewritten["sent_bytes"], 0, "{rewritten}");
    assert_eq!(gets(&items_sha), read_before + 1);
    assert_eq!(origin.backups_health().await["damaged_parts"], 0);
    let before = all_gets();
    origin.app.clock.advance(1000).unwrap();
    origin.back_up().await;
    assert_eq!(
        all_gets(),
        before,
        "the ETag a check found was not recorded"
    );

    // A store that changes an object's bytes and keeps its ETag goes unseen until a restore.
    let key = Place::key("backup-parts", &id, &part_name(&items_sha));
    store.rot_object(&key, &altered(bytes));
    origin.app.clock.advance(1000).unwrap();
    let rotted = origin.back_up().await;
    assert_eq!(rotted["sent_bytes"], 0, "{rotted}");
    let rotted_name = rotted["backup"]["name"].as_str().unwrap().to_string();
    let refused = Instance::start(&place)
        .await
        .restore(&id, &rotted_name, "")
        .await;
    assert_eq!(
        missing_parts(&refused),
        BTreeSet::from([part_name(&items_sha)])
    );
}

async fn a_part_only_an_older_backup_names_shows_in_health_once_rewritten(place: Place) {
    let origin = Instance::start(&place).await;
    let id = origin.id();
    origin.item("core.note", json!({ "title": "first" })).await;
    let first = origin.back_up().await;
    let first_name = first["backup"]["name"].as_str().unwrap().to_string();
    let (old_items, _) = entry_part(&place.manifest(&id, &first_name), "items.ndjson.gz");
    origin.app.clock.pause(true);
    origin.item("core.note", json!({ "title": "second" })).await;
    origin.app.clock.advance(1000).unwrap();
    let second = origin.back_up().await;
    let second_name = second["backup"]["name"].as_str().unwrap().to_string();
    let (new_items, _) = entry_part(&place.manifest(&id, &second_name), "items.ndjson.gz");
    assert_ne!(old_items, new_items);
    let health = origin.backups_health().await;
    assert_eq!(health["damaged_parts"], 0, "{health}");

    let bytes = altered(place.part(&id, &old_items));
    place.write("backup-parts", &id, &part_name(&old_items), &bytes);
    origin.app.clock.advance(1000).unwrap();
    origin.back_up().await;
    let health = origin.backups_health().await;
    assert_eq!(health["damaged_parts"], 1, "{health}");
    assert_eq!(health["status"], "failing", "{health}");
    assert!(
        origin
            .backup_concerns()
            .await
            .contains(&"parts_damaged".to_string())
    );
    let refused = Instance::start(&place)
        .await
        .restore(&id, &first_name, "")
        .await;
    assert_eq!(
        missing_parts(&refused),
        BTreeSet::from([part_name(&old_items)])
    );
}

#[tokio::test]
async fn a_part_only_an_older_backup_names_in_a_folder_shows_in_health_once_rewritten() {
    a_part_only_an_older_backup_names_shows_in_health_once_rewritten(Place::folder().await).await;
}

#[tokio::test]
async fn a_part_only_an_older_backup_names_in_an_object_store_shows_in_health_once_rewritten() {
    a_part_only_an_older_backup_names_shows_in_health_once_rewritten(Place::bucket().await).await;
}

/// Two backups a day apart, the second after a note is added. Answers the manifest of each.
async fn two_days(origin: &Instance, place: &Place) -> (Value, Value) {
    let id = origin.id();
    origin.app.clock.pause(true);
    origin.item("core.note", json!({ "title": "first" })).await;
    let first = origin.back_up().await;
    let first = place.manifest(&id, first["backup"]["name"].as_str().unwrap());
    origin.item("core.note", json!({ "title": "second" })).await;
    origin.app.clock.advance(DAY_MS).unwrap();
    let second = origin.back_up().await;
    let second = place.manifest(&id, second["backup"]["name"].as_str().unwrap());
    (first, second)
}

#[tokio::test]
async fn a_due_folder_part_only_an_older_backup_names_is_hashed_though_a_manifest_does_not_read() {
    let place = Place::folder().await;
    let origin = Instance::start(&place).await;
    let id = origin.id();
    let (first, second) = two_days(&origin, &place).await;
    let (old_items, _) = entry_part(&first, "items.ndjson.gz");
    assert_ne!(old_items, entry_part(&second, "items.ndjson.gz").0);

    place.write("backups", &id, FOUND, b"not a manifest");
    let stray = b"a part no backup names";
    place.write("backup-parts", &id, &part_name(&sha_of(stray)), stray);
    let old_path = place.path("backup-parts", &id, &part_name(&old_items));
    rewrite_keeping_time(&old_path, &altered(place.part(&id, &old_items)));
    origin.app.clock.advance(8 * DAY_MS).unwrap();
    origin.back_up().await;
    assert!(
        place
            .names("backup-parts", &id)
            .contains(&part_name(&sha_of(stray))),
        "clean-up read every manifest"
    );
    let health = origin.backups_health().await;
    assert_eq!(health["damaged_parts"], 1, "{health}");
    assert_eq!(health["status"], "failing", "{health}");
}

async fn a_damaged_part_is_not_read_again_while_it_keeps_the_tag_it_was_found_with(place: Place) {
    let origin = Instance::start(&place).await;
    let id = origin.id();
    let (first, _) = two_days(&origin, &place).await;
    let (old_items, _) = entry_part(&first, "items.ndjson.gz");
    let gets = || match &place {
        Place::Bucket(store) => store.requests(
            &Method::GET,
            &Place::key("backup-parts", &id, &part_name(&old_items)),
        ),
        Place::Folder(_) => 0,
    };
    let whole = place.part(&id, &old_items);
    place.write(
        "backup-parts",
        &id,
        &part_name(&old_items),
        &altered(whole.clone()),
    );
    origin.app.clock.advance(1000).unwrap();
    origin.back_up().await;
    assert_eq!(origin.backups_health().await["damaged_parts"], 1);
    let found = origin.hashed_at(&old_items).await;
    assert!(found.is_some());
    let read = gets();

    origin.app.clock.advance(1000).unwrap();
    origin.back_up().await;
    assert_eq!(origin.backups_health().await["damaged_parts"], 1);
    assert_eq!(origin.hashed_at(&old_items).await, found);
    assert_eq!(gets(), read);

    place.write("backup-parts", &id, &part_name(&old_items), &whole);
    origin.app.clock.advance(1000).unwrap();
    origin.back_up().await;
    let health = origin.backups_health().await;
    assert_eq!(health["damaged_parts"], 0, "{health}");
    assert_ne!(origin.hashed_at(&old_items).await, found);
}

#[tokio::test]
async fn a_damaged_folder_part_is_not_read_again_while_it_keeps_its_stamp() {
    a_damaged_part_is_not_read_again_while_it_keeps_the_tag_it_was_found_with(
        Place::folder().await,
    )
    .await;
}

#[tokio::test]
async fn a_damaged_object_store_part_is_not_read_again_while_it_keeps_its_etag() {
    a_damaged_part_is_not_read_again_while_it_keeps_the_tag_it_was_found_with(
        Place::bucket().await,
    )
    .await;
}

#[tokio::test]
async fn a_folder_part_that_cannot_be_read_is_damaged_and_stored_again_where_a_backup_needs_it() {
    use std::os::unix::fs::PermissionsExt;

    let place = Place::folder().await;
    let origin = Instance::start(&place).await;
    let id = origin.id();
    let (first, second) = two_days(&origin, &place).await;
    let (old_items, _) = entry_part(&first, "items.ndjson.gz");
    let (_, shared, shared_size) = named(&second)
        .into_iter()
        .find(|(_, sha256, _)| named(&first).iter().any(|(_, old, _)| old == sha256))
        .expect("a part both backups name");
    for sha256 in [&old_items, &shared] {
        let path = place.path("backup-parts", &id, &part_name(sha256));
        fs::set_permissions(&path, fs::Permissions::from_mode(0o000)).unwrap();
        assert!(fs::read(&path).is_err(), "a part without permissions read");
    }

    origin.app.clock.advance(8 * DAY_MS).unwrap();
    let third = origin.back_up().await;
    assert_eq!(third["sent_bytes"], shared_size, "{third}");
    assert_eq!(sha_of(&place.part(&id, &shared)), shared);
    let health = origin.backups_health().await;
    assert_eq!(health["damaged_parts"], 1, "{health}");
    assert_eq!(health["status"], "failing", "{health}");
    assert!(
        origin
            .backup_concerns()
            .await
            .contains(&"parts_damaged".to_string())
    );
    let third_name = third["backup"]["name"].as_str().unwrap().to_string();
    let restored = Instance::start(&place)
        .await
        .restore(&id, &third_name, "")
        .await;
    assert_eq!(restored.status, StatusCode::OK, "{}", restored.body);
}

#[tokio::test]
async fn a_due_part_no_backup_names_is_not_found_damaged_when_its_delete_fails() {
    use std::os::unix::fs::PermissionsExt;

    let place = Place::folder().await;
    let origin = Instance::start(&place).await;
    let id = origin.id();
    origin.app.clock.pause(true);
    origin.item("core.note", json!({ "title": "first" })).await;
    let first = origin.back_up().await;
    let first_name = first["backup"]["name"].as_str().unwrap().to_string();
    let (old_items, _) = entry_part(&place.manifest(&id, &first_name), "items.ndjson.gz");
    origin.item("core.note", json!({ "title": "second" })).await;
    origin.app.clock.advance(DAY_MS).unwrap();
    let second = origin.back_up().await;
    let second = place.manifest(&id, second["backup"]["name"].as_str().unwrap());
    assert_ne!(old_items, entry_part(&second, "items.ndjson.gz").0);

    place.remove("backups", &id, &first_name);
    let old_path = place.path("backup-parts", &id, &part_name(&old_items));
    rewrite_keeping_time(&old_path, &altered(place.part(&id, &old_items)));
    let parts = old_path.parent().unwrap().to_path_buf();
    fs::set_permissions(&parts, fs::Permissions::from_mode(0o555)).unwrap();
    let locked = fs::write(parts.join("probe"), b"probe").is_err();
    origin.app.clock.advance(8 * DAY_MS).unwrap();
    let third = origin.back_up().await;
    fs::set_permissions(&parts, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(locked, "a folder without write permission took a file");

    assert_eq!(third["sent_bytes"], 0, "{third}");
    assert!(old_path.exists(), "a part no backup names was deleted");
    let health = origin.backups_health().await;
    assert_eq!(health["damaged_parts"], 0, "{health}");
    assert_eq!(origin.hashed_at(&old_items).await, None);
}

const FOUND: &str = "20200101T000000.000Z.json";

async fn a_found_backup_keeps_its_parts_until_the_server_forgets_it(place: Place) {
    let origin = Instance::start(&place).await;
    let id = origin.id();
    origin.item("core.note", json!({ "title": "kept" })).await;
    let first = origin.back_up().await;
    let first_name = first["backup"]["name"].as_str().unwrap().to_string();
    let extra = b"a part only the found backup names".to_vec();
    let extra_sha = sha_of(&extra);
    place.write("backup-parts", &id, &part_name(&extra_sha), &extra);
    let mut found = place.manifest(&id, &first_name);
    found["parts"].as_array_mut().unwrap().push(json!({
        "entry": ROWS, "sha256": extra_sha, "size_bytes": extra.len(), "lines": 0,
    }));
    place.write("backups", &id, FOUND, &serde_json::to_vec(&found).unwrap());

    origin.app.clock.pause(true);
    origin.app.clock.advance(1000).unwrap();
    origin.back_up().await;
    assert_eq!(origin.count("SELECT count(*) FROM found_backups").await, 1);
    assert!(place.parts(&id).contains_key(&extra_sha));

    // A backup omitted from listings is forgotten once thinning would have deleted it, so a
    // backup a day for more days than are kept.
    place.remove("backups", &id, FOUND);
    let mut held_while_omitted = 0;
    for _ in 0..40 {
        origin.app.clock.advance(DAY_MS).unwrap();
        origin.back_up().await;
        if origin.count("SELECT count(*) FROM found_backups").await == 0 {
            break;
        }
        assert!(
            place.parts(&id).contains_key(&extra_sha),
            "a part a found backup names was deleted while the server held it"
        );
        held_while_omitted += 1;
    }
    assert!(held_while_omitted >= 3, "{held_while_omitted}");
    assert_eq!(origin.count("SELECT count(*) FROM found_backups").await, 0);
    origin.app.clock.advance(1000).unwrap();
    origin.back_up().await;
    assert!(!place.parts(&id).contains_key(&extra_sha));
}

#[tokio::test]
async fn a_found_backup_keeps_its_parts_in_a_folder_until_the_server_forgets_it() {
    a_found_backup_keeps_its_parts_until_the_server_forgets_it(Place::folder().await).await;
}

#[tokio::test]
async fn a_found_backup_keeps_its_parts_in_an_object_store_until_the_server_forgets_it() {
    a_found_backup_keeps_its_parts_until_the_server_forgets_it(Place::bucket().await).await;
}

/// Waits until `done` holds.
async fn until(what: &str, done: impl Fn() -> bool) {
    let began = std::time::Instant::now();
    while !done() {
        assert!(began.elapsed() < Duration::from_secs(60), "{what}");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

#[tokio::test]
async fn a_backup_asked_for_during_a_restore_says_a_restore_is_running() {
    let place = Place::bucket().await;
    let Place::Bucket(store) = &place else {
        unreachable!()
    };
    let origin = Arc::new(Instance::start(&place).await);
    let id = origin.id();
    origin.item("core.note", json!({ "title": "held" })).await;
    let answer = origin.back_up().await;
    let name = answer["backup"]["name"].as_str().unwrap().to_string();

    origin.app.faults.set("hold:backup:put", None).unwrap();
    let running = origin.clone();
    let run = tokio::spawn(async move { running.local(Method::POST, "/backups", None).await });
    until("the backup to hold", || {
        origin
            .app
            .faults
            .list()
            .iter()
            .any(|fault| fault.waiting > 0)
    })
    .await;
    let busy = origin.local(Method::POST, "/backups", None).await;
    assert_eq!(busy.status, StatusCode::CONFLICT, "{}", busy.body);
    assert_eq!(
        busy.body["error"]["message"],
        "A backup is running; try again once it ends."
    );
    origin.app.faults.clear(None);
    assert_eq!(run.await.unwrap().status, StatusCode::OK);

    let fresh = Arc::new(Instance::start(&place).await);
    let manifest_key = Place::key("backups", &id, &name);
    store.set_mode(fake_s3::Mode::Trickle(3));
    let restoring = fresh.clone();
    let (instance, backup) = (id.clone(), name.clone());
    let restore =
        tokio::spawn(async move { restoring.restore(&instance, &backup, "").await.status });
    until("the restore to read the manifest", || {
        store.requests(&Method::GET, &manifest_key) > 0
    })
    .await;
    let busy = fresh.local(Method::POST, "/backups", None).await;
    store.set_mode(fake_s3::Mode::Normal);
    assert_eq!(busy.status, StatusCode::CONFLICT, "{}", busy.body);
    assert_eq!(busy.body["error"]["code"], "housekeeping_job_running");
    assert_eq!(
        busy.body["error"]["message"],
        "A restore is reading a backup; try again once it ends."
    );
    assert_eq!(restore.await.unwrap(), StatusCode::OK);
}
