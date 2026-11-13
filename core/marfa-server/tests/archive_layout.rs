//! The archive's layout: what each entry holds, that no line grows with an item's history, what a
//! restore does with an entry it does not know, and which manifests it reads.

use std::io::{Read, Write};
use std::path::Path;
use std::sync::Arc;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Method, Request, StatusCode, header};
use flate2::Compression;
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use marfa_server::app::App;
use marfa_server::app::archive;
use marfa_server::http::{control, public};
use marfa_server::settings::{Environment, Settings};
use serde_json::{Map, Value, json};
use tempfile::TempDir;
use tower::ServiceExt;

const BLOCK: usize = 512;
const MEGABYTE: usize = 1_000_000;

struct Instance {
    _data: TempDir,
    app: Arc<App>,
    control: Router,
    public: Router,
    writer: String,
}

struct Reply {
    status: StatusCode,
    body: Value,
    bytes: Vec<u8>,
}

impl Instance {
    async fn start(folder: &Path, more: &[(&str, &str)]) -> Instance {
        let data = TempDir::new().unwrap();
        let database = data.path().join("marfa.db");
        let blobs = data.path().join("blobs");
        let socket = data.path().join("s.sock");
        let mut pairs = vec![
            ("MARFA_DATABASE_PATH", database.to_str().unwrap()),
            ("MARFA_BLOB_PATH", blobs.to_str().unwrap()),
            ("MARFA_CONTROL_SOCKET", socket.to_str().unwrap()),
            ("MARFA_BACKUP_PATH", folder.to_str().unwrap()),
            ("MARFA_BACKUP_INTERVAL_SECONDS", "31536000"),
            ("MARFA_TEST_HOOKS", "true"),
            ("MARFA_RATE_LIMIT_ENABLED", "false"),
        ];
        pairs.extend_from_slice(more);
        let settings = Settings::read(Environment::from_pairs(&pairs)).unwrap();
        let app = App::start(settings).await.unwrap();
        let mut instance = Instance {
            control: control(app.clone()),
            public: public(app.clone()),
            app,
            _data: data,
            writer: String::new(),
        };
        let minted = instance
            .local(
                Method::POST,
                "/keys",
                json!({
                    "label": "writer",
                    "source": format!("writer-{}", uuid::Uuid::now_v7()),
                    "permissions": ["blobs.manage"],
                    "type_permissions": { "*": "write" },
                    "edge_permissions": { "*": "write" },
                }),
            )
            .await;
        assert_eq!(minted.status, StatusCode::CREATED, "{}", minted.body);
        instance.writer = minted.body["key"].as_str().unwrap().to_string();
        instance
    }

