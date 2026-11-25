//! Archive layout, history, line limits, and input validation.

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
                    "permissions": ["blobs.manage", "items.purge"],
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

/// The layout of archive version 5. A change to any of it raises `VERSION`, and this pin with it.
#[tokio::test]
async fn the_layout_is_pinned_to_its_version() {
    assert_eq!(archive::VERSION, 5);
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
            json!({ "from_id": note, "to_id": conversation, "edge_type": "references" }),
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
            format!("blobs/{}", hash.strip_prefix("sha256:").unwrap()),
        ]
    );
    assert_eq!(
        sorted_keys(&Value::Object(manifest_of(&held))),
        [
            "app_vendor_count",
            "blob_count",
            "connector_agreement_count",
            "connector_mapping_count",
            "connector_setting_count",
            "connector_state_count",
            "created_at",
            "edge_count",
            "edge_type_count",
            "enforcement_count",
            "file_count",
            "format",
            "instance_id",
            "item_count",
            "plugin_count",
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
        "app_vendor",
        "connector_agreement",
        "connector_setting",
        "connector_state",
        "edge_type",
        "enforcement",
        "plugin",
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
            "state_writer",
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
async fn a_manifest_with_no_format_is_refused_naming_the_build_that_wrote_it() {
    let folder = TempDir::new().unwrap();
    let origin = Instance::start(folder.path(), &[]).await;
    origin.note("written with no format").await;
    let archive = with_manifest(entries(&origin.archive().await), |manifest| {
        manifest.remove("format");
        manifest.insert("written_by".into(), "marfa-server 0.0.70".into());
    });
    let fresh = Instance::start(folder.path(), &[]).await;
    let refused = fresh.restore(archive).await;
    assert_eq!(refused.status, StatusCode::BAD_REQUEST, "{}", refused.body);
    assert_eq!(
        refused.body["error"]["message"],
        "This archive was written by marfa-server 0.0.70, and its manifest.json names no format, \
         which only releases before 0.0.72 left out, so this build cannot read it."
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
        manifest.insert("version".into(), 6.into());
        manifest.insert("written_by".into(), "marfa-server 9.0.0".into());
    });
    let fresh = Instance::start(folder.path(), &[]).await;
    let refused = fresh.restore(archive).await;
    assert_eq!(refused.status, StatusCode::BAD_REQUEST, "{}", refused.body);
    let message = refused.body["error"]["message"].as_str().unwrap();
    assert!(message.contains("version 6"), "{message}");
    assert!(message.contains("marfa-server 9.0.0"), "{message}");
    assert!(message.contains("up to version 5"), "{message}");
    let details = &refused.body["error"]["details"];
    assert_eq!(details["version"], 6, "{details}");
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

fn at(held: &[(String, Vec<u8>)], name: &str) -> usize {
    names(held).iter().position(|held| held == name).unwrap()
}

#[tokio::test]
async fn an_item_on_two_lines_is_refused_naming_it() {
    let folder = TempDir::new().unwrap();
    let origin = Instance::start(folder.path(), &[]).await;
    let id = origin.note("first").await;
    origin.edit(&id, 1, "second").await;
    let held = entries(&origin.archive().await);

    // The witness: the archive as written restores.
    let plain = Instance::start(folder.path(), &[]).await;
    let restored = plain.restore(tar(&held)).await;
    assert_eq!(restored.status, StatusCode::OK, "{}", restored.body);

    let mut held = held;
    let items = at(&held, "items.ndjson.gz");
    let mut lines_held = lines(&held[items].1);
    let mut later = lines_held[0].clone();
    later["item"]["version"] = Value::from(10);
    lines_held.push(later);
    held[items].1 = gzip(&lines_held);
    let archive = with_manifest(held, |manifest| {
        manifest.insert("item_count".into(), 2.into());
    });
    let fresh = Instance::start(folder.path(), &[]).await;
    let refused = fresh.restore(archive).await;
    assert_eq!(refused.status, StatusCode::BAD_REQUEST, "{}", refused.body);
    let details = &refused.body["error"]["details"];
    assert_eq!(details["item_id"], id.as_str(), "{details}");
    assert_eq!(details["entry"], "items.ndjson.gz", "{details}");
    assert_eq!(details["line"], 2, "{details}");
    let read = fresh
        .keyed(Method::GET, &format!("/items/{id}"), json!({}))
        .await;
    assert_eq!(read.status, StatusCode::NOT_FOUND, "{}", read.body);
}

#[tokio::test]
async fn a_blob_before_the_file_list_is_refused_as_out_of_order() {
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
    let held = entries(&origin.archive().await);
    let blob = format!("blobs/{}", hash.strip_prefix("sha256:").unwrap());

    // The witness: in its place, the blob restores.
    let plain = Instance::start(folder.path(), &[]).await;
    let restored = plain.restore(tar(&held)).await;
    assert_eq!(restored.status, StatusCode::OK, "{}", restored.body);
    assert_eq!(restored.body["blobs_imported"], 1, "{}", restored.body);

    for before in ["files.ndjson.gz", "rows.ndjson.gz"] {
        let mut moved = held.clone();
        let entry = moved.remove(at(&moved, &blob));
        moved.insert(at(&moved, before), entry);
        let fresh = Instance::start(folder.path(), &[]).await;
        let refused = fresh.restore(tar(&moved)).await;
        assert_eq!(refused.status, StatusCode::BAD_REQUEST, "{}", refused.body);
        let error = &refused.body["error"];
        assert_eq!(error["details"]["entry"], blob.as_str(), "{error}");
        assert!(
            error["message"].as_str().unwrap().contains("out of order"),
            "{error}"
        );
    }
}

#[tokio::test]
async fn a_line_kind_or_field_a_restore_does_not_know_is_skipped_and_the_kind_named() {
    let folder = TempDir::new().unwrap();
    let origin = Instance::start(folder.path(), &[]).await;
    let id = origin.note("kept past a later kind").await;
    let held = entries(&origin.archive().await);

    let plain = Instance::start(folder.path(), &[]).await;
    let restored = plain.restore(tar(&held)).await;
    assert_eq!(restored.status, StatusCode::OK, "{}", restored.body);
    assert_eq!(restored.body["line_kinds_skipped"], json!([]));

    let mut held = held;
    let instance = at(&held, "instance.ndjson.gz");
    let mut kinds = lines(&held[instance].1);
    kinds.push(json!({ "later_kind": { "name": "a" } }));
    kinds.push(json!({ "later_kind": { "name": "b" }, "provenance": {} }));
    kinds.push(json!({ "another_kind": {} }));
    held[instance].1 = gzip(&kinds);
    let items = at(&held, "items.ndjson.gz");
    let mut item_lines = lines(&held[items].1);
    item_lines[0]["later_field"] = json!({ "held": true });
    item_lines[0]["item"]["later_field"] = Value::from(1);
    held[items].1 = gzip(&item_lines);
    let archive = with_manifest(held, |manifest| {
        manifest.insert("later_kind_count".into(), 2.into());
    });

    let fresh = Instance::start(folder.path(), &[]).await;
    let restored = fresh.restore(archive).await;
    assert_eq!(restored.status, StatusCode::OK, "{}", restored.body);
    assert_eq!(
        restored.body["line_kinds_skipped"],
        json!(["later_kind", "another_kind"])
    );
    assert_eq!(restored.body["imported"], 1, "{}", restored.body);
    let read = fresh
        .keyed(Method::GET, &format!("/items/{id}"), json!({}))
        .await;
    assert_eq!(read.status, StatusCode::OK, "{}", read.body);
    assert!(
        read.body["item"].get("later_field").is_none(),
        "{}",
        read.body
    );
}

impl Instance {
    /// An archive written by a key that holds `config.manage`.
    async fn local_archive(&self) -> Vec<u8> {
        let exported = self.manager_export().await;
        assert_eq!(exported.status, StatusCode::OK, "{}", exported.body);
        exported.bytes
    }

    async fn manager_export(&self) -> Reply {
        let minted = self
            .local(
                Method::POST,
                "/keys",
                json!({
                    "label": "manager",
                    "source": format!("manager-{}", uuid::Uuid::now_v7()),
                    "permissions": ["config.manage"],
                    "type_permissions": { "*": "read" },
                }),
            )
            .await;
        assert_eq!(minted.status, StatusCode::CREATED, "{}", minted.body);
        self.call(
            &self.public,
            minted.body["key"].as_str(),
            Method::GET,
            "/export?format=archive",
            Body::empty(),
            "application/json",
        )
        .await
    }

    async fn levers(&self) -> Value {
        let config = self.local(Method::GET, "/config", json!({})).await;
        assert_eq!(config.status, StatusCode::OK, "{}", config.body);
        config.body["enforcement"].clone()
    }

    async fn set_levers(&self, levers: Value) {
        let set = self
            .local(Method::PATCH, "/config", json!({ "enforcement": levers }))
            .await;
        assert_eq!(set.status, StatusCode::OK, "{}", set.body);
    }
}

#[tokio::test]
async fn a_restore_stores_each_enforcement_setting_the_instance_lacks_and_keeps_each_it_has() {
    let folder = TempDir::new().unwrap();
    let origin = Instance::start(folder.path(), &[]).await;
    let allowlist = json!({ "types": ["core.note"], "sources": ["origin"] });
    let filter = json!({ "types": ["core.note"], "sources": ["origin", "other"] });
    origin
        .set_levers(json!({
            "strict_mode": { "types": ["core.task"] },
            "source_allowlist": allowlist,
            "source_filter": filter,
        }))
        .await;
    let archive = origin.local_archive().await;

    // An empty row holds no setting, so each comes back.
    let empty = Instance::start(folder.path(), &[]).await;
    empty.set_levers(json!({})).await;
    let restored = empty.restore(archive.clone()).await;
    assert_eq!(restored.status, StatusCode::OK, "{}", restored.body);
    assert_eq!(
        restored.body["enforcement_added"],
        json!(["strict_mode", "source_allowlist", "source_filter"])
    );
    assert_eq!(restored.body["enforcement_skipped"], json!([]));
    assert_eq!(empty.levers().await, origin.levers().await);
    let again = empty.restore(archive.clone()).await;
    assert_eq!(again.status, StatusCode::OK, "{}", again.body);
    assert_eq!(again.body["enforcement_added"], json!([]));
    assert_eq!(
        again.body["enforcement_skipped"],
        json!(["strict_mode", "source_allowlist", "source_filter"])
    );

    // A setting the instance holds stays its own, and the ones it lacks are added.
    let partial = Instance::start(folder.path(), &[]).await;
    let own = json!({ "types": ["core.note"] });
    partial.set_levers(json!({ "strict_mode": own })).await;
    let restored = partial.restore(archive).await;
    assert_eq!(restored.status, StatusCode::OK, "{}", restored.body);
    assert_eq!(
        restored.body["enforcement_added"],
        json!(["source_allowlist", "source_filter"])
    );
    assert_eq!(restored.body["enforcement_skipped"], json!(["strict_mode"]));
    assert_eq!(
        partial.levers().await,
        json!({ "strict_mode": own, "source_allowlist": allowlist, "source_filter": filter })
    );
}

#[tokio::test]
async fn unreadable_enforcement_settings_refuse_an_export_and_a_backup_names_them() {
    let folder = TempDir::new().unwrap();
    let origin = Instance::start(folder.path(), &[]).await;
    origin
        .set_levers(json!({ "strict_mode": { "types": ["core.task"] } }))
        .await;
    let task = origin
        .keyed(
            Method::POST,
            "/items",
            json!({ "type": "core.task", "properties": { "title": "kept" } }),
        )
        .await;
    assert_eq!(task.status, StatusCode::CREATED, "{}", task.body);
    // The witness: a row that reads travels, and an export holds the item.
    let readable = manifest_of(&entries(&origin.local_archive().await));
    assert_eq!(readable["enforcement_count"], 1);
    assert!(readable.get("unreadable").is_none(), "{readable:?}");
    let held = readable["item_count"].clone();
    assert!(held.as_u64().unwrap() >= 1, "{readable:?}");
    assert_eq!(origin.export().await.status, StatusCode::OK);

    origin
        .app
        .db
        .write(marfa_server::db::Write::own(), |tx| {
            tx.execute(
                "UPDATE settings SET value = '{ not levers' WHERE key = 'enforcement'",
                [],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    for refused in [origin.export().await, origin.manager_export().await] {
        assert_eq!(refused.status, StatusCode::CONFLICT, "{}", refused.body);
        assert_eq!(refused.body["error"]["code"], "enforcement_unreadable");
        assert!(refused.bytes.len() < 1024, "{}", refused.body);
    }

    let backed_up = origin.back_up().await;
    assert_eq!(backed_up.status, StatusCode::OK, "{}", backed_up.body);
    let name = backed_up.body["backup"]["name"].as_str().unwrap();
    let backup: Value = serde_json::from_slice(
        &std::fs::read(
            folder
                .path()
                .join("backups")
                .join(&origin.app.instance_id)
                .join(name),
        )
        .unwrap(),
    )
    .unwrap();
    let manifest = &backup["archive"];
    assert_eq!(manifest["item_count"], held, "{manifest:?}");
    assert_eq!(manifest["enforcement_count"], 0);
    assert_eq!(manifest["unreadable"], json!(["enforcement"]));

    let fresh = Instance::start(folder.path(), &[]).await;
    let restored = fresh.restore_backup(&origin.app.instance_id, name).await;
    assert_eq!(restored.status, StatusCode::OK, "{}", restored.body);
    assert_eq!(restored.body["imported"], held, "{}", restored.body);
    let named = restored.body["not_restored"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["kind"] == "enforcement")
        .cloned()
        .expect("the unreadable settings named");
    assert!(
        named["message"].as_str().unwrap().contains("strict mode"),
        "{named}"
    );
    assert_eq!(restored.body["enforcement_added"], json!([]));
    assert_eq!(fresh.levers().await, Value::Null);
}

#[tokio::test]
async fn a_restore_from_another_instance_names_its_backup_folders_and_calls_none_safe() {
    let folder = TempDir::new().unwrap();
    let origin = Instance::start(folder.path(), &[]).await;
    let archive = origin.local_archive().await;
    let id = manifest_of(&entries(&archive))["instance_id"]
        .as_str()
        .unwrap()
        .to_string();

    let fresh = Instance::start(folder.path(), &[]).await;
    let restored = fresh.restore(archive).await;
    assert_eq!(restored.status, StatusCode::OK, "{}", restored.body);
    let previous = &restored.body["previous_instance"];
    assert_eq!(previous["instance_id"], id.as_str());
    assert_eq!(previous["destination"], "folder");
    assert_eq!(
        previous["kept_by_previous_instance"],
        json!([
            format!("backups/{id}"),
            format!("backup-parts/{id}"),
            format!("files/{id}")
        ])
    );
    assert!(previous.get("safe_to_delete").is_none(), "{previous}");
    let message = previous["message"].as_str().unwrap();
    assert!(message.contains("no longer runs"), "{message}");
    assert!(message.contains(&format!("backups/{id}")), "{message}");
}

impl Instance {
    async fn edge(&self, source: &str, target: &str) {
        let made = self
            .keyed(
                Method::POST,
                "/edges",
                json!({ "from_id": source, "to_id": target, "edge_type": "parent-of" }),
            )
            .await;
        assert_eq!(made.status, StatusCode::CREATED, "{}", made.body);
    }

    async fn archive_all(&self) -> Vec<u8> {
        let key = Some(self.writer.as_str());
        let exported = self
            .call(
                &self.public,
                key,
                Method::GET,
                "/export?format=archive&state=any",
                Body::empty(),
                "application/json",
            )
            .await;
        assert_eq!(exported.status, StatusCode::OK, "{}", exported.body);
        exported.bytes
    }

    async fn trash(&self, id: &str) {
        let trashed = self
            .keyed(Method::DELETE, &format!("/items/{id}"), json!({}))
            .await;
        assert_eq!(trashed.status, StatusCode::OK, "{}", trashed.body);
    }

    async fn bring_back(&self, id: &str) {
        let back = self
            .keyed(Method::POST, &format!("/items/{id}/restore"), json!({}))
            .await;
        assert_eq!(back.status, StatusCode::OK, "{}", back.body);
    }

    async fn item(&self, id: &str) -> Value {
        let read = self
            .keyed(Method::GET, &format!("/items/{id}?state=any"), json!({}))
            .await;
        assert_eq!(read.status, StatusCode::OK, "{}", read.body);
        read.body["item"].clone()
    }
}

/// A parent trashed with a child and a grandchild, and a note trashed on its own.
struct Bin {
    parent: String,
    child: String,
    grandchild: String,
    alone: String,
}

impl Instance {
    async fn bin(&self) -> Bin {
        let parent = self.note("parent").await;
        let child = self.note("child").await;
        let grandchild = self.note("grandchild").await;
        let alone = self.note("alone").await;
        self.edge(&parent, &child).await;
        self.edge(&child, &grandchild).await;
        self.trash(&alone).await;
        self.trash(&parent).await;
        Bin {
            parent,
            child,
            grandchild,
            alone,
        }
    }
}

#[tokio::test]
async fn a_restore_keeps_what_a_cascade_trashed_so_the_parent_brings_its_children_back() {
    let folder = TempDir::new().unwrap();
    let origin = Instance::start(folder.path(), &[]).await;
    let bin = origin.bin().await;
    let child = origin.item(&bin.child).await;
    assert_eq!(child["trashed_with"], bin.parent.as_str(), "{child}");

    let fresh = Instance::start(folder.path(), &[]).await;
    let restored = fresh.restore(origin.archive_all().await).await;
    assert_eq!(restored.status, StatusCode::OK, "{}", restored.body);
    assert_eq!(restored.body["imported"], 4, "{}", restored.body);

    for (id, state) in [(&bin.child, "trashed"), (&bin.grandchild, "trashed")] {
        let held = fresh.item(id).await;
        assert_eq!(held["state"], state, "{held}");
        assert_eq!(held["trashed_by_cascade"], true, "{held}");
        assert_eq!(held["trashed_with"], bin.parent.as_str(), "{held}");
    }
    let alone = fresh.item(&bin.alone).await;
    assert!(alone.get("trashed_with").is_none(), "{alone}");
    assert!(alone.get("trashed_by_cascade").is_none(), "{alone}");

    fresh.bring_back(&bin.parent).await;
    for id in [&bin.parent, &bin.child, &bin.grandchild] {
        assert_eq!(fresh.item(id).await["state"], "active", "{id}");
    }
    let alone = fresh.item(&bin.alone).await;
    assert_eq!(alone["state"], "trashed", "{alone}");
    let back = fresh.item(&bin.child).await;
    assert!(back.get("trashed_with").is_none(), "{back}");
    assert!(back.get("trashed_by_cascade").is_none(), "{back}");
}

#[tokio::test]
async fn a_restore_skips_a_live_item_and_leaves_it_unmarked() {
    let folder = TempDir::new().unwrap();
    let origin = Instance::start(folder.path(), &[]).await;
    let parent = origin.note("parent").await;
    let child = origin.note("child").await;
    origin.edge(&parent, &child).await;
    let whole = origin.archive_all().await;
    origin.trash(&parent).await;
    let binned = origin.archive_all().await;

    let fresh = Instance::start(folder.path(), &[]).await;
    assert_eq!(fresh.restore(whole).await.status, StatusCode::OK);
    let skipped = fresh.restore(binned).await;
    assert_eq!(skipped.status, StatusCode::OK, "{}", skipped.body);
    assert_eq!(skipped.body["imported"], 0, "{}", skipped.body);
    assert_eq!(skipped.body["duplicates"], 2, "{}", skipped.body);
    for id in [&parent, &child] {
        let held = fresh.item(id).await;
        assert_eq!(held["state"], "active", "{held}");
        assert!(held.get("trashed_with").is_none(), "{held}");
    }
}

async fn marked_archive(origin: &Instance, change: impl Fn(&mut Value)) -> Vec<u8> {
    let mut held = entries(&origin.archive_all().await);
    let items = at(&held, "items.ndjson.gz");
    let mut lines_held = lines(&held[items].1);
    for line in &mut lines_held {
        change(line);
    }
    held[items].1 = gzip(&lines_held);
    tar(&held)
}

#[tokio::test]
async fn an_archive_whose_cascade_marks_do_not_read_is_refused() {
    let folder = TempDir::new().unwrap();
    let origin = Instance::start(folder.path(), &[]).await;
    let bin = origin.bin().await;
    let child = bin.child.as_str();
    let marked = |line: &Value| line["item"]["id"] == child;

    // The witness: the archive as written restores.
    let plain = Instance::start(folder.path(), &[]).await;
    assert_eq!(
        plain.restore(origin.archive_all().await).await.status,
        StatusCode::OK
    );

    let cases: [(&str, Value, &str); 4] = [
        ("trashed_with", json!("not an id"), "trashed_with"),
        ("trashed_with", json!(7), "trashed_with"),
        ("trashed_by_cascade", json!("yes"), "trashed_by_cascade"),
        ("trashed_by_cascade", json!(false), "trashed_by_cascade"),
    ];
    for (key, value, field) in cases {
        let archive = marked_archive(&origin, |line| {
            if marked(line) {
                line["item"][key] = value.clone();
            }
        })
        .await;
        let fresh = Instance::start(folder.path(), &[]).await;
        let refused = fresh.restore(archive).await;
        assert_eq!(
            refused.status,
            StatusCode::BAD_REQUEST,
            "{key} {value}: {}",
            refused.body
        );
        let details = &refused.body["error"]["details"];
        assert_eq!(details["field"], field, "{key} {value}: {details}");
        assert_eq!(details["item_id"], child, "{key} {value}: {details}");
        let read = fresh
            .keyed(Method::GET, &format!("/items/{child}"), json!({}))
            .await;
        assert_eq!(read.status, StatusCode::NOT_FOUND, "{key} {value}");
    }

    // A mark on an item outside the bin, or one that names itself, cannot be real.
    let archive = marked_archive(&origin, |line| {
        if line["item"]["id"] == bin.parent.as_str() {
            line["item"]["trashed_by_cascade"] = json!(true);
            line["item"]["trashed_with"] = json!(bin.child);
            line["item"]["state"] = json!("active");
            line["item"]["trashed_at"] = Value::Null;
        }
    })
    .await;
    let fresh = Instance::start(folder.path(), &[]).await;
    let refused = fresh.restore(archive).await;
    assert_eq!(refused.status, StatusCode::BAD_REQUEST, "{}", refused.body);
    assert_eq!(
        refused.body["error"]["details"]["field"],
        "trashed_by_cascade"
    );
    let archive = marked_archive(&origin, |line| {
        if marked(line) {
            line["item"]["trashed_with"] = json!(bin.child);
        }
    })
    .await;
    let fresh = Instance::start(folder.path(), &[]).await;
    let refused = fresh.restore(archive).await;
    assert_eq!(refused.status, StatusCode::BAD_REQUEST, "{}", refused.body);
    assert_eq!(refused.body["error"]["details"]["field"], "trashed_with");
}

#[tokio::test]
async fn a_cascade_mark_names_an_item_whose_line_comes_later_in_the_archive() {
    let folder = TempDir::new().unwrap();
    let origin = Instance::start(folder.path(), &[]).await;
    let bin = origin.bin().await;
    let mut held = entries(&origin.archive_all().await);
    let items = at(&held, "items.ndjson.gz");
    let mut reversed = lines(&held[items].1);
    reversed.reverse();
    let position = |id: &str| reversed.iter().position(|line| line["item"]["id"] == id);
    // The witness: the child's line now comes before the parent's.
    assert!(position(&bin.child) < position(&bin.parent));
    held[items].1 = gzip(&reversed);

    let fresh = Instance::start(folder.path(), &[]).await;
    let restored = fresh.restore(tar(&held)).await;
    assert_eq!(restored.status, StatusCode::OK, "{}", restored.body);
    let child = fresh.item(&bin.child).await;
    assert_eq!(child["trashed_with"], bin.parent.as_str(), "{child}");
    fresh.bring_back(&bin.parent).await;
    assert_eq!(fresh.item(&bin.child).await["state"], "active");
    assert_eq!(fresh.item(&bin.grandchild).await["state"], "active");
}

#[tokio::test]
async fn a_cascade_mark_naming_an_item_the_archive_lacks_leaves_the_item_its_own_trash() {
    let folder = TempDir::new().unwrap();
    let origin = Instance::start(folder.path(), &[]).await;
    let bin = origin.bin().await;
    let purged = origin
        .keyed(
            Method::POST,
            &format!("/items/{}/purge", bin.parent),
            json!({}),
        )
        .await;
    assert_eq!(purged.status, StatusCode::OK, "{}", purged.body);
    let archive = origin.archive_all().await;
    let held = entries(&archive);
    let lines_held = lines(&held[at(&held, "items.ndjson.gz")].1);
    // The witness: the child's line names a parent that no line holds.
    let child_line = lines_held
        .iter()
        .find(|line| line["item"]["id"] == bin.child.as_str())
        .unwrap();
    assert_eq!(child_line["item"]["trashed_with"], bin.parent.as_str());
    assert!(
        lines_held
            .iter()
            .all(|line| line["item"]["id"] != bin.parent.as_str())
    );

    let fresh = Instance::start(folder.path(), &[]).await;
    let restored = fresh.restore(archive).await;
    assert_eq!(restored.status, StatusCode::OK, "{}", restored.body);
    let child = fresh.item(&bin.child).await;
    assert_eq!(child["state"], "trashed", "{child}");
    assert!(child.get("trashed_with").is_none(), "{child}");
    assert!(child.get("trashed_by_cascade").is_none(), "{child}");
    let grandchild = fresh.item(&bin.grandchild).await;
    assert!(grandchild.get("trashed_with").is_none(), "{grandchild}");
    fresh.bring_back(&bin.child).await;
    assert_eq!(fresh.item(&bin.child).await["state"], "active");
    assert_eq!(fresh.item(&bin.grandchild).await["state"], "trashed");
}
