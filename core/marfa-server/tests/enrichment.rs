//! The reader starts this test program as its child; `main` must serve it first.

use std::sync::Arc;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Method, Request, StatusCode, header};
use libtest_mimic::{Arguments, Trial};
use marfa_server::app::{App, housekeeping};
use marfa_server::http::{control, public};
use marfa_server::settings::{Environment, Settings};
use rusqlite::{Connection, OpenFlags};
use serde_json::{Value, json};
use tempfile::TempDir;
use tower::ServiceExt;

const SWEEP: &str = "enrichment-sweep";

struct Instance {
    dir: TempDir,
    app: Arc<App>,
    public: Router,
    control: Router,
    token: String,
}

async fn send(router: &Router, request: Request<Body>) -> (StatusCode, Value) {
    let response = router.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

impl Instance {
    async fn start(settings: &[(&str, &str)]) -> Instance {
        let dir = TempDir::new().unwrap();
        let database = dir.path().join("marfa.db");
        let blobs = dir.path().join("blobs");
        let socket = dir.path().join("s.sock");
        let mut pairs = vec![
            ("SQLITE_PATH", database.to_str().unwrap()),
            ("BLOB_PATH", blobs.to_str().unwrap()),
            ("MARFA_CONTROL_SOCKET", socket.to_str().unwrap()),
            ("MARFA_TEST_HOOKS", "true"),
            ("RATE_LIMIT_ENABLED", "false"),
            ("MARFA_ENRICHMENT_ENABLED", "true"),
            ("MARFA_ENRICHMENT_OCR_ENABLED", "false"),
            ("MARFA_ENRICHMENT_INTERVAL_MS", "3600000"),
        ];
        pairs.extend_from_slice(settings);
        let settings = Settings::read(Environment::from_pairs(&pairs)).unwrap();
        let app = App::start(settings).await.unwrap();
        let mut instance = Instance {
            public: public(app.clone()),
            control: control(app.clone()),
            app,
            dir,
            token: String::new(),
        };
        let body = json!({
            "label": "writer",
            "source": "writer",
            "permissions": [],
            "type_permissions": { "core.file": "write" },
        });
        let (status, minted) = instance.local(Method::POST, "/keys", body).await;
        assert_eq!(status, StatusCode::CREATED, "{minted}");
        instance.token = minted["key"].as_str().unwrap().to_string();
        instance
    }

    async fn local(&self, method: Method, path: &str, body: Value) -> (StatusCode, Value) {
        let request = Request::builder()
            .method(method)
            .uri(path)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .unwrap();
        send(&self.control, request).await
    }

    async fn upload(&self, bytes: &[u8]) -> String {
        let request = Request::builder()
            .method(Method::POST)
            .uri("/blobs")
            .header(header::AUTHORIZATION, format!("Bearer {}", self.token))
            .body(Body::from(bytes.to_vec()))
            .unwrap();
        let (status, stored) = send(&self.public, request).await;
        assert_eq!(status, StatusCode::CREATED, "{stored}");
        stored["hash"].as_str().unwrap().to_string()
    }

    async fn file(&self, bytes: &[u8], mime: &str, extra: Value) -> String {
        let hash = self.upload(bytes).await;
        let mut properties = json!({ "blob_ref": hash, "mime_type": mime, "title": "a file" });
        properties
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let request = Request::builder()
            .method(Method::POST)
            .uri("/items")
            .header(header::AUTHORIZATION, format!("Bearer {}", self.token))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                json!({ "type": "core.file", "properties": properties }).to_string(),
            ))
            .unwrap();
        let (status, made) = send(&self.public, request).await;
        assert_eq!(status, StatusCode::CREATED, "{made}");
        made["item"]["id"].as_str().unwrap().to_string()
    }

    async fn item(&self, id: &str) -> Value {
        let request = Request::builder()
            .uri(format!("/items/{id}"))
            .header(header::AUTHORIZATION, format!("Bearer {}", self.token))
            .body(Body::empty())
            .unwrap();
        let (status, found) = send(&self.public, request).await;
        assert_eq!(status, StatusCode::OK, "{found}");
        found["item"].clone()
    }

    async fn sweep(&self) -> Value {
        let ended = housekeeping::run_now(&self.app, SWEEP).await.unwrap();
        assert_eq!(ended.outcome, "ok", "{:?}", ended.error);
        ended.result.unwrap()
    }

    fn count(&self, sql: &str, id: &str) -> i64 {
        let file = self.dir.path().join("marfa.db");
        let db = Connection::open_with_flags(file, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        db.query_row(sql, [id], |row| row.get(0)).unwrap()
    }
}

