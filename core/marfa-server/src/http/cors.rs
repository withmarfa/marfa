//! Which web pages may call the API from a browser, and what a preflight allows them.

use std::collections::BTreeSet;
use std::sync::{Arc, LazyLock};

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::header::{
    ACCESS_CONTROL_ALLOW_HEADERS, ACCESS_CONTROL_ALLOW_METHODS, ACCESS_CONTROL_ALLOW_ORIGIN,
    ACCESS_CONTROL_EXPOSE_HEADERS, ACCESS_CONTROL_REQUEST_HEADERS, ACCESS_CONTROL_REQUEST_METHOD,
    ORIGIN, VARY,
};
use axum::http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};

use super::doors::Doors;
use super::root::DOCUMENT;
use crate::app::App;
use crate::app::oauth::clients::page_approved;

/// RFC 9700 section 2.6: no page's scripts may read these.
const AUTHORIZATION_DOORS: [&str; 3] =
    ["/oauth/authorize", "/auth/consent", "/auth/device/consent"];

/// A browser lets a page read only the safelisted response headers unless the answer lists the rest.
const SAFELISTED: [&str; 7] = [
    "cache-control",
    "content-language",
    "content-length",
    "content-type",
    "expires",
    "last-modified",
    "pragma",
];

fn response_headers(response: &serde_json::Value, found: &mut BTreeSet<String>) {
    if let Some(headers) = response
        .get("headers")
        .and_then(|headers| headers.as_object())
    {
        found.extend(headers.keys().cloned());
    }
}

fn declared_headers(document: &serde_json::Value) -> BTreeSet<String> {
    let mut found = BTreeSet::new();
    let operations = document["paths"].as_object().into_iter().flatten();
    for operation in operations.flat_map(|(_, path)| path.as_object().into_iter().flatten()) {
        for response in operation.1["responses"].as_object().into_iter().flatten() {
            response_headers(response.1, &mut found);
        }
    }
    for response in document["components"]["responses"]
        .as_object()
        .into_iter()
        .flatten()
    {
        response_headers(response.1, &mut found);
    }
    found
}

/// Pages need access to the response headers declared in the document.
static EXPOSED: LazyLock<Option<HeaderValue>> = LazyLock::new(|| {
    let document: serde_json::Value = serde_json::from_str(DOCUMENT).ok()?;
    let mut found = declared_headers(&document);
    found.retain(|name| {
        let lower = name.to_ascii_lowercase();
        lower != "set-cookie" && !SAFELISTED.contains(&lower.as_str())
    });
    HeaderValue::from_str(&found.into_iter().collect::<Vec<_>>().join(", ")).ok()
});

/// What a path takes: the methods a page may ask for, and whether the path answers its own preflight.
struct Path {
    methods: Vec<Method>,
    answers_itself: bool,
}

/// The methods each path serves.
pub struct Served(matchit::Router<Path>);

impl Served {
    pub(super) fn of(doors: &Doors) -> Served {
        let mut router = matchit::Router::new();
        for (path, mut methods) in doors.methods_by_path() {
            let answers_itself = methods.contains(&Method::OPTIONS);
            methods.retain(|method| *method != Method::OPTIONS);
            if methods.contains(&Method::GET) && !methods.contains(&Method::HEAD) {
                methods.push(Method::HEAD);
            }
            methods.sort_by(|a, b| a.as_str().cmp(b.as_str()));
            let entry = Path {
                methods,
                answers_itself,
            };
            router
                .insert(path, entry)
                .expect("axum routes the same paths, and refuses a conflict itself");
        }
        Served(router)
    }

    fn at(&self, path: &str) -> Option<&Path> {
        self.0.at(path).ok().map(|found| found.value)
    }
}

#[derive(Clone)]
pub struct Pages {
    pub app: Arc<App>,
    pub served: Arc<Served>,
}

/// The one `Origin` a request names. Two of them name none a server can judge.
fn named_origin(headers: &HeaderMap) -> Option<&HeaderValue> {
    let mut named = headers.get_all(ORIGIN).iter();
    match (named.next(), named.next()) {
        (Some(origin), None) => Some(origin),
        _ => None,
    }
}

async fn approved(app: &App, origin: &HeaderValue) -> bool {
    match origin.to_str() {
        Ok(text) => page_approved(app, text).await.unwrap_or(false),
        Err(_) => false,
    }
}