    async fn call(
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

    async fn local(&self, method: Method, path: &str, body: Value) -> Reply {
        let body = Body::from(body.to_string());
        self.call(&self.control, None, method, path, body, "application/json")
            .await
    }

    async fn keyed(&self, method: Method, path: &str, body: Value) -> Reply {
        let key = Some(self.writer.as_str());
        let body = Body::from(body.to_string());
        self.call(&self.public, key, method, path, body, "application/json")
            .await
    }

    async fn upload(&self, bytes: &[u8]) -> String {
        let key = Some(self.writer.as_str());
        let body = Body::from(bytes.to_vec());
        let stored = self
            .call(
                &self.public,
                key,
                Method::POST,
                "/blobs",
                body,
                "text/plain",
            )
            .await;
        assert_eq!(stored.status, StatusCode::CREATED, "{}", stored.body);
        stored.body["hash"].as_str().unwrap().to_string()
    }

    async fn note(&self, body: &str) -> String {
        let made = self
            .keyed(
                Method::POST,
                "/items",
                json!({ "type": "core.note", "properties": { "body": body } }),
            )
            .await;
        assert_eq!(made.status, StatusCode::CREATED, "{}", made.body);
        made.body["item"]["id"].as_str().unwrap().to_string()
    }

    async fn edit(&self, id: &str, version: u64, body: &str) {
        let changed = self
            .keyed(
                Method::PATCH,
                &format!("/items/{id}"),
                json!({ "version": version, "properties": { "body": body } }),
            )
            .await;
        assert_eq!(changed.status, StatusCode::OK, "{}", changed.body);
    }

    async fn versions(&self, id: &str) -> Vec<Value> {
        let mut held = Vec::new();
        let mut path = format!("/items/{id}/versions?limit=200");
        loop {
            let listed = self.keyed(Method::GET, &path, json!({})).await;
            assert_eq!(listed.status, StatusCode::OK, "{}", listed.body);
            held.extend(listed.body["data"].as_array().unwrap().iter().cloned());
            match listed.body["next_cursor"].as_str() {
                Some(cursor) => path = format!("/items/{id}/versions?limit=200&cursor={cursor}"),
                None => return held,
            }
        }
    }

    async fn export(&self) -> Reply {
        let key = Some(self.writer.as_str());
        self.call(
            &self.public,
            key,
            Method::GET,
            "/export?format=archive",
            Body::empty(),
            "application/json",
        )
        .await
    }

    async fn archive(&self) -> Vec<u8> {
        let exported = self.export().await;
        assert_eq!(exported.status, StatusCode::OK, "{}", exported.body);
        exported.bytes
    }

    async fn restore(&self, archive: Vec<u8>) -> Reply {
        self.call(
            &self.control,
            None,
            Method::POST,
            "/restore",
            Body::from(archive),
            "application/x-tar",
        )
        .await
    }

    async fn back_up(&self) -> Reply {
        self.local(Method::POST, "/backups", json!({})).await
    }

    async fn restore_backup(&self, instance: &str, name: &str) -> Reply {
        self.local(
            Method::POST,
            &format!("/backups/{instance}/{name}/restore"),
            json!({}),
        )
        .await
    }
}

/// A ustar header for a file `name` of `size` bytes, of tar type `kind`.
fn header(name: &str, size: usize, kind: u8) -> Vec<u8> {
    let mut block = vec![0u8; BLOCK];
    block[..name.len()].copy_from_slice(name.as_bytes());
    block[100..107].copy_from_slice(b"0000644");
    block[124..135].copy_from_slice(format!("{size:011o}").as_bytes());
    block[156] = kind;
    block[257..263].copy_from_slice(b"ustar\0");
    block[263..265].copy_from_slice(b"00");
    block[148..156].copy_from_slice(b"        ");
    let sum: u32 = block.iter().map(|byte| u32::from(*byte)).sum();
    block[148..155].copy_from_slice(format!("{sum:06o}\0").as_bytes());
    block
}

/// Each entry of a tar, by name and bytes, in order.
fn entries(tar: &[u8]) -> Vec<(String, Vec<u8>)> {
    let mut found = Vec::new();
    let mut at = 0;
    while at + BLOCK <= tar.len() && tar[at..at + BLOCK].iter().any(|byte| *byte != 0) {
        let block = &tar[at..at + BLOCK];
        let name_end = block[..100]
            .iter()
            .position(|byte| *byte == 0)
            .unwrap_or(100);
        let name = String::from_utf8(block[..name_end].to_vec()).unwrap();
        let octal = String::from_utf8_lossy(&block[124..136]);
        let size =
            usize::from_str_radix(octal.trim_matches(|c: char| c == '\0' || c == ' '), 8).unwrap();
        found.push((name, tar[at + BLOCK..at + BLOCK + size].to_vec()));
        at += BLOCK + size.div_ceil(BLOCK) * BLOCK;
    }
    found
}

fn tar(entries: &[(String, Vec<u8>)]) -> Vec<u8> {
    let mut out = Vec::new();
    for (name, body) in entries {
        out.extend(header(name, body.len(), b'0'));
        out.extend_from_slice(body);
        out.resize(out.len().div_ceil(BLOCK) * BLOCK, 0);
    }
    out.resize(out.len() + 2 * BLOCK, 0);
    out
}

fn names(entries: &[(String, Vec<u8>)]) -> Vec<String> {
    entries.iter().map(|(name, _)| name.clone()).collect()
}

fn lines(gzipped: &[u8]) -> Vec<Value> {
    let mut text = String::new();
    GzDecoder::new(gzipped).read_to_string(&mut text).unwrap();
    text.lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

fn gzip(lines: &[Value]) -> Vec<u8> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    for line in lines {
        encoder.write_all(line.to_string().as_bytes()).unwrap();
        encoder.write_all(b"\n").unwrap();
    }
    encoder.finish().unwrap()
}

fn manifest_of(entries: &[(String, Vec<u8>)]) -> Map<String, Value> {
    let (name, body) = &entries[0];
    assert_eq!(name, "manifest.json");
    serde_json::from_slice(body).unwrap()
}

fn with_manifest(
    mut entries: Vec<(String, Vec<u8>)>,
    change: impl FnOnce(&mut Map<String, Value>),
) -> Vec<u8> {
    let mut manifest = manifest_of(&entries);
    change(&mut manifest);
    entries[0].1 = serde_json::to_vec(&manifest).unwrap();
    tar(&entries)
}

fn sorted_keys(value: &Value) -> Vec<String> {
    let mut keys: Vec<String> = value.as_object().unwrap().keys().cloned().collect();
    keys.sort();
    keys
}

fn text_of(seed: usize, bytes: usize) -> String {
    let letter = char::from(b'a' + (seed % 26) as u8);
    format!("{seed:04}{}", letter.to_string().repeat(bytes - 4))
}

/// 71 versions of 1 MB, more history than one line may hold, back up and restore whole.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_item_whose_history_is_larger_than_a_line_backs_up_and_restores_whole() {
    let folder = TempDir::new().unwrap();
    let origin = Instance::start(folder.path(), &[]).await;
    let id = origin.note(&text_of(0, MEGABYTE)).await;
    for edit in 1..71u64 {
        origin
            .edit(&id, edit, &text_of(edit as usize, MEGABYTE))
            .await;
    }
    let history = origin.versions(&id).await;
    assert_eq!(history.len(), 70);