fn counts(extracted: u64, skipped: u64, failed: u64) -> Value {
    json!({ "extracted": extracted, "skipped": skipped, "failed": failed })
}

async fn reads_text_and_announces_it() {
    let one = Instance::start(&[]).await;
    let id = one
        .file(b"the quokka ledger, page one", "text/plain", json!({}))
        .await;
    assert_eq!(one.sweep().await, counts(1, 0, 0));
    let item = one.item(&id).await;
    assert_eq!(
        item["properties"]["extracted_text"],
        "the quokka ledger, page one"
    );
    assert_eq!(item["version"], 2);
    let announced = "SELECT count(*) FROM event_log WHERE event_type = 'item.updated' \
                     AND item_id = ?1 AND payload LIKE '%quokka ledger%'";
    assert_eq!(one.count(announced, &id), 1);
    let audited = "SELECT count(*) FROM audit_log WHERE action = 'item.enrich' AND resource_id = ?1 \
                   AND kind = 'housekeeping'";
    assert_eq!(one.count(audited, &id), 1);
    assert_eq!(one.sweep().await, counts(0, 0, 0));
}

async fn leaves_what_the_client_wrote() {
    let one = Instance::start(&[]).await;
    let id = one
        .file(
            b"what the file says",
            "text/plain",
            json!({ "extracted_text": "what the client says" }),
        )
        .await;
    assert_eq!(one.sweep().await, counts(0, 0, 0));
    let item = one.item(&id).await;
    assert_eq!(item["properties"]["extracted_text"], "what the client says");
    assert_eq!(item["version"], 1);
}

async fn counts_a_damaged_file_until_its_attempts_run_out_and_reads_the_next() {
    let one = Instance::start(&[]).await;
    let docx = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    let broken = one.file(b"PK this is no document", docx, json!({})).await;
    let good = one
        .file(b"the wombat ledger", "text/plain", json!({}))
        .await;
    assert_eq!(one.sweep().await, counts(1, 0, 1));
    assert_eq!(one.sweep().await, counts(0, 0, 1));
    assert_eq!(one.sweep().await, counts(0, 0, 1));
    assert_eq!(one.sweep().await, counts(0, 0, 0));
    let item = one.item(&broken).await;
    assert!(item["properties"].get("extracted_text").is_none());
    assert_eq!(
        one.item(&good).await["properties"]["extracted_text"],
        "the wombat ledger"
    );
}

