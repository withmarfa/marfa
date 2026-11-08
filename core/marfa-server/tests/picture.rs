//! The owner's picture: what is kept, what is refused, and what stays when a send fails.

use std::collections::VecDeque;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{HeaderMap, Method, Request, StatusCode, header};
use http_body::Frame;
use marfa_server::app::App;
use marfa_server::http::{control, public};
use marfa_server::settings::{Environment, Settings};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tempfile::TempDir;
use tower::ServiceExt;

const ORIGIN: &str = "http://127.0.0.1:8600";
const EMAIL: &str = "owner@example.test";
const PASSWORD: &str = "the first password";
const LIMIT: usize = 2 * 1024 * 1024;

struct Instance {
    _dir: TempDir,
    app: Arc<App>,
    public: Router,
    control: Router,
}

struct Reply {
    status: StatusCode,
    headers: HeaderMap,
    bytes: Vec<u8>,
}

impl Reply {
    fn json(&self) -> Value {
        serde_json::from_slice(&self.bytes).unwrap_or(Value::Null)
    }

    fn code(&self) -> String {
        self.json()["error"]["code"]
            .as_str()
            .unwrap_or("")
            .to_string()
    }
}

async fn send(router: &Router, request: Request<Body>) -> Reply {
    let response = router.clone().oneshot(request).await.unwrap();
    let (parts, body) = response.into_parts();
    let bytes = to_bytes(body, usize::MAX).await.unwrap_or_default();
    Reply {
        status: parts.status,
        headers: parts.headers,
        bytes: bytes.to_vec(),
    }
}

struct Frames(VecDeque<Result<Vec<u8>, std::io::Error>>);

impl http_body::Body for Frames {
    type Data = axum::body::Bytes;
    type Error = std::io::Error;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        _: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Self::Data>, Self::Error>>> {
        Poll::Ready(
            self.0
                .pop_front()
                .map(|next| next.map(|data| Frame::data(data.into()))),
        )
    }
}

fn chunk(name: &[u8; 4], data: &[u8]) -> Vec<u8> {
    let mut out = u32::try_from(data.len()).unwrap().to_be_bytes().to_vec();
    out.extend_from_slice(name);
    out.extend_from_slice(data);
    out.extend_from_slice(&[0; 4]);
    out
}

fn png_sized(width: u32, height: u32, shade: u8, padding: usize) -> Vec<u8> {
    let mut header = width.to_be_bytes().to_vec();
    header.extend_from_slice(&height.to_be_bytes());
    header.extend_from_slice(&[8, 2, 0, 0, 0]);
    [
        vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a],
        chunk(b"IHDR", &header),
        chunk(b"IDAT", &[shade]),
        chunk(b"paDd", &vec![0; padding]),
        chunk(b"IEND", &[]),
    ]
    .concat()
}

fn png(shade: u8) -> Vec<u8> {
    png_sized(8, 8, shade, 0)
}

fn jpeg() -> Vec<u8> {
    vec![
        0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0, 8, 0, 8, 1, 1, 0x11, 0, 0xff, 0xda, 0x00,
        0x08, 1, 1, 0, 0, 0x3f, 0, 0, 0xff, 0xd9,
    ]
}

fn riff(chunks: &[Vec<u8>]) -> Vec<u8> {
    let mut body = b"WEBP".to_vec();
    body.extend(chunks.concat());
    let mut out = b"RIFF".to_vec();
    out.extend_from_slice(&u32::try_from(body.len()).unwrap().to_le_bytes());
    out.extend_from_slice(&body);
    out
}

fn riff_chunk(name: &[u8; 4], data: &[u8], padded: bool) -> Vec<u8> {
    let mut out = name.to_vec();
    out.extend_from_slice(&u32::try_from(data.len()).unwrap().to_le_bytes());
    out.extend_from_slice(data);
    if padded && data.len() % 2 == 1 {
        out.push(0);
    }
    out
}

fn lossless(width: u32, height: u32, padded: bool) -> Vec<u8> {
    let bits = (width - 1) | ((height - 1) << 14);
    let mut data = vec![0x2f];
    data.extend_from_slice(&bits.to_le_bytes());
    riff_chunk(b"VP8L", &data, padded)
}