    let backed_up = origin.back_up().await;
    assert_eq!(backed_up.status, StatusCode::OK, "{}", backed_up.body);
    let name = backed_up.body["backup"]["name"]
        .as_str()
        .unwrap()
        .to_string();
    let fresh = Instance::start(folder.path(), &[]).await;
    let restored = fresh.restore_backup(&origin.app.instance_id, &name).await;
    assert_eq!(restored.status, StatusCode::OK, "{}", restored.body);
    assert_eq!(restored.body["imported"], 1, "{}", restored.body);
    let read = fresh
        .keyed(Method::GET, &format!("/items/{id}"), json!({}))
        .await;
    assert_eq!(read.body["item"]["version"], 71, "{}", read.body);
    assert_eq!(
        read.body["item"]["properties"]["body"],
        text_of(70, MEGABYTE)
    );
    assert_eq!(fresh.versions(&id).await, history);

    let again = Instance::start(folder.path(), &[]).await;
    let restored = again.restore(origin.archive().await).await;
    assert_eq!(restored.status, StatusCode::OK, "{}", restored.body);
    assert_eq!(again.versions(&id).await, history);
}

/// An item and its one earlier version, each as large as a write takes, back up and restore.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_item_whose_versions_are_each_as_large_as_a_write_takes_backs_up_and_restores() {
    let folder = TempDir::new().unwrap();
    let cap = archive::LINE_CAP / 2;
    let (cap_text, request_text) = (cap.to_string(), (2 * cap).to_string());
    let settings = [
        ("MARFA_MAX_BULK_REQUEST_BYTES", cap_text.as_str()),
        ("MARFA_MAX_REQUEST_BYTES", request_text.as_str()),
    ];
    let origin = Instance::start(folder.path(), &settings).await;
    let wrapping = json!({ "body": "large", "extra": "" }).to_string().len();
    let at_cap = |seed| json!({ "body": "large", "extra": text_of(seed, cap - wrapping) });
    assert_eq!(at_cap(1).to_string().len(), cap);
    let made = origin
        .keyed(
            Method::POST,
            "/items",
            json!({ "type": "core.note", "properties": at_cap(1) }),
        )
        .await;
    assert_eq!(made.status, StatusCode::CREATED, "{}", made.body);
    let id = made.body["item"]["id"].as_str().unwrap().to_string();
    let changed = origin
        .keyed(
            Method::PATCH,
            &format!("/items/{id}"),
            json!({ "version": 1, "properties": at_cap(2) }),
        )
        .await;
    assert_eq!(changed.status, StatusCode::OK, "{}", changed.body);

    let backed_up = origin.back_up().await;
    assert_eq!(backed_up.status, StatusCode::OK, "{}", backed_up.body);
    let name = backed_up.body["backup"]["name"]
        .as_str()
        .unwrap()
        .to_string();
    let fresh = Instance::start(folder.path(), &settings).await;
    let restored = fresh.restore_backup(&origin.app.instance_id, &name).await;
    assert_eq!(restored.status, StatusCode::OK, "{}", restored.body);
    let history = fresh.versions(&id).await;
    assert_eq!(history.len(), 1);
    assert_eq!(history[0]["properties"], at_cap(1));
}