async fn offers_a_skipped_file_again_when_its_limit_is_raised() {
    let one = Instance::start(&[("MARFA_ENRICHMENT_MAX_BLOB_BYTES", "10")]).await;
    let id = one
        .file(b"more than ten bytes of text", "text/plain", json!({}))
        .await;
    assert_eq!(one.sweep().await, counts(0, 1, 0));
    assert_eq!(one.sweep().await, counts(0, 0, 0));
    let (status, body) = one
        .local(
            Method::PATCH,
            "/config",
            json!({ "enrichment_max_blob_bytes": 1000 }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(one.sweep().await, counts(1, 0, 0));
    assert_eq!(
        one.item(&id).await["properties"]["extracted_text"],
        "more than ten bytes of text"
    );
}

#[cfg(feature = "native")]
const SENTENCE: &[u8] = include_bytes!("../../marfa-enrichment/fixtures/sentence.png");

#[cfg(feature = "native")]
async fn picture_item(one: &Instance, bytes: &[u8]) -> String {
    let hash = one.upload(bytes).await;
    let made = json!({ "type": "core.file.image", "properties": {
        "blob_ref": hash, "mime_type": "image/png", "title": "a picture" } });
    let request = Request::builder()
        .method(Method::POST)
        .uri("/items")
        .header(header::AUTHORIZATION, format!("Bearer {}", one.token))
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(made.to_string()))
        .unwrap();
    let (status, body) = send(&one.public, request).await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    body["item"]["id"].as_str().unwrap().to_string()
}

#[cfg(feature = "native")]
async fn reads_a_picture_for_its_size_and_again_for_its_words_once_ocr_is_on() {
    let one = Instance::start(&[]).await;
    let id = picture_item(&one, SENTENCE).await;
    assert_eq!(one.sweep().await, counts(1, 0, 0));
    let item = one.item(&id).await;
    assert!(item["properties"]["width"].as_u64().unwrap() > 0);
    assert!(item["properties"].get("extracted_text").is_none());
    assert_eq!(one.sweep().await, counts(0, 0, 0));
    let (status, body) = one
        .local(
            Method::PATCH,
            "/config",
            json!({ "enrichment_ocr_enabled": true }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(one.sweep().await, counts(1, 0, 0));
    let text = one.item(&id).await["properties"]["extracted_text"].clone();
    assert!(
        text.as_str()
            .unwrap()
            .contains("Marfa reads this sentence upright."),
        "{text}"
    );
}

#[cfg(feature = "native")]
async fn counts_a_damaged_picture_when_ocr_is_on() {
    let one = Instance::start(&[("MARFA_ENRICHMENT_OCR_ENABLED", "true")]).await;
    let mut damaged = vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    damaged.extend_from_slice(&[0x5a; 4096]);
    let broken = picture_item(&one, &damaged).await;
    let good = picture_item(&one, SENTENCE).await;
    assert_eq!(one.sweep().await, counts(1, 0, 1));
    assert!(one.item(&broken).await["properties"].get("width").is_none());
    assert!(
        one.item(&good).await["properties"]
            .get("extracted_text")
            .is_some()
    );
}

async fn leaves_a_disabled_sweep_with_its_files_waiting() {
    let one = Instance::start(&[("MARFA_ENRICHMENT_ENABLED", "false")]).await;
    let id = one.file(b"waiting text", "text/plain", json!({})).await;
    assert_eq!(one.sweep().await, counts(0, 0, 0));
    assert!(
        one.item(&id).await["properties"]
            .get("extracted_text")
            .is_none()
    );
    let (status, body) = one
        .local(
            Method::PATCH,
            "/config",
            json!({ "enrichment_enabled": true }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(one.sweep().await, counts(1, 0, 0));
}

fn main() {
    marfa_enrichment::serve_child_if_asked();
    let arguments = Arguments::from_args();
    let runtime = Arc::new(
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap(),
    );
    let trial =
        |name: &'static str,
         case: fn() -> std::pin::Pin<Box<dyn std::future::Future<Output = ()>>>| {
            let runtime = runtime.clone();
            Trial::test(name, move || {
                runtime.block_on(case());
                Ok(())
            })
        };
    let trials = vec![
        trial("reads_text_and_announces_it", || {
            Box::pin(reads_text_and_announces_it())
        }),
        trial("leaves_what_the_client_wrote", || {
            Box::pin(leaves_what_the_client_wrote())
        }),
        trial(
            "counts_a_damaged_file_until_its_attempts_run_out_and_reads_the_next",
            || Box::pin(counts_a_damaged_file_until_its_attempts_run_out_and_reads_the_next()),
        ),
        trial(
            "offers_a_skipped_file_again_when_its_limit_is_raised",
            || Box::pin(offers_a_skipped_file_again_when_its_limit_is_raised()),
        ),
        trial("leaves_a_disabled_sweep_with_its_files_waiting", || {
            Box::pin(leaves_a_disabled_sweep_with_its_files_waiting())
        }),
    ];
    #[cfg(feature = "native")]
    let trials = {
        let mut trials = trials;
        trials.push(trial(
            "reads_a_picture_for_its_size_and_again_for_its_words_once_ocr_is_on",
            || Box::pin(reads_a_picture_for_its_size_and_again_for_its_words_once_ocr_is_on()),
        ));
        trials.push(trial("counts_a_damaged_picture_when_ocr_is_on", || {
            Box::pin(counts_a_damaged_picture_when_ocr_is_on())
        }));
        trials
    };
    libtest_mimic::run(&arguments, trials).exit();
}