fn canvas(width: u32, height: u32) -> Vec<u8> {
    let mut data = vec![0; 4];
    data.extend_from_slice(&(width - 1).to_le_bytes()[..3]);
    data.extend_from_slice(&(height - 1).to_le_bytes()[..3]);
    riff_chunk(b"VP8X", &data, true)
}

fn digest_of(bytes: &[u8]) -> String {
    format!("sha256:{}", hex::encode(Sha256::digest(bytes)))
}

fn etag_of(bytes: &[u8]) -> String {
    format!("\"{}\"", hex::encode(Sha256::digest(bytes)))
}

fn request(method: Method, path: &str, body: Body) -> Request<Body> {
    Request::builder()
        .method(method)
        .uri(path)
        .body(body)
        .unwrap()
}

impl Instance {
    async fn start(claimed: bool) -> Instance {
        let dir = TempDir::new().unwrap();
        let database = dir.path().join("marfa.db");
        let blobs = dir.path().join("blobs");
        let socket = dir.path().join("s.sock");
        let pairs = [
            ("SQLITE_PATH", database.to_str().unwrap()),
            ("BLOB_PATH", blobs.to_str().unwrap()),
            ("MARFA_CONTROL_SOCKET", socket.to_str().unwrap()),
            ("API_KEY_SALT", "a salt for these tests"),
            ("MARFA_TEST_HOOKS", "true"),
            ("MARFA_AUTH_BASE_URL", ORIGIN),
            ("RATE_LIMIT_ENABLED", "false"),
        ];
        let settings = Settings::read(Environment::from_pairs(&pairs)).unwrap();
        let app = App::start(settings).await.unwrap();
        let instance = Instance {
            public: public(app.clone()),
            control: control(app.clone()),
            app,
            _dir: dir,
        };
        if claimed {
            let claim = json!({ "email": EMAIL, "password": PASSWORD });
            let reply = instance
                .json(
                    &instance.control,
                    Method::POST,
                    "/_control/setup/claim",
                    &claim,
                )
                .await;
            assert_eq!(reply.status, StatusCode::CREATED);
        }
        instance
    }

    async fn json(&self, router: &Router, method: Method, path: &str, body: &Value) -> Reply {
        let mut built = request(method, path, Body::from(body.to_string()));
        built
            .headers_mut()
            .insert(header::CONTENT_TYPE, "application/json".parse().unwrap());
        built
            .headers_mut()
            .insert(header::ORIGIN, ORIGIN.parse().unwrap());
        send(router, built).await
    }

    /// Sent as the private local command.
    async fn put_local(&self, bytes: &[u8]) -> Reply {
        let body = Body::from(bytes.to_vec());
        send(&self.control, request(Method::PUT, "/owner/picture", body)).await
    }

    async fn served(&self) -> Reply {
        send(
            &self.control,
            request(Method::GET, "/owner/picture", Body::empty()),
        )
        .await
    }

    async fn cookie(&self) -> String {
        let body = json!({ "email": EMAIL, "password": PASSWORD });
        let reply = self
            .json(&self.public, Method::POST, "/auth/sign-in/email", &body)
            .await;
        let line = reply.headers[header::SET_COOKIE].to_str().unwrap();
        line.split(';').next().unwrap().to_string()
    }

    async fn key(&self, profile: Value) -> String {
        let body = json!({
            "label": "Picture",
            "source": format!("picture-{profile}"),
            "profile_permissions": profile,
        });
        let minted = self.json(&self.control, Method::POST, "/keys", &body).await;
        assert_eq!(minted.status, StatusCode::CREATED, "{:?}", minted.json());
        minted.json()["key"].as_str().unwrap().to_string()
    }

    async fn owner(&self) -> Value {
        let reply = send(&self.control, request(Method::GET, "/owner", Body::empty())).await;
        reply.json()
    }

    async fn put_with_key(&self, key: &str, bytes: &[u8]) -> Reply {
        let mut built = request(Method::PUT, "/profile/picture", Body::from(bytes.to_vec()));
        built.headers_mut().insert(
            header::AUTHORIZATION,
            format!("Bearer {key}").parse().unwrap(),
        );
        send(&self.public, built).await
    }

    fn pictures(&self) -> i64 {
        self.count("SELECT count(*) FROM owner_picture")
    }

