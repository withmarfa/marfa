use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::task::{Context, Poll};
use std::time::Duration;

use axum::body::{Body, Bytes, HttpBody};
use axum::extract::{FromRequest, MatchedPath, Request, State};
use axum::http::{Extensions, HeaderMap, HeaderValue, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use http_body::{Frame, SizeHint};
use http_body_util::BodyExt;
use marfa_rules::{integers, json_text};
use serde_json::{Map, Value, json};

use super::answer::{Stopped, refusal_answer};
use super::caller::presents;
use super::doors::Credentials;
use super::observe::RequestContext;
use crate::app::App;
use crate::app::items::write::ruled;
use crate::app::oauth::resource::MCP_PATHS;
use crate::app::refusal::{Code, Refusal};
use crate::listener::Transport;
use crate::settings::registry::MAX_REQUEST_BYTES;

const LINGER: Duration = Duration::from_secs(5);
const LINGER_BYTES: usize = 64 * 1024 * 1024;
const BULK_PATHS: [&str; 2] = ["/items/bulk", "/items/bulk-actions"];
const STATE_REQUEST_BYTES: usize = 2 * 512 * 1024 + 100 * 6 + 35;
const CONNECTORS_PATH: &str = "/connectors";
const REGISTER_PATH: &str = "/auth/oauth2/register";
const PLAIN_JSON: &str = "application/json";
const REGISTER_REQUEST_BYTES: usize = 32 * 1024;
const CONFIG_PATH: &str = "/config";

/// `finish` keeps reading so a refusal that leaves a body unread still arrives.
#[derive(Clone)]
pub struct Shared {
    body: Arc<Mutex<Body>>,
    ended: Arc<AtomicBool>,
}

impl Shared {
    pub fn new(body: Body) -> Shared {
        Shared {
            ended: Arc::new(AtomicBool::new(body.is_end_stream())),
            body: Arc::new(Mutex::new(body)),
        }
    }

    fn held(&self) -> MutexGuard<'_, Body> {
        self.body.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Whether the body has been read to its end.
    pub fn is_whole(&self) -> bool {
        self.ended.load(Ordering::Acquire)
    }

    pub fn finish(mut self) {
        if self.is_end_stream() {
            return;
        }
        tokio::spawn(async move {
            let discard = async {
                let mut read = 0;
                while read < LINGER_BYTES {
                    match self.frame().await {
                        Some(Ok(frame)) => {
                            read += frame.data_ref().map_or(0, Bytes::len);
                        }
                        _ => break,
                    }
                }
            };
            let _ = tokio::time::timeout(LINGER, discard).await;
        });
    }
}

impl HttpBody for Shared {
    type Data = Bytes;
    type Error = axum::Error;

    fn poll_frame(
        self: Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, axum::Error>>> {
        let polled = Pin::new(&mut *self.held()).poll_frame(context);
        if matches!(polled, Poll::Ready(None)) {
            self.ended.store(true, Ordering::Release);
        }
        polled
    }

    fn is_end_stream(&self) -> bool {
        let end = self.held().is_end_stream();
        if end {
            self.ended.store(true, Ordering::Release);
        }
        end
    }

    fn size_hint(&self) -> SizeHint {
        self.held().size_hint()
    }
}

/// The private socket's body deadline; the public one is `Tuning::body_deadline`.
pub const CONTROL_BODY_DEADLINE: Duration = Duration::from_secs(30);

#[derive(Debug, thiserror::Error)]
#[error("the body did not arrive in time")]
struct Late;

/// A body that ends in an error once its deadline passes before it is whole.
struct Due {
    body: Body,
    until: Pin<Box<tokio::time::Sleep>>,
    late: Arc<AtomicBool>,
}

impl HttpBody for Due {
    type Data = Bytes;
    type Error = axum::Error;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, axum::Error>>> {
        if let Poll::Ready(frame) = Pin::new(&mut self.body).poll_frame(context) {
            return Poll::Ready(frame);
        }
        if self.until.as_mut().poll(context).is_pending() {
            return Poll::Pending;
        }
        self.late.store(true, Ordering::Release);
        Poll::Ready(Some(Err(axum::Error::new(Late))))
    }

    fn is_end_stream(&self) -> bool {
        self.body.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        self.body.size_hint()
    }
}

/// Reads and drops the rest of a refused body, so a client still sending reaches the answer.
pub async fn linger(body: &mut Body, idle: Duration) {
    while !body.is_end_stream() {
        match tokio::time::timeout(idle, body.frame()).await {
            Ok(Some(Ok(_))) => {}
            _ => return,
        }
    }
}

fn due(body: Body, within: Duration, late: Arc<AtomicBool>) -> Body {
    Body::new(Due {
        body,
        until: Box::pin(tokio::time::sleep(within)),
        late,
    })
}

/// Holds each request's body to arriving whole within `within`. A body that
/// does not is answered `408`, and its connection is not kept.
pub async fn due_within(State(within): State<Duration>, request: Request, next: Next) -> Response {
    if super::profile::reads_own_body(&request) {
        return next.run(request).await;
    }
    let late = Arc::new(AtomicBool::new(false));
    let request = request.map(|body| due(body, within, late.clone()));
    let mut response = next.run(request).await;
    if late.load(Ordering::Acquire) {
        response
            .headers_mut()
            .insert(header::CONNECTION, HeaderValue::from_static("close"));
    }
    response
}

fn arrived_late(error: &axum::Error) -> bool {
    std::iter::successors(Some(error as &(dyn std::error::Error + 'static)), |error| {
        error.source()
    })
    .any(|error| error.is::<Late>())
}

pub struct JsonBody {
    headers: HeaderMap,
    body: Body,
    limit: usize,
}

impl FromRequest<Arc<App>> for JsonBody {
    type Rejection = Stopped;

    async fn from_request(request: Request, app: &Arc<App>) -> Result<JsonBody, Stopped> {
        let (parts, body) = request.into_parts();
        let limit = cap_on(app, parts.uri.path(), &parts.extensions);
        Ok(JsonBody {
            headers: parts.headers,
            body,
            limit,
        })
    }
}

fn cap_on(app: &App, path: &str, extensions: &Extensions) -> usize {
    if BULK_PATHS.contains(&path) {
        return app.bulk_cap();
    }
    if path == REGISTER_PATH {
        return REGISTER_REQUEST_BYTES;
    }
    if let Some(cap) = connector_cap(app, path) {
        return cap;
    }
    let local = extensions
        .get::<RequestContext>()
        .is_some_and(|context| context.transport == Transport::LocalSocket);
    // The stored cap can be too small for the body that would raise it, and
    // the local command is the way back from that.
    let live = app.settings.live().get(MAX_REQUEST_BYTES);
    let cap = if local && path == CONFIG_PATH {
        live.max(MAX_REQUEST_BYTES.default_value())
    } else {
        live
    };
    usize::try_from(cap).unwrap_or(usize::MAX)
}

fn under_connectors(path: &str) -> bool {
    path.strip_prefix(CONNECTORS_PATH)
        .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
}

/// The state document and the agreements batch carry more than the usual cap.
fn connector_cap(app: &App, path: &str) -> Option<usize> {
    let mut parts = path.strip_prefix("/connectors/")?.split('/').skip(1);
    match (parts.next(), parts.next()) {
        (Some("state"), None) => Some(STATE_REQUEST_BYTES),
        (Some("agreements"), None) => Some(app.bulk_cap()),
        _ => None,
    }
}

fn essence_of(content_type: &str) -> String {
    content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase()
}

fn is_json(content_type: &str) -> bool {
    let essence = essence_of(content_type);
    essence == PLAIN_JSON
        || essence
            .strip_prefix("application/")
            .is_some_and(|subtype| subtype.ends_with("+json") && subtype.len() > "+json".len())
}

fn declared_length(headers: &HeaderMap) -> Option<usize> {
    headers
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse().ok())
}

fn too_large(limit: usize) -> Refusal {
    Refusal::new(
        Code::RequestTooLarge,
        format!("The body is larger than {limit} bytes."),
    )
}

async fn buffered(body: Body, limit: usize) -> Result<Bytes, Stopped> {
    axum::body::to_bytes(body, limit).await.map_err(|error| {
        let over = std::error::Error::source(&error)
            .is_some_and(|source| source.is::<http_body_util::LengthLimitError>());
        if over {
            too_large(limit).into()
        } else if arrived_late(&error) {
            Refusal::new(
                Code::RequestTimeout,
                "The body did not arrive in the time allowed.",
            )
            .into()
        } else {
            Stopped::ClientClosed
        }
    })
}

impl JsonBody {
    async fn bytes(self) -> Result<Bytes, Stopped> {
        if declared_length(&self.headers) > Some(self.limit) {
            return Err(too_large(self.limit).into());
        }
        buffered(self.body, self.limit).await
    }

    pub fn require_json(&self) -> Result<(), Refusal> {
        if self.declares_json() {
            Ok(())
        } else {
            Err(not_json())
        }
    }

    fn declares_json(&self) -> bool {
        self.headers
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(is_json)
    }

    pub fn declares_plain_json(&self) -> bool {
        self.headers
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| essence_of(value) == PLAIN_JSON)
    }

    pub fn declares_form(&self) -> bool {
        self.headers
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| {
                value
                    .to_ascii_lowercase()
                    .starts_with("application/x-www-form-urlencoded")
            })
    }

    pub async fn form(self) -> Result<Map<String, Value>, Stopped> {
        let mut fields = Map::new();
        for (name, value) in form_urlencoded::parse(&self.bytes().await?) {
            fields
                .entry(name.into_owned())
                .or_insert_with(|| value.into_owned().into());
        }
        Ok(fields)
    }

    pub async fn read(self) -> Result<ReadBody, Stopped> {
        let declared = self.declares_json();
        Ok(ReadBody {
            declared,
            bytes: self.bytes().await?,
        })
    }

    pub async fn form_pairs(self) -> Result<Vec<(String, String)>, Stopped> {
        if !self.declares_form() {
            return Ok(Vec::new());
        }
        let bytes = self.bytes().await?;
        Ok(form_urlencoded::parse(&bytes).into_owned().collect())
    }

    pub async fn object(self, allowed: &[&str]) -> Result<Map<String, Value>, Stopped> {
        Ok(only_declared(self.open_object().await?, allowed)?)
    }

    pub async fn open_object(self) -> Result<Map<String, Value>, Stopped> {
        if !self.declares_json() {
            return Err(not_json().into());
        }
        Ok(parsed_object(&self.bytes().await?, None)?)
    }
}