/// The header names a preflight asks to send, `Ok(None)` when it asks for none.
fn requested_headers(headers: &HeaderMap) -> Result<Option<HeaderValue>, ()> {
    let mut asked = headers.get_all(ACCESS_CONTROL_REQUEST_HEADERS).iter();
    let (Some(value), None) = (asked.next(), asked.next()) else {
        return match headers.contains_key(ACCESS_CONTROL_REQUEST_HEADERS) {
            true => Err(()),
            false => Ok(None),
        };
    };
    let text = value.to_str().map_err(|_| ())?;
    if text.trim().is_empty() {
        return Ok(None);
    }
    let names = text
        .split(',')
        .map(|name| HeaderName::from_bytes(name.trim().as_bytes()).map_err(|_| ()))
        .collect::<Result<Vec<_>, ()>>()?;
    let names: Vec<&str> = names.iter().map(HeaderName::as_str).collect();
    HeaderValue::from_str(&names.join(", "))
        .map(Some)
        .map_err(|_| ())
}

fn varies_by_preflight(response: &mut Response) {
    let headers = response.headers_mut();
    for name in [
        "Origin",
        "Access-Control-Request-Method",
        "Access-Control-Request-Headers",
    ] {
        headers.append(VARY, HeaderValue::from_static(name));
    }
}

fn preflight_answer(
    app: &App,
    origin: &HeaderValue,
    methods: &[Method],
    headers: Option<HeaderValue>,
) -> Response {
    let mut answer = Response::new(Body::empty());
    *answer.status_mut() = StatusCode::NO_CONTENT;
    let named: Vec<&str> = methods.iter().map(Method::as_str).collect();
    let fields = answer.headers_mut();
    fields.insert("x-marfa-contract", HeaderValue::from(app.contract()));
    fields.insert(ACCESS_CONTROL_ALLOW_ORIGIN, origin.clone());
    if let Ok(methods) = HeaderValue::from_str(&named.join(", ")) {
        fields.insert(ACCESS_CONTROL_ALLOW_METHODS, methods);
    }
    if let Some(asked) = headers {
        fields.insert(ACCESS_CONTROL_ALLOW_HEADERS, asked);
    }
    varies_by_preflight(&mut answer);
    answer
}

/// The answer to a preflight from an approved page that asks for what the path takes.
async fn preflight(pages: &Pages, path: &Path, headers: &HeaderMap) -> Option<Response> {
    let origin = named_origin(headers)?;
    let method = headers.get(ACCESS_CONTROL_REQUEST_METHOD)?;
    let method = Method::from_bytes(method.as_bytes()).ok()?;
    if !path.methods.contains(&method) {
        return None;
    }
    let asked = requested_headers(headers).ok()?;
    if !approved(&pages.app, origin).await {
        return None;
    }
    Some(preflight_answer(&pages.app, origin, &path.methods, asked))
}

/// Allows an origin only while `cors_origins` names it or an approved grant covers it, judged per request.
pub async fn pages(State(pages): State<Pages>, request: Request, next: Next) -> Response {
    let uri_path = request.uri().path();
    if AUTHORIZATION_DOORS.contains(&uri_path) {
        return next.run(request).await;
    }
    let is_preflight = request.method() == Method::OPTIONS
        && request
            .headers()
            .contains_key(ACCESS_CONTROL_REQUEST_METHOD);
    if is_preflight
        && let Some(path) = pages.served.at(uri_path)
        && !path.answers_itself
        && let Some(answer) = preflight(&pages, path, request.headers()).await
    {
        return answer;
    }
    let origin = named_origin(request.headers()).cloned();
    let mut response = next.run(request).await;
    if is_preflight {
        varies_by_preflight(&mut response);
        return response;
    }
    response
        .headers_mut()
        .append(VARY, HeaderValue::from_static("Origin"));
    let Some(origin) = origin else {
        return response;
    };
    if response.headers().contains_key(ACCESS_CONTROL_ALLOW_ORIGIN)
        || !approved(&pages.app, &origin).await
    {
        return response;
    }
    let headers = response.headers_mut();
    headers.insert(ACCESS_CONTROL_ALLOW_ORIGIN, origin);
    if let Some(exposed) = EXPOSED.as_ref() {
        headers.insert(ACCESS_CONTROL_EXPOSE_HEADERS, exposed.clone());
    }
    response
}

/// Every origin may read a door that takes no credential and keeps nothing of the owner's.
pub async fn every_origin(request: Request, next: Next) -> Response {
    let answering = request.method() != Method::OPTIONS && request.headers().contains_key(ORIGIN);
    let mut response = next.run(request).await;
    if answering {
        response
            .headers_mut()
            .insert(ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
    }
    response
}

/// A page that is not yet approved registers itself, so registration takes a preflight from any origin.
pub async fn register_preflight(method: Method, asked: HeaderMap) -> Response {
    let posting = asked
        .get(ACCESS_CONTROL_REQUEST_METHOD)
        .is_some_and(|method| method == "POST");
    if !posting {
        return super::unmatched(method, asked).await;
    }
    let mut response = StatusCode::NO_CONTENT.into_response();
    let headers = response.headers_mut();
    headers.insert(ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
    headers.insert(
        ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("POST"),
    );
    headers.insert(
        ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static("Content-Type"),
    );
    response
}