    fn count(&self, sql: &'static str) -> i64 {
        let path = self._dir.path().join("marfa.db");
        let connection = rusqlite::Connection::open(path).unwrap();
        connection.query_row(sql, [], |row| row.get(0)).unwrap()
    }
}

#[tokio::test]
async fn a_picture_is_kept_served_replaced_and_removed() {
    let instance = Instance::start(true).await;
    assert!(instance.owner().await["avatar"].is_null());
    assert_eq!(instance.served().await.code(), "not_found");

    let first = png(1);
    let stored = instance.put_local(&first).await;
    assert_eq!(stored.status, StatusCode::OK);
    let address = format!("{ORIGIN}/owner/picture");
    assert_eq!(stored.json()["avatar"], address.as_str());
    assert_eq!(instance.owner().await["avatar"], address.as_str());

    let served = instance.served().await;
    assert_eq!(served.status, StatusCode::OK);
    assert_eq!(served.bytes, first);
    assert_eq!(served.headers[header::CONTENT_TYPE], "image/png");
    assert_eq!(served.headers[header::ETAG], etag_of(&first).as_str());
    assert_eq!(served.headers[header::X_CONTENT_TYPE_OPTIONS], "nosniff");

    let second = jpeg();
    assert_eq!(instance.put_local(&second).await.status, StatusCode::OK);
    let served = instance.served().await;
    assert_eq!(served.bytes, second);
    assert_eq!(served.headers[header::CONTENT_TYPE], "image/jpeg");
    assert_eq!(instance.pictures(), 1);

    let removed = instance
        .json(
            &instance.control,
            Method::PATCH,
            "/owner",
            &json!({ "avatar": null }),
        )
        .await;
    assert_eq!(removed.status, StatusCode::OK);
    assert!(removed.json()["avatar"].is_null());
    assert_eq!(instance.served().await.code(), "not_found");
    assert_eq!(instance.pictures(), 0);
}