fn not_json() -> Refusal {
    Refusal::validation("Send the body as JSON, with Content-Type: application/json.")
}

pub fn only_declared(
    object: Map<String, Value>,
    allowed: &[&str],
) -> Result<Map<String, Value>, Refusal> {
    let mut unknown: Vec<&str> = object
        .keys()
        .map(String::as_str)
        .filter(|key| !allowed.contains(key))
        .collect();
    if unknown.is_empty() {
        return Ok(object);
    }
    unknown.sort_unstable();
    Err(Refusal::validation(format!(
        "The body names fields this operation does not take: {}.",
        unknown.join(", ")
    ))
    .with_detail("unknown_body_fields", unknown))
}

/// `bytes` as a JSON object. A parse stops at a number too large for a float,
/// so `bag` names where such a number is the operation's to refuse by name.
fn parsed_object(bytes: &[u8], bag: Option<Bag>) -> Result<Map<String, Value>, Refusal> {
    if bytes.is_empty() {
        return Err(Refusal::validation(
            "The body is empty; send a JSON object.",
        ));
    }
    match serde_json::from_slice::<Value>(bytes) {
        Ok(Value::Object(object)) => Ok(object),
        Ok(_) => Err(Refusal::validation("The body must be a JSON object.")),
        Err(error) => {
            if let (Some(bag), Ok(text)) = (bag, std::str::from_utf8(bytes)) {
                bag.refuse_inexact_numbers(text)?;
            }
            Err(Refusal::validation(format!(
                "The body is not valid JSON: {error}"
            )))
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub enum Bag {
    Properties,
    /// A bulk action's `patch`, which it lays over each item's properties.
    Patch,
    Entries(&'static str),
    Whole,
}

impl Bag {
    fn refuse_inexact_numbers(self, text: &str) -> Result<(), Refusal> {
        let member = match self {
            Bag::Properties => Some("properties"),
            Bag::Patch => Some("patch"),
            Bag::Whole => None,
            Bag::Entries(list) => {
                return match integers::inexact_entry(text, list, "properties") {
                    Some((index, error)) => Err(ruled(error).with_detail("index", index)),
                    None => Ok(()),
                };
            }
        };
        integers::refuse_inexact_integers_in(text, member).map_err(ruled)
    }
}

#[derive(Debug)]
pub struct ReadBody {
    declared: bool,
    bytes: Bytes,
}

impl ReadBody {
    pub fn declares_json(&self) -> bool {
        self.declared
    }

    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    pub fn object(&self, bag: Bag) -> Result<Map<String, Value>, Refusal> {
        if !self.declared {
            return Err(not_json());
        }
        parsed_object(&self.bytes, Some(bag))
    }

    /// As [`JsonBody::object`] reads it.
    pub fn declared_object(&self, allowed: &[&str]) -> Result<Map<String, Value>, Refusal> {
        if !self.declared {
            return Err(not_json());
        }
        only_declared(parsed_object(&self.bytes, None)?, allowed)
    }

    pub fn refuse_inexact_numbers(&self, bag: Bag) -> Result<(), Refusal> {
        match std::str::from_utf8(&self.bytes) {
            Ok(text) => bag.refuse_inexact_numbers(text),
            Err(_) => Ok(()),
        }
    }
}

fn nested_too_deep() -> Refusal {
    Refusal::validation("The body nests deeper than 64 levels.")
}

fn ill_formed(pointer: String) -> Refusal {
    let message = "The body holds text that is not well-formed: a surrogate escape has no partner.";
    Refusal::validation(message)
        .with_detail("errors", json!([{ "path": pointer, "message": message }]))
}

#[derive(Clone)]
pub struct Checking {
    pub app: Arc<App>,
    pub credentials: Arc<Credentials>,
}

/// A connector's declared size takes precedence over its credential.
pub async fn checked(State(checking): State<Checking>, request: Request, next: Next) -> Response {
    let app = &checking.app;
    let path = request.uri().path();
    let limit = cap_on(app, path, request.extensions());
    // The MCP doors judge the origin and the credential before they read the body.
    if super::profile::reads_own_body(&request)
        || request.body().is_end_stream()
        || MCP_PATHS.contains(&path)
    {
        return next.run(request).await;
    }
    let over = declared_length(request.headers()) > Some(limit);
    if over && under_connectors(path) {
        return refusal_answer(&too_large(limit));
    }
    let (mut parts, body) = request.into_parts();
    let door = parts
        .extensions
        .get::<MatchedPath>()
        .and_then(|matched| {
            checking
                .credentials
                .get(&(parts.method.clone(), matched.as_str()))
        })
        .copied();
    if let Some((asks, admission)) = door
        && let Err(refusal) = presents(&mut parts, app, asks, admission).await
    {
        return refusal_answer(&refusal);
    }
    if over {
        return next.run(Request::from_parts(parts, body)).await;
    }
    let bytes = match buffered(body, limit).await {
        Ok(bytes) => bytes,
        Err(stopped) => return stopped.into_response(),
    };
    if let Err(refusal) = scanned(&bytes) {
        return refusal_answer(&refusal);
    }
    next.run(Request::from_parts(parts, Body::from(bytes)))
        .await
}

fn scanned(bytes: &[u8]) -> Result<(), Refusal> {
    if json_text::too_deep(bytes) {
        return Err(nested_too_deep());
    }
    match json_text::ill_formed_at(bytes) {
        Some(pointer) => Err(ill_formed(pointer)),
        None => Ok(()),
    }
}

#[cfg(test)]
mod due_tests {
    use super::*;

    /// A body that sends one frame and then nothing more.
    struct Stalled(bool);

    impl HttpBody for Stalled {
        type Data = Bytes;
        type Error = axum::Error;

        fn poll_frame(
            mut self: Pin<&mut Self>,
            _: &mut Context<'_>,
        ) -> Poll<Option<Result<Frame<Bytes>, axum::Error>>> {
            if self.0 {
                return Poll::Pending;
            }
            self.0 = true;
            Poll::Ready(Some(Ok(Frame::data(Bytes::from_static(b"{")))))
        }
    }

    #[tokio::test]
    async fn a_body_that_stops_arriving_is_answered_408_at_its_deadline() {
        let late = Arc::new(AtomicBool::new(false));
        let body = due(
            Body::new(Stalled(false)),
            Duration::from_millis(50),
            late.clone(),
        );
        let started = std::time::Instant::now();
        match buffered(body, 1024).await {
            Err(Stopped::Refused(refusal)) => assert_eq!(refusal.code, Code::RequestTimeout),
            other => panic!("{other:?}"),
        }
        assert!(started.elapsed() >= Duration::from_millis(50));
        assert!(late.load(Ordering::Acquire));
    }

    #[tokio::test]
    async fn a_body_that_arrives_in_time_is_read_whole() {
        let late = Arc::new(AtomicBool::new(false));
        let body = due(Body::from("{}"), Duration::from_millis(50), late.clone());
        tokio::time::sleep(Duration::from_millis(80)).await;
        assert_eq!(
            buffered(body, 1024).await.unwrap(),
            Bytes::from_static(b"{}")
        );
        assert!(!late.load(Ordering::Acquire));
    }
}

#[cfg(test)]
mod presented_tests {
    use std::collections::BTreeSet;

    use axum::http::{Method, StatusCode};
    use tower::ServiceExt;

    use super::*;
    use crate::http::doors::Asks;
    use crate::http::test_instance::{Instance, start};
    use crate::http::{public_doors, shared};

    const ID: &str = "019537a0-7b80-7000-8000-0000000000ff";
    const PROMPT: Duration = Duration::from_secs(2);

    struct Held;

    impl HttpBody for Held {
        type Data = Bytes;
        type Error = axum::Error;

        fn poll_frame(
            self: Pin<&mut Self>,
            _: &mut Context<'_>,
        ) -> Poll<Option<Result<Frame<Bytes>, axum::Error>>> {
            Poll::Pending
        }
    }

    fn request(method: &Method, path: &str, key: Option<&str>, body: Body) -> Request {
        let mut at = path.replace("{*path}", "x");
        while let Some(open) = at.find('{') {
            let close = at[open..].find('}').unwrap() + open;
            at.replace_range(open..=close, ID);
        }
        let mut request = Request::builder()
            .method(method)
            .uri(at)
            .header(header::CONTENT_TYPE, "application/json");
        if let Some(key) = key {
            request = request.header(header::AUTHORIZATION, format!("Bearer {key}"));
        }
        request.body(body).unwrap()
    }

    async fn answer(instance: &Instance, request: Request) -> Option<StatusCode> {
        let sent = instance.public.clone().oneshot(request);
        tokio::time::timeout(PROMPT, sent)
            .await
            .ok()
            .map(|answer| answer.unwrap().status())
    }

    #[tokio::test]
    async fn a_door_that_asks_a_credential_refuses_none_with_the_body_unread_as_the_door_would() {
        let instance = start().await;
        let mut asked = 0;
        let mut disagree = Vec::new();
        for ((method, path), (asks, _)) in public_doors(instance.app.clone()).credentials() {
            if asks == Asks::Nothing {
                continue;
            }
            asked += 1;
            let bare = answer(&instance, request(&method, path, None, Body::empty())).await;
            let held_request = request(&method, path, None, Body::new(Held));
            let held = if super::super::profile::reads_own_body(&held_request) {
                bare
            } else {
                answer(&instance, held_request).await
            };
            if (bare, held) != (Some(StatusCode::UNAUTHORIZED), bare) {
                disagree.push(format!("{method} {path}: {bare:?}, {held:?} with a body"));
            }
        }
        assert!(asked > 100, "the witness: {asked} doors");
        assert_eq!(disagree, Vec::<String>::new());
    }

    #[tokio::test]
    async fn a_key_the_instance_holds_is_read_past_and_one_it_does_not_is_refused() {
        let instance = start().await;
        let held = |key| request(&Method::POST, "/items", Some(key), Body::new(Held));
        assert_eq!(answer(&instance, held(&instance.key)).await, None);
        let unknown = format!("{}x", instance.key);
        assert_eq!(
            answer(&instance, held(&unknown)).await,
            Some(StatusCode::UNAUTHORIZED)
        );
    }

    #[tokio::test]
    async fn the_shared_doors_that_ask_nothing_are_the_root_health_document_link_and_claim() {
        let instance = start().await;
        let open: BTreeSet<String> = shared(instance.app.clone())
            .credentials()
            .into_iter()
            .filter(|(_, (asks, _))| *asks == Asks::Nothing)
            .map(|((method, path), _)| format!("{method} {path}"))
            .collect();
        let expected = [
            "GET /",
            "GET /blobs/{hash}/fetch",
            "GET /health",
            "GET /openapi.json",
            "HEAD /blobs/{hash}/fetch",
            "POST /owner",
        ]
        .map(String::from);
        assert_eq!(open, BTreeSet::from(expected));
    }
}