#[tokio::test]
async fn the_bulk_limit_may_not_be_set_above_what_one_line_holds() {
    let folder = TempDir::new().unwrap();
    let instance = Instance::start(folder.path(), &[]).await;
    let half = archive::LINE_CAP / 2;
    let set = |value: usize| json!({ "max_bulk_request_bytes": value });
    let refused = instance
        .local(Method::PATCH, "/config", set(half + 1))
        .await;
    assert_eq!(refused.status, StatusCode::BAD_REQUEST, "{}", refused.body);
    let taken = instance.local(Method::PATCH, "/config", set(half)).await;
    assert_eq!(taken.status, StatusCode::OK, "{}", taken.body);
}

/// The layout of archive version 1. A change to any of it raises `VERSION`, and this pin with it.
#[tokio::test]
async fn the_layout_is_pinned_to_its_version() {
    assert_eq!(archive::VERSION, 1);
    let folder = TempDir::new().unwrap();
    let origin = Instance::start(folder.path(), &[]).await;
    let hash = origin.upload(b"a file the archive carries").await;
    let file = origin
        .keyed(
            Method::POST,
            "/items",
            json!({ "type": "core.file", "properties": { "blob_ref": hash, "mime_type": "text/plain" } }),
        )
        .await;
    assert_eq!(file.status, StatusCode::CREATED, "{}", file.body);
    let note = origin.note("first").await;
    origin.edit(&note, 1, "second").await;
    let conversation = origin
        .keyed(
            Method::POST,
            "/items",
            json!({ "type": "core.conversation", "properties": {} }),
        )
        .await;
    let conversation = conversation.body["item"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let row = json!({ "operations": [{ "op": "put", "id": uuid::Uuid::now_v7().to_string(),
        "values": { "author": "ada", "sent_at": "2026-01-01T10:00:00Z" } }] });
    let rows = origin
        .keyed(
            Method::POST,
            &format!("/items/{conversation}/tables/messages/rows"),
            row,
        )
        .await;
    assert_eq!(rows.status, StatusCode::OK, "{}", rows.body);
    let edge = origin
        .keyed(
            Method::POST,
            "/edges",
            json!({ "source_id": note, "target_id": conversation, "edge_type": "references" }),
        )
        .await;
    assert_eq!(edge.status, StatusCode::CREATED, "{}", edge.body);
    let registered = origin
        .local(
            Method::POST,
            "/types",
            json!({ "id": "user.pinned", "fields": { "title": { "type": "string" } } }),
        )
        .await;
    assert_eq!(
        registered.status,
        StatusCode::CREATED,
        "{}",
        registered.body
    );

    let held = entries(&origin.archive().await);
    assert_eq!(
        names(&held),
        [
            "manifest.json".to_string(),
            "files.ndjson.gz".to_string(),
            "instance.ndjson.gz".to_string(),
            "items.ndjson.gz".to_string(),
            "versions.ndjson.gz".to_string(),
            "edges.ndjson.gz".to_string(),
            "rows.ndjson.gz".to_string(),
            format!("blobs/{hash}"),
        ]
    );
    assert_eq!(
        sorted_keys(&Value::Object(manifest_of(&held))),
        [
            "blob_count",
            "connector_agreement_count",
            "connector_state_count",
            "created_at",
            "edge_count",
            "edge_type_count",
            "file_count",
            "format",
            "instance_id",
            "item_count",
            "row_count",
            "setting_count",
            "source_count",
            "type_count",
            "type_icon_count",
            "version",
            "version_count",
            "written_by",
        ]
    );
    assert_eq!(manifest_of(&held)["format"], "marfa-archive");
    let line = |name: &str| {
        let (_, body) = held.iter().find(|(held, _)| held == name).unwrap();
        lines(body)
    };
    assert_eq!(
        sorted_keys(&line("files.ndjson.gz")[0]),
        ["hash", "mime_type", "size_bytes", "state"]
    );
    assert_eq!(line("files.ndjson.gz")[0]["state"], "carried");
    let instance = line("instance.ndjson.gz");
    assert!(
        instance
            .iter()
            .any(|held| held["type"]["id"] == "user.pinned")
    );
    let kinds = [
        "connector_agreement",
        "connector_state",
        "edge_type",
        "setting",
        "source",
        "type",
        "type_icon",
    ];
    for held in &instance {
        let mut keys = sorted_keys(held);
        keys.retain(|key| key != "provenance");
        assert!(
            keys.len() == 1 && kinds.contains(&keys[0].as_str()),
            "{held}"
        );
    }
    assert_eq!(
        sorted_keys(&line("items.ndjson.gz")[0]),
        [
            "item",
            "lending_blobs",
            "lending_extensions",
            "metadata",
            "restored_at",
            "trashed_by",
            "writer"
        ]
    );
    let version = &line("versions.ndjson.gz")[0];
    assert_eq!(
        sorted_keys(version),
        [
            "created_at",
            "id",
            "item_id",
            "occurred_at",
            "properties",
            "source_id",
            "tier",
            "type",
            "version",
            "writer"
        ]
    );
    assert_eq!(version["item_id"], note.as_str());
    assert_eq!(
        sorted_keys(&line("edges.ndjson.gz")[0]),
        ["edge", "lending_blobs"]
    );
    assert_eq!(
        sorted_keys(&line("rows.ndjson.gz")[0]),
        ["id", "item_id", "table", "updated_at", "values"]
    );
}

#[tokio::test]
async fn an_entry_a_tar_tool_adds_is_skipped_and_named_in_the_answer() {
    let folder = TempDir::new().unwrap();
    let origin = Instance::start(folder.path(), &[]).await;
    let note = origin.note("kept past the strays").await;
    let mut held = entries(&origin.archive().await);
    let strays = ["._manifest.json", "PaxHeaders.4242/items.ndjson.gz"];
    held.insert(0, (strays[0].to_string(), b"\x00\x05\x16\x07".to_vec()));
    let items = names(&held)
        .iter()
        .position(|name| name == "items.ndjson.gz")
        .unwrap();
    held.insert(items, (strays[1].to_string(), b"path=items\n".to_vec()));
    let mut archive = tar(&held);
    // A pax extended header is no entry at all, so the answer does not name it.
    let mut pax = header("PaxHeaders.4242/manifest.json", 11, b'x');
    pax.extend_from_slice(b"path=x\n\0\0\0\0");
    pax.resize(2 * BLOCK, 0);
    archive.splice(0..0, pax);

    let fresh = Instance::start(folder.path(), &[]).await;
    let restored = fresh.restore(archive).await;
    assert_eq!(restored.status, StatusCode::OK, "{}", restored.body);
    assert_eq!(restored.body["entries_skipped"], json!(strays));
    let read = fresh
        .keyed(Method::GET, &format!("/items/{note}"), json!({}))
        .await;
    assert_eq!(read.status, StatusCode::OK, "{}", read.body);

    let plain = Instance::start(folder.path(), &[]).await;
    let restored = plain.restore(origin.archive().await).await;
    assert_eq!(restored.status, StatusCode::OK, "{}", restored.body);
    assert_eq!(restored.body["entries_skipped"], json!([]));
}

#[tokio::test]
async fn a_manifest_written_before_0_1_is_refused_naming_the_build_that_wrote_it() {
    let folder = TempDir::new().unwrap();
    let origin = Instance::start(folder.path(), &[]).await;
    origin.note("written before 0.1").await;
    let archive = with_manifest(entries(&origin.archive().await), |manifest| {
        manifest.remove("format");
        manifest.insert("written_by".into(), "marfa-server 0.0.70".into());
    });
    let fresh = Instance::start(folder.path(), &[]).await;
    let refused = fresh.restore(archive).await;
    assert_eq!(refused.status, StatusCode::BAD_REQUEST, "{}", refused.body);
    assert_eq!(
        refused.body["error"]["message"],
        "This archive was written by marfa-server 0.0.70, before Marfa 0.1, and this build \
         cannot read it."
    );
    assert_eq!(
        refused.body["error"]["details"]["written_by"],
        "marfa-server 0.0.70"
    );
    let listed = fresh.keyed(Method::GET, "/items", json!({})).await;
    assert_eq!(listed.body["data"], json!([]), "{}", listed.body);
}

#[tokio::test]
async fn a_manifest_at_a_later_version_is_refused_naming_the_build_that_wrote_it() {
    let folder = TempDir::new().unwrap();
    let origin = Instance::start(folder.path(), &[]).await;
    origin.note("written by a later build").await;
    let archive = with_manifest(entries(&origin.archive().await), |manifest| {
        manifest.insert("version".into(), 2.into());
        manifest.insert("written_by".into(), "marfa-server 9.0.0".into());
    });
    let fresh = Instance::start(folder.path(), &[]).await;
    let refused = fresh.restore(archive).await;
    assert_eq!(refused.status, StatusCode::BAD_REQUEST, "{}", refused.body);
    let message = refused.body["error"]["message"].as_str().unwrap();
    assert!(message.contains("version 2"), "{message}");
    assert!(message.contains("marfa-server 9.0.0"), "{message}");
    assert!(message.contains("up to version 1"), "{message}");
    let details = &refused.body["error"]["details"];
    assert_eq!(details["version"], 2, "{details}");
    assert_eq!(details["written_by"], "marfa-server 9.0.0", "{details}");
}

#[tokio::test]
async fn an_export_or_backup_with_a_line_past_the_readers_limit_is_refused_naming_the_item() {
    let folder = TempDir::new().unwrap();
    let origin = Instance::start(folder.path(), &[]).await;
    let small = origin.note("short").await;
    let large = origin.note(&"x".repeat(4096)).await;
    // The witness: at the full limit both lines go.
    assert_eq!(origin.export().await.status, StatusCode::OK);
    origin
        .app
        .faults
        .set("limit:archive-line", Some("2048"))
        .unwrap();

    let refused = origin.export().await;
    assert_eq!(refused.status, StatusCode::CONFLICT, "{}", refused.body);
    let error = &refused.body["error"];
    assert_eq!(error["code"], "export_entry_unrestorable", "{error}");
    assert_eq!(error["details"]["entry"]["kind"], "item", "{error}");
    assert_eq!(error["details"]["entry"]["id"], large.as_str(), "{error}");
    assert!(
        error["message"].as_str().unwrap().contains("2048"),
        "{error}"
    );
    assert_ne!(error["details"]["entry"]["id"], small.as_str());

    let refused = origin.back_up().await;
    assert!(!refused.status.is_success(), "{}", refused.body);
    assert!(
        refused.body.to_string().contains(large.as_str()),
        "{}",
        refused.body
    );
}

#[tokio::test]
async fn a_version_past_the_readers_limit_refuses_the_export_naming_its_item() {
    let folder = TempDir::new().unwrap();
    let origin = Instance::start(folder.path(), &[]).await;
    let id = origin.note(&"y".repeat(4096)).await;
    origin.edit(&id, 1, "short now").await;
    origin
        .app
        .faults
        .set("limit:archive-line", Some("2048"))
        .unwrap();
    let refused = origin.export().await;
    assert_eq!(refused.status, StatusCode::CONFLICT, "{}", refused.body);
    let entry = &refused.body["error"]["details"]["entry"];
    assert_eq!(entry["id"], id.as_str(), "{entry}");
    assert_eq!(entry["field"], "versions.1", "{entry}");
}

#[tokio::test]
async fn a_version_whose_item_the_archive_does_not_hold_is_refused() {
    let folder = TempDir::new().unwrap();
    let origin = Instance::start(folder.path(), &[]).await;
    let id = origin.note("first").await;
    origin.edit(&id, 1, "second").await;
    let mut held = entries(&origin.archive().await);
    let at = names(&held)
        .iter()
        .position(|name| name == "versions.ndjson.gz")
        .unwrap();
    let mut versions = lines(&held[at].1);
    let other = uuid::Uuid::now_v7().to_string();
    versions[0]["item_id"] = Value::from(other.clone());
    held[at].1 = gzip(&versions);
    let fresh = Instance::start(folder.path(), &[]).await;
    let refused = fresh.restore(tar(&held)).await;
    assert_eq!(refused.status, StatusCode::BAD_REQUEST, "{}", refused.body);
    assert_eq!(refused.body["error"]["details"]["item_id"], other.as_str());
    assert_eq!(
        refused.body["error"]["details"]["entry"],
        "versions.ndjson.gz"
    );
}