#[tokio::test]
async fn a_refused_picture_stores_nothing_and_keeps_the_previous_one() {
    let instance = Instance::start(true).await;
    let kept = png(2);
    assert_eq!(instance.put_local(&kept).await.status, StatusCode::OK);
    let blobs = instance.count("SELECT count(*) FROM blobs");

    let whole = png(3);
    let refused: Vec<(&str, Vec<u8>)> = vec![
        ("empty", vec![]),
        (
            "svg",
            b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>".to_vec(),
        ),
        ("gif", b"GIF89a\x01\x00\x01\x00".to_vec()),
        ("cut short", whole[..whole.len() - 1].to_vec()),
        ("a byte past the end", [whole.clone(), vec![0]].concat()),
        ("huge declared size", png_sized(60_000, 60_000, 3, 0)),
        ("no width", png_sized(0, 8, 3, 0)),
        ("one past the limit", png_sized(4097, 1, 3, 0)),
        (
            "a webp image past the limit inside a one pixel canvas",
            riff(&[canvas(1, 1), lossless(4097, 1, true)]),
        ),
        (
            "a webp image that is not the canvas",
            riff(&[canvas(8, 8), lossless(4, 4, true)]),
        ),
        (
            "a webp chunk without its padding byte",
            riff(&[lossless(8, 8, false)]),
        ),
    ];
    for (label, bytes) in refused {
        let reply = instance.put_local(&bytes).await;
        assert_eq!(reply.status, StatusCode::BAD_REQUEST, "{label}");
        assert_eq!(reply.code(), "validation_error", "{label}");
    }
    let over = png_sized(8, 8, 3, LIMIT);
    let reply = instance.put_local(&over).await;
    assert_eq!(reply.status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(reply.code(), "request_too_large");

    assert_eq!(instance.served().await.bytes, kept);
    assert_eq!(instance.count("SELECT count(*) FROM blobs"), blobs);
    let witness = instance.put_local(&png_sized(4096, 1, 3, 0)).await;
    assert_eq!(witness.status, StatusCode::OK);
    let webp = riff(&[canvas(8, 8), lossless(8, 8, true)]);
    assert_eq!(instance.put_local(&webp).await.status, StatusCode::OK);
}

#[tokio::test]
async fn a_body_that_stops_before_its_end_changes_nothing() {
    let instance = Instance::start(true).await;
    let kept = png(4);
    assert_eq!(instance.put_local(&kept).await.status, StatusCode::OK);

    let next = png(5);
    let dropped = Frames(VecDeque::from([
        Ok(next.clone()),
        Err(std::io::Error::other("the connection closed")),
    ]));
    let reply = send(
        &instance.control,
        request(Method::PUT, "/owner/picture", Body::new(dropped)),
    )
    .await;
    assert!(!reply.status.is_success(), "{}", reply.status);
    assert_eq!(instance.served().await.bytes, kept);

    assert_eq!(instance.put_local(&next).await.status, StatusCode::OK);
    assert_eq!(instance.served().await.bytes, next);
}

#[tokio::test]
async fn a_body_past_the_limit_is_refused_before_its_end_arrives() {
    let instance = Instance::start(true).await;
    let kept = png(6);
    assert_eq!(instance.put_local(&kept).await.status, StatusCode::OK);

    let endless = Frames((0..64).map(|_| Ok(vec![0u8; 64 * 1024])).collect());
    let reply = send(
        &instance.control,
        request(Method::PUT, "/owner/picture", Body::new(endless)),
    )
    .await;
    assert_eq!(reply.status, StatusCode::PAYLOAD_TOO_LARGE);

    let mut declared = request(Method::PUT, "/owner/picture", Body::empty());
    declared.headers_mut().insert(
        header::CONTENT_LENGTH,
        (LIMIT + 1).to_string().parse().unwrap(),
    );
    let reply = send(&instance.control, declared).await;
    assert_eq!(reply.status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(instance.served().await.bytes, kept);
}

#[tokio::test]
async fn two_pictures_sent_at_once_leave_one_whole() {
    let instance = Instance::start(true).await;
    let (one, two) = (png(7), jpeg());
    let (first, second) = tokio::join!(instance.put_local(&one), instance.put_local(&two));
    assert_eq!(first.status, StatusCode::OK);
    assert_eq!(second.status, StatusCode::OK);
    let served = instance.served().await;
    assert!(served.bytes == one || served.bytes == two);
    let kind = if served.bytes == one {
        "image/png"
    } else {
        "image/jpeg"
    };
    assert_eq!(served.headers[header::CONTENT_TYPE], kind);
    assert_eq!(
        served.headers[header::ETAG],
        etag_of(&served.bytes).as_str()
    );
    assert_eq!(instance.pictures(), 1);
}

#[tokio::test]
async fn an_unavailable_owner_is_refused_and_nothing_is_stored() {
    let instance = Instance::start(false).await;
    let reply = instance.put_local(&png(8)).await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);
    assert_eq!(reply.code(), "owner_not_found");
    assert_eq!(instance.pictures(), 0);
    assert_eq!(instance.count("SELECT count(*) FROM blobs"), 0);
    let _ = &instance.app;
}

#[tokio::test]
async fn the_owner_door_takes_a_recent_sign_in_and_the_profile_door_a_key_that_may_write() {
    let instance = Instance::start(true).await;
    let cookie = instance.cookie().await;
    let kept = png(9);
    let signed_in = |bytes: &[u8]| {
        let mut built = request(Method::PUT, "/owner/picture", Body::from(bytes.to_vec()));
        built
            .headers_mut()
            .insert(header::COOKIE, cookie.parse().unwrap());
        built
            .headers_mut()
            .insert(header::ORIGIN, ORIGIN.parse().unwrap());
        built
    };
    assert_eq!(
        send(&instance.public, signed_in(&kept)).await.status,
        StatusCode::OK
    );

    let writer = instance.key(json!({ "avatar": "write" })).await;
    let over_http = send(&instance.public, {
        let mut built = request(Method::GET, "/owner/picture", Body::empty());
        built.headers_mut().insert(
            header::AUTHORIZATION,
            format!("Bearer {writer}").parse().unwrap(),
        );
        built
    })
    .await;
    assert_eq!(over_http.bytes, kept);
    assert_eq!(
        over_http.headers[header::CACHE_CONTROL],
        "private, no-cache"
    );
    assert_eq!(
        over_http.headers[header::CONTENT_SECURITY_POLICY],
        "sandbox; default-src 'none'"
    );
    assert_eq!(
        over_http.headers[header::CONTENT_DISPOSITION],
        "attachment; filename=\"picture\""
    );
    let reader = instance.key(json!({ "avatar": "read" })).await;
    let named = instance.key(json!({ "name": "write" })).await;
    let next = jpeg();
    for refused in [&reader, &named] {
        let reply = instance.put_with_key(refused, &next).await;
        assert_eq!(reply.status, StatusCode::FORBIDDEN);
        assert_eq!(reply.code(), "forbidden");
    }
    assert_eq!(instance.served().await.bytes, kept);
    let reply = instance.put_with_key(&writer, &next).await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.json(), json!({ "ok": true }));
    assert_eq!(instance.served().await.bytes, next);

    instance.app.clock.advance(300_001).unwrap();
    let late = send(&instance.public, signed_in(&kept)).await;
    assert_eq!(late.status, StatusCode::FORBIDDEN);
    assert_eq!(instance.served().await.bytes, next);
    assert_eq!(instance.put_local(&kept).await.status, StatusCode::OK);
}

#[tokio::test]
async fn the_profile_door_removes_the_picture_and_changes_the_name_in_one_step() {
    let instance = Instance::start(true).await;
    let kept = png(10);
    assert_eq!(instance.put_local(&kept).await.status, StatusCode::OK);
    let named = instance.key(json!({ "name": "write" })).await;
    let patch = |key: &str, body: Value| {
        let mut built = request(Method::PATCH, "/profile", Body::from(body.to_string()));
        built
            .headers_mut()
            .insert(header::CONTENT_TYPE, "application/json".parse().unwrap());
        built.headers_mut().insert(
            header::AUTHORIZATION,
            format!("Bearer {key}").parse().unwrap(),
        );
        built
    };
    let before = instance.owner().await;
    let refused = send(
        &instance.public,
        patch(&named, json!({ "name": "Changed", "avatar": null })),
    )
    .await;
    assert_eq!(refused.status, StatusCode::FORBIDDEN);
    assert_eq!(instance.owner().await, before);
    assert_eq!(instance.served().await.bytes, kept);

    for body in [
        json!({}),
        json!({ "email": "x@example.test" }),
        json!({ "avatar": "https://example.test/p.png" }),
    ] {
        let reply = send(&instance.public, patch(&named, body)).await;
        assert_eq!(reply.status, StatusCode::BAD_REQUEST);
    }

    let writer = instance.key(json!({ "*": "write" })).await;
    let reply = send(
        &instance.public,
        patch(&writer, json!({ "name": "Changed", "avatar": null })),
    )
    .await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.json(), json!({ "ok": true }));
    let after = instance.owner().await;
    assert_eq!(after["name"], "Changed");
    assert!(after["avatar"].is_null());
    assert_eq!(instance.served().await.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn a_validator_that_still_matches_gets_304_and_a_stale_one_gets_the_picture() {
    let instance = Instance::start(true).await;
    let file = png(11);
    assert_eq!(instance.put_local(&file).await.status, StatusCode::OK);
    let conditional = |tag: &str| {
        let mut built = request(Method::GET, "/owner/picture", Body::empty());
        built
            .headers_mut()
            .insert(header::IF_NONE_MATCH, tag.parse().unwrap());
        built
    };
    let same = send(&instance.control, conditional(&etag_of(&file))).await;
    assert_eq!(same.status, StatusCode::NOT_MODIFIED);
    assert!(same.bytes.is_empty());
    assert_eq!(same.headers[header::ETAG], etag_of(&file).as_str());
    let stale = send(&instance.control, conditional("\"0000\"")).await;
    assert_eq!(stale.status, StatusCode::OK);
    assert_eq!(stale.bytes, file);
}

impl Instance {
    fn references(&self) -> Vec<(String, String, bool)> {
        let path = self._dir.path().join("marfa.db");
        let connection = rusqlite::Connection::open(path).unwrap();
        let mut statement = connection
            .prepare("SELECT hash, kind, lends FROM blob_references ORDER BY hash, kind")
            .unwrap();
        statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    }

    async fn blob_status(&self, key: &str, hash: &str) -> StatusCode {
        let mut built = request(Method::GET, &format!("/blobs/{hash}"), Body::empty());
        built.headers_mut().insert(
            header::AUTHORIZATION,
            format!("Bearer {key}").parse().unwrap(),
        );
        send(&self.public, built).await.status
    }

    async fn plain_key(&self, source: &str, grants: Value) -> String {
        let mut body = json!({ "label": source, "source": source, "permissions": [] });
        body.as_object_mut()
            .unwrap()
            .extend(grants.as_object().unwrap().clone());
        let minted = self.json(&self.control, Method::POST, "/keys", &body).await;
        assert_eq!(minted.status, StatusCode::CREATED, "{:?}", minted.json());
        minted.json()["key"].as_str().unwrap().to_string()
    }
}

#[tokio::test]
async fn the_picture_is_a_row_of_the_reference_index_that_follows_it_and_lends_nothing() {
    let instance = Instance::start(true).await;
    assert!(instance.references().is_empty());

    let first = png(20);
    assert_eq!(instance.put_local(&first).await.status, StatusCode::OK);
    let held = digest_of(&first);
    assert_eq!(
        instance.references(),
        vec![(held.clone(), "owner".to_string(), false)]
    );
    assert_eq!(instance.put_local(&first).await.status, StatusCode::OK);
    assert_eq!(instance.references().len(), 1);

    let second = jpeg();
    assert_eq!(instance.put_local(&second).await.status, StatusCode::OK);
    assert_eq!(
        instance.references(),
        vec![(digest_of(&second), "owner".to_string(), false)]
    );

    let refused = instance.put_local(&png_sized(4097, 1, 3, 0)).await;
    assert_eq!(refused.status, StatusCode::BAD_REQUEST);
    assert_eq!(
        instance.references(),
        vec![(digest_of(&second), "owner".to_string(), false)]
    );

    let removed = instance
        .json(
            &instance.control,
            Method::PATCH,
            "/owner",
            &json!({ "avatar": null }),
        )
        .await;
    assert_eq!(removed.status, StatusCode::OK);
    assert!(instance.references().is_empty());

    assert_eq!(instance.put_local(&first).await.status, StatusCode::OK);
    let clearing = instance.key(json!({ "avatar": "write" })).await;
    let mut built = request(
        Method::PATCH,
        "/profile",
        Body::from(json!({ "avatar": null }).to_string()),
    );
    built
        .headers_mut()
        .insert(header::CONTENT_TYPE, "application/json".parse().unwrap());
    built.headers_mut().insert(
        header::AUTHORIZATION,
        format!("Bearer {clearing}").parse().unwrap(),
    );
    let cleared = send(&instance.public, built).await;
    assert_eq!(cleared.status, StatusCode::OK, "{:?}", cleared.json());
    assert!(instance.references().is_empty());
}

#[tokio::test]
async fn a_key_holding_every_type_reads_the_picture_blob_only_where_another_row_lends_it() {
    let instance = Instance::start(true).await;
    let kept = png(21);
    assert_eq!(instance.put_local(&kept).await.status, StatusCode::OK);
    let hash = digest_of(&kept);

    let every = instance
        .plain_key("every", json!({ "type_permissions": { "*": "write" } }))
        .await;
    assert_eq!(
        instance.blob_status(&every, &hash).await,
        StatusCode::NOT_FOUND
    );
    let manager = instance
        .plain_key("manager", json!({ "permissions": ["blobs.manage"] }))
        .await;
    assert_eq!(instance.blob_status(&manager, &hash).await, StatusCode::OK);

    let mut upload = request(Method::POST, "/blobs", Body::from(kept.clone()));
    upload.headers_mut().insert(
        header::AUTHORIZATION,
        format!("Bearer {every}").parse().unwrap(),
    );
    assert_eq!(
        send(&instance.public, upload).await.status,
        StatusCode::CREATED
    );
    let body = json!({ "type": "core.note", "properties": { "body": format!("![x]({hash})") } });
    let mut note = request(Method::POST, "/items", Body::from(body.to_string()));
    note.headers_mut().insert(
        header::AUTHORIZATION,
        format!("Bearer {every}").parse().unwrap(),
    );
    note.headers_mut()
        .insert(header::CONTENT_TYPE, "application/json".parse().unwrap());
    assert_eq!(
        send(&instance.public, note).await.status,
        StatusCode::CREATED
    );
    assert_eq!(instance.blob_status(&every, &hash).await, StatusCode::OK);
}
